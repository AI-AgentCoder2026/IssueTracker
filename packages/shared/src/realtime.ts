/**
 * Real-time channel contract shared by the WebSocket gateway and the SPA.
 */

import { z } from 'zod';
import type { IssueId, ProjectId, UserId } from './ids.ts';
import type { IssueSummary } from './issue.ts';

export const WS_PATH = '/ws';

/** Default heartbeat interval; the server prunes presence after 45s of silence. */
export const PRESENCE_HEARTBEAT_MS = 25_000;

/** Events the server pushes to clients. */
export const SERVER_EVENTS = [
  'hello',
  'pong',
  'presence',
  'issue.created',
  'issue.updated',
  'issue.transitioned',
  'issue.moved',
  'issue.deleted',
  'issue.archived',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'attachment.added',
  'board.updated',
  'notification',
  'gitlab.sync',
  'gitlab.conflict',
  'error',
] as const;
export type ServerEvent = (typeof SERVER_EVENTS)[number];

/** Messages a client may send. */
export const CLIENT_EVENTS = [
  'subscribe.project',
  'unsubscribe.project',
  'subscribe.issue',
  'unsubscribe.issue',
  'subscribe.dashboard',
  'ping',
  'presence.cursor',
] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

/** A participant editing a specific issue right now. */
export interface PresenceEntry {
  userId: UserId;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Project the user is currently viewing, when known. */
  projectId: ProjectId | null;
  /** Issue the user currently has open, when scoped. */
  issueId: IssueId | null;
  /** ISO timestamp of the client's last heartbeat. */
  lastSeenAt: string;
  /** What the user is doing, e.g. `editing description`. */
  activity: string | null;
}

export interface PresenceState {
  projectId: ProjectId | null;
  entries: PresenceEntry[];
}

export interface ServerMessage {
  event: ServerEvent;
  /** Correlates with the client message that caused it, when applicable. */
  ref?: string;
  projectId?: ProjectId;
  issueId?: IssueId;
  data?: unknown;
  at?: string;
}

export interface ClientMessage {
  event: ClientEvent;
  ref?: string;
  projectId?: ProjectId;
  issueId?: IssueId;
  activity?: string;
}

/**
 * Server frames are validated before fan-out. The envelope is strict so a
 * malformed broadcast fails loudly, while `data` stays opaque because its shape
 * depends on the event.
 */
export const serverMessageSchema = z.object({
  event: z.enum(SERVER_EVENTS),
  ref: z.string().max(64).optional(),
  projectId: z.number().int().positive().optional(),
  issueId: z.number().int().positive().optional(),
  data: z.unknown().optional(),
  at: z.string().datetime().optional(),
});

export const clientMessageSchema = z.object({
  event: z.enum(CLIENT_EVENTS),
  ref: z.string().max(64).optional(),
  projectId: z.number().int().positive().optional(),
  issueId: z.number().int().positive().optional(),
  activity: z.string().max(120).optional(),
});

/** Board payload sent after any mutation affecting column membership. */
export interface BoardUpdate {
  projectId: ProjectId;
  workflowId: number;
  /** Full column layout so a late joiner can render without another fetch. */
  columns: Array<{
    statusId: number;
    key: string;
    name: string;
    color: string;
    wipLimit: number | null;
    issues: IssueSummary[];
  }>;
  /** Issues that changed and are not present in any column. */
  removedIssueIds: IssueId[];
}
