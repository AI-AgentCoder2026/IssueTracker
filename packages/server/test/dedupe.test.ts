/**
 * Duplicate detection.
 *
 * The strategies are deterministic and lexical, not neural. That is stated in
 * the code and in the README, and the tests below pin the behaviour so the
 * honesty cannot quietly drift: what is asserted is a title-normalisation and
 * similarity contract, not "semantic understanding".
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import { defaultStrategies, normaliseTitle } from '../src/services/dedupe.service.ts';
import type { RequestContext } from '../src/services/context.ts';
import type { ProjectId, Role, UserId } from '@tracker/shared';
import type { DedupeStrategy } from '@tracker/shared';

const strategies = defaultStrategies();

/** A minimal comparable; the strategies read type and labels as well as title. */
function comparable(title: string, type = 'bug') {
  return { id: 0, key: 'DEDUP-1', title, type, labelIds: [] as number[] };
}

/** Score two titles with one named strategy. */
function scoreOf(strategy: DedupeStrategy, a: string, b: string): number {
  const implementation = strategies.get(strategy);
  assert.ok(implementation, `no strategy registered for ${strategy}`);
  return implementation.score(comparable(a), comparable(b)).score;
}

/** An actor with admin rights, which the scan permission check expects. */
function actorFor(user: number) {
  return {
    userId: user as UserId,
    isInstanceAdmin: true,
    roles: ['admin' as Role],
    projectRoles: new Map<ProjectId, Role>(),
  };
}

/** A request context shaped like the real one. */
function requestContext(user: number, project: number, harnessRef: TestHarness): RequestContext {
  return {
    services: harnessRef.services,
    db: harnessRef.db,
    config: harnessRef.config,
    actor: {
      userId: user as UserId,
      isInstanceAdmin: true,
      roles: ['admin' as Role],
      projectRoles: new Map([[project as ProjectId, 'owner' as Role]]),
    },
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: user, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

let harness: TestHarness;
let projectId: number;
let userId: number;

async function newIssue(title: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'bug', priority: 'medium', ...overrides },
    userId,
    { actorId: userId },
  );
  return result.issue.id as unknown as number;
}

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'deduper' });
  projectId = createProject(harness, userId, 'DEDUP');
});

after(() => harness.close());

describe('title normalisation', () => {
  const normalise = (title: string): string => normaliseTitle(title);

  it('folds case', () => {
    assert.equal(normalise('Login Button Fails'), normalise('login button fails'));
  });

  it('collapses whitespace', () => {
    assert.equal(normalise('login   button'), normalise('login button'));
  });

  it('strips surrounding punctuation', () => {
    assert.equal(normalise('"login button"'), normalise('login button'));
    assert.equal(normalise('(login button)'), normalise('login button'));
  });

  it('removes a leading type prefix so [Bug] and [Feature] can still match', () => {
    assert.equal(normalise('[Bug] login button'), normalise('login button'));
  });

  it('removes a trailing issue key so the same text matches across issues', () => {
    assert.equal(normalise('login button (DEDUP-12)'), normalise('login button'));
  });

  it('keeps words that matter', () => {
    assert.notEqual(normalise('login fails'), normalise('logout fails'));
  });
});

describe('similarity strategies', () => {
  it('scores identical titles at the top', () => {
    const first = newIssue('Duplicate detection misses reorders');
    const second = newIssue('Duplicate detection misses reorders');
    const score = scoreOf('exact_title', 'Duplicate detection misses reorders', 'Duplicate detection misses reorders');
    assert.equal(typeof score, 'number');
    assert.ok(score > 0.9, `expected a near-certain score, got ${score}`);
    void first;
    void second;
  });

  it('scores two different titles low', () => {
    const score = scoreOf('fuzzy_title', 'Login button fails on Safari', 'Password reset email never arrives');
    assert.ok(score < 0.5, `expected a low score, got ${score}`);
  });

  it('rewards a shared prefix on a fuzzy match', () => {
    const close = scoreOf('fuzzy_title', 'Login button fails on Safari', 'Login button broken on Safari');
    const far = scoreOf('fuzzy_title', 'Login button fails on Safari', 'Unrelated database migration');
    assert.ok(close > far, 'a similar title must score above an unrelated one');
  });

  it('returns a bounded score for every strategy', () => {
    for (const strategy of ['exact_title', 'fuzzy_title', 'semantic'] as const) {
      const score = scoreOf(strategy, 'Something entirely different', 'Nothing alike');
      assert.ok(score >= 0 && score <= 1, `${strategy} produced an out-of-range score: ${score}`);
    }
  });
});

