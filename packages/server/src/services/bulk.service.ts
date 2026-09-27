/**
 * Bulk issue editing.
 *
 * Every mutation is written directly against the database here rather than
 * looping over the single-issue service: a batch of 500 issues must cost a fixed
 * number of queries, not 500 round trips. The trade-off is that this module
 * duplicates a little of the field logic the issue service owns, so the columns
 * it touches are listed in `ISSUE_COLUMNS` and documented at each write.
 *
 * Transaction model
 * -----------------
 * * `continueOnError: false` (all-or-nothing) — the batch runs inside one
 *   `db.transaction()`; the first failure rolls everything back and propagates.
 * * `continueOnError: true` (default) — each issue gets its own transaction, so a
 *   partially successful batch persists and failures come back per issue.
 *
 * Nothing here interpolates a user value into SQL; ids, enums and kinds are all
 * bound parameters.
 */

import type {
  Actor,
  ActivityType,
  BulkEditResult,
  BulkOperation,
  IssueState,
  Permission,
} from '@tracker/shared';
import { asIssueId, bulkEditSchema, can } from '@tracker/shared';
import { inClause, type Database, type SqlParam } from '../db/connection.ts';
import { badRequest, conflict, cycleDetected, forbidden, notFound, workflowViolation } from '../errors.ts';
import { nowIso } from '../lib/time.ts';
import type { FieldChange } from './activity.service.ts';
import type { RequestContext, Services } from './context.ts';

export interface BulkApplyOptions {
  /** Default true. Report failures instead of aborting the whole batch. */
  continueOnError?: boolean;
  /** Correlation id echoed to realtime subscribers. */
  ref?: string;
}

export interface BulkOperationPreview {
  op: BulkOperation['op'];
  /** Human summary, e.g. `priority → high`. */
  label: string;
  /** Issues whose value would actually change. */
  wouldChange: number;
  /** Issues the operation could not be applied to at all. */
  skipped: number;
  notes: string[];
}

export interface BulkPreview {
  requested: number;
  /** Issues found and writable by the actor. */
  eligible: number;
  operations: BulkOperationPreview[];
}

/** The columns of `issues` this module reads. */
type IssueRow = {
  id: number;
  project_id: number;
  key: string;
  title: string;
  type: string;
  priority: string;
  state: string;
  status_id: number;
  assignee_id: number | null;
  reporter_id: number | null;
  parent_id: number | null;
  due_date: string | null;
  milestone_id: number | null;
  archived: number;
  version: number;
  started_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
}

type WorkflowStatusRow = {
  id: number;
  project_id: number;
  name: string;
  state: string;
  is_resolution: number;
  is_closed: number;
  is_done: number;
}

type LinkRow = {
  id: number;
  source_issue_id: number;
  target_issue_id: number;
  kind: string;
}

/** Pre-read link index for a batch, keyed three ways. */
interface LinkIndex {
  byId: Map<number, LinkRow>;
  bySource: Map<number, Set<string>>;
  byTarget: Map<number, Set<string>>;
}

/**
 * Workflow lookups repeated per issue in a batch. A 500-issue `transition` would
 * otherwise issue 500 identical `SELECT`s, so results are memoised per call.
 */
type StatusCache = Map<string, WorkflowStatusRow | undefined>;

/** One operation's effect, computed without writing anything. */
interface IssuePatch {
  set: Record<string, SqlParam>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changes: FieldChange[];
  extraEvents: Array<{ type: ActivityType; summary: string; metadata?: Record<string, unknown> }>;
  /** Label ids to add or remove. */
  labels?: { add: number[]; remove: number[] };
  /** Link row to insert or delete. */
  link?: { insert?: { targetIssueId: number; kind: string }; deleteId?: number };
}

/** Which capability each bulk operation needs. */
const OP_PERMISSION: Record<BulkOperation['op'], Permission> = {
  transition: 'issue.transition',
  setState: 'issue.update',
  setPriority: 'issue.update',
  setType: 'issue.update',
  assign: 'issue.assign',
  setDueDate: 'issue.update',
  addLabels: 'issue.update',
  removeLabels: 'issue.update',
  setMilestone: 'issue.update',
  setParent: 'issue.link',
  archive: 'issue.bulkEdit',
  link: 'issue.link',
  unlink: 'issue.link',
};

