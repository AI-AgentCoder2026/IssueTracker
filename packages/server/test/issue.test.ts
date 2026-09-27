/**
 * Issue lifecycle: sequencing, hierarchy cycles, dependencies, concurrency and
 * the board projection.
 *
 * `IssueService.create` is async (it awaits duplicate detection), so every
 * helper here returns a promise and every call site awaits it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, createProject, statusId, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;
let otherUserId: number;

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'reporter' });
  otherUserId = insertUser(harness, { username: 'dev' });
  projectId = createProject(harness, userId, 'ISS');
  harness.db.run('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,?)', [
    projectId,
    otherUserId,
    'developer',
  ]);
});

after(() => harness.close());

/** Create an issue in the shared project and return it. */
async function newIssue(title: string, overrides: Record<string, unknown> = {}) {
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'task', priority: 'medium', ...overrides },
    userId,
    {},
  );
  return result.issue;
}

describe('creation', () => {
  it('allocates sequential keys scoped to the project', async () => {
    const first = await newIssue('first');
    const second = await newIssue('second');

    assert.match(first.key, /^ISS-\d+$/);
    assert.match(second.key, /^ISS-\d+$/);

    const firstNumber = Number(first.key.split('-')[1]);
    const secondNumber = Number(second.key.split('-')[1]);
    assert.equal(secondNumber, firstNumber + 1, 'issue numbers must be contiguous');
  });

  it('scopes the sequence per project, not globally', async () => {
    const otherOwner = insertUser(harness, { username: 'seqowner' });
    const otherProject = createProject(harness, otherOwner, 'SEQ');

    const inFirst = await newIssue('sequence in first');
    const second = await harness.services.issues.create(
      otherProject,
      { title: 'sequence in second', description: '', type: 'task', priority: 'medium' },
      otherOwner,
      {},
    );

    // A brand-new project starts its own sequence at 1, proving the counter is
    // per project rather than global.
    assert.equal(second.issue.key, 'SEQ-1');
    assert.ok(
      Number(inFirst.key.split('-')[1]) > 1,
      'the first project keeps incrementing independently',
    );
  });

  it('defaults to a status matching the project workflow', async () => {
    const issue = await newIssue('default status');
    const statuses = harness.services.workflow.statusesForProject(projectId);
    const current = statuses.find((status) => status.id === Number(issue.statusId));

    assert.ok(current, 'the issue must point at a real status');
    assert.equal(current?.category, 'unstarted', 'new issues start unstarted');
  });

  it('rejects a status from another project', async () => {
    const otherOwner = insertUser(harness, { username: 'xproj' });
    const otherProject = createProject(harness, otherOwner, 'XPROJ');
    const foreignStatus = statusId(harness, otherProject, 'open');

    await assert.rejects(
      async () => await newIssue('foreign status', { statusId: foreignStatus }),
      /does not belong to this project/,
    );
  });

  it('reports duplicate candidates without blocking creation', async () => {
    await newIssue('Login button does nothing on Safari');
    const result = await harness.services.issues.create(
      projectId,
      { title: 'Login button does nothing on safari', description: '', type: 'bug', priority: 'medium' },
      userId,
      {},
    );

    assert.ok(result.issue.id, 'the issue is still created');
    assert.ok(Array.isArray(result.duplicateCandidates));
  });

  it('writes an activity event and an audit entry', async () => {
    const issue = await newIssue('audited creation');

    const events = harness.services.activity.forIssue(issue.id, { types: ['issue.created'] });
    assert.equal(events.length, 1);

    // `entity_id` is a TEXT column, so bind a string or SQLite's type affinity
    // silently fails to match it.
    const audit = harness.db.get<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_type = 'issue' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [String(issue.id)],
    );
    assert.equal(audit?.action, 'issue.created');
  });
});

