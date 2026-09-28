/**
 * Requirement reachability.
 *
 * The requirements matrix claims features are delivered. Three separate kinds of
 * "exists" had been passing for "works", and each one hid a real failure:
 *
 *   1. The service was written and unit-tested, but no route connected it. That
 *      is how attachment upload served a 404 while `AttachmentService.upload`
 *      sat fully tested beside it.
 *   2. The route existed, but the SPA called it with the wrong method or the
 *      wrong constant -- a 404 or 405 that reads as a broken screen.
 *   3. Everything was wired, but a guard meant to prevent (1) was satisfied by
 *      the mere mention of a constant in a comment.
 *
 * This file checks the first kind for the features the matrix names, so a
 * requirement cannot be marked delivered on the strength of a service existing.
 *
 * Each entry is a constant the SPA must be able to reach. `client-contract`
 * then proves the SPA's call has a matching route, and this file proves the
 * feature is not API-only with no UI at all. A feature that is deliberately
 * API-only belongs in `NOT_YET_IN_UI` with its reason, so the exemption is a
 * decision on the record rather than an omission.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = resolve(serverRoot, '..', 'shared');
const webRoot = resolve(serverRoot, '..', 'web', 'src');

/**
 * Features the requirements matrix names, and the constant the SPA must call
 * to reach them. A missing entry here is a coverage gap in this file, not in
 * the product.
 */
const MUST_REACH_FROM_UI: Record<string, string> = {
  // Issue lifecycle
  'issues.create': 'create a ticket',
  'issues.update': 'edit a ticket',
  'issues.transition': 'move a ticket through the workflow',
  'issues.children': 'parent-child nesting',
  'issues.link': 'dependencies',
  'bulk.apply': 'bulk issue editing',
  'archive.candidates': 'stale-issue archiving, candidate list',
  'archive.run': 'stale-issue archiving, run',
  'dedupe.scan': 'duplicate detection, run a scan',
  'dedupe.candidates': 'duplicate detection, review candidates',
  // Collaboration
  'issues.createComment': 'rich-text comment log',
  'issues.upload': 'multiformat file attachments',
  'notifications.list': 'in-app notifications',
  'board.get': 'interactive Kanban board',
  // Analytics
  'issues.search': 'full-text search',
  'export.run': 'data export',
  'versionControl.repositories': 'version-control linkage',
  'dashboards.render': 'custom dashboard widgets',
  'sla.forIssue': 'SLA countdown on an issue',
  'webhooks.list': 'live webhook configuration',
  // Access and security
  'users.create': 'user administration',
  'users.createGuestToken': 'time-bound guest tokens',
  'webauthn.registerBegin': 'passkey enrolment',
  // GitLab
  'gitlab.connections': 'read a GitLab connection',
  'gitlab.sync': 'trigger a GitLab sync',
};

/**
 * Requirements that are implemented and routed but have no interface yet.
 *
 * Each one names what a user cannot do. The list is deliberately not empty and
 * deliberately not hidden: the README carries the same rows marked ⚠️, and
 * moving an entry between the two files is an explicit edit that shows up in
 * review. Closing a gap means deleting its line here *and* changing the README
 * in the same commit, which is the point.
 */
/**
 * Requirements that are implemented and routed but have no interface yet.
 *
 * Empty, and that is the point: every requirement the matrix names is now
 * reachable from the SPA. Adding a line here is a deliberate statement that a
 * feature ships without a screen, and the README's matrix carries the same ⚠️.
 * Closing a gap means deleting the line *and* updating the README in the same
 * commit, which is what makes the two impossible to drift apart silently.
 */
const NOT_YET_IN_UI: Record<string, string> = {};

function spaReferences(): Set<string> {
  const refs = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/\bAPI\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
          refs.add(`${m[1]}.${m[2]}`);
        }
      }
    }
  };
  walk(webRoot);
  return refs;
}

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

describe('requirements are reachable from the interface', () => {
  const referenced = spaReferences();
  const declared = declaredPaths();

  it('names a real constant for every requirement', () => {
    const unknown = Object.keys(MUST_REACH_FROM_UI).filter((key) => !declared.has(key));
    assert.deepEqual(unknown, [], 'these requirement anchors name no declared constant');
  });

  it('anchors every deferred requirement to a constant that exists', () => {
    const unknown = Object.keys(NOT_YET_IN_UI).filter((key) => !declared.has(key));
    assert.deepEqual(unknown, [], 'NOT_YET_IN_UI names undeclared constants');
  });

  it('gives every deferral a real reason', () => {
    for (const [key, reason] of Object.entries(NOT_YET_IN_UI)) {
      assert.ok(reason.length > 30, `${key} needs a proper justification, not "${reason}"`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(MUST_REACH_FROM_UI, key),
        `${key} is deferred but is not a named requirement; it does not belong in this list`,
      );
    }
  });

  it('reaches every named requirement from the SPA, or defers it explicitly', () => {
    const unaccounted = Object.keys(MUST_REACH_FROM_UI)
      .filter((key) => !referenced.has(key))
      .filter((key) => NOT_YET_IN_UI[key] === undefined)
      .map((key) => `${key} (${MUST_REACH_FROM_UI[key]}) -> ${declared.get(key) ?? 'unknown path'}`);
    assert.deepEqual(
      unaccounted,
      [],
      `a named requirement is neither reachable from the interface nor recorded as deferred:\n  ${unaccounted.join('\n  ')}`,
    );
  });

  it('does not defer something the SPA already calls', () => {
    // A stale deferral is worse than none: it would keep a finished feature
    // listed as missing.
    const stale = Object.keys(NOT_YET_IN_UI).filter((key) => referenced.has(key));
    assert.deepEqual(stale, [], 'these are deferred but the SPA calls them; remove them from the list');
  });

  it('checks reachability by screen, not by constant', () => {
    // The method has a trap in it, and it caught me. A *declared and routed*
    // constant that the SPA never calls is not evidence that a feature has no
    // interface: `API.workflow.update`, `workflow.statuses` and
    // `workflow.transitions` are all uncalled because the workflow editor uses
    // the per-entity routes instead, and the editor very much exists.
    //
    // So this asserts the shape of the evidence. A page may exist for a
    // feature whose constants are partly unused, and the matrix is right to
    // call it delivered; the converse -- a page that exists but cannot reach
    // the server -- is what `client-contract.test.ts` exists to catch.
    const workflowPage = join(webRoot, 'pages', 'SettingsWorkflow.tsx');
    assert.ok(
      readFileSync(workflowPage, 'utf8').includes('workflowApi.createStatus'),
      'the workflow editor should drive the per-status routes it was built for',
    );
    assert.ok(
      referenced.has('workflow.createStatus'),
      'if the editor exists, the per-status route it calls must be referenced',
    );
  });
});
