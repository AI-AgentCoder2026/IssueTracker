/**
 * Typed endpoint wrappers. One function per operation the UI performs; every
 * path is filled from `API` in `@tracker/shared` and every response passes
 * through `api/normalize.ts` before it reaches a component.
 */

import type {
  BranchImportResult,
  BranchLinkRule,
  CreateReferenceInput,
  CreateRepositoryInput,
  IssueLinkageSummary,
  IssueReference,
  IssueReferenceView,
  PasskeyAttachment,
  PasskeyAuthenticationResponse,
  PasskeyListResponse,
  PasskeyRegistrationResponse,
  UpdateReferenceInput,
  Repository,
} from '@tracker/shared';

import { API, fill, http, type QueryParams } from './client';
import {
  passkeyAuthenticationResponseSchema,
  passkeyRegistrationResponseSchema,
} from '@tracker/shared';
import {
  asArray,
  asRecord,
  bool,
  isRecord,
  num,
  str,
  strOrNull,
  toBoardUpdate,
  toComment,
  toDashboard,
  toGitLabConnection,
  toIssue,
  toIssueSummary,
  toIssueTiming,
  toLink,
  toPublicUser,
  toRenderedDashboard,
  toRole,
  toSearchPage,
  toStatus,
  toTimeline,
  toTransitionCheck,
  toWorkflow,
  unwrap,
} from './normalize';
import type {
  AddMemberInput,
  BoardMoveInput,
  CommentWithAuthor,
  CreateGuestTokenInput,
  CreateLinkInput,
  Dashboard,
  GitLabConnectionPublic,
  GuestToken,
  GuestTokenCreated,
  Issue,
  IssueAttachment,
  IssueLink,
  IssueSummary,
  IssueTiming,
  IssueTimeline,
  Label,
  MemberView,
  Notification,
  NotificationEvent,
  NotificationFeed,
  PublicUser,
  RenderedDashboard,
  Role,
  SearchResultPage,
  SyncConflict,
  SyncMode,
  SyncRun,
  TransitionCheck,
  WidgetReorderInput,
  Workflow,
  WorkflowStatus,
  WorkflowTransition,
  Project,
  ProjectVisibility,
  IssueType,
  IssuePriority,
  DependencyKind,
  IssueState,
  StatusCategory,
  ProjectId,
  IssueId,
} from './types';

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