describe('hierarchy', () => {
  it('nests a child under a parent', async () => {
    const parent = await newIssue('parent');
    const child = await newIssue('child', { parentId: parent.id });

    const children = harness.services.issues.children(parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]?.id, child.id);

    const ancestors = harness.services.issues.ancestors(child.id);
    assert.deepEqual(
      ancestors.map((issue) => issue.id),
      [parent.id],
    );
  });

  it('refuses to make an issue its own parent', async () => {
    const issue = await newIssue('self parent');
    assert.throws(
      () => harness.services.issues.update(issue.id, { parentId: issue.id }, userId, {}),
      /own parent/,
    );
  });

  it('refuses to create a nesting cycle', async () => {
    const root = await newIssue('cycle root');
    const middle = await newIssue('cycle middle', { parentId: root.id });
    const leaf = await newIssue('cycle leaf', { parentId: middle.id });

    // Making the root a child of its own grandchild closes the loop.
    assert.throws(
      () => harness.services.issues.update(root.id, { parentId: leaf.id }, userId, {}),
      /own ancestor/,
    );
  });

  it('refuses a parent from another project', async () => {
    const otherOwner = insertUser(harness, { username: 'howner' });
    const otherProject = createProject(harness, otherOwner, 'HPROJ');
    const foreign = (
      await harness.services.issues.create(
        otherProject,
        { title: 'foreign parent', description: '', type: 'task', priority: 'medium' },
        otherOwner,
        {},
      )
    ).issue;

    const local = await newIssue('local child');
    assert.throws(
      () => harness.services.issues.update(local.id, { parentId: foreign.id }, userId, {}),
      /same project/,
    );
  });

  it('refuses to delete an issue that still has sub-tasks', async () => {
    const parent = await newIssue('has children');
    await newIssue('child a', { parentId: parent.id });

    assert.throws(() => harness.services.issues.remove(parent.id, userId, {}), /sub-task/);
  });
});

describe('dependencies', () => {
  it('creates a link and resolves it in both directions', async () => {
    const source = await newIssue('blocks target');
    const target = await newIssue('is blocked');

    const link = harness.services.issues.link(source.id, target.id, 'blocks', userId, {});

    const fromSource = harness.services.issues.links(source.id);
    const fromTarget = harness.services.issues.links(target.id);

    assert.equal(fromSource.length, 1);
    assert.equal(fromTarget.length, 1, 'the reverse edge is derived, not stored twice');
    assert.equal(fromSource[0]?.direction, 'outgoing');
    assert.equal(fromTarget[0]?.direction, 'incoming');
    assert.equal(fromTarget[0]?.id, link.id, 'both views see the same row');
  });

  it('refuses a self-link', async () => {
    const issue = await newIssue('self link');
    assert.throws(
      () => harness.services.issues.link(issue.id, issue.id, 'relates_to', userId, {}),
      /depend on itself/,
    );
  });

  it('refuses a duplicate link of the same kind', async () => {
    const a = await newIssue('dup link a');
    const b = await newIssue('dup link b');
    harness.services.issues.link(a.id, b.id, 'relates_to', userId, {});

    assert.throws(
      () => harness.services.issues.link(a.id, b.id, 'relates_to', userId, {}),
      /already linked/,
    );
  });

  it('allows different kinds between the same pair', async () => {
    const a = await newIssue('multi a');
    const b = await newIssue('multi b');
    harness.services.issues.link(a.id, b.id, 'relates_to', userId, {});
    const second = harness.services.issues.link(a.id, b.id, 'duplicates', userId, {});

    assert.ok(second.id);
    assert.equal(harness.services.issues.links(a.id).length, 2);
  });

  it('refuses a link that would deadlock the blocking graph', async () => {
    const a = await newIssue('block cycle a');
    const b = await newIssue('block cycle b');
    const c = await newIssue('block cycle c');

    harness.services.issues.link(a.id, b.id, 'blocks', userId, {});
    harness.services.issues.link(b.id, c.id, 'blocks', userId, {});

    // c -> a would close a -> b -> c -> a.
    assert.throws(
      () => harness.services.issues.link(c.id, a.id, 'blocks', userId, {}),
      /circular dependency/,
    );
  });

  it('does not treat a non-blocking link as a cycle', async () => {
    const a = await newIssue('relates cycle a');
    const b = await newIssue('relates cycle b');

    harness.services.issues.link(a.id, b.id, 'relates_to', userId, {});
    // A "relates to" edge in the opposite direction is harmless.
    const reverse = harness.services.issues.link(b.id, a.id, 'relates_to', userId, {});
    assert.ok(reverse.id);
  });

  it('removes a link', async () => {
    const a = await newIssue('unlink a');
    const b = await newIssue('unlink b');
    const link = harness.services.issues.link(a.id, b.id, 'relates_to', userId, {});

    harness.services.issues.unlink(a.id, link.id, userId, {});
    assert.equal(harness.services.issues.links(a.id).length, 0);
  });
});

