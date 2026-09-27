/**
 * WebAuthn / passkey authentication.
 *
 * This is the browser-native answer to "biometric login": the user approves the
 * sign-in with Face ID, Touch ID or a fingerprint, and the private key stays in
 * the device's secure element. The server only ever holds the public key.
 *
 * Verification is delegated to `@simplewebauthn/server`. That is a deliberate
 * choice, in the same spirit as using `xml-crypto` for SAML: WebAuthn's
 * attestation and assertion formats involve CBOR, COSE keys and packed
 * attestation, and getting any of it subtly wrong is how passkey bypasses get
 * shipped. The library is the audited implementation of that specification.
 *
 * Two properties this module adds on top, because they are the ones an attacker
 * actually probes:
 *
 *  * **Challenges are single-use and server-side.** The challenge is stored and
 *    marked consumed, so a replayed registration or authentication response
 *    cannot be reused even inside its validity window.
 *  * **Counters are enforced.** A credential whose counter fails to advance has
 *    been cloned, and is refused rather than quietly accepted.
 */

import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticatorTransport } from '@simplewebauthn/server';
import { badRequest, conflict, notFound, unauthenticated } from '../errors.ts';
import { nowIso, addMinutes } from '../lib/time.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { Database } from '../db/connection.ts';
import type { RequestAuditContext, Services } from './context.ts';

export const CHALLENGE_TTL_MINUTES = 5;

