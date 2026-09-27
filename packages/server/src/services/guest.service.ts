/**
 * Time-bound guest access.
 *
 * A guest token is a shareable link that grants a *synthetic* principal
 * standing in exactly one project, at `viewer` or `reporter`. There is no user
 * row behind it, so `redeem` builds an `Actor` whose `projectRoles` map holds
 * that single project and nothing else: every `can()` check outside the project
 * falls through to "not a member of this project".
 *
 * Only `sha256(token)` is stored, so the database cannot be mined for working
 * invite links.
 */

import {
  asProjectId,
  asUserId,
  can,
  createGuestTokenSchema,
  type Actor,
  type CreateGuestTokenInput,
  type GuestToken,
  type ProjectId,
} from '@tracker/shared';
import { forbidden, notFound } from '../errors.ts';
import { generateToken, hashToken } from '../lib/crypto.ts';
import { isPast, nowIso } from '../lib/time.ts';
import type { Services } from './context.ts';
import type { RequestMeta } from './auth.service.ts';

/** The guest descriptor carried on `RequestContext.guest`. */
export interface GuestPrincipal {
  id: number;
  projectId: number;
  /** Set when the link is scoped to a single issue. */
  issueId: number | null;
  role: 'viewer' | 'reporter';
  canComment: boolean;
  label: string;
}

export interface RedeemResult {
  actor: Actor;
  guest: GuestPrincipal;
  /** Present when the token is pinned to a single issue. */
  issueId: number | null;
  expiresAt: string;
}

type GuestTokenRow = {
  id: number;
  project_id: number;
  issue_id: number | null;
  label: string;
  token_hash: string;
  role: string;
  can_comment: number;
  expires_at: string;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
  created_by: number;
  created_at: string;
};

const GUEST_TOKEN_COLUMNS =
  'id, project_id, issue_id, label, token_hash, role, can_comment, expires_at, ' +
  'max_uses, use_count, revoked_at, created_by, created_at';

