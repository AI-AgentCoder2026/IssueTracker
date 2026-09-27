/**
 * Search, filtering, bulk operations, export and SLA policy contracts.
 */

import { z } from 'zod';
import type { IssueId, ProjectId, SlaPolicyId, UserId } from './ids.ts';
import {
  DEPENDENCY_KINDS,
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPES,
  type DependencyKind,
  type IssuePriority,
  type IssueState,
  type IssueType,
} from './issue.ts';

// ---------------------------------------------------------------------------
// Search & filter
// ---------------------------------------------------------------------------

/**
 * FTS5 query syntax is passed through after sanitisation. The dialect supports
 * `col:term`, `AND/OR/NOT`, `"phrases"`, `*` prefixes and `NEAR`. Anything that
 * looks like a bare FTS operator outside a quoted phrase is escaped so user text
 * can never produce a syntax error.
 */
export const searchQuerySchema = z.object({
  /** Free-text query. Empty string means "no text filter". */
  q: z.string().max(500).default(''),
  projectIds: z.array(z.number().int().positive()).max(50).optional(),
  states: z.array(z.enum(ISSUE_STATES)).max(20).optional(),
  types: z.array(z.enum(ISSUE_TYPES)).max(20).optional(),
  priorities: z.array(z.enum(ISSUE_PRIORITIES)).max(20).optional(),
  assigneeIds: z.array(z.number().int().positive()).max(200).optional(),
  reporterIds: z.array(z.number().int().positive()).max(200).optional(),
  labelIds: z.array(z.number().int().positive()).max(50).optional(),
  milestoneIds: z.array(z.number().int().positive()).max(50).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  /** Only issues with a parent (sub-tasks). */
  hasParent: z.boolean().optional(),
  /** Only top-level issues. */
  topLevelOnly: z.boolean().optional(),
  statusIds: z.array(z.number().int().positive()).max(50).optional(),
  dueWithin: z
    .enum(['1d', '3d', '7d', '14d', '30d'])
    .optional()
    .describe('Issues due within this window'),
  overdueOnly: z.boolean().optional(),
  /** Issues with no assignee. */
  unassignedOnly: z.boolean().optional(),
  /** Restrict to a dependency relation involving this issue. */
  linkedToIssueId: z.number().int().positive().optional(),
  linkedKinds: z.array(z.enum(DEPENDENCY_KINDS)).max(20).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  updatedAfter: z.string().datetime().optional(),
  archived: z.boolean().default(false),
  /** Sub-tasks of an excluded issue are omitted unless this is true. */
  includeDescendants: z.boolean().default(true),
  sort: z
    .enum(['relevance', 'created_desc', 'created_asc', 'updated_desc', 'updated_asc', 'due_asc', 'priority_desc', 'key_asc'])
    .default('updated_desc'),
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.number().int().positive().optional(),
});

export type IssueSearchQuery = z.infer<typeof searchQuerySchema> & {
  projectId?: ProjectId;
  /** Restrict to issues the actor may see (permission-derived). */
  visibleProjectIds?: ProjectId[];
};

export interface SearchResultPage {
  issues: import('./issue.js').IssueSummary[];
  nextCursor: number | null;
  total: number;
  /** Wall-clock ms spent building the query. */
  tookMs: number;
  /** Non-fatal notes, e.g. "query syntax simplified". */
  warnings: string[];
}

/**
 * Escape user input so it can be embedded in an FTS5 MATCH expression.
 * Doubles single quotes and neutralises the bare operator characters that
 * would otherwise let a user inject query structure.
 */
export function toFtsMatchExpression(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Already valid FTS syntax (has a column filter, phrase, or explicit operator)
  // is passed through so power users keep full query support.
  if (/\w+:/.test(trimmed) || /"/.test(trimmed) || /\b(AND|OR|NOT|NEAR)\b/.test(trimmed)) {
    return trimmed;
  }
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_.*-]/gu, ''))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens
    .map((token) => (token.endsWith('*') ? token : `${token}*`))
    .join(' AND ');
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export const bulkOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('transition'),
    toStatusId: z.number().int().positive(),
    comment: z.string().max(4000).optional(),
  }),
  z.object({
    op: z.literal('setState'),
    state: z.enum(ISSUE_STATES),
  }),
  z.object({
    op: z.literal('setPriority'),
    priority: z.enum(ISSUE_PRIORITIES),
  }),
  z.object({
    op: z.literal('setType'),
    type: z.enum(ISSUE_TYPES),
  }),
  z.object({
    op: z.literal('assign'),
    assigneeId: z.number().int().positive().nullable(),
  }),
  z.object({
    op: z.literal('setDueDate'),
    dueDate: z.string().datetime().nullable(),
  }),
  z.object({
    op: z.literal('addLabels'),
    labelIds: z.array(z.number().int().positive()).min(1).max(50),
  }),
  z.object({
    op: z.literal('removeLabels'),
    labelIds: z.array(z.number().int().positive()).min(1).max(50),
  }),
  z.object({
    op: z.literal('setMilestone'),
    milestoneId: z.number().int().positive().nullable(),
  }),
  z.object({
    op: z.literal('setParent'),
    parentId: z.number().int().positive().nullable(),
  }),
  z.object({
    op: z.literal('archive'),
    archived: z.boolean(),
  }),
  z.object({
    op: z.literal('link'),
    kind: z.enum(DEPENDENCY_KINDS),
    targetIssueId: z.number().int().positive(),
  }),
  z.object({
    op: z.literal('unlink'),
    linkId: z.number().int().positive(),
  }),
]);

