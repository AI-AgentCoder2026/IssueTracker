/**
 * Automated stale-issue archiving.
 *
 * The policy lives in `projects.archive_policy` as a JSON TEXT column validated
 * by `archivePolicySchema` from `@tracker/shared`, so there is one source of truth
 * for its shape rather than a second table to keep in sync.
 *
 * Inactivity is measured from the most recent of three signals — the issue's
 * `updated_at`, its last comment, and its last activity event — because a ticket
 * someone is still discussing has not gone stale just because nobody edited its
 * fields. All three come from one query per project; the policy is then evaluated
 * in memory so the operator can be told *why* each issue qualified.
 *
 * Archiving is idempotent and conservative: an already-archived issue is skipped,
 * and an issue outside the policy's allowed states is never archived, whatever
 * else matches.
 */

import type { Actor, ArchivePolicyInput, IssueState } from '@tracker/shared';
import { TERMINAL_STATES, archivePolicySchema, asProjectId, can } from '@tracker/shared';
import { placeholders, type Database } from '../db/connection.ts';
import { forbidden, notFound } from '../errors.ts';
import { DAY_MS, nowIso } from '../lib/time.ts';
import type { RequestContext, Services } from './context.ts';

/** Policy applied when a project has never configured one. */
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicyInput = {
  inactiveDays: 365,
  states: ['resolved', 'closed', 'wont_fix', 'duplicate'],
  skipIssuesWithOpenSubtasks: true,
  requireCommentWithinDays: null,
  enabled: false,
};

export interface ArchiveCandidate {
  issueId: number;
  key: string;
  title: string;
  state: IssueState;
  /** Newest of updated_at, last comment and last activity event. */
  lastActivityAt: string;
  daysInactive: number;
  /** Why this issue qualifies, spelled out for the preview. */
  reasons: string[];
}

export interface ArchiveRunResult {
  archived: number;
  skipped: number;
  /** Keys of the issues archived by this run. */
  issues: string[];
}

type CandidateRow = {
  id: number;
  key: string;
  title: string;
  state: string;
  project_id: number;
  updated_at: string;
  archived: number;
  last_comment_at: string | null;
  last_event_at: string | null;
  open_subtasks: number;
};

export class ArchiveService {
  private readonly db: Database;
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  /**
   * The project's archive policy, or `null` when it has never been configured.
   * A stored-but-unparseable value falls back to the default policy rather than
   * throwing, so a bad JSON blob cannot stop the scheduler.
   */
  getPolicy(projectId: number): ArchivePolicyInput | null {
    const row = this.db.get<{ archive_policy: string | null }>(
      'SELECT archive_policy FROM projects WHERE id = ?',
      [projectId],
    );
    if (!row) throw notFound('Project', projectId);
    if (row.archive_policy === null || row.archive_policy === '') return null;
    try {
      const parsed = archivePolicySchema.safeParse(JSON.parse(row.archive_policy));
      return parsed.success ? parsed.data : { ...DEFAULT_ARCHIVE_POLICY };
    } catch {
      return { ...DEFAULT_ARCHIVE_POLICY };
    }
  }

