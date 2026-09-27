/**
 * Search, type-ahead, facets, export, duplicate-detection and archive routes.
 *
 * ============================================================================
 * ROUTE REGISTRATION ORDER — READ THIS
 * ============================================================================
 * `GET /api/issues/search` must be registered BEFORE `GET /api/issues/:issueId`.
 * The `:issueId` route belongs to the issues plugin (owned by another module) and
 * Fastify resolves overlapping static and parametric routes by **registration
 * order across plugins, in the order the plugins are registered**. If the issues
 * plugin is registered first, `GET /api/issues/search` is captured by
 * `GET /api/issues/:issueId` and this handler never runs.
 *
 * `app.ts` (owned by the integration layer) MUST therefore register this plugin
 * before the issues plugin. Fastify's `find-my-way` actually does treat a static
 * segment as more specific than a parameter in recent versions, so the ordering
 * requirement is a safety net rather than a hard dependency — but it is cheap and
 * it removes all doubt, so keep it.
 * ============================================================================
 */

import { API, can, exportRequestSchema, dedupeScanSchema, archivePolicySchema } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { asProjectId } from '@tracker/shared';
import { badRequest, forbidden, notFound, unauthenticated } from '../errors.ts';
import type { RequestContext } from '../services/context.ts';
import { parseId } from '../services/context.ts';
import { parseSearchQuery } from '../services/search.service.ts';
import { visibleProjectIds } from '../services/export.service.ts';

// `app.ts` imports `{ searchRoutes, bulkRoutes }` from this module. The bulk
// plugin lives in its own file (see the ordering note above), so it is
// re-exported here rather than duplicating its routes.
export { bulkRoutes } from './bulk.routes.ts';

// `any` is used deliberately and only here: the auth plugin (owned by another
// module) augments `FastifyRequest` with `context`, and that augmentation is not
// visible to this file yet. Everything downstream of `authed()` is typed.
function authed(request: any): RequestContext {
  if (!request.context) throw unauthenticated();
  return request.context as RequestContext;
}

function allow(ctx: RequestContext, permission: Parameters<typeof can>[1], projectId?: number) {
  // `AccessContext.projectId` is a branded `ProjectId`, so a raw route param is
  // cast once here rather than at every call site.
  const decision = can(ctx.actor, permission, projectId ? { projectId: asProjectId(projectId) } : {});
  if (!decision.allowed) throw forbidden(decision.reason);
}

/** Query bags arrive as raw strings; narrow them without trusting the shape. */
function queryBag(request: any): Record<string, unknown> {
  const query = request.query;
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return {};
  return query as Record<string, unknown>;
}

