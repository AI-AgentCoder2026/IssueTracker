/**
 * Customisable workflow definition.
 *
 * Every project owns a workflow: an ordered set of statuses plus the allowed
 * transitions between them. The built-in default encodes the conventional
 * `Open → In Progress → Closed` path; projects override it to match their own
 * process (incident response, approvals, staged releases, ...).
 */

import { z } from 'zod';
import type { IsoDateTime, ProjectId, StatusId, TransitionId, UserId } from './ids.ts';
import { ISSUE_STATES, type IssueState } from './issue.ts';

/** Categories a status can belong to, used to group columns on the board. */
export const STATUS_CATEGORIES = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export interface WorkflowStatus {
  id: StatusId;
  workflowId: number;
  projectId: ProjectId;
  /** Stable machine key, unique per workflow. */
  key: string;
  name: string;
  state: IssueState;
  category: StatusCategory;
  /** Hex colour used by the board column header. */
  color: string;
  description: string;
  position: number;
  /** Statuses flagged as a resolution stop work; entering one sets `resolvedAt`. */
  isResolution: boolean;
  isClosed: boolean;
  /** Statuses that mean the item is counted as done on a dashboard. */
  isDone: boolean;
  wipLimit: number | null;
}

export interface WorkflowTransition {
  id: TransitionId;
  workflowId: number;
  fromStatusId: StatusId | null;
  /** `null` target means the transition is shown as a generic "move" affordance. */
  toStatusId: StatusId;
  name: string;
  description: string;
  /** Extra roles allowed to perform this transition beyond `issue.transition`. */
  requiredPermission: string | null;
}

export interface Workflow {
  id: number;
  projectId: ProjectId;
  name: string;
  description: string;
  isDefault: boolean;
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Result of asking the workflow engine whether a transition is allowed. */
export interface TransitionCheck {
  allowed: boolean;
  reason: string;
  /** Transition that would be taken when a single candidate matches. */
  transition: WorkflowTransition | null;
  /** All transitions available from the current status. */
  available: WorkflowTransition[];
}

/**
 * The default workflow, created for every new project. Keys intentionally match
 * the built-in `IssueState` values so state-based logic keeps working for teams
 * that never customise their workflow.
 */
export const DEFAULT_STATUSES: ReadonlyArray<
  Omit<WorkflowStatus, 'id' | 'workflowId' | 'projectId'>
> = [
  {
    key: 'backlog',
    name: 'Backlog',
    state: 'open',
    category: 'backlog',
    color: '#94a3b8',
    description: 'Captured but not yet triaged',
    position: 0,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: null,
  },
  {
    key: 'open',
    name: 'Open',
    state: 'open',
    category: 'unstarted',
    color: '#3b82f6',
    description: 'Triaged and ready to start',
    position: 1,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: null,
  },
  {
    key: 'in_progress',
    name: 'In Progress',
    state: 'in_progress',
    category: 'started',
    color: '#f59e0b',
    description: 'Actively being worked on',
    position: 2,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: 5,
  },
  {
    key: 'blocked',
    name: 'Blocked',
    state: 'blocked',
    category: 'started',
    color: '#ef4444',
    description: 'Waiting on an external dependency',
    position: 3,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: null,
  },
  {
    key: 'in_review',
    name: 'In Review',
    state: 'review',
    category: 'started',
    color: '#8b5cf6',
    description: 'Awaiting review or approval',
    position: 4,
    isResolution: false,
    isClosed: false,
    isDone: false,
    wipLimit: null,
  },
  {
    key: 'resolved',
    name: 'Resolved',
    state: 'resolved',
    category: 'completed',
    color: '#10b981',
    description: 'Fix delivered, awaiting verification',
    position: 5,
    isResolution: true,
    isClosed: false,
    isDone: false,
    wipLimit: null,
  },
  {
    key: 'closed',
    name: 'Closed',
    state: 'closed',
    category: 'completed',
    color: '#6b7280',
    description: 'Completed and verified',
    position: 6,
    isResolution: false,
    isClosed: true,
    isDone: true,
    wipLimit: null,
  },
  {
    key: 'wont_fix',
    name: "Won't Fix",
    state: 'wont_fix',
    category: 'cancelled',
    color: '#9ca3af',
    description: 'Closed without a change',
    position: 7,
    isResolution: false,
    isClosed: true,
    isDone: true,
    wipLimit: null,
  },
];

const statusCategoryByState: Record<IssueState, StatusCategory> = {
  open: 'unstarted',
  in_progress: 'started',
  blocked: 'started',
  review: 'started',
  resolved: 'completed',
  closed: 'completed',
  wont_fix: 'cancelled',
  duplicate: 'cancelled',
};

export function defaultCategoryForState(state: IssueState): StatusCategory {
  return statusCategoryByState[state] ?? 'unstarted';
}

/**
 * Whether a project that has never customised its workflow should still be
 * treated as using the default set. Used by the API to answer "is this custom?"
 * for the settings UI.
 */
export function isDefaultStatusKey(key: string): boolean {
  return DEFAULT_STATUSES.some((s) => s.key === key);
}

export const createStatusSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'key must be lowercase alphanumeric with underscores'),
  name: z.string().trim().min(1).max(120),
  state: z.enum(ISSUE_STATES),
  /**
   * Board column grouping. Optional: when omitted the server derives it from
   * `state`, which is right for almost every workflow.
   */
  category: z.enum(STATUS_CATEGORIES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour'),
  description: z.string().max(1000).default(''),
  position: z.number().int().min(0),
  isResolution: z.boolean().default(false),
  isClosed: z.boolean().default(false),
  isDone: z.boolean().default(false),
  wipLimit: z.number().int().min(1).nullable().default(null),
});

/** A status input with `category` resolved. */
export type ResolvedStatusInput = CreateStatusInput & { category: StatusCategory };

export type CreateStatusInput = z.infer<typeof createStatusSchema>;

export const updateStatusSchema = createStatusSchema.partial();

const transitionShape = {
  fromStatusId: z.number().int().positive().nullable().default(null),
  toStatusId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  requiredPermission: z.string().max(64).nullable().default(null),
};

export const createTransitionSchema = z
  .object(transitionShape)
  .refine((v) => v.fromStatusId === null || v.fromStatusId !== v.toStatusId, {
    message: 'a transition cannot target its own source status',
  });

export type CreateTransitionInput = z.infer<typeof createTransitionSchema>;

export const workflowStatusSchema = createStatusSchema.extend({ id: z.number().int().positive() });
/** Built from the raw shape because `createTransitionSchema` is a ZodEffects. */
export const workflowTransitionSchema = z
  .object({ ...transitionShape, id: z.number().int().positive() })
  .refine((v) => v.fromStatusId === null || v.fromStatusId !== v.toStatusId, {
    message: 'a transition cannot target its own source status',
  });

/** A status change request submitted by a client. */
export const transitionRequestSchema = z.object({
  toStatusId: z.number().int().positive(),
  /** Optional user-facing note recorded in the timeline. */
  comment: z.string().max(4000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export type TransitionRequest = z.infer<typeof transitionRequestSchema>;

export interface WorkflowChangeSet {
  statuses: CreateStatusInput[];
  transitions: CreateTransitionInput[];
  removedStatusIds: number[];
  removedTransitionIds: number[];
  updatedStatuses: Array<{ id: number; patch: Partial<CreateStatusInput> }>;
}

/** Who is allowed to see/act on a status, for restricted workflow columns. */
export interface StatusVisibility {
  statusId: StatusId;
  /** Roles that may not see issues in this status. Empty means everyone sees. */
  hiddenFromRoles: string[];
}

export type { UserId };
