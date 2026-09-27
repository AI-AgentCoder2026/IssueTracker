/**
 * WebAuthn / passkey client contract.
 *
 * The protocol involves a conversion in each direction that is easy to get
 * subtly wrong, so it lives here rather than being re-implemented per screen.
 *
 * `fromWebAuthnJSON` and `toWebAuthnJSON` must walk the structure
 * **recursively**: `ArrayBuffer` values appear at several different depths —
 * `options.challenge`, `options.user.id`, `allowCredentials[].id`,
 * `excludeCredentials[].id`, and inside the authenticator's response
 * (`attestationObject`, `authenticatorData`, `signature`, `clientDataJSON`). A
 * shallow map that only handles the top level produces a request the browser
 * silently rejects, or worse, one that appears to work and carries a
 * mistyped challenge.
 *
 * The asymmetry matters too: on the way *in* to the browser, `user.id` and
 * `allowCredentials[].id` must be decoded from base64url into bytes; on the way
 * *out*, every buffer — including `id` and `rawId` — is encoded to base64url.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Browser surface
//
// This package is consumed by the server as well as the browser, and adding
// `lib: DOM` here would drag the whole DOM into the server build. Only the
// handful of members actually used are declared, so the contract stays narrow
// and an accidental dependency on some other global is a compile error.
// ---------------------------------------------------------------------------

interface PublicKeyCredentialConstructorLike {
  new (): unknown;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
}

interface CredentialsContainerLike {
  create?: (options: unknown) => Promise<unknown>;
  get?: (options: unknown) => Promise<unknown>;
}

declare const window: {
  PublicKeyCredential?: PublicKeyCredentialConstructorLike;
  btoa: (value: string) => string;
  atob: (value: string) => string;
};

declare const navigator: { credentials?: CredentialsContainerLike };

declare const btoa: (value: string) => string;
declare const atob: (value: string) => string;

declare const DOMException: {
  new (message?: string, name?: string): Error & { name: string };
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Base64url encode without padding, which is what WebAuthn uses. */
export function bufferToBase64url(value: ArrayBuffer | Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return '';
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  // Chunked so a large attestation object does not blow the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBuffer(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Recursively convert a server-supplied options object into the shape
 * `navigator.credentials.create` / `.get` expect.
 */
export function fromWebAuthnJSON<T>(value: unknown): T {
  const walk = (input: unknown, key?: string): unknown => {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      // Every string in these payloads that is not a `type`/`alg`/`userVerification`
      // is a base64url binary. `type` is the one string field that must not move.
      if (key === 'type') return input;
      return base64urlToBuffer(input);
    }
    if (Array.isArray(input)) return input.map((entry) => walk(entry, key));
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      return new Uint8Array(input instanceof ArrayBuffer ? input : input.buffer);
    }
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(input as Record<string, unknown>)) {
        out[entryKey] = walk(entryValue, entryKey);
      }
      return out;
    }
    return input;
  };
  return walk(value) as T;
}

/**
 * Recursively convert a `PublicKeyCredential` into the JSON the server
 * verifies. Buffers become base64url strings; everything else passes through.
 */
export function toWebAuthnJSON(value: unknown): unknown {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return input;
    if (input instanceof ArrayBuffer) return bufferToBase64url(input);
    if (ArrayBuffer.isView(input)) {
      const view = input as ArrayBufferView;
      return bufferToBase64url(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        out[key] = walk(entry);
      }
      return out;
    }
    return input;
  };
  return walk(value);
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** True when this browser can create or use a credential at all. */
export function isWebAuthnAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.PublicKeyCredential !== 'function') return false;
  // Some browsers expose the constructor but not the conditional-mediation
  // surface; the basic create/get path is what we actually require.
  return typeof navigator !== 'undefined' && typeof navigator.credentials?.create === 'function';
}

/**
 * True when the device has a built-in authenticator — which is what makes
 * Face ID, Touch ID or a fingerprint available rather than a roaming key.
 *
 * The probe is feature-detected because the static method is absent in some
 * browsers, and a false here must degrade to "we cannot tell", never to an
 * error.
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  const probe = window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof probe !== 'function') return false;
  try {
    return await probe.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

/**
 * A user closing the platform sheet raises `AbortError`. That is a normal
 * outcome, not a failure, and must not be reported as an error.
 */
export function isCredentialAborted(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'NotAllowedError')
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const PASSKEY_ATTACHMENTS = ['platform', 'cross-platform'] as const;
export type PasskeyAttachment = (typeof PASSKEY_ATTACHMENTS)[number];

export interface PasskeyCredentialSummary {
  id: number;
  label: string;
  /**
   * `platform` means the key is bound to this device and the sign-in is gated
   * behind its Face ID / fingerprint. `cross-platform` is a roaming security
   * key or a synced passkey, which travels between devices.
   */
  attachment: PasskeyAttachment;
  /** A synced passkey is a convenience, not a device-bound secret. */
  backedUp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PasskeyRegistrationResponse {
  credential: PasskeyCredentialSummary;
}

export interface PasskeyAuthenticationResponse {
  sessionId: string;
  expiresAt: string;
  credential: { id: number; label: string };
}

export interface PasskeyListResponse {
  credentials: PasskeyCredentialSummary[];
  currentSessionId: string | null;
}

export const passkeyRegistrationResponseSchema = z.object({
  credential: z.object({
    id: z.number().int().positive(),
    label: z.string(),
    attachment: z.enum(PASSKEY_ATTACHMENTS),
    backedUp: z.boolean(),
    lastUsedAt: z.string().nullable().optional(),
    createdAt: z.string(),
  }),
});

export const passkeyAuthenticationResponseSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string(),
  credential: z.object({ id: z.number().int().positive(), label: z.string() }),
});

export const passkeyListResponseSchema = z.object({
  credentials: z.array(
    z.object({
      id: z.number().int().positive(),
      label: z.string(),
      attachment: z.enum(PASSKEY_ATTACHMENTS),
      backedUp: z.boolean(),
      lastUsedAt: z.string().nullable().optional(),
      createdAt: z.string(),
    }),
  ),
  currentSessionId: z.string().nullable().optional(),
});

/** Human wording for the device type, used in the management list. */
export function describeAttachment(credential: PasskeyCredentialSummary): string {
  if (credential.attachment === 'cross-platform') {
    return credential.backedUp
      ? 'Synced passkey — works on your other devices'
      : 'Security key or roaming authenticator';
  }
  return 'This device — unlocked with Face ID, Touch ID or a fingerprint';
}
