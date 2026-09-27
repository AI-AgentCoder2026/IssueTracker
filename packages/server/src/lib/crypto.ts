/**
 * Cryptographic helpers built on `node:crypto` only — no native dependency.
 *
 * Password hashing uses scrypt (memory-hard, in Node's standard library).
 * Integration tokens are encrypted with AES-256-GCM using the per-installation
 * key so a database file copied off the host does not yield usable GitLab
 * credentials.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16_384; // ~2^14; the OWASP baseline for scrypt.
const SCRYPT_BLOCKSIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SALT_BYTES = 16;

/**
 * Encode as `scrypt$N$r$p$salt$hash`, all binary parts base64url. The
 * parameters travel with the hash so they can be raised later without
 * invalidating existing passwords.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCKSIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: 128 * SCRYPT_KEYLEN * SCRYPT_COST * 2,
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCKSIZE,
    SCRYPT_PARALLELISM,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelism)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: 128 * expected.length * cost * 2,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Whether a hash was produced with weaker parameters than the current default
 * and should be upgraded on the next successful login.
 */
export function needsPasswordRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_COST;
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/** URL-safe random token. 32 bytes gives 256 bits of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateSessionId(): string {
  return randomBytes(48).toString('base64url');
}

/** First 8 characters of a token, stored so a user can identify it later. */
export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

/** Tokens are stored as hashes so a database leak cannot be replayed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashOpaque(value: string): string {
  return hashToken(value);
}

// ---------------------------------------------------------------------------
// Symmetric encryption (integration tokens, SSO client secrets)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // version | iv | authTag | ciphertext
  return Buffer.concat([Buffer.from([1]), iv, authTag, encrypted]).toString('base64url');
}

export function decrypt(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64url');
  const version = raw[0];
  if (version !== 1) {
    throw new Error(`Unsupported ciphertext version ${String(version)}`);
  }
  const iv = raw.subarray(1, 1 + IV_BYTES);
  const authTag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + 16);
  const ciphertext = raw.subarray(1 + IV_BYTES + 16);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Signatures & digests
// ---------------------------------------------------------------------------

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time comparison for signature verification. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still run a comparison so the timing does not reveal the length mismatch.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Mask a secret for display: keeps the first few characters so a user can
 * confirm which token is configured without exposing it.
 */
export function maskSecret(secret: string, visible = 4): string {
  if (secret.length <= visible) return '*'.repeat(secret.length);
  return `${secret.slice(0, visible)}${'*'.repeat(Math.min(secret.length - visible, 12))}`;
}

// ---------------------------------------------------------------------------
// PII / secret scrubbing
// ---------------------------------------------------------------------------

type ScrubReplacement = string | ((...args: never[]) => string);

const SCRUB_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp; replacement: ScrubReplacement }> = [
  // AWS access key ids
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED:aws-key]' },
  // Google API keys
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED:google-api-key]' },
  // Slack tokens
  { name: 'slack_token', pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g, replacement: '[REDACTED:slack-token]' },
  // GitHub tokens
  { name: 'github_token', pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g, replacement: '[REDACTED:github-token]' },
  // GitLab personal access tokens
  { name: 'gitlab_token', pattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/g, replacement: '[REDACTED:gitlab-token]' },
  // Private key blocks
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  // JWTs
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  // Bearer headers
  { name: 'bearer', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: 'Bearer [REDACTED]' },
  // Generic `something = <value>` secrets. The keyword list is deliberately
  // broad — `access_token`, `client_secret` and friends are as common as
  // `password` and just as sensitive.
  {
    name: 'generic_secret',
    pattern:
      /\b(api[_-]?key|secret|password|passwd|passphrase|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|access[_-]?key|credential[s]?)\b(\s*[:=]\s*|\s+)(["']?)([^\s"',;]{8,})\3/gi,
    replacement: (_match, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}[REDACTED]${quote}`,
  },
  // Email addresses
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED:email]',
  },
  // Credit-card-like digit runs
  {
    name: 'card',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[REDACTED:card]',
  },
];

export interface ScrubOptions {
  /** Patterns to skip, by name. */
  except?: string[];
  /** Replace email addresses too. Off by default for issue text. */
  includeEmail?: boolean;
}

/**
 * Redact credentials and personal data from free text.
 *
 * Used for the "scrub PII" requirement: issue descriptions and comments can be
 * passed through this before mirroring to an external system such as GitLab.
 */
export function scrubSecrets(input: string, options: ScrubOptions = {}): string {
  const except = new Set(options.except ?? []);
  let output = input;

  for (const { name, pattern, replacement } of SCRUB_PATTERNS) {
    if (except.has(name)) continue;
    if (name === 'email' && !options.includeEmail) continue;
    if (typeof replacement === 'string') {
      output = output.replace(pattern, replacement);
    } else {
      // Functional replacements re-wrap the captured keyword and separator so
      // the redaction keeps the shape of the original text. The cast is needed
      // because `String.replace` types its replacer with `any[]` args, which a
      // `never[]` signature cannot satisfy.
      output = output.replace(
        pattern,
        replacement as unknown as (substring: string, ...args: unknown[]) => string,
      );
    }
  }

  return output;
}

/** Names of the patterns `scrubSecrets` can apply, for the settings UI. */
export const SCRUB_PATTERN_NAMES: readonly string[] = SCRUB_PATTERNS.map((p) => p.name);