export type BulkOperation = z.infer<typeof bulkOperationSchema>;

export const bulkEditSchema = z.object({
  issueIds: z.array(z.number().int().positive()).min(1).max(500),
  operations: z.array(bulkOperationSchema).min(1).max(20),
  /** Report failures instead of aborting the whole batch. */
  continueOnError: z.boolean().default(true),
});

export type BulkEditInput = z.infer<typeof bulkEditSchema>;

export interface BulkEditResult {
  requested: number;
  succeeded: number;
  failed: number;
  results: Array<{
    issueId: IssueId;
    ok: boolean;
    error: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ['json', 'csv', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportRequestSchema = z.object({
  projectId: z.number().int().positive().optional(),
  issueIds: z.array(z.number().int().positive()).max(5000).optional(),
  filter: searchQuerySchema.partial().optional(),
  format: z.enum(EXPORT_FORMATS).default('json'),
  /** Include the full comment history per issue. */
  includeComments: z.boolean().default(false),
  includeAttachments: z.boolean().default(false),
  includeTimeline: z.boolean().default(false),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export const DEDUPE_STRATEGIES = ['exact_title', 'fuzzy_title', 'semantic'] as const;
export type DedupeStrategy = (typeof DEDUPE_STRATEGIES)[number];

export interface DuplicateCandidate {
  sourceIssueId: IssueId;
  sourceKey: string;
  sourceTitle: string;
  candidateIssueId: IssueId;
  candidateKey: string;
  candidateTitle: string;
  /** 0..1 similarity. */
  confidence: number;
  strategy: DedupeStrategy;
  /** Matched tokens, shown as the explanation in the review queue. */
  sharedTokens: string[];
}

export const dedupeScanSchema = z.object({
  projectId: z.number().int().positive().optional(),
  strategies: z.array(z.enum(DEDUPE_STRATEGIES)).min(1).default(['exact_title', 'fuzzy_title']),
  /** Candidates below this score are discarded. */
  minConfidence: z.number().min(0).max(1).default(0.75),
  /** Restrict to issues currently open. */
  openOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(1000).default(100),
  /** Persist results as `is_duplicated_by` links. */
  autoLink: z.boolean().default(false),
});

export type DedupeScanInput = z.infer<typeof dedupeScanSchema>;

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export const SLA_TARGETS = ['response', 'resolution'] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];

export interface SlaPolicy {
  id: SlaPolicyId;
  projectId: ProjectId | null;
  name: string;
  description: string;
  /** Filters deciding which issues the policy applies to. */
  appliesTo: {
    types: IssueType[];
    priorities: IssuePriority[];
    states: IssueState[];
    labelIds: number[];
  };
  responseMinutes: number | null;
  resolutionMinutes: number | null;
  /** Emit a warning this many minutes before breach. */
  warningMinutes: number;
  /** Only count weekdays when measuring. */
  businessHoursOnly: boolean;
  calendarId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Live countdown state for one issue/policy pair. */
export interface SlaStatus {
  policyId: SlaPolicyId;
  issueId: IssueId;
  target: SlaTarget;
  /** When the clock started. */
  startsAt: string;
  /** Deadline, or null once met. */
  dueAt: string | null;
  /** ms remaining; negative once breached. */
  remainingMs: number | null;
  metAt: string | null;
  breached: boolean;
  state: 'not_started' | 'on_track' | 'at_risk' | 'breached' | 'met';
}

export const createSlaPolicySchema = z.object({
  projectId: z.number().int().positive().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  appliesTo: z
    .object({
      types: z.array(z.enum(ISSUE_TYPES)).default([]),
      priorities: z.array(z.enum(ISSUE_PRIORITIES)).default([]),
      labelIds: z.array(z.number().int().positive()).default([]),
      states: z.array(z.enum(ISSUE_STATES)).default([]),
    })
    .default({ types: [], priorities: [], labelIds: [], states: [] }),
  responseMinutes: z.number().int().min(1).max(100_000).nullable().default(null),
  resolutionMinutes: z.number().int().min(1).max(1_000_000).nullable().default(null),
  warningMinutes: z.number().int().min(0).max(10_000).default(60),
  businessHoursOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

export const archivePolicySchema = z.object({
  /** Archive inactive issues after this many days. */
  inactiveDays: z.number().int().min(1).max(3650),
  /** Only archive issues in these states. Empty means "any terminal state". */
  states: z.array(z.enum(ISSUE_STATES)).default(['closed', 'resolved', 'wont_fix', 'duplicate']),
  /** Skip issues that still have open sub-tasks. */
  skipIssuesWithOpenSubtasks: z.boolean().default(true),
  /** Require a comment within this many days. */
  requireCommentWithinDays: z.number().int().min(1).max(3650).nullable().default(90),
  enabled: z.boolean().default(true),
});

export type ArchivePolicyInput = z.infer<typeof archivePolicySchema>;

export type { DependencyKind, IssuePriority, IssueState, IssueType, UserId };
