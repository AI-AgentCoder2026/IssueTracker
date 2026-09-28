/**
 * Timing math and the per-issue timeline.
 *
 * This backs the "timeline showing per-task progress, overdue alerts and time
 * taken" requirement, so the numbers are treated as load-bearing: the issue
 * header, the dashboard charts and the SLA service all read them, and a
 * disagreement between two surfaces is worse than no number at all.
 *
 * The cases that matter most are the boundaries — an issue resolved *before*
 * its due date must report zero overdue, not a growing figure — and the
 * recursive sub-task rollup, which is the one place a cycle or a shared
 * descendant could quietly inflate a total.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

before(() => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'timinguser' });
  projectId = createProject(harness, userId, 'TIME');
});

after(() => {
  harness.close();
});

/** Create an issue, then force its timestamps so the math is deterministic. */
async function issueWithTimes(
  title: string,
  times: {
    createdAt?: string;
    startedAt?: string | null;
    resolvedAt?: string | null;
    closedAt?: string | null;
    dueDate?: string | null;
    spentHours?: number;
    parentId?: number | null;
  } = {},
): Promise<number> {
  const result = await harness.services.issues.create(
    projectId,
    {
      title,
      description: '',
      type: 'task',
      priority: 'medium',
      ...(times.parentId ? { parentId: times.parentId } : {}),
    },
    userId,
    {},
  );
  const id = result.issue.id;

  harness.db.run(
    `UPDATE issues
        SET created_at = ?, started_at = ?, resolved_at = ?, closed_at = ?,
            due_date = ?, time_spent_hours = ?
      WHERE id = ?`,
    [
      times.createdAt ?? new Date().toISOString(),
      times.startedAt ?? null,
      times.resolvedAt ?? null,
      times.closedAt ?? null,
      times.dueDate ?? null,
      times.spentHours ?? 0,
      id,
    ],
  );
  return id;
}

const timing = (id: number) => harness.services.timing.computeForIssue(id);

describe('durations', () => {
  it('measures the wait from creation to first start', async () => {
    const created = new Date(Date.now() - 5 * DAY).toISOString();
    const started = new Date(Date.now() - 3 * DAY).toISOString();
    const id = await issueWithTimes('waits for a start', { createdAt: created, startedAt: started });

    const t = await timing(id);
    assert.ok(t.timeToStartMs !== null);
    // Tolerance for the wall clock moving between the write and the read.
    assert.ok(
      Math.abs(t.timeToStartMs - 2 * DAY) < 60_000,
      `expected ~2 days to start, got ${t.timeToStartMs}`,
    );
  });

  it('reports null rather than zero when an issue was never started', async () => {
    const id = await issueWithTimes('never started');
    const t = await timing(id);
    assert.equal(t.startedAt, null);
    assert.equal(t.timeToStartMs, null, 'an unstarted issue has no time-to-start');
    assert.equal(t.timeInProgressMs, null);
  });

  it('measures in-progress time up to resolution when still open', async () => {
    const created = new Date(Date.now() - 2 * DAY).toISOString();
    const started = new Date(Date.now() - 6 * HOUR).toISOString();
    const resolved = new Date(Date.now() - 2 * HOUR).toISOString();
    const id = await issueWithTimes('resolved an hour ago', {
      createdAt: created,
      startedAt: started,
      resolvedAt: resolved,
    });

    const t = await timing(id);
    assert.ok(t.timeInProgressMs !== null);
    assert.ok(
      Math.abs(t.timeInProgressMs - 4 * HOUR) < 60_000,
      `expected ~4h in progress, got ${t.timeInProgressMs}`,
    );
    assert.ok(t.timeToResolveMs !== null && t.timeToResolveMs > 0);
  });

  it('clamps a clock that runs backwards instead of reporting negative time', async () => {
    // Data imported from another system can carry a start later than its
    // resolution. A negative duration is never a useful thing to render.
    const created = new Date(Date.now() - 10 * DAY).toISOString();
    const started = new Date(Date.now() - 1 * DAY).toISOString();
    const resolved = new Date(Date.now() - 5 * DAY).toISOString();
    const id = await issueWithTimes('resolution precedes its start', {
      createdAt: created,
      startedAt: started,
      resolvedAt: resolved,
    });

    const t = await timing(id);
    assert.equal(t.timeInProgressMs, 0, 'negative in-progress time must clamp to 0');
    assert.ok((t.timeToStartMs ?? -1) >= 0);
  });
});

