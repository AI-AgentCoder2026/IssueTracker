/**
 * GitLab integration routes.
 *
 * Paths come from `API.gitlab` so the SPA cannot drift from the server. Two
 * plugins are exported: `gitlabRoutes` for the authenticated API surface and
 * `gitlabWebhookRoutes` for the inbound receiver, which the app registers
 * separately so it can be exempted from authentication and rate limiting.
 *
 * Auth guards
 * -----------
 * `request.context` / `request.actor` are attached by the auth plugin, which
 * another module owns. Rather than importing that plugin (coupling this file to
 * its build order), the two helpers below read the same fields through a
 * local structural view of the request and raise exactly the errors the plugin
 * would. They are exported so the sibling `webhooks.routes.ts` reuses them.
 */

import {
  API,
  asProjectId,
  can,
  createConnectionSchema,
  resolveConflictSchema,
  testConnectionSchema,
  triggerSyncSchema,
  updateConnectionSchema,
  type AccessContext,
  type Actor,
  type Permission,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, notFound, unauthenticated } from '../errors.ts';
import type { RequestContext } from '../services/context.ts';
import { parseId } from '../services/context.ts';
import { testConnection } from '../services/gitlab/client.ts';

/** Structural view of the decorated request; no dependency on the auth plugin. */
type AuthedRequestLike = {
  context?: RequestContext;
  actor?: Actor | null;
};

/** The per-request context, or 401 when the auth plugin did not run. */
export function requestContext(request: FastifyRequest): RequestContext {
  const ctx = (request as unknown as AuthedRequestLike).context;
  if (!ctx) throw unauthenticated();
  return ctx;
}

/**
 * Assert the actor holds `permission`, optionally within a project. The
 * project-less form lets an instance-wide action — testing a GitLab token —
 * pass for anyone who may administer integrations anywhere.
 */
export function requirePermission(
  request: FastifyRequest,
  permission: Permission,
  access: AccessContext = {},
): RequestContext {
  const ctx = requestContext(request);
  // `request.actor` is null for an anonymous caller; `context.actor` then holds
  // a grant-nothing actor, so both are safe to consult.
  const actor = (request as unknown as AuthedRequestLike).actor ?? ctx.actor;
  if (!actor) throw unauthenticated();
  const decision = can(actor, permission, access);
  if (!decision.allowed) throw forbidden(decision.reason);
  return ctx;
}

/** Parse and validate a JSON body with a zod schema. */
function parseBody<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  return schema.parse(request.body);
}

function params(request: FastifyRequest): Record<string, unknown> {
  return (request.params ?? {}) as Record<string, unknown>;
}

function requireProjectId(request: FastifyRequest): number {
  return parseId(params(request).projectId, 'project');
}

