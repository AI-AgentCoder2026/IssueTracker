/**
 * Response normalisers.
 *
 * The shared package pins domain shapes but not every response *envelope*.
 * Rather than sprinkling casts through the pages, each read goes through a narrow
 * normaliser here: it accepts the bare payload or a `{ data }` wrapper and
 * returns a fully-populated type. Every function is total — a malformed payload
 * degrades to an empty list instead of throwing inside a render.
 */

import type {
  AttachmentId,
  BoardUpdate,
  CommentId,
  CommentWithAuthor,
  Dashboard,
  DashboardWidget,
  GitLabConnectionPublic,
  Issue,
  IssueLink,
  IssueState,
  IssueSummary,
  IssueTiming,
  IssueTimeline,
  MilestoneId,
  ProjectId,
  PublicUser,
  RenderedDashboard,
  RenderedWidget,
  Role,
  SearchResultPage,
  SyncMode,
  TransitionCheck,
  WidgetData,
  WidgetPosition,
  Workflow,
  WorkflowStatus,
  WorkflowTransition,
} from './types';
import {
  ACTIVITY_TYPES,
  AUTH_PROVIDERS,
  DEPENDENCY_KINDS,
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPES,
  STATUS_CATEGORIES,
  SYNC_MODES,
  WIDGET_TYPES,
  WIDGET_TYPE_LABEL,
  asIssueId,
  asProjectId,
  asUserId,
} from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys that mark an object as a domain row rather than a response envelope.
 *
 * `unwrap` is for envelopes, but a domain object is free to have a `data`
 * field of its own -- `RenderedWidget` does -- and handing that to a
 * normaliser that unwraps silently replaces the object with its payload, so
 * every field then falls back to a default. The one place that happens is
 * guarded explicitly, in `toWidget`.
 *
 * If a new domain type gains a `data` or `result` field, that guard needs
 * extending too.
 */
const ENVELOPE_KEYS = new Set(['data', 'result', 'meta', 'error', 'success', 'requestId']);

/** Peels a `{ data: ... }` / `{ result: ... }` envelope when one is present. */
export function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of ['data', 'result'] as const) {
    const inner = value[key];
    if (inner === undefined || inner === null) continue;
    // Only peel when the keys present are envelope-shaped. A row that also
    // carries `id` or `type` is the payload, not a wrapper around it.
    const isEnvelope = Object.keys(value).every((k) => ENVELOPE_KEYS.has(k));
    return isEnvelope ? inner : value;
  }
  return value;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Narrows a raw string to one of `allowed`, falling back rather than throwing. */
export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function optionalNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function optionalId<T>(value: unknown, cast: (n: number) => T): T | null {
  return value === null || value === undefined ? null : cast(num(value));
}

