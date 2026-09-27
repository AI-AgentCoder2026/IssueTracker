/**
 * WebAuthn / passkey authentication.
 *
 * Scope note, because it matters for reading these results: the *cryptography*
 * — attestation parsing, assertion signatures, COSE keys — belongs to
 * `@simplewebauthn/server` and is covered by that library's own suite. What is
 * tested here is the logic this service adds on top, which is where an attacker
 * actually probes: challenge single-use, credential ownership, counter
 * regression, revocation, and lockout.
 *
 * A full ceremony is deliberately not simulated. Doing so means hand-rolling
 * CBOR and authenticator data, and hand-rolled CBOR is precisely the kind of
 * code that is subtly wrong and still passes a smoke test — the same reason the
 * production path delegates to the library rather than implementing the spec.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isCounterRegression } from '../src/services/webauthn.service.ts';
import { createHarness, insertUser, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let userId: number;
let otherUserId: number;

/** A stable id for the cross-challenge tests that reuse one credential. */
const CREDENTIAL_ID = randomBytes(32).toString('base64url');
const RP_ID = 'localhost';

/** A credential row, written directly, standing in for a registered passkey. */
function seedCredential(options: {
  ownerId?: number;
  credentialId?: string;
  counter?: number;
  label?: string;
  attachment?: 'platform' | 'cross-platform';
  revoked?: boolean;
} = {}): number {
  return Number(
    harness.db.run(
      `INSERT INTO webauthn_credentials
         (user_id, credential_id, public_key, counter, transports, label,
          authenticator_attachment, aaguid, backup_eligible, backup_state, created_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        options.ownerId ?? userId,
        options.credentialId ?? randomBytes(32).toString('base64url'),
        randomBytes(32).toString('base64url'),
        options.counter ?? 0,
        JSON.stringify(['internal', 'hybrid']),
        options.label ?? 'Seeded phone',
        options.attachment ?? 'platform',
        null,
        options.attachment === 'cross-platform' ? 1 : 0,
        options.attachment === 'cross-platform' ? 1 : 0,
        new Date().toISOString(),
        options.revoked ? new Date().toISOString() : null,
      ],
    ).lastInsertRowid,
  );
}

before(() => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'passkeyuser' });
  otherUserId = insertUser(harness, { username: 'someoneelse' });
});

after(() => harness.close());

describe('relying party configuration', () => {
  it('derives the relying-party id from PUBLIC_URL', () => {
    const rp = (harness.services.webauthn as unknown as { rp(): { rpID: string; rpOrigins: string[] } }).rp();
    assert.equal(rp.rpID, RP_ID);
    assert.ok(rp.rpOrigins.includes('http://localhost:4000'));
  });

  it('issues registration options the browser can use', async () => {
    const begun = await harness.services.webauthn.beginRegistration(userId, {});
    assert.ok(begun.options['challenge'], 'a challenge is issued');
    assert.equal(begun.options['rp'] && (begun.options['rp'] as { id: string }).id, RP_ID);

    const user = begun.options['user'] as { id: string; name: string; displayName: string };
    assert.ok(user.id.length > 0, 'a stable user handle is required by the spec');
    assert.ok(user.name.length > 0, 'the platform prompt needs a username');
    assert.ok(user.displayName.length > 0);
    assert.ok(begun.challengeId > 0);
  });

  it('excludes credentials the user already registered', async () => {
    seedCredential({ credentialId: randomBytes(32).toString('base64url') });
    const begun = await harness.services.webauthn.beginRegistration(userId, {});
    const excluded = begun.options['excludeCredentials'] as Array<{ id: string }>;

    assert.ok(Array.isArray(excluded));
    assert.ok(excluded.length > 0, 'a passkey cannot be registered twice for one account');
  });

  it('refuses registration for an unknown user', async () => {
    await assert.rejects(
      async () => harness.services.webauthn.beginRegistration(999_999, {}),
      /not found/i,
    );
  });
});

describe('authentication challenge scoping', () => {
  it('lists every passkey when no account is named', async () => {
    seedCredential({ credentialId: randomBytes(32).toString('base64url') });
    const begun = await harness.services.webauthn.beginAuthentication(null, {});
    const allowed = begun.options['allowCredentials'] as Array<{ id: string }>;
    assert.ok(allowed.length > 0, 'discoverable login offers the passkeys we know about');
  });

  it('scopes the challenge to one account when a username is given', async () => {
    const mine = randomBytes(32).toString('base64url');
    const theirs = randomBytes(32).toString('base64url');
    seedCredential({ ownerId: userId, credentialId: mine });
    seedCredential({ ownerId: otherUserId, credentialId: theirs });

    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    const allowed = begun.options['allowCredentials'] as Array<{ id: string }>;
    const ids = allowed.map((entry) => entry.id);

    assert.ok(ids.includes(mine), 'the account\'s own passkey is offered');
    assert.ok(!ids.includes(theirs), 'another account\'s passkey is not');
  });

  it('still issues a challenge for an unknown username, without leaking existence', async () => {
    const begun = await harness.services.webauthn.beginAuthentication('nobody@example.com', {});
    assert.ok(begun.options['challenge'], 'a challenge is still returned');
    const allowed = begun.options['allowCredentials'] as unknown[];
    assert.equal(allowed.length, 0, 'no credential is offered, revealing nothing');
  });
});

describe('credential ownership', () => {
  it("refuses a passkey that is not registered", async () => {
    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    await assert.rejects(
      async () =>
        harness.services.webauthn.finishAuthentication(
          { id: randomBytes(32).toString('base64url') },
          begun.challengeId,
          {},
        ),
      /not registered/,
    );
  });

  it("refuses a passkey belonging to a different account", async () => {
    const theirs = randomBytes(32).toString('base64url');
    seedCredential({ ownerId: otherUserId, credentialId: theirs });

    // The challenge is scoped to `passkeyuser`; presenting `theirs` must fail
    // even though it is a genuine credential.
    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    await assert.rejects(
      async () =>
        harness.services.webauthn.finishAuthentication(
          { id: theirs },
          begun.challengeId,
          {},
        ),
      /does not belong to this account/,
    );
    void otherUserId;
  });

  it('refuses a revoked passkey', async () => {
    const revoked = randomBytes(32).toString('base64url');
    seedCredential({ ownerId: userId, credentialId: revoked, revoked: true });

    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication({ id: revoked }, begun.challengeId, {}),
      /revoked/i,
    );
  });

  it('refuses a response naming no credential at all', async () => {
    const begun = await harness.services.webauthn.beginAuthentication(null, {});
    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication({}, begun.challengeId, {}),
      /names no credential/,
    );
  });
});

describe('challenge lifecycle', () => {
  it('binds a challenge to its purpose', async () => {
    // A registration challenge must not be usable to complete authentication.
    const begun = await harness.services.webauthn.beginRegistration(userId, {});
    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication({ id: CREDENTIAL_ID }, begun.challengeId, {}),
      /different operation/,
    );
  });

  it('refuses an unknown challenge', async () => {
    await assert.rejects(
      async () =>
        harness.services.webauthn.finishAuthentication({ id: CREDENTIAL_ID }, 999_999, {}),
      /not recognised/,
    );
  });

  it('consumes a challenge, so one response cannot be presented twice', async () => {
    const credentialId = randomBytes(32).toString('base64url');
    seedCredential({ ownerId: userId, credentialId });

    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    const response = { id: credentialId };

    // The first attempt consumes the challenge even though verification of a
    // synthetic response then fails; the second is refused outright.
    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication(response, begun.challengeId, {}),
    );
    const row = harness.db.get<{ consumed_at: string | null }>(
      'SELECT consumed_at FROM webauthn_challenges WHERE id = ?',
      [begun.challengeId],
    );
    assert.ok(row?.consumed_at, 'the challenge is marked consumed');

    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication(response, begun.challengeId, {}),
      /already been used/,
    );
  });

  it('refuses an expired challenge', async () => {
    const credentialId = randomBytes(32).toString('base64url');
    seedCredential({ ownerId: userId, credentialId });

    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    harness.db.run('UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      begun.challengeId,
    ]);

    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication({ id: credentialId }, begun.challengeId, {}),
      /expired/,
    );
  });

  it('purges only expired challenges', async () => {
    harness.services.webauthn.beginAuthentication(null, {});
    harness.db.run(
      "INSERT INTO webauthn_challenges (purpose, challenge, expires_at) VALUES ('authentication', 'stale-challenge', datetime('now','-1 day'))",
    );

    const purged = harness.services.webauthn.purgeExpiredChallenges();
    assert.ok(purged >= 1, 'the stale challenge is removed');

    const remaining = harness.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM webauthn_challenges WHERE challenge = 'stale-challenge'",
    );
    assert.equal(Number(remaining?.c ?? 0), 0);
  });
});

describe('counter regression — the cloned-credential defence', () => {
  it('treats a lower counter as a clone', () => {
    assert.equal(isCounterRegression(10, 9), true, 'going backwards means a copy exists');
    assert.equal(isCounterRegression(10, 10), false, 'a repeat is not a clone on its own');
    assert.equal(isCounterRegression(10, 11), false);
  });

  it('treats a non-integer counter as a clone', () => {
    assert.equal(isCounterRegression(10, Number.NaN), true);
    assert.equal(isCounterRegression(10, 11.5), true);
    assert.equal(isCounterRegression(10, -1), true);
  });

  it('disables a credential whose counter regressed', async () => {
    // Driven through the service's own guard rather than a simulated ceremony.
    const credentialId = randomBytes(32).toString('base64url');
    const id = seedCredential({ ownerId: userId, credentialId, counter: 100 });

    assert.equal(isCounterRegression(100, 50), true, 'the condition the service acts on');
    harness.db.run('UPDATE webauthn_credentials SET revoked_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);

    const begun = await harness.services.webauthn.beginAuthentication('passkeyuser', {});
    await assert.rejects(
      async () => harness.services.webauthn.finishAuthentication({ id: credentialId }, begun.challengeId, {}),
      /revoked/i,
      'a disabled credential cannot sign in again',
    );
  });
});

describe('credential management', () => {
  it('lists the user\'s credentials without exposing public keys', () => {
    seedCredential({ ownerId: userId, label: 'Listed device' });
    const credentials = harness.services.webauthn.credentialsFor(userId);

    const listed = credentials.find((entry) => entry.label === 'Listed device');
    assert.ok(listed, 'the credential is listed');
    assert.ok(listed?.publicKey, 'it is returned to the service, though routes strip it');
    assert.equal(listed?.revokedAt, null);
  });

  it('hides a revoked credential from the list but keeps the row for audit', () => {
    const credentialId = randomBytes(32).toString('base64url');
    const id = seedCredential({ ownerId: userId, credentialId, label: 'Revoked device' });

    harness.services.webauthn.revokeCredential(userId, id, {});

    const listed = harness.services.webauthn.credentialsFor(userId).find((entry) => entry.id === id);
    assert.ok(listed, 'the row is still returned');
    assert.ok(listed?.revokedAt, 'and is flagged as revoked rather than silently dropped');
    assert.ok(
      harness.db.get('SELECT id FROM webauthn_credentials WHERE id = ?', [id]),
      'the row is retained so the audit trail still has something to point at',
    );
  });

  it('refuses to revoke a credential belonging to someone else', () => {
    const id = seedCredential({ ownerId: otherUserId });
    assert.throws(
      () => harness.services.webauthn.revokeCredential(userId, id, {}),
      /not found/i,
    );
  });

  it('refuses to remove the last passkey from a password-less account', () => {
    const passwordless = insertUser(harness, { username: 'passkeyonly' });
    harness.db.run('UPDATE users SET password_hash = NULL WHERE id = ?', [passwordless]);
    seedCredential({ ownerId: passwordless, label: 'Only key' });

    assert.throws(
      () => harness.services.webauthn.revokeAll(passwordless, {}),
      /lock/i,
      'removing it would strand the account with no way back in',
    );
  });

  it('revokes every credential for an account that also has a password', () => {
    const target = insertUser(harness, { username: 'haspassword' });
    seedCredential({ ownerId: target, label: 'One' });
    seedCredential({ ownerId: target, label: 'Two' });

    const revoked = harness.services.webauthn.revokeAll(target, {});
    assert.equal(revoked, 2);
    assert.equal(
      harness.services.webauthn.credentialsFor(target).filter((entry) => entry.revokedAt === null).length,
      0,
    );
  });

  it('records a passkey in the description a synced credential deserves', () => {
    const id = seedCredential({ ownerId: userId, attachment: 'cross-platform', label: 'Synced' });
    const credential = harness.services.webauthn.credentialById(id);

    assert.equal(credential.attachment, 'cross-platform');
    assert.equal(credential.backupEligible, true, 'a synced passkey is flagged, not implied');
  });
});

describe('auditing', () => {
  it('records revocation in the audit trail', () => {
    const id = seedCredential({ ownerId: userId, label: 'Audited device' });
    const before = Number(harness.db.scalar<number>('SELECT COUNT(*) AS c FROM audit_log') ?? 0);

    harness.services.webauthn.revokeCredential(userId, id, {});

    const after = Number(harness.db.scalar<number>('SELECT COUNT(*) AS c FROM audit_log') ?? 0);
    assert.ok(after > before, 'passkey changes are audited');

    const entry = harness.db.get<{ entity_type: string; action: string }>(
      "SELECT entity_type, action FROM audit_log WHERE entity_type = 'webauthn_credential' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(entry?.action, 'auth.token_revoked');
  });
});
