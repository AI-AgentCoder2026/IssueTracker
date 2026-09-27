/**
 * Authentication, identity and RBAC.
 *
 * Responsibilities:
 *   * local credentials (register / login / password change),
 *   * opaque server-side sessions, API tokens and guest tokens,
 *   * user administration with a full audit trail,
 *   * the `Actor` projection that every route guard consumes, and
 *   * OIDC / SAML single sign-on.
 *
 * Secrets follow one rule: only a hash (or an encrypted blob) ever reaches the
 * database. `sessions.id` holds `sha256(sessionId)` so a database leak cannot
 * be replayed as a live session; the plaintext only ever exists in the
 * httpOnly cookie. API and guest tokens use the same scheme via `hashToken()`.
 */

import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import {
  asProjectId,
  asUserId,
  changePasswordSchema,
  createApiTokenSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  type Actor,
  type ApiToken,
  type AuditAction,
  type AuthProvider,
  type AuthResult,
  type ExternalIdentity,
  type InstanceRole,
  type ProjectId,
  type Role,
  type Session,
  type SsoConfiguration,
  type User,
} from '@tracker/shared';
import {
  decrypt,
  generateSessionId,
  generateToken,
  hashPassword,
  hashToken,
  hmacSha256Hex,
  needsPasswordRehash,
  safeEqual,
  tokenPrefix,
  verifyPassword,
} from '../lib/crypto.ts';
import { addMs, isPast, nowIso } from '../lib/time.ts';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  integrationError,
  internalError,
  notFound,
  unauthenticated,
} from '../errors.ts';
import { JwksCache, verifyIdToken, type JwtClaims } from './oidc.ts';
import { verifySamlResponse } from './saml.ts';
import type { SqlParam } from '../db/connection.ts';
import type { Services } from './context.ts';
import type { RequestAuditContext } from './audit.service.ts';

export type CreateUserInput = z.infer<typeof registerSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Per-request identity passed down from the route layer. */
export interface RequestMeta {
  ip: string;
  userAgent: string;
  /** Pre-filled actor identity, merged into every audit entry. */
  audit?: RequestAuditContext;
  /** Correlation id, recorded in the log lines this service emits. */
  requestId?: string;
}

/** Administrative edits to a user record. */
export interface UpdateUserPatch {
  displayName?: string;
  email?: string;
  username?: string;
  avatarUrl?: string | null;
  timezone?: string;
  locale?: string;
  isActive?: boolean;
  instanceRole?: InstanceRole;
  /** Plaintext; hashed here and never persisted in the clear. */
  password?: string;
}

export interface ListUserOptions {
  search?: string;
  includeInactive?: boolean;
  limit?: number;
}

/**
 * A `User` plus the instance role. The shared `User` shape deliberately omits
 * `instance_role` (it only exposes the derived `isInstanceAdmin` flag), but RBAC
 * needs the raw role to build the platform half of an `Actor`, so the value
 * travels alongside the public object. Structurally assignable to `User`.
 */
export type StoredUser = User & { instanceRole: InstanceRole };