describe('overdue reporting', () => {
  it('reports no overdue figure when there is no due date', async () => {
    const id = await issueWithTimes('no deadline');
    const t = await timing(id);
    assert.equal(t.dueDate, null);
    assert.equal(t.overdueByMs, null, 'undated work cannot be overdue');
  });

  it('stops counting once the issue is resolved, even if it was late', async () => {
    // The regression this guards: a resolved issue kept accruing overdue time
    // forever, so a two-year-old closed ticket read as "overdue by 2 years".
    const due = new Date(Date.now() - 30 * DAY).toISOString();
    const resolved = new Date(Date.now() - 29 * DAY).toISOString();
    const id = await issueWithTimes('resolved after the deadline', {
      dueDate: due,
      resolvedAt: resolved,
    });

    const t = await timing(id);
    assert.ok(t.overdueByMs !== null);
    assert.ok(
      Math.abs(t.overdueByMs - DAY) < 60_000,
      `overdue should be measured to resolution (~1 day), got ${t.overdueByMs}`,
    );
  });

  it('reports zero overdue for something finished before its deadline', async () => {
    const due = new Date(Date.now() - 1 * DAY).toISOString();
    const resolved = new Date(Date.now() - 5 * DAY).toISOString();
    const id = await issueWithTimes('finished early', { dueDate: due, resolvedAt: resolved });

    const t = await timing(id);
    assert.equal(t.overdueByMs, 0, 'work delivered early is not overdue');
  });

  it('prefers the resolution time over the closure time for the overdue baseline', async () => {
    // Closing an issue weeks after resolving it should not inflate how late the
    // work actually was.
    const due = new Date(Date.now() - 10 * DAY).toISOString();
    const resolved = new Date(Date.now() - 9 * DAY).toISOString();
    const closed = new Date(Date.now() - 1 * DAY).toISOString();
    const id = await issueWithTimes('closed long after resolving', {
      dueDate: due,
      resolvedAt: resolved,
      closedAt: closed,
    });

    const t = await timing(id);
    assert.ok(t.overdueByMs !== null);
    assert.ok(
      Math.abs(t.overdueByMs - DAY) < 60_000,
      `overdue must stop at resolution (~1 day), got ${t.overdueByMs}`,
    );
  });

  it('keeps growing for an open issue past its deadline', async () => {
    const due = new Date(Date.now() - 2 * DAY).toISOString();
    const id = await issueWithTimes('still open and late', { dueDate: due });

    const t = await timing(id);
    assert.ok(t.overdueByMs !== null && t.overdueByMs > 2 * DAY - 60_000);
  });
});

describe('labels', () => {
  it('says an open issue is open and a finished one has lived', async () => {
    const resolved = new Date(Date.now() - 2 * DAY).toISOString();
    const id = await issueWithTimes('finished', { resolvedAt: resolved });

    const labels = harness.services.timing.describe(await timing(id));
    assert.match(labels.ageLabel, /^lived /);
    assert.match(labels.stageLabel, /^resolved after /);
  });

  it('reports an untouched issue as not started', async () => {
    const id = await issueWithTimes('untouched');
    const labels = harness.services.timing.describe(await timing(id));
    assert.equal(labels.stageLabel, 'not started');
    assert.equal(labels.overdueLabel, '', 'an on-time issue gets no overdue label');
  });

  it('surfaces an overdue label only when actually late', async () => {
    const due = new Date(Date.now() - 3 * DAY).toISOString();
    const late = await issueWithTimes('late', { dueDate: due });
    const onTime = await issueWithTimes('on time', { dueDate: new Date(Date.now() + 3 * DAY).toISOString() });

    assert.match(harness.services.timing.describe(await timing(late)).overdueLabel, /^overdue by /);
    assert.equal(harness.services.timing.describe(await timing(onTime)).overdueLabel, '');
  });
});

