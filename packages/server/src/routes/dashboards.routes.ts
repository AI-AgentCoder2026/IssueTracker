/**
 * Dashboard routes.
 *
 * Paths come from `API.dashboards` so the SPA cannot drift from the server.
 *
 * Auth guards
 * -----------
 * `request.context` is attached by the auth plugin that another module owns.
 * Rather than importing that plugin (coupling this file to its build order),
 * the two helpers below read the same field through a local, type-only view of
 * the request and raise exactly the errors the plugin would.
 *
 * Registration order matters: the literal `/api/dashboards/visible` is
 * registered before the parameterised `/:id` routes, because Fastify matches in
 * registration order and would otherwise capture `visible` as an id.
 */

import {
  API,
  createDashboardSchema,
  createWidgetSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  can,
  type Dashboard,
  type DashboardWidget,
  type Permission,
  type ProjectId,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, unauthenticated } from '../errors.ts';
import type { RequestContext } from '../services/context.ts';
import { parseId } from '../services/context.ts';
import type { AuditScope } from '../services/sla.service.ts';

/** Body of `POST /api/dashboards/:id/widgets/reorder`. */
const reorderSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    x: z.number().int().min(0).max(23).optional(),
    y: z.number().int().min(0).max(199).optional(),
    w: z.number().int().min(1).max(12).optional(),
    h: z.number().int().min(1).max(24).optional(),
  }),
);

/** The per-request context, or 401 when the auth plugin did not run. */
function authed(request: FastifyRequest): RequestContext {
  const ctx = request.context;
  if (!ctx) throw unauthenticated();
  return ctx;
}

/** Assert the actor holds `permission`, optionally within a project. */
function allow(ctx: RequestContext, permission: Permission, projectId?: number | null): void {
  const access = projectId === undefined || projectId === null ? {} : { projectId: projectId as ProjectId };
  const decision = can(ctx.actor, permission, access);
  if (!decision.allowed) throw forbidden(decision.reason);
}

/** The audit identity for this request, so services can attribute a change. */
function scope(ctx: RequestContext): AuditScope {
  return { ...ctx.auditContext, actorId: ctx.auditContext.actorId ?? ctx.actor.userId };
}

function params(request: FastifyRequest): Record<string, unknown> {
  return (request.params ?? {}) as Record<string, unknown>;
}

function query(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** `?projectId=` is optional: absent means "instance-wide". */
function optionalProjectId(request: FastifyRequest): number | null {
  const raw = query(request)['projectId'];
  if (raw === undefined || raw === null || raw === '') return null;
  return parseId(raw, 'project');
}

export const dashboardRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- literal path, registered before `/:id` -------------------------------

  /** The dashboards this viewer's role may open, with their widgets. */
  app.get(API.dashboards.visible, async (request) => {
    const ctx = authed(request);
    const projectId = optionalProjectId(request);
    if (projectId !== null) allow(ctx, 'dashboard.read', projectId);

    return { dashboards: ctx.services.dashboards.visibleTo(ctx.actor, projectId) };
  });

  /** Every dashboard in a project, for the settings screen. */
  app.get(API.dashboards.list, async (request) => {
    const ctx = authed(request);
    const projectId = optionalProjectId(request);
    if (projectId !== null) allow(ctx, 'dashboard.read', projectId);

    return { dashboards: ctx.services.dashboards.list(projectId) };
  });

  app.post(API.dashboards.create, async (request, reply) => {
    const ctx = authed(request);
    const body = createDashboardSchema.parse((request as { body?: unknown }).body);
    const projectId = body.projectId ?? null;
    if (projectId !== null) allow(ctx, 'dashboard.manage', projectId);

    const dashboard = ctx.services.dashboards.create({ ...body, projectId }, scope(ctx));
    return reply.code(201).send(dashboard);
  });

  // -- one dashboard -------------------------------------------------------

  app.get(API.dashboards.render, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    // Cheap membership check first; the service then enforces the role filter
    // and throws 404 so existence is not leaked to the wrong role.
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.read', existing.projectId);

    return ctx.services.dashboards.render(id, ctx.actor, scope(ctx));
  });

  app.get(API.dashboards.get, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const dashboard = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.read', dashboard.projectId);
    return dashboard;
  });

  const updateHandler = async (request: FastifyRequest): Promise<Dashboard> => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    // `widgets` is accepted here so a client can save a layout in one call; the
    // dedicated widget endpoints remain for single-widget edits.
    const body = updateDashboardSchema.parse((request as { body?: unknown }).body);
    return ctx.services.dashboards.update(id, body, scope(ctx));
  };

  app.patch(API.dashboards.update, updateHandler);
  app.put(API.dashboards.update, updateHandler);

  app.delete(API.dashboards.remove, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    ctx.services.dashboards.remove(id, scope(ctx));
    return { deleted: true, id };
  });

  // -- widgets -------------------------------------------------------------
  // `reorder` is registered before the `:widgetId` routes so a drag-and-drop
  // save is never parsed as a widget id.

  app.post(API.dashboards.reorder, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    const body = (request as { body?: unknown }).body;
    const entries = reorderSchema.parse(body);
    const widgets = ctx.services.dashboards.reorder(id, entries, scope(ctx));
    return { widgets };
  });

  app.post(API.dashboards.addWidget, async (request, reply) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    const body = createWidgetSchema.parse((request as { body?: unknown }).body);
    const widget = ctx.services.dashboards.addWidget(id, body, scope(ctx));
    return reply.code(201).send(widget);
  });

  const patchWidgetHandler = async (request: FastifyRequest): Promise<DashboardWidget> => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const widgetId = parseId(params(request)['widgetId'], 'widget');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    const body = updateWidgetSchema.parse((request as { body?: unknown }).body);
    const position = body.position;
    // The widget id travels in the path; the body copy is ignored.
    return ctx.services.dashboards.updateWidget(
      id,
      widgetId,
      {
        type: body.type,
        title: body.title,
        filters: body.filters,
        limit: body.limit,
        hiddenFromRoles: body.hiddenFromRoles,
        x: position?.x,
        y: position?.y,
        w: position?.w,
        h: position?.h,
      },
      scope(ctx),
    );
  };

  app.patch(API.dashboards.updateWidget, patchWidgetHandler);
  app.put(API.dashboards.updateWidget, patchWidgetHandler);

  app.delete(API.dashboards.removeWidget, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'dashboard');
    const widgetId = parseId(params(request)['widgetId'], 'widget');
    const existing = ctx.services.dashboards.get(id);
    allow(ctx, 'dashboard.manage', existing.projectId);

    ctx.services.dashboards.removeWidget(id, widgetId, scope(ctx));
    return { deleted: true, id: widgetId };
  });
};

export default dashboardRoutes;
