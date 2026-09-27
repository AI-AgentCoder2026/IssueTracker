/**
 * Workflow engine: transition legality, WIP limits, and the timing columns a
 * transition is responsible for maintaining.
 *
 * `IssueService.create` and `transition` are async, so helpers and call sites
 * await them.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, createProject, statusId, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'wfuser' });
  projectId = createProject(harness, userId, 'WF');
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

describe('workflow provisioning', () => {
  it('gives a new project the full default status set', () => {
    const statuses = harness.services.workflow.statusesForProject(projectId);
    const keys = statuses.map((status) => status.key);

    for (const expected of [
      'backlog',
      'open',
      'in_progress',
      'blocked',
      'in_review',
      'resolved',
      'closed',
      'wont_fix',
    ]) {
      assert.ok(keys.includes(expected), `default workflow must include "${expected}"`);
    }
  });

  it('orders the statuses for board rendering', () => {
    const positions = harness.services.workflow
      .statusesForProject(projectId)
      .map((status) => status.position);
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, sorted, 'statuses must come back in position order');
  });

  it('reports that an untouched project still uses the defaults', () => {
    assert.equal(harness.services.workflow.isUsingDefaultStatuses(projectId), true);
  });

  it('marks resolution and closure statuses correctly', () => {
    const resolved = harness.services.workflow
      .statusesForProject(projectId)
      .find((status) => status.key === 'resolved');
    const closed = harness.services.workflow
      .statusesForProject(projectId)
      .find((status) => status.key === 'closed');

    assert.equal(resolved?.isResolution, true);
    assert.equal(resolved?.isClosed, false);
    assert.equal(closed?.isClosed, true);
    assert.equal(closed?.isDone, true);
  });
});

describe('transition rules', () => {
  it('allows the documented happy path', () => {
    const open = statusId(harness, projectId, 'open');
    const inProgress = statusId(harness, projectId, 'in_progress');
    const inReview = statusId(harness, projectId, 'in_review');
    const resolved = statusId(harness, projectId, 'resolved');
    const closed = statusId(harness, projectId, 'closed');

    for (const [from, to] of [
      [open, inProgress],
      [inProgress, inReview],
      [inReview, resolved],
      [resolved, closed],
    ] as Array<[number, number]>) {
      const check = harness.services.workflow.checkTransition({
        projectId,
        fromStatusId: from,
        toStatusId: to,
      });
      assert.equal(check.allowed, true, `${from} -> ${to} should be allowed: ${check.reason}`);
    }
  });

  it('blocks a transition that has no edge', () => {
    const backlog = statusId(harness, projectId, 'backlog');
    const inReview = statusId(harness, projectId, 'in_review');

    const check = harness.services.workflow.checkTransition({
      projectId,
      fromStatusId: backlog,
      toStatusId: inReview,
    });
    assert.equal(check.allowed, false);
    assert.ok(check.reason.length > 0, 'a refusal must explain itself');
  });

  it('honours a wildcard transition from any status', () => {
    const inReview = statusId(harness, projectId, 'in_review');
    const wontFix = statusId(harness, projectId, 'wont_fix');

    // `* -> wont_fix` is a default edge, so it is reachable from anywhere.
    const check = harness.services.workflow.checkTransition({
      projectId,
      fromStatusId: inReview,
      toStatusId: wontFix,
    });
    assert.equal(check.allowed, true);
  });

  it('rejects a status belonging to another project', () => {
    const otherOwner = insertUser(harness, { username: 'wfother' });
    const otherProject = createProject(harness, otherOwner, 'WF2');
    const foreignStatus = statusId(harness, otherProject, 'closed');

    const check = harness.services.workflow.checkTransition({
      projectId,
      fromStatusId: statusId(harness, projectId, 'open'),
      toStatusId: foreignStatus,
    });
    assert.equal(check.allowed, false);
    assert.match(check.reason, /does not belong/);
  });

  it('enforces the WIP limit on a target status', async () => {
    const wipHarness = createHarness();
    try {
      const owner = insertUser(wipHarness, { username: 'wipowner' });
      const wipProject = createProject(wipHarness, owner, 'WIP');
      const inProgress = statusId(wipHarness, wipProject, 'in_progress');
      const open = statusId(wipHarness, wipProject, 'open');

      const limit = wipHarness.services.workflow
        .statusesForProject(wipProject)
        .find((status) => status.key === 'in_progress')?.wipLimit;
      assert.ok(limit && limit > 0, 'in_progress should have a WIP limit by default');

      // Fill the column to its limit.
      for (let i = 0; i < limit; i += 1) {
        await wipHarness.services.issues.create(
          wipProject,
          { title: `filler ${i}`, description: '', type: 'task', priority: 'medium', statusId: inProgress },
          owner,
          {},
        );
      }

      const overflow = (
        await wipHarness.services.issues.create(
          wipProject,
          { title: 'one too many', description: '', type: 'task', priority: 'medium', statusId: open },
          owner,
          {},
        )
      ).issue;

      const check = wipHarness.services.workflow.checkTransition({
        projectId: wipProject,
        fromStatusId: open,
        toStatusId: inProgress,
      });
      assert.equal(check.allowed, false, 'the column is full');
      assert.match(check.reason, /WIP limit/);

      // Moving within the same status must not consume another slot.
      const sameColumn = wipHarness.services.workflow.checkTransition({
        projectId: wipProject,
        fromStatusId: inProgress,
        toStatusId: inProgress,
      });
      assert.equal(sameColumn.allowed, true, 'a same-column move is always permitted');

      // And the overflow issue genuinely cannot move.
      await assert.rejects(
        async () =>
          wipHarness.services.issues.transition(
            overflow.id,
            { toStatusId: inProgress },
            owner,
            {},
          ),
        /WIP limit/,
      );
    } finally {
      wipHarness.close();
    }
  });
});

describe('transition side effects', () => {
  it('stamps started_at on first entry into a started status', async () => {
    const issue = await newIssue('stamps started');
    assert.equal(issue.startedAt, null, 'a new issue has not started');

    const moved = harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_progress') },
      userId,
      {},
    );

    assert.ok(moved.startedAt, 'starting work must record when');
    assert.equal(moved.state, 'in_progress');
  });

  it('stamps resolved_at on a resolution status and closed_at on a closed one', async () => {
    const issue = await newIssue('resolution timing');
    const inProgress = statusId(harness, projectId, 'in_progress');

    harness.services.issues.transition(issue.id, { toStatusId: inProgress }, userId, {});
    harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_review') },
      userId,
      {},
    );
    const resolved = harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'resolved') },
      userId,
      {},
    );

    assert.ok(resolved.resolvedAt, 'resolving must record when');
    assert.equal(resolved.closedAt, null, 'resolved is not yet closed');

    const closed = harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'closed') },
      userId,
      {},
    );
    assert.ok(closed.closedAt, 'closing must record when');
  });

  it('bumps the version on every transition', async () => {
    const issue = await newIssue('versioning');
    const before = issue.version;
    const after = harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_progress') },
      userId,
      {},
    );
    assert.equal(after.version, before + 1);
  });

  it('rejects a stale expectedVersion', async () => {
    const issue = await newIssue('optimistic locking');
    const staleVersion = issue.version;

    harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_progress') },
      userId,
      {},
    );

    assert.throws(
      () =>
        harness.services.issues.transition(
          issue.id,
          { toStatusId: statusId(harness, projectId, 'in_review'), expectedVersion: staleVersion },
          userId,
          {},
        ),
      /modified by someone else/,
    );
  });

  it('records a transition on the activity timeline', async () => {
    const issue = await newIssue('timeline transition');
    harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_progress') },
      userId,
      {},
    );

    const events = harness.services.activity.forIssue(issue.id, { types: ['issue.transitioned'] });
    assert.ok(events.length > 0, 'the transition must appear on the timeline');
    assert.match(events[0]?.summary ?? '', /moved from .* to In Progress/);
  });

  it('attaches a transition comment when one is supplied', async () => {
    const issue = await newIssue('transition comment');
    harness.services.issues.transition(
      issue.id,
      { toStatusId: statusId(harness, projectId, 'in_progress'), comment: 'Picked this up.' },
      userId,
      {},
    );

    const comments = harness.services.comments.listForIssue(issue.id);
    assert.ok(
      comments.some((comment) => comment.body.includes('Picked this up.')),
      'the comment must be stored',
    );
  });
});

describe('workflow customisation', () => {
  it('refuses to remove a status that still holds issues', async () => {
    const harness2 = createHarness();
    try {
      const owner = insertUser(harness2, { username: 'wfcustom' });
      const proj = createProject(harness2, owner, 'CUSTOM');
      const open = statusId(harness2, proj, 'open');

      await harness2.services.issues.create(
        proj,
        { title: 'occupies open', description: '', type: 'task', priority: 'medium', statusId: open },
        owner,
        {},
      );

      assert.throws(
        () => harness2.services.workflow.update(proj, { removedStatusIds: [open] }, { actorId: owner }),
        /still use it/,
        'deleting an in-use status would orphan issues',
      );
    } finally {
      harness2.close();
    }
  });

  it('records a workflow change in the audit trail', () => {
    const harness2 = createHarness();
    try {
      const owner = insertUser(harness2, { username: 'wfaudit' });
      const proj = createProject(harness2, owner, 'WAUDIT');
      const before = harness2.db.scalar<number>('SELECT COUNT(*) AS c FROM audit_log');

      harness2.services.workflow.update(
        proj,
        {
          statuses: [
            {
              key: 'triage',
              name: 'Triage',
              state: 'open',
              color: '#123456',
              description: '',
              position: 9,
              isResolution: false,
              isClosed: false,
              isDone: false,
              wipLimit: null,
            },
          ],
        },
        { actorId: owner },
      );

      const after = harness2.db.scalar<number>('SELECT COUNT(*) AS c FROM audit_log');
      assert.ok((after ?? 0) > (before ?? 0), 'the change must be audited');

      const entry = harness2.db.get<{ after_json: string }>(
        "SELECT after_json FROM audit_log WHERE action = 'workflow.changed' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(entry?.after_json);
      assert.match(entry.after_json, /triage/);
    } finally {
      harness2.close();
    }
  });
});
