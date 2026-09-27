/**
 * Types available to the web client.
 *
 * Domain shapes come from `@tracker/shared` and are re-exported unchanged so a
 * page never redefines a server contract. The handful of extra types below cover
 * request bodies the shared package does not model and purely client-side
 * structures; they are deliberately narrow.
 */

import type {
  DependencyKind,
  GuestToken,
  Membership,
  Notification,
  Role,
  User,
  WidgetPosition,
} from '@tracker/shared';

export type {
  // ids
  AttachmentId,
  CommentId,
  DashboardId,
  IssueId,
  LabelId,
  MilestoneId,
  ProjectId,
  StatusId,
  UserId,
} from '@tracker/shared';
export type { Role } from '@tracker/shared';
export type { ActivityEvent, IssueTimeline } from '@tracker/shared';
export type { GuestToken, User } from '@tracker/shared';
export type {
  CommentWithAuthor,
  Mention,
  Notification,
  NotificationEvent,
} from '@tracker/shared';
export type {
  Dashboard,
  DashboardWidget,
  RenderedDashboard,
  RenderedWidget,
  WidgetData,
  WidgetPosition,
  WidgetType,
} from '@tracker/shared';
export type {
  DependencyKind,
  Issue,
  IssueAttachment,
  IssueLink,
  IssuePriority,
  IssueState,
  IssueSummary,
  IssueTiming,
  IssueType,
} from '@tracker/shared';
export type { SearchResultPage } from '@tracker/shared';
export type {
  GitLabConnectionPublic,
  SyncConflict,
  SyncMode,
  SyncRun,
} from '@tracker/shared';
export type {
  BoardUpdate,
  PresenceEntry,
  ServerEvent,
  ServerMessage,
} from '@tracker/shared';
export type { ErrorCode, FieldError, Label, Project, ProjectVisibility } from '@tracker/shared';
export type { TransitionCheck, Workflow, WorkflowStatus, WorkflowTransition } from '@tracker/shared';
export type { StatusCategory } from '@tracker/shared';
export type { ClientMessage } from '@tracker/shared';

export {
  ACTIVITY_LABEL,
  ACTIVITY_TYPES,
  API,
  AUTH_PROVIDERS,
  DEFAULT_STATUSES,
  DEPENDENCY_KINDS,
  DASHBOARD_TEMPLATES,
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPE_LABEL,
  ISSUE_TYPES,
  MENTION_PATTERN,
  NOTIFICATION_EVENTS,
  PRESENCE_HEARTBEAT_MS,
  PRIORITY_LABEL,
  PRIORITY_RANK,
  ROLES,
  ROLE_RANK,
  STATE_COLOR_HINT,
  STATUS_CATEGORIES,
  SYNC_MODES,
  SYNC_MODE_DESCRIPTION,
  SYNC_MODE_LABEL,
  TERMINAL_STATES,
  WIDGET_TYPES,
  WIDGET_TYPE_LABEL,
  WS_PATH,
  asIssueId,
  asProjectId,
  asUserId,
  can,
  extractMentionUsernames,
  fill,
  isTerminalState,
  roleAtLeast,
} from '@tracker/shared';

/** The signed-in user as the API returns it: `User` without `passwordHash`. */
export type PublicUser = Omit<User, 'passwordHash'>;

/** A project member joined with the user record, as the members page needs it. */
export interface MemberView extends Membership {
  user: PublicUser;
}

/** Body of `POST /api/projects/:projectId/board/move`. */
export interface BoardMoveInput {
  issueId: number;
  toStatusId: number;
  /** Fractional position between the two neighbouring cards. */
  position: number;
  /** Optimistic-concurrency guard; the server rejects stale moves with 409. */
  expectedVersion?: number;
}

/** Body of `POST /api/dashboards/:id/widgets/reorder`. */
export interface WidgetReorderInput {
  widgets: Array<{ id: number; position: WidgetPosition }>;
}

/** Body of `POST /api/projects/:projectId/members`. */
export interface AddMemberInput {
  usernameOrEmail: string;
  role: Role;
}

/** Body of `POST /api/issues/:issueId/links`. */
export interface CreateLinkInput {
  kind: DependencyKind;
  targetIssueId: number;
}

/** Body of `POST /api/projects/:projectId/guest-tokens`. */
export interface CreateGuestTokenInput {
  issueId: number | null;
  label: string;
  role: 'viewer' | 'reporter';
  canComment: boolean;
  expiresAt: string;
  maxUses: number | null;
}

/**
 * Server responses whose exact envelope is not pinned by the shared package.
 * The client reads them through a narrow normaliser rather than assuming a
 * wrapper, so a `{ data }` envelope and a bare payload both work.
 */
export interface GuestTokenCreated {
  token: GuestToken;
  /** Plaintext guest link, returned exactly once. */
  tokenValue: string | null;
}

/** UI-only: a notification list plus its unread counter, as the bell needs. */
export interface NotificationFeed {
  notifications: Notification[];
  unreadCount: number;
}