describe('updates', () => {
  it('accumulates logged time rather than overwriting it', async () => {
    const issue = await newIssue('time logging');
    harness.services.issues.update(issue.id, { timeSpentHours: 2 }, userId, {});
    const after = harness.services.issues.update(issue.id, { timeSpentHours: 1.5 }, userId, {});

    assert.equal(after.timeSpentHours, 3.5);
  });

  it('rejects a stale expectedVersion', async () => {
    const issue = await newIssue('stale write');
    const stale = issue.version;

    harness.services.issues.update(issue.id, { title: 'first write' }, userId, {});

    assert.throws(
      () => harness.services.issues.update(issue.id, { title: 'second write', expectedVersion: stale }, userId, {}),
      /modified by someone else/,
    );
  });

  it('bumps the version on every write', async () => {
    const issue = await newIssue('version bump');
    const updated = harness.services.issues.update(issue.id, { title: 'renamed' }, userId, {});
    assert.equal(updated.version, issue.version + 1);
  });

  it('records which fields changed', async () => {
    const issue = await newIssue('change summary');
    harness.services.issues.update(issue.id, { priority: 'highest' }, userId, {});

    const events = harness.services.activity.forIssue(issue.id, { types: ['issue.updated'] });
    assert.ok(events.length > 0);
    assert.match(events[0]?.summary ?? '', /priority/);
  });

  it('does not record an event when nothing changed', async () => {
    const issue = await newIssue('no-op update');
    const before = harness.services.activity.forIssue(issue.id).length;

    harness.services.issues.update(issue.id, { title: issue.title }, userId, {});
    const after = harness.services.activity.forIssue(issue.id).length;

    assert.equal(after, before, 'a no-op write must not spam the timeline');
  });

  it('notifies a new assignee but not the actor', async () => {
    const issue = await newIssue('assignment notification');
    harness.services.issues.update(issue.id, { assigneeId: otherUserId }, userId, {});

    const { notifications } = harness.services.notifications.listForUser(otherUserId, { limit: 50 });
    assert.ok(
      notifications.some((notification) => notification.issueId === issue.id),
      'the assignee is notified',
    );

    const { notifications: actorNotifications } = harness.services.notifications.listForUser(userId, {
      limit: 50,
    });
    assert.ok(
      !actorNotifications.some(
        (notification) => notification.issueId === issue.id && notification.event === 'issue.assigned',
      ),
      'the actor is not notified of their own assignment',
    );
  });
});

describe('archive', () => {
  it('archives and restores, keeping both timestamps consistent', async () => {
    const issue = await newIssue('archivable');

    const archived = harness.services.issues.setArchived(issue.id, true, userId, {});
    assert.equal(archived.archived, true);
    assert.ok(archived.archivedAt);

    const restored = harness.services.issues.setArchived(issue.id, false, userId, {});
    assert.equal(restored.archived, false);
    assert.equal(restored.archivedAt, null);
  });
});