function bodyBag(request: any): Record<string, unknown> {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export const searchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- full-text search ----------------------------------------------------
  app.get(API.issues.search, async (request) => {
    const ctx = authed(request);
    allow(ctx, 'issue.read');
    const query = parseSearchQuery(queryBag(request));
    return ctx.services.search.search(query, {
      visibleProjectIds: visibleProjectIds(ctx.actor) ?? undefined,
    });
  });

  // -- type-ahead ----------------------------------------------------------
  // `API.issues.suggest` is not a shared constant, so the literal is kept next to
  // the shared paths it sits beside and documented here rather than duplicated
  // silently.
  app.get('/api/issues/search/suggest', async (request) => {
    const ctx = authed(request);
    allow(ctx, 'issue.read');
    const bag = queryBag(request);
    const text = String(bag.q ?? '');
    const limit = bag.limit === undefined ? undefined : Number(bag.limit);
    const projectId = bag.projectId === undefined ? undefined : Number(bag.projectId);
    return {
      suggestions: await ctx.services.search.suggest(text, {
        limit,
        projectId,
        visibleProjectIds: visibleProjectIds(ctx.actor) ?? undefined,
      }),
    };
  });

  // -- facet counts for the filter chips -----------------------------------
  app.get('/api/issues/search/facets', async (request) => {
    const ctx = authed(request);
    allow(ctx, 'issue.read');
    const query = parseSearchQuery(queryBag(request));
    return ctx.services.search.facets(query, {
      visibleProjectIds: visibleProjectIds(ctx.actor) ?? undefined,
    });
  });

  // -- aggregate counts (dashboard widgets) --------------------------------
  app.get('/api/issues/search/summary', async (request) => {
    const ctx = authed(request);
    allow(ctx, 'issue.read');
    const query = parseSearchQuery(queryBag(request));
    return ctx.services.search.summarise(query, {
      visibleProjectIds: visibleProjectIds(ctx.actor) ?? undefined,
    });
  });

  // ==========================================================================
  // Export
  // ==========================================================================
  app.post(API.export.run, async (request, reply) => {
    const ctx = authed(request);
    allow(ctx, 'issue.export');
    const body = exportRequestSchema.parse(bodyBag(request));
    const result = await ctx.services.export.run(body, ctx.actor, ctx);
    reply.header('Content-Type', result.contentType);
    // Always an attachment: an export is a file the user saves, never something
    // the SPA should render inline.
    reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    reply.header('Content-Length', String(Buffer.byteLength(result.body, 'utf8')));
    return reply.send(result.body);
  });

  // ==========================================================================
  // Duplicate detection
  // ==========================================================================
  app.post(API.dedupe.scan, async (request) => {
    const ctx = authed(request);
    const bag = bodyBag(request);
    const projectId =
      bag.projectId === undefined || bag.projectId === null
        ? undefined
        : parseId(bag.projectId, 'projectId');
    if (projectId !== undefined) allow(ctx, 'issue.bulkEdit', projectId);
    const input = dedupeScanSchema.parse(bag);
    const candidates = await ctx.services.dedupe.scan(input, ctx.actor, ctx);
    return { candidates, count: candidates.length };
  });

  // Auto-detected links awaiting human review.
  app.get(API.dedupe.candidates, async (request) => {
    const ctx = authed(request);
    const bag = queryBag(request);
    const projectId = parseId(bag.projectId, 'projectId');
    allow(ctx, 'issue.read', projectId);
    return { candidates: ctx.services.dedupe.listPending(projectId) };
  });

  app.delete(API.dedupe.dismiss, async (request) => {
    const ctx = authed(request);
    const linkId = parseId((request.params as Record<string, string>).linkId, 'linkId');
    const existing = ctx.db.get<{ source_issue_id: number }>(
      'SELECT source_issue_id FROM issue_links WHERE id = ?',
      [linkId],
    );
    if (!existing) throw notFound('Issue link', linkId);
    const issue = ctx.db.get<{ project_id: number }>('SELECT project_id FROM issues WHERE id = ?', [
      existing.source_issue_id,
    ]);
    if (!issue) throw notFound('Issue', existing.source_issue_id);
    allow(ctx, 'issue.link', issue.project_id);
    return ctx.services.dedupe.dismiss(linkId, ctx.actor, ctx);
  });

  // Possible duplicates for one issue (issue detail page).
  app.get(API.issues.duplicates, async (request) => {
    const ctx = authed(request);
    const params = request.params as Record<string, string>;
    const issueId = parseId(params.issueId, 'issueId');
    const bag = queryBag(request);
    const limit = bag.limit === undefined ? 10 : Math.min(Number(bag.limit), 50);
    const issue = ctx.db.get<{ project_id: number }>('SELECT project_id FROM issues WHERE id = ?', [
      issueId,
    ]);
    if (!issue) throw notFound('Issue', issueId);
    allow(ctx, 'issue.read', issue.project_id);
    return { candidates: await ctx.services.dedupe.suggestForIssue(issueId, limit) };
  });

  // ==========================================================================
  // Archive policy & scheduler
  // ==========================================================================
  app.get(API.archive.policy, async (request) => {
    const ctx = authed(request);
    const bag = queryBag(request);
    if (bag.projectId !== undefined) {
      const projectId = parseId(bag.projectId, 'projectId');
      allow(ctx, 'project.read', projectId);
      return { projectId, policy: ctx.services.archive.getPolicy(projectId) };
    }
    allow(ctx, 'issue.read');
    const visible = visibleProjectIds(ctx.actor);
    if (!visible) throw badRequest('An instance administrator must name a projectId');
    return { projectId: visible, policies: visible.map((id) => ctx.services.archive.getPolicy(id)) };
  });

  app.put(API.archive.policy, async (request) => {
    const ctx = authed(request);
    const bag = bodyBag(request);
    const projectId = parseId(bag.projectId, 'projectId');
    allow(ctx, 'project.update', projectId);
    const { projectId: _ignored, ...rest } = bag;
    const policy = archivePolicySchema.parse(rest);
    return { projectId, policy: ctx.services.archive.setPolicy(projectId, policy, ctx) };
  });

  app.get(API.archive.candidates, async (request) => {
    const ctx = authed(request);
    const bag = queryBag(request);
    const projectId = parseId(bag.projectId, 'projectId');
    allow(ctx, 'issue.read', projectId);
    return { candidates: await ctx.services.archive.candidates(projectId) };
  });

  app.post(API.archive.run, async (request) => {
    const ctx = authed(request);
    const bag = bodyBag(request);
    const projectId =
      bag.projectId === undefined || bag.projectId === null
        ? null
        : parseId(bag.projectId, 'projectId');
    if (projectId !== null) allow(ctx, 'issue.bulkEdit', projectId);
    else allow(ctx, 'instance.settings');
    return ctx.services.archive.run(projectId, ctx.actor, ctx);
  });
};

export default searchRoutes;
