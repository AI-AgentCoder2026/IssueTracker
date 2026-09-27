/**
 * Shared test harness.
 *
 * Every test gets its own in-memory SQLite database and service registry, so
 * suites are fully isolated and can run concurrently.
 */

import { Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { createServices } from '../src/services/registry.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { nowIso } from '../src/lib/time.ts';
import type { Services } from '../src/services/context.ts';

export interface TestHarness {
  db: Database;
  services: Services;
  config: Config;
  close(): void;
}

let harnessCount = 0;

/** Build an isolated database + service registry for one test. */
export function createHarness(options: { config?: Partial<Config> } = {}): TestHarness {
  harnessCount += 1;

  const config = loadConfig({
    env: 'test',
    // A unique throwaway directory per harness keeps the generated secrets
    // from leaking between suites.
    dataDir: `${process.env['TEMP'] ?? '/tmp'}/tracker-test-${process.pid}-${harnessCount}`,
    databaseFile: ':memory:',
    enableScheduler: false,
    logLevel: 'silent',
    ...options.config,
  });

  const db = new Database({ file: ':memory:', wal: false });
  migrate(db);

  const services = createServices({ config, db });

  return {
    db,
    services,
    config,
    close() {
      db.close();
    },
  };
}

export interface SeedUserOptions {
  username: string;
  role?: 'owner' | 'admin' | 'maintainer' | 'developer' | 'reporter' | 'viewer';
  instanceRole?: 'user' | 'staff' | 'admin';
  password?: string;
}

/** Insert a user directly, bypassing the auth service. */
export function insertUser(harness: TestHarness, options: SeedUserOptions): number {
  const id = Number(
    harness.db.run(
      `INSERT INTO users (username, email, display_name, password_hash, provider, instance_role, created_at, updated_at)
       VALUES (?,?,?,?,'local',?,?,?)`,
      [
        options.username,
        `${options.username}@example.com`,
        options.username.toUpperCase(),
        hashPassword(options.password ?? 'TestPassword123!'),
        options.instanceRole ?? 'user',
        nowIso(),
        nowIso(),
      ],
    ).lastInsertRowid,
  );

  if (options.role) {
    const project = harness.db.get<{ id: number }>('SELECT id FROM projects ORDER BY id LIMIT 1');
    if (project) {
      harness.db.run('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,?)', [
        project.id,
        id,
        options.role,
      ]);
    }
  }

  return id;
}

/** Create a project owned by `ownerId`. */
export function createProject(harness: TestHarness, ownerId: number, key = 'TEST'): number {
  return harness.services.projects.create(
    {
      key,
      name: `Test ${key}`,
      description: '',
      visibility: 'private',
      defaultIssueType: 'task',
      defaultPriority: 'medium',
      archivePolicy: null,
    },
    ownerId,
    { ipAddress: 'test', userAgent: 'test' },
  ).id as unknown as number;
}

/** Map a status key to its id for a project. */
export function statusId(harness: TestHarness, projectId: number, key: string): number {
  const status = harness.services.workflow
    .statusesForProject(projectId)
    .find((candidate) => candidate.key === key);
  if (!status) throw new Error(`No status "${key}" in project ${projectId}`);
  return Number(status.id);
}
