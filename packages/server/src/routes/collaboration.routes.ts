/**
 * Standalone comment, attachment, notification and admin routes.
 */

import { auditQuerySchema, updateCommentSchema, updateNotificationPreferenceSchema, NOTIFICATION_EVENTS } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { badRequest, notFound } from '../errors.ts';
import { parseId } from '../services/context.ts';
import { requireAuth, requirePermission } from '../plugins/auth.plugin.ts';

export const commentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.patch('/api/comments/:commentId', async (request) => {
    const commentId = parseId((request.params as { commentId: string }).commentId, 'comment');
    const body = updateCommentSchema.parse(request.body);
    const ctx = requireAuth(request);

    const comment = ctx.services.comments.getById(commentId);
    const issue = ctx.services.issues.getById(Number(comment.issueId));
    const isAuthor = Number(comment.authorId) === Number(ctx.actor.userId);

    // Authors may always edit their own comments; editing someone else's needs
    // the elevated `comment.update.any` capability.
    requirePermission(
      request,
      isAuthor ? 'comment.update.own' : 'comment.update.any',
      Number(issue.projectId),
      { isOwnerOfResource: isAuthor },
    );

    return {
      comment: ctx.services.comments.update(commentId, body.body, Number(ctx.actor.userId), ctx.auditContext),
    };
  });

  app.delete('/api/comments/:commentId', async (request) => {
    const commentId = parseId((request.params as { commentId: string }).commentId, 'comment');
    const ctx = requireAuth(request);

    const comment = ctx.services.comments.getById(commentId);
    const issue = ctx.services.issues.getById(Number(comment.issueId));
    const isAuthor = Number(comment.authorId) === Number(ctx.actor.userId);

    requirePermission(
      request,
      isAuthor ? 'comment.delete.own' : 'comment.delete.any',
      Number(issue.projectId),
      { isOwnerOfResource: isAuthor },
    );

    ctx.services.comments.remove(commentId, Number(ctx.actor.userId), ctx.auditContext);
    return { deleted: true };
  });
};

export const attachmentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/api/attachments/:id', async (request, reply) => {
    const attachmentId = parseId((request.params as { id: string }).id, 'attachment');
    const ctx = requireAuth(request);

    const attachment = ctx.services.attachments.getById(attachmentId);
    const issue = ctx.services.issues.getById(Number(attachment.issueId));
    requirePermission(request, 'issue.read', Number(issue.projectId));

    const { attachment: meta } = ctx.services.attachments.resolveDownloadPath(attachmentId);

    // `Content-Disposition: attachment` plus a sanitised name prevents a stored
    // file from ever being rendered inline in the browser.
    reply
      .header('Content-Type', meta.mimeType)
      .header('Content-Length', String(meta.sizeBytes))
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `attachment; filename="${meta.filename.replace(/["\\]/g, '')}"`,
      );

    await ctx.services.attachments.stream(attachmentId, reply.raw);
    return reply;
  });

  app.delete('/api/attachments/:id', async (request) => {
    const attachmentId = parseId((request.params as { id: string }).id, 'attachment');
    const ctx = requireAuth(request);

    const attachment = ctx.services.attachments.getById(attachmentId);
    const issue = ctx.services.issues.getById(Number(attachment.issueId));
    const isUploader = Number(attachment.uploadedBy) === Number(ctx.actor.userId);

    requirePermission(
      request,
      isUploader ? 'attachment.delete.own' : 'attachment.delete.any',
      Number(issue.projectId),
      { isOwnerOfResource: isUploader },
    );

    ctx.services.attachments.remove(attachmentId, Number(ctx.actor.userId));
    return { deleted: true };
  });
};

export const notificationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/api/notifications', async (request) => {
    const ctx = requireAuth(request);
    const query = request.query as { limit?: string; unreadOnly?: string };
    return ctx.services.notifications.listForUser(Number(ctx.actor.userId), {
      limit: query.limit ? Number(query.limit) : undefined,
      unreadOnly: query.unreadOnly === 'true',
    });
  });

  app.post('/api/notifications/read', async (request) => {
    const body = request.body as { ids?: number[] };
    if (!Array.isArray(body.ids)) throw badRequest('ids must be an array');
    const ctx = requireAuth(request);
    return { updated: ctx.services.notifications.markRead(Number(ctx.actor.userId), body.ids) };
  });

  app.post('/api/notifications/read-all', async (request) => {
    const ctx = requireAuth(request);
    return { updated: ctx.services.notifications.markAllRead(Number(ctx.actor.userId)) };
  });

  app.get('/api/notifications/preferences', async (request) => {
    const ctx = requireAuth(request);
    return {
      preferences: ctx.services.notifications.listPreferences(Number(ctx.actor.userId)),
      availableEvents: NOTIFICATION_EVENTS,
    };
  });

  app.put('/api/notifications/preferences', async (request) => {
    const body = updateNotificationPreferenceSchema.parse(request.body);
    const ctx = requireAuth(request);
    ctx.services.notifications.setPreference(
      Number(ctx.actor.userId),
      body.event,
      body.inApp ?? true,
      body.email ?? false,
    );
    return { preferences: ctx.services.notifications.listPreferences(Number(ctx.actor.userId)) };
  });
};

export const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/api/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  // -- audit trail ---------------------------------------------------------
  app.get('/api/admin/audit', async (request) => {
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.audit');

    // Fastify exposes query values as strings, so numeric filters are coerced
    // before validation rather than rejected with a 422.
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = auditQuerySchema.parse({
      ...raw,
      ...(raw['limit'] !== undefined ? { limit: Number(raw['limit']) } : {}),
      ...(raw['cursor'] !== undefined ? { cursor: Number(raw['cursor']) } : {}),
      ...(raw['actorId'] !== undefined ? { actorId: Number(raw['actorId']) } : {}),
      ...(raw['projectId'] !== undefined ? { projectId: Number(raw['projectId']) } : {}),
    });
    return ctx.services.audit.list(query);
  });

  /**
   * Recompute the audit hash chain. This is the evidence that the
   * tamper-evident trail has not been altered.
   */
  app.get('/api/admin/audit/verify', async (request) => {
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.audit');

    const query = request.query as { limit?: string; since?: string };
    return ctx.services.audit.verifyChain({
      limit: query.limit ? Number(query.limit) : undefined,
      since: query.since,
    });
  });

  // -- SSO -----------------------------------------------------------------
  app.get('/api/admin/sso', async (request) => {
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings');

    // The client secret is never returned, only whether one is configured.
    const rows = ctx.services.db.all<Record<string, unknown>>(
      'SELECT * FROM sso_configurations ORDER BY is_default DESC, name ASC',
    );
    return {
      configurations: rows.map((row) => ({
        ...row,
        client_secret_encrypted: undefined,
        hasSecret: row.client_secret_encrypted !== null && row.client_secret_encrypted !== '',
      })),
    };
  });
};

export default commentRoutes;