function toProject(value: unknown): Project {
  const r = asRecord(unwrap(value));
  const visibility = str(r.visibility, 'private');
  return {
    id: r.id as Project['id'],
    key: str(r.key),
    name: str(r.name),
    description: str(r.description),
    visibility: (visibility === 'public' || visibility === 'internal'
      ? visibility
      : 'private') as ProjectVisibility,
    defaultIssueType: str(r.defaultIssueType, 'task') as IssueType,
    defaultPriority: str(r.defaultPriority, 'medium') as IssuePriority,
    nextIssueNumber: num(r.nextIssueNumber, 1),
    sourceOfTruth: r.sourceOfTruth === 'gitlab' ? 'gitlab' : 'local',
    archivePolicy: isRecord(r.archivePolicy)
      ? {
          enabled: bool(r.archivePolicy.enabled),
          inactiveDays: num(r.archivePolicy.inactiveDays, 365),
          requireCommentWithinDays:
            r.archivePolicy.requireCommentWithinDays === null ||
            r.archivePolicy.requireCommentWithinDays === undefined
              ? null
              : num(r.archivePolicy.requireCommentWithinDays),
        }
      : null,
    createdBy: r.createdBy === null || r.createdBy === undefined ? null : (num(r.createdBy) as never),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

function toLabel(value: unknown): Label {
  const r = asRecord(unwrap(value));
  return {
    id: num(r.id),
    projectId: r.projectId === null || r.projectId === undefined ? null : (num(r.projectId) as never),
    name: str(r.name),
    slug: str(r.slug),
    color: str(r.color, '#64748b'),
    description: str(r.description),
    createdAt: str(r.createdAt),
  };
}

function toAttachment(value: unknown): IssueAttachment {
  const r = asRecord(unwrap(value));
  return {
    id: num(r.id) as never,
    issueId: num(r.issueId) as IssueId,
    commentId: r.commentId === null || r.commentId === undefined ? null : (num(r.commentId) as never),
    filename: str(r.filename),
    storedName: str(r.storedName, str(r.filename)),
    mimeType: str(r.mimeType, 'application/octet-stream'),
    sizeBytes: num(r.sizeBytes),
    checksum: str(r.checksum),
    uploadedBy: num(r.uploadedBy) as never,
    createdAt: str(r.createdAt),
  };
}

function toSyncRun(value: unknown): SyncRun {
  const r = asRecord(value);
  return {
    id: num(r.id),
    connectionId: num(r.connectionId) as never,
    direction: r.direction === 'push' || r.direction === 'pull' ? r.direction : 'full',
    trigger: (['manual', 'webhook', 'schedule', 'issue_change'] as const).find((t) => t === r.trigger) ?? 'manual',
    status: r.status === 'ok' || r.status === 'error' ? r.status : 'running',
    pushed: num(r.pushed),
    pulled: num(r.pulled),
    conflicts: num(r.conflicts),
    failed: num(r.failed),
    message: strOrNull(r.message),
    startedAt: str(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
  };
}

function toSyncConflict(value: unknown): SyncConflict {
  const r = asRecord(value);
  const resolution = r.resolution;
  return {
    id: num(r.id),
    connectionId: num(r.connectionId) as never,
    issueId: num(r.issueId) as IssueId,
    localIssueKey: str(r.localIssueKey),
    field: str(r.field),
    localValue: strOrNull(r.localValue),
    gitlabValue: strOrNull(r.gitlabValue),
    localUpdatedAt: str(r.localUpdatedAt),
    gitlabUpdatedAt: str(r.gitlabUpdatedAt),
    resolvedAt: strOrNull(r.resolvedAt),
    resolution:
      resolution === 'kept_local' || resolution === 'kept_gitlab' || resolution === 'merged'
        ? resolution
        : null,
    createdAt: str(r.createdAt),
  };
}

function toNotification(value: unknown): Notification {
  const r = asRecord(value);
  const event = str(r.event, 'issue.updated');
  return {
    id: num(r.id),
    userId: num(r.userId) as never,
    event: event as NotificationEvent,
    issueId: r.issueId === null || r.issueId === undefined ? null : (num(r.issueId) as IssueId),
    title: str(r.title),
    body: str(r.body),
    payload: asRecord(r.payload),
    readAt: strOrNull(r.readAt),
    createdAt: str(r.createdAt),
  };
}

function toGuestToken(value: unknown): GuestToken {
  const r = asRecord(value);
  return {
    id: num(r.id),
    projectId: num(r.projectId) as ProjectId,
    issueId: r.issueId === null || r.issueId === undefined ? null : num(r.issueId),
    label: str(r.label),
    // The server must not return the hash; a masked placeholder is used instead
    // so a mistake upstream can never surface a credential in the DOM.
    tokenHash: '',
    role: toRole(r.role),
    canComment: bool(r.canComment),
    expiresAt: str(r.expiresAt),
    maxUses: r.maxUses === null || r.maxUses === undefined ? null : num(r.maxUses),
    useCount: num(r.useCount),
    revokedAt: strOrNull(r.revokedAt),
    createdBy: num(r.createdBy) as never,
    createdAt: str(r.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthResponse {
  user: PublicUser;
  /** Opaque session id; the server also sets it as an httpOnly cookie. */
  sessionId: string | null;
}

function toAuthResponse(raw: unknown): AuthResponse {
  const r = asRecord(unwrap(raw));
  const session = asRecord(r.session);
  return {
    user: toPublicUser(r.user ?? raw),
    sessionId: strOrNull(r.sessionId ?? session.id),
  };
}

export const authApi = {
  login: (login: string, password: string): Promise<AuthResponse> =>
    http.post<unknown>(API.auth.login, { login, password }).then(toAuthResponse),
  register: (input: {
    username: string;
    email: string;
    displayName: string;
    password: string;
  }): Promise<AuthResponse> => http.post<unknown>(API.auth.register, input).then(toAuthResponse),
  logout: () => http.post<unknown>(API.auth.logout),
  me: (): Promise<PublicUser> =>
    http.get<unknown>(API.auth.me).then((raw) => {
      const r = asRecord(unwrap(raw));
      return toPublicUser(r.user ?? raw);
    }),
  redeemGuestToken: (token: string): Promise<AuthResponse> =>
    http.post<unknown>(API.auth.guestRedeem, { token }).then(toAuthResponse),

  /** Profile fields the account page may change. */
  updateProfile: (patch: {
    displayName?: string;
    timezone?: string;
    locale?: string;
  }): Promise<PublicUser> =>
    http.patch<unknown>(API.auth.me, patch).then((raw) => {
      const r = asRecord(unwrap(raw));
      return toPublicUser(r.user ?? raw);
    }),

  changePassword: (input: { currentPassword: string; newPassword: string }): Promise<void> =>
    http.post<unknown>(API.auth.changePassword, input).then(() => undefined),
};

// ---------------------------------------------------------------------------
// Projects, members, labels
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  key: string;
  name: string;
  description: string;
  visibility: ProjectVisibility;
  defaultIssueType: IssueType;
  defaultPriority: IssuePriority;
}

export const projectApi = {
  async list(signal?: AbortSignal): Promise<Project[]> {
    const raw = await http.get<unknown>(API.projects.list, signal !== undefined ? { signal } : undefined);
    return asArray(raw, 'projects').map(toProject);
  },
  async get(projectId: ProjectId, signal?: AbortSignal): Promise<Project> {
    return toProject(
      await http.get<unknown>(fill(API.projects.get, { projectId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  async create(input: CreateProjectInput): Promise<Project> {
    return toProject(await http.post<unknown>(API.projects.create, input));
  },
  update: (projectId: ProjectId, patch: Partial<CreateProjectInput> & { sourceOfTruth?: 'local' | 'gitlab' }) =>
    http.patch<unknown>(fill(API.projects.update, { projectId }), patch),
  stats: (projectId: ProjectId) => http.get<unknown>(fill(API.projects.stats, { projectId })),

  async members(projectId: ProjectId, signal?: AbortSignal): Promise<MemberView[]> {
    const raw = await http.get<unknown>(fill(API.projects.members, { projectId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'members').map((row) => {
      const r = asRecord(row);
      const user = isRecord(r.user) ? r.user : r;
      return {
        id: num(r.id),
        projectId: (num(r.projectId, projectId as number) as ProjectId),
        userId: num(r.userId ?? user.id) as never,
        role: toRole(r.role),
        createdAt: str(r.createdAt),
        updatedAt: str(r.updatedAt),
        user: toPublicUser(user),
      };
    });
  },
  addMember: (projectId: ProjectId, input: AddMemberInput) =>
    http.post<unknown>(fill(API.projects.addMember, { projectId }), input),
  updateMember: (projectId: ProjectId, userId: number, input: { role: Role }) =>
    http.patch<unknown>(fill(API.projects.updateMember, { projectId, userId }), input),
  removeMember: (projectId: ProjectId, userId: number) =>
    http.delete<unknown>(fill(API.projects.removeMember, { projectId, userId })),

  async labels(projectId: ProjectId, signal?: AbortSignal): Promise<Label[]> {
    const raw = await http.get<unknown>(fill(API.projects.labels, { projectId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'labels').map(toLabel);
  },
  createLabel: (projectId: ProjectId, input: { name: string; color: string; description: string }) =>
    http.post<unknown>(fill(API.projects.createLabel, { projectId }), input),
  updateLabel: (projectId: ProjectId, id: number, input: { name?: string; color?: string; description?: string }) =>
    http.patch<unknown>(fill(API.projects.updateLabel, { projectId, id }), input),
  removeLabel: (projectId: ProjectId, id: number) =>
    http.delete<unknown>(fill(API.projects.removeLabel, { projectId, id })),
};

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface StatusDraft {
  key: string;
  name: string;
  state: IssueState;
  category: StatusCategory;
  color: string;
  description: string;
  position: number;
  isResolution: boolean;
  isClosed: boolean;
  isDone: boolean;
  wipLimit: number | null;
}

export const workflowApi = {
  async get(projectId: ProjectId, signal?: AbortSignal): Promise<Workflow> {
    return toWorkflow(
      await http.get<unknown>(fill(API.workflow.get, { projectId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  async createStatus(projectId: ProjectId, input: StatusDraft): Promise<WorkflowStatus> {
    return toStatus(await http.post<unknown>(fill(API.workflow.createStatus, { projectId }), input));
  },
  updateStatus: (projectId: ProjectId, id: number, patch: Partial<StatusDraft>) =>
    http.patch<unknown>(fill(API.workflow.updateStatus, { projectId, id }), patch),
  removeStatus: (projectId: ProjectId, id: number) =>
    http.delete<unknown>(fill(API.workflow.removeStatus, { projectId, id })),
  createTransition: (
    projectId: ProjectId,
    input: {
      fromStatusId: number | null;
      toStatusId: number;
      name: string;
      description: string;
      requiredPermission: string | null;
    },
  ) => http.post<unknown>(fill(API.workflow.createTransition, { projectId }), input),
  removeTransition: (projectId: ProjectId, id: number) =>
    http.delete<unknown>(fill(API.workflow.removeTransition, { projectId, id })),
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface CreateIssueBody {
  title: string;
  description?: string;
  type?: IssueType;
  priority?: IssuePriority;
  statusId?: number;
  assigneeId?: number | null;
  parentId?: number | null;
  dueDate?: string | null;
  estimateHours?: number | null;
  labelIds?: number[];
}

export interface SearchFilters {
  q: string;
  states: IssueState[];
  types: IssueType[];
  priorities: IssuePriority[];
  assigneeIds: number[];
  labelIds: number[];
  dueWithin?: '1d' | '3d' | '7d' | '14d' | '30d';
  overdueOnly: boolean;
  unassignedOnly: boolean;
  sort: 'relevance' | 'created_desc' | 'created_asc' | 'updated_desc' | 'updated_asc' | 'due_asc' | 'priority_desc' | 'key_asc';
}

function searchQuery(projectId: ProjectId, filters: SearchFilters): QueryParams {
  return {
    projectId,
    q: filters.q,
    states: filters.states,
    types: filters.types,
    priorities: filters.priorities,
    assigneeIds: filters.assigneeIds,
    labelIds: filters.labelIds,
    dueWithin: filters.dueWithin,
    overdueOnly: filters.overdueOnly || undefined,
    unassignedOnly: filters.unassignedOnly || undefined,
    archived: false,
    includeDescendants: true,
    sort: filters.q.trim() === '' ? filters.sort : 'relevance',
    limit: 100,
  };
}

export const issueApi = {
  async search(
    projectId: ProjectId,
    filters: SearchFilters,
    signal?: AbortSignal,
  ): Promise<SearchResultPage> {
    const raw = await http.get<unknown>(API.issues.search, {
      query: searchQuery(projectId, filters),
      ...(signal !== undefined ? { signal } : {}),
    });
    return toSearchPage(raw);
  },

  async create(input: CreateIssueBody): Promise<Issue> {
    return toIssue(await http.post<unknown>(API.issues.create, input));
  },
  get: (issueId: IssueId, signal?: AbortSignal) =>
    http.get<unknown>(fill(API.issues.get, { issueId }), { ...(signal !== undefined ? { signal } : {}) }).then(toIssue),
  update: (issueId: IssueId, patch: Record<string, unknown>) =>
    http.patch<unknown>(fill(API.issues.update, { issueId }), patch),
  remove: (issueId: IssueId) => http.delete<unknown>(fill(API.issues.remove, { issueId })),
  transition: (issueId: IssueId, body: { toStatusId: number; comment?: string; expectedVersion?: number }) =>
    http.post<unknown>(fill(API.issues.transition, { issueId }), body),
  async availableTransitions(issueId: IssueId, signal?: AbortSignal): Promise<TransitionCheck> {
    return toTransitionCheck(
      await http.get<unknown>(fill(API.issues.availableTransitions, { issueId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  async timeline(issueId: IssueId, signal?: AbortSignal): Promise<IssueTimeline> {
    return toTimeline(
      await http.get<unknown>(fill(API.issues.timeline, { issueId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  async timing(issueId: IssueId): Promise<IssueTiming> {
    return toIssueTiming(await http.get<unknown>(fill(API.issues.timing, { issueId })));
  },
  logTime: (issueId: IssueId, body: { hours: number; note?: string }) =>
    http.post<unknown>(fill(API.issues.logTime, { issueId }), body),

  async comments(issueId: IssueId, signal?: AbortSignal): Promise<CommentWithAuthor[]> {
    const raw = await http.get<unknown>(fill(API.issues.comments, { issueId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'comments').map(toComment);
  },
  createComment: (
    issueId: IssueId,
    body: { body: string; attachmentIds?: number[]; resolvesThreadId?: number | null },
  ) => http.post<unknown>(fill(API.issues.createComment, { issueId }), body),
  updateComment: (commentId: number, body: { body: string }) =>
    http.patch<unknown>(fill(API.issues.updateComment, { commentId }), body),
  removeComment: (commentId: number) => http.delete<unknown>(fill(API.issues.removeComment, { commentId })),

  async children(issueId: IssueId, signal?: AbortSignal): Promise<IssueSummary[]> {
    const raw = await http.get<unknown>(fill(API.issues.children, { issueId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'issues').map(toIssueSummary);
  },
  async ancestors(issueId: IssueId, signal?: AbortSignal): Promise<IssueSummary[]> {
    const raw = await http.get<unknown>(fill(API.issues.ancestors, { issueId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'issues').map(toIssueSummary);
  },
  async links(issueId: IssueId, signal?: AbortSignal): Promise<IssueLink[]> {
    const raw = await http.get<unknown>(fill(API.issues.link, { issueId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'links').map(toLink);
  },
  createLink: (issueId: IssueId, input: CreateLinkInput) =>
    http.post<unknown>(fill(API.issues.link, { issueId }), input),
  unlink: (issueId: IssueId, linkId: number) =>
    http.delete<unknown>(fill(API.issues.unlink, { issueId, linkId })),

  async attachments(issueId: IssueId, signal?: AbortSignal): Promise<IssueAttachment[]> {
    const raw = await http.get<unknown>(fill(API.issues.attachments, { issueId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'attachments').map(toAttachment);
  },
  uploadAttachment: (issueId: IssueId, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<unknown>(fill(API.issues.upload, { issueId }), undefined, { form });
  },
  attachmentUrl: (attachmentId: number) => fill(API.issues.attachmentDownload, { id: attachmentId }),
  removeAttachment: (attachmentId: number) =>
    http.delete<unknown>(fill(API.issues.removeAttachment, { id: attachmentId })),

  watch: (issueId: IssueId) => http.post<unknown>(fill(API.issues.watch, { issueId })),
  unwatch: (issueId: IssueId) => http.post<unknown>(fill(API.issues.unwatch, { issueId })),
};

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export const boardApi = {
  get: (projectId: ProjectId, signal?: AbortSignal) =>
    http
      .get<unknown>(fill(API.board.get, { projectId }), signal ? { signal } : undefined)
      .then((raw) => toBoardUpdate(raw, projectId)),
  move: (projectId: ProjectId, input: BoardMoveInput) =>
    http.post<unknown>(fill(API.board.move, { projectId }), input),
};

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export const dashboardApi = {
  async visible(projectId: ProjectId, signal?: AbortSignal): Promise<Dashboard[]> {
    const raw = await http.get<unknown>(API.dashboards.visible, {
      query: { projectId },
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'dashboards').map(toDashboard);
  },
  async list(projectId: ProjectId, signal?: AbortSignal): Promise<Dashboard[]> {
    const raw = await http.get<unknown>(API.dashboards.list, {
      query: { projectId },
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'dashboards').map(toDashboard);
  },
  async render(dashboardId: number, signal?: AbortSignal): Promise<RenderedDashboard> {
    return toRenderedDashboard(
      await http.get<unknown>(fill(API.dashboards.render, { id: dashboardId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  reorder: (dashboardId: number, input: WidgetReorderInput) =>
    http.post<unknown>(fill(API.dashboards.reorder, { id: dashboardId }), input),
  create: (input: {
    name: string;
    description: string;
    projectId: ProjectId | null;
    roles: Role[];
  }) => http.post<unknown>(API.dashboards.create, input),
  update: (dashboardId: number, patch: Record<string, unknown>) =>
    http.patch<unknown>(fill(API.dashboards.update, { id: dashboardId }), patch),
  remove: (dashboardId: number) => http.delete<unknown>(fill(API.dashboards.remove, { id: dashboardId })),
  addWidget: (dashboardId: number, widget: Record<string, unknown>) =>
    http.post<unknown>(fill(API.dashboards.addWidget, { id: dashboardId }), widget),
  updateWidget: (dashboardId: number, widgetId: number, patch: Record<string, unknown>) =>
    http.patch<unknown>(fill(API.dashboards.updateWidget, { id: dashboardId, widgetId }), patch),
  removeWidget: (dashboardId: number, widgetId: number) =>
    http.delete<unknown>(fill(API.dashboards.removeWidget, { id: dashboardId, widgetId })),
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationApi = {
  async list(limit = 30, signal?: AbortSignal): Promise<NotificationFeed> {
    const raw = await http.get<unknown>(API.notifications.list, {
      query: { limit },
      ...(signal !== undefined ? { signal } : {}),
    });
    const r = asRecord(unwrap(raw));
    return {
      notifications: asArray(r.notifications ?? raw, 'notifications').map(toNotification),
      unreadCount: num(r.unreadCount),
    };
  },
  markRead: (ids: number[]) => http.post<unknown>(API.notifications.markRead, { ids }),
  markAllRead: () => http.post<unknown>(API.notifications.markAllRead),
  async preferences(): Promise<Record<string, { inApp: boolean; email: boolean }>> {
    const raw = await http.get<unknown>(API.notifications.preferences);
    const list = asArray(raw, 'preferences');
    const out: Record<string, { inApp: boolean; email: boolean }> = {};
    for (const entry of list) {
      const r = asRecord(entry);
      out[str(r.event)] = { inApp: bool(r.inApp, true), email: bool(r.email) };
    }
    return out;
  },
  setPreference: (event: NotificationEvent, inApp: boolean, email: boolean) =>
    // `PUT`, not `PATCH`: the server replaces the whole preference set, so a
    // PATCH here answered 405.
    http.put<unknown>(API.notifications.preferences, { event, inApp, email }),
};

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const gitlabApi = {
  async connection(projectId: ProjectId, signal?: AbortSignal): Promise<GitLabConnectionPublic | null> {
    // `gitlab.connections` (plural) is the read route; the singular constant
    // is the create-or-update POST, so the singular one here 404'd.
    return toGitLabConnection(
      await http.get<unknown>(fill(API.gitlab.connections, { projectId }), {
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  },
  save: (projectId: ProjectId, body: Record<string, unknown>) =>
    // PATCH, not PUT: the server patches the connection in place.
    http.patch<unknown>(fill(API.gitlab.update, { projectId }), body),
  remove: (projectId: ProjectId) => http.delete<unknown>(fill(API.gitlab.remove, { projectId })),
  test: (body: { baseUrl: string; accessToken: string; gitlabProjectPath?: string }) =>
    http.post<unknown>(API.gitlab.test, body),
  sync: (projectId: ProjectId, direction: 'push' | 'pull' | 'full') =>
    http.post<unknown>(fill(API.gitlab.sync, { projectId }), { direction }),
  async runs(projectId: ProjectId, signal?: AbortSignal): Promise<SyncRun[]> {
    const raw = await http.get<unknown>(fill(API.gitlab.runs, { projectId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'runs').map(toSyncRun);
  },
  async conflicts(projectId: ProjectId, signal?: AbortSignal): Promise<SyncConflict[]> {
    const raw = await http.get<unknown>(fill(API.gitlab.conflicts, { projectId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'conflicts').map(toSyncConflict);
  },
  resolveConflict: (conflictId: number, resolution: 'kept_local' | 'kept_gitlab' | 'merged', mergedValue?: string) =>
    http.post<unknown>(fill(API.gitlab.resolveConflict, { id: conflictId }), {
      resolution,
      ...(mergedValue === undefined ? {} : { mergedValue }),
    }),
  status: (projectId: ProjectId) => http.get<unknown>(fill(API.gitlab.status, { projectId })),
};

// ---------------------------------------------------------------------------
// Users & guest tokens
// ---------------------------------------------------------------------------

export const userApi = {
  async list(query?: { q?: string; limit?: number; signal?: AbortSignal }): Promise<PublicUser[]> {
    const raw = await http.get<unknown>(API.users.list, {
      query: { q: query?.q, limit: query?.limit ?? 20 },
      ...(query?.signal !== undefined ? { signal: query.signal } : {}),
    });
    return asArray(raw, 'users').map(toPublicUser);
  },

  async guestTokens(projectId: ProjectId, signal?: AbortSignal): Promise<GuestToken[]> {
    const raw = await http.get<unknown>(fill(API.users.guestTokens, { projectId }), {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'guestTokens').map(toGuestToken);
  },
  async createGuestToken(
    projectId: ProjectId,
    input: CreateGuestTokenInput,
  ): Promise<GuestTokenCreated> {
    const raw = asRecord(
      await http.post<unknown>(fill(API.users.createGuestToken, { projectId }), input),
    );
    const token = toGuestToken(raw.token ?? raw);
    const tokenValue = strOrNull(raw.tokenValue ?? raw.plaintextToken ?? raw.value);
    return { token, tokenValue };
  },
  revokeGuestToken: (projectId: ProjectId, id: number) =>
    http.delete<unknown>(fill(API.users.revokeGuestToken, { projectId, id })),
};

// ---------------------------------------------------------------------------
// Workflow transition reader used by the issue detail page
// ---------------------------------------------------------------------------

export async function fetchTransitions(issueId: IssueId): Promise<TransitionCheck> {
  return issueApi.availableTransitions(issueId);
}


/**
 * Version-control linkage.
 *
 * Paths come from the shared `API` constants, so the client cannot drift from
 * the server. Responses go through the normalising readers because the server
 * returns snake_case-adjacent shapes that the project has learned to tolerate.
 */
export const vcsApi = {
  async repositories(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<{ repositories: Repository[]; rules: BranchLinkRule[] }> {
    const raw = await http.get<unknown>(
      fill(API.versionControl.repositories, { projectId }),
      signal !== undefined ? { signal } : undefined,
    );
    const record = asRecord(raw);
    return {
      repositories: asArray(record['repositories'], 'repositories').map((entry) =>
        toRepository(entry),
      ),
      rules: asArray(record['rules'], 'rules').map((entry) => toBranchLinkRule(entry)),
    };
  },

  async createRepository(projectId: ProjectId, input: CreateRepositoryInput): Promise<Repository> {
    const raw = await http.post<unknown>(fill(API.versionControl.createRepository, { projectId }), input);
    return toRepository(asRecord(raw));
  },

  async removeRepository(projectId: ProjectId, repositoryId: number): Promise<void> {
    await http.delete<unknown>(
      fill(API.versionControl.removeRepository, { projectId, id: repositoryId }),
    );
  },

  async references(
    issueId: IssueId,
    signal?: AbortSignal,
  ): Promise<{ references: IssueReferenceView[]; summary: IssueLinkageSummary }> {
    const raw = await http.get<unknown>(
      fill(API.issues.references, { issueId }),
      signal !== undefined ? { signal } : undefined,
    );
    const record = asRecord(raw);
    return {
      references: asArray(record['references'], 'references').map((entry) => toReferenceView(entry)),
      summary: toLinkageSummary(asRecord(record['summary'])),
    };
  },

  async addReference(issueId: IssueId, input: CreateReferenceInput): Promise<IssueReference> {
    const raw = await http.post<unknown>(fill(API.issues.addReference, { issueId }), input);
    return toReference(asRecord(raw));
  },

  async updateReference(
    issueId: IssueId,
    referenceId: number,
    patch: UpdateReferenceInput,
  ): Promise<IssueReference> {
    const raw = await http.patch<unknown>(
      fill(API.issues.updateReference, { issueId, id: referenceId }),
      patch,
    );
    return toReference(asRecord(raw));
  },

  async removeReference(issueId: IssueId, referenceId: number): Promise<void> {
    await http.delete<unknown>(fill(API.issues.removeReference, { issueId, id: referenceId }));
  },

  /**
   * Ask the server what a branch name would resolve to. Lets a developer check
   * their convention before pushing, instead of discovering it later.
   */
  async previewBranch(
    projectId: ProjectId,
    repositoryId: number,
    branch: string,
  ): Promise<{ issueKey: string | null; issue: { id: number; key: string; title: string } | null }> {
    const raw = await http.post<unknown>(
      fill(`${API.versionControl.branchRules}/preview`, { projectId, id: repositoryId }),
      { branch },
    );
    const record = asRecord(raw);
    const issue = record['issue'];
    return {
      issueKey: strOrNull(record['issueKey']),
      issue: isRecord(issue)
        ? { id: num(issue['id']), key: str(issue['key']), title: str(issue['title']) }
        : null,
    };
  },

  async importBranches(
    projectId: ProjectId,
    repositoryId: number,
    branches: Array<{ name: string; headSha?: string | null; url?: string | null }>,
  ): Promise<BranchImportResult> {
    const raw = await http.post<unknown>(
      fill(API.versionControl.importBranches, { projectId, id: repositoryId }),
      { branches },
    );
    const record = asRecord(asRecord(raw));
    return {
      scanned: num(record['scanned']),
      linked: num(record['linked']),
      updated: num(record['updated']),
      unresolved: asArray(record['unresolved'], 'unresolved').map((entry) => {
        const item = asRecord(entry);
        return { branch: str(item['branch']), issueKey: str(item['issueKey']) };
      }),
      skipped: asArray(record['skipped'], 'skipped').map((entry) => {
        const item = asRecord(entry);
        return { branch: str(item['branch']), reason: str(item['reason']) };
      }),
    };
  },
};

function toRepository(entry: unknown): Repository {
  const record = asRecord(entry);
  return {
    id: num(record['id']),
    projectId: num(record['projectId']),
    provider: str(record['provider']) as Repository['provider'],
    name: str(record['name']),
    baseUrl: str(record['baseUrl']),
    externalId: strOrNull(record['externalId']),
    defaultBranch: str(record['defaultBranch']),
    gitlabConnectionId:
      record['gitlabConnectionId'] === null || record['gitlabConnectionId'] === undefined
        ? null
        : num(record['gitlabConnectionId']),
    createdAt: str(record['createdAt']),
    updatedAt: str(record['updatedAt']),
  };
}

function toReference(entry: unknown): IssueReference {
  const record = asRecord(entry);
  return {
    id: num(record['id']),
    issueId: num(record['issueId']),
    repositoryId: num(record['repositoryId']),
    kind: str(record['kind']) as IssueReference['kind'],
    provider: str(record['provider']) as IssueReference['provider'],
    ref: str(record['ref']),
    headSha: strOrNull(record['headSha']),
    title: str(record['title']),
    state: str(record['state']) as IssueReference['state'],
    url: strOrNull(record['url']),
    autoDetected: bool(record['autoDetected']),
    linkedBy: record['linkedBy'] === null || record['linkedBy'] === undefined ? null : num(record['linkedBy']),
    createdAt: str(record['createdAt']),
    updatedAt: str(record['updatedAt']),
  };
}

function toReferenceView(entry: unknown): IssueReferenceView {
  const record = asRecord(entry);
  return {
    ...toReference(entry),
    repositoryName: str(record['repositoryName']),
    repositoryProvider: str(record['repositoryProvider']) as IssueReferenceView['repositoryProvider'],
    issueKey: str(record['issueKey']),
    issueTitle: str(record['issueTitle']),
    isMerged: bool(record['isMerged']),
  };
}

function toLinkageSummary(entry: unknown): IssueLinkageSummary {
  const record = asRecord(entry);
  const latest = record['latest'];
  return {
    issueId: num(record['issueId']),
    branches: num(record['branches']),
    commits: num(record['commits']),
    mergeRequests: num(record['mergeRequests']),
    merged: num(record['merged']),
    latest:
      isRecord(latest)
        ? {
            id: num(latest['id']),
            kind: str(latest['kind']) as IssueReference['kind'],
            ref: str(latest['ref']),
            url: strOrNull(latest['url']),
          }
        : null,
  };
}

function toBranchLinkRule(entry: unknown): BranchLinkRule {
  const record = asRecord(entry);
  return {
    id: num(record['id']),
    projectId: num(record['projectId']),
    repositoryId: num(record['repositoryId']),
    pattern: str(record['pattern']),
    stripPrefixes: asArray(record['stripPrefixes'], 'stripPrefixes').map(String),
    enabled: bool(record['enabled']),
    lastImportedAt: strOrNull(record['lastImportedAt']),
  };
}

/**
 * Passkeys.
 *
 * The ceremony is two-legged: `begin*` returns WebAuthn options plus a
 * `challengeId`, the browser asks its authenticator, and `finish*` posts the
 * JSON-ified result back. The conversion itself lives in
 * `@tracker/shared/src/passkeys.ts` because it is protocol, not presentation.
 */
export const passkeyApi = {
  async list(signal?: AbortSignal): Promise<PasskeyListResponse> {
    const raw = await http.get<unknown>(
      API.webauthn.credentials,
      signal !== undefined ? { signal } : undefined,
    );
    const record = asRecord(raw);
    return {
      credentials: asArray(record['credentials'], 'credentials').map((entry) => {
        const item = asRecord(entry);
        return {
          id: num(item['id']),
          label: str(item['label']),
          attachment: str(item['attachment']) as PasskeyAttachment,
          backedUp: bool(item['backedUp']),
          lastUsedAt: strOrNull(item['lastUsedAt']),
          createdAt: str(item['createdAt']),
        };
      }),
      currentSessionId: strOrNull(record['currentSessionId']),
    };
  },

  /** Ask the server for creation options and a challenge id. */
  async beginRegistration(label: string): Promise<{ options: unknown; challengeId: number }> {
    const raw = asRecord(
      await http.post<unknown>(API.webauthn.registerBegin, { label }),
    );
    return { options: raw['options'], challengeId: num(raw['challengeId']) };
  },

  async finishRegistration(input: {
    response: unknown;
    challengeId: number;
    label: string;
  }): Promise<PasskeyRegistrationResponse> {
    const raw = await http.post<unknown>(API.webauthn.registerFinish, input);
    const parsed = passkeyRegistrationResponseSchema.safeParse(unwrap(raw));
    if (!parsed.success) throw new Error('The server returned an unexpected passkey response');
    return parsed.data as PasskeyRegistrationResponse;
  },

  /**
   * Sign-in leg one. `username` is optional: with it, the platform prompt can
   * skip account selection; without it, any passkey for this site is offered.
   */
  async beginAuthentication(username?: string): Promise<{ options: unknown; challengeId: number }> {
    const raw = asRecord(
      await http.post<unknown>(API.webauthn.authenticateBegin, { username: username ?? null }),
    );
    return { options: raw['options'], challengeId: num(raw['challengeId']) };
  },

  /** Sign-in leg two. Establishes a session exactly like a password login. */
  async finishAuthentication(input: {
    response: unknown;
    challengeId: number;
  }): Promise<PasskeyAuthenticationResponse> {
    const raw = await http.post<unknown>(API.webauthn.authenticateFinish, input);
    const parsed = passkeyAuthenticationResponseSchema.safeParse(unwrap(raw));
    if (!parsed.success) throw new Error('The server returned an unexpected sign-in response');
    return parsed.data as PasskeyAuthenticationResponse;
  },

  async revoke(credentialId: number): Promise<void> {
    await http.delete<unknown>(fill(API.webauthn.revokeCredential, { id: credentialId }));
  },

  async revokeAll(): Promise<number> {
    const raw = asRecord(await http.post<unknown>(API.webauthn.revokeAll, {}));
    return num(raw['revoked']);
  },
};
// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** One pending duplicate pair, as the server's `listPending` reports it. */
export interface DuplicateCandidate {
  linkId: number;
  sourceIssueId: number;
  sourceKey: string;
  sourceTitle: string;
  targetIssueId: number;
  targetKey: string;
  targetTitle: string;
  /** Null when the pair matched exactly rather than by score. */
  confidence: number | null;
  createdAt: string;
}

function toDuplicateCandidate(value: unknown): DuplicateCandidate {
  const r = asRecord(value);
  const confidence = r.confidence === null || r.confidence === undefined ? null : num(r.confidence);
  return {
    linkId: num(r.linkId),
    sourceIssueId: num(r.sourceIssueId),
    sourceKey: str(r.sourceKey),
    sourceTitle: str(r.sourceTitle),
    targetIssueId: num(r.targetIssueId),
    targetKey: str(r.targetKey),
    targetTitle: str(r.targetTitle),
    confidence: confidence === null || confidence === 0 ? null : confidence,
    createdAt: str(r.createdAt),
  };
}

export const dedupeApi = {
  async candidates(projectId: ProjectId, signal?: AbortSignal): Promise<DuplicateCandidate[]> {
    const raw = await http.get<unknown>(`${fill(API.dedupe.candidates, { projectId })}?projectId=${projectId}`, {
      ...(signal !== undefined ? { signal } : {}),
    });
    return asArray(raw, 'candidates').map(toDuplicateCandidate);
  },

  /**
   * `autoLink: true` is what makes a scan useful here. Without it the server
   * compares and returns without persisting anything, so the review list would
   * stay empty and a "Run scan" button would appear to do nothing.
   */
  async scan(projectId: ProjectId, body: Record<string, unknown>): Promise<DuplicateCandidate[]> {
    const raw = await http.post<unknown>(API.dedupe.scan, {
      minConfidence: 0.6,
      ...body,
      projectId,
      autoLink: true,
    });
    return asArray(unwrap(raw), 'candidates').map(toDuplicateCandidate);
  },

  dismiss: (linkId: number) =>
    http.delete<unknown>(fill(API.dedupe.dismiss, { linkId })),
};

// ---------------------------------------------------------------------------
// Bulk editing
// ---------------------------------------------------------------------------

/** One operation, in the shape `bulkOperationSchema` expects. */
export type BulkOperationDraft = Record<string, unknown>;

export interface BulkOperationPreview {
  op: string;
  label: string;
  wouldChange: number;
  skipped: number;
  notes: string[];
}

export interface BulkPreview {
  requested: number;
  eligible: number;
  operations: BulkOperationPreview[];
}

export interface BulkResult {
  requested: number;
  succeeded: number;
  failed: number;
  results: Array<{ issueId: number; ok: boolean; error: string | null }>;
}

function toBulkPreview(value: unknown): BulkPreview {
  const r = asRecord(unwrap(value));
  return {
    requested: num(r.requested),
    eligible: num(r.eligible),
    operations: asArray(r.operations).map((entry) => {
      const op = asRecord(entry);
      return {
        op: str(op.op),
        label: str(op.label),
        wouldChange: num(op.wouldChange),
        skipped: num(op.skipped),
        notes: asArray(op.notes).map((n) => str(n)).filter((n) => n !== ''),
      };
    }),
  };
}

function toBulkResult(value: unknown): BulkResult {
  const r = asRecord(unwrap(value));
  return {
    requested: num(r.requested),
    succeeded: num(r.succeeded),
    failed: num(r.failed),
    results: asArray(r.results).map((entry) => {
      const row = asRecord(entry);
      return {
        issueId: num(row.issueId),
        ok: bool(row.ok),
        error: strOrNull(row.error),
      };
    }),
  };
}

export const bulkApi = {
  /** Dry run for the confirmation dialog. Writes nothing. */
  async preview(
    issueIds: number[],
    operations: BulkOperationDraft[],
    signal?: AbortSignal,
  ): Promise<BulkPreview> {
    return toBulkPreview(
      await http.post<unknown>(
        '/api/issues/bulk/preview',
        { issueIds, operations },
        { ...(signal !== undefined ? { signal } : {}) },
      ),
    );
  },

  async apply(
    issueIds: number[],
    operations: BulkOperationDraft[],
    continueOnError = true,
  ): Promise<BulkResult> {
    return toBulkResult(
      await http.post<unknown>(API.bulk.apply, { issueIds, operations, continueOnError }),
    );
  },
};

export type { SyncMode, WorkflowTransition, DependencyKind };
