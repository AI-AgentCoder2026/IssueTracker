/**
 * SQL placeholder translation.
 *
 * The services are written against SQLite's `?` placeholders, ~3,000 of them.
 * The Postgres wire protocol uses positional `$1, $2, ...`, so the adapter
 * rewrites them on the way out rather than the services being edited.
 *
 * This is the highest-risk piece of the whole port: a mistranslation would not
 * throw, it would bind a value to the wrong argument. It is therefore a real
 * scanner rather than a chain of regular expressions, because a `?` that is
 * *not* a placeholder must survive untouched:
 *
 *   * inside a single-quoted string   -- `'what? really'`
 *   * inside a quoted identifier      -- `"weird?name"`
 *   * inside a backtick identifier    -- (SQLite's form)
 *   * inside a line or block comment
 *   * inside a dollar-quoted string   -- `$$ ... $$`, used by PL/pgSQL bodies
 *
 * Deliberately *not* handled: the jsonb existence operators `?`, `?|` and
 * `?&`. They are indistinguishable from a placeholder by lookahead -- `a ? 'k'`
 * and `a = ?` differ only in what precedes -- and this schema has no jsonb at
 * all, storing JSON as TEXT by design. A rule that silently changed meaning
 * based on the next character would be worse than not having one, so every
 * `?` outside a literal or comment is a placeholder.
 */

/** A token the scanner recognised but deliberately left alone. */
export interface Translation {
  sql: string;
  /** How many placeholders were rewritten. */
  count: number;
}

const IDENTIFIER_QUOTES = new Set(['"', '`']);

/**
 * Rewrite `?` placeholders to `$1..$n`.
 *
 * Not called for DDL: `exec()` passes SQL through untouched, which is what
 * keeps dollar-quoted PL/pgSQL bodies in the migrations intact.
 */
export function toPositionalPlaceholders(sql: string): Translation {
  let out = '';
  let count = 0;
  let i = 0;

  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    // -- line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // -- block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // -- dollar-quoted string: $tag$ ... $tag$  (PL/pgSQL bodies)
    if (ch === '$') {
      const tag = readDollarTag(sql, i);
      if (tag !== null) {
        const closing = sql.indexOf(tag, i + tag.length);
        const stop = closing === -1 ? n : closing + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // -- single-quoted string, '' escapes a quote
    if (ch === "'") {
      const stop = readQuoted(sql, i, "'");
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // -- quoted identifier, doubled quote escapes
    if (IDENTIFIER_QUOTES.has(ch)) {
      const stop = readQuoted(sql, i, ch);
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '?') {
      count += 1;
      out += `$${count}`;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { sql: out, count };
}

/**
 * The opening dollar-quote tag at `start`, or null when this `$` is not one.
 * `$1` is a placeholder-shaped dollar sign, not a dollar quote.
 */
function readDollarTag(sql: string, start: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start));
  if (!match) return null;
  return match[0];
}

/** Index just past the closing quote, honouring doubled-quote escaping. */
function readQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/** Convenience for callers that only want the rewritten SQL. */
export function positional(sql: string): string {
  return toPositionalPlaceholders(sql).sql;
}