/** Claims after `attribute_map` has been applied. */
export interface MappedSsoClaims {
  externalId: string | null;
  email: string | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Row shapes. Declared as `type` aliases (not interfaces) so they keep the
// implicit index signature that `Database.get<T extends SqlRow>` requires.
// ---------------------------------------------------------------------------

type UserRow = {
  id: number;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  password_hash: string | null;
  provider: string;
  instance_role: string;
  is_active: number;
  timezone: string;
  locale: string;
  email_opt_out: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  user_id: number;
  ip_address: string;
  user_agent: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
};

/** `sessions` joined to `users`; the user columns are aliased 1:1. */
type SessionJoinRow = UserRow & { expires_at: string };

/** `api_tokens` joined to `users`, with the two `created_at` columns disambiguated. */
type ApiTokenJoinRow = UserRow & {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  scopes: string;
  project_ids: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  token_created_at: string;
};

type ApiTokenRow = {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  project_ids: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type SsoRow = {
  id: number;
  name: string;
  protocol: string;
  enabled: number;
  issuer: string | null;
  client_id: string | null;
  client_secret_encrypted: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  jwks_uri: string | null;
  entity_id: string | null;
  sso_url: string | null;
  idp_certificate: string | null;
  attribute_map: string;
  allowed_domains: string;
  auto_provision: number;
  default_role: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

type ExternalIdentityRow = {
  id: number;
  user_id: number;
  provider: string;
  external_id: string;
  external_username: string | null;
  created_at: string;
  last_login_at: string | null;
};

const USER_COLUMNS =
  'id, username, email, display_name, avatar_url, password_hash, provider, ' +
  'instance_role, is_active, timezone, locale, email_opt_out, last_login_at, created_at, updated_at';

const SSO_COLUMNS =
  'id, name, protocol, enabled, issuer, client_id, client_secret_encrypted, ' +
  'authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri, entity_id, ' +
  'sso_url, idp_certificate, attribute_map, allowed_domains, auto_provision, ' +
  'default_role, is_default, created_at, updated_at';

/**
 * Instance role -> the platform role an `Actor` carries when no project is in
 * context. `can()` allow-lists instance administrators before this is ever
 * consulted, so `admin` is a belt-and-braces mapping.
 */
export const INSTANCE_ROLE_PLATFORM_ROLE: Record<InstanceRole, Role> = {
  admin: 'admin',
  staff: 'maintainer',
  user: 'viewer',
};

const DEFAULT_SSO_SCOPE = 'openid email profile';

/** Fallback claim names per local field, used when `attribute_map` is empty. */
const DEFAULT_CLAIM_KEYS: Record<string, string[]> = {
  externalId: ['sub', 'user_id', 'uid', 'nameid', 'NameID', 'userNameId', 'saml.user_id'],
  email: ['email', 'mail', 'emailaddress', 'email_address', 'userprincipalname', 'upn'],
  username: ['preferred_username', 'uid', 'username', 'login', 'cn', 'saml.user_id'],
  displayName: ['name', 'displayname', 'given_name', 'cn', 'uid'],
  avatarUrl: ['picture', 'avatar_url', 'avatarurl', 'photo'],
};

/** Local field aliases accepted inside `attribute_map` values. */
const FIELD_ALIASES: Record<string, keyof MappedSsoClaims> = {
  externalid: 'externalId',
  external_id: 'externalId',
  sub: 'externalId',
  subject: 'externalId',
  userid: 'externalId',
  email: 'email',
  mail: 'email',
  username: 'username',
  preferred_username: 'username',
  login: 'username',
  displayname: 'displayName',
  display_name: 'displayName',
  name: 'displayName',
  avatarurl: 'avatarUrl',
  avatar_url: 'avatarUrl',
  picture: 'avatarUrl',
};

/** Anonymous principal: grants nothing, keeps the context shape total. */
const ANONYMOUS_ACTOR: Actor = {
  userId: asUserId(0),
  isInstanceAdmin: false,
  roles: [],
  projectRoles: new Map<ProjectId, Role>(),
};

/** SSO `state` parameter: provider round trip plus a post-login target. */
export interface SsoStatePayload {
  /** SAML `AuthnRequest/@ID`; echoed back as `InResponseTo` for replay defence. */
  requestId: string;
  provider: string;
  protocol: 'oidc' | 'saml';
  /** Same-origin path to land on after the callback; never an absolute URL. */
  redirect: string;
  nonce: string;
  issuedAt: number;
}

const SSO_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Build a tamper-evident, stateless OAuth `state`. There is no state table in
 * the schema, so the payload is HMAC-signed with the instance session secret.
 */
/** A fresh OIDC nonce, bound to this browser session via the signed state. */
export function newSsoNonce(): string {
  return generateToken(16);
}

/** A fresh SAML AuthnRequest ID, recorded in the signed state for replay defence. */
export function newSamlRequestId(): string {
  return `_${generateToken(16)}`;
}

export function createSsoState(secret: Buffer, payload: Omit<SsoStatePayload, 'issuedAt'>): string {
  const body: SsoStatePayload = { ...payload, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const signature = hmacSha256Hex(secret.toString('base64'), encoded);
  return `${encoded}.${signature}`;
}

/** Verify and decode a `state`, or `null` when it is forged or expired. */
export function readSsoState(secret: Buffer, state: string): SsoStatePayload | null {
  const separator = state.lastIndexOf('.');
  if (separator <= 0) return null;

  const encoded = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = hmacSha256Hex(secret.toString('base64'), encoded);
  if (!safeEqual(signature, expected)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = parsed as Partial<SsoStatePayload>;
    if (typeof payload.provider !== 'string' || typeof payload.issuedAt !== 'number') return null;
    if (Date.now() - payload.issuedAt > SSO_STATE_TTL_MS) return null;
    if (payload.issuedAt - Date.now() > SSO_STATE_TTL_MS) return null;
    return {
      provider: payload.provider,
      protocol: payload.protocol === 'saml' ? 'saml' : 'oidc',
      redirect: typeof payload.redirect === 'string' ? payload.redirect : '/',
      nonce: typeof payload.nonce === 'string' ? payload.nonce : '',
      // States issued before this field existed decode to an empty request id,
      // which the SAML path treats as "unsolicited" rather than trusted.
      requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
      issuedAt: payload.issuedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Only accept same-origin, path-relative redirect targets so the callback
 * cannot be turned into an open redirect.
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.includes('\\') || /[\r\n]/.test(value)) return '/';
  return value;
}

export class AuthService {
  /** Short-lived cache of each provider's published signing keys. */
  private readonly jwksCache = new JwksCache();

  private readonly services: Services;
  /**
   * A throw-away hash used to keep the "unknown user" branch of `login` as slow
   * as the "known user" one, so response timing does not disclose which
   * usernames exist.
   */
  private dummyHash: string | null = null;

  constructor(services: Services) {
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Registration & credentials
  // -------------------------------------------------------------------------

  /**
   * Create a local account and sign it in. The very first account on a fresh
   * instance becomes the instance administrator; every later registration is a
   * plain `user`.
   */
  async register(input: CreateUserInput, ctx: RequestMeta): Promise<AuthResult> {
    const data = registerSchema.parse(input);
    this.assertUsernameAvailable(data.username);
    this.assertEmailAvailable(data.email);

    const isFirstUser = this.countUsers() === 0;
    const instanceRole: InstanceRole = isFirstUser ? 'admin' : 'user';

    const user = this.services.db.transaction(() => {
      const created = this.insertUser({
        username: data.username,
        email: data.email,
        displayName: data.displayName,
        passwordHash: hashPassword(data.password),
        provider: 'local',
        instanceRole,
      });
      this.recordAudit(
        {
          action: 'user.created',
          entityType: 'user',
          entityId: created.id,
          after: { ...this.publicUser(created), instanceRole, isActive: true },
        },
        ctx,
      );
      return created;
    });

    const session = this.createSession(user.id, ctx);
    return { user: this.publicUser(user), sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  /**
   * Verify credentials against a username *or* an email and open a session.
   * Every failure path is indistinguishable from the outside and records an
   * `auth.login_failed` audit entry.
   */
  async login(login: string, password: string, ctx: RequestMeta): Promise<AuthResult> {
    const data = loginSchema.parse({ login, password });
    const row =
      this.services.db.get<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users
          WHERE lower(username) = lower(?) OR lower(email) = lower(?)`,
        [data.login, data.login],
      ) ?? undefined;

    const failed = (reason: string): never => {
      // Recorded outside any transaction so the entry survives the throw.
      this.recordAudit(
        { action: 'auth.login_failed', entityType: 'user', entityId: row?.id ?? null, after: { reason } },
        ctx,
      );
      throw unauthenticated('Invalid credentials');
    };

    if (!row) {
      // Burn roughly the same CPU as a real verification.
      this.dummyHash ??= hashPassword('not-a-real-password');
      verifyPassword(data.password, this.dummyHash);
      return failed('unknown account');
    }
    if (!verifyPassword(data.password, row.password_hash)) return failed('bad password');
    if (row.is_active !== 1) return failed('inactive account');

    const user = this.mapUser(row);
    const now = nowIso();

    this.services.db.transaction(() => {
      // Opportunistic cleanup; a stuck session is not worth a scheduled job.
      this.services.db.run('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?', [
        user.id,
        now,
      ]);
      this.services.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, user.id]);

      if (row.password_hash && needsPasswordRehash(row.password_hash)) {
        this.services.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
          hashPassword(data.password),
          user.id,
        ]);
      }

      this.recordAudit(
        { action: 'auth.login', entityType: 'user', entityId: user.id, after: { method: 'password' } },
        ctx,
      );
    });

    const session = this.createSession(user.id, ctx);
    return { user: this.publicUser(user), sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  /**
   * End one session. Safe to call with an unknown or already-expired id — the
   * route layer clears the cookie unconditionally.
   */
  async logout(sessionId: string, ctx: RequestMeta): Promise<void> {
    const key = this.sessionKey(sessionId);
    const row = this.services.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [key]);
    if (!row) return;

    this.services.db.transaction(() => {
      this.services.db.run('DELETE FROM sessions WHERE id = ?', [key]);
      this.recordAudit(
        { action: 'auth.logout', entityType: 'session', entityId: sessionId, after: { userId: row.user_id } },
        { ...ctx, audit: { ...ctx.audit, actorId: row.user_id } },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Open a session. Only `sha256(id)` is stored; the returned plaintext is the
   * value that belongs in the cookie.
   */
  createSession(
    userId: number,
    ctx: RequestMeta,
  ): { sessionId: string; expiresAt: string; key: string } {
    const sessionId = generateSessionId();
    const key = this.sessionKey(sessionId);
    const expiresAt = addMs(nowIso(), this.services.config.sessionTtlSeconds * 1000);

    this.services.db.run(
      `INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
       VALUES (?,?,?,?,?)`,
      [key, userId, ctx.ip ?? '', (ctx.userAgent ?? '').slice(0, 512), expiresAt],
    );

    return { sessionId, expiresAt, key };
  }

  /** Drop a single session. */
  destroySession(sessionId: string): void {
    this.services.db.run('DELETE FROM sessions WHERE id = ?', [this.sessionKey(sessionId)]);
  }

  /** Drop every session belonging to a user, optionally sparing one. */
  destroyUserSessions(userId: number, exceptSessionId?: string): number {
    if (exceptSessionId) {
      const result = this.services.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [
        userId,
        this.sessionKey(exceptSessionId),
      ]);
      return result.changes;
    }
    return this.services.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]).changes;
  }

  /**
   * Resolve a cookie value to its user. Expired sessions and deactivated users
   * resolve to `null`; a successful lookup refreshes `last_seen_at` so idle
   * session pruning has something meaningful to sort on.
   */
  async resolveSession(sessionId: string): Promise<StoredUser | null> {
    if (!sessionId) return null;
    const key = this.sessionKey(sessionId);
    const row = this.services.db.get<SessionJoinRow>(
      `SELECT s.expires_at AS expires_at,
              u.id AS id, u.username, u.email, u.display_name, u.avatar_url, u.password_hash,
              u.provider, u.instance_role, u.is_active, u.timezone, u.locale, u.email_opt_out,
              u.last_login_at, u.created_at AS created_at, u.updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      [key],
    );
    if (!row) return null;
    if (isPast(row.expires_at)) return null;
    if (row.is_active !== 1) return null;

    this.services.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), key]);
    return this.mapUser(row);
  }

  /** Look up a session row without touching `last_seen_at`. */
  getSession(sessionId: string): Session | null {
    const row = this.services.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [
      this.sessionKey(sessionId),
    ]);
    return row ? this.mapSession(row) : null;
  }

  // -------------------------------------------------------------------------
  // API tokens
  // -------------------------------------------------------------------------

  /**
   * Resolve a bearer token to its owner. Revoked, expired and token-less rows
   * never match, and a successful use refreshes `last_used_at`.
   */
  async authenticateApiToken(rawToken: string): Promise<StoredUser | null> {
    const resolved = this.resolveApiToken(rawToken);
    return resolved ? resolved.user : null;
  }

  /**
   * Like {@link authenticateApiToken} but also returns the token row, so the
   * request pipeline can narrow the actor to the token's `project_ids`.
   */
  resolveApiToken(rawToken: string): { user: StoredUser; token: ApiToken } | null {
    if (!rawToken) return null;
    const row = this.services.db.get<ApiTokenJoinRow>(
      `SELECT t.id AS id, t.name AS name, t.prefix AS prefix, t.scopes AS scopes,
              t.project_ids AS project_ids, t.expires_at AS expires_at,
              t.last_used_at AS last_used_at, t.revoked_at AS revoked_at,
              t.created_at AS token_created_at,
              u.id AS user_id, u.username, u.email, u.display_name, u.avatar_url, u.password_hash,
              u.provider, u.instance_role, u.is_active, u.timezone, u.locale, u.email_opt_out,
              u.last_login_at, u.created_at, u.updated_at
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?
          AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?)`,
      [hashToken(rawToken), nowIso()],
    );
    if (!row) return null;
    if (row.is_active !== 1) return null;

    this.services.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), row.id]);
    return {
      user: this.mapUser(row),
      token: this.mapApiToken({
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        prefix: row.prefix,
        token_hash: '',
        scopes: row.scopes,
        project_ids: row.project_ids,
        expires_at: row.expires_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
        created_at: row.token_created_at,
      }),
    };
  }

