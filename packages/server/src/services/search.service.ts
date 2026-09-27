/**
 * Full-text search, custom filtering, facet counts and type-ahead.
 *
 * Design notes
 * ------------
 * * The WHERE clause is built **structurally** from the query object, but every
 *   VALUE is a bound parameter. The only interpolated fragments are
 *   `inClause()` lengths and the `CASE` arms of the `PRIORITY_RANK` ordering,
 *   whose values are bound as well.
 * * Aggregations (labels, comment/attachment/sub-task counts, last activity) come
 *   from a fixed set of derived tables, so a result page is always a single
 *   query — never a query per row.
 * * FTS5 is optional sugar. If `toFtsMatchExpression()` yields nothing, or SQLite
 *   rejects the expression, the search degrades to a `LIKE` filter and records a
 *   note in `warnings`. It never 500s.
 * * Cursor pagination is a real keyset: the caller passes back the id of the last
 *   row it saw, the anchor row's sort values are looked up, and the predicate
 *   "(k1, k2, ..., id) after" is generated from those values. `id DESC` is the
 *   final tiebreaker so the ordering is total.
 *
 * This service is the single implementation of "which issues match"; the
 * dashboard service and the issue service (duplicate checks) both call it, so the
 * public surface is intentionally small: `search`, `summarise`, `facets`,
 * `suggest`.
 */

import type { IssueSearchQuery, IssueSummary, SearchResultPage } from '@tracker/shared';
import {
  ISSUE_PRIORITIES,
  PRIORITY_RANK,
  asIssueId,
  asUserId,
  searchQuerySchema,
  toFtsMatchExpression,
} from '@tracker/shared';
import { inClause, type Database, type SqlParam } from '../db/connection.ts';
import { addDays, nowIso } from '../lib/time.ts';
import type { Services } from './context.ts';

/** Restricts a search to the projects the caller is allowed to see. */
export interface SearchOptions {
  visibleProjectIds?: number[];
}

/** One facet chip: a value plus how many issues carry it. */
export interface FacetBucket {
  /** Machine value: enum string, numeric id, or `unassigned`. */
  value: string;
  /** Numeric id for id-based dimensions, otherwise null. */
  id: number | null;
  /** Human label for rendering. */
  label: string;
  count: number;
}

export interface SearchFacets {
  states: FacetBucket[];
  priorities: FacetBucket[];
  types: FacetBucket[];
  assignees: FacetBucket[];
  labels: FacetBucket[];
  total: number;
  tookMs: number;
  warnings: string[];
}

/** Compact aggregate used by dashboard widgets that need numbers, not rows. */
export interface SearchSummary {
  total: number;
  byState: Record<string, number>;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  overdue: number;
  unassigned: number;
  withDueDate: number;
  tookMs: number;
  warnings: string[];
}

/** Type-ahead result; deliberately smaller than `IssueSummary`. */
export interface SearchSuggestion {
  id: number;
  key: string;
  title: string;
  projectId: number;
}

interface SortKey {
  /** SQL expression, always evaluated to a non-NULL value. */
  expr: string;
  /** Bound parameters the expression itself needs. */
  params: SqlParam[];
  direction: 'ASC' | 'DESC';
}

/** A partially-built query: fragments plus the parameters in textual order. */
interface QueryPlan {
  /**
   * Optional leading `WITH ...` block. Kept separate from `source` because a
   * CTE has to be spliced in *before* the SELECT list, not after it.
   */
  cte: string;
  /** Always starts with `FROM issues i`. */
  source: string;
  /** Parameters bound by `cte` (the MATCH expressions), in order. */
  sourceParams: SqlParam[];
  /** Filter clauses without the keyset predicate. */
  where: string[];
  whereParams: SqlParam[];
  /** Keyset predicate; empty for the first page. */
  cursorClause: string;
  cursorParams: SqlParam[];
  orderBy: string;
  orderParams: SqlParam[];
  warnings: string[];
  /** Set when the filter cannot match anything, so no SQL needs to run. */
  impossible: boolean;
  /** True when the plan actually uses an FTS5 MATCH. */
  usesFts: boolean;
}

const DUE_WINDOW_DAYS: Record<string, number> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '30d': 30,
};