/** Activity event emitted for a field that changed. */
const FIELD_ACTIVITY: Record<string, ActivityType> = {
  state: 'issue.transitioned',
  assigneeId: 'issue.assigned',
  priority: 'issue.priority_changed',
  type: 'issue.type_changed',
  dueDate: 'issue.due_date_changed',
  parentId: 'issue.parent_changed',
  milestoneId: 'issue.milestone_changed',
  labelIds: 'issue.label_added',
  archived: 'issue.archived',
  links: 'issue.linked',
};

const ISSUE_COLUMNS = `id, project_id, key, title, type, priority, state, status_id,
  assignee_id, reporter_id, parent_id, due_date, milestone_id, archived, version,
  started_at, resolved_at, closed_at`;

function emptyPatch(): IssuePatch {
  return { set: {}, before: {}, after: {}, changes: [], extraEvents: [] };
}

function snapshot(issue: IssueRow): Record<string, unknown> {
  return {
    statusId: issue.status_id,
    state: issue.state,
    priority: issue.priority,
    type: issue.type,
    assigneeId: issue.assignee_id,
    dueDate: issue.due_date,
    parentId: issue.parent_id,
    milestoneId: issue.milestone_id,
    archived: issue.archived === 1,
    resolvedAt: issue.resolved_at,
    closedAt: issue.closed_at,
  };
}

function describeOperation(op: BulkOperation): string {
  switch (op.op) {
    case 'transition':
      return `transition to status ${op.toStatusId}`;
    case 'setState':
      return `state to ${op.state}`;
    case 'setPriority':
      return `priority to ${op.priority}`;
    case 'setType':
      return `type to ${op.type}`;
    case 'assign':
      return op.assigneeId === null ? 'unassign' : `assign to ${op.assigneeId}`;
    case 'setDueDate':
      return op.dueDate === null ? 'clear the due date' : `due date to ${op.dueDate}`;
    case 'addLabels':
      return `add ${op.labelIds.length} label(s)`;
    case 'removeLabels':
      return `remove ${op.labelIds.length} label(s)`;
    case 'setMilestone':
      return op.milestoneId === null ? 'clear the milestone' : `milestone to ${op.milestoneId}`;
    case 'setParent':
      return op.parentId === null ? 'clear the parent' : `parent to ${op.parentId}`;
    case 'archive':
      return op.archived ? 'archive' : 'unarchive';
    case 'link':
      return `link ${op.kind} to issue ${op.targetIssueId}`;
    case 'unlink':
      return `remove link ${op.linkId}`;
    default: {
      const never: never = op;
      return JSON.stringify(never);
    }
  }
}

