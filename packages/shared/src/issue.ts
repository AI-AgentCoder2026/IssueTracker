/**
 * Issue domain model: classification, priority, hierarchy and dependencies.
 */

import { z } from 'zod';
import type {
  CommentId,
  IssueId,
  IsoDateTime,
  MilestoneId,
  ProjectId,
  UserId,
} from './ids.ts';

export const ISSUE_TYPES = [
  'bug',
  'feature',
  'task',
  'incident',
  'chore',
  'question',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
  'critical',
] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const PRIORITY_RANK: Record<IssuePriority, number> = {
  lowest: 10,
  low: 20,
  medium: 30,
  high: 40,
  highest: 50,
  critical: 60,
};

/** Issue lifecycle state. Kept in sync with the default workflow statuses. */
export const ISSUE_STATES = [
  'open',
  'in_progress',
  'blocked',
  'review',
  'resolved',
  'closed',
  'wont_fix',
  'duplicate',
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** States that mean the issue no longer counts as open work. */
export const TERMINAL_STATES: readonly IssueState[] = [
  'resolved',
  'closed',
  'wont_fix',
  'duplicate',
];

/** States that count as "actively being worked on" for velocity and SLA. */
export const ACTIVE_STATES: readonly IssueState[] = ['open', 'in_progress', 'review'];

export function isTerminalState(state: IssueState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Human-facing colour hints for the UI; not a source of truth. */
export const STATE_COLOR_HINT: Record<IssueState, string> = {
  open: '#3b82f6',
  in_progress: '#f59e0b',
  blocked: '#ef4444',
  review: '#8b5cf6',
  resolved: '#10b981',
  closed: '#6b7280',
  wont_fix: '#9ca3af',
  duplicate: '#9ca3af',
};

/**
 * Dependency kinds. `blocks` is stored on the source issue; the reverse edge
 * is derived at query time so a link is never stored twice.
 */
export const DEPENDENCY_KINDS = [
  'blocks',
  'is_blocked_by',
  'relates_to',
  'duplicates',
  'is_duplicated_by',
  'caused_by',
  'causes',
  'replaces',
  'replaced_by',
  'subtask_of',
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Kinds that represent a real ordering constraint on work. */
export const BLOCKING_KINDS: readonly DependencyKind[] = ['blocks', 'is_blocked_by'];

export function isBlocking(kind: DependencyKind): boolean {
  return BLOCKING_KINDS.includes(kind);
}

/** A hyperlink between two issues. */
export interface IssueLink {
  id: number;
  sourceIssueId: IssueId;
  targetIssueId: IssueId;
  kind: DependencyKind;
  /** Set when the link was created by duplicate detection rather than a human. */
  autoDetected: boolean;
  /** Similarity score 0..1 for auto-detected duplicate candidates. */
  confidence: number | null;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
}

/** Attachments referenced by an issue. */
export interface IssueAttachment {
  id: number;
  issueId: IssueId;
  commentId: CommentId | null;
  filename: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  uploadedBy: UserId;
  createdAt: IsoDateTime;
}

export interface Issue {
  id: IssueId;
  /** Human-readable key such as `PROJ-42`, unique per project. */
  key: string;
  projectId: ProjectId;
  sequence: number;
  title: string;
  /** Markdown source; rendered to HTML for display. */
  description: string;
  type: IssueType;
  priority: IssuePriority;
  state: IssueState;
  /** FK to the project's workflow status row for this issue. */
  statusId: number;
  assigneeId: UserId | null;
  reporterId: UserId | null;
  /** Parent issue for sub-task nesting; guards against cycles. */
  parentId: IssueId | null;
  dueDate: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  resolvedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  /** Estimated effort in hours. */
  estimateHours: number | null;
  /** Spent effort in hours. */
  timeSpentHours: number;
  position: number;
  milestoneId: MilestoneId | null;
  archived: boolean;
  archivedAt: IsoDateTime | null;
  /** Optimistic-concurrency token; bumped on every write. */
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Compact projection used by board columns and result tables. */
export interface IssueSummary {
  id: IssueId;
  key: string;
  title: string;
  type: IssueType;
  priority: IssuePriority;
  state: IssueState;
  assigneeId: UserId | null;
  assigneeName: string | null;
  parentId: IssueId | null;
  dueDate: IsoDateTime | null;
  position: number;
  labelIds: number[];
  commentCount: number;
  attachmentCount: number;
  subtaskCount: number;
  isOverdue: boolean;
  lastActivityAt: IsoDateTime;
}

/** Computed timing facts powering the timeline and SLA views. */
export interface IssueTiming {
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  resolvedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  dueDate: IsoDateTime | null;
  /** Wall-clock ms from creation to first start. */
  timeToStartMs: number | null;
  /** Wall-clock ms from first start to resolution. */
  timeInProgressMs: number | null;
  /** Wall-clock ms from creation to resolution. */
  timeToResolveMs: number | null;
  /** Wall-clock ms from creation to close. */
  timeToCloseMs: number | null;
  /** Positive ms past `dueDate`; 0 when on time, null when no due date. */
  overdueByMs: number | null;
  /** Aggregate of child issue time spent. */
  subtaskTimeSpentHours: number;
}

export const issueTypeSchema = z.enum(ISSUE_TYPES);
export const issuePrioritySchema = z.enum(ISSUE_PRIORITIES);
export const issueStateSchema = z.enum(ISSUE_STATES);
export const dependencyKindSchema = z.enum(DEPENDENCY_KINDS);

/** Human label for each issue type, used in the UI. */
export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  bug: 'Bug',
  feature: 'Feature',
  task: 'Task',
  incident: 'Incident',
  chore: 'Chore',
  question: 'Question',
};

export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  lowest: 'Lowest',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  highest: 'Highest',
  critical: 'Critical',
};

/** Fields a client may set when creating an issue. */
export const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(200_000).default(''),
  type: issueTypeSchema.default('task'),
  priority: issuePrioritySchema.default('medium'),
  statusId: z.number().int().positive().optional(),
  state: issueStateSchema.optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  estimateHours: z.number().min(0).max(10_000).nullable().optional(),
  milestoneId: z.number().int().positive().nullable().optional(),
  labelIds: z.array(z.number().int().positive()).max(50).optional(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;

/** Partial update; `undefined` means "leave unchanged". */
export const updateIssueSchema = createIssueSchema
  .partial()
  .extend({
    timeSpentHours: z.number().min(0).max(100_000).optional(),
    position: z.number().min(0).optional(),
    /** Optimistic concurrency guard. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine(
    (v) => Object.keys(v).filter((k) => v[k as keyof typeof v] !== undefined).length > 0,
    { message: 'at least one field must be provided' },
  );

export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
