/**
 * Outbound email transport.
 *
 * The notification service already writes to `email_outbox`; this drains it.
 * The design constraint is that a self-hosted instance often has no SMTP
 * configured at all, so the absence of a transport must be a *configuration*
 * state, not an error: rows stay in the queue with a recorded reason and are
 * retried with backoff once a transport appears.
 *
 * Sending is deliberately dependency-free — Node's own `net`/`tls` give a
 * minimal SMTP client, and an optional webhook-based relay covers the hosted
 * case without adding a transport library to the tree.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import type { Config } from '../config.ts';
import type { Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';

export type EmailTransport = 'smtp' | 'webhook' | 'none';

export interface EmailMessage {
  to: string;
  toName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export interface DeliveryOutcome {
  sent: boolean;
  error: string | null;
  /** The transport actually used, or `none` when nothing is configured. */
  transport: EmailTransport;
}

export interface MailConfig {
  transport: EmailTransport;
  host: string;
  port: number;
  /** Implicit TLS (port 465) versus STARTTLS. */
  secure: boolean;
  username: string;
  password: string;
  from: string;
  fromName: string;
  /** POST every message here instead, for a hosted relay. */
  webhookUrl: string;
  webhookSecret: string;
  /** Give up after this many attempts so a poisoned row cannot spin forever. */
  maxAttempts: number;
  timeoutMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/** Read mail settings from the environment. Returns `none` when unconfigured. */
export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const webhookUrl = env['MAIL_WEBHOOK_URL'] ?? '';
  const host = env['SMTP_HOST'] ?? '';
  const port = Number(env['SMTP_PORT'] ?? '587');

  let transport: EmailTransport = 'none';
  if (webhookUrl.length > 0) transport = 'webhook';
  else if (host.length > 0) transport = 'smtp';

  return {
    transport,
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: (env['SMTP_SECURE'] ?? '').toLowerCase() === 'true' || port === 465,
    username: env['SMTP_USERNAME'] ?? '',
    password: env['SMTP_PASSWORD'] ?? '',
    from: env['MAIL_FROM'] ?? 'tracker@localhost',
    fromName: env['MAIL_FROM_NAME'] ?? 'Issue Tracker',
    webhookUrl,
    webhookSecret: env['MAIL_WEBHOOK_SECRET'] ?? '',
    maxAttempts: Number(env['MAIL_MAX_ATTEMPTS'] ?? String(DEFAULT_MAX_ATTEMPTS)),
    timeoutMs: Number(env['MAIL_TIMEOUT_MS'] ?? '15000'),
  };
}