describe('board', () => {
  it('places every issue in the column matching its status', async () => {
    const boardProject = createProject(harness, userId, 'BOARD');
    const inProgress = statusId(harness, boardProject, 'in_progress');

    const card = (
      await harness.services.issues.create(
        boardProject,
        { title: 'board card', description: '', type: 'task', priority: 'medium', statusId: inProgress },
        userId,
        {},
      )
    ).issue;

    const board = harness.services.issues.board(boardProject);
    const column = board.columns.find((candidate) => candidate.statusId === inProgress);

    assert.ok(column, 'the status must have a column');
    assert.ok(
      column?.issues.some((issue) => issue.id === card.id),
      'the card must be in its status column',
    );
  });

  it('gives a board column to every workflow status, even an empty one', () => {
    const boardProject = createProject(harness, userId, 'BOARD2');
    const board = harness.services.issues.board(boardProject);
    const statusCount = harness.services.workflow.statusesForProject(boardProject).length;

    assert.equal(board.columns.length, statusCount);
  });

  it('moves a card and reorders it fractionally', async () => {
    const boardProject = createProject(harness, userId, 'MOVE');
    const open = statusId(harness, boardProject, 'open');

    const a = (
      await harness.services.issues.create(
        boardProject,
        { title: 'move a', description: '', type: 'task', priority: 'medium', statusId: open },
        userId,
        {},
      )
    ).issue;
    const b = (
      await harness.services.issues.create(
        boardProject,
        { title: 'move b', description: '', type: 'task', priority: 'medium', statusId: open },
        userId,
        {},
      )
    ).issue;
    const c = (
      await harness.services.issues.create(
        boardProject,
        { title: 'move c', description: '', type: 'task', priority: 'medium', statusId: open },
        userId,
        {},
      )
    ).issue;

    // Drop `a` between `b` and `c`.
    const board = harness.services.issues.moveOnBoard({
      issueId: a.id,
      toStatusId: open,
      beforeIssueId: b.id,
      afterIssueId: c.id,
      actorId: userId,
    });

    const column = board.columns.find((candidate) => candidate.statusId === open);
    const order = (column?.issues ?? []).map((issue) => issue.id);
    assert.deepEqual(order, [b.id, a.id, c.id], 'the card lands between its neighbours');
  });

  it('moves a card to another column and updates its state', async () => {
    const boardProject = createProject(harness, userId, 'XCOL');
    const open = statusId(harness, boardProject, 'open');
    const inProgress = statusId(harness, boardProject, 'in_progress');

    const card = (
      await harness.services.issues.create(
        boardProject,
        { title: 'cross column', description: '', type: 'task', priority: 'medium', statusId: open },
        userId,
      )
    ).issue;

    harness.services.issues.moveOnBoard({
      issueId: card.id,
      toStatusId: inProgress,
      beforeIssueId: null,
      afterIssueId: null,
      actorId: userId,
    });

    const updated = harness.services.issues.getById(card.id);
    assert.equal(Number(updated.statusId), inProgress);
    assert.equal(updated.state, 'in_progress');
  });

  it('rejects a move that the workflow forbids', async () => {
    const boardProject = createProject(harness, userId, 'BADMOVE');
    const backlog = statusId(harness, boardProject, 'backlog');
    const inReview = statusId(harness, boardProject, 'in_review');

    const card = (
      await harness.services.issues.create(
        boardProject,
        { title: 'illegal move', description: '', type: 'task', priority: 'medium', statusId: backlog },
        userId,
      )
    ).issue;

    assert.throws(
      () =>
        harness.services.issues.moveOnBoard({
          issueId: card.id,
          toStatusId: inReview,
          beforeIssueId: null,
          afterIssueId: null,
          actorId: userId,
        }),
      /cannot move directly|cannot/i,
    );
  });

  it('excludes archived issues from the board', async () => {
    const boardProject = createProject(harness, userId, 'ARCH');
    const open = statusId(harness, boardProject, 'open');

    const card = (
      await harness.services.issues.create(
        boardProject,
        { title: 'archived card', description: '', type: 'task', priority: 'medium', statusId: open },
        userId,
      )
    ).issue;

    harness.services.issues.setArchived(card.id, true, userId, {});
    const board = harness.services.issues.board(boardProject);
    const column = board.columns.find((candidate) => candidate.statusId === open);

    assert.ok(
      !(column?.issues ?? []).some((issue) => issue.id === card.id),
      'an archived card must not appear on the board',
    );
  });
});

describe('summaries', () => {
  it('computes counts in the batch projection', async () => {
    const summaryProject = createProject(harness, userId, 'SUM');
    const issue = (
      await harness.services.issues.create(
        summaryProject,
        { title: 'has comments', description: '', type: 'bug', priority: 'high' },
        userId,
      )
    ).issue;

    await harness.services.issues.create(
      summaryProject,
      { title: 'a child', description: '', type: 'task', priority: 'medium', parentId: issue.id },
      userId,
    );
    harness.services.comments.create(issue.id, { body: 'a comment' }, userId, { silent: true });

    const summary = harness.services.issues.summary(issue.id);
    assert.equal(summary.commentCount, 1);
    assert.equal(summary.subtaskCount, 1);
    assert.equal(summary.attachmentCount, 0);
  });

  it('flags an overdue issue', async () => {
    const overdueProject = createProject(harness, userId, 'DUE');
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const overdue = (
      await harness.services.issues.create(
        overdueProject,
        { title: 'overdue', description: '', type: 'task', priority: 'medium', dueDate: past },
        userId,
      )
    ).issue;
    const onTime = (
      await harness.services.issues.create(
        overdueProject,
        { title: 'on time', description: '', type: 'task', priority: 'medium', dueDate: future },
        userId,
      )
    ).issue;

    assert.equal(harness.services.issues.summary(overdue.id).isOverdue, true);
    assert.equal(harness.services.issues.summary(onTime.id).isOverdue, false);
  });
});
