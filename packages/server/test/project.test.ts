/**
 * Project service: creation, membership, labels, milestones and statistics.
 *
 * This is the one service that fans out across many tables on create, so the
 * cases here concentrate on the ways that can go wrong quietly: a project that
 * exists but is unusable, a member row pointing at nothing, two labels sharing
 * a slug, a milestone that cannot be reopened, and a statistics block whose
 * parts disagree with each other.
 *
 * Foreign keys are enforced, which means a bad reference surfaces as a raw
 * constraint violation. Several cases below assert that those are reported as
 * clean domain errors instead of 500s.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, insertUser, type TestHarness } from './helpers.ts';
import { slugify } from '../src/services/project.service.ts';

let harness: TestHarness;
let ownerId: number;

before(() => {
  harness = createHarness();
  ownerId = insertUser(harness, { username: 'projowner' });
});

after(() => {
  harness.close();
});

/** Create a project and return its id. */
function newProject(key: string, overrides: Record<string, unknown> = {}): number {
  const project = harness.services.projects.create(
    {
      key,
      name: `Test ${key}`,
      description: '',
      visibility: 'private',
      defaultIssueType: 'task',
      defaultPriority: 'medium',
      archivePolicy: null,
      ...overrides,
    } as never,
    ownerId,
    {},
  );
  return project.id as unknown as number;
}

