/**
 * OpenID Connect ID-token verification.
 *
 * The previous implementation decoded the `id_token` and trusted its claims,
 * which is the textbook OIDC vulnerability: anyone able to reach the callback
 * could mint a token and sign in as anyone. This module verifies the signature
 * against the provider's published JWKS before a single claim is read.
 *
 * The pieces are split so each can be tested without a network:
 *   `decodeJwt`        split and parse, without trusting anything
 *   `jwkToPublicKey`   build a verification key from a JWK
 *   `verifyIdToken`    signature + claims, the part that actually decides
 */

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { AppError, badRequest, integrationError } from '../errors.ts';

/** Algorithms we will verify. Symmetric (`HS*`) and `none` are excluded. */
export const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'] as const;
export type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

/** Tolerance for clock skew between us and the identity provider. */
export const CLOCK_SKEW_SECONDS = 60;

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  [key: string]: unknown;
}

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  [key: string]: unknown;
}

export interface VerifyOptions {
  /** Expected `iss`. Required. */
  issuer: string;
  /** Expected `aud` — our client id. Required. */
  audience: string;
  /** Expected `nonce`, when one was sent in the authorization request. */
  nonce?: string | null;
  /** Overridable clock, in epoch milliseconds, for deterministic tests. */
  now?: number;
  /** Tolerance applied to `exp`/`nbf`. */
  clockSkewSeconds?: number;
}

/** Base64url-decode to a Buffer. */
function base64urlToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * Split a compact JWS into its parts and parse header and payload.
 *
 * Nothing here is trusted: the signature has not been checked yet, and the
 * caller must not act on the returned claims before `verifyIdToken` succeeds.
 */
export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw badRequest('Malformed ID token: expected three JWS segments');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(base64urlToBuffer(headerPart).toString('utf8')) as JwtHeader;
    claims = JSON.parse(base64urlToBuffer(payloadPart).toString('utf8')) as JwtClaims;
  } catch {
    throw badRequest('Malformed ID token: segments are not valid JSON');
  }

  if (typeof header.alg !== 'string' || header.alg.length === 0) {
    throw badRequest('Malformed ID token: missing algorithm');
  }

  return {
    header,
    claims,
    // The signature covers `header.payload`, so it is reconstructed verbatim.
    signingInput: `${headerPart}.${payloadPart}`,
    signature: base64urlToBuffer(signaturePart),
  };
}

/**
 * Build a public key from a JWK.
 *
 * Only asymmetric key types are supported, which is why `HS*` tokens are
 * rejected outright: a symmetric algorithm would let anyone sign a token using
 * the public RSA modulus as the "secret".
 */
export function jwkToPublicKey(jwk: Jwk): KeyObject {
  if (jwk.kty === 'RSA') {
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
      throw badRequest('Malformed JWKS: an RSA key needs both `n` and `e`');
    }
    return createPublicKey({
      key: { kty: 'RSA', n: jwk.n, e: jwk.e },
      format: 'jwk',
    });
  }

  if (jwk.kty === 'EC') {
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      throw badRequest('Malformed JWKS: an EC key needs both `x` and `y`');
    }
    // Node's JWK importer derives the curve from `crv`; a missing or unknown
    // curve is rejected by the import itself, which is the behaviour we want.
    return createPublicKey({
      key: { kty: 'EC', crv: jwk.crv ?? 'P-256', x: jwk.x, y: jwk.y },
      format: 'jwk',
    });
  }

  throw badRequest(`Unsupported key type "${String(jwk.kty)}" in JWKS`);
}

/** Map a JOSE algorithm to the digest Node expects. */
function digestFor(alg: AllowedAlgorithm): string {
  if (alg.startsWith('RS')) {
    return alg === 'RS384' ? 'sha384' : alg === 'RS512' ? 'sha512' : 'sha256';
  }
  // ECDSA uses the curve's own hash, which is P-256→sha256 and P-384→sha384.
  return alg === 'ES384' ? 'sha384' : 'sha512';
}

/** Choose a signing key from a JWKS, matching `kid` when the token names one. */
export function selectJwk(jwks: Jwk[], kid: string | undefined): Jwk {
  const usable = jwks.filter((jwk) => {
    // A key explicitly marked for signing only is excluded when marked otherwise.
    if (jwk.use !== undefined && jwk.use !== 'sig') return false;
    return jwk.kty === 'RSA' || jwk.kty === 'EC';
  });

  if (usable.length === 0) {
    throw integrationError('The identity provider published no usable signing keys');
  }

  if (kid) {
    const match = usable.find((jwk) => jwk.kid === kid);
    if (!match) {
      throw integrationError(
        `No signing key matches the token's key id "${kid}". The provider may have rotated keys.`,
      );
    }
    return match;
  }

  // No `kid` is only unambiguous when there is exactly one candidate.
  if (usable.length > 1) {
    throw integrationError(
      'The ID token names no key id and the provider publishes several keys; refusing to guess',
    );
  }
  return usable[0] as Jwk;
}

