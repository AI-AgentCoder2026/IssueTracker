/**
 * Client/server contract agreement.
 *
 * `contract.test.ts` checks that every declared path is routed. It says
 * nothing about *who calls it*, so two failures slip through it:
 *
 *   - the SPA calls a path the server does not serve, which 404s at runtime;
 *   - the SPA calls a path with a method the server does not register, which
 *     405s. Both look like a broken screen rather than a broken build, and
 *     neither is caught by a typecheck, because the shared constant is typed.
 *
 * This walks the client for `http.<method>(... API.<group>.<name> ...)` and
 * the route modules for `app.<method>(...)`, then requires every client call
 * to have a matching registration. Routes written as string literals are
 * matched on the path with `:param` normalised, so a client call to a literal
 * route is covered too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = resolve(serverRoot, '..', 'shared');
const webRoot = resolve(serverRoot, '..', 'web', 'src');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];

/** `group.name -> path`, parsed from the shared source. */
function declaredPaths(): Map<string, string> {
  const lines = readFileSync(join(sharedRoot, 'src', 'api.ts'), 'utf8').split('\n');
  const out = new Map<string, string>();
  let group: string | null = null;
  for (const line of lines) {
    const g = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{\s*$/);
    if (g) {
      group = g[1] as string;
      continue;
    }
    const e = line.match(/^ {4}([A-Za-z0-9_]+):\s*'(\/api\/[^']+)'/);
    if (e && group) out.set(`${group}.${e[1]}`, e[2] as string);
  }
  return out;
}

/** Every call the client makes, as `group.name:method`. */
function clientCalls(): Set<string> {
  const calls = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        const text = readFileSync(full, 'utf8');
        // `http.get<unknown>(API.x.y` and `http.post<unknown>(fill(API.x.y, {`
        for (const m of text.matchAll(/\bhttp\.(get|post|put|patch|delete)\b[^()]*\(\s*(?:fill\(\s*)?API\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
          calls.add(`${m[2]}.${m[3]}:${m[1]}`);
        }
      }
    }
  };
  walk(webRoot);
  return calls;
}

/** Every `group.name:method` the server registers. */
function registeredCalls(): Set<string> {
  const out = new Set<string>();
  const routeDir = join(serverRoot, 'src', 'routes');
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(routeDir, file), 'utf8');
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*API\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
      out.add(`${m[2]}.${m[3]}:${m[1]}`);
    }
  }
  return out;
}

/** Literal `app.<method>('/api/...')` registrations, path-normalised. */
function literalRoutes(): Set<string> {
  const out = new Set<string>();
  const routeDir = join(serverRoot, 'src', 'routes');
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(routeDir, file), 'utf8');
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)) {
      out.add(`${(m[2] as string).replace(/:[A-Za-z]+/g, ':*')}:${m[1]}`);
    }
  }
  return out;
}

describe('client and server agree on the HTTP surface', () => {
  const declared = declaredPaths();
  const client = clientCalls();
  const registered = registeredCalls();
  const literals = literalRoutes();

  it('finds both sides of the contract', () => {
    assert.ok(declared.size > 100, `only parsed ${declared.size} declared paths`);
    assert.ok(client.size > 40, `only found ${client.size} client calls; the walk drifted`);
    assert.ok(registered.size + literals.size > 40, 'too few routes found; the walk drifted');
  });

  it('serves every endpoint the client calls', () => {
    const missing: string[] = [];
    for (const call of client) {
      const [key, method] = call.split(':') as [string, Method];
      const path = declared.get(key);
      if (path === undefined) {
        missing.push(`${key} (${method}) is called by the SPA but is not declared in @tracker/shared`);
        continue;
      }
      if (registered.has(call)) continue;
      if (literals.has(`${path.replace(/:[A-Za-z]+/g, ':*')}:${method}`)) continue;
      missing.push(`${key} (${method} ${path}) has no matching route`);
    }
    assert.deepEqual(missing, [], `client calls the server does not serve:\n  ${missing.join('\n  ')}`);
  });

  it('uses only declared constants in the client', () => {
    const unknown = [...client]
      .map((c) => c.split(':')[0] as string)
      .filter((key) => !declared.has(key));
    assert.deepEqual([...new Set(unknown)], [], 'the SPA references undeclared API constants');
  });
});