export class GuestService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  /**
   * Mint a guest link. The caller must hold `guestToken.create` in the target
   * project; the raw token is returned once, inside the shareable URL.
   */
  async create(
    projectId: number,
    input: CreateGuestTokenInput,
    actor: Actor,
    ctx: RequestMeta,
  ): Promise<{ token: GuestToken; url: string }> {
    const data = createGuestTokenSchema.parse({ ...input, projectId });
    this.assertCanManageGuestTokens(actor, projectId);
    this.assertProjectExists(projectId);
    if (data.issueId !== null) this.assertIssueInProject(data.issueId, projectId);

    const rawToken = generateToken();
    const created = this.services.db.transaction(() => {
      const result = this.services.db.run(
        `INSERT INTO guest_tokens
           (project_id, issue_id, label, token_hash, role, can_comment, expires_at, max_uses, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          projectId,
          data.issueId,
          data.label,
          hashToken(rawToken),
          data.role,
          data.canComment ? 1 : 0,
          data.expiresAt,
          data.maxUses,
          actor.userId,
        ],
      );

      const row = this.services.db.get<GuestTokenRow>('SELECT * FROM guest_tokens WHERE id = ?', [
        result.lastInsertRowid,
      ]);
      if (!row) throw notFound('Guest token', result.lastInsertRowid);
      const token = this.mapGuestToken(row);

      this.services.audit.record(
        {
          action: 'guest_token.created',
          entityType: 'guest_token',
          entityId: token.id,
          projectId,
          after: {
            label: token.label,
            role: token.role,
            canComment: token.canComment,
            issueId: token.issueId,
            expiresAt: token.expiresAt,
            maxUses: token.maxUses,
            createdBy: token.createdBy,
          },
        },
        { ipAddress: ctx.ip, userAgent: ctx.userAgent, ...ctx.audit },
      );

      return token;
    });

    return { token: created, url: `/guest/${rawToken}` };
  }

  /**
   * Exchange a raw guest token for a project-scoped `Actor`. The use counter is
   * incremented inside the same transaction as the validity checks, so two
   * concurrent redemptions cannot both consume the final use.
   */
  redeem(rawToken: string, ctx: RequestMeta): RedeemResult {
    void ctx; // Not audited: redemption mutates nothing but the use counter.
    if (!rawToken) throw forbidden('This guest link is not valid');

    const key = hashToken(rawToken);
    const result = this.services.db.transaction(() => {
      const row = this.services.db.get<GuestTokenRow>(
        `SELECT ${GUEST_TOKEN_COLUMNS} FROM guest_tokens WHERE token_hash = ?`,
        [key],
      );
      if (!row) throw forbidden('This guest link is not valid');
      if (row.revoked_at !== null) throw forbidden('This guest link has been revoked');
      if (isPast(row.expires_at)) throw forbidden('This guest link has expired');
      if (row.max_uses !== null && row.use_count >= row.max_uses) {
        throw forbidden('This guest link has reached its usage limit');
      }

      this.services.db.run('UPDATE guest_tokens SET use_count = use_count + 1 WHERE id = ?', [row.id]);
      return row;
    });

    const role = result.role === 'reporter' ? 'reporter' : 'viewer';
    const projectId = asProjectId(result.project_id);
    const actor: Actor = {
      // No user row backs a guest; `userId` 0 is the reserved "anonymous" id.
      userId: asUserId(0),
      isInstanceAdmin: false,
      roles: [],
      projectRoles: new Map<ProjectId, typeof role>([[projectId, role]]),
    };

    return {
      actor,
      guest: {
        id: result.id,
        projectId: result.project_id,
        issueId: result.issue_id,
        role,
        canComment: result.can_comment === 1,
        label: result.label,
      },
      issueId: result.issue_id,
      expiresAt: result.expires_at,
    };
  }

  /** All guest links for a project, newest first. */
  list(projectId: number, actor: Actor): GuestToken[] {
    this.assertCanManageGuestTokens(actor, projectId);
    return this.services.db
      .all<GuestTokenRow>(
        `SELECT ${GUEST_TOKEN_COLUMNS} FROM guest_tokens WHERE project_id = ? ORDER BY created_at DESC`,
        [projectId],
      )
      .map((row) => this.mapGuestToken(row));
  }

  /** Revoke a guest link. The row is kept so the audit trail stays meaningful. */
  revoke(projectId: number, id: number, actor: Actor, ctx: RequestMeta): GuestToken {
    this.assertCanManageGuestTokens(actor, projectId);

    return this.services.db.transaction(() => {
      const row = this.services.db.get<GuestTokenRow>(
        'SELECT * FROM guest_tokens WHERE id = ? AND project_id = ?',
        [id, projectId],
      );
      if (!row) throw notFound('Guest token', id);
      if (row.revoked_at !== null) return this.mapGuestToken(row);

      const revokedAt = nowIso();
      this.services.db.run('UPDATE guest_tokens SET revoked_at = ? WHERE id = ?', [revokedAt, id]);

      this.services.audit.record(
        {
          action: 'guest_token.revoked',
          entityType: 'guest_token',
          entityId: id,
          projectId,
          before: { revokedAt: null },
          after: { revokedAt },
        },
        { ipAddress: ctx.ip, userAgent: ctx.userAgent, ...ctx.audit },
      );

      return this.mapGuestToken({ ...row, revoked_at: revokedAt });
    });
  }

  /** A single guest link, for the management screen. */
  get(projectId: number, id: number, actor: Actor): GuestToken {
    this.assertCanManageGuestTokens(actor, projectId);
    const row = this.services.db.get<GuestTokenRow>(
      'SELECT * FROM guest_tokens WHERE id = ? AND project_id = ?',
      [id, projectId],
    );
    if (!row) throw notFound('Guest token', id);
    return this.mapGuestToken(row);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertCanManageGuestTokens(actor: Actor, projectId: number): void {
    const decision = can(actor, 'guestToken.create', { projectId: asProjectId(projectId) });
    if (!decision.allowed) throw forbidden(decision.reason);
  }

  private assertProjectExists(projectId: number): void {
    const row = this.services.db.get('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!row) throw notFound('Project', projectId);
  }

  private assertIssueInProject(issueId: number, projectId: number): void {
    const row = this.services.db.get('SELECT id FROM issues WHERE id = ? AND project_id = ?', [
      issueId,
      projectId,
    ]);
    if (!row) throw notFound('Issue', issueId);
  }

  private mapGuestToken(row: GuestTokenRow): GuestToken {
    return {
      id: row.id,
      projectId: asProjectId(row.project_id),
      issueId: row.issue_id,
      label: row.label,
      // The digest is part of the shared shape; the route strips it so the
      // hash never reaches a client.
      tokenHash: row.token_hash,
      role: row.role === 'reporter' ? 'reporter' : 'viewer',
      canComment: row.can_comment === 1,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
      revokedAt: row.revoked_at,
      createdBy: asUserId(row.created_by),
      createdAt: row.created_at,
    };
  }
}

export default GuestService;
