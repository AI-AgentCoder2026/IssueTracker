/**
 * WebAuthn / passkey routes.
 *
 * The ceremony is two-legged by design: the browser gets `options` from one call
 * and posts the authenticator's `response` back to another, with a
 * `challengeId` in between so the server can prove the two halves belong to the
 * same, unused challenge.
 */

import { API } from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { badRequest } from '../errors.ts';
import { parseId } from '../services/context.ts';
import { requireAuth, servicesOf, sessionIdOf, setSessionCookie } from '../plugins/auth.plugin.ts';
import type { RequestMeta } from '../services/auth.service.ts';
import type { FastifyRequest } from 'fastify';

/** Request metadata the auth service records alongside an audit entry. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.context.ip,
    userAgent: request.context.userAgent,
    audit: request.context.auditContext,
    requestId: request.context.requestId,
  };
}

export const webauthnRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const services = servicesOf(app);

  // -- registration (an authenticated user adds a passkey) ------------------
  app.post(API.webauthn.registerBegin, async (request) => {
    const ctx = requireAuth(request);
    const body = (request.body ?? {}) as { label?: unknown };
    const label = typeof body.label === 'string' ? body.label : '';

    const begun = await ctx.services.webauthn.beginRegistration(
      Number(ctx.actor.userId),
      ctx.auditContext,
    );
    return { options: begun.options, challengeId: begun.challengeId, label };
  });

  app.post(API.webauthn.registerFinish, async (request) => {
    const ctx = requireAuth(request);
    const body = (request.body ?? {}) as {
      response?: unknown;
      challengeId?: unknown;
      label?: unknown;
    };

    if (body.challengeId === undefined) throw badRequest('A challengeId is required');
    const label = typeof body.label === 'string' ? body.label : 'Passkey';

    const credential = await ctx.services.webauthn.finishRegistration(
      Number(ctx.actor.userId),
      body.response,
      parseId(body.challengeId, 'challenge'),
      label,
      ctx.auditContext,
    );

    // The public key is never returned; only the id and the labels the UI shows.
    return {
      credential: {
        id: credential.id,
        label: credential.label,
        attachment: credential.attachment,
        backedUp: credential.backedUp,
        createdAt: credential.createdAt,
      },
    };
  });

  // -- authentication (sign in with a passkey) -----------------------------
  app.post(API.webauthn.authenticateBegin, async (request) => {
    const body = (request.body ?? {}) as { username?: unknown; context?: unknown };
    const username = typeof body.username === 'string' ? body.username : null;
    const context =
      body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : {};

    const begun = await services.webauthn.beginAuthentication(username, context);
    return { options: begun.options, challengeId: begun.challengeId };
  });

  /**
   * Verify the assertion and establish a session, exactly as a password login
   * would. A passkey is a first-class credential, not a lesser one.
   */
  app.post(API.webauthn.authenticateFinish, async (request, reply) => {
    const body = (request.body ?? {}) as { response?: unknown; challengeId?: unknown };
    if (body.challengeId === undefined) throw badRequest('A challengeId is required');

    const result = await services.webauthn.finishAuthentication(
      body.response,
      parseId(body.challengeId, 'challenge'),
      requestMeta(request),
    );

    const user = services.db.get<{ id: number; is_active: number }>(
      'SELECT id, is_active FROM users WHERE id = ?',
      [result.userId],
    );
    if (!user) {
      // Defensive: the service already checks, so reaching here means the
      // account vanished between verification and the session.
      throw badRequest('That account no longer exists');
    }

    const session = services.auth.createSession(result.userId, requestMeta(request));
    setSessionCookie(reply, services, session.sessionId, session.expiresAt);

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      credential: { id: result.credential.id, label: result.credential.label },
    };
  });

  // -- management ----------------------------------------------------------
  app.get(API.webauthn.credentials, async (request) => {
    const ctx = requireAuth(request);
    const credentials = ctx.services.webauthn
      .credentialsFor(Number(ctx.actor.userId))
      .filter((credential) => credential.revokedAt === null)
      .map((credential) => ({
        id: credential.id,
        label: credential.label,
        // `platform` means the device's own biometric prompt gates the sign-in;
        // `cross-platform` is a roaming key or a synced passkey.
        attachment: credential.attachment,
        backedUp: credential.backedUp,
        lastUsedAt: credential.lastUsedAt,
        createdAt: credential.createdAt,
      }));

    return {
      credentials,
      currentSessionId: sessionIdOf(request),
    };
  });

  app.delete(API.webauthn.revokeCredential, async (request) => {
    const params = request.params as { id: string };
    const ctx = requireAuth(request);
    ctx.services.webauthn.revokeCredential(
      Number(ctx.actor.userId),
      parseId(params.id, 'credential'),
      ctx.auditContext,
    );
    return { deleted: true };
  });

  /** Remove every passkey; refused when it would lock the account out. */
  app.post(API.webauthn.revokeAll, async (request) => {
    const ctx = requireAuth(request);
    const revoked = ctx.services.webauthn.revokeAll(Number(ctx.actor.userId), ctx.auditContext);
    return { revoked };
  });
};

export default webauthnRoutes;
