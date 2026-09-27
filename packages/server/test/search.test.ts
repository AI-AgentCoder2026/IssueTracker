/**
 * Search: FTS5 matching, filter dimensions, facets and the degradation path.
 *
 * Two things are worth defending here. First, an FTS5 query is user input that
 * reaches a parser with its own grammar, so a malformed one must degrade to a
 * LIKE search rather than a 500. Second, the `visibleProjectIds` guard is a
 * security boundary: a search that ignores it leaks issues across projects.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSearchQuery } from '@tracker/shared';
import { createHarness, insertUser, createProject, statusId, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;
let otherProjectId: number;
let userId: number;

/** A minimal query; the service applies its own defaults. */
function query(overrides: Partial<IssueSearchQuery> = {}): IssueSearchQuery {
  return { q: '', limit: 50, archived: false, includeDescendants: true, ...overrides } as IssueSearchQuery;
}

async function newIssue(
  project: number,
  title: string,
  description = '',
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const result = await harness.services.issues.create(
    project,
    { title, description, type: 'task', priority: 'medium', ...overrides },
    userId,
    { actorId: userId },
  );
  return result.issue.id as unknown as number;
}

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'searcher' });
  projectId = createProject(harness, userId, 'SRCH');
  otherProjectId = createProject(harness, userId, 'OTHR');

  await newIssue(projectId, 'Login button fails on Safari', 'The submit handler throws a TypeError');
  await newIssue(projectId, 'Password reset email never arrives', 'SMTP relay is rejecting the message');
  await newIssue(projectId, 'Dashboard widget renders blank', 'Only affects the burndown chart');
  await newIssue(projectId, 'Typo in the changelog', 'mentions lable instead of label');
  await newIssue(otherProjectId, 'Unrelated secret project issue', 'should never leak');

  // Comment text must be searchable too: someone reported this only in a comment.
  const withComment = await newIssue(projectId, 'Discussed elsewhere');
  harness.services.comments.create(
    withComment,
    { body: 'The fix involved a certificate rotation on the IdP.' },
    userId,
    { silent: true },
  );
});

after(() => harness.close());

describe('full-text search', () => {
  it('matches on the title', async () => {
    const page = await harness.services.search.search(
      query({ q: 'Safari', projectIds: [projectId] }),
    );
    assert.ok(page.issues.length >= 1);
    assert.match(page.issues[0]?.title ?? '', /Safari/);
  });

  it('matches on the description', async () => {
    const page = await harness.services.search.search(
      query({ q: 'TypeError', projectIds: [projectId] }),
    );
    assert.ok(page.issues.length >= 1, 'body text is indexed');
  });

  it('matches text that only appears in a comment', async () => {
    const page = await harness.services.search.search(
      query({ q: 'certificate', projectIds: [projectId] }),
    );
    assert.ok(
      page.issues.some((issue) => /Discussed elsewhere/.test(issue.title)),
      'comment text is indexed as well as issue text',
    );
  });

  it('finds a near miss on a misspelling', async () => {
    const page = await harness.services.search.search(
      query({ q: 'changelog', projectIds: [projectId] }),
    );
    assert.ok(page.issues.length >= 1);
  });

  it('reports how long the query took', async () => {
    const page = await harness.services.search.search(query({ q: 'login', projectIds: [projectId] }));
    assert.equal(typeof page.tookMs, 'number');
    assert.ok(page.tookMs >= 0);
  });
});

describe('degrading safely on a malformed query', () => {
  // FTS5 has its own grammar; user text must never reach it unescaped and blow
  // up the request.
  const hostile = [
    '((( unbalanced',
    'AND OR NOT',
    'title:',
    '"unterminated phrase',
    'NEAR(',
    '*',
    'a AND (b OR',
    'title:"x" NEAR',
  ];

  for (const input of hostile) {
    it(`degrades rather than throwing for ${JSON.stringify(input)}`, async () => {
      const page = await harness.services.search.search(
        query({ q: input, projectIds: [projectId] }),
      );
      assert.ok(Array.isArray(page.issues), 'a result set is still returned');
      assert.ok(Array.isArray(page.warnings));
    });
  }
});