const SELECT_COLUMNS = `
  i.id            AS id,
  i.project_id    AS project_id,
  i.key           AS key,
  i.title         AS title,
  i.type          AS type,
  i.priority      AS priority,
  i.state         AS state,
  i.assignee_id   AS assignee_id,
  au.display_name AS assignee_name,
  i.parent_id     AS parent_id,
  i.due_date      AS due_date,
  i.position      AS position,
  i.updated_at    AS updated_at,
  COALESCE(la.label_ids, '') AS label_ids,
  COALESCE(cc.c, 0)          AS comment_count,
  COALESCE(ac.c, 0)          AS attachment_count,
  COALESCE(sc.c, 0)          AS subtask_count,
  CASE WHEN act.last_at IS NOT NULL AND act.last_at > i.updated_at
       THEN act.last_at ELSE i.updated_at END AS last_activity_at`;

/**
 * Fixed join set. Each derived table is a single aggregate pass, so the whole
 * result page costs one query no matter how many rows come back.
 */
const JOIN_SUFFIX = `
  LEFT JOIN users au ON au.id = i.assignee_id
  LEFT JOIN (SELECT issue_id, group_concat(label_id) AS label_ids
             FROM issue_labels GROUP BY issue_id) la ON la.issue_id = i.id
  LEFT JOIN (SELECT issue_id, COUNT(*) AS c FROM comments GROUP BY issue_id) cc ON cc.issue_id = i.id
  LEFT JOIN (SELECT issue_id, COUNT(*) AS c FROM attachments GROUP BY issue_id) ac ON ac.issue_id = i.id
  LEFT JOIN (SELECT parent_id AS issue_id, COUNT(*) AS c
             FROM issues WHERE parent_id IS NOT NULL GROUP BY parent_id) sc ON sc.issue_id = i.id
  LEFT JOIN (SELECT issue_id, MAX(created_at) AS last_at FROM (
               SELECT issue_id, created_at FROM comments
               UNION ALL
               SELECT issue_id, created_at FROM activity_events
             ) GROUP BY issue_id) act ON act.issue_id = i.id`;

const ARRAY_ID_KEYS = new Set([
  'projectIds',
  'assigneeIds',
  'reporterIds',
  'labelIds',
  'milestoneIds',
  'statusIds',
]);
const ARRAY_ENUM_KEYS = new Set(['states', 'types', 'priorities', 'linkedKinds']);
const NUMBER_KEYS = new Set(['limit', 'cursor', 'linkedToIssueId']);
const BOOLEAN_KEYS = new Set([
  'hasParent',
  'topLevelOnly',
  'overdueOnly',
  'unassignedOnly',
  'archived',
  'includeDescendants',
]);
const STRING_KEYS = new Set([
  'q',
  'dueWithin',
  'sort',
  'createdAfter',
  'createdBefore',
  'updatedAfter',
]);

/** Escape the LIKE metacharacters so user text cannot widen the pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Normalise an HTTP query-string bag (or any plain object) into something
 * `searchQuerySchema` accepts: comma-separated values become arrays, `"true"`
 * becomes a boolean, numeric strings become numbers.
 */
export function coerceSearchInput(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Search input must be an object');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;

    if (key === 'parentId') {
      out[key] =
        value === null || value === '' || value === 'null' || value === 'none' ? null : Number(value);
      continue;
    }

    if (ARRAY_ID_KEYS.has(key) || ARRAY_ENUM_KEYS.has(key)) {
      const list = Array.isArray(value) ? value : [value];
      const parts = list
        .flatMap((entry) => (entry === null || entry === undefined ? [] : String(entry).split(',')))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (ARRAY_ID_KEYS.has(key)) {
        out[key] = parts.map((entry) => {
          const parsed = Number(entry);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new TypeError(`${key} must be a list of positive integers`);
          }
          return parsed;
        });
      } else {
        out[key] = parts;
      }
      continue;
    }

    if (NUMBER_KEYS.has(key)) {
      const raw2 = Array.isArray(value) ? value[0] : value;
      const parsed = Number(raw2);
      out[key] = raw2 === '' || !Number.isFinite(parsed) ? raw2 : parsed;
      continue;
    }

    if (BOOLEAN_KEYS.has(key)) {
      const text = String(Array.isArray(value) ? (value[0] ?? '') : value).toLowerCase();
      out[key] = text === 'true' || text === '1' || text === 'yes' || text === '';
      continue;
    }

    if (STRING_KEYS.has(key)) {
      out[key] = String(Array.isArray(value) ? (value[0] ?? '') : value);
      continue;
    }

    out[key] = value;
  }
  return out;
}