  /**
   * Mint a long-lived token. The secret is returned exactly once — the database
   * only ever receives `sha256(secret)`.
   */
  createApiToken(
    userId: number,
    input: CreateApiTokenInput,
    ctx: RequestMeta,
  ): { token: ApiToken; secret: string } {
    const data = createApiTokenSchema.parse(input);
    const secret = generateToken();
    const prefix = tokenPrefix(secret);

    const created = this.services.db.transaction(() => {
      const result = this.services.db.run(
        `INSERT INTO api_tokens (user_id, name, prefix, token_hash, scopes, project_ids, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          userId,
          data.name,
          prefix,
          hashToken(secret),
          JSON.stringify(data.scopes),
          JSON.stringify(data.projectIds),
          data.expiresAt,
        ],
      );
      const row = this.services.db.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?', [
        result.lastInsertRowid,
      ]);
      if (!row) throw internalError('Failed to persist the newly created API token');
      const token = this.mapApiToken(row);
      this.recordAudit(
        {
          action: 'auth.token_created',
          entityType: 'api_token',
          entityId: token.id,
          after: {
            name: token.name,
            prefix: token.prefix,
            scopes: token.scopes,
            projectIds: token.projectIds,
            expiresAt: token.expiresAt,
          },
        },
        ctx,
      );
      return token;
    });

    return { token: created, secret };
  }

  /** Revoke a token the caller owns. */
  revokeApiToken(userId: number, tokenId: number, ctx: RequestMeta): void {
    const row = this.services.db.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?', [
      tokenId,
      userId,
    ]);
    if (!row) throw notFound('API token', tokenId);
    if (row.revoked_at !== null) return;

    this.services.db.transaction(() => {
      const revokedAt = nowIso();
      this.services.db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', [revokedAt, tokenId]);
      this.recordAudit(
        {
          action: 'auth.token_revoked',
          entityType: 'api_token',
          entityId: tokenId,
          before: { revokedAt: null },
          after: { revokedAt },
        },
        ctx,
      );
    });
  }

  /** List the caller's tokens. The secret is not recoverable by design. */
  listApiTokens(userId: number): ApiToken[] {
    return this.services.db
      .all<ApiTokenRow>('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', [userId])
      .map((row) => this.mapApiToken(row));
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /** Load one user, or `null`. */
  getUser(id: number): StoredUser | null {
    const row = this.services.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
    return row ? this.mapUser(row) : null;
  }

  /** Load one user or throw `notFound`. */
  requireUser(id: number): StoredUser {
    const user = this.getUser(id);
    if (!user) throw notFound('User', id);
    return user;
  }

  /**
   * Directory listing for the administration screens. Active users only unless
   * `includeInactive` is set, so a deactivated account is hidden by default.
   */
  listUsers(ctx: RequestMeta, options: ListUserOptions = {}): StoredUser[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    if (!options.includeInactive) clauses.push('is_active = 1');
    if (options.search) {
      clauses.push('(lower(username) LIKE ? OR lower(email) LIKE ? OR lower(display_name) LIKE ?)');
      const needle = `%${options.search.toLowerCase()}%`;
      params.push(needle, needle, needle);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);

    return this.services.db
      .all<UserRow>(`SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY username ASC LIMIT ?`, [
        ...params,
        limit,
      ])
      .map((row) => this.mapUser(row));
  }

  /** Administrative creation. Does not open a session. */
  createUser(input: CreateUserInput, ctx: RequestMeta, options: { instanceRole?: InstanceRole } = {}): StoredUser {
    const data = registerSchema.parse(input);
    this.assertUsernameAvailable(data.username);
    this.assertEmailAvailable(data.email);

    return this.services.db.transaction(() => {
      const user = this.insertUser({
        username: data.username,
        email: data.email,
        displayName: data.displayName,
        passwordHash: hashPassword(data.password),
        provider: 'local',
        instanceRole: options.instanceRole ?? 'user',
      });
      this.recordAudit(
        {
          action: 'user.created',
          entityType: 'user',
          entityId: user.id,
          after: { ...this.publicUser(user), instanceRole: options.instanceRole ?? 'user' },
        },
        ctx,
      );
      return user;
    });
  }

  /** Self-service profile edits. Only the whitelisted columns are writable. */
  updateProfile(userId: number, patch: UpdateProfileInput, ctx: RequestMeta): StoredUser {
    const data = updateProfileSchema.parse(patch);
    const before = this.requireUser(userId);

    const entries: Array<[string, SqlParam]> = [];
    if (data.displayName !== undefined) entries.push(['display_name', data.displayName]);
    if (data.avatarUrl !== undefined) entries.push(['avatar_url', data.avatarUrl]);
    if (data.timezone !== undefined) entries.push(['timezone', data.timezone]);
    if (data.locale !== undefined) entries.push(['locale', data.locale]);

    return this.applyUserPatch(userId, before, entries, 'user.updated', ctx);
  }

  /** Administrative edits, including role and activation. */
  updateUser(id: number, patch: UpdateUserPatch, ctx: RequestMeta): StoredUser {
    const before = this.requireUser(id);
    if (patch.username !== undefined) this.assertUsernameAvailable(patch.username, id);
    if (patch.email !== undefined) this.assertEmailAvailable(patch.email, id);

    const entries: Array<[string, SqlParam]> = [];
    if (patch.displayName !== undefined) entries.push(['display_name', patch.displayName]);
    if (patch.username !== undefined) entries.push(['username', patch.username]);
    if (patch.email !== undefined) entries.push(['email', patch.email]);
    if (patch.avatarUrl !== undefined) entries.push(['avatar_url', patch.avatarUrl]);
    if (patch.timezone !== undefined) entries.push(['timezone', patch.timezone]);
    if (patch.locale !== undefined) entries.push(['locale', patch.locale]);
    if (patch.isActive !== undefined) entries.push(['is_active', patch.isActive ? 1 : 0]);
    if (patch.instanceRole !== undefined) entries.push(['instance_role', patch.instanceRole]);
    if (patch.password !== undefined) entries.push(['password_hash', hashPassword(patch.password)]);

    const action: AuditAction =
      patch.instanceRole !== undefined && patch.instanceRole !== before.instanceRole
        ? 'user.role_changed'
        : 'user.updated';

    const updated = this.applyUserPatch(id, before, entries, action, ctx);
    if (patch.isActive === false) this.destroyUserSessions(id);
    return updated;
  }

  /**
   * Deactivate an account and cut its sessions. The row is kept so issue
   * history still points at a real person.
   */
  deactivateUser(id: number, ctx: RequestMeta): StoredUser {
    const before = this.requireUser(id);
    if (before.isActive === false) return before;

    const updated = this.services.db.transaction(() => {
      this.services.db.run(
        'UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?',
        [nowIso(), id],
      );
      this.destroyUserSessions(id);
      const after = this.requireUser(id);
      this.recordAudit(
        {
          action: 'user.deactivated',
          entityType: 'user',
          entityId: id,
          before: { isActive: true },
          after: { isActive: false },
        },
        ctx,
      );
      return after;
    });

    return updated;
  }

  /** Reactivate a previously deactivated account. */
  activateUser(id: number, ctx: RequestMeta): StoredUser {
    const before = this.requireUser(id);
    if (before.isActive) return before;
    return this.updateUser(id, { isActive: true }, ctx);
  }

  /**
   * Change a password after proving knowledge of the current one. Every other
   * session for the account is destroyed, so a stolen cookie cannot outlive the
   * rotation.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    ctx: RequestMeta,
    options: { keepSessionId?: string } = {},
  ): Promise<void> {
    const data = changePasswordSchema.parse({ currentPassword, newPassword });
    const row = this.services.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [userId]);
    if (!row) throw notFound('User', userId);
    if (!verifyPassword(data.currentPassword, row.password_hash)) {
      this.recordAudit(
        { action: 'auth.login_failed', entityType: 'user', entityId: userId, after: { reason: 'password change without the current password' } },
        ctx,
      );
      throw unauthenticated('The current password is incorrect');
    }

    let revoked = 0;
    this.services.db.transaction(() => {
      this.services.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
        hashPassword(data.newPassword),
        nowIso(),
        userId,
      ]);
      revoked = this.destroyUserSessions(userId, options.keepSessionId);
      this.recordAudit(
        {
          action: 'user.updated',
          entityType: 'user',
          entityId: userId,
          before: { passwordHash: '[redacted]' },
          after: { passwordHash: '[redacted]', revokedSessions: revoked },
        },
        ctx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Actor projection
  // -------------------------------------------------------------------------

  /**
   * Build the `Actor` every guard consumes: instance-admin flag, platform
   * roles derived from `instance_role`, and per-project membership roles.
   */
  async buildActor(user: User, projectRolesOverride?: ReadonlyMap<ProjectId, Role>): Promise<Actor> {
    const projectRoles = projectRolesOverride ?? (await this.listProjectRoles(user.id));
    return {
      userId: user.id,
      isInstanceAdmin: user.isInstanceAdmin,
      roles: [INSTANCE_ROLE_PLATFORM_ROLE[instanceRoleOf(user)]],
      projectRoles,
    };
  }

  /** Per-project membership roles, used to build an `Actor`. */
  async listProjectRoles(userId: number): Promise<Map<ProjectId, Role>> {
    const rows = this.services.db.all<{ project_id: number; role: string }>(
      'SELECT project_id, role FROM project_members WHERE user_id = ?',
      [userId],
    );
    const roles = new Map<ProjectId, Role>();
    for (const row of rows) {
      roles.set(asProjectId(row.project_id), row.role as Role);
    }
    return roles;
  }

  // -------------------------------------------------------------------------
  // SSO
  // -------------------------------------------------------------------------

  /** Enabled IdP configurations, for the login screen. */
  listEnabledSsoConfigurations(): SsoConfiguration[] {
    return this.services.db
      .all<SsoRow>(`SELECT ${SSO_COLUMNS} FROM sso_configurations WHERE enabled = 1 ORDER BY is_default DESC, name ASC`)
      .map((row) => this.mapSso(row));
  }

  /** All configurations, enabled or not. Administrator view. */
  listSsoConfigurations(): SsoConfiguration[] {
    return this.services.db
      .all<SsoRow>(`SELECT ${SSO_COLUMNS} FROM sso_configurations ORDER BY name ASC`)
      .map((row) => this.mapSso(row));
  }

  /** Find an enabled configuration by its (path-safe) name. */
  findSsoConfigurationByName(name: string): SsoConfiguration | null {
    const row = this.services.db.get<SsoRow>(
      `SELECT ${SSO_COLUMNS} FROM sso_configurations WHERE name = ? AND enabled = 1`,
      [name],
    );
    return row ? this.mapSso(row) : null;
  }

  /** Default enabled configuration, used when the UI has no picker. */
  findDefaultSsoConfiguration(): SsoConfiguration | null {
    const row = this.services.db.get<SsoRow>(
      `SELECT ${SSO_COLUMNS} FROM sso_configurations WHERE enabled = 1 AND is_default = 1 LIMIT 1`,
    );
    return row ? this.mapSso(row) : null;
  }

  /** The callback URL this instance advertises to an IdP. */
  ssoRedirectUri(providerName: string): string {
    return `${this.services.config.publicUrl.replace(/\/$/, '')}/api/auth/sso/${encodeURIComponent(providerName)}/callback`;
  }

  /**
   * Build the OIDC authorization URL. No PKCE: the code exchange below is
   * confidential-client only, so a public client must not use this endpoint
   * until `code_verifier` is threaded through the signed state.
   */
  buildAuthorizationUrl(sso: SsoConfiguration, state: string, redirectUri: string): string {
    if (!sso.authorizationEndpoint) {
      throw badRequest(`SSO provider "${sso.name}" has no authorization endpoint configured`);
    }
    if (!sso.clientId) {
      throw badRequest(`SSO provider "${sso.name}" has no client id configured`);
    }

    const url = new URL(sso.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', sso.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', DEFAULT_SSO_SCOPE);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Build an unsigned, deflated SAML 2.0 AuthnRequest (HTTP-Redirect binding). */
  buildSamlRedirectUrl(
    sso: SsoConfiguration,
    relayState: string,
    /** Supplied by the caller so it can be recorded in the signed state. */
    requestId = newSamlRequestId(),
  ): string {
    if (!sso.ssoUrl) throw badRequest(`SSO provider "${sso.name}" has no SSO URL configured`);

    const issueInstant = nowIso();
    const destination = escapeXml(sso.ssoUrl);
    const acs = escapeXml(this.ssoRedirectUri(sso.name));
    const issuer = escapeXml(sso.entityId ?? `${this.services.config.publicUrl}/api/auth/sso/${encodeURIComponent(sso.name)}`);

    const xml =
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${escapeXml(requestId)}" Version="2.0" IssueInstant="${issueInstant}" ` +
      `Destination="${destination}" AssertionConsumerServiceURL="${acs}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
      `<saml:Issuer>${issuer}</saml:Issuer></samlp:AuthnRequest>`;

    const url = new URL(sso.ssoUrl);
    url.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'));
    url.searchParams.set('RelayState', relayState);
    return url.toString();
  }

  /**
   * SP metadata document for a SAML IdP to import.
   */
  buildSamlMetadata(sso: SsoConfiguration): string {
    const entityId = escapeXml(sso.entityId ?? this.ssoRedirectUri(sso.name));
    const acs = escapeXml(this.ssoRedirectUri(sso.name));
    const idpSso = sso.ssoUrl ? escapeXml(sso.ssoUrl) : '';

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">\n` +
      `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" ` +
      `protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n` +
      `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\n` +
      (idpSso
        ? `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ` +
          `Location="${acs}" index="0" isDefault="true"/>\n`
        : '') +
      `  </md:SPSSODescriptor>\n` +
      `  <md:Organization><md:OrganizationName xml:lang="en">Issue Tracker</md:OrganizationName>` +
      `<md:OrganizationDisplayName xml:lang="en">Issue Tracker</md:OrganizationDisplayName>` +
      `<md:OrganizationURL xml:lang="en">${escapeXml(this.services.config.publicUrl)}</md:OrganizationURL></md:Organization>\n` +
      `</md:EntityDescriptor>\n`
    );
  }

  /**
   * Structurally parse a base64 SAMLResponse into a flat claim record.
   *
   * SECURITY: this reads the document the browser handed us. It does **not**
   * verify the XML signature against `sso.idp_certificate`, and it is not
   * capable of detecting a forged assertion. Signature verification (XML-DSIG
   * over the signed element, issuer/audience checks and replay protection) MUST
   * be added before an external IdP is trusted. See `consumeSsoCallback`.
   */
  parseSamlAssertion(
    sso: SsoConfiguration,
    xml: string,
    options: { inResponseTo?: string | null; allowUnsolicited?: boolean } = {},
  ): Record<string, unknown> {
    const certificate = this.readIdpCertificate(sso);
    if (!certificate) {
      throw integrationError(
        'This SAML provider has no IdP certificate configured, so its assertions cannot be verified',
      );
    }

    const verified = verifySamlResponse({
      xml,
      idpCertificate: certificate,
      expectedAudience: this.ssoEntityId(),
      expectedInResponseTo: options.inResponseTo ?? null,
      allowUnsolicited: options.allowUnsolicited ?? false,
    });

    // Claims are flattened so `mapSsoClaims` can consume them the same way it
    // consumes OIDC claims.
    const claims: Record<string, unknown> = {
      nameid: verified.nameId,
      inResponseTo: verified.inResponseTo,
    };
    if (verified.notOnOrAfter) claims['notOnOrAfter'] = verified.notOnOrAfter.toISOString();
    if (verified.issuer) claims['issuer'] = verified.issuer;
    for (const [key, value] of Object.entries(verified.attributes)) {
      claims[key] = value;
      claims[key.toLowerCase()] = value;
    }
    return claims;
  }

  /** Map raw IdP claims onto local fields using `attribute_map`. */
  mapSsoClaims(sso: SsoConfiguration, claims: Record<string, unknown>): MappedSsoClaims {
    const lowered = new Map<string, unknown>();
    for (const [key, value] of Object.entries(claims)) lowered.set(key.toLowerCase(), value);

    const mapped: Partial<Record<keyof MappedSsoClaims, string>> = {};
    for (const [claimKey, field] of Object.entries(sso.attributeMap)) {
      const canonical = FIELD_ALIASES[field.trim().toLowerCase()];
      if (!canonical) continue;
      const value = claims[claimKey] ?? lowered.get(claimKey.toLowerCase());
      if (typeof value === 'string' && value.trim() !== '') mapped[canonical] = value.trim();
    }

    for (const [field, candidates] of Object.entries(DEFAULT_CLAIM_KEYS)) {
      const canonical = FIELD_ALIASES[field];
      if (!canonical || mapped[canonical] !== undefined) continue;
      for (const candidate of candidates) {
        const value = claims[candidate] ?? lowered.get(candidate.toLowerCase());
        if (typeof value === 'string' && value.trim() !== '') {
          mapped[canonical] = value.trim();
          break;
        }
      }
    }

    const email = mapped.email ?? null;
    if (email && !mapped.username) {
      const localPart = email.split('@')[0];
      if (localPart) mapped.username = localPart;
    }

    return {
      externalId: mapped.externalId ?? null,
      email,
      username: mapped.username ?? null,
      displayName: mapped.displayName ?? null,
      avatarUrl: mapped.avatarUrl ?? null,
      raw: claims,
    };
  }

  /**
   * Turn protocol-level claims into a local session.
   *
   * SECURITY: the incoming claims are trusted as-is. The OIDC path does not
   * verify the `id_token` signature against the JWKS and the SAML path does not
   * verify the assertion signature against `sso.idp_certificate`; both are
   * deliberately out of scope here and MUST be added before an external IdP is
   * trusted in production. Every other control (domain allow-list,
   * auto-provisioning, identity linking) is enforced below.
   */
  async consumeSsoCallback(
    sso: SsoConfiguration,
    claims: Record<string, unknown>,
    ctx: RequestMeta,
  ): Promise<AuthResult> {
    const provider = sso.protocol as AuthProvider;
    const mapped = this.mapSsoClaims(sso, claims);

    if (!mapped.externalId) {
      throw unauthenticated('The identity provider did not supply a stable subject identifier');
    }
    if (!mapped.email) {
      throw unauthenticated('The identity provider did not supply an email address');
    }
    if (!this.isEmailDomainAllowed(sso, mapped.email)) {
      const domain = mapped.email.split('@')[1] ?? mapped.email;
      throw forbidden(`Accounts from ${domain} may not sign in to this instance`);
    }
    if (typeof claims['notOnOrAfter'] === 'string' && isPast(claims['notOnOrAfter'])) {
      throw unauthenticated('The identity assertion has expired');
    }

    const identity = this.services.db.get<ExternalIdentityRow>(
      'SELECT * FROM external_identities WHERE provider = ? AND external_id = ?',
      [provider, mapped.externalId],
    );

    const user = this.services.db.transaction(() => {
      let resolved: StoredUser | null;
      if (identity) {
        resolved = this.getUser(identity.user_id);
      } else {
        const existing = this.services.db.get<UserRow>(
          'SELECT * FROM users WHERE lower(email) = lower(?)',
          [mapped.email as string],
        );
        if (existing) {
          resolved = this.mapUser(existing);
        } else if (sso.autoProvision) {
          resolved = this.insertUser({
            username: this.uniqueUsername(mapped.username ?? (mapped.email as string).split('@')[0] ?? 'user'),
            email: mapped.email as string,
            displayName: mapped.displayName ?? (mapped.email as string).split('@')[0] ?? 'User',
            passwordHash: null,
            provider,
            instanceRole: 'user',
            avatarUrl: mapped.avatarUrl,
          });
          this.recordAudit(
            {
              action: 'user.created',
              entityType: 'user',
              entityId: resolved.id,
              after: { ...this.publicUser(resolved), provisionedBy: `sso:${sso.name}` },
            },
            ctx,
          );
        } else {
          throw forbidden('No account is linked to this identity. Ask an administrator for access.');
        }
      }

      if (!resolved) throw notFound('User');
      if (!resolved.isActive) throw forbidden('This account has been deactivated');

      const now = nowIso();
      this.services.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, resolved.id]);
      this.upsertExternalIdentity(resolved.id, provider, mapped.externalId as string, mapped.username, ctx);
      this.recordAudit(
        {
          action: 'auth.login',
          entityType: 'user',
          entityId: resolved.id,
          after: { method: provider, provider: sso.name },
        },
        ctx,
      );

      return { ...resolved, lastLoginAt: now };
    });

    const session = this.createSession(user.id, ctx);
    return { user: this.publicUser(user), sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  /**
   * Exchange an OIDC authorization code for claims.
   *
   * SECURITY: the `id_token` returned by the token endpoint is decoded but not
   * signature-verified against `jwks_uri`, and the `state`/`nonce` round trip is
   * not bound to a browser session. Both checks must be added before an
   * external IdP is trusted.
   */
  async exchangeOidcCode(
    sso: SsoConfiguration,
    code: string,
    redirectUri: string,
    /** Nonce issued in the signed `state`; bound to this browser session. */
    nonce?: string | null,
  ): Promise<Record<string, unknown>> {
    if (!sso.tokenEndpoint) {
      throw badRequest(`SSO provider "${sso.name}" has no token endpoint configured`);
    }

    const secret = this.readClientSecret(sso);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: sso.clientId ?? '',
    });
    if (secret) body.set('client_secret', secret);

    let payload: Record<string, unknown>;
    try {
      const response = await fetch(sso.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
      if (!response.ok) {
        throw integrationError(`Token endpoint responded with ${response.status}`, {
          provider: sso.name,
          status: response.status,
        });
      }
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw integrationError(`Could not reach the token endpoint for "${sso.name}"`, {
        provider: sso.name,
      });
    }

    const accessToken =
      typeof payload['access_token'] === 'string' ? payload['access_token'] : null;

    // The `id_token` is verified before any claim is read. If it checks out we
    // still prefer userinfo, because the endpoint is authoritative and returns
    // a fresh, normalised view of the subject.
    if (typeof payload['id_token'] === 'string') {
      const claims = await this.verifyOidcIdToken(sso, payload['id_token'], nonce);

      if (sso.userinfoEndpoint && accessToken) {
        try {
          const response = await fetch(sso.userinfoEndpoint, {
            headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
          });
          if (!response.ok) {
            throw integrationError(`Userinfo endpoint responded with ${response.status}`, {
              provider: sso.name,
              status: response.status,
            });
          }
          return (await response.json()) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof Error && error.name === 'AppError') throw error;
          throw integrationError(`Could not reach the userinfo endpoint for "${sso.name}"`, {
            provider: sso.name,
          });
        }
      }

      return claims as Record<string, unknown>;
    }

    throw integrationError(`SSO provider "${sso.name}" returned no usable identity claims`);
  }

