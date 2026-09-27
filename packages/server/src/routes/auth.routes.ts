/**
 * Authentication routes.
 *
 * Every route here is reachable without credentials; the ones that need a
 * principal call `requireAuth` themselves. Successful credential and SSO
 * exchanges set the session cookie; `logout` clears it.
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
import { createSsoState, readSsoState, safeRedirectPath } from '../services/auth.service.ts';
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

const ssoStartQuerySchema = z.object({
  redirect: z.string().max(2048).optional(),
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

  // ---------------------------------------------------------------------
  // SSO
  // ---------------------------------------------------------------------

  /** Providers offered on the login screen. No endpoints, no client secrets. */
  app.get(API.auth.ssoProviders, async () => {
    const services = servicesOf(app);
    const configurations = services.auth.listEnabledSsoConfigurations();

    return configurations.map((sso) => ({
      name: sso.name,
      protocol: sso.protocol,
      isDefault: sso.isDefault,
      startUrl: API.auth.ssoStart.replace(':provider', encodeURIComponent(sso.name)),
      metadataUrl: `/api/auth/sso/${encodeURIComponent(sso.name)}/metadata`,
    }));
  });

  /** Begin a federated login: 302 to the IdP with a signed `state`. */
  app.get(API.auth.ssoStart, async (request, reply: FastifyReply) => {
    const services = servicesOf(app);
    const params = request.params as { provider: string };
    const query = ssoStartQuerySchema.parse(request.query ?? {});

    const sso = services.auth.findSsoConfigurationByName(params.provider);
    if (!sso) throw notFound('SSO provider', params.provider);

    const state = createSsoState(services.config.sessionSecret, {
      provider: sso.name,
      protocol: sso.protocol,
      redirect: safeRedirectPath(query.redirect),
      nonce: '',
    });

    const target =
      sso.protocol === 'saml'
        ? services.auth.buildSamlRedirectUrl(sso, state)
        : services.auth.buildAuthorizationUrl(sso, state, services.auth.ssoRedirectUri(sso.name));

    return reply.redirect(target, 302);
  });

  /**
   * Assertion consumer. OIDC arrives as a query string, SAML as a form POST.
   */
  app.route({
    method: ['GET', 'POST'],
    url: API.auth.ssoCallback,
    handler: async (request, reply) => {
      const services = servicesOf(app);
      const params = request.params as { provider: string };
      const sso = services.auth.findSsoConfigurationByName(params.provider);
      if (!sso) throw notFound('SSO provider', params.provider);

      const source = {
        ...(typeof request.query === 'object' && request.query !== null ? request.query : {}),
        ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      } as Record<string, unknown>;

      let state = readSsoState(services.config.sessionSecret, String(source['state'] ?? source['RelayState'] ?? ''));
      if (!state) state = readSsoState(services.config.sessionSecret, String(source['relayState'] ?? ''));
      if (!state) throw unauthenticated('The single sign-on state is missing or has expired');
      if (state.provider !== sso.name) throw unauthenticated('The single sign-on state does not match this provider');

      const claims =
        sso.protocol === 'saml'
          ? services.auth.parseSamlAssertion(decodeSamlResponse(source['SAMLResponse']))
          : await services.auth.exchangeOidcCode(
              sso,
              String(source['code'] ?? ''),
              services.auth.ssoRedirectUri(sso.name),
            );

      if (!claims || Object.keys(claims).length === 0) {
        throw badRequest('The identity provider returned no usable claims');
      }

      const result = await services.auth.consumeSsoCallback(sso, claims, requestMeta(request));
      setSessionCookie(reply, services, result.sessionId, result.expiresAt);

      return reply.redirect(safeRedirectPath(state.redirect), 302);
    },
  });

  /** SP metadata for a SAML IdP to import. */
  app.get('/api/auth/sso/:provider/metadata', async (request, reply) => {
    const services = servicesOf(app);
    const params = request.params as { provider: string };
    const sso = services.auth.findSsoConfigurationByName(params.provider);
    if (!sso) throw notFound('SSO provider', params.provider);
    if (sso.protocol !== 'saml') throw badRequest(`SSO provider "${sso.name}" is not a SAML provider`);

    return reply
      .header('content-type', 'application/samlmetadata+xml; charset=utf-8')
      .send(services.auth.buildSamlMetadata(sso));
  });
};

/** Strip the password hash; nothing outside the service should see it. */
function withoutPassword(user: User & { instanceRole?: string }): Omit<User, 'passwordHash'> {
  const { passwordHash: _passwordHash, instanceRole: _instanceRole, ...rest } = user;
  return rest;
}

/** Decode the base64 `SAMLResponse` an IdP posts to the ACS endpoint. */
function decodeSamlResponse(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw badRequest('The SAML response is missing');
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

// `app.ts` imports `userRoutes` from this module; the implementation lives in
// its own file. This re-export is a compatibility shim and can be replaced by a
// direct import of `./users.routes.ts` whenever the assembler is next edited.
export { userRoutes } from './users.routes.ts';
export default authRoutes;
