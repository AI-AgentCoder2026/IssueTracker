/**
 * Runtime configuration, resolved once at startup from the environment.
 *
 * Every value has a development-friendly default except the secrets, which
 * are generated and persisted on first boot so a fresh clone runs without
 * any setup while still not shipping a hard-coded key.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicUrl: string;
  /** Directory holding the SQLite database and uploaded files. */
  dataDir: string;
  databaseFile: string;
  uploadDir: string;
  /** Absolute key used to encrypt integration tokens at rest. */
  encryptionKey: Buffer;
  sessionSecret: Buffer;
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number;
  /** Cors allow-list; empty means reflect the request origin. */
  corsOrigins: string[];
  /** Serve the built SPA from the API process when present. */
  serveWebClient: boolean;
  webClientDir: string;
  /** Maximum accepted upload size in bytes. */
  maxUploadBytes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Background scheduler on/off; disabled in tests to keep them deterministic. */
  enableScheduler: boolean;
  /** Outgoing webhook delivery timeout in milliseconds. */
  webhookTimeoutMs: number;
  /** GitLab API timeout in milliseconds. */
  gitlabTimeoutMs: number;
  /** Seed an admin account on first boot. */
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
  /** Trust X-Forwarded-* headers when behind a reverse proxy. */
  trustProxy: boolean;
}

function envString(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, received "${raw}"`);
  }
  return parsed;
}

function envBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envList(key: string): string[] {
  const raw = process.env[key];
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Load a 32-byte secret from `dataDir/.secrets.json`, creating it on first run.
 * Returning a stable per-installation value means restarting the server does not
 * invalidate every session and cannot decrypt stored GitLab tokens.
 */
function loadOrCreateSecret(dataDir: string, name: string): Buffer {
  const secretsPath = resolve(dataDir, '.secrets.json');
  let store: Record<string, string> = {};

  if (existsSync(secretsPath)) {
    try {
      store = JSON.parse(readFileSync(secretsPath, 'utf8')) as Record<string, string>;
    } catch {
      // A corrupt file is replaced rather than crashing the boot; the operator
      // loses existing sessions but the server still starts.
      store = {};
    }
  }

  const existing = store[name];
  if (typeof existing === 'string' && existing.length > 0) {
    return Buffer.from(existing, 'base64');
  }

  const generated = randomBytes(32);
  store[name] = generated.toString('base64');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(secretsPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  return generated;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = envString('NODE_ENV', 'development') as Config['env'];
  const dataDir = resolve(envString('DATA_DIR', './data'));

  const port = envNumber('PORT', 4000);
  const host = envString('HOST', '0.0.0.0');

  const config: Config = {
    env,
    host,
    port,
    publicUrl: envString('PUBLIC_URL', `http://localhost:${port}`),
    dataDir,
    databaseFile: resolve(
      dataDir,
      envString('DATABASE_FILE', env === 'test' ? 'test.db' : 'tracker.db'),
    ),
    uploadDir: resolve(dataDir, envString('UPLOAD_DIR', 'uploads')),
    encryptionKey: loadOrCreateSecret(dataDir, 'encryptionKey'),
    sessionSecret: loadOrCreateSecret(dataDir, 'sessionSecret'),
    sessionTtlSeconds: envNumber('SESSION_TTL_SECONDS', 60 * 60 * 24 * 7),
    corsOrigins: envList('CORS_ORIGINS'),
    serveWebClient: envBoolean('SERVE_WEB_CLIENT', true),
    webClientDir: resolve(envString('WEB_CLIENT_DIR', '../web/dist')),
    maxUploadBytes: envNumber('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
    logLevel: envString('LOG_LEVEL', env === 'test' ? 'silent' : 'info') as Config['logLevel'],
    enableScheduler: envBoolean('ENABLE_SCHEDULER', env !== 'test'),
    webhookTimeoutMs: envNumber('WEBHOOK_TIMEOUT_MS', 10_000),
    gitlabTimeoutMs: envNumber('GITLAB_TIMEOUT_MS', 20_000),
    bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || null,
    trustProxy: envBoolean('TRUST_PROXY', false),
    ...overrides,
  };

  return config;
}

/** Path of the built SPA index, when one is present to serve. */
export function webClientIndex(config: Config): string | null {
  const indexPath = resolve(config.webClientDir, 'index.html');
  return existsSync(indexPath) ? indexPath : null;
}

export { dirname };