  /**
   * Verify an OIDC ID token's signature and claims against the provider's JWKS.
   *
   * A token that cannot be verified is a hard failure: silently falling back to
   * the unverified claims is the vulnerability this closes.
   */
  async verifyOidcIdToken(
    sso: SsoConfiguration,
    idToken: string,
    nonce?: string | null,
  ): Promise<JwtClaims> {
    if (!sso.jwksUri) {
      throw integrationError(
        `SSO provider "${sso.name}" has no JWKS URI configured, so its ID tokens cannot be verified`,
      );
    }
    if (!sso.issuer) {
      throw integrationError(
        `SSO provider "${sso.name}" has no issuer configured, so the token's issuer cannot be checked`,
      );
    }
    if (!sso.clientId) {
      throw integrationError(
        `SSO provider "${sso.name}" has no client id, so the token's audience cannot be checked`,
      );
    }

    const jwks = await this.jwksCache.get(sso.jwksUri);
    try {
      return verifyIdToken(idToken, jwks, {
        issuer: sso.issuer,
        audience: sso.clientId,
        nonce: nonce ?? null,
      });
    } catch (error) {
      // A key-id mismatch is the common symptom of a rotation. Drop the cache
      // so the retry sees the new set rather than repeating the failure.
      if (error instanceof AppError && /key id/i.test(error.message)) {
        this.jwksCache.invalidate(sso.jwksUri);
      }
      throw error;
    }
  }

