/**
 * Notification fan-out.
 *
 * Events are published through `notify()`, which resolves the audience
 * (assignee, reporter, watchers, mentioned users), respects per-user
 * preferences, writes in-app rows and queues email into the durable outbox.
 * Delivery is deliberately decoupled from recording so a slow or failing SMTP
 * server never blocks the request that triggered the notification.
 */

import type { Notification, NotificationEvent } from '@tracker/shared';
import type { Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';

export interface NotifyInput {
  event: NotificationEvent;
  title: string;
  body?: string;
  issueId?: number | null;
  projectId?: number | null;
  /** Explicit recipients; merged with the resolved audience. */
  userIds?: number[];
  /** Explicit exclusions, e.g. the user who caused the event. */
  excludeUserIds?: number[];
  payload?: Record<string, unknown>;
  /** Restrict the resolved audience to project members. */
  projectMembersOnly?: boolean;
}

export interface NotificationRecipient {
  userId: number;
  reason: 'assignee' | 'reporter' | 'watcher' | 'mention' | 'explicit';
}

export interface NotifyResult {
  inAppCreated: number;
  emailsQueued: number;
  recipients: NotificationRecipient[];
}

export class NotificationService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }
  /**
   * Resolve who should hear about an event. The audience depends on the event:
   * a status change reaches the assignee and watchers, a comment reaches
   * watchers and previous participants, a mention always reaches the user.
   */
  private resolveAudience(input: NotifyInput): NotificationRecipient[] {
    const map = new Map<number, NotificationRecipient>();
    const add = (userId: number | null | undefined, reason: NotificationRecipient['reason']): void => {
      if (userId === null || userId === undefined) return;
      // Keep the first, most specific reason for display purposes.
      if (!map.has(userId)) map.set(userId, { userId, reason });
    };

    if (input.issueId) {
      const issue = this.db.get<{
        assignee_id: number | null;
        reporter_id: number | null;
        project_id: number;
      }>('SELECT assignee_id, reporter_id, project_id FROM issues WHERE id = ?', [input.issueId]);

      add(issue?.assignee_id, 'assignee');
      add(issue?.reporter_id, 'reporter');

      for (const row of this.db.all<{ user_id: number }>(
        'SELECT user_id FROM watchers WHERE issue_id = ?',
        [input.issueId],
      )) {
        add(row.user_id, 'watcher');
      }

      // Anyone already in the conversation has a stake in new comments.
      for (const row of this.db.all<{ author_id: number | null }>(
        'SELECT DISTINCT author_id FROM comments WHERE issue_id = ? AND author_id IS NOT NULL',
        [input.issueId],
      )) {
        add(row.author_id, 'watcher');
      }

      for (const row of this.db.all<{ user_id: number }>(
        'SELECT user_id FROM comment_mentions WHERE comment_id IN (SELECT id FROM comments WHERE issue_id = ?)',
        [input.issueId],
      )) {
        add(row.user_id, 'mention');
      }
    }

    for (const userId of input.userIds ?? []) add(userId, 'explicit');

    const excluded = new Set(input.excludeUserIds ?? []);
    for (const userId of excluded) map.delete(userId);

    // Inactive accounts never receive notifications.
    const recipients = [...map.values()].filter((recipient) => {
      const user = this.db.get<{ is_active: number }>('SELECT is_active FROM users WHERE id = ?', [
        recipient.userId,
      ]);
      return user !== undefined && Number(user.is_active) === 1;
    });

    if (input.projectMembersOnly && input.projectId) {
      const members = new Set(
        this.db
          .all<{ user_id: number }>('SELECT user_id FROM project_members WHERE project_id = ?', [
            input.projectId,
          ])
          .map((row) => row.user_id),
      );
      return recipients.filter((recipient) => members.has(recipient.userId));
    }

    return recipients;
  }

  /**
   * Record the event for every recipient. Returns counts so the caller can log
   * delivery without re-querying.
   */
  notify(input: NotifyInput, options: { excludeUserIds?: number[] } = {}): NotifyResult {
    const exclude = new Set([...(input.excludeUserIds ?? []), ...(options.excludeUserIds ?? [])]);
    const recipients = this
      .resolveAudience(input)
      .filter((recipient) => !exclude.has(recipient.userId));

    let inAppCreated = 0;
    let emailsQueued = 0;

    this.db.transaction(() => {
      for (const recipient of recipients) {
        const preference = this.db.get<{ in_app: number; email: number }>(
          'SELECT in_app, email FROM notification_preferences WHERE user_id = ? AND event = ?',
          [recipient.userId, input.event],
        );

        const wantsInApp = preference ? Number(preference.in_app) === 1 : true;
        const wantsEmail = preference ? Number(preference.email) === 1 : false;

        if (wantsInApp) {
          this.db.run(
            `INSERT INTO notifications (user_id, event, issue_id, title, body, payload)
             VALUES (?,?,?,?,?,?)`,
            [
              recipient.userId,
              input.event,
              input.issueId ?? null,
              input.title,
              input.body ?? '',
              JSON.stringify(input.payload ?? {}),
            ],
          );
          inAppCreated += 1;
        }

        if (wantsEmail) {
          const user = this.db.get<{ email: string; display_name: string; email_opt_out: number }>(
            'SELECT email, display_name, email_opt_out FROM users WHERE id = ?',
            [recipient.userId],
          );
          // A global opt-out overrides an event-level email preference.
          if (user && Number(user.email_opt_out) === 0) {
            this.db.run(
              `INSERT INTO email_outbox (to_email, to_name, subject, body_text)
               VALUES (?,?,?,?)`,
              [user.email, user.display_name, input.title, input.body ?? input.title],
            );
            emailsQueued += 1;
          }
        }
      }
    });

    return { inAppCreated, emailsQueued, recipients };
  }

  /** Unread notifications for a user, newest first. */
  listForUser(
    userId: number,
    options: { limit?: number; unreadOnly?: boolean } = {},
  ): { notifications: Notification[]; unreadCount: number } {
    const clauses = ['user_id = ?'];
    const params: Array<string | number> = [userId];

    if (options.unreadOnly) clauses.push('read_at IS NULL');

    const where = `WHERE ${clauses.join(' AND ')}`;
    const unreadCount = Number(
      this.db.scalar<number>(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL`, [
        userId,
      ]) ?? 0,
    );

    const limit = Math.min(options.limit ?? 50, 200);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    );

    return { notifications: rows.map((row) => this.mapRow(row)), unreadCount };
  }

  markRead(userId: number, notificationIds: number[], readAt = nowIso()): number {
    if (notificationIds.length === 0) return 0;
    const result = this.db.run(
      `UPDATE notifications SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL AND id IN (${notificationIds.map(() => '?').join(', ')})`,
      [readAt, userId, ...notificationIds],
    );
    return result.changes;
  }

  markAllRead(userId: number, readAt = nowIso()): number {
    return this.db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [
      readAt,
      userId,
    ]).changes;
  }

  setPreference(userId: number, event: NotificationEvent, inApp: boolean, email: boolean): void {
    this.db.run(
      `INSERT INTO notification_preferences (user_id, event, in_app, email)
       VALUES (?,?,?,?)
       ON CONFLICT (user_id, event) DO UPDATE SET in_app = excluded.in_app, email = excluded.email`,
      [userId, event, inApp ? 1 : 0, email ? 1 : 0],
    );
  }

  listPreferences(userId: number): Array<{ event: NotificationEvent; inApp: boolean; email: boolean }> {
    return this.db
      .all<{ event: string; in_app: number; email: number }>(
        'SELECT event, in_app, email FROM notification_preferences WHERE user_id = ?',
        [userId],
      )
      .map((row) => ({
        event: row.event as NotificationEvent,
        inApp: Number(row.in_app) === 1,
        email: Number(row.email) === 1,
      }));
  }

  private mapRow(row: Record<string, unknown>): Notification {
    let payload: Record<string, unknown> = {};
    if (typeof row.payload === 'string') {
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }

    return {
      id: Number(row.id),
      userId: Number(row.user_id) as Notification['userId'],
      event: String(row.event) as NotificationEvent,
      issueId: row.issue_id === null ? null : (Number(row.issue_id) as Notification['issueId']),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      payload,
      readAt: row.read_at === null ? null : String(row.read_at),
      createdAt: String(row.created_at ?? ''),
    };
  }
}
