/**
 * Workflow engine.
 *
 * A project owns exactly one workflow: an ordered set of statuses plus the
 * transitions permitted between them. This service owns the rules:
 *
 *   * a project's first workflow is seeded from `DEFAULT_STATUSES`
 *   * a transition is legal only when a matching edge exists (a `null` source
 *     acts as a wildcard), and a WIP limit is not exceeded
 *   * entering a status flagged `is_resolution` stamps `resolved_at`; entering
 *     one flagged `is_closed` stamps `closed_at`
 *   * removing a status is refused while issues still reference it, so history
 *     can never dangle
 */

import {
  DEFAULT_STATUSES,
  type CreateStatusInput,
  type CreateTransitionInput,
  type StatusCategory,
  type TransitionCheck,
  type UpdateIssueInput,
  type Workflow,
  type WorkflowStatus,
  type WorkflowTransition,
  isDefaultStatusKey,
} from '@tracker/shared';
import { forbidden, notFound, workflowViolation } from '../errors.ts';
import type { Database, SqlParam } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';
import type { Services } from './context.ts';

export interface WorkflowChangeSet {
  statuses?: CreateStatusInput[];
  transitions?: CreateTransitionInput[];
  removedStatusIds?: number[];
  removedTransitionIds?: number[];
  updatedStatuses?: Array<{ id: number; patch: Partial<CreateStatusInput> }>;
}

