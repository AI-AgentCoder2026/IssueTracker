/**
 * Timing math and the per-issue timeline.
 *
 * Everything here is derived from timestamps already on the issue row, so this
 * service owns no state of its own. The SLA clocks, the dashboard charts and
 * the issue header strip all read these same numbers, which is what keeps a
 * "time to resolve" shown in two places from ever disagreeing.
 *
 * Measurement conventions (applied consistently across the codebase):
 *   * `overdueByMs` is measured against the moment the issue stopped being at
 *     risk — `resolved_at`, then `closed_at`, then now. An issue resolved
 *     before its due date therefore reports 0 rather than growing forever.
 *   * Durations are wall-clock milliseconds, never business hours; the SLA
 *     service is the only place business calendars are applied.
 */

import type { ActivityType, IssueTiming, IssueTimeline } from '@tracker/shared';
import { inClause } from '../db/connection.ts';
import { notFound } from '../errors.ts';
import { formatDuration, nowIso } from '../lib/time.ts';
import type { Services } from './context.ts';

/** The subset of `issues` needed to compute a timing block. */
type TimingRow = {
  id: number;
  created_at: string;
  started_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  due_date: string | null;
  time_spent_hours: number;
};

/** A raw issue row plus the sub-task rollup computed alongside it. */
export type IssueTimingEntry = {
  row: TimingRow;
  subtaskHours: number;
};

/** Human strings for the issue header strip. An empty `overdueLabel` means "on time". */
export interface TimingLabels {
  ageLabel: string;
  overdueLabel: string;
  stageLabel: string;
}

export interface TimelineOptions {
  limit?: number;
  types?: ActivityType[];
}

export class TimingService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  /**
   * Computed durations for one issue. Throws `notFound('Issue')` when the issue
   * does not exist, so a stale link cannot silently render an empty timeline.
   */
  async computeForIssue(issueId: number): Promise<IssueTiming> {
    const timings = await this.computeForIssues([issueId]);
    const timing = timings.get(issueId);
    if (!timing) throw notFound('Issue', issueId);
    return timing;
  }

  /**
   * Batch variant for list views. Two queries total — the issues themselves and
   * one recursive walk of the sub-task tree — so rendering 50 rows costs the
   * same as rendering one.
   */
  async computeForIssues(issueIds: readonly number[]): Promise<Map<number, IssueTiming>> {
    const entries = this.loadTimings(issueIds);
    const now = Date.now();
    const timings = new Map<number, IssueTiming>();
    for (const [id, entry] of entries) {
      timings.set(id, buildTiming(entry, now));
    }
    return timings;
  }

  /**
   * Human-readable summary of a timing block: how long the issue has existed,
   * how far past due it is, and which stage it is in.
   */
  describe(timing: IssueTiming, now: number = Date.now()): TimingLabels {
    const created = Date.parse(timing.createdAt);
    const end = timing.closedAt
      ? Date.parse(timing.closedAt)
      : timing.resolvedAt
        ? Date.parse(timing.resolvedAt)
        : now;
    const age = Math.max(0, end - created);

    let stageLabel: string;
    if (timing.timeToCloseMs !== null) {
      stageLabel = `closed after ${formatDuration(timing.timeToCloseMs)}`;
    } else if (timing.timeToResolveMs !== null) {
      stageLabel = `resolved after ${formatDuration(timing.timeToResolveMs)}`;
    } else if (timing.startedAt !== null) {
      const sinceStart = Math.max(0, now - Date.parse(timing.startedAt));
      stageLabel = `in progress for ${formatDuration(sinceStart)}`;
    } else {
      stageLabel = 'not started';
    }

    const overdueLabel =
      timing.overdueByMs !== null && timing.overdueByMs > 0
        ? `overdue by ${formatDuration(timing.overdueByMs)}`
        : '';

    return {
      ageLabel: `${timing.closedAt !== null || timing.resolvedAt !== null ? 'lived' : 'open for'} ${formatDuration(age)}`,
      overdueLabel,
      stageLabel,
    };
  }

  /**
   * The activity stream plus the computed durations, which together are what
   * the "timeline to show progress" requirement asks the UI to render.
   */
  async issueTimeline(issueId: number, options: TimelineOptions = {}): Promise<IssueTimeline> {
    const entry = this.loadTimings([issueId]).get(issueId);
    if (!entry) throw notFound('Issue', issueId);

    const now = Date.now();
    const timing = buildTiming(entry, now);
    const events = this.services.activity.forIssue(issueId, {
      limit: options.limit ?? 200,
      types: options.types,
    });

    const created = Date.parse(timing.createdAt);
    const ageMs = Math.max(0, (timing.closedAt ? Date.parse(timing.closedAt) : now) - created);

    return {
      issueId: issueId as IssueTimeline['issueId'],
      events,
      timing: {
        createdAt: timing.createdAt,
        startedAt: timing.startedAt,
        resolvedAt: timing.resolvedAt,
        closedAt: timing.closedAt,
        dueDate: timing.dueDate,
        ageMs,
        timeToStartMs: timing.timeToStartMs,
        timeInProgressMs: timing.timeInProgressMs,
        timeToResolveMs: timing.timeToResolveMs,
        timeToCloseMs: timing.timeToCloseMs,
        overdueByMs: timing.overdueByMs,
        // Own effort plus everything logged on the sub-task tree.
        totalLoggedHours: round2(entry.row.time_spent_hours + entry.subtaskHours),
      },
    };
  }

  /**
   * The raw rows behind `computeForIssues`. The dashboard's cycle-time chart
   * needs the same rows (to average per-issue durations) without paying for a
   * second sub-task traversal.
   */
  loadTimings(issueIds: readonly number[]): Map<number, IssueTimingEntry> {
    const ids = [...new Set(issueIds)].filter((id) => Number.isInteger(id) && id > 0);
    const entries = new Map<number, IssueTimingEntry>();
    if (ids.length === 0) return entries;

    const db = this.services.db;
    const rows = db.all<TimingRow>(
      `SELECT id, created_at, started_at, resolved_at, closed_at, due_date, time_spent_hours
         FROM issues
        WHERE id IN ${inClause(ids.length)}`,
      ids,
    );

    const subtaskHours = this.subtaskHours(ids);
    for (const row of rows) {
      entries.set(row.id, { row, subtaskHours: subtaskHours.get(row.id) ?? 0 });
    }
    return entries;
  }

  /** Current instant, isolated so callers and tests can pin it. */
  now(): string {
    return nowIso();
  }

  /**
   * One recursive walk of the sub-task forest, grouped by the requested root.
   * `UNION` (not `UNION ALL`) makes the walk terminate even if a cycle were
   * somehow introduced into `issues.parent_id`.
   */
  private subtaskHours(rootIds: readonly number[]): Map<number, number> {
    const seedPlaceholders = rootIds.map(() => '(?)').join(',');
    const rows = this.services.db.all<{ root_id: number; total: number }>(
      `WITH RECURSIVE
         seed(id) AS (VALUES ${seedPlaceholders}),
         subtree(root_id, id) AS (
           SELECT seed.id, i.id FROM seed JOIN issues i ON i.parent_id = seed.id
           UNION
           SELECT s.root_id, i.id FROM subtree s JOIN issues i ON i.parent_id = s.id
         )
       SELECT s.root_id AS root_id, COALESCE(SUM(i.time_spent_hours), 0) AS total
         FROM subtree s
         JOIN issues i ON i.id = s.id
        GROUP BY s.root_id`,
      [...rootIds],
    );

    const totals = new Map<number, number>();
    for (const row of rows) totals.set(row.root_id, Number(row.total ?? 0));
    return totals;
  }
}

