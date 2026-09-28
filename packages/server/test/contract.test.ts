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

/** Declared-but-unrouted constants, each with why it is still open. */
const KNOWN_GAPS: Record<string, string> = {
  'projects.roles':
    'No list-the-roles endpoint. The role catalogue is implicit; the SPA has no role editor.',
  'workflow.statuses': 'Per-status CRUD is not routed; the whole workflow is PUT as one document.',
  'workflow.createStatus': 'See workflow.statuses.',
  'workflow.updateStatus': 'See workflow.statuses.',
  'workflow.removeStatus': 'See workflow.statuses.',
  'workflow.transitions': 'Per-transition CRUD is not routed; the whole workflow is PUT as one document.',
  'workflow.createTransition': 'See workflow.transitions.',
  'workflow.removeTransition': 'See workflow.transitions.',
  'dashboards.widgets': 'Widgets are returned embedded in the dashboard; there is no separate list route.',
  'admin.users': 'No instance-wide user list for administrators. /api/users requires a project context.',
  'admin.updateSso': 'SSO configurations can be listed but not edited.',
  'admin.removeSso': 'SSO configurations can be listed but not deleted.',
  'admin.settings': 'No instance settings route; configuration is environment-driven.',
  'admin.updateSettings': 'No instance settings route; configuration is environment-driven.',
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
  for (const m of source.matchAll(/API\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
    viaConstant.add(`${m[1]}.${m[2]}`);
  }
  const literals = new Set<string>();
  for (const m of source.matchAll(/app\.(?:get|post|patch|put|delete)\('(\/api\/[^']+)'/g)) {
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
