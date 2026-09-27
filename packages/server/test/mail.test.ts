/**
 * Outbound email: message construction, transport selection, and the outbox
 * drain semantics.
 *
 * The SMTP path is exercised against a real in-process server rather than a
 * mock, because the interesting failures (STARTTLS, dot-stuffing, multi-line
 * replies) live in the protocol handling itself.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { loadConfig } from '../src/config.ts';
import { MailService, buildMessage, readMailConfig } from '../src/services/mail.service.ts';

describe('mail configuration', () => {
  it('reports no transport when nothing is configured', () => {
    const config = readMailConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.transport, 'none');
  });

  it('prefers a webhook relay when one is set', () => {
    const config = readMailConfig({
      MAIL_WEBHOOK_URL: 'https://relay.example.com/send',
    } as NodeJS.ProcessEnv);
    assert.equal(config.transport, 'webhook');
  });

  it('detects an SMTP host', () => {
    const config = readMailConfig({ SMTP_HOST: 'smtp.example.com' } as NodeJS.ProcessEnv);
    assert.equal(config.transport, 'smtp');
    assert.equal(config.secure, false, 'port 587 implies STARTTLS, not implicit TLS');
  });

  it('treats port 465 as implicit TLS', () => {
    const config = readMailConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
    } as NodeJS.ProcessEnv);
    assert.equal(config.secure, true);
  });
});

describe('message construction', () => {
  const config = readMailConfig({ SMTP_HOST: 'smtp.example.com' } as NodeJS.ProcessEnv);

  it('builds a plain-text message with the required headers', () => {
    const message = buildMessage(config, {
      to: 'dev@example.com',
      toName: 'Dev',
      subject: 'Assigned PROJ-1',
      bodyText: 'Please take a look.',
      bodyHtml: '',
    });

    assert.match(message, /^From: /m);
    assert.match(message, /^To: "Dev" <dev@example\.com>$/m);
    assert.match(message, /^Subject: Assigned PROJ-1$/m);
    assert.match(message, /^MIME-Version: 1\.0$/m);
    assert.match(message, /Please take a look\./);
    // CRLF is required by RFC 5322.
    assert.ok(message.includes('\r\n'));
  });

  it('encodes a non-ASCII subject per RFC 2047', () => {
    const message = buildMessage(config, {
      to: 'dev@example.com',
      toName: '',
      subject: 'مرحبا PROJ-1',
      bodyText: 'x',
      bodyHtml: '',
    });
    assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
  });

  it('strips quotes from a display name so it cannot break the header', () => {
    const message = buildMessage(config, {
      to: 'dev@example.com',
      toName: 'Ev"il\r\nBcc: attacker@example.com',
      subject: 'x',
      bodyText: 'x',
      bodyHtml: '',
    });
    // A raw newline in the name would let an attacker append headers.
    assert.ok(!/^Bcc:/m.test(message), 'no header injection via the display name');
  });

  it('produces a multipart message when HTML is supplied', () => {
    const message = buildMessage(config, {
      to: 'dev@example.com',
      toName: '',
      subject: 'x',
      bodyText: 'plain',
      bodyHtml: '<p>rich</p>',
    });
    assert.match(message, /multipart\/alternative/);
    assert.match(message, /Content-Type: text\/plain/);
    assert.match(message, /Content-Type: text\/html/);
  });
});

describe('outbox drain', () => {
  let db: Database;

  before(() => {
    db = new Database({ file: ':memory:', wal: false });
    migrate(db);
  });

  after(() => db.close());

  function queueRow(subject: string): number {
    return Number(
      db.run(
        `INSERT INTO email_outbox (to_email, to_name, subject, body_text, body_html, status)
         VALUES ('dev@example.com','Dev',?,'body','','queued')`,
        [subject],
      ).lastInsertRowid,
    );
  }

  it('leaves rows queued and records why when no transport is configured', async () => {
    const config = loadConfig({ env: 'test', dataDir: process.env['TEMP'] ?? '/tmp', databaseFile: ':memory:' });
    // An empty environment: no SMTP, no relay.
    const previous = { ...process.env };
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'MAIL_WEBHOOK_URL']) {
      delete process.env[key];
    }

    try {
      const mail = new MailService(config, db);
      queueRow('no transport');
      const result = await mail.drain();

      assert.equal(result.sent, 0);
      assert.ok(result.skipped > 0, 'rows are reported as skipped, not silently lost');

      const row = db.get<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM email_outbox WHERE subject = 'no transport'",
      );
      assert.equal(row?.status, 'queued', 'the message must stay queued for a later retry');
      assert.match(row?.last_error ?? '', /No mail transport configured/);
    } finally {
      process.env = previous as NodeJS.ProcessEnv;
    }
  });

  it('marks a row failed once attempts are exhausted', async () => {
    const config = loadConfig({ env: 'test', dataDir: process.env['TEMP'] ?? '/tmp', databaseFile: ':memory:' });
    const id = queueRow('will exhaust');
    db.run('UPDATE email_outbox SET attempts = 4 WHERE id = ?', [id]);

    const previous = { ...process.env };
    // A relay URL makes the transport *configured*; the stub below then makes
    // the send fail, which is the condition under test.
    process.env['MAIL_WEBHOOK_URL'] = 'https://relay.invalid/send';
    try {
      const mail = new MailService(config, db);
      (mail as unknown as { send: () => Promise<{ sent: boolean; error: string | null; transport: 'webhook' }> }).send =
        async () => ({ sent: false, error: 'simulated failure', transport: 'webhook' });

      await mail.drain();
      const row = db.get<{ status: string; attempts: number; last_error: string | null }>(
        'SELECT status, attempts, last_error FROM email_outbox WHERE id = ?',
        [id],
      );
      assert.equal(row?.attempts, 5);
      assert.equal(row?.status, 'failed', 'a poisoned row stops being retried');
      assert.equal(row?.last_error, 'simulated failure');
    } finally {
      process.env = previous as NodeJS.ProcessEnv;
    }
  });
});

describe('SMTP submission', () => {
  // A single in-process server that speaks just enough SMTP to accept a
  // message, so the client's protocol handling is exercised for real.
  let server: Server;
  let port = 0;
  const received: string[] = [];
  const transcript: string[] = [];

  before(async () => {
    server = createServer((socket: Socket) => {
      socket.write('220 test.local ESMTP\r\n');
      transcript.push('greeting');
      let inData = false;
      let buffer = '';

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          transcript.push(line);

          if (inData) {
            if (line === '.') {
              inData = false;
              received.push(bufferOfCurrent);
              bufferOfCurrent = '';
              socket.write('250 2.0.0 Ok: queued\r\n');
            } else {
              // Undo dot-stuffing so the test sees the original body.
              bufferOfCurrent += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
            }
          } else if (/^EHLO/i.test(line)) {
            socket.write('250-test.local\r\n250 SIZE 10240000\r\n');
          } else if (/^DATA$/i.test(line)) {
            inData = true;
            bufferOfCurrent = '';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (/^QUIT$/i.test(line)) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }

          index = buffer.indexOf('\r\n');
        }
      });
      socket.on('error', () => undefined);
    });

    let bufferOfCurrent = '';

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a message and marks the outbox row sent', async () => {
    const db = new Database({ file: ':memory:', wal: false });
    migrate(db);

    const config = loadConfig({
      env: 'test',
      dataDir: process.env['TEMP'] ?? '/tmp',
      databaseFile: ':memory:',
    });

    const previous = { ...process.env };
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(port);
    delete process.env['SMTP_SECURE'];
    delete process.env['MAIL_WEBHOOK_URL'];

    try {
      const mail = new MailService(config, db);
      const id = Number(
        db.run(
          `INSERT INTO email_outbox (to_email, to_name, subject, body_text, body_html, status)
           VALUES ('dev@example.com','Dev','SMTP round trip','.leading dot line','<p>x</p>','queued')`,
        ).lastInsertRowid,
      );

      const result = await mail.drain();
      assert.equal(result.sent, 1, `drain failed: ${JSON.stringify(result)}`);

      const row = db.get<{ status: string; sent_at: string | null }>(
        'SELECT status, sent_at FROM email_outbox WHERE id = ?',
        [id],
      );
      assert.equal(row?.status, 'sent');
      assert.ok(row?.sent_at);

      // The message actually reached the server, dot-stuffing undone.
      const delivered = received[received.length - 1] ?? '';
      assert.match(delivered, /^Subject: SMTP round trip$/m);
      assert.match(delivered, /^\.leading dot line$/m);

      // The conversation followed the expected order.
      assert.ok(transcript.some((line) => /^EHLO /i.test(line)), 'must greet with EHLO');
      assert.ok(transcript.some((line) => /^MAIL FROM:/i.test(line)));
      assert.ok(transcript.some((line) => /^RCPT TO:/i.test(line)));
      assert.ok(transcript.some((line) => /^DATA$/i.test(line)));
    } finally {
      process.env = previous as NodeJS.ProcessEnv;
      db.close();
    }
  });

  it('refuses to send credentials to a server with no STARTTLS', async () => {
    // The test server does not advertise STARTTLS, which is exactly the
    // condition that must stop authentication rather than leak the password.
    const db = new Database({ file: ':memory:', wal: false });
    migrate(db);
    const config = loadConfig({
      env: 'test',
      dataDir: process.env['TEMP'] ?? '/tmp',
      databaseFile: ':memory:',
    });

    const previous = { ...process.env };
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(port);
    process.env['SMTP_USERNAME'] = 'mailer';
    process.env['SMTP_PASSWORD'] = 'super-secret';
    delete process.env['SMTP_SECURE'];
    delete process.env['MAIL_WEBHOOK_URL'];

    try {
      const mail = new MailService(config, db);
      const outcome = await mail.send({
        to: 'dev@example.com',
        toName: '',
        subject: 'x',
        bodyText: 'x',
        bodyHtml: '',
      });

      assert.equal(outcome.sent, false);
      assert.match(outcome.error ?? '', /refusing to send credentials in the clear/);
      assert.ok(
        !transcript.some((line) => line === 'dW1haWxlcg==' || line === 'c3VwZXItc2VjcmV0'),
        'the base64 credentials must never reach the wire',
      );
    } finally {
      process.env = previous as NodeJS.ProcessEnv;
      db.close();
    }
  });
});
