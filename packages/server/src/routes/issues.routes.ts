/**
 * Issue routes.
 *
 * Note the registration order: `POST /api/issues/bulk` and `GET
 * /api/issues/search` are declared before `GET /api/issues/:issueId` so the
 * literal paths win. Fastify matches in registration order, and the bulk and
 * search plugins are registered ahead of this one in `app.ts`.
 */

import {
  API,
  can,
  createCommentSchema,
  createIssueSchema,
  transitionRequestSchema,
  updateCommentSchema,
  updateIssueSchema,
  type Permission,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { parseId, type RequestContext } from '../services/context.ts';
import { requireAuth, requirePermission } from '../plugins/auth.plugin.ts';

/**
 * Resolve the project the request targets.
 *
 * Read from the **raw** body, not the zod-parsed one: `createIssueSchema` is a
 * plain object schema, so zod strips any key it does not declare — including
 * `projectId`, which scopes the create but is not a column on the issue.
 */
function resolveProjectId(request: FastifyRequest): number {
  const raw = (request.body ?? {}) as Record<string, unknown>;
  const candidate =
    raw['projectId'] ??
    (request.params as Record<string, string> | undefined)?.['projectId'] ??
    (request.query as Record<string, unknown> | undefined)?.['projectId'];

  if (candidate === undefined) {
    throw badRequest('A projectId is required');
  }
  return parseId(candidate, 'project');
}

function ctxOf(request: FastifyRequest): RequestContext {
  return requireAuth(request);
}

export const issueRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- create ---------------------------------------------------------------
  app.post('/api/issues', async (request) => {
    // Resolve the project before parsing, because the schema strips it.
    const projectId = resolveProjectId(request);
    const body = createIssueSchema.parse(request.body);
    const ctx = requirePermission(request, 'issue.create', projectId);

    const result = await ctx.services.issues.create(
      projectId,
      body,
      Number(ctx.actor.userId),
      ctx.auditContext,
    );

    return {
      issue: result.issue,
      duplicateCandidates: result.duplicateCandidates,
    };
  });

  // -- read ----------------------------------------------------------------
  app.get('/api/issues/:issueId', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    const projectId = Number(issue.projectId);

    const decision = can(ctx.actor, 'issue.read', { projectId });
    if (!decision.allowed) throw forbidden(decision.reason);

    return {
      issue,
      summary: ctx.services.issues.summary(issueId),
      links: ctx.services.issues.links(issueId),
      ancestors: ctx.services.issues.ancestors(issueId),
      children: ctx.services.issues.children(issueId),
      isWatching: ctx.services.issues.isWatching(issueId, Number(ctx.actor.userId)),
      timing: await ctx.services.timing.computeForIssue(issueId),
      sla: ctx.services.sla.statusForIssue(issueId),
    };
  });

  app.patch('/api/issues/:issueId', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = updateIssueSchema.parse(request.body);
    const ctx = ctxOf(request);

    const existing = ctx.services.issues.getById(issueId);
    const projectId = Number(existing.projectId);
    requirePermission(request, 'issue.update', projectId);

    return { issue: ctx.services.issues.update(issueId, body, Number(ctx.actor.userId), ctx.auditContext) };
  });

  app.delete('/api/issues/:issueId', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.delete', Number(issue.projectId));

    ctx.services.issues.remove(issueId, Number(ctx.actor.userId), ctx.auditContext);
    return { deleted: true, key: issue.key };
  });

  // -- transitions ---------------------------------------------------------
  app.get('/api/issues/:issueId/transitions', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));

    return { transitions: ctx.services.issues.availableTransitions(issueId) };
  });

  app.post('/api/issues/:issueId/transition', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = transitionRequestSchema.parse(request.body);
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.transition', Number(issue.projectId));

    return { issue: ctx.services.issues.transition(issueId, body, Number(ctx.actor.userId), ctx.auditContext) };
  });

  // -- hierarchy -----------------------------------------------------------
  app.get('/api/issues/:issueId/children', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return { issues: ctx.services.issues.children(issueId) };
  });

  app.get('/api/issues/:issueId/ancestors', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return { issues: ctx.services.issues.ancestors(issueId) };
  });

  // -- links ---------------------------------------------------------------
  app.get('/api/issues/:issueId/links', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return { links: ctx.services.issues.links(issueId) };
  });

  app.post('/api/issues/:issueId/links', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = request.body as { targetIssueId?: unknown; kind?: unknown; confidence?: unknown };
    const targetIssueId = parseId(body.targetIssueId, 'target issue');
    const kind = String(body.kind ?? 'relates_to');

    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.link', Number(issue.projectId));

    return {
      link: ctx.services.issues.link(
        issueId,
        targetIssueId,
        kind as Parameters<typeof ctx.services.issues.link>[2],
        Number(ctx.actor.userId),
        ctx.auditContext,
        typeof body.confidence === 'number' ? { confidence: body.confidence } : {},
      ),
    };
  });

  app.delete('/api/issues/:issueId/links/:linkId', async (request) => {
    const params = request.params as { issueId: string; linkId: string };
    const issueId = parseId(params.issueId, 'issue');
    const linkId = parseId(params.linkId, 'link');

    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.link', Number(issue.projectId));

    ctx.services.issues.unlink(issueId, linkId, Number(ctx.actor.userId), ctx.auditContext);
    return { deleted: true };
  });

  // -- timeline & timing ---------------------------------------------------
  app.get('/api/issues/:issueId/timeline', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return ctx.services.timing.issueTimeline(issueId);
  });

  app.get('/api/issues/:issueId/timing', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return ctx.services.timing.computeForIssue(issueId);
  });

  // -- time logging --------------------------------------------------------
  app.post('/api/issues/:issueId/time', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = request.body as { hours?: unknown; comment?: unknown };
    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw badRequest('hours must be a positive number');
    }

    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.update', Number(issue.projectId));

    const updated = ctx.services.issues.update(
      issueId,
      { timeSpentHours: hours },
      Number(ctx.actor.userId),
      ctx.auditContext,
    );

    if (typeof body.comment === 'string' && body.comment.trim().length > 0) {
      ctx.services.comments.create(
        issueId,
        { body: `Logged ${hours}h: ${String(body.comment).trim()}` },
        Number(ctx.actor.userId),
        {},
      );
    }

    return { issue: updated, timing: await ctx.services.timing.computeForIssue(issueId) };
  });

  // -- watching ------------------------------------------------------------
  app.post('/api/issues/:issueId/watch', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    ctx.services.issues.watch(issueId, Number(ctx.actor.userId), ctx.auditContext);
    return { watching: true };
  });

  app.delete('/api/issues/:issueId/watch', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    ctx.services.issues.unwatch(issueId, Number(ctx.actor.userId), ctx.auditContext);
    return { watching: false };
  });

  // -- archive -------------------------------------------------------------
  app.post('/api/issues/:issueId/archive', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = request.body as { archived?: unknown };
    const archived = body.archived !== false;

    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.update', Number(issue.projectId));

    return { issue: ctx.services.issues.setArchived(issueId, archived, Number(ctx.actor.userId), ctx.auditContext) };
  });

  // NOTE: `GET /api/issues/:issueId/duplicates` is registered by
  // `searchRoutes`, which owns the dedupe surface and declares it through the
  // pinned `API.issues.duplicates` constant. Declaring it here too would
  // produce a duplicate-route error at boot.

  // -- comments (nested) ---------------------------------------------------
  app.get('/api/issues/:issueId/comments', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return { comments: ctx.services.comments.listForIssue(issueId) };
  });

  app.post('/api/issues/:issueId/comments', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const body = createCommentSchema.parse(request.body);
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);

    // A guest token may comment only when it was minted with that capability.
    if (ctx.guest) {
      if (!ctx.guest.canComment) throw forbidden('This guest link is read-only');
      if (ctx.guest.issueId !== null && ctx.guest.issueId !== issueId) {
        throw forbidden('This guest link is scoped to a different issue');
      }
    } else {
      requirePermission(request, 'comment.create', Number(issue.projectId));
    }

    return {
      comment: ctx.services.comments.create(issueId, body, Number(ctx.actor.userId), ctx.auditContext),
    };
  });

  // -- attachments ---------------------------------------------------------
  app.post(API.issues.upload, async (request, reply) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);

    if (ctx.guest) {
      if (!ctx.guest.canComment) throw forbidden('This guest link may not attach files');
      if (ctx.guest.issueId !== null && ctx.guest.issueId !== issueId) {
        throw forbidden('This guest link is scoped to a different issue');
      }
    } else {
      requirePermission(request, 'attachment.create', Number(issue.projectId));
    }

    if (!request.isMultipart()) {
      throw badRequest('An attachment must be sent as multipart/form-data with a "file" part');
    }

    const file = await request.file();
    if (!file) throw badRequest('The multipart request carried no file');

    // `fields` arrives before the file part is consumed; each entry is either
    // a plain field (which has `value`) or another file.
    const field = (name: string): string | undefined => {
      const entry = file.fields?.[name];
      const first = Array.isArray(entry) ? entry[0] : entry;
      return first && 'value' in first ? String(first.value) : undefined;
    };

    const commentIdRaw = field('commentId');
    const commentId =
      commentIdRaw === undefined ? null : parseId(commentIdRaw, 'comment');
    const declaredSize = field('size');

    // The service owns size limits, content sniffing, path resolution and the
    // SVG refusal; this route only adapts the HTTP body to its input.
    const attachment = await ctx.services.attachments.upload(
      {
        issueId,
        commentId,
        filename: file.filename,
        declaredMimeType: file.mimetype,
        stream: file.file,
        ...(declaredSize !== undefined ? { expectedSize: Number(declaredSize) } : {}),
      },
      Number(ctx.actor.userId),
    );

    return reply.code(201).send({ attachment });
  });

  app.get('/api/issues/:issueId/attachments', async (request) => {
    const issueId = parseId((request.params as { issueId: string }).issueId, 'issue');
    const ctx = ctxOf(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return { attachments: ctx.services.attachments.listForIssue(issueId) };
  });

  // NOTE: `GET /api/issues/:issueId/sla` is registered by `slaRoutes`, which
  // owns the SLA surface and declares it through the pinned
  // `API.sla.forIssue` constant.

  // NOTE: the bulk surface (`/api/issues/bulk`, `/api/issues/bulk/preview`) is
  // registered by `bulkRoutes`, which is registered *before* this plugin in
  // `app.ts` so those literal paths win against `/api/issues/:issueId`.
};

export default issueRoutes;
