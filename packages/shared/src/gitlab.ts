/**
 * GitLab integration — the configurable source-of-truth model.
 *
 * A connection binds a local project to a GitLab project and declares which
 * side is authoritative. The same adapter serves all three modes; only the
 * conflict-resolution rule changes:
 *
 *   local_authoritative  local wins; GitLab is a write-only mirror
 *   gitlab_authoritative GitLab wins; local is a read-only mirror
 *   bidirectional        newest change wins, ties go to GitLab, conflicts are
 *                        recorded and surfaced in the UI
 */

import { z } from 'zod';
import type { GitLabConnectionId, IssueId, IsoDateTime, ProjectId } from './ids.ts';

export const SYNC_MODES = [
  'local_authoritative',
  'gitlab_authoritative',
  'bidirectional',
] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_MODE_LABEL: Record<SyncMode, string> = {
  local_authoritative: 'This tracker is the source of truth',
  gitlab_authoritative: 'GitLab is the source of truth',
  bidirectional: 'Two-way sync (newest change wins)',
};

export const SYNC_MODE_DESCRIPTION: Record<SyncMode, string> = {
  local_authoritative:
    'Issues are edited here and pushed to GitLab. Edits made directly in GitLab are imported and reported as conflicts rather than silently discarded.',
  gitlab_authoritative:
    'Issues are edited in GitLab and pulled in here. Edits made here are pushed to GitLab immediately so GitLab stays canonical.',
  bidirectional:
    'Both sides accept writes. The most recent edit wins; if both changed since the last sync the conflict is recorded for review.',
};

/** Which side of a sync a given issue's data currently mirrors. */
export const ISSUE_SYNC_STATES = [
  'synced',
  'pending_push',
  'pending_pull',
  'conflict',
  'local_only',
  'gitlab_only',
  'error',
] as const;
export type IssueSyncState = (typeof ISSUE_SYNC_STATES)[number];

export interface GitLabConnection {
  id: GitLabConnectionId;
  projectId: ProjectId;
  /** Base URL of the GitLab instance, e.g. `https://gitlab.example.com`. */
  baseUrl: string;
  /** Numeric or namespaced path of the GitLab project. */
  gitlabProjectPath: string;
  /** Never returned to clients; stored encrypted at rest. */
  accessTokenEncrypted: string;
  /** Which side wins when both changed. */
  syncMode: SyncMode;
  enabled: boolean;
  /** Mirror parent/child nesting into GitLab child issues. */
  syncHierarchy: boolean;
  /** Mirror local comments to GitLab issue notes. */
  syncComments: boolean;
  /** Mirror labels both ways. */
  syncLabels: boolean;
  /** Create a matching GitLab issue for every local incident. */
  syncIncidents: boolean;
  /** Path prefix applied to mirrored GitLab issue titles. */
  titlePrefix: string;
  lastSyncAt: IsoDateTime | null;
  lastSyncStatus: 'never' | 'ok' | 'error' | 'running';
  lastSyncError: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Connection shape safe to send to a browser. */
export type GitLabConnectionPublic = Omit<GitLabConnection, 'accessTokenEncrypted'> & {
  hasToken: boolean;
  /** Token hint such as `glpat-****abcd` so users can confirm which token. */
  tokenHint: string | null;
};

/** How a remote GitLab field maps onto a local issue. */
export const FIELD_MAP = {
  title: 'title',
  description: 'description',
  state: 'state',
  priority: 'priority',
  labels: 'labels',
  assignee: 'assignee',
  dueDate: 'dueDate',
} as const;
export type FieldKey = keyof typeof FIELD_MAP;

export const FIELD_MAP_VALUES = Object.values(FIELD_MAP) as string[];

/** One recorded disagreement between local and GitLab state. */
export interface SyncConflict {
  id: number;
  connectionId: GitLabConnectionId;
  issueId: IssueId;
  localIssueKey: string;
  field: string;
  localValue: string | null;
  gitlabValue: string | null;
  localUpdatedAt: IsoDateTime;
  gitlabUpdatedAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
  resolution: 'kept_local' | 'kept_gitlab' | 'merged' | null;
  createdAt: IsoDateTime;
}

export interface SyncRun {
  id: number;
  connectionId: GitLabConnectionId;
  direction: 'push' | 'pull' | 'full';
  trigger: 'manual' | 'webhook' | 'schedule' | 'issue_change';
  status: 'running' | 'ok' | 'error';
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
  message: string | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

/**
 * Provenance recorded on every imported issue, so a later sync can tell an
 * imported field from a locally edited one.
 */
export interface ExternalLink {
  provider: 'gitlab';
  connectionId: GitLabConnectionId;
  issueId: IssueId;
  externalId: string;
  externalKey: string;
  externalUrl: string;
  lastPushedHash: string | null;
  lastPulledAt: IsoDateTime | null;
  lastPushedAt: IsoDateTime | null;
  remoteUpdatedAt: IsoDateTime | null;
  syncState: IssueSyncState;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const baseUrlSchema = z
  .string()
  .trim()
  .url('must be an absolute URL')
  .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u), {
    message: 'must use https, except for localhost during development',
  })
  .refine((u) => !u.endsWith('/'), { message: 'must not end with a trailing slash' });

export const testConnectionSchema = z.object({
  baseUrl: baseUrlSchema,
  accessToken: z.string().trim().min(8).max(512),
  /** Optional: verify this specific project is reachable. */
  gitlabProjectPath: z.string().trim().min(1).max(300).optional(),
});

export const createConnectionSchema = z.object({
  baseUrl: baseUrlSchema,
  accessToken: z.string().trim().min(8).max(512),
  gitlabProjectPath: z.string().trim().min(1).max(300),
  syncMode: z.enum(SYNC_MODES).default('bidirectional'),
  enabled: z.boolean().default(true),
  syncHierarchy: z.boolean().default(true),
  syncComments: z.boolean().default(true),
  syncLabels: z.boolean().default(true),
  syncIncidents: z.boolean().default(false),
  titlePrefix: z.string().max(32).default(''),
});

export const updateConnectionSchema = createConnectionSchema
  .partial()
  .omit({ accessToken: true })
  .extend({ accessToken: z.string().trim().min(8).max(512).optional() });

export const triggerSyncSchema = z.object({
  direction: z.enum(['push', 'pull', 'full']).default('full'),
});

export const resolveConflictSchema = z.object({
  resolution: z.enum(['kept_local', 'kept_gitlab', 'merged']),
  /** For `merged`, the value to write back. */
  mergedValue: z.string().max(50_000).optional(),
});

/** Minimal subset of the GitLab API surface the adapter relies on. */
export interface GitLabIssuePayload {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  due_date: string | null;
  weight: number | null;
  author: { id: number; name: string; username: string };
  assignees: Array<{ id: number; name: string; username: string }>;
  web_url: string;
  /** Present when the issue was created as a child of another. */
  task_completion_status?: { count: number; completed_count: number };
}

export interface GitLabProjectPayload {
  id: number;
  path_with_namespace: string;
  name: string;
  web_url: string;
  default_branch: string | null;
  visibility: string;
  issues_enabled: boolean;
}
