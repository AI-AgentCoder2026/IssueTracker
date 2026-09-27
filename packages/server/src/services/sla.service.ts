/**
 * SLA policies, per-issue clocks and the scheduler pass that alerts on them.
 *
 * A policy declares targets (`response`, `resolution`) and the issue filters it
 * applies to. Each matching (issue, policy, target) triple owns exactly one row
 * in `sla_clocks` — the `UNIQUE (policy_id, issue_id, target)` constraint is what
 * makes `ensureClocksForIssue` safe to call on every issue write.
 *
 * Alerting is a two-guard state machine rather than a comparison against a
 * window: `warned_at` and `breach_notified_at` are each written exactly once,
 * and the alert is only emitted by the UPDATE that actually changed a row. A
 * scheduler tick that overlaps a slow one therefore cannot double-notify, and
 * re-running the pass after a restart is a no-op.
 */

import type { Actor, CreateSlaPolicyInput, SlaPolicy, SlaStatus, SlaTarget } from '@tracker/shared';
import { createSlaPolicySchema } from '@tracker/shared';
import type { SqlParam } from '../db/connection.ts';
import { inClause } from '../db/connection.ts';
import { notFound } from '../errors.ts';
import {
  DEFAULT_BUSINESS_HOURS,
  MINUTE_MS,
  addBusinessMs,
  addMinutes,
  formatDuration,
  nowIso,
} from '../lib/time.ts';
import type { RequestAuditContext } from './audit.service.ts';
import type { Services } from './context.ts';