/** Reads a list, tolerating both `[...]` and `{ <key>: [...] }` shapes. */
export function asArray(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (key !== undefined && isRecord(value) && Array.isArray(value[key])) {
    return value[key] as unknown[];
  }
  const inner = unwrap(value);
  return Array.isArray(inner) ? inner : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function toPublicUser(value: unknown): PublicUser {
  const row = asRecord(unwrap(value));
  const username = str(row.username, 'unknown');
  return {
    id: asUserId(num(row.id)),
    username,
    email: str(row.email),
    displayName: str(row.displayName, username),
    avatarUrl: strOrNull(row.avatarUrl),
    provider: enumValue(row.provider, AUTH_PROVIDERS, 'local'),
    isInstanceAdmin: bool(row.isInstanceAdmin),
    isActive: bool(row.isActive, true),
    timezone: str(row.timezone, 'UTC'),
    locale: str(row.locale, 'en'),
    lastLoginAt: strOrNull(row.lastLoginAt),
    createdAt: str(row.createdAt),
    updatedAt: str(row.updatedAt),
  };
}

export function toRole(value: unknown): Role {
  return enumValue(
    value,
    ['owner', 'admin', 'maintainer', 'developer', 'reporter', 'viewer'] as const,
    'viewer',
  );
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function toIssueSummary(value: unknown): IssueSummary {
  const r = asRecord(value);
  return {
    id: asIssueId(num(r.id)),
    key: str(r.key),
    title: str(r.title),
    type: enumValue(r.type, ISSUE_TYPES, 'task'),
    priority: enumValue(r.priority, ISSUE_PRIORITIES, 'medium'),
    state: enumValue(r.state, ISSUE_STATES, 'open'),
    assigneeId: optionalId(r.assigneeId, asUserId),
    assigneeName: strOrNull(r.assigneeName),
    parentId: optionalId(r.parentId, asIssueId),
    dueDate: strOrNull(r.dueDate),
    position: num(r.position),
    labelIds: asArray(r.labelIds)
      .map((id) => num(id))
      .filter((id) => id > 0),
    commentCount: num(r.commentCount),
    attachmentCount: num(r.attachmentCount),
    subtaskCount: num(r.subtaskCount),
    isOverdue: bool(r.isOverdue),
    lastActivityAt: str(r.lastActivityAt),
  };
}

export function toIssue(value: unknown): Issue {
  const r = asRecord(unwrap(value));
  return {
    id: asIssueId(num(r.id)),
    key: str(r.key),
    projectId: asProjectId(num(r.projectId)),
    sequence: num(r.sequence),
    title: str(r.title),
    description: str(r.description),
    type: enumValue(r.type, ISSUE_TYPES, 'task'),
    priority: enumValue(r.priority, ISSUE_PRIORITIES, 'medium'),
    state: enumValue(r.state, ISSUE_STATES, 'open'),
    statusId: num(r.statusId),
    assigneeId: optionalId(r.assigneeId, asUserId),
    reporterId: optionalId(r.reporterId, asUserId),
    parentId: optionalId(r.parentId, asIssueId),
    dueDate: strOrNull(r.dueDate),
    startedAt: strOrNull(r.startedAt),
    resolvedAt: strOrNull(r.resolvedAt),
    closedAt: strOrNull(r.closedAt),
    estimateHours: optionalNum(r.estimateHours),
    timeSpentHours: num(r.timeSpentHours),
    position: num(r.position),
    milestoneId: optionalId(r.milestoneId, (n) => n as MilestoneId),
    archived: bool(r.archived),
    archivedAt: strOrNull(r.archivedAt),
    version: num(r.version, 1),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

export function toSearchPage(value: unknown): SearchResultPage {
  const r = asRecord(value);
  const meta = asRecord(r.meta);
  const issues = (Array.isArray(r.issues) ? r.issues : asArray(r.data, 'nodes')).map(toIssueSummary);
  const rawCursor = r.nextCursor;
  return {
    issues,
    nextCursor:
      rawCursor === null || rawCursor === undefined ? null : num(rawCursor, 0) || null,
    total: num(r.total ?? meta.totalCount ?? r.totalCount, issues.length),
    tookMs: num(r.tookMs),
    warnings: asArray(r.warnings)
      .map((w) => str(w))
      .filter((w) => w !== ''),
  };
}

export function toLink(value: unknown): IssueLink {
  const r = asRecord(value);
  return {
    id: num(r.id),
    sourceIssueId: asIssueId(num(r.sourceIssueId)),
    targetIssueId: asIssueId(num(r.targetIssueId)),
    kind: enumValue(r.kind, DEPENDENCY_KINDS, 'relates_to'),
    autoDetected: bool(r.autoDetected),
    confidence: optionalNum(r.confidence),
    createdBy: optionalId(r.createdBy, asUserId),
    createdAt: str(r.createdAt),
  };
}

export function toComment(value: unknown): CommentWithAuthor {
  const r = asRecord(unwrap(value));
  return {
    id: num(r.id) as CommentId,
    issueId: asIssueId(num(r.issueId)),
    authorId: asUserId(num(r.authorId)),
    authorName: str(r.authorName, 'Unknown'),
    authorAvatarUrl: strOrNull(r.authorAvatarUrl),
    body: str(r.body),
    isSystem: bool(r.isSystem),
    resolvesThreadId: optionalId(r.resolvesThreadId, (n) => n as CommentId),
    editedAt: strOrNull(r.editedAt),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    mentions: asArray(r.mentions).map((m) => {
      const mention = asRecord(m);
      return {
        userId: asUserId(num(mention.userId)),
        username: str(mention.username),
        displayName: str(mention.displayName),
        offset: num(mention.offset),
      };
    }),
    attachments: asArray(r.attachments).map((a) => {
      const att = asRecord(a);
      return {
        id: num(att.id) as AttachmentId,
        filename: str(att.filename),
        mimeType: str(att.mimeType),
        sizeBytes: num(att.sizeBytes),
      };
    }),
  };
}

export function toIssueTiming(value: unknown): IssueTiming {
  const r = asRecord(unwrap(value));
  return {
    createdAt: str(r.createdAt),
    startedAt: strOrNull(r.startedAt),
    resolvedAt: strOrNull(r.resolvedAt),
    closedAt: strOrNull(r.closedAt),
    dueDate: strOrNull(r.dueDate),
    timeToStartMs: optionalNum(r.timeToStartMs),
    timeInProgressMs: optionalNum(r.timeInProgressMs),
    timeToResolveMs: optionalNum(r.timeToResolveMs),
    timeToCloseMs: optionalNum(r.timeToCloseMs),
    overdueByMs: optionalNum(r.overdueByMs),
    subtaskTimeSpentHours: num(r.subtaskTimeSpentHours),
  };
}

export function toTimeline(value: unknown): IssueTimeline {
  const r = asRecord(unwrap(value));
  const timing = asRecord(r.timing);
  return {
    issueId: asIssueId(num(r.issueId)),
    events: asArray(r.events).map((e) => {
      const event = asRecord(e);
      return {
        id: num(event.id),
        issueId: asIssueId(num(event.issueId)),
        projectId: asProjectId(num(event.projectId)),
        actorId: optionalId(event.actorId, asUserId),
        type: enumValue(event.type, ACTIVITY_TYPES, 'issue.updated'),
        summary: str(event.summary),
        changes: asArray(event.changes).map((c) => {
          const change = asRecord(c);
          return { field: str(change.field), from: change.from ?? null, to: change.to ?? null };
        }),
        metadata: asRecord(event.metadata),
        isSystemGenerated: bool(event.isSystemGenerated),
        createdAt: str(event.createdAt),
      };
    }),
    timing: {
      createdAt: str(timing.createdAt),
      startedAt: strOrNull(timing.startedAt),
      resolvedAt: strOrNull(timing.resolvedAt),
      closedAt: strOrNull(timing.closedAt),
      dueDate: strOrNull(timing.dueDate),
      ageMs: num(timing.ageMs),
      timeToStartMs: optionalNum(timing.timeToStartMs),
      timeInProgressMs: optionalNum(timing.timeInProgressMs),
      timeToResolveMs: optionalNum(timing.timeToResolveMs),
      timeToCloseMs: optionalNum(timing.timeToCloseMs),
      overdueByMs: optionalNum(timing.overdueByMs),
      totalLoggedHours: num(timing.totalLoggedHours),
    },
  };
}

export function toTransition(value: unknown): WorkflowTransition {
  const r = asRecord(value);
  return {
    id: num(r.id) as WorkflowTransition['id'],
    workflowId: num(r.workflowId),
    fromStatusId: optionalId(r.fromStatusId, (n) => n as WorkflowStatus['id']),
    toStatusId: num(r.toStatusId) as WorkflowStatus['id'],
    name: str(r.name),
    description: str(r.description),
    requiredPermission: strOrNull(r.requiredPermission),
  };
}

export function toTransitionCheck(value: unknown): TransitionCheck {
  const r = asRecord(unwrap(value));
  const available = asArray(r.available ?? r.transitions).map(toTransition);
  return {
    allowed: bool(r.allowed, available.length > 0),
    reason: str(r.reason),
    transition: r.transition === null || r.transition === undefined ? null : toTransition(r.transition),
    available,
  };
}

export function toStatus(value: unknown): WorkflowStatus {
  const r = asRecord(value);
  return {
    id: num(r.id) as WorkflowStatus['id'],
    workflowId: num(r.workflowId),
    projectId: asProjectId(num(r.projectId)),
    key: str(r.key),
    name: str(r.name),
    state: enumValue<IssueState>(r.state, ISSUE_STATES, 'open'),
    category: enumValue(r.category, STATUS_CATEGORIES, 'unstarted'),
    color: str(r.color, '#64748b'),
    description: str(r.description),
    position: num(r.position),
    isResolution: bool(r.isResolution),
    isClosed: bool(r.isClosed),
    isDone: bool(r.isDone),
    wipLimit: optionalNum(r.wipLimit),
  };
}

export function toWorkflow(value: unknown): Workflow {
  const r = asRecord(unwrap(value));
  const statuses = asArray(r.statuses).map(toStatus);
  return {
    id: num(r.id),
    projectId: asProjectId(num(r.projectId)),
    name: str(r.name, 'Workflow'),
    description: str(r.description),
    isDefault: bool(r.isDefault),
    statuses: statuses.sort((a, b) => a.position - b.position),
    transitions: asArray(r.transitions).map(toTransition),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * `BoardUpdate` is the shape the WebSocket also sends, so the HTTP fetch and the
 * live event share one reader and stay in sync.
 */
export function toBoardUpdate(value: unknown, projectId: ProjectId): BoardUpdate {
  const r = asRecord(value);
  const columns = asArray(r.columns)
    .map((column) => {
      const c = asRecord(column);
      return {
        statusId: num(c.statusId ?? c.id),
        key: str(c.key),
        name: str(c.name),
        color: str(c.color, '#64748b'),
        wipLimit: optionalNum(c.wipLimit),
        issues: asArray(c.issues).map(toIssueSummary),
      };
    })
    .sort((a, b) => a.statusId - b.statusId);
  return {
    projectId: asProjectId(num(r.projectId, projectId)),
    workflowId: num(r.workflowId),
    columns,
    removedIssueIds: asArray(r.removedIssueIds).map((id) => asIssueId(num(id))),
  };
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

/**
 * Widget payloads are rendered from `WidgetData` alone; the server decides which
 * of the six kinds each widget produces. The grid additionally depends on
 * `type` (for the label) and `position` (for the CSS grid), so both are
 * validated here rather than cast through.
 */
export function toWidgetData(value: unknown): WidgetData {
  const r = asRecord(value);
  const kind = enumValue(r.kind, ['table', 'bar', 'line', 'stat', 'list', 'empty'] as const, 'empty');
  switch (kind) {
    case 'table': {
      const columns = asArray(r.columns)
        .map((c) => str(c))
        .filter((c) => c !== '');
      const rows = asArray(r.rows).map((row) => asRecord(row));
      return { kind: 'table', columns, rows, total: num(r.total, rows.length) };
    }
    case 'bar':
      return {
        kind: 'bar',
        series: asArray(r.series).map((s) => {
          const series = asRecord(s);
          return {
            label: str(series.label),
            value: num(series.value),
            color: strOrNull(series.color) ?? undefined,
          };
        }),
      };
    case 'line':
      return {
        kind: 'line',
        points: asArray(r.points).map((p) => {
          const point = asRecord(p);
          return { label: str(point.label), value: optionalNum(point.value) };
        }),
      };
    case 'stat':
      return {
        kind: 'stat',
        value: typeof r.value === 'number' ? r.value : str(r.value),
        label: str(r.label),
        delta: optionalNum(r.delta) ?? undefined,
      };
    case 'list':
      return {
        kind: 'list',
        items: asArray(r.items).map((i) => {
          const item = asRecord(i);
          return {
            id: str(item.id),
            title: str(item.title),
            subtitle: strOrNull(item.subtitle) ?? undefined,
            href: strOrNull(item.href) ?? undefined,
            tone: strOrNull(item.tone) ?? undefined,
          };
        }),
      };
    case 'empty':
      return { kind: 'empty', reason: str(r.reason, 'Nothing to show for this widget yet.') };
  }
}

function toWidgetPosition(value: unknown): WidgetPosition {
  const p = asRecord(value);
  return {
    x: num(p.x),
    y: num(p.y),
    w: Math.max(1, num(p.w, 4)),
    h: Math.max(1, num(p.h, 3)),
  };
}

export function toWidget(value: unknown): DashboardWidget {
  const w = asRecord(unwrap(value));
  return {
    id: num(w.id),
    dashboardId: num(w.dashboardId) as Dashboard['id'],
    type: enumValue(w.type, WIDGET_TYPES, 'issue_list'),
    title: str(w.title, WIDGET_TYPE_LABEL.issue_list),
    position: toWidgetPosition(w.position),
    filters: asRecord(w.filters),
    limit: num(w.limit, 10),
    hiddenFromRoles: asArray(w.hiddenFromRoles).map(toRole),
  };
}

export function toRenderedWidget(value: unknown): RenderedWidget {
  const w = asRecord(unwrap(value));
  return { ...toWidget(w), data: toWidgetData(w.data) };
}

export function toDashboard(value: unknown): Dashboard {
  const r = asRecord(unwrap(value));
  return {
    id: num(r.id) as Dashboard['id'],
    projectId: optionalId(r.projectId, asProjectId),
    name: str(r.name, 'Dashboard'),
    description: str(r.description),
    roles: asArray(r.roles).map(toRole),
    isDefault: bool(r.isDefault),
    widgets: asArray(r.widgets).map(toWidget),
    createdBy: optionalId(r.createdBy, asUserId),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

export function toRenderedDashboard(value: unknown): RenderedDashboard {
  const base = toDashboard(value);
  const r = asRecord(unwrap(value));
  return { ...base, widgets: asArray(r.widgets).map(toRenderedWidget) };
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export function toGitLabConnection(value: unknown): GitLabConnectionPublic | null {  if (value === null || value === undefined) return null;
  const r = asRecord(value);
  if (Object.keys(r).length === 0) return null;
  if (r.connection !== undefined) return toGitLabConnection(r.connection);
  return {
    id: num(r.id) as GitLabConnectionPublic['id'],
    projectId: asProjectId(num(r.projectId)),
    baseUrl: str(r.baseUrl),
    gitlabProjectPath: str(r.gitlabProjectPath),
    syncMode: enumValue<SyncMode>(r.syncMode, SYNC_MODES, 'bidirectional'),
    enabled: bool(r.enabled, true),
    syncHierarchy: bool(r.syncHierarchy, true),
    syncComments: bool(r.syncComments, true),
    syncLabels: bool(r.syncLabels, true),
    syncIncidents: bool(r.syncIncidents),
    titlePrefix: str(r.titlePrefix),
    lastSyncAt: strOrNull(r.lastSyncAt),
    lastSyncStatus: enumValue(
      r.lastSyncStatus,
      ['never', 'ok', 'error', 'running'] as const,
      'never',
    ),
    lastSyncError: strOrNull(r.lastSyncError),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    hasToken: bool(r.hasToken),
    tokenHint: strOrNull(r.tokenHint),
  };
}