export class BulkService {
  private readonly db: Database;
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Apply `operations` to every id in `issueIds` and return a per-issue result.
   *
   * A permission failure, a missing issue, a status from another project's
   * workflow, a parent cycle and a duplicate link are all per-issue failures
   * when `continueOnError` is on, and abort the batch when it is off.
   */
  async apply(
    issueIds: number[],
    operations: BulkOperation[],
    actor: Actor,
    ctx: RequestContext,
    options: BulkApplyOptions = {},
  ): Promise<BulkEditResult> {
    const input = bulkEditSchema.parse({
      issueIds,
      operations,
      continueOnError: options.continueOnError ?? true,
    });
    const actorId = Number(actor.userId);
    const at = nowIso();
    const cache: StatusCache = new Map();
    const labels = this.loadLabelMap(input.issueIds);
    const links = this.loadLinkIndex(input.issueIds);

    const results: BulkEditResult['results'] = [];
    const affected: Array<{ issue: IssueRow; changed: FieldChange[] }> = [];

    /**
     * Execute one issue and let failures propagate. The caller decides whether a
     * throw rolls the whole batch back or only this issue, so the error must not
     * be caught here — swallowing it would commit a half-applied issue.
     */
    const execute = (issueId: number): void => {
      const outcome = this.applyOne(issueId, input.operations, actor, actorId, at, ctx, {
        labels,
        links,
        cache,
      });
      results.push({ issueId: asIssueId(issueId), ok: true, error: null });
      if (outcome) affected.push(outcome);
    };

    if (input.continueOnError) {
      for (const issueId of input.issueIds) {
        try {
          // One transaction per issue, so a failure cannot undo its siblings —
          // and cannot leave this issue half applied either.
          this.db.transaction(() => execute(issueId));
        } catch (error) {
          results.push({
            issueId: asIssueId(issueId),
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      try {
        // All-or-nothing: the first failure rolls the entire batch back.
        this.db.transaction(() => {
          for (const issueId of input.issueIds) execute(issueId);
        });
      } catch (error) {
        // The transaction rolled back, so nothing in this batch was committed:
        // every id is reported as failed rather than pretending the ids that
        // happened to run before the failure survived.
        const message = error instanceof Error ? error.message : String(error);
        return {
          requested: input.issueIds.length,
          succeeded: 0,
          failed: input.issueIds.length,
          results: input.issueIds.map((issueId) => ({
            issueId: asIssueId(issueId),
            ok: false,
            error: message,
          })),
        };
      }
    }

    this.publishUpdates(affected, options.ref ?? ctx.requestId);
    this.recordBatchAudit(input.issueIds.length, results, actorId, ctx);

    return {
      requested: input.issueIds.length,
      succeeded: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length,
      results,
    };
  }

  /**
   * How many issues each operation would actually change, without writing
   * anything. The confirmation dialog calls this; it reuses the same pure
   * operation analysis as `apply` so the preview cannot drift from the result.
   */
  async preview(issueIds: number[], operations: BulkOperation[], actor: Actor): Promise<BulkPreview> {
    const input = bulkEditSchema.parse({ issueIds, operations, continueOnError: true });
    const issues = this.loadIssues(input.issueIds);
    const labels = this.loadLabelMap(input.issueIds);
    const links = this.loadLinkIndex(input.issueIds);
    const cache: StatusCache = new Map();

    let eligible = 0;
    for (const issue of issues.values()) {
      if (this.canOperate(actor, issue, input.operations)) eligible += 1;
    }

    const previews: BulkOperationPreview[] = input.operations.map((op) => {
      let wouldChange = 0;
      let skipped = 0;
      const notes: string[] = [];
      for (const issue of issues.values()) {
        if (!this.canOperate(actor, issue, input.operations)) {
          skipped += 1;
          continue;
        }
        try {
          const patch = this.simulate(issue, op, labels.get(issue.id) ?? new Set(), links, cache);
          if (patch.changes.length > 0 || patch.extraEvents.length > 0) wouldChange += 1;
          else notes.push(`${issue.key} already has this value`);
        } catch (error) {
          skipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (!notes.includes(message)) notes.push(message);
        }
      }
      return { op: op.op, label: describeOperation(op), wouldChange, skipped, notes };
    });

    return { requested: input.issueIds.length, eligible, operations: previews };
  }

  // -------------------------------------------------------------------------
  // Per-issue execution
  // -------------------------------------------------------------------------

  /** Apply every operation to one issue inside the caller's transaction. */
  private applyOne(
    issueId: number,
    operations: BulkOperation[],
    actor: Actor,
    actorId: number,
    at: string,
    ctx: RequestContext,
    batch: { labels: Map<number, Set<number>>; links: LinkIndex; cache: StatusCache },
  ): { issue: IssueRow; changed: FieldChange[] } | null {
    const issue = this.db.get<IssueRow>(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ?`, [issueId]);
    if (!issue) throw notFound('Issue', issueId);

    const before = snapshot(issue);
    const set: Record<string, SqlParam> = {};
    const changes: FieldChange[] = [];
    const extraEvents: Array<{ type: ActivityType; summary: string; metadata?: Record<string, unknown> }> = [];
    const labelIds = batch.labels.get(issue.id) ?? new Set<number>();

    for (const op of operations) {
      const permission = OP_PERMISSION[op.op];
      const decision = can(actor, permission, { projectId: issue.project_id as never });
      if (!decision.allowed) {
        throw forbidden(`${decision.reason} (${permission})`);
      }
      const patch = this.simulate(issue, op, labelIds, batch.links, batch.cache);
      this.commitPatch(issue, op, patch, actorId, at, set, changes, extraEvents, batch.links);
    }

    if (changes.length === 0 && extraEvents.length === 0) {
      // Nothing moved: no version bump, no events, no audit row.
      return null;
    }

    const columns = Object.keys(set);
    if (columns.length > 0) {
      // `version` and `updated_at` are appended by the server, never by a caller.
      this.db.run(
        `UPDATE issues
            SET ${columns.map((column) => `${column} = ?`).join(', ')},
                version = version + 1,
                updated_at = ?
          WHERE id = ?`,
        [...columns.map((column) => set[column] as SqlParam), at, issue.id],
      );
    }

    const after: Record<string, unknown> = { ...before };
    for (const change of changes) after[change.field] = change.to;

    this.services.audit.record(
      {
        action: 'issue.bulk_updated',
        entityType: 'issue',
        entityId: issue.id,
        projectId: issue.project_id,
        before,
        after,
        actorId,
      },
      ctx.auditContext,
    );

    this.services.activity.record({
      issueId: issue.id,
      projectId: issue.project_id,
      actorId,
      type: 'issue.bulk_updated',
      summary: `bulk edited (${changes.length} field change(s), ${extraEvents.length} action(s))`,
      changes,
      metadata: { operations: operations.map((op) => op.op) },
    });

    for (const change of changes) {
      const type = FIELD_ACTIVITY[change.field];
      if (!type) continue;
      this.services.activity.recordFieldChange({
        issueId: issue.id,
        projectId: issue.project_id,
        actorId,
        type,
        before,
        after,
        fields: [change.field],
      });
    }
    for (const event of extraEvents) {
      this.services.activity.record({
        issueId: issue.id,
        projectId: issue.project_id,
        actorId,
        type: event.type,
        summary: event.summary,
        metadata: event.metadata ?? {},
      });
    }

    return { issue, changed: changes };
  }

  /**
   * Compute one operation's effect. Reads only — no writes — so `preview()` can
   * reuse it unchanged and stay side-effect free.
   */
  private simulate(
    issue: IssueRow,
    op: BulkOperation,
    labelIds: Set<number>,
    links: LinkIndex,
    cache: StatusCache,
  ): IssuePatch {
    switch (op.op) {
      case 'transition': {
        const status = this.requireStatus(op.toStatusId, issue.project_id, cache);
        return this.statusPatch(issue, status);
      }
      case 'setState': {
        const status = this.statusForState(op.state, issue.project_id, cache);
        if (!status) {
          throw workflowViolation(`this project's workflow has no status for state "${op.state}"`);
        }
        return this.statusPatch(issue, status);
      }
      case 'setPriority': {
        if (issue.priority === op.priority) return emptyPatch();
        const patch = emptyPatch();
        patch.set.priority = op.priority;
        patch.before.priority = issue.priority;
        patch.after.priority = op.priority;
        patch.changes.push({ field: 'priority', from: issue.priority, to: op.priority });
        return patch;
      }
      case 'setType': {
        if (issue.type === op.type) return emptyPatch();
        const patch = emptyPatch();
        patch.set.type = op.type;
        patch.before.type = issue.type;
        patch.after.type = op.type;
        patch.changes.push({ field: 'type', from: issue.type, to: op.type });
        return patch;
      }
      case 'assign': {
        if (issue.assignee_id === op.assigneeId) return emptyPatch();
        if (op.assigneeId !== null && !this.userExists(op.assigneeId)) {
          throw badRequest(`assignee ${op.assigneeId} does not exist`);
        }
        const patch = emptyPatch();
        patch.set.assignee_id = op.assigneeId;
        patch.before.assigneeId = issue.assignee_id;
        patch.after.assigneeId = op.assigneeId;
        patch.changes.push({ field: 'assigneeId', from: issue.assignee_id, to: op.assigneeId });
        return patch;
      }
      case 'setDueDate': {
        if (issue.due_date === op.dueDate) return emptyPatch();
        const patch = emptyPatch();
        patch.set.due_date = op.dueDate;
        patch.before.dueDate = issue.due_date;
        patch.after.dueDate = op.dueDate;
        patch.changes.push({ field: 'dueDate', from: issue.due_date, to: op.dueDate });
        return patch;
      }
      case 'setMilestone': {
        if (issue.milestone_id === op.milestoneId) return emptyPatch();
        const patch = emptyPatch();
        patch.set.milestone_id = op.milestoneId;
        patch.before.milestoneId = issue.milestone_id;
        patch.after.milestoneId = op.milestoneId;
        patch.changes.push({ field: 'milestoneId', from: issue.milestone_id, to: op.milestoneId });
        return patch;
      }
      case 'setParent': {
        if (issue.parent_id === op.parentId) return emptyPatch();
        if (op.parentId !== null) {
          const parent = this.db.get<{ project_id: number }>(
            'SELECT project_id FROM issues WHERE id = ?',
            [op.parentId],
          );
          if (!parent) throw notFound('Issue', op.parentId);
          if (parent.project_id !== issue.project_id) {
            throw badRequest('the parent issue belongs to a different project');
          }
          if (this.wouldCycle(issue.id, op.parentId)) {
            throw cycleDetected(
              `making ${issue.key} a child of issue ${op.parentId} would create a cycle`,
            );
          }
        }
        const patch = emptyPatch();
        patch.set.parent_id = op.parentId;
        patch.before.parentId = issue.parent_id;
        patch.after.parentId = op.parentId;
        patch.changes.push({ field: 'parentId', from: issue.parent_id, to: op.parentId });
        return patch;
      }
      case 'archive': {
        const archived = op.archived ? 1 : 0;
        if (issue.archived === archived) return emptyPatch();
        const patch = emptyPatch();
        patch.set.archived = archived;
        patch.set.archived_at = op.archived ? nowIso() : null;
        patch.before.archived = issue.archived === 1;
        patch.after.archived = op.archived;
        patch.changes.push({ field: 'archived', from: issue.archived === 1, to: op.archived });
        patch.extraEvents.push({
          type: op.archived ? 'issue.archived' : 'issue.unarchived',
          summary: op.archived ? 'archived by a bulk edit' : 'restored by a bulk edit',
        });
        return patch;
      }
      case 'addLabels': {
        const add = op.labelIds.filter((id) => !labelIds.has(id));
        if (add.length === 0) return emptyPatch();
        const patch = emptyPatch();
        patch.labels = { add, remove: [] };
        patch.before.labelIds = [...labelIds].sort((a, b) => a - b);
        patch.after.labelIds = [...labelIds, ...add].sort((a, b) => a - b);
        patch.changes.push({ field: 'labelIds', from: patch.before.labelIds, to: patch.after.labelIds });
        patch.extraEvents.push({
          type: 'issue.label_added',
          summary: `added ${add.length} label(s) in a bulk edit`,
          metadata: { labelIds: add },
        });
        return patch;
      }
      case 'removeLabels': {
        const remove = op.labelIds.filter((id) => labelIds.has(id));
        if (remove.length === 0) return emptyPatch();
        const patch = emptyPatch();
        patch.labels = { add: [], remove };
        patch.before.labelIds = [...labelIds].sort((a, b) => a - b);
        patch.after.labelIds = [...labelIds].filter((id) => !remove.includes(id));
        patch.changes.push({ field: 'labelIds', from: patch.before.labelIds, to: patch.after.labelIds });
        patch.extraEvents.push({
          type: 'issue.label_removed',
          summary: `removed ${remove.length} label(s) in a bulk edit`,
          metadata: { labelIds: remove },
        });
        return patch;
      }
      case 'link': {
        if (op.targetIssueId === issue.id) {
          throw badRequest('an issue cannot be linked to itself');
        }
        const target = this.db.get<{ id: number }>('SELECT id FROM issues WHERE id = ?', [
          op.targetIssueId,
        ]);
        if (!target) throw notFound('Issue', op.targetIssueId);
        // A relation is stored once, so the reverse edge is a duplicate too.
        const duplicate =
          links.bySource.get(issue.id)?.has(op.kind) === true ||
          links.byTarget.get(issue.id)?.has(op.kind) === true ||
          links.bySource.get(op.targetIssueId)?.has(op.kind) === true ||
          links.byTarget.get(op.targetIssueId)?.has(op.kind) === true;
        if (duplicate) {
          throw conflict(`a "${op.kind}" link to issue ${op.targetIssueId} already exists`);
        }
        const patch = emptyPatch();
        patch.link = { insert: { targetIssueId: op.targetIssueId, kind: op.kind } };
        patch.changes.push({ field: 'links', from: null, to: op.kind });
        patch.extraEvents.push({
          type: 'issue.linked',
          summary: `linked to issue ${op.targetIssueId} as ${op.kind}`,
          metadata: { kind: op.kind, targetIssueId: op.targetIssueId },
        });
        return patch;
      }
      case 'unlink': {
        const link = links.byId.get(op.linkId);
        if (!link) throw notFound('Issue link', op.linkId);
        if (link.source_issue_id !== issue.id) {
          throw badRequest(`link ${op.linkId} does not belong to ${issue.key}`);
        }
        const patch = emptyPatch();
        patch.link = { deleteId: link.id };
        patch.changes.push({ field: 'links', from: link.kind, to: null });
        patch.extraEvents.push({
          type: 'issue.unlinked',
          summary: `removed the "${link.kind}" link to issue ${link.target_issue_id}`,
          metadata: { linkId: link.id, kind: link.kind },
        });
        return patch;
      }
      default: {
        // Exhaustiveness guard: a new variant must be handled above.
        const never: never = op;
        throw new Error(`unsupported bulk operation: ${JSON.stringify(never)}`);
      }
    }
  }

  /** Write one operation's patch. Only called from `applyOne`. */
  private commitPatch(
    issue: IssueRow,
    op: BulkOperation,
    patch: IssuePatch,
    actorId: number,
    at: string,
    set: Record<string, SqlParam>,
    changes: FieldChange[],
    extraEvents: Array<{ type: ActivityType; summary: string; metadata?: Record<string, unknown> }>,
    links: LinkIndex,
  ): void {
    if (patch.labels) {
      for (const labelId of patch.labels.add) {
        this.db.run(
          'INSERT OR IGNORE INTO issue_labels (issue_id, label_id, created_at) VALUES (?,?,?)',
          [issue.id, labelId, at],
        );
      }
      for (const labelId of patch.labels.remove) {
        this.db.run('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?', [
          issue.id,
          labelId,
        ]);
      }
      changes.push(...patch.changes);
      extraEvents.push(...patch.extraEvents);
      return;
    }

    if (patch.link?.insert) {
      const insert = patch.link.insert;
      this.db.run(
        `INSERT INTO issue_links
           (source_issue_id, target_issue_id, kind, auto_detected, confidence, created_by, created_at)
         VALUES (?,?,?,0,NULL,?,?)`,
        [issue.id, insert.targetIssueId, insert.kind, actorId, at],
      );
      // Keep the batch index current so a second identical link in the same
      // request is reported as a duplicate rather than a UNIQUE violation.
      const row: LinkRow = {
        id: 0,
        source_issue_id: issue.id,
        target_issue_id: insert.targetIssueId,
        kind: insert.kind,
      };
      const source = links.bySource.get(issue.id) ?? new Set<string>();
      source.add(insert.kind);
      links.bySource.set(issue.id, source);
      const target = links.byTarget.get(insert.targetIssueId) ?? new Set<string>();
      target.add(insert.kind);
      links.byTarget.set(insert.targetIssueId, target);
      links.byId.set(row.id, row);
      changes.push(...patch.changes);
      extraEvents.push(...patch.extraEvents);
      return;
    }

    if (patch.link?.deleteId) {
      const link = links.byId.get(patch.link.deleteId);
      this.db.run('DELETE FROM issue_links WHERE id = ?', [patch.link.deleteId]);
      if (link) {
        links.byId.delete(link.id);
        links.bySource.get(link.source_issue_id)?.delete(link.kind);
        links.byTarget.get(link.target_issue_id)?.delete(link.kind);
      }
      changes.push(...patch.changes);
      extraEvents.push(...patch.extraEvents);
      return;
    }

    if (op.op === 'transition' && op.comment && op.comment.trim() !== '') {
      this.db.run(
        `INSERT INTO comments (issue_id, author_id, body, is_system, created_at, updated_at)
         VALUES (?,?,?,1,?,?)`,
        [issue.id, actorId, op.comment, at, at],
      );
    }

    Object.assign(set, patch.set);
    changes.push(...patch.changes);
    extraEvents.push(...patch.extraEvents);
  }

  // -------------------------------------------------------------------------
  // Workflow helpers
  // -------------------------------------------------------------------------

  /**
   * Build the `state` / `status_id` / `resolved_at` / `closed_at` patch for a
   * target status. Terminal timestamps are stamped once and cleared when an issue
   * comes back out of a terminal status, which is what keeps the issue timeline
   * honest after a bulk transition.
   */
  private statusPatch(issue: IssueRow, status: WorkflowStatusRow): IssuePatch {
    if (issue.status_id === status.id && issue.state === status.state) return emptyPatch();
    const patch = emptyPatch();
    patch.set.status_id = status.id;
    patch.set.state = status.state;
    patch.before.statusId = issue.status_id;
    patch.before.state = issue.state;
    patch.after.statusId = status.id;
    patch.after.state = status.state;
    patch.changes.push({ field: 'state', from: issue.state, to: status.state });

    const isDone = status.is_done === 1 || status.is_resolution === 1;
    const isClosed = status.is_closed === 1;
    if (isDone && !issue.resolved_at) {
      patch.set.resolved_at = nowIso();
      patch.before.resolvedAt = null;
      patch.after.resolvedAt = patch.set.resolved_at;
    }
    if (!isDone && issue.resolved_at) {
      patch.set.resolved_at = null;
      patch.before.resolvedAt = issue.resolved_at;
      patch.after.resolvedAt = null;
    }
    if (isClosed && !issue.closed_at) {
      patch.set.closed_at = nowIso();
      patch.before.closedAt = null;
      patch.after.closedAt = patch.set.closed_at;
    }
    if (!isClosed && issue.closed_at) {
      patch.set.closed_at = null;
      patch.before.closedAt = issue.closed_at;
      patch.after.closedAt = null;
    }
    if (status.state === 'in_progress' && !issue.started_at) patch.set.started_at = nowIso();
    return patch;
  }

  /** A target status must belong to the same workflow as the issue. */
  private requireStatus(
    statusId: number,
    projectId: number,
    cache: StatusCache,
  ): WorkflowStatusRow {
    const cacheKey = `id:${statusId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const status = this.db.get<WorkflowStatusRow>(
      `SELECT id, project_id, name, state, is_resolution, is_closed, is_done
         FROM workflow_statuses WHERE id = ?`,
      [statusId],
    );
    if (!status) {
      cache.set(cacheKey, undefined);
      throw notFound('Workflow status', statusId);
    }
    cache.set(cacheKey, status);
    if (status.project_id !== projectId) {
      throw workflowViolation(`status ${statusId} does not belong to this project's workflow`);
    }
    return status;
  }

  /** Best status matching a state: a done/closed column wins over a plain one. */
  private statusForState(
    state: IssueState,
    projectId: number,
    cache: StatusCache,
  ): WorkflowStatusRow | undefined {
    const cacheKey = `state:${projectId}:${state}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const status = this.db.get<WorkflowStatusRow>(
      `SELECT id, project_id, name, state, is_resolution, is_closed, is_done
         FROM workflow_statuses
        WHERE project_id = ? AND state = ?
        ORDER BY is_done DESC, is_closed DESC, position ASC, id ASC
        LIMIT 1`,
      [projectId, state],
    );
    cache.set(cacheKey, status);
    return status;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private loadIssues(issueIds: number[]): Map<number, IssueRow> {
    if (issueIds.length === 0) return new Map();
    const rows = this.db.all<IssueRow>(
      `SELECT ${ISSUE_COLUMNS} FROM issues WHERE id IN ${inClause(issueIds.length)}`,
      issueIds,
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  private loadLabelMap(issueIds: number[]): Map<number, Set<number>> {
    const map = new Map<number, Set<number>>();
    if (issueIds.length === 0) return map;
    const rows = this.db.all<{ issue_id: number; label_id: number }>(
      `SELECT issue_id, label_id FROM issue_labels WHERE issue_id IN ${inClause(issueIds.length)}`,
      issueIds,
    );
    for (const row of rows) {
      const set = map.get(row.issue_id) ?? new Set<number>();
      set.add(row.label_id);
      map.set(row.issue_id, set);
    }
    return map;
  }

  private loadLinkIndex(issueIds: number[]): LinkIndex {
    const index: LinkIndex = {
      byId: new Map(),
      bySource: new Map(),
      byTarget: new Map(),
    };
    if (issueIds.length === 0) return index;
    const rows = this.db.all<LinkRow>(
      `SELECT id, source_issue_id, target_issue_id, kind
         FROM issue_links
        WHERE source_issue_id IN ${inClause(issueIds.length)}
           OR target_issue_id IN ${inClause(issueIds.length)}`,
      [...issueIds, ...issueIds],
    );
    for (const row of rows) {
      index.byId.set(row.id, row);
      const source = index.bySource.get(row.source_issue_id) ?? new Set<string>();
      source.add(row.kind);
      index.bySource.set(row.source_issue_id, source);
      const target = index.byTarget.get(row.target_issue_id) ?? new Set<string>();
      target.add(row.kind);
      index.byTarget.set(row.target_issue_id, target);
    }
    return index;
  }

  private userExists(userId: number): boolean {
    return (
      this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE id = ?', [userId])?.c === 1
    );
  }

  /**
   * Walk the ancestor chain of `newParentId`. If the chain reaches `issueId`,
   * making the issue its own ancestor would create a cycle. A pre-existing loop
   * or a dangling parent is treated as a cycle too — the write is refused either
   * way. The walk is bounded so a corrupt chain cannot spin forever.
   */
  private wouldCycle(issueId: number, newParentId: number): boolean {
    if (newParentId === issueId) return true;
    const seen = new Set<number>([issueId]);
    let cursor: number | null = newParentId;
    for (let hops = 0; cursor !== null && hops < 1000; hops += 1) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      const row: { parent_id: number | null } | undefined = this.db.get<{
        parent_id: number | null;
      }>('SELECT parent_id FROM issues WHERE id = ?', [cursor]);
      if (!row) return true;
      cursor = row.parent_id;
    }
    return cursor !== null;
  }

  /** True when the actor holds every capability the operation set requires. */
  private canOperate(actor: Actor, issue: IssueRow, operations: BulkOperation[]): boolean {
    return operations.every((op) =>
      can(actor, OP_PERMISSION[op.op], { projectId: issue.project_id as never }).allowed,
    );
  }

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------

  /** Tell the board and the open issue views which rows moved. */
  private publishUpdates(affected: Array<{ issue: IssueRow; changed: FieldChange[] }>, ref: string): void {
    const byProject = new Map<number, number[]>();
    for (const { issue, changed } of affected) {
      this.services.realtime.publish(
        {
          event: 'issue.updated',
          projectId: issue.project_id,
          issueId: issue.id,
          data: {
            issueId: issue.id,
            key: issue.key,
            version: issue.version + 1,
            changedFields: changed.map((change) => change.field),
            reason: 'bulk',
          },
        },
        { ref },
      );
      const ids = byProject.get(issue.project_id) ?? [];
      ids.push(issue.id);
      byProject.set(issue.project_id, ids);
    }
    for (const [projectId, issueIds] of byProject) {
      // Deliberately a partial board signal: the board route owns the column
      // layout, so clients are told to re-fetch rather than sent a fabricated
      // `BoardUpdate`.
      this.services.realtime.publish(
        { event: 'board.updated', projectId, data: { projectId, issueIds, reason: 'bulk' } },
        { ref },
      );
    }
  }

  /** One summary row for the batch itself, alongside the per-issue entries. */
  private recordBatchAudit(
    requested: number,
    results: BulkEditResult['results'],
    actorId: number,
    ctx: RequestContext,
  ): void {
    this.services.audit.record(
      {
        action: 'issue.bulk_updated',
        entityType: 'bulk_batch',
        entityId: ctx.requestId,
        after: {
          requested,
          succeeded: results.filter((entry) => entry.ok).length,
          failed: results.filter((entry) => !entry.ok).length,
          failedIssueIds: results.filter((entry) => !entry.ok).map((entry) => entry.issueId),
        },
        actorId,
      },
      ctx.auditContext,
    );
  }
}