type PolicyRow = {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  applies_to: string;
  response_minutes: number | null;
  resolution_minutes: number | null;
  warning_minutes: number;
  business_hours_only: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type IssueForSla = {
  id: number;
  project_id: number;
  key: string;
  type: string;
  priority: string;
  state: string;
  assignee_id: number | null;
  created_at: string;
  started_at: string | null;
  resolved_at: string | null;
  updated_at: string;
};

/** An SLA clock joined to the issue and policy it belongs to. */
export type SlaClockView = SlaStatus & {
  policyName: string;
  issueKey: string;
  issueTitle: string;
  projectId: number;
  /** Warning runway still left; negative once the clock is inside the warning window. */
  warningMs: number | null;
  warnedAt: string | null;
  breachNotifiedAt: string | null;
};

export interface SlaSummary {
  total: number;
  onTrack: number;
  atRisk: number;
  breached: number;
  met: number;
}

export interface EvaluateResult {
  scanned: number;
  warned: number;
  breached: number;
}

/**
 * Everything the mutating methods need to attribute an audit entry: the
 * identity of whoever caused the change. A `RequestContext.auditContext`
 * satisfies this as-is, a `RequestContext` is passed as `ctx.auditContext`, and
 * a background job may pass nothing at all to record a system action.
 */
export type AuditScope = RequestAuditContext;

/** Hard cap per pass so one backlog cannot stall the scheduler. */
const MAX_PER_PASS = 200;

export class SlaService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  /**
   * Policies visible in a scope. `projectId === null` lists every policy
   * (instance-wide and per project); a number narrows to that project plus the
   * instance-wide defaults, because those apply to it too.
   */
  listPolicies(projectId: number | null): SlaPolicy[] {
    const rows =
      projectId === null
        ? this.services.db.all<PolicyRow>('SELECT * FROM sla_policies ORDER BY name ASC')
        : this.services.db.all<PolicyRow>(
            `SELECT * FROM sla_policies
              WHERE project_id = ? OR project_id IS NULL
              ORDER BY project_id IS NULL ASC, name ASC`,
            [projectId],
          );
    return rows.map((row) => mapPolicy(row));
  }

  /** One policy by id, or `notFound('SlaPolicy')`. */
  getPolicy(id: number): SlaPolicy {
    const row = this.services.db.get<PolicyRow>('SELECT * FROM sla_policies WHERE id = ?', [id]);
    if (!row) throw notFound('SlaPolicy', id);
    return mapPolicy(row);
  }

  /**
   * Create a policy. The input is validated with the shared zod schema so the
   * HTTP route and any internal caller enforce identical rules.
   */
  createPolicy(input: CreateSlaPolicyInput, ctx?: AuditScope): SlaPolicy {
    const parsed = createSlaPolicySchema.parse(input);
    const now = nowIso();

    const id = this.services.db.transaction(() => {
      const result = this.services.db.run(
        `INSERT INTO sla_policies
           (project_id, name, description, applies_to, response_minutes, resolution_minutes,
            warning_minutes, business_hours_only, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          parsed.projectId,
          parsed.name,
          parsed.description,
          JSON.stringify(parsed.appliesTo),
          parsed.responseMinutes,
          parsed.resolutionMinutes,
          parsed.warningMinutes,
          parsed.businessHoursOnly ? 1 : 0,
          parsed.enabled ? 1 : 0,
          now,
          now,
        ],
      );
      return result.lastInsertRowid;
    });

    const policy = this.getPolicy(id);
    this.audit(ctx, {
      action: 'sla.policy_changed',
      entityType: 'sla_policy',
      entityId: policy.id,
      projectId: policy.projectId,
      after: policy as unknown as Record<string, unknown>,
    });
    return policy;
  }

  /**
   * Patch a policy. The patch is merged over the stored row and the *result* is
   * re-validated, so a partial update can never leave an invalid combination.
   */
  updatePolicy(id: number, patch: Partial<CreateSlaPolicyInput>, ctx?: AuditScope): SlaPolicy {
    const before = this.getPolicy(id);
    const merged = createSlaPolicySchema.parse({
      projectId: before.projectId,
      name: before.name,
      description: before.description,
      appliesTo: before.appliesTo,
      responseMinutes: before.responseMinutes,
      resolutionMinutes: before.resolutionMinutes,
      warningMinutes: before.warningMinutes,
      businessHoursOnly: before.businessHoursOnly,
      enabled: before.enabled,
      ...patch,
    });

    this.services.db.run(
      `UPDATE sla_policies
          SET project_id = ?, name = ?, description = ?, applies_to = ?, response_minutes = ?,
              resolution_minutes = ?, warning_minutes = ?, business_hours_only = ?, enabled = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        merged.projectId,
        merged.name,
        merged.description,
        JSON.stringify(merged.appliesTo),
        merged.responseMinutes,
        merged.resolutionMinutes,
        merged.warningMinutes,
        merged.businessHoursOnly ? 1 : 0,
        merged.enabled ? 1 : 0,
        nowIso(),
        id,
      ],
    );

    const after = this.getPolicy(id);
    this.audit(ctx, {
      action: 'sla.policy_changed',
      entityType: 'sla_policy',
      entityId: id,
      projectId: after.projectId,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });
    return after;
  }

  /** Delete a policy. Its clocks cascade with it. */
  removePolicy(id: number, ctx?: AuditScope): void {
    const before = this.getPolicy(id);
    this.services.db.run('DELETE FROM sla_policies WHERE id = ?', [id]);
    this.audit(ctx, {
      action: 'sla.policy_changed',
      entityType: 'sla_policy',
      entityId: id,
      projectId: before.projectId,
      before: before as unknown as Record<string, unknown>,
    });
  }

  /**
   * Create the missing clocks for one issue. Idempotent: existing
   * (policy, issue, target) rows are skipped in JS and the insert is
   * `INSERT OR IGNORE`, so a concurrent caller loses the race harmlessly.
   *
   * Returns the number of clocks created, which is zero on every repeat call.
   */
  ensureClocksForIssue(issueId: number, _ctx?: AuditScope): number {
    const db = this.services.db;
    const issue = db.get<IssueForSla>(
      `SELECT id, project_id, key, type, priority, state, assignee_id,
              created_at, started_at, resolved_at, updated_at
         FROM issues WHERE id = ?`,
      [issueId],
    );
    if (!issue) throw notFound('Issue', issueId);

    const policies = db.all<PolicyRow>(
      'SELECT * FROM sla_policies WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?)',
      [issue.project_id],
    );
    if (policies.length === 0) return 0;

    const labelRows = db.all<{ label_id: number }>(
      'SELECT label_id FROM issue_labels WHERE issue_id = ?',
      [issueId],
    );
    const labelIds = new Set(labelRows.map((row) => row.label_id));

    const existing = new Set(
      db
        .all<{ policy_id: number; target: string }>(
          'SELECT policy_id, target FROM sla_clocks WHERE issue_id = ?',
          [issueId],
        )
        .map((row) => `${row.policy_id}:${row.target}`),
    );

    const firstComment = db.get<{ created_at: string }>(
      'SELECT created_at FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
      [issueId],
    );

    let created = 0;
    db.transaction(() => {
      for (const row of policies) {
        const policy = mapPolicy(row);
        if (!policyApplies(policy, issue, labelIds)) continue;

        for (const target of ['response', 'resolution'] as const) {
          if (existing.has(`${policy.id}:${target}`)) continue;

          const minutes = target === 'response' ? policy.responseMinutes : policy.resolutionMinutes;
          if (minutes === null) continue;

          const startsAt = target === 'response' ? issue.created_at : issue.started_at ?? issue.created_at;
          const dueAt = policy.businessHoursOnly
            ? addBusinessMs(startsAt, minutes * MINUTE_MS, {
                startHour: DEFAULT_BUSINESS_HOURS.startHour,
                endHour: DEFAULT_BUSINESS_HOURS.endHour,
                workingDays: DEFAULT_BUSINESS_HOURS.workingDays,
              })
            : addMinutes(startsAt, minutes);

          // Response is met by the first human touch (assignment or comment);
          // resolution by `resolved_at`.
          const metAt =
            target === 'resolution'
              ? issue.resolved_at
              : firstComment?.created_at ?? (issue.assignee_id !== null ? issue.updated_at : null);

          const result = db.run(
            `INSERT OR IGNORE INTO sla_clocks
               (policy_id, issue_id, target, starts_at, due_at, met_at)
             VALUES (?,?,?,?,?,?)`,
            [policy.id, issueId, target, startsAt, dueAt, metAt],
          );
          created += result.changes;
        }
      }
    });

    return created;
  }

  /** Live countdown state for one issue, one entry per clock. */
  async statusForIssue(issueId: number): Promise<SlaStatus[]> {
    const now = Date.now();
    const rows = this.services.db.all<ClockJoinRow>(
      `${CLOCK_JOIN_SQL} WHERE c.issue_id = ? ORDER BY c.target ASC, c.policy_id ASC`,
      [issueId],
    );
    return rows.map((row) => toStatus(row, now));
  }

  /**
   * Scheduler entry point. Two passes — warning, then breach — each of which
   * only alerts for the UPDATE that flipped its guard column. Safe to call on a
   * timer, concurrently, or twice in a row.
   */
  evaluate(now: number = Date.now()): EvaluateResult {
    const db = this.services.db;
    const nowIsoValue = nowIso();
    const result: EvaluateResult = { scanned: 0, warned: 0, breached: 0 };

    // Warnings only for clocks still in the future: a clock already past due
    // gets the breach alert in the second pass instead of both.
    const dueSoon = db.all<AlertRow>(
      `${ALERT_JOIN_SQL}
        WHERE c.due_at IS NOT NULL
          AND c.met_at IS NULL
          AND c.warned_at IS NULL
          AND p.enabled = 1
          AND c.due_at > ?
          AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%fZ', julianday(?) + (p.warning_minutes / 1440.0))
        ORDER BY c.due_at ASC
        LIMIT ?`,
      [nowIsoValue, nowIsoValue, MAX_PER_PASS],
    );
    result.scanned = dueSoon.length;

    for (const row of dueSoon) {
      // The WHERE clause guarantees a due date; the guard keeps the type honest.
      if (row.due_at === null) continue;
      const remaining = Date.parse(row.due_at) - now;
      const changed = db.run('UPDATE sla_clocks SET warned_at = ? WHERE id = ? AND warned_at IS NULL', [
        nowIsoValue,
        row.clock_id,
      ]);
      if (changed.changes === 0) continue;

      result.warned += 1;
      this.raise(row, {
        type: 'sla.warning',
        event: 'issue.due_soon',
        summary: `SLA "${row.policy_name}" ${row.target} due in ${formatDuration(Math.max(0, remaining))}`,
        title: `${row.issue_key} is approaching its ${row.target} SLA`,
        body: `The ${row.target} target of "${row.policy_name}" is due ${formatDuration(Math.max(0, remaining))} from now.`,
      });
    }

    const breached = db.all<AlertRow>(
      `${ALERT_JOIN_SQL}
        WHERE c.due_at IS NOT NULL
          AND c.met_at IS NULL
          AND c.breach_notified_at IS NULL
          AND p.enabled = 1
          AND c.due_at <= ?
        ORDER BY c.due_at ASC
        LIMIT ?`,
      [nowIsoValue, MAX_PER_PASS],
    );
    result.scanned += breached.length;

    for (const row of breached) {
      if (row.due_at === null) continue;
      const overdueBy = now - Date.parse(row.due_at);
      const changed = db.run(
        'UPDATE sla_clocks SET breach_notified_at = ? WHERE id = ? AND breach_notified_at IS NULL',
        [nowIsoValue, row.clock_id],
      );
      if (changed.changes === 0) continue;

      result.breached += 1;
      this.raise(row, {
        type: 'sla.breached',
        event: 'issue.sla_breach',
        summary: `SLA "${row.policy_name}" ${row.target} breached by ${formatDuration(overdueBy)}`,
        title: `${row.issue_key} breached its ${row.target} SLA`,
        body: `"${row.policy_name}" was breached ${formatDuration(overdueBy)} ago.`,
      });
    }

    return result;
  }

  /**
   * One query behind both the `sla_countdown` widget and the
   * `/api/sla/at-risk` + `/api/sla/breached` routes, so the chart and the list
   * can never show different numbers.
   */
  clocksForProjects(
    projectIds: readonly number[],
    options: { windowMs?: number; includeBreached?: boolean; issueType?: string; limit?: number } = {},
  ): SlaClockView[] {
    const ids = [...new Set(projectIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return [];

    const now = Date.now();
    const scope = `c.issue_id IN (SELECT id FROM issues WHERE project_id IN ${inClause(ids.length)})`;
    const clauses: string[] = [scope, 'c.met_at IS NULL', 'c.due_at IS NOT NULL'];
    const params: SqlParam[] = [...ids];

    if (options.windowMs !== undefined) {
      // Not yet due, but inside the window.
      clauses.push('c.due_at > ?');
      params.push(nowIsoValue(now));
    }
    if (options.includeBreached === true) {
      clauses.push('c.due_at <= ?');
      params.push(nowIsoValue(now));
    }
    if (options.issueType) {
      clauses.push('i.type = ?');
      params.push(options.issueType);
    }

    const rows = this.services.db.all<ClockJoinRow>(
      `${CLOCK_JOIN_SQL} WHERE ${clauses.join(' AND ')} ORDER BY c.due_at ASC LIMIT ?`,
      [...params, options.limit ?? MAX_PER_PASS],
    );
    return rows.map((row) => toClockView(row, now));
  }

  /** Unmet clocks due within `windowMs`, soonest first. */
  atRisk(projectIds: readonly number[], windowMs: number): SlaClockView[] {
    return this.clocksForProjects(projectIds, { windowMs });
  }

  /** Unmet clocks already past due, soonest first. */
  breached(projectIds: readonly number[]): SlaClockView[] {
    return this.clocksForProjects(projectIds, { includeBreached: true });
  }

  /**
   * Projects an actor may read. Instance admins get every project; everyone
   * else gets their memberships, so an unscoped countdown query can never
   * leak another project's issues.
   */
  projectIdsFor(actor: Actor): number[] {
    if (actor.isInstanceAdmin) {
      return this.services.db
        .all<{ id: number }>('SELECT id FROM projects')
        .map((row) => row.id);
    }
    return [...actor.projectRoles.keys()].map((id) => Number(id));
  }

  /** Aggregate clock counts for one project, in a single grouped query. */
  summary(projectId: number): SlaSummary {
    const now = nowIso();
    const row = this.services.db.get<{
      total: number | null;
      met: number | null;
      breached: number | null;
      at_risk: number | null;
      on_track: number | null;
    }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN c.met_at IS NOT NULL THEN 1 ELSE 0 END) AS met,
         SUM(CASE WHEN c.met_at IS NULL AND c.due_at <= ? THEN 1 ELSE 0 END) AS breached,
         SUM(CASE WHEN c.met_at IS NULL AND c.due_at > ?
                   AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%fZ', julianday(?) + (p.warning_minutes / 1440.0))
             THEN 1 ELSE 0 END) AS at_risk,
         SUM(CASE WHEN c.met_at IS NULL AND c.due_at >
                   strftime('%Y-%m-%dT%H:%M:%fZ', julianday(?) + (p.warning_minutes / 1440.0))
             THEN 1 ELSE 0 END) AS on_track
       FROM sla_clocks c
       JOIN sla_policies p ON p.id = c.policy_id
       JOIN issues i ON i.id = c.issue_id
      WHERE i.project_id = ? AND p.enabled = 1`,
      [now, now, now, now, projectId],
    );

    return {
      total: Number(row?.total ?? 0),
      met: Number(row?.met ?? 0),
      breached: Number(row?.breached ?? 0),
      atRisk: Number(row?.at_risk ?? 0),
      onTrack: Number(row?.on_track ?? 0),
    };
  }

  /** Append one activity event and fan the matching notification out. */
  private raise(
    row: AlertRow,
    alert: { type: 'sla.warning' | 'sla.breached'; event: 'issue.due_soon' | 'issue.sla_breach'; summary: string; title: string; body: string },
  ): void {
    this.services.activity.record({
      issueId: row.issue_id,
      projectId: row.project_id,
      type: alert.type,
      summary: alert.summary,
      isSystemGenerated: true,
      metadata: {
        policyId: row.policy_id,
        policyName: row.policy_name,
        target: row.target,
        dueAt: row.due_at,
      },
    });

    this.services.notifications.notify({
      event: alert.event,
      issueId: row.issue_id,
      projectId: row.project_id,
      title: alert.title,
      body: alert.body,
      payload: { policyId: row.policy_id, target: row.target, dueAt: row.due_at },
    });
  }

  private audit(
    ctx: AuditScope | undefined,
    input: {
      action: 'sla.policy_changed';
      entityType: string;
      entityId: number;
      projectId: number | null;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): void {
    this.services.audit.record(
      {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId,
        before: input.before,
        after: input.after,
        actorId: ctx?.actorId ?? null,
      },
      ctx ?? {},
    );
  }
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

type ClockJoinRow = {
  policy_id: number;
  policy_name: string;
  warning_minutes: number;
  issue_id: number;
  project_id: number;
  issue_key: string;
  issue_title: string;
  target: string;
  starts_at: string;
  due_at: string | null;
  met_at: string | null;
  warned_at: string | null;
  breach_notified_at: string | null;
};

type AlertRow = ClockJoinRow & { clock_id: number };

const CLOCK_JOIN_SQL = `
  SELECT c.policy_id AS policy_id, p.name AS policy_name, p.warning_minutes AS warning_minutes,
         c.issue_id AS issue_id, i.project_id AS project_id, i.key AS issue_key,
         i.title AS issue_title, c.target AS target, c.starts_at AS starts_at,
         c.due_at AS due_at, c.met_at AS met_at, c.warned_at AS warned_at,
         c.breach_notified_at AS breach_notified_at
    FROM sla_clocks c
    JOIN sla_policies p ON p.id = c.policy_id
    JOIN issues i ON i.id = c.issue_id`;

const ALERT_JOIN_SQL = `
  SELECT c.id AS clock_id, c.policy_id AS policy_id, p.name AS policy_name,
         p.warning_minutes AS warning_minutes, c.issue_id AS issue_id,
         i.project_id AS project_id, i.key AS issue_key, i.title AS issue_title,
         c.target AS target, c.starts_at AS starts_at, c.due_at AS due_at,
         c.met_at AS met_at, c.warned_at AS warned_at, c.breach_notified_at AS breach_notified_at
    FROM sla_clocks c
    JOIN sla_policies p ON p.id = c.policy_id
    JOIN issues i ON i.id = c.issue_id`;

function mapPolicy(row: PolicyRow): SlaPolicy {
  return {
    id: row.id as SlaPolicy['id'],
    projectId: row.project_id === null ? null : (row.project_id as SlaPolicy['projectId']),
    name: row.name,
    description: row.description,
    appliesTo: parseAppliesTo(row.applies_to),
    responseMinutes: row.response_minutes,
    resolutionMinutes: row.resolution_minutes,
    warningMinutes: Number(row.warning_minutes),
    businessHoursOnly: Number(row.business_hours_only) === 1,
    // `calendarId` has no column in 001_init.sql; business hours use the
    // instance default window in lib/time.ts.
    calendarId: null,
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAppliesTo(raw: string): SlaPolicy['appliesTo'] {
  const empty: SlaPolicy['appliesTo'] = { types: [], priorities: [], labelIds: [], states: [] };
  if (typeof raw !== 'string' || raw === '') return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<SlaPolicy['appliesTo']>;
    return {
      types: Array.isArray(parsed.types) ? (parsed.types as SlaPolicy['appliesTo']['types']) : [],
      priorities: Array.isArray(parsed.priorities)
        ? (parsed.priorities as SlaPolicy['appliesTo']['priorities'])
        : [],
      labelIds: Array.isArray(parsed.labelIds) ? parsed.labelIds.map(Number) : [],
      states: Array.isArray(parsed.states) ? (parsed.states as SlaPolicy['appliesTo']['states']) : [],
    };
  } catch {
    return empty;
  }
}

/** Does this policy's filter select the given issue? An empty filter matches all. */
function policyApplies(policy: SlaPolicy, issue: IssueForSla, labelIds: ReadonlySet<number>): boolean {
  const appliesTo = policy.appliesTo;
  if (appliesTo.types.length > 0 && !appliesTo.types.includes(issue.type as SlaPolicy['appliesTo']['types'][number])) {
    return false;
  }
  if (
    appliesTo.priorities.length > 0 &&
    !appliesTo.priorities.includes(
      issue.priority as SlaPolicy['appliesTo']['priorities'][number],
    )
  ) {
    return false;
  }
  if (
    appliesTo.states.length > 0 &&
    !appliesTo.states.includes(issue.state as SlaPolicy['appliesTo']['states'][number])
  ) {
    return false;
  }
  if (appliesTo.labelIds.length > 0 && !appliesTo.labelIds.some((id) => labelIds.has(id))) {
    return false;
  }
  return true;
}

type ClockState = {
  state: SlaStatus['state'];
  remainingMs: number | null;
  breached: boolean;
};

/**
 * Classify one clock. `warningMs` is the policy's warning runway, so a clock
 * inside that window is `at_risk` rather than merely `on_track`.
 */
function classify(dueAt: string | null, metAt: string | null, warningMs: number, now: number): ClockState {
  if (metAt !== null) return { state: 'met', remainingMs: null, breached: false };
  if (dueAt === null) return { state: 'not_started', remainingMs: null, breached: false };
  const remainingMs = Date.parse(dueAt) - now;
  return {
    state: remainingMs < 0 ? 'breached' : remainingMs <= warningMs ? 'at_risk' : 'on_track',
    remainingMs,
    breached: remainingMs < 0,
  };
}

function toStatus(row: ClockJoinRow, now: number): SlaStatus {
  const warningMs = Number(row.warning_minutes) * MINUTE_MS;
  const { state, remainingMs, breached } = classify(row.due_at, row.met_at, warningMs, now);
  return {
    policyId: row.policy_id as SlaStatus['policyId'],
    issueId: row.issue_id as SlaStatus['issueId'],
    target: row.target as SlaTarget,
    startsAt: row.starts_at,
    dueAt: row.due_at,
    remainingMs,
    metAt: row.met_at,
    breached,
    state,
  };
}

function toClockView(row: ClockJoinRow, now: number): SlaClockView {
  const status = toStatus(row, now);
  return {
    ...status,
    policyName: row.policy_name,
    issueKey: row.issue_key,
    issueTitle: row.issue_title,
    projectId: row.project_id,
    // Negative once the warning window has been entered.
    warningMs:
      status.remainingMs === null ? null : status.remainingMs - Number(row.warning_minutes) * MINUTE_MS,
    warnedAt: row.warned_at,
    breachNotifiedAt: row.breach_notified_at,
  };
}

function nowIsoValue(now: number): string {
  return new Date(now).toISOString();
}