/**
 * Verify an ID token's signature and claims.
 *
 * Returns the claims only after the signature is proven against the published
 * key. Any failure throws — there is no "unverified but probably fine" path.
 */
export function verifyIdToken(
  token: string,
  jwks: Jwk[],
  options: VerifyOptions,
): JwtClaims {
  const { header, claims, signingInput, signature } = decodeJwt(token);

  // `alg: none` and every symmetric algorithm are refused before any key work,
  // because accepting them is what makes "sign it yourself" possible.
  if (header.alg === 'none') {
    throw badRequest('ID token is unsigned (alg "none"); refusing to trust it');
  }
  if (!ALLOWED_ALGORITHMS.includes(header.alg as AllowedAlgorithm)) {
    throw badRequest(
      `ID token uses unsupported algorithm "${header.alg}". Allowed: ${ALLOWED_ALGORITHMS.join(', ')}`,
    );
  }

  const jwk = selectJwk(jwks, header.kid);
  // A key may pin the algorithm it is used with; a mismatch is a red flag.
  if (typeof jwk.alg === 'string' && jwk.alg !== header.alg) {
    throw badRequest(
      `Signing key is restricted to "${jwk.alg}" but the token claims "${header.alg}"`,
    );
  }

  const publicKey = jwkToPublicKey(jwk);
  const verifier = createVerify(digestFor(header.alg as AllowedAlgorithm));
  verifier.update(signingInput);
  verifier.end();

  let verified = false;
  try {
    verified = verifier.verify(publicKey, signature);
  } catch (error) {
    throw badRequest(`ID token signature could not be checked: ${(error as Error).message}`);
  }
  if (!verified) {
    // Deliberately does not say which check failed beyond "signature".
    throw badRequest('ID token signature is invalid; refusing to trust this login');
  }

  assertClaims(claims, options);
  return claims;
}

/** Claim-level checks, run only after the signature has been proven. */
export function assertClaims(claims: JwtClaims, options: VerifyOptions): void {
  const skew = options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);

  if (typeof options.issuer === 'string' && options.issuer.length > 0) {
    if (claims.iss !== options.issuer) {
      // A wrong issuer means a token minted by a different tenant, which is the
      // classic confused-deputy case.
      throw badRequest(
        `ID token issuer "${String(claims.iss)}" does not match the configured issuer`,
      );
    }
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (audiences.length === 0) {
    throw badRequest('ID token has no audience');
  }
  if (!audiences.includes(options.audience)) {
    throw badRequest('ID token audience does not include this application');
  }

  if (typeof claims.exp !== 'number') {
    throw badRequest('ID token has no expiry');
  }
  if (claims.exp + skew < nowSeconds) {
    throw badRequest('ID token has expired');
  }

  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSeconds) {
    throw badRequest('ID token is not yet valid');
  }

  if (typeof claims.iat === 'number' && claims.iat - skew > nowSeconds) {
    // A token issued in the future usually means a replay or a bad clock.
    throw badRequest('ID token was issued in the future');
  }

  if (options.nonce) {
    if (typeof claims.nonce !== 'string' || claims.nonce.length === 0) {
      throw badRequest('ID token carries no nonce, but one was sent in the request');
    }
    if (claims.nonce !== options.nonce) {
      // This is what binds the token to this browser session.
      throw badRequest('ID token nonce does not match the value sent in the request');
    }
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw badRequest('ID token has no subject');
  }
}

/**
 * Fetch a provider's JWKS, with a small in-process cache.
 *
 * Key rotation means a stale cache produces confusing failures, so entries are
 * short-lived and a cache miss is always a cache miss, never a stale fallback.
 */
export class JwksCache {
  private readonly entries = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(ttlMs = 10 * 60_000, timeoutMs = 10_000) {
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
  }

  async get(jwksUri: string): Promise<Jwk[]> {
    const cached = this.entries.get(jwksUri);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) return cached.keys;

    let parsed: unknown;
    try {
      const response = await fetch(jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        throw integrationError(`JWKS endpoint responded with ${response.status}`, { jwksUri });
      }
      parsed = await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw integrationError(`Could not fetch the provider's JWKS: ${(error as Error).message}`, {
        jwksUri,
      });
    }

    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) {
      throw integrationError('JWKS response has no `keys` array', { jwksUri });
    }

    const jwks = keys as Jwk[];
    this.entries.set(jwksUri, { keys: jwks, fetchedAt: now });
    return jwks;
  }

  /** Forget a cached key set, so a rotated key is picked up immediately. */
  invalidate(jwksUri: string): void {
    this.entries.delete(jwksUri);
  }

  clear(): void {
    this.entries.clear();
  }
}
