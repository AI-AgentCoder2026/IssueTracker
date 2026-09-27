/**
 * Cross-cutting primitives: project, labels, milestones, pagination and the
 * error envelope used by every endpoint.
 */

import { z } from 'zod';
import type { IsoDateTime, MilestoneId, ProjectId, UserId } from './ids.ts';
import type { IssuePriority, IssueState, IssueType } from './issue.ts';
import { ROLES, type Role } from './rbac.ts';

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const PROJECT_VISIBILITIES = ['private', 'internal', 'public'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export interface Project {
  id: ProjectId;
  /** Short uppercase key used to build issue keys, e.g. `PROJ` in `PROJ-42`. */
  key: string;
  name: string;
  description: string;
  visibility: ProjectVisibility;
  defaultIssueType: IssueType;
  defaultPriority: IssuePriority;
  /** Next value for the issue sequence column. */
  nextIssueNumber: number;
  /** Set when GitLab is the configured source of truth for this project. */
  sourceOfTruth: 'local' | 'gitlab';
  /** Per-project retention; null keeps issues forever. */
  archivePolicy: {
    enabled: boolean;
    inactiveDays: number;
    requireCommentWithinDays: number | null;
  } | null;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const createProjectSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PROJECT_KEY_PATTERN, 'must be 2-10 uppercase letters or digits starting with a letter'),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).default(''),
  visibility: z.enum(PROJECT_VISIBILITIES).default('private'),
  defaultIssueType: z.enum(['bug', 'feature', 'task', 'incident', 'chore', 'question'] as const)
    .default('task'),
  defaultPriority: z.enum(
    ['lowest', 'low', 'medium', 'high', 'highest', 'critical'] as const,
  ).default('medium'),
  archivePolicy: z
    .object({
      enabled: z.boolean(),
      inactiveDays: z.number().int().min(1).max(3650),
      requireCommentWithinDays: z.number().int().min(1).max(3650).nullable(),
    })
    .nullable()
    .default(null),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema
  .partial()
  .omit({ key: true })
  .extend({ sourceOfTruth: z.enum(['local', 'gitlab'] as const).optional() });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const addMemberSchema = z.object({
  usernameOrEmail: z.string().trim().min(1).max(320),
  role: z.enum(ROLES),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;

// ---------------------------------------------------------------------------
// Label & milestone
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  projectId: ProjectId | null;
  name: string;
  slug: string;
  color: string;
  description: string;
  createdAt: IsoDateTime;
}

export interface Milestone {
  id: MilestoneId;
  projectId: ProjectId;
  title: string;
  description: string;
  state: 'planned' | 'active' | 'closed';
  dueDate: IsoDateTime | null;
  startDate: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour'),
  description: z.string().max(1000).default(''),
});

export type CreateLabelInput = z.infer<typeof createLabelSchema>;
export const updateLabelSchema = createLabelSchema.partial();
export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export const createMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  state: z.enum(['planned', 'active', 'closed'] as const).default('planned'),
  dueDate: z.string().datetime().nullable().default(null),
  startDate: z.string().datetime().nullable().default(null),
});

export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

/** Progress rollup attached to a milestone. */
export interface MilestoneProgress {
  milestoneId: MilestoneId;
  totalIssues: number;
  doneIssues: number;
  inProgressIssues: number;
  todoIssues: number;
  overdueIssues: number;
  percentComplete: number;
  totalEstimateHours: number;
  totalSpentHours: number;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Opaque cursor. Encodes the sort key of the last row seen so pagination stays
 * stable while rows are inserted concurrently — unlike `LIMIT/OFFSET`.
 */
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Page<T> {
  nodes: T[];
  pageInfo: PageInfo;
  totalCount: number;
}

export function emptyPage<T>(totalCount = 0): Page<T> {
  return {
    nodes: [],
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount,
  };
}

/** base64url encode/decode used for cursors and opaque ids. */
export function encodeCursor(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'rate_limited',
  'payload_too_large',
  'unsupported_media',
  'workflow_violation',
  'cycle_detected',
  'immutable_violation',
  'integration_error',
  'sync_conflict',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media: 415,
  workflow_violation: 422,
  cycle_detected: 422,
  immutable_violation: 409,
  integration_error: 502,
  sync_conflict: 409,
  internal_error: 500,
};

/** Field-level validation detail returned with `validation_failed`. */
export interface FieldError {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Extra context, e.g. the conflicting version number. */
    details?: Record<string, unknown>;
    fields?: FieldError[];
    requestId?: string;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    totalCount: number;
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

export type { IssuePriority, IssueState, IssueType, Role };
