/**
 * Comment service: rich-text (Markdown) comment logs, `@mention` extraction and
 * notification fan-out.
 *
 * Mentions are the subtle part. A mention is only actionable if the username
 * exists *and* the user can actually see the issue, so resolution and audience
 * are computed together: an unknown `@name` stays as literal text and an
 * invisible user is silently skipped rather than leaking their name.
 */

import {
  extractMentionUsernames,
  type Comment,
  type CommentWithAuthor,
  type CreateCommentInput,
  type Mention,
} from '@tracker/shared';
import { badRequest, notFound } from '../errors.ts';
import { placeholders, type Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';
import type { Services } from './context.ts';

export interface CreateCommentContext {
  ipAddress?: string;
  userAgent?: string;
  /** Marks the comment as machine-generated (transitions, sync results). */
  isSystemGenerated?: boolean;
  /** Skip notification fan-out, for bulk imports. */
  silent?: boolean;
}

export class CommentService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }
  private get db(): Database {
    return this.services.db;
  }

  /**
   * Post a comment.
   *
   * The insert, the mention rows and the watcher registration share one
   * transaction, so a comment can never exist with its mentions missing.
   */
  create(
    issueId: number,
    input: CreateCommentInput,
    actorId: number,
    ctx: CreateCommentContext = {},
  ): CommentWithAuthor {
    const issue = this.db.get<{ id: number; project_id: number; key: string; title: string }>(
      'SELECT id, project_id, key, title FROM issues WHERE id = ?',
      [issueId],
    );
    if (!issue) throw notFound('Issue', issueId);

    const comment = this.db.transaction(() => {
      const id = Number(
        this.db.run(
          `INSERT INTO comments (issue_id, author_id, body, is_system, resolves_thread_id)
           VALUES (?,?,?,?,?)`,
          [issueId, actorId, input.body, ctx.isSystemGenerated ? 1 : 0, input.resolvesThreadId ?? null],
        ).lastInsertRowid,
      );

      // Mentions, then attach any supplied attachment ids to this comment.
      const mentions = this.resolveMentions(input.body, Number(issue.project_id));
      for (const mention of mentions) {
        this.db.run(
          'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?,?)',
          [id, Number(mention.userId)],
        );
      }

      if (input.attachmentIds && input.attachmentIds.length > 0) {
        for (const attachmentId of input.attachmentIds) {
          this.db.run(
            'UPDATE attachments SET comment_id = ? WHERE id = ? AND issue_id = ? AND comment_id IS NULL',
            [id, attachmentId, issueId],
          );
        }
      }

      // Posting implies interest, unless the comment is machine-generated.
      if (!ctx.isSystemGenerated) {
        this.db.run('INSERT OR IGNORE INTO watchers (issue_id, user_id) VALUES (?,?)', [issueId, actorId]);
      }

      return this.getById(id);
    });

    this.services.activity.record({
      issueId,
      projectId: Number(issue.project_id),
      actorId,
      type: ctx.isSystemGenerated ? 'comment.created' : 'comment.created',
      summary: ctx.isSystemGenerated ? 'added a system note' : 'commented',
      metadata: { commentId: comment.id },
    });

    this.services.audit.record(
      {
        action: 'comment.created',
        entityType: 'comment',
        entityId: comment.id,
        projectId: Number(issue.project_id),
        actorId,
        after: { issueId, length: input.body.length, isSystem: ctx.isSystemGenerated ?? false },
      },
      ctx,
    );

    if (!ctx.silent && !ctx.isSystemGenerated) {
      // Mentioned users are notified explicitly; the rest of the audience
      // (assignee, reporter, watchers) is resolved by the notification service.
      this.services.notifications.notify(
        {
          event: 'comment.reply',
          title: `New comment on ${issue.key}`,
          body: excerpt(input.body),
          issueId,
          projectId: Number(issue.project_id),
          userIds: comment.mentions.map((mention) => Number(mention.userId)),
          excludeUserIds: [actorId],
        },
        { excludeUserIds: [actorId] },
      );

      for (const mention of comment.mentions) {
        this.services.notifications.notify(
          {
            event: 'issue.mentioned',
            title: `${mention.displayName} mentioned you on ${issue.key}`,
            body: excerpt(input.body),
            issueId,
            projectId: Number(issue.project_id),
            userIds: [Number(mention.userId)],
            excludeUserIds: [actorId],
          },
          { excludeUserIds: [actorId] },
        );
      }
    }

    this.services.realtime.publish({
      event: 'comment.created',
      projectId: Number(issue.project_id),
      issueId,
      data: { comment },
    });

    // Keep the issue's `updated_at` moving so "recently updated" ordering
    // reflects new conversation.
    this.db.run('UPDATE issues SET updated_at = ? WHERE id = ?', [nowIso(), issueId]);

    return comment;
  }

  /**
   * Resolve `@username` mentions to real users who can see the issue.
   *
   * Returns an empty list rather than throwing when nothing matches, so a
   * comment mentioning a non-existent user still posts.
   */
  private resolveMentions(body: string, projectId: number): Mention[] {
    const usernames = extractMentionUsernames(body);
    if (usernames.length === 0) return [];

    // A mention is only actionable if the account is active and the user can
    // actually see the project: an instance admin, a project member, or the
    // project's creator. Anyone else is left as literal text in the body.
    const rows = this.db.all<{ id: number; username: string; display_name: string }>(
      `SELECT u.id, u.username, u.display_name
       FROM users u
       WHERE u.is_active = 1
         AND lower(u.username) IN (${usernames.map(() => '?').join(', ')})
         AND (
           u.instance_role = 'admin'
           OR EXISTS (
             SELECT 1 FROM project_members m
             WHERE m.user_id = u.id AND m.project_id = ?
           )
           OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.id = ? AND p.created_by = u.id
           )
         )`,
      [...usernames.map((name) => name.toLowerCase()), projectId, projectId],
    );

    const byUsername = new Map(rows.map((row) => [String(row.username).toLowerCase(), row]));
    const mentions: Mention[] = [];

    for (const username of usernames) {
      const row = byUsername.get(username.toLowerCase());
      if (!row) continue;
      mentions.push({
        userId: Number(row.id) as Mention['userId'],
        username: String(row.username),
        displayName: String(row.display_name),
        // Offset is approximate; the UI highlights by matching the token text
        // rather than by byte position.
        offset: body.toLowerCase().indexOf(`@${username.toLowerCase()}`),
      });
    }

    return mentions;
  }

  getById(commentId: number): CommentWithAuthor {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c LEFT JOIN users u ON u.id = c.author_id
       WHERE c.id = ?`,
      [commentId],
    );
    if (!row) throw notFound('Comment', commentId);
    // Mentions and attachments are part of the declared type, so they are
    // resolved here too, not only by listForIssue. A caller that posts a comment
    // and reads the response should see the same shape as one that lists them.
    return this.hydrateBatch([row])[0] as CommentWithAuthor;
  }

  /**
   * Comments for an issue, oldest first, with authors, mentions and
   * attachments resolved in two extra queries rather than per comment.
   */
  listForIssue(
    issueId: number,
    options: { limit?: number; since?: string } = {},
  ): CommentWithAuthor[] {
    const clauses = ['c.issue_id = ?'];
    const params: Array<string | number> = [issueId];
    if (options.since) {
      clauses.push('c.created_at > ?');
      params.push(options.since);
    }
    const limit = Math.min(options.limit ?? 500, 1000);

    const rows = this.db.all<Record<string, unknown>>(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c LEFT JOIN users u ON u.id = c.author_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?`,
      [...params, limit],
    );

    return this.hydrateBatch(rows);
  }

  /**
   * Edit a comment. Only the author may edit, and the original text is
   * replaced wholesale — comments are a log, not a collaborative document, so
   * an edit is visible via `edited_at` and the activity trail.
   */
  update(
    commentId: number,
    body: string,
    actorId: number,
    ctx: CreateCommentContext = {},
  ): CommentWithAuthor {
    const before = this.getById(commentId);
    if (Number(before.authorId) !== actorId) {
      throw badRequest('Only the author can edit a comment');
    }
    if (Number(before.isSystem) === 1) {
      throw badRequest('System comments cannot be edited');
    }

    const at = nowIso();
    const comment = this.db.transaction(() => {
      this.db.run('UPDATE comments SET body = ?, edited_at = ?, updated_at = ? WHERE id = ?', [
        body,
        at,
        at,
        commentId,
      ]);
      // Mentions are recomputed; someone may have been added or removed.
      this.db.run('DELETE FROM comment_mentions WHERE comment_id = ?', [commentId]);
      const projectId = this.db.scalar<number>('SELECT project_id FROM issues WHERE id = ?', [before.issueId]);
      for (const mention of this.resolveMentions(body, Number(projectId))) {
        this.db.run('INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?,?)', [
          commentId,
          Number(mention.userId),
        ]);
      }
      return this.getById(commentId);
    });

    this.services.activity.record({
      issueId: before.issueId,
      projectId: Number(
        this.db.scalar<number>('SELECT project_id FROM issues WHERE id = ?', [before.issueId]),
      ),
      actorId,
      type: 'comment.edited',
      summary: 'edited a comment',
      metadata: { commentId },
    });

    this.services.audit.record(
      {
        action: 'comment.created',
        entityType: 'comment',
        entityId: commentId,
        before: { body: excerpt(before.body) },
        after: { body: excerpt(body) },
      },
      ctx,
    );

    this.services.realtime.publish({
      event: 'comment.updated',
      issueId: before.issueId,
      data: { comment },
    });

    return comment;
  }

  remove(commentId: number, actorId: number, ctx: CreateCommentContext = {}): void {
    const comment = this.getById(commentId);
    const projectId = Number(
      this.db.scalar<number>('SELECT project_id FROM issues WHERE id = ?', [comment.issueId]),
    );

    this.db.run('DELETE FROM comments WHERE id = ?', [commentId]);

    this.services.activity.record({
      issueId: comment.issueId,
      projectId,
      actorId,
      type: 'comment.deleted',
      summary: 'deleted a comment',
      metadata: { commentId },
    });

    this.services.audit.record(
      {
        action: 'comment.deleted',
        entityType: 'comment',
        entityId: commentId,
        projectId,
        actorId,
        before: { body: excerpt(comment.body), authorId: comment.authorId },
      },
      ctx,
    );

    this.services.realtime.publish({
      event: 'comment.deleted',
      projectId,
      issueId: comment.issueId,
      data: { commentId },
    });
  }

  /** Mentions of a user across all issues, newest first. */
  mentionsFor(userId: number, limit = 50): Array<{ comment: CommentWithAuthor; issueKey: string }> {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT c.*, u.username, u.display_name, u.avatar_url, i.key AS issue_key
       FROM comment_mentions m
       JOIN comments c ON c.id = m.comment_id
       JOIN issues i ON i.id = c.issue_id
       LEFT JOIN users u ON u.id = c.author_id
       WHERE m.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ?`,
      [userId, Math.min(limit, 200)],
    );
    return rows.map((row) => ({ comment: this.hydrate(row), issueKey: String(row.issue_key ?? '') }));
  }

  /**
   * Fill in mentions and attachments for a batch of comment rows.
   *
   * Shared by `getById` and `listForIssue` so a single comment and a page of
   * them are hydrated identically - a caller that posts a comment and reads
   * the response gets the same shape as one that lists them.
   */
  private hydrateBatch(rows: Record<string, unknown>[]): CommentWithAuthor[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => Number(row.id));
    // Bound placeholders rather than an inlined id list: the values stay
    // parameters, so the bind count always matches the placeholder count.
    const idSlots = placeholders(ids.length);


    const mentionsByComment = new Map<number, Mention[]>();
    for (const row of this.db.all<Record<string, unknown>>(
      `SELECT m.comment_id, u.id, u.username, u.display_name
       FROM comment_mentions m JOIN users u ON u.id = m.user_id
       WHERE m.comment_id IN (${idSlots})`,
      ids,
    )) {
      const commentId = Number(row.comment_id);
      const list = mentionsByComment.get(commentId) ?? [];
      list.push({
        userId: Number(row.id) as Mention['userId'],
        username: String(row.username),
        displayName: String(row.display_name),
        offset: 0,
      });
      mentionsByComment.set(commentId, list);
    }

    const attachmentsByComment = new Map<
      number,
      Array<{ id: number; filename: string; mimeType: string; sizeBytes: number }>
    >();
    for (const row of this.db.all<Record<string, unknown>>(
      `SELECT id, comment_id, filename, mime_type, size_bytes
       FROM attachments WHERE comment_id IN (${idSlots}) ORDER BY id ASC`,
      ids,
    )) {
      const commentId = Number(row.comment_id);
      const list = attachmentsByComment.get(commentId) ?? [];
      list.push({
        id: Number(row.id),
        filename: String(row.filename),
        mimeType: String(row.mime_type),
        sizeBytes: Number(row.size_bytes),
      });
      attachmentsByComment.set(commentId, list);
    }

    return rows.map((row) => {
      const id = Number(row.id);
      const hydrated = this.hydrate(row);
      return {
        ...hydrated,
        mentions: mentionsByComment.get(id) ?? [],
        attachments: attachmentsByComment.get(id) ?? [],
      };
    });
  }

  private hydrate(row: Record<string, unknown>): CommentWithAuthor {
    return {
      id: Number(row.id) as Comment['id'],
      issueId: Number(row.issue_id) as Comment['issueId'],
      authorId: row.author_id === null ? null : (Number(row.author_id) as Comment['authorId']),
      body: String(row.body ?? ''),
      isSystem: Number(row.is_system) === 1,
      resolvesThreadId:
        row.resolves_thread_id === null ? null : (Number(row.resolves_thread_id) as Comment['resolvesThreadId']),
      editedAt: row.edited_at === null ? null : String(row.edited_at),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      authorName: row.display_name === null ? 'Deleted user' : String(row.display_name),
      authorAvatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
      mentions: [],
      attachments: [],
    };
  }
}

/** First line of a comment, trimmed, for notification bodies. */
function excerpt(body: string, max = 140): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