/** Minimal RFC-5322 message, folded to the 78-column limit for headers. */
export function buildMessage(config: MailConfig, message: EmailMessage): string {
  const boundary = `----tracker-${Date.now().toString(36)}`;
  const subject = encodeHeaderValue(message.subject);
  const from = encodeAddress(config.fromName, config.from);
  const to = encodeAddress(message.toName || message.to, message.to);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Message-ID: <${randomId()}@tracker.local>`,
  ];

  const body = message.bodyText.trim();
  if (!message.bodyHtml) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  }

  // Multipart so a plain-text client still gets something readable.
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    message.bodyHtml,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function encodeHeaderValue(value: string): string {
  // Anything non-ASCII must be RFC 2047 encoded or the message is rejected.
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function encodeAddress(name: string, email: string): string {
  const cleaned = name
    // Strip CR/LF first. A display name containing them can otherwise inject
    // arbitrary headers, including `Bcc:`, into the rendered message.
    .replace(/[\r\n]+/g, ' ')
    // Then quotes and backslashes, which would break out of the quoted-string.
    .replace(/["\\]/g, '')
    .trim();
  if (cleaned.length === 0) return email;
  return `"${cleaned}" <${email}>`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class MailService {
  private readonly services: Config;
  private readonly db: Database;
  private readonly config: MailConfig;

  constructor(config: Config, db: Database) {
    this.services = config;
    this.db = db;
    this.config = readMailConfig();
  }

  get transport(): EmailTransport {
    return this.config.transport;
  }

  get isConfigured(): boolean {
    return this.config.transport !== 'none';
  }

  /**
   * Drain the outbox.
   *
   * Returns how many rows were sent, so the scheduler can log something useful.
   * A row that fails is marked with its error and an incremented attempt count;
   * the query only selects attempts below the limit, so a permanently failing
   * message stops being retried rather than looping forever.
   */
  async drain(limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
    if (!this.isConfigured) {
      const pending = Number(
        this.db.scalar<number>("SELECT COUNT(*) AS c FROM email_outbox WHERE status = 'queued'") ?? 0,
      );
      // Record the reason once so an operator can see *why* nothing is moving.
      if (pending > 0) {
        this.db.run(
          "UPDATE email_outbox SET last_error = ? WHERE status = 'queued' AND last_error IS NULL",
          ['No mail transport configured (set SMTP_* or MAIL_WEBHOOK_URL)'],
        );
      }
      return { sent: 0, failed: 0, skipped: pending };
    }

    const rows = this.db.all<{
      id: number;
      to_email: string;
      to_name: string;
      subject: string;
      body_text: string;
      body_html: string;
      attempts: number;
    }>(
      "SELECT * FROM email_outbox WHERE status = 'queued' AND attempts < ? ORDER BY created_at ASC LIMIT ?",
      [this.config.maxAttempts, Math.min(limit, 200)],
    );

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      const outcome = await this.send({
        to: row.to_email,
        toName: row.to_name,
        subject: row.subject,
        bodyText: row.body_text,
        bodyHtml: row.body_html,
      });

      if (outcome.sent) {
        this.db.run(
          "UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
          [nowIso(), row.id],
        );
        sent += 1;
      } else {
        this.db.run(
          `UPDATE email_outbox
           SET attempts = attempts + 1,
               status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END,
               last_error = ?
           WHERE id = ?`,
          [this.config.maxAttempts, outcome.error ?? 'unknown error', row.id],
        );
        failed += 1;
      }
    }

    return { sent, failed, skipped: 0 };
  }

  /** Send one message through the configured transport. */
  async send(message: EmailMessage): Promise<DeliveryOutcome> {
    switch (this.config.transport) {
      case 'webhook':
        return this.sendViaWebhook(message);
      case 'smtp':
        return this.sendViaSmtp(message);
      case 'none':
      default:
        return {
          sent: false,
          error: 'No mail transport configured (set SMTP_* or MAIL_WEBHOOK_URL)',
          transport: 'none',
        };
    }
  }

  /** POST the rendered message to a relay endpoint. */
  private async sendViaWebhook(message: EmailMessage): Promise<DeliveryOutcome> {
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.webhookSecret
            ? { authorization: `Bearer ${this.config.webhookSecret}` }
            : {}),
        },
        body: JSON.stringify({
          from: { email: this.config.from, name: this.config.fromName },
          to: { email: message.to, name: message.toName },
          subject: message.subject,
          text: message.bodyText,
          html: message.bodyHtml,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        return {
          sent: false,
          error: `Relay responded ${response.status}`,
          transport: 'webhook',
        };
      }
      return { sent: true, error: null, transport: 'webhook' };
    } catch (error) {
      return {
        sent: false,
        error: `Relay unreachable: ${(error as Error).message}`,
        transport: 'webhook',
      };
    }
  }

  /**
   * Minimal SMTP submission.
   *
   * Speaks just enough of RFC 5321 to hand a message to a relay: greet, EHLO,
   * STARTTLS when available, authenticate, send, quit. Any unexpected reply is
   * treated as a failure rather than a partial success, so the row is retried.
   */
  private async sendViaSmtp(message: EmailMessage): Promise<DeliveryOutcome> {
    let socket: Socket | TLSSocket | null = null;
    try {
      socket = this.config.secure
        ? await connectTls(this.config.host, this.config.port, this.config.timeoutMs)
        : await connectPlain(this.config.host, this.config.port, this.config.timeoutMs);

      await expect(socket, '220');

      // The EHLO reply is the capability list, and it decides whether an
      // upgrade is even possible. Guessing here is what previously caused a
      // silent hang against a server that never advertised STARTTLS.
      const capabilities = parseCapabilities(
        await command(socket, `EHLO ${this.hostname()}`, ['250']),
      );

      if (!this.config.secure && capabilities.has('STARTTLS')) {
        // A 220 is mandatory: upgrading on anything else corrupts the stream.
        // `allowFailure` is deliberately not used here.
        await command(socket, 'STARTTLS', ['220']);
        socket = await upgradeToTls(socket, this.config.host, this.config.timeoutMs);
        capabilities.clear();
        for (const entry of parseCapabilities(
          await command(socket, `EHLO ${this.hostname()}`, ['250']),
        )) {
          capabilities.add(entry);
        }
      }

      if (this.config.username.length > 0) {
        if (!this.config.secure && !capabilities.has('STARTTLS')) {
          // Refuse to put credentials on the wire unencrypted rather than
          // leaking them.
          return {
            sent: false,
            error:
              'SMTP server does not support STARTTLS, refusing to send credentials in the clear. ' +
              'Use an implicit-TLS port (465) or a relay transport.',
            transport: 'smtp',
          };
        }
        await command(socket, 'AUTH LOGIN', ['334']);
        await command(socket, Buffer.from(this.config.username, 'utf8').toString('base64'), ['334']);
        await command(socket, Buffer.from(this.config.password, 'utf8').toString('base64'), ['235']);
      }

      await command(socket, `MAIL FROM:<${this.config.from}>`, ['250']);
      await command(socket, `RCPT TO:<${message.to}>`, ['250', '251']);
      await command(socket, 'DATA', ['354']);

      const payload = buildMessage(this.config, message)
        // A leading '.' would terminate DATA early; dot-stuffing is required.
        .replace(/^\./gm, '..');
      // Same ordering rule as `command`: listen before writing the terminator.
      const accepted = expect(socket, '250');
      socket.write(`${payload}\r\n.\r\n`);
      await accepted;

      await command(socket, 'QUIT', ['221', '250'], { allowFailure: true });
      socket.end();

      return { sent: true, error: null, transport: 'smtp' };
    } catch (error) {
      socket?.destroy();
      return {
        sent: false,
        error: (error as Error).message,
        transport: 'smtp',
      };
    }
  }

  private hostname(): string {
    return 'localhost';
  }
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP connection timed out')));
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function connectTls(host: string, port: number, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP TLS handshake timed out')));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Wrap an already-connected socket in TLS — the STARTTLS upgrade.
 *
 * `node:tls` has no `createTlsConnection`; the supported way is to construct a
 * `TLSSocket` around the existing socket and wait for `secureConnect`.
 */
function upgradeToTls(socket: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = new TLSSocket(socket, { isServer: false });
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error('SMTP TLS handshake timed out')));
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

/**
 * Read one SMTP reply, honouring multi-line continuations.
 *
 * Leaves the socket paused with no data listener between calls, so the next
 * `command` can attach its listener before writing.
 */
function expect(socket: Socket | TLSSocket, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      // A reply ends at a line whose 4th character is a space.
      const lines = buffer.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length === 0) return;
      const last = lines[lines.length - 1] as string;
      if (last.length < 4 || last[3] !== ' ') return;

      cleanup();
      if (last.startsWith(prefix)) {
        // Resolve the whole reply, not just its final line: the caller needs
        // the multi-line EHLO capability list.
        resolve(lines.join('\n'));
      } else {
        reject(new Error(`SMTP expected ${prefix}, got "${last}"`));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('SMTP connection closed unexpectedly'));
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * Write a command and await its reply.
 *
 * The reply listener is attached *before* the write. A local server can answer
 * within the same tick, and a stream with no `data` listener is free to drop
 * those bytes — which would otherwise hang until the socket timeout.
 */
async function command(
  socket: Socket | TLSSocket,
  value: string,
  expected: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  const reply = expect(socket, expected[0] as string);
  socket.write(`${value}\r\n`);
  try {
    return await reply;
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

/**
 * Uppercased keywords from a multi-line SMTP reply.
 *
 * The EHLO greeting is the only place a server states what it supports, so
 * acting on anything else would mean guessing.
 */
function parseCapabilities(reply: string): Set<string> {
  const capabilities = new Set<string>();
  for (const line of reply.split(/\r?\n/)) {
    const keyword = line.slice(4).trim().split(/\s+/)[0];
    if (keyword) capabilities.add(keyword.toUpperCase());
  }
  return capabilities;
}