describe('creation', () => {
  it('creates a project that is immediately usable', () => {
    const id = newProject('READY');
    const project = harness.services.projects.getById(id);

    assert.equal(project.key, 'READY');
    assert.equal(project.sourceOfTruth, 'local');
    assert.equal(project.nextIssueNumber, 1);

    // The creator is the owner, so control is retained without an invite step.
    const members = harness.services.projects.listMembers(id);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.userId, ownerId);
    assert.equal(members[0]?.role, 'owner');

    // A workflow and default labels must exist, or the board is empty forever.
    const workflow = harness.services.workflow.getForProject(id);
    assert.ok(workflow.statuses.length > 0, 'a new project needs statuses');
    assert.ok(harness.services.projects.listLabels(id).length > 0, 'a new project needs labels');
  });

  it('rejects a duplicate project key rather than shadowing the original', () => {
    newProject('UNIQ');
    assert.throws(() => newProject('UNIQ'), /already exists/i);
    assert.equal(
      harness.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE key = 'UNIQ'`)?.n,
      1,
      'the losing attempt must not leave a row behind',
    );
  });

  it('throws rather than returning a blank project for an unknown id', () => {
    assert.throws(() => harness.services.projects.getById(999_999), /not found/i);
    assert.equal(harness.services.projects.findByKey('NOPE'), null);
  });

  it('does not leave a half-created project when provisioning fails', () => {
    // The dashboard service is called outside the transaction on purpose. If
    // it throws, the project must still exist rather than vanish.
    const original = harness.services.dashboards.provisionDefaultDashboards;
    (harness.services.dashboards as unknown as Record<string, unknown>)['provisionDefaultDashboards'] = () => {
      throw new Error('dashboards unavailable');
    };
    try {
      const id = newProject('NODASH');
      assert.ok(id > 0, 'the project must survive a dashboard failure');
      assert.equal(harness.services.projects.findByKey('NODASH')?.key, 'NODASH');
    } finally {
      (harness.services.dashboards as unknown as Record<string, unknown>)['provisionDefaultDashboards'] =
        original;
    }
  });
});

describe('visibility', () => {
  it('shows a member their projects and everyone the public ones', () => {
    const privateId = newProject('HIDDEN');
    newProject('SHARED', { visibility: 'public' });

    const outsider = insertUser(harness, { username: 'outsider2' });
    const visible = harness.services.projects.listVisible({ isInstanceAdmin: false, userId: outsider });
    const keys = visible.map((p) => p.key);

    assert.ok(keys.includes('SHARED'), 'a public project is visible to non-members');
    assert.ok(!keys.includes('HIDDEN'), 'a private project must not leak to a non-member');
    assert.ok(!keys.includes('READY'), 'an unrelated private project must not leak');
    assert.ok(!keys.includes(String(privateId)));

    // The owner does see their own private project.
    const asOwner = harness.services.projects.listVisible({ isInstanceAdmin: false, userId: ownerId });
    assert.ok(asOwner.some((p) => p.key === 'HIDDEN'));
  });

  it('shows an instance admin everything', () => {
    const admin = insertUser(harness, { username: 'instadmin', instanceRole: 'admin' });
    const visible = harness.services.projects.listVisible({ isInstanceAdmin: true, userId: admin });
    assert.ok(visible.some((p) => p.key === 'HIDDEN'), 'an admin sees private projects');
  });
});

describe('membership', () => {
  let projectId: number;
  let memberId: number;

  before(() => {
    projectId = newProject('TEAM');
    memberId = insertUser(harness, { username: 'teammate' });
  });

  it('adds a member and records the change', () => {
    harness.services.projects.setMemberRole(projectId, memberId, 'developer', { actorId: ownerId });
    const roles = harness.services.projects.listMembers(projectId).map((m) => [m.userId, m.role]);
    assert.ok(roles.some(([id, role]) => id === memberId && role === 'developer'));
    assert.ok(harness.services.projects.projectIdsForUser(memberId).includes(projectId));
  });

  it('reports an unknown user as not found rather than a constraint failure', () => {
    // The FK on project_members.user_id means the INSERT would otherwise
    // surface as an opaque 500 instead of a 404.
    assert.throws(
      () => harness.services.projects.setMemberRole(projectId, 999_999, 'viewer', { actorId: ownerId }),
      /not found/i,
    );
    assert.equal(
      harness.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND user_id = 999_999',
        [projectId],
      )?.n,
      0,
      'no phantom member may survive a rejected add',
    );
  });

  it('refuses to grant a role that outranks the actor', () => {
    assert.throws(
      () =>
        harness.services.projects.setMemberRole(projectId, memberId, 'owner', {
          actorId: ownerId,
          actorRole: 'admin',
        }),
      /outranks you/i,
    );
  });

  it('refuses to change the role of someone who outranks the actor', () => {
    harness.services.projects.setMemberRole(projectId, memberId, 'owner', {
      actorId: ownerId,
      actorRole: 'owner',
    });
    assert.throws(
      () =>
        harness.services.projects.setMemberRole(projectId, memberId, 'viewer', {
          actorId: ownerId,
          actorRole: 'maintainer',
        }),
      /outranks you/i,
    );
  });

  it('refuses to remove the last owner, which would orphan the project', () => {
    // Its own project: the test above promotes a second owner, and owner
    // counts are per project.
    const solo = newProject('SOLO');
    assert.throws(
      () => harness.services.projects.removeMember(solo, ownerId, { actorId: ownerId }),
      /at least one owner/i,
    );
    assert.ok(
      harness.services.projects.listMembers(solo).some((m) => m.userId === ownerId),
      'the owner must still be a member',
    );
  });

  it('allows removing an owner once a second one exists', () => {
    const shared = newProject('TWOWNERS');
    const second = insertUser(harness, { username: 'secondowner' });
    harness.services.projects.setMemberRole(shared, second, 'owner', { actorId: ownerId, actorRole: 'owner' });

    harness.services.projects.removeMember(shared, second, { actorId: ownerId });
    const members = harness.services.projects.listMembers(shared);
    assert.ok(!members.some((m) => m.userId === second));
    assert.equal(members.length, 1);
    assert.equal(members[0]?.userId, ownerId);
  });

  it('reports removing a non-member as not found', () => {
    assert.throws(
      () => harness.services.projects.removeMember(projectId, 999_999, { actorId: ownerId }),
      /not found/i,
    );
  });
});

describe('labels', () => {
  let projectId: number;

  before(() => {
    projectId = newProject('LABELS');
  });

  it('creates a label with a slug derived from its name', () => {
    const label = harness.services.projects.createLabel(
      projectId,
      { name: 'Needs Review', color: '#123456', description: '' },
      { actorId: ownerId },
    );
    assert.equal(label.slug, 'needs-review');
    assert.equal(label.color, '#123456');
  });

  it('rejects two labels in one project that slug to the same value', () => {
    harness.services.projects.createLabel(
      projectId,
      { name: 'Duplicate Source', color: '#111111', description: '' },
      { actorId: ownerId },
    );
    assert.throws(
      () =>
        harness.services.projects.createLabel(
          projectId,
          { name: 'duplicate  source!', color: '#222222', description: '' },
          { actorId: ownerId },
        ),
      /already exists/i,
    );
  });

  it('reports a rename collision as a conflict, not a constraint crash', () => {
    // Renaming re-slugs the row. The unique index then rejects it, and unless
    // the service catches that the caller gets an opaque 500 from SQLite.
    const first = harness.services.projects.createLabel(
      projectId,
      { name: 'Rename Target', color: '#333333', description: '' },
      { actorId: ownerId },
    );
    const second = harness.services.projects.createLabel(
      projectId,
      { name: 'Rename Source', color: '#444444', description: '' },
      { actorId: ownerId },
    );

    assert.throws(
      () => harness.services.projects.updateLabel(projectId, second.id, { name: 'Rename Target' }, { actorId: ownerId }),
      /already exists/i,
      'a rename onto an existing label name must be a clean conflict',
    );
    assert.equal(
      harness.services.projects.listLabels(projectId).find((l) => l.id === second.id)?.name,
      'Rename Source',
      'the rejected rename must not have been applied',
    );
    assert.ok(first.id > 0);
  });

  it('keeps instance-wide labels separate from project labels', () => {
    harness.db.run(`INSERT INTO labels (project_id, name, slug, color) VALUES (NULL,'Severity','severity','#555555')`);
    const labels = harness.services.projects.listLabels(projectId);
    assert.ok(labels.some((l) => l.slug === 'severity'), 'instance labels are included in the list');
    assert.equal(
      harness.services.projects.listLabels(projectId).filter((l) => l.slug === 'severity').length,
      1,
      'the instance label must appear exactly once',
    );
  });

  it('detaches labels from issues when one is deleted', async () => {
    const created = await harness.services.issues.create(
      projectId,
      { title: 'labelled issue', description: '', type: 'task', priority: 'medium' },
      ownerId,
      {},
    );
    const issue = created.issue;
    const label = harness.services.projects.createLabel(
      projectId,
      { name: 'Temporary', color: '#666666', description: '' },
      { actorId: ownerId },
    );
    harness.db.run('INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)', [issue.id, label.id]);

    harness.services.projects.removeLabel(projectId, label.id, { actorId: ownerId });
    assert.equal(
      harness.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issue_labels WHERE label_id = ?', [label.id])?.n,
      0,
      'the join rows must not outlive the label',
    );
    assert.ok(harness.services.issues.getById(issue.id), 'the issue itself must survive');
  });

  it('will not touch a label belonging to another project', () => {
    const other = newProject('OTHERLABELS');
    const theirs = harness.services.projects.createLabel(
      other,
      { name: 'Theirs', color: '#777777', description: '' },
      { actorId: ownerId },
    );
    assert.throws(
      () => harness.services.projects.updateLabel(projectId, theirs.id, { name: 'Hijacked' }, { actorId: ownerId }),
      /not found/i,
    );
    assert.equal(
      harness.services.projects.listLabels(other).find((l) => l.id === theirs.id)?.name,
      'Theirs',
    );
  });
});

describe('slugify', () => {
  it('produces a url-safe slug', () => {
    assert.equal(slugify('Good first issue'), 'good-first-issue');
    assert.equal(slugify('  Spaced  Out  '), 'spaced-out');
    assert.equal(slugify('a/b\\c:d'), 'a-b-c-d');
  });

  it('never leaves a trailing dash after truncating', () => {
    // Truncation happens after the separators are collapsed, so a long name can
    // be cut mid-token and leave a dangling dash that no longer round-trips.
    const name = 'a'.repeat(59) + ' tail end';
    const slug = slugify(name);
    assert.equal(slug.length <= 60, true);
    assert.ok(!slug.endsWith('-'), `slug ended with a dash: "${slug}"`);
  });
});

describe('milestones', () => {
  let projectId: number;

  before(() => {
    projectId = newProject('MILES');
  });

  it('creates a milestone', () => {
    const milestone = harness.services.projects.createMilestone(
      projectId,
      { title: 'v1', description: 'first cut', state: 'planned', dueDate: null, startDate: null },
      { actorId: ownerId },
    );
    assert.equal(milestone.title, 'v1');
    assert.equal(milestone.state, 'planned');
    assert.equal(milestone.closedAt, null);
  });

  it('stamps closed_at when a milestone closes', () => {
    const milestone = harness.services.projects.createMilestone(
      projectId,
      { title: 'v2', description: '', state: 'planned', dueDate: null, startDate: null },
      { actorId: ownerId },
    );
    const closed = harness.services.projects.updateMilestone(projectId, milestone.id, { state: 'closed' }, { actorId: ownerId });
    assert.equal(closed.state, 'closed');
    assert.ok(closed.closedAt !== null, 'closing must stamp the closure time');
  });

  it('clears closed_at when a closed milestone is reopened', () => {
    // Otherwise a reopened milestone still reports the old closure time, and
    // "time to close" is measured from a moment it was not closed.
    const milestone = harness.services.projects.createMilestone(
      projectId,
      { title: 'v3', description: '', state: 'planned', dueDate: null, startDate: null },
      { actorId: ownerId },
    );
    harness.services.projects.updateMilestone(projectId, milestone.id, { state: 'closed' }, { actorId: ownerId });
    const reopened = harness.services.projects.updateMilestone(
      projectId,
      milestone.id,
      { state: 'active' },
      { actorId: ownerId },
    );
    assert.equal(reopened.state, 'active');
    assert.equal(reopened.closedAt, null, 'a reopened milestone must forget when it was closed');
  });

  it('sorts undated milestones last', () => {
    harness.services.projects.createMilestone(
      projectId,
      { title: 'undated', description: '', state: 'planned', dueDate: null, startDate: null },
      { actorId: ownerId },
    );
    harness.services.projects.createMilestone(
      projectId,
      { title: 'dated', description: '', state: 'planned', dueDate: '2999-01-01T00:00:00.000Z', startDate: null },
      { actorId: ownerId },
    );
    const list = harness.services.projects.listMilestones(projectId);
    assert.equal(list[list.length - 1]?.title, 'undated', 'an undated milestone sorts last');
  });

  it('will not touch a milestone in another project', () => {
    const other = newProject('OTHERMILES');
    const theirs = harness.services.projects.createMilestone(
      other,
      { title: 'not yours', description: '', state: 'planned', dueDate: null, startDate: null },
      { actorId: ownerId },
    );
    // Addressed to the wrong project: the row exists, but not there.
    assert.throws(
      () => harness.services.projects.updateMilestone(projectId, theirs.id, { title: 'hijacked' }, { actorId: ownerId }),
      /not found/i,
    );
    assert.throws(
      () => harness.services.projects.removeMilestone(projectId, theirs.id, { actorId: ownerId }),
      /not found/i,
    );
    assert.equal(
      harness.services.projects.listMilestones(other).find((m) => m.id === theirs.id)?.title,
      'not yours',
    );
  });
});

describe('statistics', () => {
  let projectId: number;
  let openId: number;
  let closedId: number;

  before(async () => {
    projectId = newProject('STATS');

    const closed = await harness.services.issues.create(
      projectId,
      { title: 'done', description: '', type: 'task', priority: 'high' },
      ownerId,
      {},
    );
    closedId = closed.issue.id;
    openId = (
      await harness.services.issues.create(
        projectId,
        { title: 'open one', description: '', type: 'bug', priority: 'low' },
        ownerId,
        {},
      )
    ).issue.id;

    // Closed directly in SQL: the default workflow requires a four-step path
    // to `closed`, and this suite is about how statistics read the rows, not
    // about the transition rules (which workflow.test.ts covers).
    harness.db.run(`UPDATE issues SET state = 'closed' WHERE id = ?`, [closedId]);
  });

  it('counts total, open and closed consistently', () => {
    const stats = harness.services.projects.stats(projectId);
    assert.equal(stats.totalIssues, 2);
    assert.equal(stats.openIssues + stats.closedIssues <= stats.totalIssues, true);
    assert.equal(stats.memberCount, 1);
  });

  it('excludes archived issues from the grouped breakdowns', () => {
    harness.db.run('UPDATE issues SET archived = 1 WHERE id = ?', [openId]);
    try {
      const stats = harness.services.projects.stats(projectId);
      assert.equal(
        stats.issuesByState.reduce((sum, g) => sum + g.count, 0),
        stats.totalIssues - stats.archivedIssues,
        'the grouped breakdown must account for every unarchived issue',
      );
    } finally {
      harness.db.run('UPDATE issues SET archived = 0 WHERE id = ?', [openId]);
    }
  });

  it('does not report a long-finished issue as overdue', () => {
    // An issue delivered a year ago with a past due date is not "overdue" --
    // it was late once and is now done. Counting it makes the project look
    // permanently in breach and contradicts the timing service, which
    // measures overdue to resolution.
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    harness.db.run('UPDATE issues SET due_date = ?, resolved_at = ?, closed_at = ? WHERE id = ?', [
      past,
      past,
      past,
      closedId,
    ]);
    try {
      const stats = harness.services.projects.stats(projectId);
      assert.equal(stats.overdueIssues, 0, 'a resolved issue must not keep counting as overdue');
    } finally {
      harness.db.run('UPDATE issues SET due_date = NULL WHERE id = ?', [closedId]);
    }
  });

  it('does not count an archived issue as overdue', () => {
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    harness.db.run('UPDATE issues SET due_date = ?, archived = 1 WHERE id = ?', [past, openId]);
    try {
      const stats = harness.services.projects.stats(projectId);
      assert.equal(stats.overdueIssues, 0, 'an archived issue is out of the live board');
    } finally {
      harness.db.run('UPDATE issues SET due_date = NULL, archived = 0 WHERE id = ?', [openId]);
    }
  });

  it('still counts a genuinely late open issue', () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    harness.db.run('UPDATE issues SET due_date = ? WHERE id = ?', [past, openId]);
    try {
      assert.equal(harness.services.projects.stats(projectId).overdueIssues, 1);
    } finally {
      harness.db.run('UPDATE issues SET due_date = NULL WHERE id = ?', [openId]);
    }
  });
});