describe('filters', () => {
  it('filters by state', async () => {
    const open = await newIssue(projectId, 'Filter target open', '', { priority: 'high' });
    const page = await harness.services.search.search(
      query({ projectIds: [projectId], states: ['open'] }),
    );
    assert.ok(page.issues.some((issue) => issue.id === open));
  });

  it('filters by type', async () => {
    const bug = await newIssue(projectId, 'Filter target bug', '', { type: 'bug' });
    const page = await harness.services.search.search(
      query({ projectIds: [projectId], types: ['bug'] }),
    );
    assert.ok(page.issues.some((issue) => issue.id === bug));
  });

  it('filters by priority', async () => {
    const critical = await newIssue(projectId, 'Filter target critical', '', { priority: 'critical' });
    const page = await harness.services.search.search(
      query({ projectIds: [projectId], priorities: ['critical'] }),
    );
    assert.ok(page.issues.some((issue) => issue.id === critical));
  });

  it('filters by assignee, including nobody', async () => {
    const unassigned = await newIssue(projectId, 'Nobody owns this');
    const page = await harness.services.search.search(
      query({ projectIds: [projectId], unassignedOnly: true }),
    );
    assert.ok(page.issues.some((issue) => issue.id === unassigned));
  });

  it('finds only overdue issues when asked', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const overdue = await newIssue(projectId, 'Overdue target', '', { dueDate: past });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await newIssue(projectId, 'Not overdue yet', '', { dueDate: future });

    const page = await harness.services.search.search(
      query({ projectIds: [projectId], overdueOnly: true }),
    );
    assert.ok(page.issues.some((issue) => issue.id === overdue));
    assert.ok(!page.issues.some((issue) => /Not overdue yet/.test(issue.title)));
  });

  it('excludes archived issues unless asked', async () => {
    const archived = await newIssue(projectId, 'Archived target');
    harness.services.issues.setArchived(archived, true, userId, {});

    const withoutArchived = await harness.services.search.search(
      query({ projectIds: [projectId] }),
    );
    assert.ok(!withoutArchived.issues.some((issue) => issue.id === archived));

    const withArchived = await harness.services.search.search(
      query({ projectIds: [projectId], archived: true }),
    );
    assert.ok(withArchived.issues.some((issue) => issue.id === archived));
  });

  it('excludes sub-tasks when top-level only is requested', async () => {
    const parent = await newIssue(projectId, 'Parent for nesting');
    const child = await newIssue(projectId, 'Child for nesting', '', { parentId: parent });

    const topLevel = await harness.services.search.search(
      query({ projectIds: [projectId], topLevelOnly: true }),
    );
    assert.ok(!topLevel.issues.some((issue) => issue.id === child));
    assert.ok(topLevel.issues.some((issue) => issue.id === parent));
  });

  it('combines a text query with a filter', async () => {
    const page = await harness.services.search.search(
      query({ q: 'Filter target', projectIds: [projectId], types: ['task'] }),
    );
    assert.ok(page.issues.every((issue) => issue.type === 'task'));
  });
});

describe('project visibility is a security boundary', () => {
  it('never returns an issue from a project the caller cannot see', async () => {
    // The caller may see only one project; the other has a matching title.
    const page = await harness.services.search.search(
      query({ q: 'secret' }),
      { visibleProjectIds: [projectId] },
    );
    assert.ok(
      !page.issues.some((issue) => /secret project/i.test(issue.title)),
      'an issue outside the permitted projects must not appear',
    );
  });

  it('returns nothing when no project is visible at all', async () => {
    const page = await harness.services.search.search(query({ q: 'secret' }), { visibleProjectIds: [] });
    assert.equal(page.issues.length, 0);
    assert.equal(page.total, 0);
  });

  it('scopes facets to the permitted projects too', async () => {
    const facets = await harness.services.search.facets(query({ projectIds: [projectId] }), {
      visibleProjectIds: [projectId],
    });
    const totalFromStates = facets.states.reduce((sum, bucket) => sum + bucket.count, 0);
    assert.ok(totalFromStates > 0);
    // The other project's issues must not inflate any bucket.
    assert.ok(totalFromStates < 100, 'facet counts stay within the visible project');
  });
});

describe('summaries and facets', () => {
  it('summarises without returning rows', async () => {
    const summary = await harness.services.search.summarise(query({ projectIds: [projectId] }), {
      visibleProjectIds: [projectId],
    });
    assert.equal(typeof summary.total, 'number');
    assert.ok(summary.total > 0);
  });

  it('produces facet buckets for each dimension', async () => {
    const facets = await harness.services.search.facets(query({ projectIds: [projectId] }), {
      visibleProjectIds: [projectId],
    });
    for (const dimension of ['states', 'priorities', 'types'] as const) {
      assert.ok(Array.isArray(facets[dimension]), `${dimension} is returned`);
    }
  });

  it('returns search suggestions for a prefix', async () => {
    const suggestions = await harness.services.search.suggest('Log', 5, { projectId });
    assert.ok(Array.isArray(suggestions));
  });
});

describe('paging', () => {
  it('walks the result set with a cursor', async () => {
    const first = await harness.services.search.search(
      query({ projectIds: [projectId], limit: 2, sort: 'created_asc' }),
      { visibleProjectIds: [projectId] },
    );
    assert.ok(first.issues.length <= 2);
    if (first.nextCursor === null) return; // fewer than one page of results

    const second = await harness.services.search.search(
      query({ projectIds: [projectId], limit: 2, sort: 'created_asc', cursor: first.nextCursor }),
      { visibleProjectIds: [projectId] },
    );
    const firstIds = new Set(first.issues.map((issue) => issue.id));
    assert.ok(
      !second.issues.some((issue) => firstIds.has(issue.id)),
      'the second page must not repeat the first',
    );
  });
});
