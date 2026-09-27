/**
 * Request authentication.
 *
 * Registered once, before the route modules, this plugin:
 *   * registers `@fastify/cookie` and `@fastify/rate-limit` (both are
 *     idempotent here: if the application already registered them it is left
 *     alone),
 *   * decorates the request with `context` and `actor`,
 *   * resolves the principal on every request, and
 *   * exposes the guards route modules use to enforce access.
 *
 * The `onRequest` hook NEVER throws for an anonymous request. Public routes
 * stay public; protected routes call `requireAuth()` (also available as
 * `app.requireAuth`) and get a 401. A guest token yields a synthetic
 * project-scoped `Actor`, which is what `request.context.guest` describes.
 *
 * Wiring: pass the registry explicitly —
 *   `app.register(authPlugin, { services })`
 * — or decorate it once in `app.ts` (`app.decorate('services', services)`) and
 * register the plugin with no options. Both are supported.
 *
 * The plugin is wrapped in `fastify-plugin` so its hooks apply to the whole
 * application rather than only to routes registered inside its own scope.
 */

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyPlugin from 'fastify-plugin';
import {
  can,
  roleAtLeast,
  type Actor,
  type Permission,
  type ProjectId,
  type Role,
  type User,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, internalError, unauthenticated } from '../errors.ts';
import type { RequestContext, Services } from '../services/context.ts';
import { GuestService, type GuestPrincipal } from '../services/guest.service.ts';
import type { StoredUser } from '../services/auth.service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request context. Always set by the `onRequest` hook, even for
     * anonymous callers: `context.actor` is then the grant-nothing anonymous
     * actor, while `request.actor` is `null`. Always test `request.actor` (or
     * call `requireAuth`) rather than trusting `context.actor`.
     */
    context: RequestContext;
    /** The authenticated principal, or `null` for an anonymous request. */
    actor: Actor | null;
  }

  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => RequestContext;
    requirePermission: (
      request: FastifyRequest,
      permission: Permission,
      projectId?: ProjectId,
      options?: { isOwnerOfResource?: boolean },
    ) => RequestContext;
    requireProjectRole: (
      request: FastifyRequest,
      projectId: ProjectId,
      minimumRole: Role,
    ) => RequestContext;
    /** Session id carried by the request cookie, if any. */
    sessionIdOf: (request: FastifyRequest) => string | null;
  }
}

export interface AuthPluginOptions {
  /** Service registry. Optional when the instance is decorated with `services`. */
  services?: Services;
  /** Overrides `SESSION_COOKIE_NAME`; defaults to `tracker_session`. */
  sessionCookieName?: string;
}

/** The instance decoration the plugin reads when no options are supplied. */
type WithServices = FastifyInstance & { services?: Services };

/** Name of the session cookie, honouring `SESSION_COOKIE_NAME`. */
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tracker_session';

/** A resolved principal plus the actor it projects onto the request. */
type Principal =
  | { kind: 'user'; user: StoredUser; actor: Actor; sessionId: string | null }
  | { kind: 'guest'; guest: GuestPrincipal; actor: Actor }
  | { kind: 'anonymous' };

/**
 * Guest tokens are redeemed through `GuestService`, which the plugin builds
 * from the registry it is given. The memo keeps one instance per registry
 * without asking the registry to own a field the shared `Services` interface
 * has no slot for.
 */
const guestServices = new WeakMap<Services, GuestService>();

/** The `GuestService` bound to a registry, created on first use. */
export function guestServiceFor(services: Services): GuestService {
  const existing = guestServices.get(services);
  if (existing) return existing;
  const created = new GuestService(services);
  guestServices.set(services, created);
  return created;
}

