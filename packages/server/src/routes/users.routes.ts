/**
 * User administration, self-service account routes and per-project guest links.
 *
 * Permission notes (the shared permission list has no `user.*` entries, so the
 * closest instance-level capabilities are used):
 *   * `GET/POST/PATCH /api/users`, `POST /api/users/:id/deactivate`
 *     -> `instance.settings`, which only the `owner` role carries, so in
 *     practice only instance administrators reach these.
 *   * `GET /api/users/:id` is additionally readable by the account's owner.
 *   * own profile / own API tokens -> plain authentication, because a user
 *     always owns their own credentials.
 *   * guest links -> `guestToken.create`, which the `admin` project role
 *     carries, evaluated against the project in the path.
 */

import {
  API,
  createApiTokenSchema,
  createGuestTokenSchema,
  asProjectId,
  type ApiToken,
  type GuestToken,
  type User,
} from '@tracker/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { badRequest, notFound } from '../errors.ts';
import type { RequestMeta, UpdateUserPatch } from '../services/auth.service.ts';
import { parseId, type RequestContext } from '../services/context.ts';
import {
  guestServiceFor,
  requireAuth,
  requirePermission,
  servicesOf,
} from '../plugins/auth.plugin.ts';

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
  instanceRole: z.enum(['user', 'staff', 'admin'] as const).optional(),
});

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  email: z.string().trim().email().max(320).optional(),
  avatarUrl: z.string().url().max(2000).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  isActive: z.boolean().optional(),
  instanceRole: z.enum(['user', 'staff', 'admin'] as const).optional(),
  /** Administrative password reset; hashed by the service, never stored raw. */
  password: z.string().min(1).max(200).optional(),
});

const listUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  includeInactive: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Build the per-request identity envelope the services expect. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.context.ip,
    userAgent: request.context.userAgent,
    audit: request.context.auditContext,
    requestId: request.context.requestId,
  };
}

/** Strip the password hash before anything leaves the process. */
function withoutPassword(user: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

/** `tokenHash` is internal bookkeeping; the client never needs the digest. */
function publicGuestToken(token: GuestToken): Omit<GuestToken, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...rest } = token;
  return rest;
}

function params(request: FastifyRequest): Record<string, string> {
  return (request.params ?? {}) as Record<string, string>;
}

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------

  app.get(API.users.list, async (request) => {
    const context: RequestContext = requirePermission(request, 'instance.settings');
    const query = listUsersQuerySchema.parse(request.query ?? {});

    const users = context.services.auth.listUsers(requestMeta(request), {
      search: query.search,
      includeInactive: query.includeInactive === 'true' || query.includeInactive === '1',
      limit: query.limit,
    });

    return { users: users.map(withoutPassword), total: users.length };
  });

  app.post(API.users.create, async (request, reply) => {
    const context = requirePermission(request, 'instance.settings');
    const body = createUserSchema.parse(request.body);

    const user = context.services.auth.createUser(
      {
        username: body.username,
        email: body.email,
        displayName: body.displayName,
        password: body.password,
      },
      requestMeta(request),
      { instanceRole: body.instanceRole },
    );

    return reply.status(201).send({ user: withoutPassword(user) });
  });

  app.get(API.users.get, async (request) => {
    const context = requireAuth(request);
    const id = parseId(params(request)['id'], 'user');

    // A user may always read their own record; reading anyone else needs the
    // instance-settings capability.
    if (Number(context.actor.userId) !== id) {
      requirePermission(request, 'instance.settings');
    }

    const user = context.services.auth.getUser(id);
    if (!user) throw notFound('User', id);
    return { user: withoutPassword(user) };
  });

  app.patch(API.users.update, async (request) => {
    const context = requirePermission(request, 'instance.settings');
    const id = parseId(params(request)['id'], 'user');
    const body = updateUserSchema.parse(request.body);

    const patch: UpdateUserPatch = { ...body };
    const user = context.services.auth.updateUser(id, patch, requestMeta(request));

    return { user: withoutPassword(user) };
  });

  app.post(API.users.deactivate, async (request) => {
    const context = requirePermission(request, 'instance.settings');
    const id = parseId(params(request)['id'], 'user');

    // Removing the last administrator would lock the instance out of its own
    // administration screens.
    if (id === Number(context.actor.userId)) {
      throw badRequest('You cannot deactivate your own account');
    }
    const target = context.services.auth.getUser(id);
    if (target?.isInstanceAdmin) {
      const otherAdmin = context.db.get(
        "SELECT id FROM users WHERE instance_role = 'admin' AND is_active = 1 AND id <> ? LIMIT 1",
        [id],
      );
      if (!otherAdmin) throw badRequest('The last active administrator cannot be deactivated');
    }

    const user = context.services.auth.deactivateUser(id, requestMeta(request));
    return { user: withoutPassword(user) };
  });

  // ---------------------------------------------------------------------
  // Own API tokens
  // ---------------------------------------------------------------------

  app.get(API.users.tokens, async (request) => {
    const context = requireAuth(request);
    const tokens: ApiToken[] = context.services.auth.listApiTokens(Number(context.actor.userId));
    return { tokens, total: tokens.length };
  });

  app.post(API.users.createToken, async (request, reply) => {
    const context = requireAuth(request);
    const body = createApiTokenSchema.parse(request.body);

    const created = context.services.auth.createApiToken(
      Number(context.actor.userId),
      body,
      requestMeta(request),
    );

    // The secret is returned exactly once; the database holds only its digest.
    return reply.status(201).send({ token: created.token, secret: created.secret });
  });

  app.delete(API.users.revokeToken, async (request) => {
    const context = requireAuth(request);
    const id = parseId(params(request)['id'], 'token');
    context.services.auth.revokeApiToken(Number(context.actor.userId), id, requestMeta(request));
    return { ok: true };
  });

  // ---------------------------------------------------------------------
  // Guest links
  // ---------------------------------------------------------------------

  app.get(API.users.guestTokens, async (request) => {
    const context = requireAuth(request);
    const projectId = parseId(params(request)['projectId'], 'project');
    requirePermission(request, 'guestToken.create', asProjectId(projectId));

    const tokens = guestServiceFor(context.services).list(projectId, context.actor);
    return { guestTokens: tokens.map(publicGuestToken), total: tokens.length };
  });

  app.post(API.users.createGuestToken, async (request, reply) => {
    const context = requireAuth(request);
    const projectId = parseId(params(request)['projectId'], 'project');
    requirePermission(request, 'guestToken.create', asProjectId(projectId));

    // The path is authoritative: a `projectId` in the body is ignored.
    const payload =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body = createGuestTokenSchema.parse({ ...payload, projectId });
    const created = await guestServiceFor(context.services).create(
      projectId,
      body,
      context.actor,
      requestMeta(request),
    );

    return reply.status(201).send({ guestToken: publicGuestToken(created.token), url: created.url });
  });

  app.delete(API.users.revokeGuestToken, async (request) => {
    const context = requireAuth(request);
    const projectId = parseId(params(request)['projectId'], 'project');
    const id = parseId(params(request)['id'], 'guest token');
    requirePermission(request, 'guestToken.create', asProjectId(projectId));

    const token = guestServiceFor(context.services).revoke(
      projectId,
      id,
      context.actor,
      requestMeta(request),
    );
    return { guestToken: publicGuestToken(token) };
  });
};

export default userRoutes;
