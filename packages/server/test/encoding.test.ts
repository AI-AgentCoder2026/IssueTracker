/**
 * Text-encoding hygiene.
 *
 * Mojibake -- UTF-8 bytes decoded as Windows-1252 and written back out -- is
 * invisible to every other check in this repository. An em dash becomes three
 * characters of garbage, a horizontal ellipsis likewise, and every emoji turns
 * into a `ð` followed by three more. All of it typechecks, bundles, and passes
 * the test suite, and then renders as noise in the UI.
 *
 * This suite fails the build if any of it comes back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverRoot, '..', '..');

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
const TEXT_FILE = /\.(ts|tsx|sql|md|css|json|html|yml|example)$/;

/**
 * Sequences that can only appear when UTF-8 was read as Windows-1252.
 *
 * Written with escapes rather than literals, and this file exempts itself
 * below, so the detector never reports its own source.
 */
const MOJIBAKE = /ð|Ã[\x80-\xbf]|â€|Â[\x80-\xbf]|ï¿½/;

/** This file necessarily contains the patterns it searches for. */
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (full === SELF) continue;
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (TEXT_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every text file the repository actually ships. */
function trackedTextFiles(): string[] {
  const out: string[] = [];
  for (const root of ['packages', 'docs', '.github']) sourceFiles(join(repoRoot, root), out);
  for (const name of ['README.md', 'CONTRIBUTING.md', '.env.example', 'LICENSE']) {
    const full = join(repoRoot, name);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

const files = trackedTextFiles();

describe('source text encoding', () => {
  it('finds the repository to check', () => {
    assert.ok(files.length > 50, `only found ${files.length} text files; the walk drifted`);
  });

  it('contains no mojibake', () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (MOJIBAKE.test(line)) {
            offenders.push(`${relative(repoRoot, file).split('\\').join('/')}:${i + 1}  ${line.trim().slice(0, 80)}`);
          }
        });
    }
    assert.deepEqual(
      offenders,
      [],
      `mojibake found (UTF-8 decoded as Windows-1252):\n  ${offenders.join('\n  ')}`,
    );
  });

  it('contains no Unicode replacement characters', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (readFileSync(file, 'utf8').includes('�')) offenders.push(relative(repoRoot, file));
    }
    assert.deepEqual(offenders, [], `replacement characters in: ${offenders.join(', ')}`);
  });

  it('starts every file with a clean first byte', () => {
    // A leading BOM is the same accident and confuses some tooling, and it
    // hides itself because `trim()` and most editors swallow it silently.
    const offenders: string[] = [];
    for (const file of files) {
      if (readFileSync(file, 'utf8').charCodeAt(0) === 0xfeff) {
        offenders.push(relative(repoRoot, file).split('\\').join('/'));
      }
    }
    assert.deepEqual(offenders, [], `leading byte-order mark in: ${offenders.join(', ')}`);
  });
});
