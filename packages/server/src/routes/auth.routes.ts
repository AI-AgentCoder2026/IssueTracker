/**
 * Authentication routes.
 *
 * Every route here is reachable without credentials; the ones that need a
 * principal call `requireAuth` themselves. Successful credential exchanges set
 * the session cookie; `logout` clears it.
 *
 * The login route is rate limited to 5 attempts per 15 minutes per IP. The
 * limit is declared through the `@fastify/rate-limit` route config, which the
 * auth plugin registers (or defers to, if the application already has it).
 */

import { API, loginSchema, registerSchema, changePasswordSchema, updateProfileSchema, type User } from '@tracker/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { badRequest, notFound, unauthenticated } from '../errors.ts';
import type { RequestMeta } from '../services/auth.service.ts';
import { safeRedirectPath } from '../services/auth.service.ts';
import {
  clearSessionCookie,
  guestServiceFor,
  requireAuth,
  servicesOf,
  setSessionCookie,
  sessionIdOf,
} from '../plugins/auth.plugin.ts';

const guestRedeemSchema = z.object({
  token: z.string().min(16).max(512),
});

/** Body the SPA needs to render a session: the user plus their project roles. */
interface MeResponse {
  user: Omit<User, 'passwordHash'>;
  projectRoles: Array<{ projectId: number; role: string }>;
}

/** Build the per-request identity envelope the services expect. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.context.ip,
    userAgent: request.context.userAgent,
    audit: request.context.auditContext,
    requestId: request.context.requestId,
  };
}

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------------------------------------------------------------------
  // Local credentials
  // ---------------------------------------------------------------------

  app.post(API.auth.register, async (request, reply) => {
    const services = servicesOf(app);
    const body = registerSchema.parse(request.body);
    const result = await services.auth.register(body, requestMeta(request));

    setSessionCookie(reply, services, result.sessionId, result.expiresAt);
    return { user: result.user, expiresAt: result.expiresAt };
  });

  app.post(
    API.auth.login,
    {
      // 5 attempts per 15 minutes per client IP; the shared in-memory store is
      // enough for a single-process deployment.
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const services = servicesOf(app);
      const body = loginSchema.parse(request.body);
      const result = await services.auth.login(body.login, body.password, requestMeta(request));

      setSessionCookie(reply, services, result.sessionId, result.expiresAt);
      return { user: result.user, expiresAt: result.expiresAt };
    },
  );

  app.post(API.auth.logout, async (request, reply) => {
    const services = servicesOf(app);
    const sessionId = sessionIdOf(request);

    // Idempotent: logging out with a stale or missing cookie still succeeds.
    if (sessionId) await services.auth.logout(sessionId, requestMeta(request));
    clearSessionCookie(reply, services);

    return { ok: true };
  });

  app.get(API.auth.me, async (request) => {
    const context = requireAuth(request);
    const services = servicesOf(app);
    const user = services.auth.requireUser(Number(context.actor.userId));

    const projectRoles = [...context.actor.projectRoles.entries()].map(([projectId, role]) => ({
      projectId: Number(projectId),
      role,
    }));

    const response: MeResponse = {
      user: withoutPassword(user),
      projectRoles,
    };
    return response;
  });

  app.patch(API.auth.me, async (request) => {
    const context = requireAuth(request);
    const services = servicesOf(app);
    const patch = updateProfileSchema.parse(request.body);
    const user = services.auth.updateProfile(
      Number(context.actor.userId),
      patch,
      requestMeta(request),
    );
    return { user: withoutPassword(user) };
  });

  app.post(API.auth.changePassword, async (request) => {
    const context = requireAuth(request);
    const services = servicesOf(app);
    const body = changePasswordSchema.parse(request.body);

    await services.auth.changePassword(
      Number(context.actor.userId),
      body.currentPassword,
      body.newPassword,
      requestMeta(request),
      { keepSessionId: sessionIdOf(request) ?? undefined },
    );

    return { ok: true };
  });

  // ---------------------------------------------------------------------
  // Guest access
  // ---------------------------------------------------------------------

  /**
   * Exchange a guest link for its project scope. No session is created: the
   * SPA keeps presenting the token as `Authorization: Guest <token>`.
   */
  app.post(API.auth.guestRedeem, async (request) => {
    const services = servicesOf(app);
    const body = guestRedeemSchema.parse(request.body);
    const redeemed = guestServiceFor(services).redeem(body.token, requestMeta(request));

    return {
      guest: redeemed.guest,
      projectId: redeemed.guest.projectId,
      issueId: redeemed.issueId,
      role: redeemed.guest.role,
      canComment: redeemed.guest.canComment,
      label: redeemed.guest.label,
      expiresAt: redeemed.expiresAt,
    };
  });
};

/** Strip the password hash; nothing outside the service should see it. */
function withoutPassword(user: User & { instanceRole?: string }): Omit<User, 'passwordHash'> {
  const { passwordHash: _passwordHash, instanceRole: _instanceRole, ...rest } = user;
  return rest;
}

// `app.ts` imports `userRoutes` from this module; the implementation lives in
// its own file. This re-export is a compatibility shim and can be replaced by a
// direct import of `./users.routes.ts` whenever the assembler is next edited.
export { userRoutes } from './users.routes.ts';
export default authRoutes;