  /** Link a federated identity to a local user, creating the row if needed. */
  upsertExternalIdentity(
    userId: number,
    provider: AuthProvider,
    externalId: string,
    username: string | null,
    ctx: RequestMeta,
  ): ExternalIdentity {
    const now = nowIso();
    this.services.db.run(
      `INSERT INTO external_identities
         (user_id, provider, external_id, external_username, last_login_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT (provider, external_id)
       DO UPDATE SET user_id = excluded.user_id,
                     external_username = excluded.external_username,
                     last_login_at = excluded.last_login_at`,
      [userId, provider, externalId, username, now],
    );

    const row = this.services.db.get<ExternalIdentityRow>(
      'SELECT * FROM external_identities WHERE provider = ? AND external_id = ?',
      [provider, externalId],
    );
    if (!row) throw internalError('Failed to persist the external identity');

    this.recordAudit(
      {
        action: 'user.updated',
        entityType: 'user',
        entityId: userId,
        after: { provider, externalId, externalUsername: username },
      },
      ctx,
    );

    return this.mapExternalIdentity(row);
  }

  /** Federated identities linked to a user. */
  listExternalIdentities(userId: number): ExternalIdentity[] {
    return this.services.db
      .all<ExternalIdentityRow>('SELECT * FROM external_identities WHERE user_id = ? ORDER BY id', [userId])
      .map((row) => this.mapExternalIdentity(row));
  }