/** Read the service registry from the instance, with a clear failure mode. */
export function servicesOf(app: FastifyInstance): Services {
  const services = (app as WithServices).services;
  if (!services) {
    throw internalError(
      'No service registry is available. Register the auth plugin with `{ services }` ' +
        'or decorate the instance with `services` before registering it.',
    );
  }
  return services;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Require an authenticated principal. Guests count: they carry a real, if
 * narrow, `Actor` on `request.actor`.
 */
export function requireAuth(request: FastifyRequest): RequestContext {
  if (!request.actor || !request.context) throw unauthenticated();
  return request.context;
}

/**
 * Require a capability, evaluated by `can()` against the project in scope.
 * Throws `forbidden(reason)` with the reason the shared policy produced, so the
 * message explains itself without leaking project details.
 */
export function requirePermission(
  request: FastifyRequest,
  permission: Permission,
  projectId?: ProjectId,
  options: { isOwnerOfResource?: boolean } = {},
): RequestContext {
  const context = requireAuth(request);
  const decision = can(context.actor, permission, {
    projectId,
    isOwnerOfResource: options.isOwnerOfResource,
  });
  if (!decision.allowed) throw forbidden(decision.reason);
  return context;
}

/**
 * Require at least a given role in a project. Instance administrators bypass
 * the comparison, matching `can()`.
 */
export function requireProjectRole(
  request: FastifyRequest,
  projectId: ProjectId,
  minimumRole: Role,
): RequestContext {
  const context = requireAuth(request);
  const actor = context.actor;
  if (actor.isInstanceAdmin) return context;

  const role = actor.projectRoles.get(projectId);
  if (!role) throw forbidden('You are not a member of this project');
  if (!roleAtLeast(role, minimumRole)) {
    throw forbidden(`This action requires the ${minimumRole} role or higher`);
  }
  return context;
}

/** The raw session id from the cookie, used by the logout route. */
export function sessionIdOf(request: FastifyRequest, cookieName: string = SESSION_COOKIE_NAME): string | null {
  const value = request.cookies?.[cookieName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function authPluginImpl(
  app: FastifyInstance,
  options: AuthPluginOptions = {},
): Promise<void> {
  const registry = options.services ?? (app as WithServices).services;
  if (!registry) servicesOf(app); // Throws the actionable message.
  const services = registry as Services;
  const cookieName = options.sessionCookieName || SESSION_COOKIE_NAME;

  if (!app.hasPlugin('@fastify/cookie')) {
    await app.register(cookie, { secret: services.config.sessionSecret });
  }
  if (!app.hasPlugin('@fastify/rate-limit')) {
    // Defaults are permissive; the login route opts into a strict limit.
    await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' });
  }

  // Fastify needs a declared default so the property exists on the request
  // prototype; both are overwritten by the `onRequest` hook below before any
  // handler runs. The cast is only about the sentinel, never about real data.
  app.decorateRequest('context', null as unknown as RequestContext);
  app.decorateRequest('actor', null);

  if (!app.hasDecorator('requireAuth')) {
    app.decorate('requireAuth', requireAuth);
    app.decorate('requirePermission', requirePermission);
    app.decorate('requireProjectRole', requireProjectRole);
    app.decorate('sessionIdOf', sessionIdOf);
  }

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const principal = await resolvePrincipal(services, request, cookieName);
    applyPrincipal(services, request, principal);
  });
}

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = fastifyPlugin(authPluginImpl, {
  name: 'tracker-auth',
  fastify: '5.x',
});

/**
 * Resolve the principal from, in order: an `Authorization: Bearer` API token, an
 * `Authorization: Guest` header, a `?guest=` query parameter, or the session
 * cookie. Never throws — a bad or expired credential is simply an anonymous
 * request, and the route decides whether that is acceptable.
 */
async function resolvePrincipal(
  services: Services,
  request: FastifyRequest,
  cookieName: string,
): Promise<Principal> {
  const authorization = headerValue(request.headers.authorization);
  const userAgent = headerValue(request.headers['user-agent']);
  const ip = request.ip;
  const meta = { ip, userAgent };

  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer?.[1]) {
      const resolved = services.auth.resolveApiToken(bearer[1].trim());
      if (resolved) {
        // A token scoped to specific projects narrows the actor to those
        // projects only; a token with an empty list is unrestricted.
        const override = narrowProjectRoles(
          await services.auth.listProjectRoles(resolved.user.id),
          resolved.token.projectIds,
        );
        return {
          kind: 'user',
          user: resolved.user,
          actor: await services.auth.buildActor(resolved.user, override),
          sessionId: null,
        };
      }
      request.log.debug({ requestId: request.id, path: request.url }, 'bearer token rejected');
    }

    const guestHeader = /^Guest\s+(.+)$/i.exec(authorization);
    if (guestHeader?.[1]) {
      const redeemed = redeemGuest(services, guestHeader[1].trim(), meta);
      if (redeemed) return redeemed;
    }
  }

  const query = request.query as Record<string, unknown> | undefined;
  const queryGuest = typeof query?.['guest'] === 'string' ? query['guest'] : null;
  if (queryGuest) {
    const redeemed = redeemGuest(services, queryGuest, meta);
    if (redeemed) return redeemed;
  }

  const sessionId = sessionIdOf(request, cookieName);
  if (sessionId) {
    const user = await services.auth.resolveSession(sessionId);
    if (user) {
      return {
        kind: 'user',
        user,
        actor: await services.auth.buildActor(user),
        sessionId,
      };
    }
    request.log.debug({ requestId: request.id }, 'session cookie rejected');
  }

  return { kind: 'anonymous' };
}

