/**
 * Copy non-TypeScript build inputs into `dist`.
 *
 * `tsc` only emits `.js`, so the SQL migrations are absent from a compiled
 * build even though they are required at runtime. This runs after `tsc` in the
 * `build` script and copies them across.
 *
 * Written against `node:fs` so it needs no build tooling of its own.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate source directories.
 *
 * This script runs from `dist/db/` after a build and from `src/db/` when
 * executed directly, so the migration directory is not at a fixed depth.
 */
const candidates = [
  resolve(here, '..', '..', 'src', 'db', 'migrations'),
  resolve(here, 'migrations'),
  resolve(process.cwd(), 'src', 'db', 'migrations'),
];

const source = candidates.find((candidate) => existsSync(candidate));

if (!source) {
  process.stderr.write(
    'migrations: could not locate src/db/migrations from ' +
      `${here}\nTried:\n${candidates.map((c) => `  ${c}`).join('\n')}\n`,
  );
  process.exit(1);
}

// `dist/db` is two levels up from `src/db`; mirror the source layout.
const destination = resolve(here, 'migrations');

mkdirSync(destination, { recursive: true });

let copied = 0;
for (const entry of readdirSync(source)) {
  if (!entry.endsWith('.sql')) continue;
  cpSync(join(source, entry), join(destination, entry));
  copied += 1;
}

process.stdout.write(`migrations: copied ${copied} file(s) from ${source}\n`);
