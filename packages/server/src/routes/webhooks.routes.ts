/**
 * Outgoing webhook routes.
 *
 * Paths come from `API.webhooks`. The signing secret is returned exactly once,
 * in the response to the create call; every other endpoint returns only the
 * public shape.
 *
 * The auth guards are imported from the sibling `gitlab.routes.ts` rather than
 * from the auth plugin, so this module does not depend on that plugin's build
 * order. Both read the same `request.context` the plugin attaches.
 */

import { API, asProjectId } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.ts';
import { parseId } from '../services/context.ts';
import { requirePermission } from './gitlab.routes.ts';

const EVENT_NAMES = [
  'issue.created',
  'issue.updated',
  'issue.transitioned',
  'issue.deleted',
  'issue.archived',
  'comment.created',
  'gitlab.sync',
  'gitlab.conflict',
  'ping',
] as const;

const urlSchema = z
  .string()
  .trim()
  .url('must be an absolute URL')
  .max(2_000)
  .refine((value) => value.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(value), {
    message: 'must use https, except for localhost during development',
  });

const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  targetUrl: urlSchema,
  events: z.array(z.enum(EVENT_NAMES)).min(1).max(50),
  enabled: z.boolean().default(true),
});

const updateWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    targetUrl: urlSchema.optional(),
    events: z.array(z.enum(EVENT_NAMES)).min(1).max(50).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one field must be provided',
  });

function params(request: FastifyRequest): Record<string, unknown> {
  return (request.params ?? {}) as Record<string, unknown>;
}

/** Read a bounded positive integer query parameter. */
function queryInt(query: unknown, key: string, fallback: number, max: number): number {
  if (!query || typeof query !== 'object') return fallback;
  const raw = (query as Record<string, unknown>)[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw badRequest(`Query parameter "${key}" must be a positive integer`);
  }
  return Math.min(Math.trunc(parsed), max);
}

export const webhookRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get(API.webhooks.list, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.read', { projectId: asProjectId(projectId) });
    return { webhooks: ctx.services.webhooks.list(projectId) };
  });

  app.post(API.webhooks.create, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.manage', { projectId: asProjectId(projectId) });
    const body = createWebhookSchema.parse(request.body);
    return { webhook: ctx.services.webhooks.create(projectId, body, ctx) };
  });

  app.patch(API.webhooks.update, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.manage', { projectId: asProjectId(projectId) });
    const id = parseId(params(request).id, 'webhook');
    const body = updateWebhookSchema.parse(request.body);
    return { webhook: ctx.services.webhooks.update(projectId, id, body, ctx) };
  });

  app.delete(API.webhooks.remove, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.manage', { projectId: asProjectId(projectId) });
    const id = parseId(params(request).id, 'webhook');
    ctx.services.webhooks.remove(projectId, id, ctx);
    return { deleted: true };
  });

  app.get(API.webhooks.deliveries, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.read', { projectId: asProjectId(projectId) });
    const id = parseId(params(request).id, 'webhook');
    const limit = queryInt(request.query, 'limit', 50, 200);
    return { deliveries: ctx.services.webhooks.listDeliveries(projectId, id, limit) };
  });

  app.post(API.webhooks.test, async (request) => {
    const projectId = parseId(params(request).projectId, 'project');
    const ctx = requirePermission(request, 'webhook.manage', { projectId: asProjectId(projectId) });
    const id = parseId(params(request).id, 'webhook');
    return { delivery: await ctx.services.webhooks.test(projectId, id, ctx) };
  });
};

export default webhookRoutes;