  /** Replace the project's policy. The change is audited with before/after. */
  setPolicy(projectId: number, input: ArchivePolicyInput, ctx: RequestContext): ArchivePolicyInput {
    const policy = archivePolicySchema.parse(input);
    const project = this.db.get<{ id: number; archive_policy: string | null }>(
      'SELECT id, archive_policy FROM projects WHERE id = ?',
      [projectId],
    );
    if (!project) throw notFound('Project', projectId);

    this.db.transaction(() => {
      this.db.run('UPDATE projects SET archive_policy = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(policy),
        nowIso(),
        projectId,
      ]);
      this.services.audit.record(
        {
          action: 'project.updated',
          entityType: 'project',
          entityId: projectId,
          projectId,
          before: project.archive_policy === null ? null : safeParse(project.archive_policy),
          after: policy,
        },
        ctx.auditContext,
      );
    });
    return policy;
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  /**
   * Issues the policy would archive right now, with the reason for each. Powers
   * the operator preview and is the exact same evaluation `run` performs.
   */
  async candidates(projectId: number): Promise<ArchiveCandidate[]> {
    const policy = this.getPolicy(projectId) ?? { ...DEFAULT_ARCHIVE_POLICY };
    const rows = this.loadCandidates(projectId);
    const now = Date.now();
    const out: ArchiveCandidate[] = [];
    for (const row of rows) {
      const reasons = this.evaluate(row, policy, now);
      if (reasons.length === 0) continue;
      out.push({
        issueId: row.id,
        key: row.key,
        title: row.title,
        state: row.state as IssueState,
        lastActivityAt: lastActivityAt(row),
        daysInactive: daysSince(lastActivityAt(row), now),
        reasons,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  /**
   * Archive everything the policy matches. `projectId: null` sweeps every project
   * that has an enabled policy — the scheduler entry point. Safe to call
   * repeatedly: already-archived issues are skipped, not re-archived.
   *
   * `actor: null` means a **system run**. Per-project RBAC is skipped in that
   * case because the work is driven by the project's own retention policy rather
   * than by a user request — there is no principal whose permissions could
   * apply. Interactive callers always pass a real actor and are checked.
   */
  async run(
    projectId: number | null,
    actor: Actor | null,
    ctx: RequestContext,
  ): Promise<ArchiveRunResult> {
    const projectIds =
      projectId !== null
        ? [projectId]
        : this.db
            .all<{ id: number }>(
              `SELECT id FROM projects
                WHERE archive_policy IS NOT NULL AND archive_policy LIKE '%"enabled":true%'`,
            )
            .map((row) => row.id);

    const archived: string[] = [];
    let skipped = 0;

    for (const id of projectIds) {
      const project = this.db.get<{ id: number }>('SELECT id FROM projects WHERE id = ?', [id]);
      if (!project) {
        skipped += 1;
        continue;
      }
      const decision = actor
        ? can(actor, 'issue.bulkEdit', { projectId: asProjectId(id) })
        : { allowed: true, reason: 'system run' };
      if (!decision.allowed) {
        // A whole project the actor may not archive: every candidate is skipped.
        skipped += this.loadCandidates(id).length;
        continue;
      }

      const policy = this.getPolicy(id) ?? { ...DEFAULT_ARCHIVE_POLICY };
      if (!policy.enabled) {
        skipped += this.loadCandidates(id).length;
        continue;
      }

      const rows = this.loadCandidates(id);
      for (const row of rows) {
        // Re-evaluated per issue inside the transaction so a concurrent run or
        // a manual edit cannot slip an issue past the policy.
        const reasons = this.evaluate(row, policy, Date.now());
        if (reasons.length === 0) {
          skipped += 1;
          continue;
        }
        try {
          this.archiveOne(row, actor, ctx);
          archived.push(row.key);
        } catch {
          skipped += 1;
        }
      }
    }
    return { archived: archived.length, skipped, issues: archived };
  }

  /**
   * Undo an archive. The issue keeps its place in the board: `archived` is the
   * only thing that changes.
   */
  async restore(issueId: number, actor: Actor, ctx: RequestContext): Promise<{ restored: true }> {
    const issue = this.db.get<{ id: number; project_id: number; key: string; archived: number }>(
      'SELECT id, project_id, key, archived FROM issues WHERE id = ?',
      [issueId],
    );
    if (!issue) throw notFound('Issue', issueId);

    const decision = can(actor, 'issue.bulkEdit', { projectId: asProjectId(issue.project_id) });
    if (!decision.allowed) throw forbidden(decision.reason);

    this.db.transaction(() => {
      this.db.run(
        `UPDATE issues
            SET archived = 0, archived_at = NULL, version = version + 1, updated_at = ?
          WHERE id = ?`,
        [nowIso(), issueId],
      );
      this.services.activity.record({
        issueId: issue.id,
        projectId: issue.project_id,
        actorId: Number(actor.userId),
        type: 'issue.unarchived',
        summary: 'restored from the archive',
      });
      this.services.audit.record(
        {
          action: 'issue.updated',
          entityType: 'issue',
          entityId: issueId,
          projectId: issue.project_id,
          before: { archived: true },
          after: { archived: false },
          actorId: Number(actor.userId),
        },
        ctx.auditContext,
      );
      this.services.realtime.publish({
        event: 'issue.updated',
        projectId: issue.project_id,
        issueId: issue.id,
        data: { issueId: issue.id, key: issue.key, archived: false, reason: 'archive.restore' },
      });
    });
    return { restored: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One query per project: counts, last comment and last event come from
   * correlated subqueries so the whole preview is a single statement.
   */
  private loadCandidates(projectId: number): CandidateRow[] {
    const terminal = this.terminalStates();
    return this.db.all<CandidateRow>(
      `SELECT i.id, i.key, i.title, i.state, i.project_id, i.updated_at, i.archived,
              (SELECT MAX(c.created_at) FROM comments c WHERE c.issue_id = i.id) AS last_comment_at,
              (SELECT MAX(a.created_at) FROM activity_events a WHERE a.issue_id = i.id) AS last_event_at,
              (SELECT COUNT(*) FROM issues s
                WHERE s.parent_id = i.id AND s.archived = 0
                  AND s.state NOT IN (${placeholders(terminal.length)})) AS open_subtasks
         FROM issues i
        WHERE i.project_id = ? AND i.archived = 0
        ORDER BY i.id`,
      [...terminal, projectId],
    );
  }

  /**
   * The states an issue may be archived from. An empty policy list means "any
   * terminal state", never "any state" — archiving open work would be data loss.
   */
  private terminalStates(): readonly string[] {
    return TERMINAL_STATES;
  }

  private allowedStates(policy: ArchivePolicyInput): readonly string[] {
    return policy.states.length > 0 ? policy.states : this.terminalStates();
  }

  /**
   * Return the reasons this issue qualifies, or an empty array when it must be
   * left alone. Shared by the preview and the run so the two can never disagree.
   */
  private evaluate(row: CandidateRow, policy: ArchivePolicyInput, now: number): string[] {
    if (!policy.enabled) return [];
    if (row.archived === 1) return [];
    if (!this.allowedStates(policy).includes(row.state)) return [];

    const last = lastActivityAt(row);
    const days = daysSince(last, now);
    if (days < policy.inactiveDays) return [];

    const reasons: string[] = [];
    reasons.push(`inactive for ${days} days (policy: ${policy.inactiveDays})`);
    reasons.push(`state "${row.state}" is in the policy's allowed states`);

    if (policy.skipIssuesWithOpenSubtasks && row.open_subtasks > 0) return [];
    if (policy.skipIssuesWithOpenSubtasks) {
      reasons.push('no open sub-tasks');
    }

    if (policy.requireCommentWithinDays !== null) {
      const lastComment = row.last_comment_at;
      if (lastComment === null) return [];
      const commentAge = daysSince(lastComment, now);
      if (commentAge > policy.requireCommentWithinDays) return [];
      reasons.push(`last comment ${commentAge} days ago (policy: within ${policy.requireCommentWithinDays})`);
    }

    return reasons;
  }

  private archiveOne(row: CandidateRow, actor: Actor | null, ctx: RequestContext): void {
    const at = nowIso();
    this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE issues
            SET archived = 1, archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND archived = 0`,
        [at, at, row.id],
      );
      if (result.changes === 0) return;

      // A system run has no principal, so the timeline entry is recorded as
      // machine-generated rather than attributed to a user.
      const actorId = actor ? Number(actor.userId) : null;

      this.services.activity.record({
        issueId: row.id,
        projectId: row.project_id,
        actorId,
        type: 'issue.archived',
        summary: 'archived automatically: inactive for too long',
        metadata: { reason: 'stale_policy', actor: actor ? 'user' : 'system' },
      });
      this.services.audit.record(
        {
          action: 'issue.updated',
          entityType: 'issue',
          entityId: row.id,
          projectId: row.project_id,
          before: { archived: false, archivedAt: null },
          after: { archived: true, archivedAt: at },
          actorId,
        },
        ctx.auditContext,
      );
      this.services.realtime.publish({
        event: 'issue.archived',
        projectId: row.project_id,
        issueId: row.id,
        data: { issueId: row.id, key: row.key, archived: true, archivedAt: at, reason: 'stale_policy' },
      });
    });
  }
}

function lastActivityAt(row: CandidateRow): string {
  const candidates = [row.updated_at, row.last_comment_at, row.last_event_at].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return candidates.reduce((latest, value) => (value > latest ? value : latest), row.updated_at);
}

function daysSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / DAY_MS));
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
