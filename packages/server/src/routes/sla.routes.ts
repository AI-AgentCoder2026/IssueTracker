/**
 * SLA routes: policy administration plus the live countdown reads.
 *
 * Paths come from `API.sla` so the SPA cannot drift from the server.
 *
 * Permissions
 * -----------
 * `@tracker/shared` has no `sla.*` capability, so policy reads map to
 * `project.read` and policy writes to `project.update` (maintainer and above)
 * for a project-scoped policy. An *instance-wide* policy — `projectId: null` —
 * affects every project, so it is gated on `instance.settings` instead.
 *
 * Auth guards mirror the sibling route modules: the auth plugin owns
 * `request.context`, and the helpers below read it through a type-only view so
 * this file does not depend on that module's build order.
 */

import { API, can, createSlaPolicySchema, type Permission, type ProjectId } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { DAY_MS, parseDuration } from '../lib/time.ts';
import { forbidden, notFound, unauthenticated } from '../errors.ts';
import type { RequestContext } from '../services/context.ts';
import { parseId } from '../services/context.ts';
import type { AuditScope } from '../services/sla.service.ts';

function authed(request: FastifyRequest): RequestContext {
  const ctx = request.context;
  if (!ctx) throw unauthenticated();
  return ctx;
}

function allow(ctx: RequestContext, permission: Permission, projectId?: number | null): void {
  const access = projectId === undefined || projectId === null ? {} : { projectId: projectId as ProjectId };
  const decision = can(ctx.actor, permission, access);
  if (!decision.allowed) throw forbidden(decision.reason);
}

/** The audit identity for this request. */
function scope(ctx: RequestContext): AuditScope {
  return { ...ctx.auditContext, actorId: ctx.auditContext.actorId ?? ctx.actor.userId };
}

function params(request: FastifyRequest): Record<string, unknown> {
  return (request.params ?? {}) as Record<string, unknown>;
}

function query(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** Instance-wide policies are administrative; project ones are project-scoped. */
function allowPolicyWrite(ctx: RequestContext, projectId: number | null): void {
  if (projectId === null) allow(ctx, 'instance.settings');
  else allow(ctx, 'project.update', projectId);
}

/** `?projectIds=1,2,3`, or every project the actor may read when omitted. */
function resolveProjectIds(ctx: RequestContext, request: FastifyRequest): number[] {
  const bag = query(request);
  const requested: number[] = [];

  // Both spellings are accepted. The plural list has always been read here, but
  // every sibling route in this API takes a singular `projectId` — and a
  // request carrying one was silently ignored, falling through to "every
  // project the caller can see". For an instance admin that turned
  // "this project's SLA" into the whole instance's.
  const single = bag['projectId'];
  if (single !== undefined && single !== null && single !== '') {
    requested.push(parseId(single, 'project'));
  }
  const many = bag['projectIds'];
  if (typeof many === 'string') {
    for (const entry of many
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '')) {
      const id = parseId(entry, 'project');
      if (!requested.includes(id)) requested.push(id);
    }
  }

  if (requested.length === 0) return ctx.services.sla.projectIdsFor(ctx.actor);
  for (const projectId of requested) allow(ctx, 'dashboard.read', projectId);
  return requested;
}

export const slaRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- literal paths, registered before the parameterised ones -------------

  /** Clocks due within the next window, soonest deadline first. */
  app.get(API.sla.atRisk, async (request) => {
    const ctx = authed(request);
    const projectIds = resolveProjectIds(ctx, request);

    const rawWindow = query(request)['window'];
    const windowMs =
      (typeof rawWindow === 'string' ? parseDuration(rawWindow) : null) ??
      (typeof query(request)['windowMs'] === 'number' ? (query(request)['windowMs'] as number) : DAY_MS);

    return { clocks: ctx.services.sla.atRisk(projectIds, windowMs) };
  });

  /** Clocks already past due that nothing has met. */
  app.get(API.sla.breached, async (request) => {
    const ctx = authed(request);
    const projectIds = resolveProjectIds(ctx, request);
    return { clocks: ctx.services.sla.breached(projectIds) };
  });

  // -- policy CRUD ---------------------------------------------------------

  app.get(API.sla.policies, async (request) => {
    const ctx = authed(request);
    const raw = query(request)['projectId'];
    const projectId = raw === undefined || raw === null || raw === '' ? null : parseId(raw, 'project');
    if (projectId !== null) allow(ctx, 'project.read', projectId);
    else allow(ctx, 'project.read');

    return { policies: ctx.services.sla.listPolicies(projectId) };
  });

  app.post(API.sla.createPolicy, async (request, reply) => {
    const ctx = authed(request);
    const body = createSlaPolicySchema.parse((request as { body?: unknown }).body);
    allowPolicyWrite(ctx, body.projectId);

    const policy = ctx.services.sla.createPolicy(body, scope(ctx));
    return reply.code(201).send(policy);
  });

  app.patch(API.sla.updatePolicy, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'sla policy');
    const existing = ctx.services.sla.getPolicy(id);
    allowPolicyWrite(ctx, existing.projectId);

    const body = createSlaPolicySchema.partial().parse((request as { body?: unknown }).body);
    // A patch may move a policy between scopes, so the destination is gated too.
    if (body.projectId !== undefined) allowPolicyWrite(ctx, body.projectId);

    return ctx.services.sla.updatePolicy(id, body, scope(ctx));
  });

  app.delete(API.sla.removePolicy, async (request) => {
    const ctx = authed(request);
    const id = parseId(params(request)['id'], 'sla policy');
    const existing = ctx.services.sla.getPolicy(id);
    allowPolicyWrite(ctx, existing.projectId);

    ctx.services.sla.removePolicy(id, scope(ctx));
    return { deleted: true, id };
  });

  // -- per issue -----------------------------------------------------------

  /** The live countdown state for one issue. */
  app.get(API.sla.forIssue, async (request) => {
    const ctx = authed(request);
    const issueId = parseId(params(request)['issueId'], 'issue');
    const issue = ctx.services.db.get<{ project_id: number }>(
      'SELECT project_id FROM issues WHERE id = ?',
      [issueId],
    );
    if (!issue) throw notFound('Issue', issueId);
    allow(ctx, 'issue.read', issue.project_id);

    return { clocks: await ctx.services.sla.statusForIssue(issueId) };
  });
};

export default slaRoutes;
