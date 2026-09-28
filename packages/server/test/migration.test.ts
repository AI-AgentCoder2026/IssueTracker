/**
 * Migration upgrade path.
 *
 * The shared harness always migrates an empty database, so a migration that is
 * wrong *only for an existing installation* would pass CI and then fail on
 * someone's upgrade. `005_drop_sso.sql` is exactly that shape: it drops tables
 * that a deployed instance already has.
 *
 * The test rebuilds the pre-upgrade state by applying the earlier migrations
 * and recording their real checksums, then lets the migrator run and asserts
 * that only the new migration is applied and that unrelated data survives.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/db/connection.ts';
import { migrate, listMigrations, migrationStatus } from '../src/db/migrate.ts';

const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

/** Matches `migrate.ts`: line endings are normalised before hashing. */
const checksum = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/** A database holding every migration except the last, as an install would. */
function databaseMissingLastMigration(): Database {
  const db = new Database({ file: ':memory:', wal: false });
  const onDisk = listMigrations();
  assert.ok(onDisk.length >= 2, 'expected at least two migrations on disk');

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    duration_ms INTEGER NOT NULL DEFAULT 0
  ) STRICT`);

  for (const migration of onDisk.slice(0, -1)) {
    db.exec(migration.sql);
    db.run('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
      migration.name,
      checksum(migration.sql),
    ]);
  }
  return db;
}

describe('migration upgrade path', () => {
  let db: Database;

  before(() => {
    db = databaseMissingLastMigration();
  });

  after(() => {
    db.close();
  });

  it('rebuilds the previous schema exactly', () => {
    const status = migrationStatus(db);
    assert.equal(status.pending.length, 1, 'exactly one migration should be pending');
    assert.equal(status.outOfOrder.length, 0, 'migrations must not be applied out of order');
  });

  it('applies only the newest migration on upgrade', () => {
    const result = migrate(db);
    assert.equal(result.applied.length, 1, `expected one applied migration, got ${JSON.stringify(result.applied)}`);
    assert.equal(result.alreadyApplied > 0, true, 'earlier migrations should be recorded as already applied');
  });

  it('leaves the schema fully migrated afterwards', () => {
    const status = migrationStatus(db);
    assert.deepEqual(status.pending, [], 'no migration may remain pending');
  });

  it('is idempotent — running the migrator again applies nothing', () => {
    const result = migrate(db);
    assert.deepEqual(result.applied, [], 'a second run must be a no-op');
  });
});

describe('dropping tables created by an earlier migration', () => {
  let db: Database;

  before(() => {
    db = databaseMissingLastMigration();

    // Real data that must survive the upgrade.
    db.run(
      `INSERT INTO users (username, email, display_name, password_hash, provider)
       VALUES ('upgrade-user', 'upgrade@example.com', 'Upgrade User', 'hash', 'local')`,
    );
  });

  after(() => {
    db.close();
  });

  it('removes the retired tables', () => {
    const tableExists = (name: string): boolean =>
      (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`, [
        name,
      ])?.n ?? 0) > 0;

    // The tables existed before the upgrade; 005 is what removes them.
    assert.equal(
      db
        .get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sso_configurations','external_identities')`,
        )?.n,
      2,
      'precondition: both tables are present before the upgrade',
    );

    migrate(db);

    assert.equal(tableExists('sso_configurations'), false, 'sso_configurations should be gone');
    assert.equal(tableExists('external_identities'), false, 'external_identities should be gone');
  });

  it('does not cascade into unrelated tables', () => {
    migrate(db);
    const users = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n;
    assert.equal(users, 1, 'user rows must survive the drop');
  });
});

describe('migrations on disk are recorded honestly', () => {
  it('every migration file is readable and non-empty', () => {
    const onDisk = listMigrations();
    assert.ok(onDisk.length > 0, 'no migrations found');
    for (const migration of onDisk) {
      const sql = readFileSync(join(migrationDir, migration.name), 'utf8');
      assert.ok(sql.trim().length > 0, `${migration.name} is empty`);
      assert.equal(migration.checksum, checksum(sql), `${migration.name} checksum drifted`);
    }
  });
});