export class WorkflowService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }
  private get db(): Database {
    return this.services.db;
  }

  /**
   * Create the default workflow, statuses and transitions for a new project.
   * Called by `ProjectService` inside the project-creation transaction.
   */
  provisionDefaultWorkflow(projectId: number): number {
    const workflowId = Number(
      this.db.run(
        `INSERT INTO workflows (project_id, name, description, is_default)
         VALUES (?, 'Default', 'Open → In Progress → Closed', 1)`,
        [projectId],
      ).lastInsertRowid,
    );

    const statusIds = new Map<string, number>();
    for (const status of DEFAULT_STATUSES) {
      const id = Number(
        this.db.run(
          `INSERT INTO workflow_statuses
             (workflow_id, project_id, key, name, state, category, color, description,
              position, is_resolution, is_closed, is_done, wip_limit)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            workflowId,
            projectId,
            status.key,
            status.name,
            status.state,
            status.category,
            status.color,
            status.description,
            status.position,
            status.isResolution ? 1 : 0,
            status.isClosed ? 1 : 0,
            status.isDone ? 1 : 0,
            status.wipLimit,
          ],
        ).lastInsertRowid,
      );
      statusIds.set(status.key, id);
    }

    // Forward path through the happy route, plus the shortcuts a real team needs.
    const edges: Array<[string | null, string, string, string]> = [
      ['backlog', 'open', 'Triage', 'Accept the issue into the sprint'],
      ['open', 'in_progress', 'Start work', 'Begin implementation'],
      ['in_progress', 'blocked', 'Block', 'Waiting on something else'],
      ['blocked', 'in_progress', 'Unblock', 'The dependency resolved'],
      ['in_progress', 'in_review', 'Submit for review', 'Hand off for verification'],
      ['in_review', 'in_progress', 'Changes requested', 'Send back for rework'],
      ['in_review', 'resolved', 'Verify', 'The change was confirmed correct'],
      ['resolved', 'closed', 'Close', 'Nothing further to do'],
      [null, 'open', 'Reopen', 'Return the issue to the queue'],
      [null, 'in_progress', 'Start', 'Jump straight into work'],
      [null, 'blocked', 'Block', 'Mark as waiting'],
      [null, 'wont_fix', "Won't fix", 'Close without making a change'],
    ];

    for (const [from, to, name, description] of edges) {
      const toId = statusIds.get(to);
      if (toId === undefined) continue;
      const fromId = from === null ? null : (statusIds.get(from) ?? null);
      this.db.run(
        `INSERT INTO workflow_transitions
           (workflow_id, from_status_id, to_status_id, name, description, required_permission)
         VALUES (?,?,?,?,?,NULL)`,
        [workflowId, fromId, toId, name, description],
      );
    }

    return workflowId;
  }

  /** Full workflow for a project, or `notFound` when it has none. */
  getForProject(projectId: number): Workflow {
    const workflow = this.db.get<Record<string, unknown>>(
      'SELECT * FROM workflows WHERE project_id = ?',
      [projectId],
    );
    if (!workflow) throw notFound('Workflow', projectId);

    const workflowId = Number(workflow.id);
    const statuses = this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM workflow_statuses WHERE workflow_id = ? ORDER BY position ASC, id ASC',
        [workflowId],
      )
      .map((row) => this.mapStatus(row));

    const transitions = this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM workflow_transitions WHERE workflow_id = ? ORDER BY id ASC',
        [workflowId],
      )
      .map((row) => this.mapTransition(row));

    return {
      id: workflowId,
      projectId: projectId as Workflow['projectId'],
      name: String(workflow.name ?? 'Default'),
      description: String(workflow.description ?? ''),
      isDefault: Number(workflow.is_default) === 1,
      statuses,
      transitions,
      createdAt: String(workflow.created_at ?? ''),
      updatedAt: String(workflow.updated_at ?? ''),
    };
  }

  /** All statuses for a project, ordered for board rendering. */
  statusesForProject(projectId: number): WorkflowStatus[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM workflow_statuses WHERE project_id = ? ORDER BY position ASC, id ASC',
        [projectId],
      )
      .map((row) => this.mapStatus(row));
  }

  /**
   * Whether the project still uses the shipped default status set. The settings
   * UI uses this to decide whether to warn before customising.
   */
  isUsingDefaultStatuses(projectId: number): boolean {
    const statuses = this.statusesForProject(projectId);
    if (statuses.length !== DEFAULT_STATUSES.length) return false;
    return statuses.every((status) => isDefaultStatusKey(status.key));
  }

  /**
   * Decide whether an issue may move to `toStatusId`.
   *
   * Returns a structured result rather than throwing so the UI can disable
   * buttons and still show the reason.
   */
  checkTransition(input: {
    projectId: number;
    fromStatusId: number;
    toStatusId: number;
  }): TransitionCheck {
    const statuses = this.statusesForProject(input.projectId);
    const byId = new Map(statuses.map((status) => [status.id, status]));

    const from = byId.get(input.fromStatusId);
    const to = byId.get(input.toStatusId);
    if (!to) {
      return {
        allowed: false,
        reason: `Status ${input.toStatusId} does not belong to this project's workflow`,
        transition: null,
        available: [],
      };
    }

    const transitions = this.db.all<Record<string, unknown>>(
      'SELECT * FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE project_id = ?) ORDER BY id ASC',
      [input.projectId],
    );
    const mapped = transitions.map((row) => this.mapTransition(row));

    // A specific edge wins over a wildcard edge, so `in_progress → in_review`
    // is preferred over the generic `* → in_review`.
    const exact = mapped.find(
      (t) => t.fromStatusId === input.fromStatusId && t.toStatusId === input.toStatusId,
    );
    const wildcard = mapped.find(
      (t) => t.fromStatusId === null && t.toStatusId === input.toStatusId,
    );
    const chosen = exact ?? wildcard;

    if (!chosen) {
      return {
        allowed: false,
        reason: from
          ? `"${from.name}" cannot move directly to "${to.name}"`
          : `No transition to "${to.name}" is available`,
        transition: null,
        available: mapped
          .filter((t) => t.fromStatusId === input.fromStatusId || t.fromStatusId === null)
          .map((t) => t),
      };
    }

    if (to.wipLimit !== null) {
      const occupancy = this.countInStatus(input.projectId, to.id);
      const current = from && from.id === to.id;
      // Moving within the same status does not consume another slot.
      if (!current && occupancy >= to.wipLimit) {
        return {
          allowed: false,
          reason: `"${to.name}" is at its WIP limit (${occupancy}/${to.wipLimit})`,
          transition: chosen,
          available: mapped.filter(
            (t) => t.fromStatusId === input.fromStatusId || t.fromStatusId === null,
          ),
        };
      }
    }

    return {
      allowed: true,
      reason: 'transition permitted',
      transition: chosen,
      available: mapped.filter(
        (t) => t.fromStatusId === input.fromStatusId || t.fromStatusId === null,
      ),
    };
  }

  /** Live occupancy of a status, used for WIP badges. */
  countInStatus(projectId: number, statusId: number): number {
    return Number(
      this.db.scalar<number>(
        'SELECT COUNT(*) AS c FROM issues WHERE project_id = ? AND status_id = ? AND archived = 0',
        [projectId, statusId],
      ) ?? 0,
    );
  }

  /** Status id for a state key, falling back to the first status. */
  statusIdForState(projectId: number, state: string): number {
    const row = this.db.get<{ id: number }>(
      'SELECT id FROM workflow_statuses WHERE project_id = ? AND state = ? ORDER BY position ASC LIMIT 1',
      [projectId, state],
    );
    if (row) return Number(row.id);

    const fallback = this.db.get<{ id: number }>(
      'SELECT id FROM workflow_statuses WHERE project_id = ? ORDER BY position ASC LIMIT 1',
      [projectId],
    );
    if (!fallback) throw notFound('Workflow status', state);
    return Number(fallback.id);
  }

  /** The status new issues should start in. */
  initialStatusId(projectId: number): number {
    const row = this.db.get<{ id: number }>(
      `SELECT id FROM workflow_statuses
       WHERE project_id = ? AND category = 'unstarted'
       ORDER BY position ASC LIMIT 1`,
      [projectId],
    );
    if (row) return Number(row.id);
    return this.statusIdForState(projectId, 'open');
  }

  /**
   * Apply a transition to an issue row, maintaining the timing columns and
   * bumping the version. Callers must already have validated the transition.
   *
   * Returns the `Set` of issue columns that changed, so the caller can build a
   * precise activity summary and audit diff.
   */
  applyTransition(input: {
    issueId: number;
    projectId: number;
    toStatusId: number;
    at?: string;
  }): Set<string> {
    const to = this.db.get<Record<string, unknown>>(
      'SELECT * FROM workflow_statuses WHERE id = ? AND project_id = ?',
      [input.toStatusId, input.projectId],
    );
    if (!to) throw notFound('Workflow status', input.toStatusId);

    const at = input.at ?? nowIso();
    const changed = new Set<string>();
    const sets: string[] = ['status_id = ?', 'state = ?', 'updated_at = ?', 'version = version + 1'];
    const params: Array<string | number> = [input.toStatusId, String(to.state), at];

    // `started_at` is stamped on the first entry into a `started` category, so
    // time-in-progress is measured from real work rather than creation.
    if (String(to.category) === 'started') {
      const current = this.db.get<{ started_at: string | null }>(
        'SELECT started_at FROM issues WHERE id = ?',
        [input.issueId],
      );
      if (current && !current.started_at) {
        sets.push('started_at = ?');
        params.push(at);
        changed.add('startedAt');
      }
    }

    if (Number(to.is_resolution) === 1) {
      sets.push('resolved_at = ?');
      params.push(at);
      changed.add('resolvedAt');
    }

    if (Number(to.is_closed) === 1) {
      sets.push('closed_at = ?');
      params.push(at);
      changed.add('closedAt');
    }

    this.db.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, [...params, input.issueId]);
    changed.add('statusId');
    changed.add('state');
    return changed;
  }

  /**
   * Apply a whole workflow change set atomically. Removing a status that still
   * holds issues is refused rather than silently reassigning them.
   */
  update(projectId: number, changeSet: WorkflowChangeSet, ctx: { actorId: number | null }): Workflow {
    const before = this.getForProject(projectId);
    const workflowId = before.id;

    this.db.transaction(() => {
      // Reorder positions first so added statuses slot into the right place.
      for (const status of changeSet.statuses ?? []) {
        this.db.run(
          `INSERT INTO workflow_statuses
             (workflow_id, project_id, key, name, state, category, color, description,
              position, is_resolution, is_closed, is_done, wip_limit)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            workflowId,
            projectId,
            status.key,
            status.name,
            status.state,
            // The column is NOT NULL, so an omitted category is derived from
            // the state rather than stored as null.
            status.category ?? this.categoryForState(status.state),
            status.color,
            status.description,
            status.position,
            status.isResolution ? 1 : 0,
            status.isClosed ? 1 : 0,
            status.isDone ? 1 : 0,
            status.wipLimit,
          ],
        );
      }

      for (const update of changeSet.updatedStatuses ?? []) {
        const patch = update.patch;
        const sets: string[] = [];
        const params: SqlParam[] = [];

        const assign = (column: string, value: string | number | null): void => {
          sets.push(`${column} = ?`);
          params.push(value);
        };

        if (patch.name !== undefined) assign('name', patch.name);
        if (patch.state !== undefined) assign('state', patch.state);
        if (patch.category !== undefined) assign('category', patch.category);
        if (patch.color !== undefined) assign('color', patch.color);
        if (patch.description !== undefined) assign('description', patch.description);
        if (patch.position !== undefined) assign('position', patch.position);
        if (patch.isResolution !== undefined) assign('is_resolution', patch.isResolution ? 1 : 0);
        if (patch.isClosed !== undefined) assign('is_closed', patch.isClosed ? 1 : 0);
        if (patch.isDone !== undefined) assign('is_done', patch.isDone ? 1 : 0);
        if (patch.wipLimit !== undefined) assign('wip_limit', patch.wipLimit ?? null);

        if (sets.length === 0) return;
        params.push(update.id);
        this.db.run(`UPDATE workflow_statuses SET ${sets.join(', ')} WHERE id = ?`, params);
      }

      for (const statusId of changeSet.removedStatusIds ?? []) {
        const inUse = Number(
          this.db.scalar<number>('SELECT COUNT(*) AS c FROM issues WHERE status_id = ?', [statusId]) ?? 0,
        );
        if (inUse > 0) {
          throw workflowViolation(
            `Cannot remove status ${statusId}: ${inUse} issue(s) still use it. Move them first.`,
            { statusId, issueCount: inUse },
          );
        }
        this.db.run('DELETE FROM workflow_statuses WHERE id = ? AND project_id = ?', [
          statusId,
          projectId,
        ]);
      }

      for (const transition of changeSet.transitions ?? []) {
        this.db.run(
          `INSERT INTO workflow_transitions
             (workflow_id, from_status_id, to_status_id, name, description, required_permission)
           VALUES (?,?,?,?,?,?)`,
          [
            workflowId,
            transition.fromStatusId,
            transition.toStatusId,
            transition.name,
            transition.description,
            transition.requiredPermission,
          ],
        );
      }

      for (const transitionId of changeSet.removedTransitionIds ?? []) {
        this.db.run('DELETE FROM workflow_transitions WHERE id = ? AND workflow_id = ?', [
          transitionId,
          workflowId,
        ]);
      }

      this.db.run('UPDATE workflows SET updated_at = ? WHERE id = ?', [nowIso(), workflowId]);
    });

    const after = this.getForProject(projectId);

    this.services.audit.record(
      {
        action: 'workflow.changed',
        entityType: 'workflow',
        entityId: workflowId,
        projectId,
        actorId: ctx.actorId,
        before: { statuses: before.statuses, transitions: before.transitions },
        after: { statuses: after.statuses, transitions: after.transitions },
      },
      this.contextOf(ctx),
    );

    this.services.realtime.publish({
      event: 'board.updated',
      projectId,
      data: { reason: 'workflow.changed' },
    });

    return after;
  }

  /** Category for a state, used when a client posts a raw state value. */
  categoryForState(state: string): StatusCategory {
    switch (state) {
      case 'open':
        return 'unstarted';
      case 'in_progress':
      case 'blocked':
      case 'review':
        return 'started';
      case 'resolved':
      case 'closed':
        return 'completed';
      default:
        return 'cancelled';
    }
  }

  /** Throw unless the actor may perform a transition requiring `permission`. */
  assertTransitionAllowed(
    check: TransitionCheck,
    requiredPermission: string | null,
    hasPermission: (permission: never) => boolean,
  ): void {
    if (requiredPermission && !hasPermission(requiredPermission as never)) {
      throw forbidden(`This transition requires the "${requiredPermission}" permission`);
    }
    if (!check.allowed) throw workflowViolation(check.reason, { transition: check.transition });
  }

  private contextOf(ctx: { actorId: number | null }) {
    return { actorId: ctx.actorId };
  }

  private mapStatus(row: Record<string, unknown>): WorkflowStatus {
    return {
      id: Number(row.id) as WorkflowStatus['id'],
      workflowId: Number(row.workflow_id),
      projectId: Number(row.project_id) as WorkflowStatus['projectId'],
      key: String(row.key),
      name: String(row.name),
      state: String(row.state) as WorkflowStatus['state'],
      category: String(row.category) as StatusCategory,
      color: String(row.color ?? '#6b7280'),
      description: String(row.description ?? ''),
      position: Number(row.position ?? 0),
      isResolution: Number(row.is_resolution) === 1,
      isClosed: Number(row.is_closed) === 1,
      isDone: Number(row.is_done) === 1,
      wipLimit: row.wip_limit === null ? null : Number(row.wip_limit),
    };
  }

  private mapTransition(row: Record<string, unknown>): WorkflowTransition {
    return {
      id: Number(row.id) as WorkflowTransition['id'],
      workflowId: Number(row.workflow_id),
      fromStatusId: row.from_status_id === null ? null : (Number(row.from_status_id) as WorkflowTransition['fromStatusId']),
      toStatusId: Number(row.to_status_id) as WorkflowTransition['toStatusId'],
      name: String(row.name),
      description: String(row.description ?? ''),
      requiredPermission: row.required_permission === null ? null : String(row.required_permission),
    };
  }
}

export type { UpdateIssueInput };