describe('sub-task rollup', () => {
  it('sums logged time across the whole sub-task tree', async () => {
    const root = await issueWithTimes('epic', { spentHours: 1 });
    const child = await issueWithTimes('child', { spentHours: 2, parentId: root });
    const grandchild = await issueWithTimes('grandchild', { spentHours: 4, parentId: child });

    const t = await timing(root);
    assert.equal(t.subtaskTimeSpentHours, 6, 'own 1 + child 2 + grandchild 4');

    // The child sees its own subtree, not its parent's.
    assert.equal((await timing(child)).subtaskTimeSpentHours, 4);
    assert.equal((await timing(grandchild)).subtaskTimeSpentHours, 0);
  });

  it('terminates instead of looping when the parent chain is a cycle', async () => {
    // A child has exactly one parent_id, so a node cannot be counted twice
    // through two parents. The real hazard is a cycle introduced by bad
    // imported data, which the recursive walk must survive. `UNION` (not
    // `UNION ALL`) is what makes the walk terminate.
    //
    // The issue service refuses to create a cycle; this bypasses it on purpose.
    // Note the rollup can re-reach the root through the cycle and so include
    // the root's own hours -- meaningless input, meaningless total. What is
    // guaranteed, and what this asserts, is that the walk terminates and
    // produces a finite number rather than hanging or growing without bound.
    const first = await issueWithTimes('cycle a', { spentHours: 1 });
    const second = await issueWithTimes('cycle b', { spentHours: 2, parentId: first });
    harness.db.run('UPDATE issues SET parent_id = ? WHERE id = ?', [second, first]);

    const entries = harness.services.timing.loadTimings([first, second]);
    assert.equal(entries.size, 2, 'both issues still resolve');

    const t = await timing(first);
    assert.ok(Number.isFinite(t.subtaskTimeSpentHours), 'a cycle must not produce a runaway total');
    assert.ok(t.subtaskTimeSpentHours <= 3, `cycle inflated the rollup to ${t.subtaskTimeSpentHours}`);
  });

  it('ignores orphaned issues that are not part of the requested tree', async () => {
    const root = await issueWithTimes('lonely root', { spentHours: 0 });
    const other = await issueWithTimes('other tree', { spentHours: 7 });
    await issueWithTimes('other child', { spentHours: 5, parentId: other });

    assert.equal((await timing(root)).subtaskTimeSpentHours, 0);
    assert.equal((await timing(other)).subtaskTimeSpentHours, 5);
  });
});

describe('batch computation', () => {
  it('returns one entry per requested issue and skips unknown ids', async () => {
    const a = await issueWithTimes('batch a');
    const b = await issueWithTimes('batch b');

    const all = await harness.services.timing.computeForIssues([a, b, 999_999]);
    assert.equal(all.size, 2, 'a missing issue is omitted, not invented');
    assert.ok(all.has(a) && all.has(b));
  });

  it('de-duplicates repeated ids', async () => {
    const a = await issueWithTimes('repeated');
    const all = await harness.services.timing.computeForIssues([a, a, a]);
    assert.equal(all.size, 1);
  });

  it('returns an empty map for no input rather than querying', async () => {
    assert.equal((await harness.services.timing.computeForIssues([])).size, 0);
    assert.equal((await harness.services.timing.computeForIssues([0, -1])).size, 0);
  });

  it('throws for a single unknown issue rather than returning a blank block', async () => {
    await assert.rejects(() => timing(999_999), /not found/i);
  });
});

describe('issue timeline', () => {
  it('pairs the activity stream with the computed durations', async () => {
    const id = await issueWithTimes('timeline subject', {
      createdAt: new Date(Date.now() - 4 * DAY).toISOString(),
      startedAt: new Date(Date.now() - 3 * DAY).toISOString(),
      resolvedAt: new Date(Date.now() - 1 * DAY).toISOString(),
    });

    const timeline = await harness.services.timing.issueTimeline(id);
    assert.equal(timeline.issueId, id);
    assert.ok(Array.isArray(timeline.events), 'a timeline always carries an event list');
    assert.ok(timeline.timing.timeToResolveMs !== null && timeline.timing.timeToResolveMs > 0);
    assert.ok(timeline.timing.ageMs > 3 * DAY);
  });

  it('rolls sub-task hours into the timeline total', async () => {
    const root = await issueWithTimes('timeline epic', { spentHours: 1 });
    await issueWithTimes('timeline child', { spentHours: 2.5, parentId: root });

    const timeline = await harness.services.timing.issueTimeline(root);
    assert.equal(timeline.timing.totalLoggedHours, 3.5);
  });

  it('honours an event limit', async () => {
    const id = await issueWithTimes('chatty issue');
    for (let i = 0; i < 5; i += 1) {
      harness.services.activity.record({
        issueId: id,
        projectId,
        actorId: userId,
        type: 'commented',
        summary: `comment ${i}`,
      });
    }

    const limited = await harness.services.timing.issueTimeline(id, { limit: 2 });
    assert.equal(limited.events.length, 2, 'the limit must be honoured');
  });

  it('throws for an unknown issue', async () => {
    await assert.rejects(() => harness.services.timing.issueTimeline(999_999), /not found/i);
  });
});
