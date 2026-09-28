// @ts-check
/**
 * One-command demo bring-up.
 *
 * Clones land with nothing built, and a first run needs three things in order:
 * the shared contract compiled (the other two workspaces import it from dist),
 * the database migrated and seeded, and the server started. Getting that order
 * wrong produces either `Cannot find module '@tracker/shared'` or a login page
 * with no projects, so it is scripted here rather than left to the reader.
 *
 * Safe to run repeatedly: seeding is skipped once a database exists, because
 * the seed is demo data and stacking a second copy of it would be noise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env['DATA_DIR'] ?? './data';
const databaseFile = process.env['DATABASE_FILE'] ?? resolve(root, dataDir, 'tracker.db');

/**
 * Run a command, echoing it first so a failing step is obvious in a log.
 *
 * Windows resolves `npm` as `npm.cmd`, and current Node refuses to spawn a
 * `.cmd` directly (`EINVAL`), so a shell is used there. Every argument below is
 * a fixed identifier with no spaces or user input, so nothing is interpolated
 * into a command line.
 */
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const isFreshInstall = !existsSync(resolve(root, 'node_modules', '@tracker'));
if (isFreshInstall) run('npm', ['ci']);

console.log('\nBuilding the shared contract, the server and the client...');
run('npm', ['run', 'build']);

// Migrations run automatically when the server boots; seeding does not.
if (existsSync(databaseFile)) {
  console.log(`\nDatabase already present at ${databaseFile} — skipping seed.`);
} else {
  console.log('\nNo database yet. Seeding demo data...');
  run('npm', ['run', 'seed']);
}

if (process.argv.includes('--no-start')) {
  console.log('\nBuild and seed complete. Start the server with: npm start');
  process.exit(0);
}

const publicUrl = process.env['PUBLIC_URL'] ?? `http://localhost:4000`;
console.log(`
Starting the tracker on port 4000.

  Local     http://localhost:4000
  Public    ${publicUrl}

If you are running this in a GitHub Codespace and made the port public, the
session cookie is only marked Secure when PUBLIC_URL is an https:// URL, so an
http:// preview link works without any extra configuration.

First registered account becomes the instance administrator. To choose it in
advance, set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before starting.

Press Ctrl+C to stop.
`);

run('npm', ['start']);