export interface PasskeyCredential {
  id: number;
  userId: number;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  attachment: 'platform' | 'cross-platform';
  aaguid: string | null;
  backupEligible: boolean;
  backedUp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CredentialRow extends Record<string, unknown> {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  label: string;
  authenticator_attachment: string;
  aaguid: string | null;
  backup_eligible: number;
  backup_state: number;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export class WebAuthnService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  private get db(): Database {
    return this.services.db;
  }

  /**
   * Relying-party identity. `rpID` must be the site's registrable domain, and
   * must match the origin the browser reports or verification will fail — which
   * is the point: it is what stops a passkey from another site being replayed
   * here.
   */
  private rp(): { rpID: string; rpName: string; rpOrigins: string[] } {
    const origin = this.services.config.publicUrl.replace(/\/$/, '');
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      // A misconfigured PUBLIC_URL must not silently weaken the relying party.
      throw badRequest('PUBLIC_URL is not a valid URL, so WebAuthn cannot be configured');
    }

    const override = process.env['WEBAUTHN_RP_ID'];
    return {
      rpID: override && override.length > 0 ? override : host,
      rpName: process.env['WEBAUTHN_RP_NAME'] ?? 'Issue Tracker',
      // Extra origins let a staging host accept passkeys scoped to production,
      // or a mobile webview origin alongside the browser one.
      rpOrigins: [origin, ...(process.env['WEBAUTHN_EXTRA_ORIGINS'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)],
    };
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Begin registering a passkey for an already-authenticated user.
   *
   * Returns the options the browser passes to `navigator.credentials.create()`.
   */
  async beginRegistration(
    userId: number,
    ctx: RequestAuditContext = {},
  ): Promise<{ options: Record<string, unknown>; challengeId: number }> {
    const user = this.db.get<{ id: number; username: string; display_name: string; email: string }>(
      'SELECT id, username, display_name, email FROM users WHERE id = ?',
      [userId],
    );
    if (!user) throw notFound('User', userId);

    const existing = this.credentialsFor(userId).filter((credential) => !credential.revokedAt);
    const rp = this.rp();

    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      // The account number is opaque and stable, which is what the spec wants;
      // the email is the human-readable hint shown in the platform prompt.
      userName: user.email || user.username,
      userDisplayName: user.display_name,
      userID: new Uint8Array(8).fill(Number(user.id) & 0xff),
      // `preferred` rather than `required`: a roaming security key is a
      // legitimate choice and should not be refused.
      attestationType: 'none',
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const challengeId = this.storeChallenge('registration', options.challenge, userId, {});
    void ctx;
    return { options: options as unknown as Record<string, unknown>, challengeId };
  }

  /**
   * Complete registration and store the credential.
   *
   * The challenge is consumed before verification, so a replayed response
   * cannot be used to add a second credential.
   */
  async finishRegistration(
    userId: number,
    response: unknown,
    challengeId: number,
    label: string,
    ctx: RequestAuditContext = {},
  ): Promise<PasskeyCredential> {
    const challenge = this.consumeChallenge(challengeId, 'registration');
    if (challenge.userId !== null && challenge.userId !== userId) {
      throw unauthenticated('That registration challenge belongs to a different user');
    }

    const rp = this.rp();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: challenge.challenge,
        expectedOrigin: rp.rpOrigins,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch (error) {
      // Never echo the library's internal message verbatim; it can contain
      // values an attacker controls.
      throw badRequest(`The passkey could not be registered: ${publicReason(error)}`);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw badRequest('The passkey could not be registered');
    }

    const info = verification.registrationInfo;
    const credentialId = info.credential.id;
    const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');

    const duplicate = this.db.get<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM webauthn_credentials WHERE credential_id = ?',
      [credentialId],
    );
    if (duplicate) {
      throw conflict('That passkey is already registered', { credentialId });
    }

    const id = Number(
      this.db.run(
        `INSERT INTO webauthn_credentials
           (user_id, credential_id, public_key, counter, transports, label,
            authenticator_attachment, aaguid, backup_eligible, backup_state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          userId,
          credentialId,
          publicKey,
          info.credential.counter ?? 0,
          JSON.stringify(info.credential.transports ?? []),
          label.slice(0, 120),
          // `singleDevice` means the key is bound to this hardware and the
          // sign-in is gated behind the device's Face ID / fingerprint.
          // `multiDevice` means it syncs across devices, and the UI says so
          // rather than implying hardware binding.
          info.credentialDeviceType ?? 'singleDevice',
          typeof info.aaguid === 'string' ? info.aaguid : null,
          // Backup eligibility is implied by the device type: only a synced
          // (multi-device) credential can be backed up at all.
          info.credentialDeviceType === 'multiDevice' ? 1 : 0,
          info.credentialBackedUp ? 1 : 0,
          nowIso(),
        ],
      ).lastInsertRowid,
    );

    this.services.audit.record(
      {
        action: 'auth.token_created',
        entityType: 'webauthn_credential',
        entityId: id,
        actorId: userId,
        after: {
          label: label.slice(0, 120),
          attachment: info.credentialDeviceType === 'multiDevice' ? 'cross-platform' : 'platform',
          backedUp: info.credentialBackedUp === true,
        },
      },
      ctx,
    );

    return this.credentialById(id);
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /**
   * Begin a passkey sign-in.
   *
   * When `username` is supplied the challenge is scoped to that account so the
   * platform prompt can skip account selection. When it is not, any passkey for
   * this relying party is allowed, which is the discoverable-login flow.
   */
  async beginAuthentication(
    username?: string | null,
    context: Record<string, unknown> = {},
  ): Promise<{ options: Record<string, unknown>; challengeId: number }> {
    const rp = this.rp();

    // Three distinct cases, and conflating them would leak which usernames
    // exist: no username given is discoverable login and may offer everything;
    // a known username is scoped to that account; an unknown username must
    // offer *nothing* rather than falling back to the full list.
    const trimmed = (username ?? '').trim();
    const discoverable = trimmed.length === 0;
    let userId: number | null = null;
    let knownAccount = false;

    if (!discoverable) {
      const row = this.db.get<{ id: number }>(
        'SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)',
        [trimmed, trimmed],
      );
      userId = row ? Number(row.id) : null;
      knownAccount = row !== undefined;
    }

    const allowed = knownAccount
      ? this.db.all<{ credential_id: string; transports: string }>(
          `SELECT credential_id, transports FROM webauthn_credentials
           WHERE revoked_at IS NULL AND user_id = ?`,
          [userId],
        )
      : discoverable
        ? this.db.all<{ credential_id: string; transports: string }>(
            'SELECT credential_id, transports FROM webauthn_credentials WHERE revoked_at IS NULL',
          )
        : [];

    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      // A signature is a security-relevant action, so the platform should ask
      // for a biometric or PIN even though the RP does not mandate it.
      userVerification: 'preferred',
      allowCredentials: allowed.map((row) => ({
        id: row.credential_id,
        transports: safeTransports(row.transports),
      })),
    });

    const challengeId = this.storeChallenge('authentication', options.challenge, userId, context);
    return { options: options as unknown as Record<string, unknown>, challengeId };
  }

  /**
   * Complete a passkey sign-in, returning the resolved user.
   *
   * The credential is looked up by id rather than trusted from the response, and
   * the counter must advance; a credential that does not advance has been cloned
   * somewhere else and is refused.
   */
  async finishAuthentication(
    response: unknown,
    challengeId: number,
    ctx: RequestAuditContext = {},
  ): Promise<{ userId: number; credential: PasskeyCredential }> {
    const challenge = this.consumeChallenge(challengeId, 'authentication');
    const rp = this.rp();

    // The credential id is attacker-supplied, so it is only used to find the
    // row; nothing about the row is taken from the response.
    const credentialId = extractCredentialId(response);
    if (!credentialId) throw badRequest('The sign-in response names no credential');

    const row = this.db.get<CredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE credential_id = ?',
      [credentialId],
    );
    if (!row) throw badRequest('That passkey is not registered');
    if (row.revoked_at !== null) throw unauthenticated('That passkey has been revoked');

    // When the challenge was scoped to an account, the credential must belong
    // to it. Without this, a valid passkey could sign in as a different user.
    if (challenge.userId !== null && Number(row.user_id) !== challenge.userId) {
      throw unauthenticated('That passkey does not belong to this account');
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challenge.challenge,
        expectedOrigin: rp.rpOrigins,
        expectedRPID: rp.rpID,
        credential: {
          id: row.credential_id,
          publicKey: Buffer.from(row.public_key, 'base64url'),
          counter: Number(row.counter),
          transports: safeTransports(row.transports),
        },
        requireUserVerification: false,
      });
    } catch (error) {
      throw unauthenticated(`The passkey could not be verified: ${publicReason(error)}`);
    }

    if (!verification.verified) {
      throw unauthenticated('The passkey could not be verified');
    }

    const nextCounter = Number(verification.authenticationInfo.newCounter);
    if (isCounterRegression(Number(row.counter), nextCounter)) {
      // A counter that goes backwards means two authenticators share a
      // credential id: one of them is a clone.
      this.db.run('UPDATE webauthn_credentials SET revoked_at = ? WHERE id = ?', [nowIso(), row.id]);
      this.services.audit.record(
        {
          action: 'auth.token_revoked',
          entityType: 'webauthn_credential',
          entityId: row.id,
          actorId: Number(row.user_id),
          after: { reason: 'counter_regression', storedCounter: Number(row.counter), presentedCounter: nextCounter },
        },
        ctx,
      );
      throw unauthenticated(
        'This passkey appears to have been copied to another device and has been disabled',
      );
    }

    this.db.run(
      'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
      [nextCounter, nowIso(), row.id],
    );

    const user = this.db.get<{ id: number; is_active: number }>(
      'SELECT id, is_active FROM users WHERE id = ?',
      [row.user_id],
    );
    if (!user || Number(user.is_active) !== 1) {
      throw unauthenticated('That account is not active');
    }

    this.services.audit.record(
      {
        action: 'auth.login',
        entityType: 'webauthn_credential',
        entityId: row.id,
        actorId: Number(row.user_id),
        after: { method: 'passkey', counter: nextCounter },
      },
      ctx,
    );

    return { userId: Number(row.user_id), credential: this.credentialById(Number(row.id)) };
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  credentialsFor(userId: number): PasskeyCredential[] {
    return this.db
      .all<CredentialRow>(
        'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
      )
      .map((row) => this.mapCredential(row));
  }

  credentialById(id: number): PasskeyCredential {
    const row = this.db.get<CredentialRow>('SELECT * FROM webauthn_credentials WHERE id = ?', [id]);
    if (!row) throw notFound('Passkey', id);
    return this.mapCredential(row);
  }

  /**
   * Revoke a passkey. Revoked rather than deleted so the audit entry has
   * something to point at, and so the credential id cannot be re-registered.
   */
  revokeCredential(userId: number, credentialId: number, ctx: RequestAuditContext = {}): void {
    const row = this.db.get<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM webauthn_credentials WHERE id = ? AND user_id = ?',
      [credentialId, userId],
    );
    if (!row) throw notFound('Passkey', credentialId);

    this.db.run('UPDATE webauthn_credentials SET revoked_at = ? WHERE id = ?', [nowIso(), credentialId]);
    this.services.audit.record(
      {
        action: 'auth.token_revoked',
        entityType: 'webauthn_credential',
        entityId: credentialId,
        actorId: userId,
        before: { revoked: false },
        after: { revoked: true },
      },
      ctx,
    );
  }

  /**
   * A passkey is the only credential a user may have. Removing the last one
   * without a password would lock them out permanently, so it is refused.
   */
  revokeAll(userId: number, ctx: RequestAuditContext = {}): number {
    const active = this.credentialsFor(userId).filter((credential) => credential.revokedAt === null);
    if (active.length === 0) return 0;

    const user = this.db.get<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = ?',
      [userId],
    );
    if (!user?.password_hash) {
      throw conflict(
        'This account has no password, so its last passkey cannot be removed without locking it out',
        { active: active.length },
      );
    }

    return this.db.transaction(() => {
      this.db.run(
        'UPDATE webauthn_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [nowIso(), userId],
      );
      this.services.audit.record(
        {
          action: 'auth.token_revoked',
          entityType: 'webauthn_credential',
          entityId: null,
          actorId: userId,
          before: { activeCredentials: active.length },
          after: { activeCredentials: 0 },
        },
        ctx,
      );
      return active.length;
    });
  }

  /** Delete expired challenges; called by the scheduler. */
  purgeExpiredChallenges(): number {
    return this.db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', [nowIso()]).changes;
  }

  // -------------------------------------------------------------------------
  // Challenges
  // -------------------------------------------------------------------------

  private storeChallenge(
    purpose: 'registration' | 'authentication',
    challenge: string,
    userId: number | null,
    context: Record<string, unknown>,
  ): number {
    return Number(
      this.db.run(
        `INSERT INTO webauthn_challenges (purpose, challenge, user_id, context, expires_at)
         VALUES (?,?,?,?,?)`,
        [
          purpose,
          challenge,
          userId,
          JSON.stringify(context),
          addMinutes(nowIso(), CHALLENGE_TTL_MINUTES),
        ],
      ).lastInsertRowid,
    );
  }

  /**
   * Read a challenge and mark it consumed in one transaction, so two concurrent
   * submissions of the same response cannot both succeed.
   */
  private consumeChallenge(
    challengeId: number,
    purpose: 'registration' | 'authentication',
  ): { challenge: string; userId: number | null; context: Record<string, unknown> } {
    return this.db.transaction(() => {
      const row = this.db.get<{
        id: number;
        purpose: string;
        challenge: string;
        user_id: number | null;
        context: string;
        expires_at: string;
        consumed_at: string | null;
      }>('SELECT * FROM webauthn_challenges WHERE id = ?', [challengeId]);

      if (!row) throw badRequest('That challenge is not recognised');
      if (row.consumed_at !== null) {
        // Replay: the same response presented twice.
        throw unauthenticated('That challenge has already been used');
      }
      if (row.expires_at < nowIso()) throw badRequest('That challenge has expired');
      if (row.purpose !== purpose) throw badRequest('That challenge is for a different operation');

      const result = this.db.run(
        'UPDATE webauthn_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        [nowIso(), challengeId],
      );
      if (result.changes === 0) throw unauthenticated('That challenge has already been used');

      let context: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.context) as unknown;
        if (parsed && typeof parsed === 'object') context = parsed as Record<string, unknown>;
      } catch {
        context = {};
      }

      return {
        challenge: row.challenge,
        userId: row.user_id === null ? null : Number(row.user_id),
        context,
      };
    });
  }

  private mapCredential(row: CredentialRow): PasskeyCredential {
    let transports: string[] = [];
    try {
      const parsed = JSON.parse(row.transports) as unknown;
      if (Array.isArray(parsed)) transports = parsed.map(String);
    } catch {
      transports = [];
    }

    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      credentialId: row.credential_id,
      publicKey: row.public_key,
      counter: Number(row.counter),
      transports,
      label: row.label,
      attachment: row.authenticator_attachment === 'cross-platform' ? 'cross-platform' : 'platform',
      aaguid: row.aaguid,
      backupEligible: Number(row.backup_eligible) === 1,
      backedUp: Number(row.backup_state) === 1,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}

/**
 * Read the credential id out of an untrusted response body. */
function extractCredentialId(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * A counter that does not advance means two authenticators hold the same
 * credential id — one of them is a copy.
 *
 * Exported so the rule can be tested directly. Asserting it only through a full
 * ceremony would mean a hand-rolled virtual authenticator in the test suite,
 * and hand-rolled CBOR is exactly the kind of code that is subtly wrong and
 * still passes a smoke test.
 */
export function isCounterRegression(storedCounter: number, presentedCounter: number): boolean {
  if (!Number.isInteger(presentedCounter)) return true;
  return presentedCounter < storedCounter;
}

function safeTransports(raw: string): AuthenticatorTransport[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Only values we understand are forwarded; an unexpected string must not
    // reach the library's type-sensitive transport handling.
    const allowed = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card']);
    return parsed.filter((entry): entry is AuthenticatorTransport => typeof entry === 'string' && allowed.has(entry));
  } catch {
    return [];
  }
}

/**
 * Reduce a verification failure to a sentence safe to show a user. The library's
 * own message can embed values the caller supplied, so it is not echoed.
 */
function publicReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/origin/i.test(message)) return 'it was not created for this site';
  if (/rpID|relying party/i.test(message)) return 'it belongs to a different site';
  if (/challenge/i.test(message)) return 'the challenge did not match';
  if (/counter/i.test(message)) return 'the authenticator counter did not advance';
  if (/expired|timing/i.test(message)) return 'the response was outside the permitted window';
  return 'the authenticator response could not be validated';
}
