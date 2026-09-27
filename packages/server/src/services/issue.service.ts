/**
 * Issue lifecycle service.
 *
 * Owns create/read/update/delete, the status-transition rules, parent/child
 * nesting with cycle prevention, dependency links, time logging, watching and
 * the Kanban board projection.
 *
 * Two invariants drive most of the design:
 *
 *  1. **Optimistic concurrency.** Every row carries `version`. A client that
 *     read v3 and writes back `expectedVersion: 3` succeeds; if someone else
 *     wrote in between, the caller gets a 409 instead of silently clobbering
 *     their edit.
 *  2. **No silent side effects.** Every mutation writes exactly one activity
 *     event (or a batch summary) and one audit entry, publishes the realtime
 *     event, and — where a downstream system cares — notifies. That is what
 *     keeps the timeline, the audit trail and the board in agreement.
 */

import {
  isBlocking,
  type ActivityType,
  type CreateIssueInput,
  type DependencyKind,
  type Issue,
  type IssueLink,
  type IssuePriority,
  type IssueState,
  type IssueSummary,
  type IssueType,
  type ServerEvent,
  type TransitionCheck,
  type TransitionRequest,
  type UpdateIssueInput,
} from '@tracker/shared';
import {
  badRequest,
  conflict,
  cycleDetected,
  forbidden,
  internalError,
  notFound,
  versionConflict,
  workflowViolation,
} from '../errors.ts';
import { placeholders, type Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';
import type { RequestAuditContext, Services } from './context.ts';

/** Columns captured in the audit `before` snapshot. */
const AUDITED_FIELDS = [
  'title',
  'description',
  'type',
  'priority',
  'state',
  'status_id',
  'assignee_id',
  'parent_id',
  'due_date',
  'estimate_hours',
  'time_spent_hours',
  'milestone_id',
  'archived',
  'version',
] as const;

/**
 * Fields that count as a *user-visible* change for the activity timeline.
 *
 * `version` is deliberately excluded: it is bumped by every write, so including
 * it would make a no-op update look like an edit and fill the timeline with
 * "changed version from 3 to 4" noise.
 */
const ACTIVITY_DIFF_FIELDS = AUDITED_FIELDS.filter((field) => field !== 'version');

/** camelCase field -> database column, for audit summaries. */
const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  type: 'type',
  priority: 'priority',
  state: 'status',
  status_id: 'status',
  assignee_id: 'assignee',
  parent_id: 'parent issue',
  due_date: 'due date',
  estimate_hours: 'estimate',
  time_spent_hours: 'time spent',
  milestone_id: 'milestone',
  archived: 'archived state',
};

export interface IssueCreateResult {
  issue: Issue;
  /** Present when duplicate detection flagged likely duplicates. */
  duplicateCandidates: Array<{ issueId: number; key: string; title: string; confidence: number }>;
}

export interface BoardColumn {
  statusId: number;
  key: string;
  name: string;
  color: string;
  wipLimit: number | null;
  issues: IssueSummary[];
}

export interface Board {
  projectId: number;
  workflowId: number;
  columns: BoardColumn[];
}

/** One candidate destination in the status picker. */
export interface AvailableTransition {
  statusId: number;
  key: string;
  name: string;
  color: string;
  allowed: boolean;
  reason: string;
  transitionId: number | null;
  requiredPermission: string | null;
  isResolution: boolean;
  isClosed: boolean;
}

