/**
 * Comments, mentions, notifications and watchers.
 */

import { z } from 'zod';
import type { AttachmentId, CommentId, IssueId, IsoDateTime, UserId } from './ids.ts';

/** Comment bodies are stored as Markdown; HTML is derived on render. */
export interface Comment {
  id: CommentId;
  issueId: IssueId;
  /** Null for a system comment, or once the author's account is removed. */
  authorId: UserId | null;
  /** Markdown source. */
  body: string;
  /** Set when this comment is an automated system message. */
  isSystem: boolean;
  /** Present when the comment is a partial update of a previous one. */
  resolvesThreadId: CommentId | null;
  editedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CommentWithAuthor extends Comment {
  authorName: string;
  authorAvatarUrl: string | null;
  mentions: Mention[];
  attachments: Array<{
    id: AttachmentId;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

/** A `@username` reference extracted from a comment body. */
export interface Mention {
  userId: UserId;
  username: string;
  displayName: string;
  /** Byte offset of the mention within the raw body. */
  offset: number;
}

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
  attachmentIds: z.array(z.number().int().positive()).max(20).optional(),
  /** Marks the parent comment as resolved. */
  resolvesThreadId: z.number().int().positive().nullable().optional(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
});

/** Matches `@username` where username is 2-40 word chars. */
export const MENTION_PATTERN = /(^|[^\w`])@([a-zA-Z0-9][a-zA-Z0-9._-]{1,39})\b/g;

export function extractMentionUsernames(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[2];
    if (name) found.add(name);
  }
  return [...found];
}

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  'issue.assigned',
  'issue.unassigned',
  'issue.status_changed',
  'issue.mentioned',
  'issue.comment_added',
  'issue.due_soon',
  'issue.overdue',
  'issue.sla_breach',
  'issue.created',
  'issue.priority_changed',
  'issue.blocked',
  'issue.resolved',
  'issue.closed',
  'comment.reply',
  'gitlab.sync_conflict',
  'gitlab.sync_failed',
  'guest.invited',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface Notification {
  id: number;
  userId: UserId;
  event: NotificationEvent;
  issueId: IssueId | null;
  /** Human-readable rendered payload. */
  title: string;
  body: string;
  payload: Record<string, unknown>;
  readAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

/** Per-user delivery preferences. Absent channel means "use default". */
export interface NotificationPreference {
  userId: UserId;
  event: NotificationEvent;
  inApp: boolean;
  email: boolean;
}

export const updateNotificationPreferenceSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
});

/**
 * A queued email awaiting delivery. The outbox pattern lets a failed SMTP
 * connection retry without losing the notification.
 */
export interface EmailOutboxEntry {
  id: number;
  toEmail: string;
  toName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: IsoDateTime;
  sentAt: IsoDateTime | null;
}

export const MUTABLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // SVG is deliberately absent. It is a script-execution vector: an uploaded
  // one opened from disk runs in a file:// origin, and rendering it inline
  // would run it here. Screenshots can be uploaded as PNG or WebP.
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'text/x-log',
  'application/octet-stream',
  // Video feedback recorded in the browser. This is a data allow-list, not a
  // security control: the real controls are the size limit, the signature
  // check and the download route's own disposition decision.
  'video/webm',
  'video/mp4',
  'video/ogg',
]);

/** Magic-byte prefixes; guards against a renamed executable being uploaded. */
export const MIME_SIGNATURES: ReadonlyArray<[string, number[]]> = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
];