/** Validate and default a search query coming from any transport. */
export function parseSearchQuery(raw: unknown): IssueSearchQuery {
  return searchQuerySchema.parse(coerceSearchInput(raw));
}

/**
 * Build `(k1 op) OR (k1 = ? AND k2 op) OR ... OR (all equal AND i.id < ?)` for a
 * keyset over `keys` anchored at the row identified by `anchor`.
 */
function buildKeysetPredicate(
  keys: SortKey[],
  anchor: Record<string, unknown>,
  anchorId: number,
): { sql: string; params: SqlParam[] } {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  const prefixExprs: string[] = [];
  let prefixParams: SqlParam[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) continue;
    const value = (anchor[`k${index}`] ?? null) as SqlParam;
    const op = key.direction === 'ASC' ? '>' : '<';
    const conds = [...prefixExprs.map((expr) => `(${expr})`), `${key.expr} ${op} ?`];
    parts.push(`(${conds.join(' AND ')})`);
    params.push(...prefixParams, ...key.params, value);
    prefixExprs.push(`${key.expr} = ?`);
    prefixParams = [...prefixParams, ...key.params, value];
  }

  parts.push(`(${prefixExprs.join(' AND ')} AND i.id < ?)`);
  params.push(...prefixParams, anchorId);
  return { sql: `(${parts.join(' OR ')})`, params };
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

export class SearchService {
  private readonly db: Database;

