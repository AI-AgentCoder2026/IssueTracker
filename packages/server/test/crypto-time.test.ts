/**
 * Cryptography and time helpers.
 *
 * These are the primitives the security guarantees rest on, so they are tested
 * directly rather than only through the services that use them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  decrypt,
  encrypt,
  generateToken,
  hashPassword,
  hashToken,
  hmacSha256Hex,
  maskSecret,
  needsPasswordRehash,
  safeEqual,
  scrubSecrets,
  sha256Hex,
  verifyPassword,
} from '../src/lib/crypto.ts';
import {
  addBusinessMs,
  addMinutes,
  ageBucket,
  daysBetween,
  formatDuration,
  isPast,
  msUntil,
  parseDuration,
} from '../src/lib/time.ts';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects an incorrect password', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('wrong password', hash), false);
  });

  it('never stores the plaintext', () => {
    const password = 'a-very-distinctive-password';
    const hash = hashPassword(password);
    assert.ok(!hash.includes(password));
    assert.ok(hash.startsWith('scrypt$'), 'the encoding declares its algorithm');
  });

  it('salts, so identical passwords produce different hashes', () => {
    assert.notEqual(hashPassword('same password'), hashPassword('same password'));
  });

  it('normalises unicode so equivalent passwords verify', () => {
    // "é" composed vs decomposed must not create two accounts.
    const composed = 'passwörd';
    const decomposed = 'passwörd';
    assert.equal(verifyPassword(decomposed, hashPassword(composed)), true);
  });

  it('treats a missing hash as a failed verification', () => {
    assert.equal(verifyPassword('anything', null), false);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2', 'scrypt$a$b$c$d$e', 'md5$1$2$3$4$5$6']) {
      assert.equal(verifyPassword('anything', bad), false, `should reject "${bad}"`);
    }
  });

  it('accepts a hash at the current cost without rehashing', () => {
    const hash = hashPassword('current cost password');
    assert.equal(needsPasswordRehash(hash), false);
  });

  it('flags a hash made with weaker parameters', () => {
    assert.equal(needsPasswordRehash('md5$1$1$1$salt$hash'), true);
  });
});

describe('tokens', () => {
  it('generates high-entropy url-safe tokens', () => {
    const token = generateToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length >= 43, '32 bytes base64url is at least 43 characters');
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    assert.equal(tokens.size, 500);
  });

  it('hashes deterministically for lookup', () => {
    const token = generateToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.notEqual(hashToken(token), token, 'the raw token is never the stored value');
  });
});

describe('symmetric encryption', () => {
  const key = randomBytes(32);

  it('round-trips a value', () => {
    const secret = 'glpat-abcdefghijklmnopqrstuvwxyz';
    assert.equal(decrypt(encrypt(secret, key), key), secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const secret = 'same input';
    assert.notEqual(encrypt(secret, key), encrypt(secret, key));
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encrypt('secret', key);
    assert.throws(() => decrypt(ciphertext, randomBytes(32)));
  });

  it('rejects a tampered ciphertext (authenticated encryption)', () => {
    const ciphertext = encrypt('secret value', key);
    const bytes = Buffer.from(ciphertext, 'base64url');
    // Flip a byte in the ciphertext body.
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    assert.throws(() => decrypt(bytes.toString('base64url'), key));
  });

  it('handles unicode', () => {
    const secret = 'pässwörd — 密码 🔐';
    assert.equal(decrypt(encrypt(secret, key), key), secret);
  });

  it('masks a secret for display', () => {
    assert.match(maskSecret('glpat-1234567890'), /^glpa\*+$/);
    assert.equal(maskSecret('abc'), '***');
  });
});

describe('signatures', () => {
  it('hashes deterministically', () => {
    assert.equal(sha256Hex('abc'), sha256Hex('abc'));
    assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
  });

  it('produces a stable HMAC', () => {
    assert.equal(hmacSha256Hex('secret', 'payload'), hmacSha256Hex('secret', 'payload'));
    assert.notEqual(hmacSha256Hex('secret', 'payload'), hmacSha256Hex('other', 'payload'));
  });

  it('compares in constant time without throwing on length mismatch', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('short', 'much longer value'), false);
  });
});

describe('secret scrubbing', () => {
  it('redacts a GitLab personal access token', () => {
    const scrubbed = scrubSecrets('deploy with glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    assert.ok(!scrubbed.includes('glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
    assert.match(scrubbed, /REDACTED/);
  });

  it('redacts an AWS access key id', () => {
    assert.ok(!scrubSecrets('key AKIAIOSFODNN7EXAMPLE here').includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    const scrubbed = scrubSecrets(pem);
    assert.ok(!scrubbed.includes('MIIEow'));
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assert.ok(!scrubSecrets(`token ${jwt}`).includes('dBjftJeZ4CVPmB92K27uhbUJU1p1r'));
  });

  it('redacts a generic password assignment', () => {
    assert.ok(!scrubSecrets('password = hunter2secretvalue').includes('hunter2secretvalue'));
  });

  it('leaves email alone unless asked, since issue text often needs it', () => {
    const input = 'contact ops@example.com about this';
    assert.equal(scrubSecrets(input), input);
    assert.ok(!scrubSecrets(input, { includeEmail: true }).includes('ops@example.com'));
  });

  it('honours the except list', () => {
    const token = 'glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

    // Excluding a category is not a blanket exemption: the generic
    // `keyword: value` rule still fires. That is deliberate
    // defence-in-depth, not a leak.
    assert.match(scrubSecrets(`access_token: ${token}`, { except: ['gitlab_token'] }), /REDACTED/);

    // With no adjacent secret keyword the specific rule is the only match, so
    // the exclusion is observable.
    const bare = `rotate ${token} soon`;
    assert.equal(scrubSecrets(bare, { except: ['gitlab_token'] }), bare);
    assert.notEqual(scrubSecrets(bare), bare);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The login button does nothing when the user has no network.';
    assert.equal(scrubSecrets(prose), prose);
  });
});

describe('time helpers', () => {
  it('parses compact durations', () => {
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('7d'), 604_800_000);
    assert.equal(parseDuration('45s'), 45_000);
    assert.equal(parseDuration('2d4h'), 2 * 86_400_000 + 4 * 3_600_000);
  });

  it('rejects nonsense durations', () => {
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration('1 week'), null);
  });

  it('formats durations compactly', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(5_400_000), '1h 30m');
    assert.equal(formatDuration(-86_400_000), '-1d');
  });

  it('measures until a future instant', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.ok(msUntil(future) > 0);
    assert.equal(isPast(future), false);
    assert.equal(isPast(null), false);
  });

  it('counts whole days between instants', () => {
    const from = '2026-01-01T00:00:00.000Z';
    assert.equal(daysBetween(from, '2026-01-11T00:00:00.000Z'), 10);
  });

  it('adds minutes as elapsed time', () => {
    const start = '2026-01-01T09:00:00.000Z';
    assert.equal(addMinutes(start, 30), '2026-01-01T09:30:00.000Z');
  });

  it('skips non-working time for business-hour SLAs', () => {
    // Friday 16:00 UTC + 4 business hours, 09:00-17:00 Mon-Fri:
    // 1h on Friday, then 3h on Monday (the weekend does not count).
    const fridayLate = '2026-01-02T16:00:00.000Z'; // a Friday
    const result = addBusinessMs(fridayLate, 4 * 3_600_000, {
      startHour: 9,
      endHour: 17,
      workingDays: [1, 2, 3, 4, 5],
    });
    // 16:00-17:00 Friday, skip the weekend, 09:00-12:00 Monday.
    assert.equal(result, '2026-01-05T12:00:00.000Z');
  });

  it('rolls a business-hour deadline into the next working morning', () => {
    // Saturday 10:00 + 1 business hour => Monday 10:00.
    const saturday = '2026-01-03T10:00:00.000Z';
    const result = addBusinessMs(saturday, 3_600_000, {
      startHour: 9,
      endHour: 17,
      workingDays: [1, 2, 3, 4, 5],
    });
    assert.equal(result, '2026-01-05T10:00:00.000Z');
  });

  it('treats elapsed time normally when business hours are off', () => {
    const saturday = '2026-01-03T10:00:00.000Z';
    const result = addBusinessMs(saturday, 3_600_000, { workingDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(result, '2026-01-03T11:00:00.000Z');
  });

  it('buckets issue age for the distribution widget', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    // Buckets are whole-day floored, so a partial day counts as its floor.
    assert.equal(ageBucket('2026-05-31T12:00:00.000Z', now), 'today');
    assert.equal(ageBucket('2026-05-30T00:00:00.000Z', now), '1-2d');
    assert.equal(ageBucket('2026-05-27T00:00:00.000Z', now), '3-6d');
    assert.equal(ageBucket('2026-05-20T00:00:00.000Z', now), '1w');
    assert.equal(ageBucket('2026-01-01T00:00:00.000Z', now), '3-12mo');
  });
});