/** Derive the timing block from one issue row. Pure — no database access. */
function buildTiming(entry: IssueTimingEntry, now: number): IssueTiming {
  const { row, subtaskHours } = entry;
  const created = Date.parse(row.created_at);

  const startedAt = row.started_at === null ? null : Date.parse(row.started_at);
  const resolvedAt = row.resolved_at === null ? null : Date.parse(row.resolved_at);
  const closedAt = row.closed_at === null ? null : Date.parse(row.closed_at);

  // In-progress time runs to whichever stop happened last, or to now.
  // Resolution ends the work; closing afterwards is administrative, so the
  // earlier of the two is the honest end point.
  const progressEnd = resolvedAt ?? closedAt ?? now;
  const inProgress = startedAt === null ? null : Math.max(0, progressEnd - startedAt);

  const due = row.due_date === null ? null : Date.parse(row.due_date);
  // Documented convention: overdue is measured to resolution, then to closure.
  // An issue resolved on time and closed weeks later was delivered on time, and
  // must not accrue lateness for the administrative delay.
  const atRiskUntil = resolvedAt ?? closedAt ?? now;

  return {
    createdAt: row.created_at,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    dueDate: row.due_date,
    timeToStartMs: startedAt === null ? null : Math.max(0, startedAt - created),
    timeInProgressMs: inProgress,
    timeToResolveMs: resolvedAt === null ? null : Math.max(0, resolvedAt - created),
    timeToCloseMs: closedAt === null ? null : Math.max(0, closedAt - created),
    overdueByMs: due === null ? null : Math.max(0, atRiskUntil - due),
    subtaskTimeSpentHours: round2(subtaskHours),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
