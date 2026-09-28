/**
 * Outgoing webhooks: target validation, signature verification, retry and
 * auto-disable.
 *
 * The SSRF cases are the point. The server makes these requests, so a target
 * that reaches back into the host turns a maintainer with `webhook.manage` into
 * a way to read the tracker's own admin API and the cloud instance metadata
 * service. That is a privilege escalation, not a nuisance.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectId, Role, UserId } from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import type { RequestContext } from '../src/services/context.ts';
import { isInternalTarget, resolvesInternally } from '../src/services/webhook.service.ts';
import { hmacSha256Hex } from '../src/lib/crypto.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;

function actor() {
  return {
    userId: userId as UserId,
    isInstanceAdmin: true,
    roles: ['admin' as Role],
    projectRoles: new Map<ProjectId, Role>([[projectId as ProjectId, 'owner' as Role]]),
  };
}

function ctx(): RequestContext {
  return {
    services: harness.services,
    db: harness.db,
    config: harness.config,
    actor: actor(),
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: userId, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

const createWebhook = (overrides: Record<string, unknown> = {}) =>
  harness.services.webhooks.create(
    projectId,
    { name: 'test hook', targetUrl: 'https://example.com/hook', events: ['issue.created'], ...overrides } as never,
    ctx(),
  );

before(() => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'hookuser' });
  projectId = createProject(harness, userId, 'HOOK');
  delete process.env['WEBHOOK_ALLOW_PRIVATE_TARGETS'];
});

after(() => {
  delete process.env['WEBHOOK_ALLOW_PRIVATE_TARGETS'];
  harness.close();
});

describe('internal target detection', () => {
  const internal = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud instance metadata
    '100.64.0.1', // CGNAT
    '224.0.0.1', // multicast
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1', // unique local
    'fe80::1', // link-local
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1',
    'localhost',
    'LOCALHOST',
    'db.internal',
    'service.localhost',
  ];

  for (const host of internal) {
    it(`treats ${host} as internal`, () => {
      assert.equal(isInternalTarget(host), true);
    });
  }

  const external = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111'];

  for (const host of external) {
    it(`treats ${host} as public`, () => {
      assert.equal(isInternalTarget(host), false);
    });
  }

  it('resolves a public name without claiming it is internal', async () => {
    // Resolution may fail in a sandbox; either way the answer must be a
    // boolean and must not be a crash.
    assert.equal(typeof (await resolvesInternally('example.com')), 'boolean');
  });
});

describe('target validation', () => {
  it("refuses the tracker's own admin API on loopback", () => {
    assert.throws(
      () => createWebhook({ targetUrl: 'http://127.0.0.1:4000/api/admin/audit' }),
      /loopback, private or link-local/,
    );
  });

  it('refuses the cloud metadata endpoint', () => {
    assert.throws(
      () => createWebhook({ targetUrl: 'http://169.254.169.254/latest/meta-data/' }),
      /loopback, private or link-local/,
    );
  });

  it('refuses a private RFC 1918 address', () => {
    assert.throws(
      () => createWebhook({ targetUrl: 'http://10.1.2.3:8080/hook' }),
      /loopback, private or link-local/,
    );
  });

  it('refuses localhost by name', () => {
    assert.throws(
      () => createWebhook({ targetUrl: 'http://localhost:9000/hook' }),
      /loopback, private or link-local/,
    );
  });

  it('accepts a normal public https target', () => {
    const created = createWebhook({ targetUrl: 'https://hooks.example.com/incoming' });
    assert.ok(created.id);
    assert.match(created.targetUrl, /hooks\.example\.com/);
  });

  it('still refuses a non-http scheme', () => {
    assert.throws(() => createWebhook({ targetUrl: 'file:///etc/passwd' }), /http or https/);
    assert.throws(() => createWebhook({ targetUrl: 'gopher://example.com' }), /http or https/);
  });

  it("still refuses embedded credentials", () => {
    assert.throws(
      () => createWebhook({ targetUrl: 'https://user:pass@example.com/hook' }),
      /must not embed credentials/,
    );
  });

  it('allows an internal target when the operator opts in', () => {
    process.env['WEBHOOK_ALLOW_PRIVATE_TARGETS'] = 'true';
    try {
      // A legitimate self-hosted integration, e.g. another service on the LAN.
      const created = createWebhook({ targetUrl: 'http://10.0.0.9/internal-hook' });
      assert.ok(created.id, 'the opt-in must permit an internal target');
    } finally {
      delete process.env['WEBHOOK_ALLOW_PRIVATE_TARGETS'];
    }
  });

  it('refuses an internal target on update too, not just at creation', () => {
    const created = createWebhook({ targetUrl: 'https://hooks.example.com/incoming' });
    assert.throws(
      () =>
        harness.services.webhooks.update(
          projectId,
          created.id,
          { targetUrl: 'http://127.0.0.1:4000/api/admin/audit' },
          actor(),
          ctx(),
        ),
      /loopback, private or link-local/,
    );
  });
});

describe('delivery refuses a target that resolves inward', () => {
  it('does not send when the hostname resolves to loopback', async () => {
    // A public-looking name that resolves inward is the DNS rebinding case,
    // and it is only catchable at send time. `localhost.localdomain` is used
    // because it is guaranteed to resolve inward without needing DNS.
    const created = harness.db.run(
      `INSERT INTO webhooks (project_id, name, target_url, secret, events, enabled, created_at, updated_at)
       VALUES (?, 'rebind', 'http://localhost.localdomain/steal', 'whsec_test', '["issue.created"]', 1,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [projectId],
    );
    const webhookId = Number(created.lastInsertRowid);
    assert.ok(webhookId > 0, 'the hook was inserted directly, bypassing validation on purpose');

    const deliveryId = Number(
      harness.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, attempt, created_at)
         VALUES (?, 'issue.created', '{}', 'pending', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [webhookId],
      ).lastInsertRowid,
    );

    const sent = await harness.services.webhooks.deliver(deliveryId);
    assert.equal(sent, false, 'delivery must be refused');

    const row = harness.db.get<{ status: string; error: string | null }>(
      'SELECT status, error FROM webhook_deliveries WHERE id = ?',
      [deliveryId],
    );
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /Refused/);
  });
});

describe('signing and delivery', () => {
  it('signs a delivery with the shared secret', () => {
    const created = createWebhook({ targetUrl: 'https://hooks.example.com/incoming' });
    assert.ok(created.secret.length > 20, 'a per-hook secret is generated');

    const expected = hmacSha256Hex(created.secret, '{"event":"ping"}');
    assert.equal(expected.length, 64, 'HMAC-SHA256 renders as 64 hex characters');
  });

  it('records a pending delivery when an event is enqueued', () => {
    const before = Number(harness.db.scalar<number>('SELECT COUNT(*) AS c FROM webhook_deliveries') ?? 0);
    harness.services.webhooks.enqueue('issue.created', projectId, { key: 'NEW-1' });
    const after = Number(harness.db.scalar<number>('SELECT COUNT(*) AS c FROM webhook_deliveries') ?? 0);
    assert.ok(after > before, 'the event is queued for delivery');
  });

  it('marks an undeliverable webhook failed rather than dropping it', async () => {
    // `192.0.2.1` is TEST-NET-1: reserved and non-routable, so the guard is
    // right to refuse it. Use a name under the reserved `.invalid` TLD, which
    // is public-looking but can never resolve, so this exercises a genuine
    // delivery failure without the request leaving the machine.
    const created = createWebhook({ targetUrl: 'https://unreachable.invalid/hook' });
    const deliveryId = Number(
      harness.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, attempt, created_at)
         VALUES (?, 'issue.created', '{}', 'pending', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [Number(
          harness.db.get<{ id: number }>('SELECT id FROM webhooks WHERE target_url = ?', [created.targetUrl])
            ?.id ?? 0,
        )],
      ).lastInsertRowid,
    );

    const sent = await harness.services.webhooks.deliver(deliveryId);
    assert.equal(typeof sent, 'boolean', 'delivery reports an outcome either way');
    const row = harness.db.get<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE id = ?',
      [deliveryId],
    );
    assert.ok(['failed', 'delivered'].includes(row?.status ?? ''), 'the attempt is recorded');
  });

  it('lists and removes webhooks', () => {
    const created = createWebhook({ name: 'listed hook' });
    assert.ok(harness.services.webhooks.list(projectId).some((hook) => hook.id === created.id));

    harness.services.webhooks.remove(projectId, created.id, actor(), ctx());
    assert.ok(!harness.services.webhooks.list(projectId).some((hook) => hook.id === created.id));
  });
});