describe('scanning a project', () => {
  it('finds an obvious duplicate pair', async () => {
    const source = await newIssue('Session cookie is not cleared on logout');
    const twin = await newIssue('Session cookie not cleared on logout');

    const candidates = await harness.services.dedupe.scan(
      { projectId, strategies: ['exact_title', 'fuzzy_title'], minConfidence: 0.6, openOnly: false, limit: 50, autoLink: false },
      actorFor(userId),
      requestContext(userId, projectId, harness),
    );

    assert.ok(candidates.length > 0, 'a near-duplicate pair should be reported');
    const pair = candidates.find(
      (candidate) =>
        (Number(candidate.sourceIssueId) === source && Number(candidate.candidateIssueId) === twin) ||
        (Number(candidate.sourceIssueId) === twin && Number(candidate.candidateIssueId) === source),
    );
    assert.ok(pair, 'the two similar issues are paired');
    assert.ok(pair && pair.confidence > 0.6);
  });

  it('does not report an issue as a duplicate of itself', async () => {
    await newIssue('Completely unique wording for the self check');
    const candidates = await harness.services.dedupe.scan(
      { projectId, strategies: ['exact_title', 'fuzzy_title'], minConfidence: 0.6, openOnly: false, limit: 50, autoLink: false },
      actorFor(userId),
      requestContext(userId, projectId, harness),
    );
    for (const candidate of candidates) {
      assert.notEqual(
        String(candidate.sourceIssueId),
        String(candidate.candidateIssueId),
        'an issue is never its own duplicate',
      );
    }
  });

  it('respects the confidence floor', async () => {
    await newIssue('Threshold probe alpha');
    await newIssue('Threshold probe beta with quite different wording');

    const strict = await harness.services.dedupe.scan(
      { projectId, strategies: ['fuzzy_title'], minConfidence: 0.95, openOnly: false, limit: 50, autoLink: false },
      actorFor(userId),
      requestContext(userId, projectId, harness),
    );
    for (const candidate of strict) {
      assert.ok(candidate.confidence >= 0.95, `a candidate below the floor leaked through: ${candidate.confidence}`);
    }
  });

  it('does not leak issues from another project', async () => {
    const otherOwner = insertUser(harness, { username: 'otherdedup' });
    const otherProject = createProject(harness, otherOwner, 'OTHERDD');
    await harness.services.issues.create(
      otherProject,
      { title: 'Leaky duplicate title', description: '', type: 'bug', priority: 'medium' },
      otherOwner,
      { actorId: otherOwner },
    );

    const candidates = await harness.services.dedupe.scan(
      { projectId, strategies: ['exact_title', 'fuzzy_title'], minConfidence: 0.5, openOnly: false, limit: 100, autoLink: false },
      actorFor(userId),
      requestContext(userId, projectId, harness),
    );
    for (const candidate of candidates) {
      const row = harness.db.get<{ project_id: number }>('SELECT project_id FROM issues WHERE id = ?', [
        candidate.candidateIssueId,
      ]);
      assert.equal(row?.project_id, projectId, 'a candidate from another project leaked in');
    }
  });
});

describe('per-issue suggestions', () => {
  it('suggests matches for one issue and excludes itself', async () => {
    const subject = await newIssue('Webhook retries storm the endpoint');
    await newIssue('Webhook retries are storming the endpoint');

    const suggestions = await harness.services.dedupe.suggestForIssue(subject);
    assert.ok(suggestions.length > 0, 'a similar issue is suggested');
    for (const suggestion of suggestions) {
      assert.notEqual(
        String(suggestion.candidateIssueId),
        String(subject),
        'an issue is never suggested as its own duplicate',
      );
    }
  });
});

describe('auto-linking', () => {
  it('creates an auto-detected link when asked', async () => {
    const source = await newIssue('Auto link probe alpha');
    const twin = await newIssue('Auto link probe alpha');

    await harness.services.dedupe.scan(
      { projectId, strategies: ['exact_title'], minConfidence: 0.5, openOnly: false, limit: 50, autoLink: true },
      actorFor(userId),
      requestContext(userId, projectId, harness),
    );

    const links = harness.db.all<{ source_issue_id: number; target_issue_id: number; auto_detected: number }>(
      'SELECT source_issue_id, target_issue_id, auto_detected FROM issue_links WHERE auto_detected = 1',
    );
    const found = links.some(
      (link) =>
        (link.source_issue_id === source && link.target_issue_id === twin) ||
        (link.source_issue_id === twin && link.target_issue_id === source),
    );
    assert.ok(found, 'the duplicate pair is linked when autoLink is set');
  });

  it('marks the link as auto-detected so a human can dismiss it', async () => {
    const links = harness.db.all<{ id: number; auto_detected: number }>(
      'SELECT id, auto_detected FROM issue_links WHERE auto_detected = 1',
    );
    assert.ok(links.length > 0);
    assert.ok(links.every((link) => link.auto_detected === 1));
  });
});
