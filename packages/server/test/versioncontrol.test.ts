/**
 * Version-control linkage: reference CRUD, branch-name inference, and the
 * validation boundaries that keep untrusted provider data from becoming a
 * stored XSS vector.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBranchRuleFor,
  parseIssueKeyFromRef,
  type BranchImportResult,
} from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;
let repositoryId: number;

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'vcuser' });
  projectId = createProject(harness, userId, 'VCS');

  const repository = harness.services.versionControl.createRepository(
    projectId,
    {
      provider: 'gitlab',
      name: 'platform/api-gateway',
      baseUrl: 'https://gitlab.example.com/platform/api-gateway',
      externalId: '42',
      defaultBranch: 'main',
    },
    { actorId: userId },
  );
  repositoryId = repository.id;
});

after(() => harness.close());

async function newIssue(title: string) {
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'task', priority: 'medium' },
    userId,
    {},
  );
  return result.issue;
}

describe('branch name parsing', () => {
  const rule = { pattern: '^(?<key>[A-Z]+-\\d+)', stripPrefixes: ['feature/', 'bugfix/'] };

  it('extracts an issue key from a plain branch name', () => {
    assert.equal(parseIssueKeyFromRef('VCS-42-add-login', rule), 'VCS-42');
  });

  it('strips a configured prefix first', () => {
    assert.equal(parseIssueKeyFromRef('feature/VCS-42-add-login', rule), 'VCS-42');
    assert.equal(parseIssueKeyFromRef('bugfix/VCS-7', rule), 'VCS-7');
  });

  it('ignores a branch that names no issue', () => {
    assert.equal(parseIssueKeyFromRef('dependabot/npm/lodash-4.17.21', rule), null);
    assert.equal(parseIssueKeyFromRef('main', rule), null);
  });

  it('does not match a key from a different project once the rule is scoped', () => {
    // A deliberately generic rule matches any well-formed key - that is what
    // it was asked to do. Scoping to one project is the generated rule's job.
    assert.equal(parseIssueKeyFromRef('OTHER-42-something', rule), 'OTHER-42');

    const scoped = defaultBranchRuleFor('VCS');
    assert.equal(parseIssueKeyFromRef('OTHER-42-something', scoped), null);
    assert.equal(parseIssueKeyFromRef('VCS-42-something', scoped), 'VCS-42');
  });

  it('handles a project key containing regex metacharacters safely', () => {
    // A key with a dot must not behave as a wildcard in the generated rule.
    const risky = defaultBranchRuleFor('A.B');
    assert.equal(parseIssueKeyFromRef('AxB-1-work', risky), null);
    assert.equal(parseIssueKeyFromRef('A.B-1-work', risky), 'A.B-1');
  });

  it('returns null for an uncompilable pattern rather than throwing', () => {
    assert.equal(parseIssueKeyFromRef('VCS-1', { pattern: '([unclosed', stripPrefixes: [] }), null);
  });

  it('falls back to the first defined group when `key` is not named', () => {
    assert.equal(
      parseIssueKeyFromRef('VCS-9-fix', { pattern: '^([A-Z]+-\\d+)', stripPrefixes: [] }),
      'VCS-9',
    );
  });
});

describe('repositories', () => {
  it('registers a repository and lists it for the project', () => {
    const repositories = harness.services.versionControl.listRepositories(projectId);
    assert.ok(repositories.some((repository) => repository.id === repositoryId));
  });

  it('refuses a duplicate repository name for the same provider', () => {
    assert.throws(
      () =>
        harness.services.versionControl.createRepository(
          projectId,
          {
            provider: 'gitlab',
            name: 'platform/api-gateway',
            baseUrl: '',
            externalId: null,
            defaultBranch: 'main',
          },
          { actorId: userId },
        ),
      /already exists/,
    );
  });

  it('records the change in the audit trail', () => {
    const entry = harness.db.get<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_type = 'repository' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(entry?.action, 'settings.changed');
  });
});

describe('issue references', () => {
  it('links a branch to an issue and reads it back', async () => {
    const issue = await newIssue('has a branch');
    const reference = harness.services.versionControl.addReference(
      issue.id,
      { repositoryId, kind: 'branch', ref: 'VCS-1-feature', headSha: null, title: '', state: 'open', url: null },
      userId,
      {},
    );

    assert.equal(reference.kind, 'branch');
    assert.equal(reference.autoDetected, false);

    const listed = harness.services.versionControl.listForIssue(issue.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.repositoryName, 'platform/api-gateway');
    assert.equal(listed[0]?.isMerged, false);
  });

  it('refuses to link a repository from another project', async () => {
    const otherOwner = insertUser(harness, { username: 'vcother' });
    const otherProject = createProject(harness, otherOwner, 'VCS2');
    const otherRepo = harness.services.versionControl.createRepository(
      otherProject,
      { provider: 'github', name: 'acme/other', baseUrl: '', externalId: null, defaultBranch: 'main' },
      { actorId: otherOwner },
    );

    const issue = await newIssue('cross project link');
    assert.throws(
      () =>
        harness.services.versionControl.addReference(
          issue.id,
          { repositoryId: otherRepo.id, kind: 'branch', ref: 'x', headSha: null, title: '', state: 'open', url: null },
          userId,
          {},
        ),
      /different project/,
    );
  });

  it('refuses to claim one branch for two issues', async () => {
    const a = await newIssue('branch owner a');
    const b = await newIssue('branch owner b');
    const input = { repositoryId, kind: 'branch' as const, ref: 'shared-branch', headSha: null, title: '', state: 'open' as const, url: null };

    harness.services.versionControl.addReference(a.id, input, userId, {});
    assert.throws(
      () => harness.services.versionControl.addReference(b.id, input, userId, {}),
      /already linked to another issue/,
    );
  });

  it('is idempotent when the same issue re-links the same ref', async () => {
    const issue = await newIssue('idempotent link');
    const input = { repositoryId, kind: 'branch' as const, ref: 'idem-branch', headSha: null, title: '', state: 'open' as const, url: null };

    const first = harness.services.versionControl.addReference(issue.id, input, userId, {});
    const second = harness.services.versionControl.addReference(issue.id, input, userId, {});
    assert.equal(second.id, first.id, 'rediscovery must not duplicate the row');
  });

  it('summarises counts for the header badge', async () => {
    const issue = await newIssue('linkage summary');
    const base = { repositoryId, headSha: null, title: '', url: null };

    harness.services.versionControl.addReference(
      issue.id,
      { ...base, kind: 'branch', ref: 'sum-branch', state: 'open' },
      userId,
      {},
    );
    harness.services.versionControl.addReference(
      issue.id,
      { ...base, kind: 'commit', ref: 'a'.repeat(40), state: 'open' },
      userId,
      {},
    );
    harness.services.versionControl.addReference(
      issue.id,
      { ...base, kind: 'merge_request', ref: '!12', state: 'merged' },
      userId,
      {},
    );

    const summary = harness.services.versionControl.summary(issue.id);
    assert.equal(summary.branches, 1);
    assert.equal(summary.commits, 1);
    assert.equal(summary.mergeRequests, 1);
    assert.equal(summary.merged, 1, 'a merged MR counts as finished work');
    assert.ok(summary.latest);
  });

  it('updates a reference state and records it on the timeline', async () => {
    const issue = await newIssue('state change');
    const reference = harness.services.versionControl.addReference(
      issue.id,
      { repositoryId, kind: 'merge_request', ref: '!99', headSha: null, title: '', state: 'open', url: null },
      userId,
      {},
    );

    const updated = harness.services.versionControl.updateReference(
      issue.id,
      reference.id,
      { state: 'merged' },
      userId,
      {},
    );
    assert.equal(updated.state, 'merged');

    const events = harness.services.activity.forIssue(issue.id, { types: ['issue.linked'] });
    assert.ok(events.some((event) => event.summary.includes('as merged')));
  });

  it('removes a reference and records it', async () => {
    const issue = await newIssue('unlink reference');
    const reference = harness.services.versionControl.addReference(
      issue.id,
      { repositoryId, kind: 'tag', ref: 'v1.0.0', headSha: null, title: '', state: 'open', url: null },
      userId,
      {},
    );

    harness.services.versionControl.removeReference(issue.id, reference.id, userId, {});
    assert.equal(harness.services.versionControl.listForIssue(issue.id).length, 0);
    assert.throws(
      () => harness.services.versionControl.removeReference(issue.id, reference.id, userId, {}),
      /not found/i,
    );
  });
});

describe('branch import', () => {
  let ruleId: number;
  const issueKeys: string[] = [];

  before(async () => {
    const a = await newIssue('import target a');
    const b = await newIssue('import target b');
    issueKeys.push(a.key, b.key);

    const rule = harness.services.versionControl.createRule(
      projectId,
      {
        repositoryId,
        pattern: defaultBranchRuleFor('VCS').pattern,
        stripPrefixes: defaultBranchRuleFor('VCS').stripPrefixes,
        enabled: true,
      },
      { actorId: userId },
    );
    ruleId = rule.id;
  });

  it('creates a rule with the project key escaped', () => {
    const rules = harness.services.versionControl.listRules(projectId);
    assert.ok(rules.some((rule) => rule.id === ruleId));
  });

  it('links branches whose names match the convention', () => {
    const result: BranchImportResult = harness.services.versionControl.importBranches(
      repositoryId,
      [
        { name: `feature/${issueKeys[0]}-add-login`, headSha: 'a'.repeat(40) },
        { name: `${issueKeys[1]}-fix-crash` },
      ],
    );

    assert.equal(result.scanned, 2);
    assert.equal(result.linked, 2);
    assert.equal(result.updated, 0);
    assert.equal(result.unresolved.length, 0);
  });

  it('is idempotent across repeated passes', () => {
    const result = harness.services.versionControl.importBranches(repositoryId, [
      { name: `feature/${issueKeys[0]}-add-login` },
    ]);
    assert.equal(result.linked, 0, 'nothing new');
    assert.equal(result.updated, 1, 'refreshed, not duplicated');
  });

  it('reports a branch whose issue does not exist locally', () => {
    const result = harness.services.versionControl.importBranches(repositoryId, [
      { name: 'feature/VCS-9999-does-not-exist' },
    ]);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]?.issueKey, 'VCS-9999');
  });

  it('reports an unmatchable branch rather than swallowing it', () => {
    const result = harness.services.versionControl.importBranches(repositoryId, [
      { name: 'dependabot/npm/lodash-4.17.21' },
    ]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]?.reason ?? '', /no rule matched/);
  });

  it('caps the number of branches per pass', () => {
    const many = Array.from({ length: 1500 }, (_value, index) => ({ name: `feature/VCS-${index}-x` }));
    const result = harness.services.versionControl.importBranches(repositoryId, many);
    assert.ok(result.scanned <= 1000, 'a pass is bounded so a huge repo cannot stall a sync');
  });

  it('marks imported branches as auto-detected', async () => {
    const issue = await newIssue('auto detected marker');
    harness.services.versionControl.importBranches(repositoryId, [{ name: `feature/${issue.key}-auto` }]);
    const references = harness.services.versionControl.listForIssue(issue.id);
    assert.equal(references[0]?.autoDetected, true);
  });

  it('does nothing when no rule is configured', () => {
    const otherOwner = insertUser(harness, { username: 'vcnorule' });
    const otherProject = createProject(harness, otherOwner, 'VCS3');
    const otherRepo = harness.services.versionControl.createRepository(
      otherProject,
      { provider: 'generic', name: 'acme/none', baseUrl: '', externalId: null, defaultBranch: 'main' },
      { actorId: otherOwner },
    );

    const result = harness.services.versionControl.importBranches(otherRepo.id, [{ name: 'PROJ-1-x' }]);
    assert.equal(result.scanned, 0);
  });
});
