/**
 * Timeline events and the immutable audit trail.
 *
 * `ActivityEvent` drives the per-issue timeline shown in the UI. `AuditEntry`
 * is the instance-wide, hash-chained record: each row stores the SHA-256 of its
 * own contents together with the previous row's hash, so deleting or editing a
 * historical entry breaks the chain and is detectable.
 */

import { z } from 'zod';
import type {
  IssueId,
  IsoDateTime,
  ProjectId,
  UserId,
} from './ids.ts';
import type { DependencyKind, IssuePriority, IssueState, IssueType } from './issue.ts';

export const ACTIVITY_TYPES = [
  'issue.created',
  'issue.updated',
  'issue.transitioned',
  'issue.assigned',
  'issue.unassigned',
  'issue.priority_changed',
  'issue.type_changed',
  'issue.due_date_changed',
  'issue.parent_changed',
  'issue.linked',
  'issue.unlinked',
  'issue.time_logged',
  'issue.estimate_changed',
  'issue.label_added',
  'issue.label_removed',
  'issue.archived',
  'issue.unarchived',
  'issue.milestone_changed',
  'issue.duplicate_detected',
  'comment.created',
  'comment.edited',
  'comment.deleted',
  'attachment.added',
  'attachment.removed',
  'mention.created',
  'sla.warning',
  'sla.breached',
  'gitlab.pushed',
  'gitlab.pulled',
  'gitlab.conflict',
  'gitlab.sync_failed',
  'workflow.changed',
  'issue.bulk_updated',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityEvent {
  id: number;
  issueId: IssueId;
  projectId: ProjectId;
  actorId: UserId | null;
  type: ActivityType;
  /** Human-readable one-line summary rendered directly in the timeline. */
  summary: string;
  /** Structured before/after payload for diff views. */
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  metadata: Record<string, unknown>;
  /** Client messages are hidden from the audit trail but shown on the timeline. */
  isSystemGenerated: boolean;
  createdAt: IsoDateTime;
}

export interface IssueTimeline {
  issueId: IssueId;
  events: ActivityEvent[];
  /** Wall-clock totals for the header strip. */
  timing: {
    createdAt: IsoDateTime;
    startedAt: IsoDateTime | null;
    resolvedAt: IsoDateTime | null;
    closedAt: IsoDateTime | null;
    dueDate: IsoDateTime | null;
    ageMs: number;
    timeToStartMs: number | null;
    timeInProgressMs: number | null;
    timeToResolveMs: number | null;
    timeToCloseMs: number | null;
    overdueByMs: number | null;
    totalLoggedHours: number;
  };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.login_failed',
  'auth.token_created',
  'auth.token_revoked',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.role_changed',
  'project.created',
  'project.updated',
  'project.deleted',
  'member.added',
  'member.removed',
  'member.role_changed',
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.transitioned',
  'issue.bulk_updated',
  'comment.created',
  'comment.deleted',
  'attachment.uploaded',
  'attachment.deleted',
  'workflow.changed',
  'dashboard.changed',
  'settings.changed',
  'gitlab.connection_created',
  'gitlab.connection_updated',
  'gitlab.connection_deleted',
  'gitlab.sync_triggered',
  'gitlab.token_rotated',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'guest_token.created',
  'guest_token.revoked',
  'sla.policy_changed',
  'export.generated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: number;
  actorId: UserId | null;
  actorName: string;
  actorEmail: string;
  /** IP address of the originating request, or `system` for background jobs. */
  ipAddress: string;
  userAgent: string;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  projectId: ProjectId | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** SHA-256 over the canonical serialisation of this row's own fields. */
  rowHash: string;
  /** `rowHash` of the preceding entry, forming the chain. */
  prevHash: string | null;
  createdAt: IsoDateTime;
}

export interface AuditChainVerification {
  valid: boolean;
  /** Row id where the chain first diverged, when `valid` is false. */
  brokenAtId: number | null;
  entriesChecked: number;
  message: string;
}

export const auditQuerySchema = z.object({
  actorId: z.number().int().positive().optional(),
  action: z.string().trim().max(64).optional(),
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(64).optional(),
  projectId: z.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.number().int().positive().optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Canonical field ordering used when hashing an audit row. */
export const AUDIT_HASH_FIELDS = [
  'actorId',
  'action',
  'entityType',
  'entityId',
  'projectId',
  'before',
  'after',
  'createdAt',
] as const;

/**
 * Stable stringify so that hashing is independent of key insertion order.
 * JSON.stringify alone would produce a different hash for `{a,b}` vs `{b,a}`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Field label map so the UI can render `issue.priority_changed` nicely. */
export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  'issue.created': 'created this issue',
  'issue.updated': 'edited this issue',
  'issue.transitioned': 'changed status',
  'issue.assigned': 'assigned',
  'issue.unassigned': 'unassigned',
  'issue.priority_changed': 'changed priority',
  'issue.type_changed': 'changed type',
  'issue.due_date_changed': 'changed the due date',
  'issue.parent_changed': 'changed the parent issue',
  'issue.linked': 'linked an issue',
  'issue.unlinked': 'removed a link',
  'issue.time_logged': 'logged time',
  'issue.estimate_changed': 'changed the estimate',
  'issue.label_added': 'added a label',
  'issue.label_removed': 'removed a label',
  'issue.archived': 'archived this issue',
  'issue.unarchived': 'restored this issue',
  'issue.milestone_changed': 'changed the milestone',
  'issue.duplicate_detected': 'possible duplicate detected',
  'comment.created': 'commented',
  'comment.edited': 'edited a comment',
  'comment.deleted': 'deleted a comment',
  'attachment.added': 'attached a file',
  'attachment.removed': 'removed a file',
  'mention.created': 'mentioned',
  'sla.warning': 'SLA warning',
  'sla.breached': 'SLA breached',
  'gitlab.pushed': 'pushed to GitLab',
  'gitlab.pulled': 'pulled from GitLab',
  'gitlab.conflict': 'sync conflict',
  'gitlab.sync_failed': 'GitLab sync failed',
  'workflow.changed': 'changed the workflow',
  'issue.bulk_updated': 'bulk edited',
};

export type ChangeField =
  | 'title'
  | 'description'
  | 'state'
  | 'priority'
  | 'type'
  | 'assigneeId'
  | 'parentId'
  | 'dueDate'
  | 'estimateHours'
  | 'timeSpentHours'
  | 'labelIds'
  | 'milestoneId'
  | 'statusId'
  | 'dependency'
  | 'archived';

export type { DependencyKind, IssuePriority, IssueState, IssueType };