  // -------------------------------------------------------------------------
  // Bootstrapping
  // -------------------------------------------------------------------------

  /**
   * Seed the first administrator from `BOOTSTRAP_ADMIN_EMAIL` /
   * `BOOTSTRAP_ADMIN_PASSWORD`. Idempotent: it does nothing once any instance
   * administrator exists, and it promotes a pre-existing account rather than
   * creating a duplicate. Called once during startup.
   */
  ensureBootstrapAdmin(): StoredUser | null {
    const email = this.services.config.bootstrapAdminEmail;
    const password = this.services.config.bootstrapAdminPassword;
    if (!email || !password) return null;

    const existingAdmin = this.services.db.get<UserRow>(
      "SELECT * FROM users WHERE instance_role = 'admin' LIMIT 1",
    );
    if (existingAdmin) return null;

    const now = nowIso();
    const user = this.services.db.transaction(() => {
      const existing = this.services.db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', [
        email,
      ]);
      if (existing) {
        this.services.db.run(
          "UPDATE users SET instance_role = 'admin', is_active = 1, updated_at = ? WHERE id = ?",
          [now, existing.id],
        );
        this.recordAudit(
          {
            action: 'user.role_changed',
            entityType: 'user',
            entityId: existing.id,
            before: { instanceRole: existing.instance_role },
            after: { instanceRole: 'admin', reason: 'bootstrap' },
          },
          { ip: 'system', userAgent: 'bootstrap' },
        );
        return this.mapUser(
          this.services.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [existing.id]) as UserRow,
        );
      }