  constructor(services: Services) {
    this.db = services.db;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a search and return one page of `IssueSummary` rows.
   *
   * `options.visibleProjectIds` is enforced unconditionally: when the caller
   * cannot see everything, the requested `projectIds` are intersected with it and
   * an empty intersection short-circuits to an empty page rather than issuing a
   * query that could match rows the caller must not see.
   */
  async search(query: IssueSearchQuery, options: SearchOptions = {}): Promise<SearchResultPage> {
    const startedAt = Date.now();
    const parsed = searchQuerySchema.parse(query);
    let plan = this.planFor(parsed, options);

    if (plan.impossible) {
      return {
        issues: [],
        nextCursor: null,
        total: 0,
        tookMs: Date.now() - startedAt,
        warnings: plan.warnings,
      };
    }

    const limit = Math.max(1, Math.min(parsed.limit, 500));
    let rows: Record<string, unknown>[];
    try {
      rows = this.runPage(plan, limit);
    } catch (error) {
      // A rejected MATCH expression must degrade, never surface as a 500.
      if (!plan.usesFts) throw error;
      plan = this.planFor(parsed, options, { forceLike: true });
      plan.warnings = dedupeWarnings([
        ...plan.warnings,
        'The full-text expression was rejected by the search index; the query was ' +
          'simplified to a plain text match.',
      ]);
      rows = this.runPage(plan, limit);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const now = nowIso();
    const total = Number(
      this.db.scalar<number>(
        // `plan.source` already begins with `FROM`; `plan.cte` goes first.
        `${plan.cte}SELECT COUNT(*) AS c ${plan.source} WHERE ${plan.where.join(' AND ')}`,
        [...plan.sourceParams, ...plan.whereParams],
      ) ?? 0,
    );
    const last = page.at(-1);

    return {
      issues: page.map((row) => this.mapSummary(row, now)),
      nextCursor: hasMore && last ? Number(last.id) : null,
      total,
      tookMs: Date.now() - startedAt,
      warnings: plan.warnings,
    };
  }

  /**
   * Numbers only: totals and the state/priority/type breakdown for the current
   * filter. One GROUP BY per dimension over the same plan the row query uses.
   */
  async summarise(query: IssueSearchQuery, options: SearchOptions = {}): Promise<SearchSummary> {
    const startedAt = Date.now();
    const parsed = searchQuerySchema.parse(query);
    const plan = this.planFor(parsed, options);
    const empty = (warnings: string[]): SearchSummary => ({
      total: 0,
      byState: {},
      byPriority: {},
      byType: {},
      overdue: 0,
      unassigned: 0,
      withDueDate: 0,
      tookMs: Date.now() - startedAt,
      warnings,
    });
    if (plan.impossible) return empty(plan.warnings);

    // Parameter order follows the SQL text: the WITH/JOIN block first, then the
    // WHERE clauses, then any literal bound at the end.
    const tally = (rows: Record<string, unknown>[], missing = 'none') => {
      const out: Record<string, number> = {};
      for (const row of rows) {
        const value = row.bucket === null || row.bucket === undefined ? missing : String(row.bucket);
        out[value] = Number(row.c ?? 0);
      }
      return out;
    };
    const group = (column: string): Record<string, unknown>[] =>
      this.db.all<Record<string, unknown>>(
        `${plan.cte}SELECT ${column} AS bucket, COUNT(*) AS c
           ${plan.source}
          WHERE ${plan.where.join(' AND ')}
          GROUP BY ${column}`,
        [...plan.sourceParams, ...plan.whereParams],
      );
    const byState = tally(group('i.state'));
    const byPriority = tally(group('i.priority'));
    const byType = tally(group('i.type'));

    const totals = this.db.get<Record<string, number>>(
      `${plan.cte}SELECT COUNT(*) AS c,
              COALESCE(SUM(CASE WHEN i.due_date IS NOT NULL AND i.due_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN i.assignee_id IS NULL THEN 1 ELSE 0 END), 0) AS unassigned,
              COALESCE(SUM(CASE WHEN i.due_date IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_due
         ${plan.source}
        WHERE ${plan.where.join(' AND ')}`,
      // The bound "now" belongs to the SELECT list, so it precedes the WHERE
      // parameters in binding order.
      [...plan.sourceParams, nowIso(), ...plan.whereParams],
    );

    return {
      total: Number(totals?.c ?? 0),
      byState,
      byPriority,
      byType,
      overdue: Number(totals?.overdue ?? 0),
      unassigned: Number(totals?.unassigned ?? 0),
      withDueDate: Number(totals?.with_due ?? 0),
      tookMs: Date.now() - startedAt,
      warnings: plan.warnings,
    };
  }

  /**
   * Counts per dimension for the current filter, used to render filter chips.
   * Each dimension ignores its own filter, so ticking "bug" does not make the
   * other types vanish from the list.
   */
  async facets(query: IssueSearchQuery, options: SearchOptions = {}): Promise<SearchFacets> {
    const startedAt = Date.now();
    const parsed = searchQuerySchema.parse(query);
    const warnings: string[] = [];
    const forceLike = { forceLike: false };

    let plan = this.planFor(parsed, options);
    if (plan.impossible) {
      return {
        states: [],
        priorities: [],
        types: [],
        assignees: [],
        labels: [],
        total: 0,
        tookMs: Date.now() - startedAt,
        warnings: plan.warnings,
      };
    }
    // Five dimension queries run off this plan, so probe the MATCH expression
    // once up front rather than failing half way through the facet list.
    if (plan.usesFts && !this.ftsIsUsable(plan.sourceParams[0])) {
      forceLike.forceLike = true;
      plan = this.planFor(parsed, options, forceLike);
    }
    warnings.push(...plan.warnings);

    const dimension = (key: keyof IssueSearchQuery): QueryPlan =>
      this.planFor({ ...parsed, [key]: undefined } as IssueSearchQuery, options, forceLike);

    const run = (dimensionPlan: QueryPlan, select: string, groupBy: string, join = '') => {
      // `dimensionPlan.source` already starts with `FROM`; the CTE goes first.
      const sql =
        `${dimensionPlan.cte}SELECT ${select} ${dimensionPlan.source} ${join}` +
        ` WHERE ${dimensionPlan.where.join(' AND ')} GROUP BY ${groupBy} ORDER BY c DESC, value ASC`;
      try {
        return this.db.all<Record<string, unknown>>(sql, [
          ...dimensionPlan.sourceParams,
          ...dimensionPlan.whereParams,
        ]);
      } catch (error) {
        if (dimensionPlan.usesFts) {
          const like = this.planFor(
            { ...parsed, [keyOfSelect(select)]: undefined } as IssueSearchQuery,
            options,
            { forceLike: true },
          );
          return this.db.all<Record<string, unknown>>(
            `${like.cte}SELECT ${select} ${like.source} ${join}` +
              ` WHERE ${like.where.join(' AND ')} GROUP BY ${groupBy} ORDER BY c DESC, value ASC`,
            [...like.sourceParams, ...like.whereParams],
          );
        }
        throw error;
      }
    };

    const toBucket = (row: Record<string, unknown>): FacetBucket => ({
      value: String(row.value),
      id: row.id === null || row.id === undefined ? null : Number(row.id),
      label: String(row.value),
      count: Number(row.c),
    });

    const states = run(
      dimension('states'),
      'i.state AS value, NULL AS id, COUNT(*) AS c',
      'i.state',
    ).map(toBucket);
    const priorities = run(
      dimension('priorities'),
      'i.priority AS value, NULL AS id, COUNT(*) AS c',
      'i.priority',
    ).map(toBucket);
    const types = run(dimension('types'), 'i.type AS value, NULL AS id, COUNT(*) AS c', 'i.type').map(
      toBucket,
    );
    const assignees = run(
      dimension('assigneeIds'),
      'i.assignee_id AS id, COALESCE(au.display_name, au.username, \'unassigned\') AS value, COUNT(*) AS c',
      'i.assignee_id',
    ).map(toBucket);
    const labels = run(
      dimension('labelIds'),
      'l.id AS id, l.name AS value, COUNT(DISTINCT i.id) AS c',
      'l.id',
      'JOIN issue_labels fl ON fl.issue_id = i.id JOIN labels l ON l.id = fl.label_id',
    ).map(toBucket);

    const total = Number(
      this.db.scalar<number>(
        `${plan.cte}SELECT COUNT(*) AS c ${plan.source} WHERE ${plan.where.join(' AND ')}`,
        [...plan.sourceParams, ...plan.whereParams],
      ) ?? 0,
    );

    return {
      states,
      priorities,
      types,
      assignees,
      labels,
      total,
      tookMs: Date.now() - startedAt,
      warnings: dedupeWarnings(warnings),
    };
  }

  /**
   * Lightweight type-ahead: the issue keys and titles that best match `text`.
   * Tries FTS first and falls back to `LIKE`, so a half-typed phrase still
   * returns something instead of an error.
   */
  async suggest(
    text: string,
    options: { limit?: number; visibleProjectIds?: number[]; projectId?: number } = {},
  ): Promise<SearchSuggestion[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];

    const clauses = ['i.archived = 0'];
    const params: SqlParam[] = [];
    const visible = options.visibleProjectIds;
    if (visible && visible.length === 0) return [];
    if (options.projectId !== undefined) {
      clauses.push('i.project_id = ?');
      params.push(options.projectId);
    } else if (visible) {
      clauses.push(`i.project_id IN ${inClause(visible.length)}`);
      params.push(...visible);
    }

    const map = (rows: Record<string, unknown>[]): SearchSuggestion[] =>
      rows.map((row) => ({
        id: Number(row.id),
        key: String(row.key),
        title: String(row.title),
        projectId: Number(row.project_id),
      }));

    const run = (expression: string | null): SearchSuggestion[] => {
      const pattern = `%${escapeLike(trimmed)}%`;
      const sql = `SELECT i.id AS id, i.key AS key, i.title AS title, i.project_id AS project_id
                     FROM issues i
                    WHERE ${clauses.join(' AND ')} ${
                      expression === null
                        ? "AND (i.key LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\')"
                        : 'AND i.id IN (SELECT rowid FROM issue_search WHERE issue_search MATCH ?)'
                    }
                    ORDER BY i.updated_at DESC, i.id DESC
                    LIMIT ?`;
      const args: SqlParam[] =
        expression === null ? [...params, pattern, pattern] : [...params, expression];
      return map(this.db.all<Record<string, unknown>>(sql, [...args, limit]));
    };

    const expression = toFtsMatchExpression(trimmed);
    if (expression !== '') {
      try {
        return run(expression);
      } catch {
        // fall through to the LIKE path
      }
    }
    try {
      return run(null);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Query planning
  // -------------------------------------------------------------------------

  /**
   * Probe an FTS expression with a cheap query. `MATCH` errors surface at
   * execution time, not at prepare time, so the only way to know an expression
   * is safe is to run it.
   */
  private ftsIsUsable(expression: SqlParam | undefined): boolean {
    if (typeof expression !== 'string' || expression === '') return false;
    try {
      this.db.get<Record<string, unknown>>(
        'SELECT rowid AS r FROM issue_search WHERE issue_search MATCH ? LIMIT 1',
        [expression],
      );
      this.db.get<Record<string, unknown>>(
        'SELECT rowid AS r FROM comment_search WHERE comment_search MATCH ? LIMIT 1',
        [expression],
      );
      return true;
    } catch {
      return false;
    }
  }

  private planFor(
    query: IssueSearchQuery,
    options: SearchOptions,
    planOptions: { forceLike?: boolean } = {},
  ): QueryPlan {
    const warnings: string[] = [];
    const where: string[] = [];
    const params: SqlParam[] = [];
    let impossible = false;

    // -- visibility ---------------------------------------------------------
    const requested = query.projectIds;
    let projectIds: number[] | null = requested && requested.length > 0 ? [...requested] : null;
    if (query.projectId !== undefined) {
      const pinned = Number(query.projectId);
      projectIds = projectIds ? projectIds.filter((id) => id === pinned) : [pinned];
    }
    const visible = options.visibleProjectIds;
    if (visible) {
      projectIds = projectIds
        ? projectIds.filter((id) => visible.includes(id))
        : visible.length > 0
          ? [...visible]
          : [];
    }
    if (projectIds) {
      if (projectIds.length === 0) {
        impossible = true;
      } else {
        where.push(`i.project_id IN ${inClause(projectIds.length)}`);
        params.push(...projectIds);
      }
    }

    // -- full text ----------------------------------------------------------
    const raw = (query.q ?? '').trim();
    const expression = raw === '' ? '' : toFtsMatchExpression(raw);
    let usesFts = false;
    let cte = '';
    let source = `FROM issues i${JOIN_SUFFIX}`;
    const sourceParams: SqlParam[] = [];

    if (expression !== '' && !planOptions.forceLike) {
      // Two FTS sources unioned: the issue index and the comment index. bm25() is
      // "smaller is better", so the per-issue score is the minimum of its hits.
      cte = `WITH fts_hits AS (
          SELECT rowid AS issue_id, bm25(issue_search) AS score
            FROM issue_search
           WHERE issue_search MATCH ?
          UNION ALL
          SELECT c.issue_id AS issue_id, bm25(comment_search) AS score
            FROM comment_search
            JOIN comments c ON c.id = comment_search.rowid
           WHERE comment_search MATCH ?
        ),
        fts_scores AS (SELECT issue_id, MIN(score) AS score FROM fts_hits GROUP BY issue_id) `;
      source = `FROM issues i LEFT JOIN fts_scores f ON f.issue_id = i.id${JOIN_SUFFIX}`;
      sourceParams.push(expression, expression);
      where.push('f.issue_id IS NOT NULL');
      usesFts = true;
    } else if (raw !== '') {
      // Degraded path. Punctuation-only input normalises to an empty expression
      // and therefore matches nothing, rather than 500-ing on a MATCH syntax
      // error.
      const pattern = `%${escapeLike(raw)}%`;
      where.push(
        "(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.key LIKE ? ESCAPE '\\')",
      );
      params.push(pattern, pattern, pattern);
      if (planOptions.forceLike) {
        warnings.push(
          'The full-text expression was rejected by the search index; the query was ' +
            'simplified to a plain text match.',
        );
      }
    }

    // -- structured filters -------------------------------------------------
    this.pushInClause(where, params, 'i.state', query.states);
    this.pushInClause(where, params, 'i.type', query.types);
    this.pushInClause(where, params, 'i.priority', query.priorities);
    this.pushInClause(where, params, 'i.status_id', query.statusIds);
    this.pushInClause(where, params, 'i.milestone_id', query.milestoneIds);
    this.pushInClause(where, params, 'i.assignee_id', query.assigneeIds);
    this.pushInClause(where, params, 'i.reporter_id', query.reporterIds);

    // Label filter is an EXISTS matching ANY of the labels, so the result set is
    // served from the issue index without a second scan.
    if (query.labelIds && query.labelIds.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label_id IN ${inClause(query.labelIds.length)})`,
      );
      params.push(...query.labelIds);
    }

    if (query.parentId === null) {
      where.push('i.parent_id IS NULL');
    } else if (query.parentId !== undefined) {
      where.push('i.parent_id = ?');
      params.push(query.parentId);
    }
    if (query.hasParent === true) where.push('i.parent_id IS NOT NULL');
    if (query.topLevelOnly === true) where.push('i.parent_id IS NULL');
    if (query.unassignedOnly === true) where.push('i.assignee_id IS NULL');
    if (query.includeDescendants === false) {
      where.push('NOT EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = i.id)');
    }

    if (query.dueWithin !== undefined) {
      where.push('i.due_date IS NOT NULL AND i.due_date <= ?');
      params.push(addDays(nowIso(), DUE_WINDOW_DAYS[query.dueWithin] ?? 7));
    }
    if (query.overdueOnly === true) {
      where.push('i.due_date IS NOT NULL AND i.due_date < ?');
      params.push(nowIso());
    }
    if (query.createdAfter !== undefined) {
      where.push('i.created_at >= ?');
      params.push(query.createdAfter);
    }
    if (query.createdBefore !== undefined) {
      where.push('i.created_at <= ?');
      params.push(query.createdBefore);
    }
    if (query.updatedAfter !== undefined) {
      where.push('i.updated_at >= ?');
      params.push(query.updatedAfter);
    }

    where.push(query.archived === true ? 'i.archived = 1' : 'i.archived = 0');

    if (query.linkedToIssueId !== undefined) {
      const kinds = query.linkedKinds && query.linkedKinds.length > 0 ? query.linkedKinds : null;
      const kindFilter = kinds ? ` AND l.kind IN ${inClause(kinds.length)}` : '';
      const kindArgs = kinds ? [...kinds] : [];
      // A link is stored once, so both directions are resolved here.
      where.push(`(
        EXISTS (SELECT 1 FROM issue_links l WHERE l.target_issue_id = i.id AND l.source_issue_id = ?${kindFilter})
        OR EXISTS (SELECT 1 FROM issue_links l WHERE l.source_issue_id = i.id AND l.target_issue_id = ?${kindFilter})
      )`);
      params.push(query.linkedToIssueId, query.linkedToIssueId, ...kindArgs, ...kindArgs);
      where.push('i.id <> ?');
      params.push(query.linkedToIssueId);
    }

    // -- ordering -----------------------------------------------------------
    const sortKeys = this.sortKeys(query.sort, usesFts);
    const orderBy = `${sortKeys.map((key) => `${key.expr} ${key.direction}`).join(', ')}, i.id DESC`;
    const orderParams: SqlParam[] = sortKeys.flatMap((key) => key.params);

    // -- keyset cursor ------------------------------------------------------
    let cursorClause = '';
    let cursorParams: SqlParam[] = [];
    if (query.cursor !== undefined) {
      const anchor = this.db.get<Record<string, unknown>>(
        `${cte}SELECT ${sortKeys.map((key, index) => `${key.expr} AS k${index}`).join(', ')}
           ${source}
          WHERE i.id = ?`,
        [...sourceParams, ...sortKeys.flatMap((key) => key.params), query.cursor],
      );
      if (anchor) {
        const built = buildKeysetPredicate(sortKeys, anchor, query.cursor);
        cursorClause = built.sql;
        cursorParams = built.params;
      } else {
        warnings.push(
          'The pagination cursor no longer resolves to a visible issue; the first page was returned.',
        );
      }
    }

    return {
      cte,
      source,
      sourceParams,
      where,
      whereParams: params,
      cursorClause,
      cursorParams,
      orderBy,
      orderParams,
      warnings: dedupeWarnings(warnings),
      impossible,
      usesFts,
    };
  }

  private pushInClause(
    where: string[],
    params: SqlParam[],
    column: string,
    values: Array<string | number> | undefined,
  ): void {
    if (!values || values.length === 0) return;
    where.push(`${column} IN ${inClause(values.length)}`);
    params.push(...values);
  }

  /**
   * Translate a sort name into its key expressions. Every expression is
   * non-NULL by construction so comparisons never hit three-valued logic:
   * `due_asc` splits into a "has a due date" flag plus a coalesced date, and
   * `key_asc` sorts on the numeric sequence before the literal key.
   */
  private sortKeys(sort: string, hasFts: boolean): SortKey[] {
    switch (sort) {
      case 'relevance':
        return hasFts
          ? [{ expr: 'f.score', params: [], direction: 'ASC' }]
          : [{ expr: 'i.updated_at', params: [], direction: 'DESC' }];
      case 'created_desc':
        return [{ expr: 'i.created_at', params: [], direction: 'DESC' }];
      case 'created_asc':
        return [{ expr: 'i.created_at', params: [], direction: 'ASC' }];
      case 'updated_asc':
        return [{ expr: 'i.updated_at', params: [], direction: 'ASC' }];
      case 'due_asc':
        return [
          { expr: 'CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END', params: [], direction: 'ASC' },
          { expr: "COALESCE(i.due_date, '')", params: [], direction: 'ASC' },
        ];
      case 'priority_desc':
        return [{ expr: this.priorityRankExpression(), params: this.priorityRankParams(), direction: 'DESC' }];
      case 'key_asc':
        return [
          {
            expr: "CAST(substr(i.key, instr(i.key, '-') + 1) AS INTEGER)",
            params: [],
            direction: 'ASC',
          },
          { expr: 'i.key', params: [], direction: 'ASC' },
        ];
      case 'updated_desc':
      default:
        return [{ expr: 'i.updated_at', params: [], direction: 'DESC' }];
    }
  }

  /**
   * `CASE` over the closed `ISSUE_PRIORITIES` set. Even these are bound, so no
   * SQL text anywhere in this file comes from a value.
   */
  private priorityRankExpression(): string {
    const arms = ISSUE_PRIORITIES.map(() => 'WHEN ? THEN ?').join(' ');
    return `CASE i.priority ${arms} ELSE 0 END`;
  }

  private priorityRankParams(): SqlParam[] {
    return ISSUE_PRIORITIES.flatMap((priority) => [priority, PRIORITY_RANK[priority]]);
  }

  private runPage(plan: QueryPlan, limit: number): Record<string, unknown>[] {
    const page = [...plan.where];
    const pageParams = [...plan.whereParams];
    if (plan.cursorClause) {
      page.push(plan.cursorClause);
      pageParams.push(...plan.cursorParams);
    }
    return this.db.all<Record<string, unknown>>(
      `${plan.cte}SELECT ${SELECT_COLUMNS}
         ${plan.source}
        WHERE ${page.join(' AND ')}
        ORDER BY ${plan.orderBy}
        LIMIT ?`,
      [...plan.sourceParams, ...pageParams, ...plan.orderParams, limit + 1],
    );
  }

  private mapSummary(row: Record<string, unknown>, now: string): IssueSummary {
    const labelIds =
      typeof row.label_ids === 'string' && row.label_ids !== ''
        ? row.label_ids.split(',').map((value) => Number(value))
        : [];
    const dueDate = row.due_date === null || row.due_date === undefined ? null : String(row.due_date);

    return {
      id: asIssueId(Number(row.id)),
      key: String(row.key),
      title: String(row.title),
      type: row.type as IssueSummary['type'],
      priority: row.priority as IssueSummary['priority'],
      state: row.state as IssueSummary['state'],
      assigneeId: row.assignee_id === null ? null : asUserId(Number(row.assignee_id)),
      assigneeName: row.assignee_name === null || row.assignee_name === undefined ? null : String(row.assignee_name),
      parentId: row.parent_id === null ? null : asIssueId(Number(row.parent_id)),
      dueDate,
      position: Number(row.position ?? 0),
      labelIds,
      commentCount: Number(row.comment_count ?? 0),
      attachmentCount: Number(row.attachment_count ?? 0),
      subtaskCount: Number(row.subtask_count ?? 0),
      // Mirrors the `overdueOnly` filter so the badge and the chip count can
      // never disagree about the same issue.
      isOverdue: dueDate !== null && dueDate < now,
      lastActivityAt: String(row.last_activity_at ?? now),
    };
  }
}

/** Which query key a facet select corresponds to, for the LIKE retry path. */
function keyOfSelect(select: string): keyof IssueSearchQuery {
  if (select.includes('i.state')) return 'states';
  if (select.includes('i.priority')) return 'priorities';
  if (select.includes('i.type')) return 'types';
  if (select.includes('assignee')) return 'assigneeIds';
  return 'labelIds';
}
