/**
 * Migration runner.
 *
 * Migrations are plain `.sql` files applied in filename order and recorded in
 * `schema_migrations` with a checksum. A file whose contents changed after it
 * was applied is a hard error: silently re-running a mutated migration would
 * corrupt the schema, so the runner refuses to start instead.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './connection.ts';
import { internalError } from '../errors.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: string;
  durationMs: number;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  alreadyApplied: number;
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      duration_ms INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
}

function checksum(sql: string): string {
  // Normalise line endings so a checkout with different EOL settings does not
  // report a spurious checksum mismatch.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function listMigrations(): Array<{ name: string; sql: string; checksum: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  return files.map((name) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    return { name, sql, checksum: checksum(sql) };
  });
}

export function appliedMigrations(db: Database): Map<string, MigrationRecord> {
  ensureMigrationsTable(db);
  const rows = db.all<{
    name: string;
    checksum: string;
    applied_at: string;
    duration_ms: number;
  }>('SELECT name, checksum, applied_at, duration_ms FROM schema_migrations');

  return new Map(
    rows.map((row) => [
      row.name,
      {
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        durationMs: row.duration_ms,
      },
    ]),
  );
}

/**
 * Apply every migration that has not run yet.
 *
 * `exec()` is used rather than individual statements because migration files
 * contain triggers and multi-statement blocks that the prepared-statement API
 * cannot express. A file that fails halfway is rolled back by the surrounding
 * transaction where SQLite supports it; `CREATE VIRTUAL TABLE` participates in
 * the same transaction, so a failure leaves no partial schema behind.
 */
export function migrate(db: Database, options: { log?: (message: string) => void } = {}): MigrationResult {
  const log = options.log ?? (() => {});
  const applied = appliedMigrations(db);
  const result: MigrationResult = { applied: [], skipped: [], alreadyApplied: applied.size };

  for (const migration of listMigrations()) {
    const record = applied.get(migration.name);
    if (record) {
      if (record.checksum !== migration.checksum) {
        throw internalError(
          `Migration ${migration.name} was modified after it was applied ` +
            `(recorded ${record.checksum.slice(0, 12)}, found ${migration.checksum.slice(0, 12)}). ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      result.skipped.push(migration.name);
      continue;
    }

    const startedAt = Date.now();
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES (?, ?, ?)', [
        migration.name,
        migration.checksum,
        Date.now() - startedAt,
      ]);
    });

    const durationMs = Date.now() - startedAt;
    log(`applied ${migration.name} (${durationMs}ms)`);
    result.applied.push(migration.name);
  }

  return result;
}

/** Verify that every migration on disk is recorded, without writing anything. */
export function migrationStatus(db: Database): {
  applied: MigrationRecord[];
  pending: string[];
  outOfOrder: string[];
} {
  const onDisk = listMigrations();
  const applied = appliedMigrations(db);
  const pending: string[] = [];
  const outOfOrder: string[] = [];
  const appliedList: MigrationRecord[] = [];

  let highestAppliedIndex = -1;
  onDisk.forEach((migration, index) => {
    if (applied.has(migration.name)) {
      const record = applied.get(migration.name) as MigrationRecord;
      appliedList.push(record);
      if (index > highestAppliedIndex) highestAppliedIndex = index;
    } else {
      pending.push(migration.name);
    }
  });

  // A migration that appears on disk *before* the newest applied one would mean
  // the history was rewritten, which is worth flagging.
  onDisk.forEach((migration, index) => {
    if (index < highestAppliedIndex && !applied.has(migration.name)) {
      outOfOrder.push(migration.name);
    }
  });

  return { applied: appliedList, pending, outOfOrder };
}
