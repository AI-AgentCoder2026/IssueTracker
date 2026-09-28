/**
 * Route/contract coverage.
 *
 * `@tracker/shared` declares the HTTP surface as constants and both the routes
 * and the SPA are meant to consume them, so a constant nobody routes is a
 * promise the server does not keep. The failure mode is silent: the client
 * type-checks against a path that answers 404 in production.
 *
 * The known gaps are listed explicitly below rather than tolerated by a
 * blanket exemption, so each one is a decision on the record and any *new*
 * drift fails the build.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = resolve(serverRoot, '..', 'shared');
const routeDir = join(serverRoot, 'src', 'routes');

/**
 * Declared-but-unrouted constants, each with why it is still open.
 *
 * A gap means *no route at this path*. The contract pins a path per constant
 * and no method, so this list cannot speak to methods: a path served by POST
 * counts as served. Where a method is genuinely missing but the path is not,
 * the fact is pinned by a dedicated assertion instead — see the
 * `leaves no method for a declared path to hide behind` case for
 * `GET /api/issues`, which is served for create but not for list.
 */
const KNOWN_GAPS: Record<string, string> = {
  'admin.settings': 'No instance settings route; configuration is environment-driven.',
  'admin.updateSettings': 'No instance settings route; configuration is environment-driven.',
  'bulk.edit':
    'A duplicate alias for API.bulk.apply, which is the routed name for POST /api/issues/bulk. Nothing calls it; kept declared rather than deleted so an external consumer does not break on it.',
};

/** Parse `API` out of the shared source: group -> name -> path. */
function declaredConstants(): Map<string, string> {
  const lines = readFileSync(join(sharedRoot, 'src', 'api.ts'), 'utf8').split('\n');
  const out = new Map<string, string>();
  let group: string | null = null;
  for (const line of lines) {
    const groupMatch = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{\s*$/);
    if (groupMatch) {
      group = groupMatch[1] as string;
      continue;
    }
    const entry = line.match(/^ {4}([A-Za-z0-9_]+):\s*'(\/api\/[^']+)'/);
    if (entry && group) out.set(`${group}.${entry[1]}`, entry[2] as string);
  }
  return out;
}

/** Every path the route modules actually register, via constant or literal. */
function registeredPaths(): { viaConstant: Set<string>; literals: Set<string> } {
  let source = '';
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    source += readFileSync(join(routeDir, file), 'utf8');
  }
  const viaConstant = new Set<string>();
  // Scoped to a registration call. A looser pattern would count a *mention* in
  // a comment as a route, which is how `API.bulk.edit` was "routed" for months:
  // the only place its name appeared was an explanatory comment.
  for (const m of source.matchAll(/app\.(?:get|post|patch|put|delete)\(\s*API\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
    viaConstant.add(`${m[1]}.${m[2]}`);
  }
  const literals = new Set<string>();
  for (const m of source.matchAll(/app\.(?:get|post|patch|put|delete)\(\s*'(\/api\/[^']*)'/g)) {
    // Path-only, deliberately. The contract declares a path per constant and no
    // method, so a method-aware match here would flag every literal-registered
    // endpoint as unrouted. The method is checked where it is actually known --
    // in `client-contract.test.ts`, which reads the method the SPA sends.
    literals.add((m[1] as string).replace(/:[A-Za-z]+/g, ':*'));
  }
  return { viaConstant, literals };
}

describe('API contract coverage', () => {
  const declared = declaredConstants();
  const { viaConstant, literals } = registeredPaths();

  it('finds the shared contract', () => {
    assert.ok(declared.size > 100, `only parsed ${declared.size} constants; the parser drifted`);
  });

  it('leaves no method for a declared path to hide behind', () => {
    // The literal-path fallback above is method-blind, so a `POST` on a path
    // can vouch for a `GET` that does not exist. That is exactly how
    // `GET /api/issues` stayed unrouted while the contract test passed. Rather
    // than guess a method from a constant's name, assert the one case we know
    // is real, so a future route landing on this path has to update it.
    const routeDir = join(serverRoot, 'src', 'routes');
    let source = '';
    for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
      source += readFileSync(join(routeDir, file), 'utf8');
    }
    assert.equal(
      /app\.get\(\s*API\.issues\.list\b/.test(source),
      false,
      'if GET /api/issues is implemented, implement it through API.issues.list and drop the gap',
    );
    assert.match(
      source,
      /app\.post\(\s*API\.issues\.create|app\.post\('\/api\/issues'/,
      'POST /api/issues (create) must stay registered — it is the one method this path does serve',
    );
  });

  it('routes every declared constant that is not a known gap', () => {
    const unrouted: string[] = [];
    for (const [key, path] of declared) {
      if (KNOWN_GAPS[key] !== undefined) continue;
      if (viaConstant.has(key)) continue;
      if (literals.has(path.replace(/:[A-Za-z]+/g, ':*'))) continue;
      unrouted.push(`${key} -> ${path}`);
    }
    assert.deepEqual(unrouted, [], `unrouted contract entries:\n  ${unrouted.join('\n  ')}`);
  });

  it('keeps the gap list honest — no stale exemptions', () => {
    const stale: string[] = [];
    for (const key of Object.keys(KNOWN_GAPS)) {
      const path = declared.get(key);
      if (path === undefined) {
        stale.push(`${key}: no longer declared in @tracker/shared`);
        continue;
      }
      const routed =
        viaConstant.has(key) || literals.has(path.replace(/:[A-Za-z]+/g, ':*'));
      if (routed) stale.push(`${key}: now routed — drop it from KNOWN_GAPS`);
    }
    assert.deepEqual(stale, [], `stale gap entries:\n  ${stale.join('\n  ')}`);
  });

  it('documents every gap it tolerates', () => {
    for (const [key, reason] of Object.entries(KNOWN_GAPS)) {
      assert.ok(reason.length > 20, `${key} needs a real explanation, not "${reason}"`);
    }
  });
});