export class IssueService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }
  private get db(): Database {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create an issue. Sequence allocation increments the project's counter
   * inside the transaction, so two concurrent creates can never share a number.
   */
  async create(
    projectId: number,
    input: CreateIssueInput,
    actorId: number,
    ctx: RequestAuditContext = {},
  ): Promise<IssueCreateResult> {
    const project = this.db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) throw notFound('Project', projectId);

    const issueId = this.db.transaction(() => {
      // Increment then read back inside the transaction. SQLite serialises
      // writers, so two concurrent creates can never be handed the same number.
      this.db.run('UPDATE projects SET next_issue_number = next_issue_number + 1 WHERE id = ?', [projectId]);
      const allocated = Number(
        this.db.scalar<number>('SELECT next_issue_number - 1 FROM projects WHERE id = ?', [projectId]),
      );
      if (!Number.isInteger(allocated)) {
        throw internalError(`Could not allocate an issue number for project ${projectId}`);
      }

      const key = `${String(project.key)}-${allocated}`;

      // Resolve the target status: explicit id, else the matching state, else
      // the project's initial status.
      let statusId: number;
      if (input.statusId !== undefined) {
        const status = this.db.get<{ id: number }>(
          'SELECT id FROM workflow_statuses WHERE id = ? AND project_id = ?',
          [input.statusId, projectId],
        );
        if (!status) throw badRequest(`Status ${input.statusId} does not belong to this project`);
        statusId = input.statusId;
      } else if (input.state !== undefined) {
        statusId = this.services.workflow.statusIdForState(projectId, input.state);
      } else {
        statusId = this.services.workflow.initialStatusId(projectId);
      }

      const state = this.stateForStatus(projectId, statusId);
      const position = this.nextPositionInStatus(projectId, statusId);

      const id = Number(
        this.db.run(
          `INSERT INTO issues
             (project_id, sequence, key, title, description, type, priority, state, status_id,
              assignee_id, reporter_id, parent_id, due_date, estimate_hours, position, milestone_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            projectId,
            allocated,
            key,
            input.title,
            input.description ?? '',
            input.type,
            input.priority,
            state,
            statusId,
            input.assigneeId ?? null,
            actorId,
            input.parentId ?? null,
            input.dueDate ?? null,
            input.estimateHours ?? null,
            position,
            input.milestoneId ?? null,
          ],
        ).lastInsertRowid,
      );

      if (input.labelIds && input.labelIds.length > 0) {
        this.setLabels(id, input.labelIds);
      }

      if (input.assigneeId) {
        this.setWatcher(id, input.assigneeId);
      }

      return id;
    });

    const issue = this.getById(issueId);

    this.services.activity.record({
      issueId,
      projectId,
      actorId,
      type: 'issue.created',
      summary: `created this ${issue.type}`,
      metadata: { key: issue.key },
    });

    this.services.audit.record(
      {
        action: 'issue.created',
        entityType: 'issue',
        entityId: issueId,
        projectId,
        actorId,
        after: this.snapshot(issue),
      },
      ctx,
    );

    if (issue.assigneeId && issue.assigneeId !== actorId) {
      this.services.notifications.notify(
        {
          event: 'issue.assigned',
          title: `You were assigned ${issue.key}`,
          body: issue.title,
          issueId,
          projectId,
          excludeUserIds: [actorId],
        },
        { excludeUserIds: [actorId] },
      );
    }

    this.publishIssue('issue.created', issue, actorId);

    // Surface likely duplicates at creation time; the caller decides whether to
    // link them. This satisfies the "AI-driven duplicate detection" UX.
    let duplicateCandidates: IssueCreateResult['duplicateCandidates'] = [];
    try {
      const candidates = await this.services.dedupe.suggestForIssue(issueId, 5);
      duplicateCandidates = candidates.map((candidate) => ({
        issueId: Number(candidate.candidateIssueId),
        key: candidate.candidateKey,
        title: candidate.candidateTitle,
          confidence: candidate.confidence,
        }));
    } catch {
      // Duplicate detection is advisory; never fail a create over it.
      duplicateCandidates = [];
    }

    return { issue, duplicateCandidates };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getById(issueId: number): Issue {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT i.*, p.key AS project_key
       FROM issues i JOIN projects p ON p.id = i.project_id
       WHERE i.id = ?`,
      [issueId],
    );
    if (!row) throw notFound('Issue', issueId);
    return this.mapIssue(row);
  }

  /** Issue plus its project key, resolved in one query. */
  findByKey(projectKey: string, issueKey: string): Issue | null {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT i.*, p.key AS project_key
       FROM issues i JOIN projects p ON p.id = i.project_id
       WHERE p.key = ? AND i.key = ?`,
      [projectKey, issueKey],
    );
    return row ? this.mapIssue(row) : null;
  }

  /** Full summary projection used by lists, boards and search. */
  summary(issueId: number): IssueSummary {
    return this.summarise([this.getById(issueId)])[0] as IssueSummary;
  }

  /**
   * Batch summary projection. Counts come from correlated subqueries so a list
   * of 200 issues is one query, not 800.
   */
  summarise(issues: Issue[]): IssueSummary[] {
    if (issues.length === 0) return [];
    const ids = issues.map((issue) => Number(issue.id));
    // Every id is bound, never interpolated; only the placeholder count varies.
    const idSlots = placeholders(ids.length);

    const assignees = new Map<number, string>();
    for (const row of this.db.all<{ id: number; display_name: string }>(
      `SELECT id, display_name FROM users WHERE id IN (${idSlots})`,
      ids,
    )) {
      assignees.set(Number(row.id), String(row.display_name));
    }

    const labels = new Map<number, number[]>();
    for (const row of this.db.all<{ issue_id: number; label_id: number }>(
      `SELECT issue_id, label_id FROM issue_labels WHERE issue_id IN (${idSlots})`,
      ids,
    )) {
      const list = labels.get(Number(row.issue_id)) ?? [];
      list.push(Number(row.label_id));
      labels.set(Number(row.issue_id), list);
    }

    const counts = new Map<
      number,
      { comments: number; attachments: number; subtasks: number; lastActivityAt: string }
    >();
    for (const row of this.db.all<Record<string, unknown>>(
      `SELECT i.id AS issue_id,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM attachments a WHERE a.issue_id = i.id) AS attachment_count,
              (SELECT COUNT(*) FROM issues s WHERE s.parent_id = i.id) AS subtask_count,
              COALESCE((SELECT MAX(e.created_at) FROM activity_events e WHERE e.issue_id = i.id),
                       i.updated_at) AS last_activity_at
       FROM issues i WHERE i.id IN (${idSlots})`,
      ids,
    )) {
      counts.set(Number(row.issue_id), {
        comments: Number(row.comment_count ?? 0),
        attachments: Number(row.attachment_count ?? 0),
        subtasks: Number(row.subtask_count ?? 0),
        lastActivityAt: String(row.last_activity_at ?? ''),
      });
    }

    const now = Date.now();

    return issues.map((issue) => {
      const count = counts.get(Number(issue.id));
      return {
        id: issue.id,
        key: issue.key,
        title: issue.title,
        type: issue.type,
        priority: issue.priority,
        state: issue.state,
        assigneeId: issue.assigneeId,
        assigneeName: issue.assigneeId ? (assignees.get(Number(issue.assigneeId)) ?? null) : null,
        parentId: issue.parentId,
        dueDate: issue.dueDate,
        position: issue.position,
        labelIds: labels.get(Number(issue.id)) ?? [],
        commentCount: count?.comments ?? 0,
        attachmentCount: count?.attachments ?? 0,
        subtaskCount: count?.subtasks ?? 0,
        isOverdue:
          issue.dueDate !== null && new Date(issue.dueDate).getTime() < now && !issue.archived,
        lastActivityAt: count?.lastActivityAt ?? issue.updatedAt,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Apply a partial update.
   *
   * `parentId` is validated for cycles and cross-project references; `statusId`
   * is routed through the workflow engine so timing columns stay correct.
   */
  update(
    issueId: number,
    input: UpdateIssueInput,
    actorId: number,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Issue {
    const before = this.getById(issueId);
    const projectId = Number(before.projectId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
      throw versionConflict(before.version, input.expectedVersion);
    }

    const updated = this.db.transaction(() => {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      const assign = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        params.push(value as string | number | null);
      };

      if (input.title !== undefined) assign('title', input.title);
      if (input.description !== undefined) assign('description', input.description);
      if (input.type !== undefined) assign('type', input.type);
      if (input.priority !== undefined) assign('priority', input.priority);
      if (input.dueDate !== undefined) assign('due_date', input.dueDate);
      if (input.estimateHours !== undefined) assign('estimate_hours', input.estimateHours);
      if (input.milestoneId !== undefined) assign('milestone_id', input.milestoneId);
      if (input.position !== undefined) assign('position', input.position);

      if (input.timeSpentHours !== undefined) {
        // Time logging is additive, never a blind overwrite of the total.
        assign('time_spent_hours', before.timeSpentHours + input.timeSpentHours);
      }

      if (input.assigneeId !== undefined) {
        assign('assignee_id', input.assigneeId);
      }

      if (input.parentId !== undefined) {
        if (input.parentId !== null) {
          this.assertValidParent(issueId, input.parentId, projectId);
        }
        assign('parent_id', input.parentId);
      }

      if (input.statusId !== undefined && input.statusId !== Number(before.statusId)) {
        const check = this.services.workflow.checkTransition({
          projectId,
          fromStatusId: Number(before.statusId),
          toStatusId: input.statusId,
        });
        if (!check.allowed) {
          throw badRequest(check.reason, { fromStatusId: before.statusId, toStatusId: input.statusId });
        }
        this.services.workflow.applyTransition({ issueId, projectId, toStatusId: input.statusId });
      } else if (input.state !== undefined && input.state !== before.state) {
        const statusId = this.services.workflow.statusIdForState(projectId, input.state);
        const check = this.services.workflow.checkTransition({
          projectId,
          fromStatusId: Number(before.statusId),
          toStatusId: statusId,
        });
        if (!check.allowed) throw badRequest(check.reason);
        this.services.workflow.applyTransition({ issueId, projectId, toStatusId: statusId });
      }

      if (sets.length > 0) {
        sets.push('updated_at = ?', 'version = version + 1');
        params.push(nowIso(), issueId);
        this.db.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, params);
      }

      if (input.labelIds !== undefined) {
        this.setLabels(issueId, input.labelIds);
      }

      return this.getById(issueId);
    });

    const after = updated;
    const changes = this.diffSnapshots(
      this.snapshot(before) as unknown as Record<string, unknown>,
      this.snapshot(after) as unknown as Record<string, unknown>,
      ACTIVITY_DIFF_FIELDS as unknown as string[],
    );

    if (changes.length > 0) {
      const isTransition = changes.some((c) => c.field === 'state' || c.field === 'status_id');
      this.services.activity.recordFieldChange({
        issueId,
        projectId,
        actorId,
        type: isTransition ? 'issue.transitioned' : 'issue.updated',
        fields: AUDITED_FIELDS as unknown as string[],
        labels: FIELD_LABELS,
        before: this.snapshot(before) as unknown as Record<string, unknown>,
        after: this.snapshot(after) as unknown as Record<string, unknown>,
      });

      this.services.audit.record(
        {
          action: isTransition ? 'issue.transitioned' : 'issue.updated',
          entityType: 'issue',
          entityId: issueId,
          projectId,
          actorId,
          before: this.snapshot(before) as unknown as Record<string, unknown>,
          after: this.snapshot(after) as unknown as Record<string, unknown>,
        },
        ctx,
      );
    }

    // Assignment changes deserve their own notification and activity line.
    if (
      input.assigneeId !== undefined &&
      before.assigneeId !== after.assigneeId
    ) {
      if (after.assigneeId) {
        this.db.run(
          'INSERT OR IGNORE INTO watchers (issue_id, user_id) VALUES (?,?)',
          [issueId, Number(after.assigneeId)],
        );
      }
      this.services.activity.record({
        issueId,
        projectId,
        actorId,
        type: after.assigneeId ? 'issue.assigned' : 'issue.unassigned',
        summary: after.assigneeId
          ? 'assigned this issue'
          : 'removed the assignee',
        changes: [
          { field: 'assignee', from: before.assigneeId, to: after.assigneeId },
        ],
      });

      if (after.assigneeId && Number(after.assigneeId) !== actorId) {
        this.services.notifications.notify(
          {
            event: 'issue.assigned',
            title: `You were assigned ${after.key}`,
            body: after.title,
            issueId,
            projectId,
            excludeUserIds: [actorId],
          },
          { excludeUserIds: [actorId] },
        );
      }
    }

    if (input.timeSpentHours !== undefined) {
      this.services.activity.record({
        issueId,
        projectId,
        actorId,
        type: 'issue.time_logged',
        summary: `logged ${input.timeSpentHours}h`,
        changes: [
          {
            field: 'time_spent_hours',
            from: before.timeSpentHours,
            to: after.timeSpentHours,
          },
        ],
      });
    }

    this.publishIssue('issue.updated', after, actorId);
    this.refreshSla(issueId, actorId);
    return after;
  }

  /** Move an issue to a status, validating against the workflow. */
  transition(
    issueId: number,
    request: TransitionRequest,
    actorId: number,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Issue {
    const before = this.getById(issueId);
    const projectId = Number(before.projectId);

    if (request.expectedVersion !== undefined && request.expectedVersion !== before.version) {
      throw versionConflict(before.version, request.expectedVersion);
    }

    const check = this.services.workflow.checkTransition({
      projectId,
      fromStatusId: Number(before.statusId),
      toStatusId: request.toStatusId,
    });

    if (!check.allowed) {
      throw workflowViolation(check.reason, {
        from: before.statusId,
        to: request.toStatusId,
      });
    }

    if (check.transition?.requiredPermission) {
      throw forbidden(
        `This transition requires the "${check.transition.requiredPermission}" permission`,
      );
    }

    const after = this.db.transaction(() => {
      this.services.workflow.applyTransition({
        issueId,
        projectId,
        toStatusId: request.toStatusId,
      });
      return this.getById(issueId);
    });

    const fromName = this.statusName(projectId, Number(before.statusId));
    const toName = this.statusName(projectId, Number(after.statusId));

    this.services.activity.record({
      issueId,
      projectId,
      actorId,
      type: 'issue.transitioned',
      summary: `moved from ${fromName} to ${toName}`,
      changes: [
        { field: 'status', from: fromName, to: toName },
        { field: 'state', from: before.state, to: after.state },
      ],
    });

    this.services.audit.record(
      {
        action: 'issue.transitioned',
        entityType: 'issue',
        entityId: issueId,
        projectId,
        actorId,
        before: { state: before.state, statusId: before.statusId },
        after: { state: after.state, statusId: after.statusId },
      },
      ctx,
    );

    // An optional comment attached to the transition is a normal comment.
    if (request.comment && request.comment.trim().length > 0) {
      this.services.comments.create(
        issueId,
        { body: request.comment },
        actorId,
        { isSystemGenerated: false },
      );
    }

    this.services.notifications.notify(
      {
        event: 'issue.status_changed',
        title: `${after.key} moved to ${toName}`,
        body: after.title,
        issueId,
        projectId,
        excludeUserIds: [actorId],
      },
      { excludeUserIds: [actorId] },
    );

    this.publishIssue('issue.moved', after, actorId);
    this.publishBoard(projectId);
    this.refreshSla(issueId, actorId);

    return after;
  }

  /** Transitions currently available for an issue, with the reason if blocked. */
  availableTransitions(issueId: number): AvailableTransition[] {
    const issue = this.getById(issueId);
    const projectId = Number(issue.projectId);
    const statuses = this.services.workflow.statusesForProject(projectId);

    return statuses
      .filter((status) => status.id !== Number(issue.statusId))
      .map((status) => {
        const probe: TransitionCheck = this.services.workflow.checkTransition({
          projectId,
          fromStatusId: Number(issue.statusId),
          toStatusId: status.id,
        });
        return {
          statusId: status.id,
          key: status.key,
          name: status.name,
          color: status.color,
          allowed: probe.allowed,
          reason: probe.reason,
          transitionId: probe.transition?.id ?? null,
          requiredPermission: probe.transition?.requiredPermission ?? null,
          isResolution: status.isResolution,
          isClosed: status.isClosed,
        };
      });
  }

  // -------------------------------------------------------------------------
  // Hierarchy
  // -------------------------------------------------------------------------

  /**
   * Validate a proposed parent. Rejects self-parenting, cross-project parents
   * and any parent whose ancestor chain already contains this issue, which is
   * what stops a nesting cycle.
   */
  private assertValidParent(issueId: number, parentId: number, projectId: number): void {
    if (issueId === parentId) throw cycleDetected('An issue cannot be its own parent');

    const parent: { id: number; project_id: number } | undefined = this.db.get(
      'SELECT id, project_id FROM issues WHERE id = ?',
      [parentId],
    );
    if (!parent) throw notFound('Parent issue', parentId);
    if (Number(parent.project_id) !== projectId) {
      throw badRequest('A parent issue must belong to the same project');
    }

    // Walk up from the proposed parent; if we meet the issue itself, the change
    // would create a loop.
    const seen = new Set<number>([issueId]);
    let cursor: number | null = parentId;
    let depth = 0;

    while (cursor !== null && depth < 200) {
      depth += 1;
      const row: { parent_id: number | null } | undefined = this.db.get(
        'SELECT parent_id FROM issues WHERE id = ?',
        [cursor],
      );
      if (!row || row.parent_id === null) break;

      cursor = Number(row.parent_id);
      if (seen.has(cursor)) {
        throw cycleDetected('This change would make the issue its own ancestor');
      }
      seen.add(cursor);

      // A 200-level chain is already pathological; stop rather than loop.
      if (depth >= 200) throw cycleDetected('The issue hierarchy is too deep to modify safely');
    }
  }

  /** Direct children, as summaries. */
  children(issueId: number): IssueSummary[] {
    const rows = this.db.all<Record<string, unknown>>('SELECT * FROM issues WHERE parent_id = ? ORDER BY position ASC, id ASC', [
      issueId,
    ]);
    return this.summarise(rows.map((row) => this.mapIssue(row)));
  }

  /** Ancestor chain from the root down to the direct parent. */
  ancestors(issueId: number): Issue[] {
    const chain: Issue[] = [];
    let cursor: number | null = issueId;
    let depth = 0;

    while (cursor !== null && depth < 200) {
      depth += 1;
      const row: { parent_id: number | null } | undefined = this.db.get(
        'SELECT parent_id FROM issues WHERE id = ?',
        [cursor],
      );
      if (!row || row.parent_id === null) break;
      cursor = Number(row.parent_id);
      chain.push(this.getById(cursor));
    }

    return chain.reverse();
  }

  /** Every descendant id, breadth-first. */
  descendantIds(issueId: number): number[] {
    const found: number[] = [];
    let frontier = [issueId];
    let depth = 0;

    while (frontier.length > 0 && depth < 20) {
      depth += 1;
      const next: number[] = [];
      for (const parentId of frontier) {
        for (const row of this.db.all<{ id: number }>('SELECT id FROM issues WHERE parent_id = ?', [parentId])) {
          const id = Number(row.id);
          if (!found.includes(id)) {
            found.push(id);
            next.push(id);
          }
        }
      }
      frontier = next;
      if (found.length > 2000) break;
    }

    return found;
  }

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  /**
   * Link two issues. The pair is stored once, in the given direction; the
   * reverse edge is derived at read time so a relation can never be duplicated.
   */
  link(
    issueId: number,
    targetIssueId: number,
    kind: DependencyKind,
    actorId: number,
    ctx: { ipAddress?: string; userAgent?: string } = {},
    options: { autoDetected?: boolean; confidence?: number } = {},
  ): IssueLink {
    if (issueId === targetIssueId) throw badRequest('An issue cannot depend on itself');

    const source = this.getById(issueId);
    const target = this.getById(targetIssueId);

    if (Number(source.projectId) !== Number(target.projectId)) {
      throw badRequest('Issues can only be linked within the same project');
    }

    // A blocking link would deadlock the graph if it closed a loop.
    if (isBlocking(kind)) {
      this.assertNoDependencyCycle(issueId, targetIssueId);
    }

    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM issue_links WHERE source_issue_id = ? AND target_issue_id = ? AND kind = ?',
      [issueId, targetIssueId, kind],
    );
    if (existing) throw conflict('These issues are already linked', { linkId: existing.id });

    const id = Number(
      this.db.run(
        `INSERT INTO issue_links
           (source_issue_id, target_issue_id, kind, auto_detected, confidence, created_by)
         VALUES (?,?,?,?,?,?)`,
        [
          issueId,
          targetIssueId,
          kind,
          options.autoDetected ? 1 : 0,
          options.confidence ?? null,
          actorId,
        ],
      ).lastInsertRowid,
    );

    this.services.activity.record({
      issueId,
      projectId: Number(source.projectId),
      actorId,
      type: 'issue.linked',
      summary: `linked this issue to ${target.key}`,
      metadata: { kind, targetIssueId, targetKey: target.key, autoDetected: options.autoDetected ?? false },
    });

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue_link',
        entityId: id,
        projectId: Number(source.projectId),
        actorId,
        after: { sourceIssueId: issueId, targetIssueId, kind, autoDetected: options.autoDetected ?? false },
      },
      ctx,
    );

    this.publishIssue('issue.updated', source, actorId);
    this.publishBoard(Number(source.projectId));

    return this.getLink(id);
  }

  /**
   * Blocking links form a directed graph. Adding `fromId → toId` is only safe
   * when no path already leads from `toId` back to `fromId`, so this walks
   * *forward* along existing blocking edges looking for `fromId`.
   */
  private assertNoDependencyCycle(fromId: number, toId: number): void {
    const stack = [toId];
    const seen = new Set<number>();
    let depth = 0;

    while (stack.length > 0 && depth < 10_000) {
      depth += 1;
      const current = stack.pop() as number;
      if (current === fromId) {
        throw cycleDetected('This link would create a circular dependency');
      }
      if (seen.has(current)) continue;
      seen.add(current);

      // Follow the edge direction: things that `current` blocks.
      for (const row of this.db.all<{ target_issue_id: number }>(
        `SELECT target_issue_id FROM issue_links
         WHERE source_issue_id = ? AND kind IN ('blocks','is_blocked_by')`,
        [current],
      )) {
        stack.push(Number(row.target_issue_id));
      }
    }
  }

  unlink(issueId: number, linkId: number, actorId: number, ctx: { ipAddress?: string; userAgent?: string } = {}): void {
    const link = this.db.get<{ id: number; source_issue_id: number; target_issue_id: number; kind: string }>(
      'SELECT * FROM issue_links WHERE id = ?',
      [linkId],
    );
    if (!link) throw notFound('Issue link', linkId);
    if (Number(link.source_issue_id) !== issueId) {
      throw badRequest('That link does not belong to this issue');
    }

    const issue = this.getById(issueId);
    this.db.run('DELETE FROM issue_links WHERE id = ?', [linkId]);

    this.services.activity.record({
      issueId,
      projectId: Number(issue.projectId),
      actorId,
      type: 'issue.unlinked',
      summary: `removed a ${link.kind} link`,
      metadata: { linkId, kind: link.kind },
    });

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue_link',
        entityId: linkId,
        projectId: Number(issue.projectId),
        actorId,
        before: {
          sourceIssueId: link.source_issue_id,
          targetIssueId: link.target_issue_id,
          kind: link.kind,
        },
      },
      ctx,
    );

    this.publishBoard(Number(issue.projectId));
  }

  /** All links touching an issue, in both directions, with resolved keys. */
  links(issueId: number): Array<IssueLink & { otherKey: string; otherTitle: string; direction: 'outgoing' | 'incoming' }> {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT l.*,
              o.key AS other_key, o.title AS other_title
       FROM issue_links l
       JOIN issues o
         ON o.id = CASE WHEN l.source_issue_id = ? THEN l.target_issue_id ELSE l.source_issue_id END
       WHERE l.source_issue_id = ? OR l.target_issue_id = ?
       ORDER BY l.id ASC`,
      [issueId, issueId, issueId],
    );

    return rows.map((row) => ({
      ...this.mapLink(row),
      otherKey: String(row.other_key ?? ''),
      otherTitle: String(row.other_title ?? ''),
      direction: Number(row.source_issue_id) === issueId ? 'outgoing' : 'incoming',
    }));
  }

  getLink(linkId: number): IssueLink {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM issue_links WHERE id = ?', [linkId]);
    if (!row) throw notFound('Issue link', linkId);
    return this.mapLink(row);
  }

  // -------------------------------------------------------------------------
  // Watchers, archive, delete
  // -------------------------------------------------------------------------

  watch(issueId: number, userId: number, ctx: { ipAddress?: string; userAgent?: string } = {}): void {
    this.getById(issueId);
    this.db.run('INSERT OR IGNORE INTO watchers (issue_id, user_id) VALUES (?,?)', [issueId, userId]);
    this.services.audit.record(
      { action: 'issue.updated', entityType: 'watcher', entityId: `${issueId}:${userId}`, after: { watching: true } },
      ctx,
    );
  }

  unwatch(issueId: number, userId: number, ctx: { ipAddress?: string; userAgent?: string } = {}): void {
    this.db.run('DELETE FROM watchers WHERE issue_id = ? AND user_id = ?', [issueId, userId]);
    this.services.audit.record(
      { action: 'issue.updated', entityType: 'watcher', entityId: `${issueId}:${userId}`, before: { watching: true } },
      ctx,
    );
  }

  isWatching(issueId: number, userId: number): boolean {
    const row = this.db.get<{ issue_id: number }>(
      'SELECT issue_id FROM watchers WHERE issue_id = ? AND user_id = ?',
      [issueId, userId],
    );
    return row !== undefined;
  }

  setArchived(issueId: number, archived: boolean, actorId: number, ctx: { ipAddress?: string; userAgent?: string } = {}): Issue {
    const before = this.getById(issueId);
    const at = nowIso();
    this.db.run('UPDATE issues SET archived = ?, archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?', [
      archived ? 1 : 0,
      archived ? at : null,
      at,
      issueId,
    ]);
    const after = this.getById(issueId);

    this.services.activity.record({
      issueId,
      projectId: Number(after.projectId),
      actorId,
      type: archived ? 'issue.archived' : 'issue.unarchived',
      summary: archived ? 'archived this issue' : 'restored this issue from the archive',
    });

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue',
        entityId: issueId,
        projectId: Number(after.projectId),
        actorId,
        before: { archived: before.archived },
        after: { archived: after.archived },
      },
      ctx,
    );

    this.publishIssue(archived ? 'issue.archived' : 'issue.updated', after, actorId);
    this.publishBoard(Number(after.projectId));
    return after;
  }

  /**
   * Delete an issue. Comments, links and attachments cascade. The audit entry
   * survives the deletion, which is the point of an audit trail.
   */
  remove(issueId: number, actorId: number, ctx: { ipAddress?: string; userAgent?: string } = {}): void {
    const issue = this.getById(issueId);
    const childCount = Number(
      this.db.scalar<number>('SELECT COUNT(*) AS c FROM issues WHERE parent_id = ?', [issueId]) ?? 0,
    );
    if (childCount > 0) {
      throw conflict(
        `Cannot delete ${issue.key}: it still has ${childCount} sub-task(s). Delete or move them first.`,
        { childCount },
      );
    }

    this.db.run('DELETE FROM issues WHERE id = ?', [issueId]);

    this.services.audit.record(
      {
        action: 'issue.deleted',
        entityType: 'issue',
        entityId: issueId,
        projectId: Number(issue.projectId),
        actorId,
        before: this.snapshot(issue) as unknown as Record<string, unknown>,
      },
      ctx,
    );

    this.services.realtime.publish({
      event: 'issue.deleted',
      projectId: Number(issue.projectId),
      issueId,
      data: { key: issue.key },
    });
    this.publishBoard(Number(issue.projectId));
  }

  // -------------------------------------------------------------------------
  // Board
  // -------------------------------------------------------------------------

  /**
   * Kanban projection: every non-archived issue in one column per status, in
   * board order. A single query plus in-memory grouping keeps it cheap.
   */
  board(projectId: number, options: { includeArchived?: boolean } = {}): Board {
    const statuses = this.services.workflow.statusesForProject(projectId);

    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM issues
       WHERE project_id = ? AND (archived = 0 ${options.includeArchived ? 'OR archived = 1' : ''})
       ORDER BY position ASC, id ASC`,
      [projectId],
    );

    const issues = rows.map((row) => this.mapIssue(row));
    const summaries = this.summarise(issues);

    const byStatus = new Map<number, IssueSummary[]>();
    for (const status of statuses) byStatus.set(status.id, []);
    for (const summary of summaries) {
      const issue = issues.find((candidate) => Number(candidate.id) === Number(summary.id));
      const statusId = issue ? Number(issue.statusId) : 0;
      const bucket = byStatus.get(statusId);
      if (bucket) bucket.push(summary);
    }

    return {
      projectId: projectId as Board['projectId'],
      workflowId: statuses[0]?.workflowId ?? 0,
      columns: statuses.map((status) => ({
        statusId: status.id,
        key: status.key,
        name: status.name,
        color: status.color,
        wipLimit: status.wipLimit,
        issues: byStatus.get(status.id) ?? [],
      })),
    };
  }

  /**
   * Move a card to a column at a fractional position between two neighbours.
   * Positions are floats so an insert never has to renumber the column.
   */
  moveOnBoard(input: {
    issueId: number;
    toStatusId: number;
    /** Id of the card the moved card was dropped before, or null for last. */
    beforeIssueId: number | null;
    afterIssueId: number | null;
    actorId: number;
  }): Board {
    const issue = this.getById(input.issueId);
    const projectId = Number(issue.projectId);
    const statusId = input.toStatusId;

    if (Number(issue.statusId) !== statusId) {
      const check = this.services.workflow.checkTransition({
        projectId,
        fromStatusId: Number(issue.statusId),
        toStatusId: statusId,
      });
      if (!check.allowed) {
        throw badRequest(check.reason, { toStatusId: statusId });
      }
    }

    const position = this.positionBetween(projectId, statusId, input.beforeIssueId, input.afterIssueId);

    this.db.transaction(() => {
      if (Number(issue.statusId) !== statusId) {
        this.services.workflow.applyTransition({ issueId: input.issueId, projectId, toStatusId: statusId });
      }
      this.db.run('UPDATE issues SET position = ?, updated_at = ?, version = version + 1 WHERE id = ?', [
        position,
        nowIso(),
        input.issueId,
      ]);
    });

    const after = this.getById(input.issueId);

    if (Number(issue.statusId) !== statusId) {
      this.services.activity.record({
        issueId: input.issueId,
        projectId,
        actorId: input.actorId,
        type: 'issue.moved' as ActivityType,
        summary: `moved to ${this.statusName(projectId, statusId)}`,
        changes: [{ field: 'status', from: Number(issue.statusId), to: statusId }],
      });

      this.services.audit.record(
        {
          action: 'issue.transitioned',
          entityType: 'issue',
          entityId: input.issueId,
          projectId,
          actorId: input.actorId,
          before: { statusId: issue.statusId, state: issue.state, position: issue.position },
          after: { statusId, state: after.state, position },
        },
        {},
      );

      this.services.notifications.notify(
        {
          event: 'issue.status_changed',
          title: `${after.key} moved to ${this.statusName(projectId, statusId)}`,
          body: after.title,
          issueId: input.issueId,
          projectId,
          excludeUserIds: [input.actorId],
        },
        { excludeUserIds: [input.actorId] },
      );
    } else {
      // Same column: a pure reorder, which is not worth an audit entry.
      this.db.run('UPDATE issues SET updated_at = ? WHERE id = ?', [nowIso(), input.issueId]);
    }

    this.publishIssue('issue.moved', after, input.actorId);
    this.refreshSla(input.issueId, input.actorId);
    return this.board(projectId);
  }

  private nextPositionInStatus(projectId: number, statusId: number): number {
    const max = this.db.scalar<number>(
      'SELECT MAX(position) AS m FROM issues WHERE project_id = ? AND status_id = ?',
      [projectId, statusId],
    );
    return (max ?? 0) + 1024;
  }

  /** Fractional position between the two neighbouring cards. */
  private positionBetween(
    projectId: number,
    statusId: number,
    beforeIssueId: number | null,
    afterIssueId: number | null,
  ): number {
    const before = beforeIssueId
      ? this.db.scalar<number>('SELECT position FROM issues WHERE id = ?', [beforeIssueId])
      : null;
    const after = afterIssueId
      ? this.db.scalar<number>('SELECT position FROM issues WHERE id = ?', [afterIssueId])
      : null;

    if (before !== null && before !== undefined && after !== null && after !== undefined) {
      // Exact collision would make the two rows unsortable; nudge apart.
      if (before === after) return before + 0.5;
      return (before + after) / 2;
    }
    if (before !== null && before !== undefined) return before + 1;
    if (after !== null && after !== undefined) return after - 1;

    const min = this.db.scalar<number>(
      'SELECT MIN(position) AS m FROM issues WHERE project_id = ? AND status_id = ?',
      [projectId, statusId],
    );
    return (min ?? 1024) - 1;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private setLabels(issueId: number, labelIds: number[]): void {
    this.db.run('DELETE FROM issue_labels WHERE issue_id = ?', [issueId]);
    for (const labelId of new Set(labelIds)) {
      this.db.run('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?,?)', [issueId, labelId]);
    }
  }

  private setWatcher(issueId: number, userId: number): void {
    this.db.run('INSERT OR IGNORE INTO watchers (issue_id, user_id) VALUES (?,?)', [issueId, userId]);
  }

  private stateForStatus(projectId: number, statusId: number): IssueState {
    const row = this.db.get<{ state: string }>('SELECT state FROM workflow_statuses WHERE id = ? AND project_id = ?', [
      statusId,
      projectId,
    ]);
    return (row?.state ?? 'open') as IssueState;
  }

  private statusName(projectId: number, statusId: number): string {
    const row = this.db.get<{ name: string }>('SELECT name FROM workflow_statuses WHERE id = ? AND project_id = ?', [
      statusId,
      projectId,
    ]);
    return row?.name ?? 'Unknown';
  }

  /** Snapshot used for audit diffs; JSON-safe and free of large blobs. */
  private snapshot(issue: Issue): Record<string, unknown> {
    return {
      key: issue.key,
      title: issue.title,
      type: issue.type,
      priority: issue.priority,
      state: issue.state,
      statusId: issue.statusId,
      assigneeId: issue.assigneeId,
      parentId: issue.parentId,
      dueDate: issue.dueDate,
      estimateHours: issue.estimateHours,
      timeSpentHours: issue.timeSpentHours,
      milestoneId: issue.milestoneId,
      archived: issue.archived,
      version: issue.version,
    };
  }

  private diffSnapshots(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields: string[],
  ): Array<{ field: string; from: unknown; to: unknown }> {
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    for (const field of fields) {
      if (before[field] === after[field]) continue;
      changes.push({ field, from: before[field] ?? null, to: after[field] ?? null });
    }
    return changes;
  }

  /**
   * Re-evaluate SLA clocks after a change. Advisory only — a missing SLA
   * service must never break an issue update.
   */
  private refreshSla(issueId: number, actorId: number | null): void {
    try {
      this.services.sla.ensureClocksForIssue(issueId, { actorId });
    } catch {
      // SLA configuration problems are surfaced by the SLA endpoints instead.
    }
  }

  private publishIssue(event: ServerEvent, issue: Issue, actorId: number): void {
    this.services.realtime.publish({
      event,
      projectId: Number(issue.projectId),
      issueId: issue.id,
      userIds: [],
      data: {
        issue: this.summary(issue.id),
        actorId,
        at: nowIso(),
      },
    });
  }

  private publishBoard(projectId: number): void {
    const board = this.board(projectId);
    this.services.realtime.publish({
      event: 'board.updated',
      projectId,
      data: {
        projectId,
        workflowId: board.workflowId,
        columns: board.columns,
        removedIssueIds: [],
      },
    });
  }

  private mapIssue(row: Record<string, unknown>): Issue {
    return {
      id: Number(row.id) as Issue['id'],
      key: String(row.key),
      projectId: Number(row.project_id) as Issue['projectId'],
      sequence: Number(row.sequence ?? 0),
      title: String(row.title),
      description: String(row.description ?? ''),
      type: String(row.type ?? 'task') as IssueType,
      priority: String(row.priority ?? 'medium') as IssuePriority,
      state: String(row.state ?? 'open') as IssueState,
      statusId: Number(row.status_id),
      assigneeId: row.assignee_id === null ? null : (Number(row.assignee_id) as Issue['assigneeId']),
      reporterId: row.reporter_id === null ? null : (Number(row.reporter_id) as Issue['reporterId']),
      parentId: row.parent_id === null ? null : (Number(row.parent_id) as Issue['parentId']),
      dueDate: row.due_date === null ? null : String(row.due_date),
      startedAt: row.started_at === null ? null : String(row.started_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      estimateHours: row.estimate_hours === null ? null : Number(row.estimate_hours),
      timeSpentHours: Number(row.time_spent_hours ?? 0),
      position: Number(row.position ?? 0),
      milestoneId: row.milestone_id === null ? null : (Number(row.milestone_id) as Issue['milestoneId']),
      archived: Number(row.archived) === 1,
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      version: Number(row.version ?? 1),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private mapLink(row: Record<string, unknown>): IssueLink {
    return {
      id: Number(row.id),
      sourceIssueId: Number(row.source_issue_id) as IssueLink['sourceIssueId'],
      targetIssueId: Number(row.target_issue_id) as IssueLink['targetIssueId'],
      kind: String(row.kind) as DependencyKind,
      autoDetected: Number(row.auto_detected) === 1,
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdBy: row.created_by === null ? null : (Number(row.created_by) as IssueLink['createdBy']),
      createdAt: String(row.created_at ?? ''),
    };
  }
}