/** Redeem a guest token; an unusable token degrades to anonymous. */
function redeemGuest(
  services: Services,
  rawToken: string,
  meta: { ip: string; userAgent: string },
): Principal | null {
  try {
    const result = guestServiceFor(services).redeem(rawToken, meta);
    const projectRoles = new Map<ProjectId, Role>();
    projectRoles.set(result.guest.projectId as ProjectId, result.guest.role);
    return {
      kind: 'guest',
      guest: result.guest,
      // No user row backs a guest; `userId` 0 is the reserved anonymous id.
      actor: { userId: 0 as Actor['userId'], isInstanceAdmin: false, roles: [], projectRoles },
    };
  } catch {
    return null;
  }
}

/** Attach the resolved principal to the request. */
function applyPrincipal(services: Services, request: FastifyRequest, principal: Principal): void {
  // `request.ip` already reflects the instance's `trustProxy` setting.
  const ip = request.ip;
  const userAgent = headerValue(request.headers['user-agent']);

  let actor: Actor | null = null;
  let guest: RequestContext['guest'] = null;
  let auditContext: RequestContext['auditContext'] = { ipAddress: ip, userAgent };

  if (principal.kind === 'user') {
    actor = principal.actor;
    auditContext = { ...auditContext, ...userAuditContext(principal.user) };
  } else if (principal.kind === 'guest') {
    actor = principal.actor;
    guest = principal.guest;
    auditContext = { ...auditContext, actorName: principal.guest.label };
  }

  request.actor = actor;
  request.context = {
    services,
    db: services.db,
    config: services.config,
    actor: actor ?? ANONYMOUS_ACTOR,
    guest,
    requestId: request.id,
    ip,
    userAgent,
    auditContext,
  };
}

/** Keep only the memberships an API token is scoped to. */
function narrowProjectRoles(
  roles: ReadonlyMap<ProjectId, Role>,
  allowed: readonly ProjectId[],
): ReadonlyMap<ProjectId, Role> {
  if (allowed.length === 0) return roles;
  const narrowed = new Map<ProjectId, Role>();
  for (const projectId of allowed) {
    const role = roles.get(projectId);
    if (role) narrowed.set(projectId, role);
  }
  return narrowed;
}

function userAuditContext(user: User): RequestContext['auditContext'] {
  return { actorId: user.id, actorName: user.username, actorEmail: user.email };
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Grants nothing; keeps the `RequestContext` shape total for public routes. */
const ANONYMOUS_ACTOR: Actor = {
  userId: 0 as Actor['userId'],
  isInstanceAdmin: false,
  roles: [],
  projectRoles: new Map<ProjectId, Role>(),
};

/**
 * Whether the deployment is expected to be reached over HTTPS.
 *
 * An explicit override always wins; otherwise the scheme of `PUBLIC_URL` decides.
 * This drives the `Secure` cookie flag, so getting it wrong breaks login rather
 * than merely weakening it.
 */
export function isHttps(publicUrl: string): boolean {
  const override = process.env['COOKIE_SECURE'];
  if (override !== undefined && override !== '') {
    return ['1', 'true', 'yes', 'on'].includes(override.toLowerCase());
  }
  return publicUrl.toLowerCase().startsWith('https://');
}
/** Set the session cookie. Exported so the route modules share one policy. */
export function setSessionCookie(
  reply: FastifyReply,
  services: Services,
  sessionId: string,
  expiresAt: string,
  cookieName: string = SESSION_COOKIE_NAME,
): void {
  reply.setCookie(cookieName, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    // Keyed off the advertised public URL rather than NODE_ENV: a production
    // build served over plain HTTP (a local trial run, or a reverse proxy that
    // terminates TLS upstream) would otherwise receive a `Secure` cookie the
    // browser refuses to store, making login appear to succeed and then fail.
    secure: isHttps(services.config.publicUrl),
    path: '/',
    expires: new Date(expiresAt),
  });
}

/** Clear the session cookie. Exported so the route modules share one policy. */
export function clearSessionCookie(
  reply: FastifyReply,
  services: Services,
  cookieName: string = SESSION_COOKIE_NAME,
): void {
  reply.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    // Keyed off the advertised public URL rather than NODE_ENV: a production
    // build served over plain HTTP (a local trial run, or a reverse proxy that
    // terminates TLS upstream) would otherwise receive a `Secure` cookie the
    // browser refuses to store, making login appear to succeed and then fail.
    secure: isHttps(services.config.publicUrl),
    path: '/',
  });
}

export default authPlugin;
