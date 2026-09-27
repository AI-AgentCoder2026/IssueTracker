/**
 * Migration CLI: `node src/db/cli.ts up | status | reset`.
 *
 * `reset` deletes the database file, so it refuses to run in production and
 * requires an explicit `--force` flag.
 */

import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { Database } from './connection.ts';
import { migrate, migrationStatus } from './migrate.ts';

const command = process.argv[2] ?? 'up';
const force = process.argv.includes('--force');

const config = loadConfig();

function open(): Database {
  return new Database({ file: config.databaseFile, wal: config.env !== 'test' });
}

switch (command) {
  case 'up': {
    const db = open();
    const result = migrate(db, { log: (message) => process.stdout.write(`  ${message}\n`) });
    process.stdout.write(
      `Applied ${result.applied.length} migration(s); ${result.alreadyApplied} already present.\n`,
    );
    db.close();
    break;
  }

  case 'status': {
    const db = open();
    const status = migrationStatus(db);
    process.stdout.write(`Database: ${config.databaseFile}\n`);
    process.stdout.write(`Applied: ${status.applied.length}\n`);
    for (const record of status.applied) {
      process.stdout.write(`  ✓ ${record.name} (${record.durationMs}ms, ${record.appliedAt})\n`);
    }
    if (status.pending.length > 0) {
      process.stdout.write(`Pending: ${status.pending.length}\n`);
      for (const name of status.pending) process.stdout.write(`  • ${name}\n`);
    }
    if (status.outOfOrder.length > 0) {
      process.stdout.write(
        `WARNING: ${status.outOfOrder.length} migration(s) appear before already-applied ones.\n`,
      );
    }
    db.close();
    break;
  }

  case 'reset': {
    if (config.env === 'production' && !force) {
      process.stderr.write('Refusing to reset the database in production. Pass --force to override.\n');
      process.exit(1);
    }
    if (!force) {
      process.stderr.write(
        `This will delete ${config.databaseFile}. Re-run with --force to confirm.\n`,
      );
      process.exit(1);
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${config.databaseFile}${suffix}`;
      if (existsSync(path)) {
        rmSync(path, { force: true });
        process.stdout.write(`  removed ${path}\n`);
      }
    }
    const db = open();
    migrate(db, { log: (message) => process.stdout.write(`  ${message}\n`) });
    process.stdout.write('Database reset and migrated.\n');
    db.close();
    break;
  }

  default:
    process.stderr.write(`Unknown command "${command}". Use: up | status | reset\n`);
    process.exit(1);
}
