/**
 * OIDC ID-token verification.
 *
 * These tests sign real tokens with a real key pair, so a regression in the
 * verification logic cannot be masked by a permissive mock. The forgery cases
 * are the point of the whole exercise: each one must be rejected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  ALLOWED_ALGORITHMS,
  assertClaims,
  decodeJwt,
  jwkToPublicKey,
  selectJwk,
  verifyIdToken,
  type Jwk,
  type JwtClaims,
} from '../src/services/oidc.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
const KEY_ID = 'test-key-1';
const KID_JWKS: Jwk[] = [{ ...jwk, kid: KEY_ID, use: 'sig', alg: 'RS256' }];

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'tracker-client';
const base64url = (value: Buffer | string): string =>
  (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');

/** Build a signed RS256 token. */
function signToken(claims: JwtClaims, header: Record<string, unknown> = {}): string {
  const fullHeader = { alg: 'RS256', kid: KEY_ID, typ: 'JWT', ...header };
  const signingInput = `${base64url(JSON.stringify(fullHeader))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function validClaims(overrides: JwtClaims = {}): JwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'user-123',
    aud: AUDIENCE,
    exp: now + 3600,
    iat: now,
    nonce: 'nonce-abc',
    ...overrides,
  };
}

const verifyOptions = { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-abc' };

describe('decodeJwt', () => {
  it('splits a token without trusting it', () => {
    const token = signToken(validClaims());
    const decoded = decodeJwt(token);
    assert.equal(decoded.header.alg, 'RS256');
    assert.equal(decoded.header.kid, KEY_ID);
    assert.equal(decoded.claims.sub, 'user-123');
    assert.ok(decoded.signature.length > 0);
  });

  it('rejects a token with the wrong number of segments', () => {
    assert.throws(() => decodeJwt('a.b'), /three JWS segments/);
    assert.throws(() => decodeJwt('a.b.c.d'), /three JWS segments/);
  });

  it('rejects segments that are not JSON', () => {
    assert.throws(() => decodeJwt('!!!.###.$$$'), /not valid JSON/);
  });

  it('rejects a header with no algorithm', () => {
    const header = base64url(JSON.stringify({ kid: KEY_ID }));
    const payload = base64url(JSON.stringify(validClaims()));
    assert.throws(() => decodeJwt(`${header}.${payload}.sig`), /missing algorithm/);
  });
});

describe('key selection', () => {
  it('matches on kid', () => {
    const selected = selectJwk(KID_JWKS, KEY_ID);
    assert.equal(selected.kid, KEY_ID);
  });

  it('refuses to guess when several keys are published', () => {
    const many: Jwk[] = [
      { ...jwk, kid: 'a' },
      { ...jwk, kid: 'b' },
    ];
    assert.throws(() => selectJwk(many, undefined), /refusing to guess/);
  });

  it('accepts the only key when the token names none', () => {
    assert.equal(selectJwk(KID_JWKS, undefined).kid, KEY_ID);
  });

  it('fails loudly when the kid is unknown', () => {
    assert.throws(() => selectJwk(KID_JWKS, 'rotated-away'), /No signing key matches/);
  });

  it('ignores keys marked for encryption only', () => {
    const encryptionOnly: Jwk[] = [{ ...jwk, kid: 'enc', use: 'enc' }];
    assert.throws(() => selectJwk(encryptionOnly, 'enc'), /no usable signing keys/);
  });
});

describe('JWK conversion', () => {
  it('builds a usable RSA public key', () => {
    const key = jwkToPublicKey(jwk);
    assert.equal(key.asymmetricKeyType, 'rsa');
  });

  it('rejects an RSA key missing its exponent', () => {
    assert.throws(() => jwkToPublicKey({ kty: 'RSA', n: jwk.n as string }), /both `n` and `e`/);
  });

  it('rejects a key type we cannot verify', () => {
    assert.throws(() => jwkToPublicKey({ kty: 'oct', k: 'AAAA' }), /Unsupported key type/);
  });
});

describe('verifyIdToken — happy path', () => {
  it('accepts a correctly signed token', () => {
    const claims = verifyIdToken(signToken(validClaims()), KID_JWKS, verifyOptions);
    assert.equal(claims.sub, 'user-123');
  });

  it('accepts a token whose audience is an array containing ours', () => {
    const claims = verifyIdToken(
      signToken(validClaims({ aud: ['other-client', AUDIENCE] })),
      KID_JWKS,
      verifyOptions,
    );
    assert.equal(claims.sub, 'user-123');
  });

  it('tolerates small clock skew', () => {
    const now = Math.floor(Date.now() / 1000);
    // Expired 20s ago, inside the 60s tolerance.
    const claims = verifyIdToken(
      signToken(validClaims({ exp: now - 20 })),
      KID_JWKS,
      verifyOptions,
    );
    assert.ok(claims.exp);
  });
});

describe('verifyIdToken — forged tokens are rejected', () => {
  it('rejects a token signed by a different key', () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const attackerJwk = { ...(attacker.publicKey.export({ format: 'jwk' }) as Jwk), kid: KEY_ID, use: 'sig' };
    const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(validClaims()))}`;
    const signer = createSign('sha256');
    signer.update(signingInput);
    signer.end();
    const forged = `${signingInput}.${signer.sign(attacker.privateKey).toString('base64url')}`;

    assert.throws(() => verifyIdToken(forged, KID_JWKS, verifyOptions), /signature is invalid/);
  });

  it('rejects an alg-none token', () => {
    const header = base64url(JSON.stringify({ alg: 'none' }));
    const payload = base64url(JSON.stringify(validClaims()));
    assert.throws(
      () => verifyIdToken(`${header}.${payload}.`, KID_JWKS, verifyOptions),
      /unsigned \(alg "none"\)/,
    );
  });

  it('rejects a symmetric algorithm outright', () => {
    // HS256 would let anyone sign with a public value as the "secret".
    const token = signToken(validClaims(), { alg: 'HS256' });
    assert.throws(
      () => verifyIdToken(token, KID_JWKS, verifyOptions),
      /unsupported algorithm "HS256"/,
    );
    assert.ok(!ALLOWED_ALGORITHMS.includes('HS256' as never));
  });

  it('rejects a tampered payload', () => {
    const token = signToken(validClaims());
    const [header, , signature] = token.split('.') as [string, string, string];
    const tampered = `${header}.${base64url(JSON.stringify(validClaims({ sub: 'admin' })))}.${signature}`;
    assert.throws(() => verifyIdToken(tampered, KID_JWKS, verifyOptions), /signature is invalid/);
  });

  it('rejects a key whose pinned algorithm does not match the token', () => {
    const mismatched: Jwk[] = [{ ...jwk, kid: KEY_ID, use: 'sig', alg: 'RS512' }];
    assert.throws(
      () => verifyIdToken(signToken(validClaims()), mismatched, verifyOptions),
      /restricted to "RS512"/,
    );
  });
});

