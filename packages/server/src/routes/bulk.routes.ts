/**
 * Bulk-edit routes.
 *
 * `POST /api/issues/bulk` and `POST /api/issues/bulk/preview` sit next to the
 * `GET /api/issues/search` static routes; Fastify prefers a static segment over
 * `:issueId`, and the search plugin (search.routes.ts) is registered first by
 * `app.ts` anyway, so `/api/issues/bulk` is never swallowed by an issue route.
 *
 * The preview endpoint is the one the confirmation dialog calls: it reports what
 * would change without writing a single row.
 */

import type { Permission } from '@tracker/shared';
import { API, asProjectId, bulkEditSchema, can } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { forbidden, unauthenticated } from '../errors.ts';
import type { RequestContext } from '../services/context.ts';

// `any` is used deliberately and only here: the auth plugin (owned by another
// module) augments `FastifyRequest` with `context`, and that augmentation is not
// visible to this file yet. Everything downstream of `authed()` is typed.
function authed(request: any): RequestContext {
  if (!request.context) throw unauthenticated();
  return request.context as RequestContext;
}

function allow(ctx: RequestContext, permission: Permission, projectId?: number) {
  // `AccessContext.projectId` is a branded `ProjectId`, so a raw route param is
  // cast once here rather than at every call site.
  const decision = can(ctx.actor, permission, projectId ? { projectId: asProjectId(projectId) } : {});
  if (!decision.allowed) throw forbidden(decision.reason);
}

function bodyBag(request: any): Record<string, unknown> {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export const bulkRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * Apply operations to many issues. Requires `issue.bulkEdit`; the per-issue
   * check inside the service is what actually decides, because one batch can
   * span projects with different roles.
   */
  app.post(API.bulk.apply, async (request) => {
    const ctx = authed(request);
    const body = bulkEditSchema.parse(bodyBag(request));
    allow(ctx, 'issue.bulkEdit');
    return ctx.services.bulk.apply(body.issueIds, body.operations, ctx.actor, ctx, {
      continueOnError: body.continueOnError,
      ref: ctx.requestId,
    });
  });

  /**
   * Dry run for the confirmation dialog: how many issues each operation would
   * change. Writes nothing. The path is a literal because `API.bulk` has no
   * preview constant — it is kept adjacent to `API.bulk.edit` so the two are
   * obviously the same feature.
   */
  app.post('/api/issues/bulk/preview', async (request) => {
    const ctx = authed(request);
    const body = bulkEditSchema.parse(bodyBag(request));
    allow(ctx, 'issue.bulkEdit');
    return ctx.services.bulk.preview(body.issueIds, body.operations, ctx.actor);
  });
};

export default bulkRoutes;
