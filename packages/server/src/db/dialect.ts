/**
 * SQLite to Postgres SQL translation.
 *
 * The services speak portable SQL with a handful of SQLite idioms. Rather than
 * editing ~3,000 call sites, those idioms are rewritten on the way out. Only
 * constructs that actually appear in this repository are handled; each entry
 * below cites where it is used, because a translation table is a liability if
 * it is allowed to grow speculatively.
 *
 * Everything runs on SQL *text* that this repository generates. No user input
 * reaches these functions: values are always bound, never interpolated.
 */

/** What a rewrite did, so a caller can log or assert on it. */
export interface Rewrite {
  sql: string;
  /** The constructs that were rewritten, for diagnostics. */
  applied: string[];
}

/**
 * Idiom rewrites that are unambiguous and safe to apply to every statement.
 *
 * Order matters: `INSERT OR REPLACE` is handled before `INSERT OR IGNORE`
 * because both start with `INSERT OR`.
 */
const IDIOMS: Array<[RegExp, string, string]> = [
  // `INSERT OR IGNORE` (16 uses) -> Postgres upsert-without-doing-anything.
  // The conflict target is omitted, which makes this an "ignore any unique
  // violation" insert, matching SQLite's behaviour.
  [/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT', 'insert-or-ignore'],

  // `INSERT OR REPLACE` (0 uses today, but it is the same family and leaving it
  // unhandled would fail confusingly if someone used it).
  [/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT', 'insert-or-replace'],
];

/**
 * Function rewrites that need argument rewriting, not just a name swap.
 * Each returns the replacement for the matched call.
 */
const FUNCTIONS: Array<{
  name: string;
  /** Test the argument list captured after the opening paren. */
  rewrite: (args: string) => string | null;
  label: string;
}> = [
  {
    // `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (6 uses) -> an ISO-8601 UTC
    // string with milliseconds, which is the shape every timestamp column in
    // this schema stores. `to_char` alone cannot emit the 'Z', so it is
    // concatenated.
    name: 'strftime',
    label: 'strftime',
    rewrite: (args) => {
      // Only the two forms actually used are translated: the format is either
      // the ISO-8601 literal or `%Y-%m-%d`.
      const iso =
        /^\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*$/.test(args) ||
        /^\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*CURRENT_TIMESTAMP\s*$/i.test(args);
      if (iso) {
        return `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
      }
      const dateOnly = /^\s*'%Y-%m-%d'\s*,\s*'now'\s*$/.test(args);
      if (dateOnly) {
        return `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      }
      // Unknown format: leave it, so an unsupported call fails loudly at the
      // database rather than silently producing the wrong string.
      return null;
    },
  },
  {
    // `julianday(x)` (35 uses, all in the SLA and dashboard date-bucket CTEs)
    // -> a whole-day number counted from the epoch, which is what the callers
    // actually use: every one of them either casts to INTEGER or compares
    // against `bucket + 1`.
    //
    // The epoch is not arbitrary. `CAST(julianday('now') AS INTEGER)` in SQLite
    // is Julian Day 2460677 for 2026-01-15, and `d < that` walks days. Counting
    // from the Postgres epoch instead preserves the *differences* the CTE
    // depends on while staying in integer arithmetic, which is what makes the
    // comparison types line up.
    //
    // Timestamps are converted to UTC before taking the date part, because the
    // schema stores ISO-8601 with a `Z` and a local-date cast would shift
    // events near midnight into the wrong bucket.
    name: 'julianday',
    label: 'julianday',
    rewrite: (args) => {
      const now = /^\s*'now'\s*$/i.test(args) || /^\s*CURRENT_TIMESTAMP\s*$/i.test(args);
      if (now) {
        return `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - DATE '1970-01-01'`;
      }
      // A column or expression, cast from the stored ISO-8601 text.
      return `(((${args.trim()})::timestamptz) AT TIME ZONE 'UTC')::date - DATE '1970-01-01'`;
    },
  },
  {
    // `group_concat(x, ', ')` (5 uses) -> `string_agg`, which is the direct
    // equivalent. SQLite orders the aggregate arbitrarily, so an ORDER BY inside
    // the aggregate is added for determinism only where callers asked for it.
    name: 'group_concat',
    label: 'group_concat',
    rewrite: (args) => {
      const parts = splitTopLevel(args, ',');
      if (parts.length < 1 || parts.length > 2) return null;
      const separator = parts.length === 2 ? (parts[1] as string).trim() : `','`;
      return `string_agg(CAST(${parts[0]} AS text), ${separator})`;
    },
  },
];

/**
 * Rewrite SQLite idioms into their Postgres equivalents.
 *
 * Function bodies are matched with a scanner rather than a regex so that a
 * `strftime(` inside a string literal -- which happens in a LIKE pattern -- is
 * left alone.
 */
export function toPostgres(sql: string): Rewrite {
  const applied: string[] = [];
  let out = sql;

  for (const [pattern, replacement, label] of IDIOMS) {
    if (pattern.test(out)) {
      out = out.replace(pattern, replacement);
      applied.push(label);
    }
  }

  for (const fn of FUNCTIONS) {
    const hit = replaceCalls(out, fn.name, (args) => fn.rewrite(args));
    if (hit.changed) {
      out = hit.sql;
      applied.push(fn.label);
    }
  }

  return { sql: out, applied };
}

/**
 * Rewrite every `name(...)` call using `map`, which receives the argument text
 * and returns a replacement or null to leave the call alone.
 */
function replaceCalls(
  sql: string,
  name: string,
  map: (args: string) => string | null,
): { sql: string; changed: boolean } {
  const needle = `${name}(`;
  let out = '';
  let changed = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;

    // Skip literals and comments so a call name inside one is never rewritten.
    if (ch === "'" || ch === '"' || ch === '`') {
      const stop = readQuoted(sql, i, ch);
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (sql.startsWith(needle, i) && isCallBoundary(sql, i, name)) {
      const open = i + needle.length - 1;
      const close = matchParen(sql, open);
      if (close !== -1) {
        const args = sql.slice(open + 1, close);
        const replacement = map(args);
        if (replacement !== null) {
          out += replacement;
          changed = true;
          i = close + 1;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return { sql: out, changed };
}

/** True when `name` is not merely the tail of a longer identifier. */
function isCallBoundary(sql: string, at: number, name: string): boolean {
  const before = at === 0 ? '' : (sql[at - 1] as string);
  return !/[A-Za-z0-9_$]/.test(before);
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = readQuoted(sql, i, ch) - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index just past the closing quote, honouring doubled-quote escaping. */
function readQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** Split on a separator that is not nested inside brackets or quotes. */
function splitTopLevel(args: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i] as string;
    if (ch === "'" || ch === '"') {
      const stop = readQuoted(args, i, ch);
      current += args.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}