describe('claim validation', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('rejects a token from a different issuer', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ iss: 'https://evil.example.com' })), KID_JWKS, verifyOptions),
      /does not match the configured issuer/,
    );
  });

  it('rejects a token for a different audience', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ aud: 'someone-else' })), KID_JWKS, verifyOptions),
      /audience does not include/,
    );
  });

  it('rejects an expired token beyond the skew window', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ exp: now() - 600 })), KID_JWKS, verifyOptions),
      /has expired/,
    );
  });

  it('rejects a token that is not yet valid', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ nbf: now() + 600 })), KID_JWKS, verifyOptions),
      /not yet valid/,
    );
  });

  it('rejects a token issued far in the future', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ iat: now() + 3600 })), KID_JWKS, verifyOptions),
      /issued in the future/,
    );
  });

  it('rejects a mismatched nonce', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ nonce: 'from-another-session' })), KID_JWKS, verifyOptions),
      /nonce does not match/,
    );
  });

  it('rejects a token with no nonce when one was sent', () => {
    const claims = validClaims();
    delete claims.nonce;
    assert.throws(
      () => verifyIdToken(signToken(claims), KID_JWKS, verifyOptions),
      /carries no nonce/,
    );
  });

  it('rejects a token with no subject', () => {
    assert.throws(
      () => verifyIdToken(signToken(validClaims({ sub: undefined })), KID_JWKS, verifyOptions),
      /no subject/,
    );
  });

  it('accepts a token with no nonce when none was requested', () => {
    const claims = validClaims();
    delete claims.nonce;
    const verified = verifyIdToken(signToken(claims), KID_JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    assert.equal(verified.sub, 'user-123');
  });

  it('is deterministic when the clock is pinned', () => {
    const fixed = 1_700_000_000_000;
    // Valid at that instant, expired "now" — proves `now` is honoured.
    assert.doesNotThrow(() =>
      assertClaims(
        { iss: ISSUER, sub: 'x', aud: AUDIENCE, exp: fixed / 1000 + 60 },
        { issuer: ISSUER, audience: AUDIENCE, now: fixed },
      ),
    );
  });
});

describe('randomness sanity', () => {
  it('produces distinct signatures for distinct tokens', () => {
    const a = signToken(validClaims({ nonce: 'a' }));
    const b = signToken(validClaims({ nonce: 'b' }));
    assert.notEqual(a.split('.')[2], b.split('.')[2]);
    assert.ok(randomBytes(8).length === 8);
  });
});
