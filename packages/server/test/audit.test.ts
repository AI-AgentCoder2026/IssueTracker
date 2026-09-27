/**
 * The immutable audit trail: hash-chain integrity and database-level
 * immutability.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import { canonicalJson } from '@tracker/shared';

let harness: TestHarness;
let projectId: number;
let userId: number;

before(() => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'auditor' });
  projectId = createProject(harness, userId, 'AUDIT');
});

after(() => harness.close());

describe('audit trail', () => {
  it('starts with a genesis entry whose prev_hash is null', () => {
    const verification = harness.services.audit.verifyChain();
    assert.equal(verification.valid, true, verification.message);
    assert.ok(verification.entriesChecked > 0);

    const first = harness.db.get<{ prev_hash: string | null }>(
      'SELECT prev_hash FROM audit_log ORDER BY id ASC LIMIT 1',
    );
    assert.equal(first?.prev_hash, null);
  });

  it('links every entry to its predecessor', () => {
    const rows = harness.db.all<{ id: number; prev_hash: string | null; row_hash: string }>(
      'SELECT id, prev_hash, row_hash FROM audit_log ORDER BY id ASC',
    );
    for (let i = 1; i < rows.length; i += 1) {
      assert.equal(
        rows[i]?.prev_hash,
        rows[i - 1]?.row_hash,
        `entry ${rows[i]?.id} must chain to entry ${rows[i - 1]?.id}`,
      );
    }
  });

  it('verifies a chain that was built by recording entries', () => {
    const before = harness.services.audit.verifyChain();
    assert.equal(before.valid, true, before.message);

    harness.services.audit.record({
      action: 'settings.changed',
      entityType: 'test',
      entityId: 'chain-1',
      actorId: userId,
      after: { value: 1 },
    });
    harness.services.audit.record({
      action: 'settings.changed',
      entityType: 'test',
      entityId: 'chain-2',
      actorId: userId,
      after: { value: 2 },
    });

    const after = harness.services.audit.verifyChain();
    assert.equal(after.valid, true, after.message);
    assert.equal(after.entriesChecked, before.entriesChecked + 2);
  });

  it('refuses to update an audit row at the database level', () => {
    const row = harness.db.get<{ id: number }>('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1');
    assert.ok(row);

    assert.throws(
      () => harness.db.run('UPDATE audit_log SET action = ? WHERE id = ?', ['tampered', row.id]),
      /append-only/,
      'the schema must reject an UPDATE',
    );
  });

  it('refuses to delete an audit row at the database level', () => {
    const row = harness.db.get<{ id: number }>('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1');
    assert.ok(row);

    assert.throws(
      () => harness.db.run('DELETE FROM audit_log WHERE id = ?', [row.id]),
      /append-only/,
      'the schema must reject a DELETE',
    );
  });

  it('detects a tampered row when the trigger is bypassed', () => {
    // The triggers make this impossible through the normal API, so the test
    // drops a trigger to simulate an out-of-band attacker, proves the chain
    // verification catches it, then restores the trigger.
    harness.db.exec('DROP TRIGGER audit_log_no_update');
    const row = harness.db.get<{ id: number; row_hash: string }>(
      'SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1',
    );
    assert.ok(row);

    try {
      harness.db.run('UPDATE audit_log SET after_json = ? WHERE id = ?', [
        JSON.stringify({ tampered: true }),
        row.id,
      ]);

      const verification = harness.services.audit.verifyChain();
      assert.equal(verification.valid, false, 'tampering must be detected');
      assert.equal(verification.brokenAtId, row.id);
      assert.match(verification.message, /Hash mismatch/);
    } finally {
      // Restore immutability regardless of the assertions above.
      harness.db.exec(`
        CREATE TRIGGER audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only: updates are not permitted');
        END;
      `);
    }

    // The tampered row is now unfixable in place; the chain must stay broken
    // so the tampering remains visible rather than being papered over.
    const after = harness.services.audit.verifyChain();
    assert.equal(after.valid, false);
  });

  it('hashes independently of key insertion order', () => {
    const a = canonicalJson({ alpha: 1, beta: 2, gamma: 3 });
    const b = canonicalJson({ gamma: 3, beta: 2, alpha: 1 });
    assert.equal(a, b, 'canonical JSON must be order-independent');
    assert.notEqual(canonicalJson({ alpha: 1 }), canonicalJson({ alpha: 2 }));
  });

  it('records before and after snapshots for updates', async () => {
    const issue = (
      await harness.services.issues.create(
        projectId,
        { title: 'Audit subject', description: '', type: 'task', priority: 'medium' },
        userId,
        {},
      )
    ).issue;

    harness.services.issues.update(issue.id, { title: 'Renamed subject' }, userId, {});

    const entry = harness.db.get<{ before_json: string | null; after_json: string | null }>(
      "SELECT before_json, after_json FROM audit_log WHERE action = 'issue.updated' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(entry?.before_json, 'an update must record the prior state');
    assert.ok(entry?.after_json, 'an update must record the new state');

    const before = JSON.parse(entry.before_json) as { title: string };
    const after = JSON.parse(entry.after_json) as { title: string };
    assert.equal(before.title, 'Audit subject');
    assert.equal(after.title, 'Renamed subject');
  });
});