      const localPart = email.split('@')[0] ?? 'admin';
      const created = this.insertUser({
        username: this.uniqueUsername(localPart),
        email,
        displayName: 'Administrator',
        passwordHash: hashPassword(password),
        provider: 'local',
        instanceRole: 'admin',
      });
      this.recordAudit(
        {
          action: 'user.created',
          entityType: 'user',
          entityId: created.id,
          after: { ...this.publicUser(created), instanceRole: 'admin', reason: 'bootstrap' },
        },
        { ip: 'system', userAgent: 'bootstrap' },
      );
      return created;
    });

    return user;
  }

  /** The principal used for requests that carried no credentials. */
  static anonymousActor(): Actor {
    return ANONYMOUS_ACTOR;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** `sessions.id` stores the digest, never the cookie value. */
  private sessionKey(sessionId: string): string {
    return hashToken(sessionId);
  }

  private countUsers(): number {
    return Number(this.services.db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0);
  }

  private assertUsernameAvailable(username: string, exceptId?: number): void {
    const row = this.services.db.get<{ id: number }>(
      'SELECT id FROM users WHERE lower(username) = lower(?)',
      [username],
    );
    if (row && row.id !== exceptId) throw conflict('That username is already taken');
  }

  private assertEmailAvailable(email: string, exceptId?: number): void {
    const row = this.services.db.get<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [
      email,
    ]);
    if (row && row.id !== exceptId) throw conflict('That email address is already registered');
  }

  private insertUser(input: {
    username: string;
    email: string;
    displayName: string;
    passwordHash: string | null;
    provider: AuthProvider;
    instanceRole: InstanceRole;
    avatarUrl?: string | null;
  }): StoredUser {
    const now = nowIso();
    const result = this.services.db.run(
      `INSERT INTO users
         (username, email, display_name, avatar_url, password_hash, provider, instance_role, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
      [
        input.username,
        input.email,
        input.displayName,
        input.avatarUrl ?? null,
        input.passwordHash,
        input.provider,
        input.instanceRole,
        now,
        now,
      ],
    );

    const row = this.services.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [
      result.lastInsertRowid,
    ]);
    if (!row) throw internalError('Failed to persist the newly created user');
    return this.mapUser(row);
  }

  /**
   * Shared UPDATE path. Column names come from this file's own literal
   * allowlist — never from the request — and every value is bound.
   */
  private applyUserPatch(
    id: number,
    before: StoredUser,
    entries: Array<[string, SqlParam]>,
    action: AuditAction,
    ctx: RequestMeta,
  ): StoredUser {
    if (entries.length === 0) return before;

    return this.services.db.transaction(() => {
      const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
      this.services.db.run(
        `UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`,
        [...entries.map(([, value]) => value), nowIso(), id],
      );
      const after = this.requireUser(id);
      this.recordAudit(
        { action, entityType: 'user', entityId: id, before: this.publicUser(before), after: this.publicUser(after) },
        ctx,
      );
      return after;
    });
  }

  private uniqueUsername(base: string): string {
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 48) || 'user';
    let candidate = cleaned.length >= 3 ? cleaned : `${cleaned}user`;
    let suffix = 1;
    while (
      this.services.db.get('SELECT id FROM users WHERE lower(username) = lower(?)', [candidate])
    ) {
      candidate = `${cleaned.slice(0, 44)}${suffix}`;
      suffix += 1;
      if (suffix > 999) {
        candidate = `user${generateToken(4).toLowerCase()}`;
        break;
      }
    }
    return candidate;
  }

  private isEmailDomainAllowed(sso: SsoConfiguration, email: string): boolean {
    if (sso.allowedDomains.length === 0) return true;
    const domain = (email.split('@')[1] ?? '').toLowerCase();
    return sso.allowedDomains.some((allowed) => allowed.trim().toLowerCase() === domain);
  }

  private readClientSecret(sso: SsoConfiguration): string | null {
    if (!sso.clientSecretEncrypted) return null;
    try {
      return decrypt(sso.clientSecretEncrypted, this.services.config.encryptionKey);
    } catch (error) {
      throw integrationError(`The stored client secret for "${sso.name}" could not be decrypted`);
    }
  }

  /**
   * The IdP's signing certificate, PEM or bare base64, as stored.
   *
   * Required for SAML: without it the assertion cannot be verified, and an
   * unverifiable assertion is refused rather than trusted.
   */
  private readIdpCertificate(sso?: SsoConfiguration): string | null {
    const configured = sso?.idpCertificate ?? null;
    return configured && configured.trim().length > 0 ? configured : null;
  }

  /**
   * This service provider's entity ID, used to check `AudienceRestriction`.
   *
   * The IdP compares the audience against whatever entity ID was advertised in
   * our AuthnRequest, which is the callback URL we expose.
   */
  private ssoEntityId(): string {
    const configured = process.env['SAML_ENTITY_ID'];
    if (configured && configured.length > 0) return configured;
    return this.ssoRedirectUri('default').replace(/\/default\/callback$/, '/callback');
  }

  /** Strip the password hash before anything leaves the service. */
  private publicUser(user: StoredUser): Omit<User, 'passwordHash'> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }

  private recordAudit(
    input: Parameters<Services['audit']['record']>[0],
    ctx: RequestMeta,
  ): void {
    const fallback: RequestAuditContext = {
      ipAddress: ctx.ip || 'system',
      userAgent: ctx.userAgent ?? '',
    };
    this.services.audit.record(input, { ...fallback, ...ctx.audit });
  }

  // -- row mapping -----------------------------------------------------------

  private mapUser(row: UserRow): StoredUser {
    return {
      id: asUserId(row.id),
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
      provider: row.provider as AuthProvider,
      isInstanceAdmin: row.instance_role === 'admin',
      isActive: row.is_active === 1,
      timezone: row.timezone,
      locale: row.locale,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // `instance_role` is not part of the shared `User` shape, but RBAC needs
      // it to derive the platform role, so it travels alongside the object.
      instanceRole: row.instance_role as InstanceRole,
    };
  }

  private mapSession(row: SessionRow): Session {
    return {
      id: row.id,
      userId: asUserId(row.user_id),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  private mapApiToken(row: ApiTokenRow): ApiToken {
    return {
      id: row.id,
      userId: asUserId(row.user_id),
      name: row.name,
      prefix: row.prefix,
      scopes: parseStringArray(row.scopes),
      projectIds: parseNumberArray(row.project_ids).map(asProjectId),
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  private mapSso(row: SsoRow): SsoConfiguration {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol as SsoConfiguration['protocol'],
      enabled: row.enabled === 1,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecretEncrypted: row.client_secret_encrypted,
      authorizationEndpoint: row.authorization_endpoint,
      tokenEndpoint: row.token_endpoint,
      userinfoEndpoint: row.userinfo_endpoint,
      jwksUri: row.jwks_uri,
      entityId: row.entity_id,
      ssoUrl: row.sso_url,
      idpCertificate: row.idp_certificate,
      attributeMap: parseRecord(row.attribute_map),
      allowedDomains: parseStringArray(row.allowed_domains),
      autoProvision: row.auto_provision === 1,
      defaultRole: (row.default_role || 'viewer') as Role,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapExternalIdentity(row: ExternalIdentityRow): ExternalIdentity {
    return {
      id: row.id,
      userId: asUserId(row.user_id),
      provider: row.provider as AuthProvider,
      externalId: row.external_id,
      externalUsername: row.external_username,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/**
 * Read the instance role off a user object. Rows produced by this service carry
 * it; a `User` assembled elsewhere falls back to the derived admin flag.
 */
function instanceRoleOf(user: User): InstanceRole {
  return isStoredUser(user) ? user.instanceRole : user.isInstanceAdmin ? 'admin' : 'user';
}

function isStoredUser(user: User): user is StoredUser {
  return typeof (user as Partial<StoredUser>).instanceRole === 'string';
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}

function parseRecord(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const output: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === 'string') output[key] = entry;
    }
    return output;
  } catch {
    return {};
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Decode a JWT payload. Does **not** verify the signature — see the caller. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.');
  const payloadSegment = segments[1];
  if (!payloadSegment) throw integrationError('The identity token is malformed');
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw integrationError('The identity token payload could not be decoded');
  }
}