/** Read a positive integer query parameter, bounded. */
function queryInt(query: unknown, key: string, fallback: number, max: number): number {
  if (!query || typeof query !== 'object') return fallback;
  const raw = (query as Record<string, unknown>)[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

/** Boolean query flag; only an explicit `true`/`1` opts in. */
function queryFlag(query: unknown, key: string): boolean {
  if (!query || typeof query !== 'object') return false;
  const raw = (query as Record<string, unknown>)[key];
  return raw === 'true' || raw === '1' || raw === true;
}

export const gitlabRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- token test (nothing is persisted) --------------------------------
  app.post(API.gitlab.test, async (request) => {
    const ctx = requirePermission(request, 'gitlab.manage');
    const body = parseBody(request, testConnectionSchema);
    const result = await testConnection(ctx.services, {
      baseUrl: body.baseUrl,
      accessToken: body.accessToken,
      gitlabProjectPath: body.gitlabProjectPath,
    });
    return { ok: true, ...result };
  });

  // -- connection CRUD ---------------------------------------------------
  app.get(API.gitlab.connections, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.read', { projectId: asProjectId(projectId) });
    return { connections: ctx.services.gitlab.listConnections(projectId) };
  });

  app.post(API.gitlab.connection, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.manage', { projectId: asProjectId(projectId) });
    const body = parseBody(request, createConnectionSchema);
    return { connection: ctx.services.gitlab.createConnection(projectId, body, ctx) };
  });

  app.patch(API.gitlab.update, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.manage', { projectId: asProjectId(projectId) });
    const body = parseBody(request, updateConnectionSchema);
    return { connection: ctx.services.gitlab.updateConnection(projectId, body, ctx) };
  });

  app.delete(API.gitlab.remove, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.manage', { projectId: asProjectId(projectId) });
    ctx.services.gitlab.deleteConnection(projectId, ctx);
    return { deleted: true };
  });

  // -- sync --------------------------------------------------------------
  app.post(API.gitlab.sync, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.sync', { projectId: asProjectId(projectId) });
    const body = parseBody(request, triggerSyncSchema);

    const connection = ctx.services.gitlab.getConnection(projectId);
    if (!connection) throw notFound('GitLabConnection', projectId);

    // Awaited so the response carries the run summary. A concurrent run for
    // the same connection is refused by the service with a 409.
    const run = await ctx.services.gitlab.sync(connection.id, {
      direction: body.direction ?? 'full',
      trigger: 'manual',
      actorId: ctx.actor.userId,
    });
    return { run };
  });

  app.get(API.gitlab.runs, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.read', { projectId: asProjectId(projectId) });
    return { runs: ctx.services.gitlab.listRuns(projectId, queryInt(request.query, 'limit', 25, 200)) };
  });

  // -- conflicts ---------------------------------------------------------
  app.get(API.gitlab.conflicts, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.read', { projectId: asProjectId(projectId) });
    const unresolvedOnly = queryFlag(request.query, 'unresolved');
    return { conflicts: ctx.services.gitlab.listConflicts(projectId, { unresolvedOnly }) };
  });

  app.post(API.gitlab.resolveConflict, async (request) => {
    const conflictId = parseId(params(request).id, 'conflict');

    // The project is not in the path, so resolve it from the conflict's own
    // connection before authorising.
    const ctx = requestContext(request);
    const owner = ctx.db.get<{ project_id: number }>(
      `SELECT k.project_id AS project_id
         FROM gitlab_sync_conflicts c
         JOIN gitlab_connections k ON k.id = c.connection_id
        WHERE c.id = ?`,
      [conflictId],
    );
    if (!owner) throw notFound('SyncConflict', conflictId);
    requirePermission(request, 'gitlab.manage', { projectId: asProjectId(owner.project_id) });

    const body = parseBody(request, resolveConflictSchema);
    return { conflict: await ctx.services.gitlab.resolveConflict(conflictId, body, ctx) };
  });

  // -- status ------------------------------------------------------------
  app.get(API.gitlab.status, async (request) => {
    const projectId = requireProjectId(request);
    const ctx = requirePermission(request, 'gitlab.read', { projectId: asProjectId(projectId) });
    return ctx.services.gitlab.status(projectId);
  });
};

/**
 * The inbound GitLab receiver.
 *
 * Unauthenticated by design: the per-connection secret in the path plus
 * GitLab's `X-Gitlab-Token` header are the credentials. Rate limiting is off
 * so a retry storm is not throttled at the edge — the service de-duplicates
 * deliveries through `webhook_receipts` instead.
 */
export const gitlabWebhookRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post(API.gitlab.inbound, { config: { rateLimit: false } }, async (request) => {
    const ctx = requestContext(request);
    const secret = String(params(request).secret ?? '');
    const event = String(request.headers['x-gitlab-event'] ?? 'unknown');
    const token = request.headers['x-gitlab-token'];
    const tokenHeader = typeof token === 'string' ? token : null;

    return ctx.services.gitlab.handleInboundWebhook(
      secret,
      event,
      request.body ?? {},
      ctx,
      tokenHeader,
    );
  });
};

export default gitlabRoutes;
/**
 * The app registers the outgoing-webhook routes alongside the GitLab ones, so
 * the name is re-exported here. The implementation lives in
 * `webhooks.routes.ts`; the cycle is benign because both sides only use these
 * bindings from inside request handlers.
 */
export { webhookRoutes } from './webhooks.routes.ts';
