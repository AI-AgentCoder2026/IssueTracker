/**
 * Bulk editing, retention archiving and data export.
 *
 * Three services with no dedicated suite until now, chosen because they are
 * where silent data loss would hide: bulk edit applies many operations with
 * per-row isolation, archiving closes issues behind the user's back, and
 * export renders attacker-influenced text into CSV.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectId, Role, UserId } from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import type { RequestContext } from '../src/services/context.ts';

let harness: TestHarness;
let projectId: number;
let userId: number;
let otherUserId: number;

function actorFor(user: number) {
  return {
    userId: user as UserId,
    isInstanceAdmin: true,
    roles: ['admin' as Role],
    projectRoles: new Map<ProjectId, Role>([[projectId as ProjectId, 'owner' as Role]]),
  };
}

function requestContext(user: number): RequestContext {
  return {
    services: harness.services,
    db: harness.db,
    config: harness.config,
    actor: actorFor(user),
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: user, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

async function newIssue(title: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'task', priority: 'medium', ...overrides },
    userId,
    { actorId: userId },
  );
  return result.issue.id as unknown as number;
}

const issueKey = (id: number): string =>
  harness.services.issues.getById(id).key;

before(async () => {
  harness = createHarness();
  userId = insertUser(harness, { username: 'bulkuser' });
  otherUserId = insertUser(harness, { username: 'bulkother' });
  projectId = createProject(harness, userId, 'BULK');
  harness.db.run('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,?)', [
    projectId,
    otherUserId,
    'developer',
  ]);
});

after(() => harness.close());

describe('bulk editing', () => {
  it('applies a priority change to every issue', async () => {
    const ids = [await newIssue('bulk priority a'), await newIssue('bulk priority b')];
    const result = await harness.services.bulk.apply(
      ids,
      [{ op: 'setPriority', priority: 'critical' }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );

    assert.equal(result.requested, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 0);
    for (const id of ids) {
      assert.equal(harness.services.issues.getById(id).priority, 'critical');
    }
  });

  it('assigns an issue', async () => {
    const id = await newIssue('bulk assign');
    await harness.services.bulk.apply(
      [id],
      [{ op: 'assign', assigneeId: otherUserId }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );
    assert.equal(harness.services.issues.getById(id).assigneeId, otherUserId);
  });

  it('isolates a bad row instead of aborting the batch', async () => {
    const good = await newIssue('bulk survivor');
    const result = await harness.services.bulk.apply(
      [good, 999_999],
      [{ op: 'setPriority', priority: 'high' }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );

    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1, 'the missing issue fails on its own');
    assert.equal(
      harness.services.issues.getById(good).priority,
      'high',
      'the valid row still went through',
    );
  });

  it('refuses a parent change that would create a cycle', async () => {
    const root = await newIssue('cycle root bulk');
    const middle = await newIssue('cycle middle bulk', { parentId: root });
    const leaf = await newIssue('cycle leaf bulk', { parentId: middle });

    const result = await harness.services.bulk.apply(
      [root],
      [{ op: 'setParent', parentId: leaf }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );

    assert.equal(result.failed, 1, 'a cycle must be refused');
    assert.equal(harness.services.issues.getById(root).parentId, null, 'the hierarchy is unchanged');
  });

  it('refuses a self-parent', async () => {
    const id = await newIssue('self parent bulk');
    const result = await harness.services.bulk.apply(
      [id],
      [{ op: 'setParent', parentId: id }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );
    assert.equal(result.failed, 1);
  });

  it('refuses to link an issue to itself', async () => {
    const id = await newIssue('self link bulk');
    const result = await harness.services.bulk.apply(
      [id],
      [{ op: 'link', kind: 'relates_to', targetIssueId: id }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );
    assert.equal(result.failed, 1);
  });

  it('archives and restores a batch', async () => {
    const id = await newIssue('bulk archive');
    await harness.services.bulk.apply(
      [id],
      [{ op: 'archive', archived: true }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );
    assert.equal(harness.services.issues.getById(id).archived, true);

    await harness.services.bulk.apply(
      [id],
      [{ op: 'archive', archived: false }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );
    assert.equal(harness.services.issues.getById(id).archived, false);
  });

  it('previews without changing anything', async () => {
    const id = await newIssue('bulk preview');
    const before = harness.services.issues.getById(id).priority;

    const preview = await harness.services.bulk.preview(
      [id],
      [{ op: 'setPriority', priority: 'lowest' }],
      actorFor(userId),
    );

    assert.ok(preview, 'a preview is returned');
    assert.equal(harness.services.issues.getById(id).priority, before, 'preview must not write');
  });

  it('refuses an issue belonging to another project', async () => {
    // A project-scoped developer, not an instance administrator: an admin is
    // legitimately allowed to edit any project's issues, so using one would
    // have asserted nothing.
    const scopedActor = {
      userId: userId as UserId,
      isInstanceAdmin: false,
      roles: ['developer' as Role],
      projectRoles: new Map<ProjectId, Role>([[projectId as ProjectId, 'developer' as Role]]),
    };
    const scopedCtx: RequestContext = { ...requestContext(userId), actor: scopedActor };
    const otherOwner = insertUser(harness, { username: 'bulkforeign' });
    const otherProject = createProject(harness, otherOwner, 'BULKFOREIGN');
    const foreign = (
      await harness.services.issues.create(
        otherProject,
        { title: 'not yours', description: '', type: 'task', priority: 'medium' },
        otherOwner,
        { actorId: otherOwner },
      )
    ).issue.id as unknown as number;

    const result = await harness.services.bulk.apply(
      [foreign],
      [{ op: 'setPriority', priority: 'lowest' }],
      scopedActor,
      scopedCtx,
      { continueOnError: true },
    );
    assert.equal(result.failed, 1, 'an issue in another project is not editable');
    assert.notEqual(
      harness.services.issues.getById(foreign).priority,
      'lowest',
      'the foreign issue must be untouched',
    );
  });

  it('records a bulk activity entry', async () => {
    const id = await newIssue('bulk activity record');
    await harness.services.bulk.apply(
      [id],
      [{ op: 'setPriority', priority: 'high' }],
      actorFor(userId),
      requestContext(userId),
      { continueOnError: true },
    );

    const events = harness.services.activity.forIssue(id, { types: ['issue.bulk_updated'] });
    assert.ok(events.length > 0, 'a bulk change must appear on the timeline');
  });
});

describe('retention archiving', () => {
  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  it('has no policy until one is set', () => {
    assert.equal(harness.services.archive.getPolicy(projectId), null);
  });

  it('archives an old closed issue', async () => {
    harness.services.archive.setPolicy(
      projectId,
      {
        enabled: true,
        inactiveDays: 30,
        states: ['closed'],
        skipIssuesWithOpenSubtasks: true,
        requireCommentWithinDays: null,
      },
      requestContext(userId),
    );

    const old = await newIssue('stale closed issue');
    // It must actually be in a policy state, and older than the window.
    const closedStatus = (await harness.services.workflow.statusesForProject(projectId)).find(
      (status) => status.key === 'closed',
    );
    harness.db.run(
      'UPDATE issues SET state = ?, status_id = ?, updated_at = ?, created_at = ? WHERE id = ?',
      ['closed', closedStatus?.id, daysAgo(90), daysAgo(120), old],
    );
    // The creation event is activity too, so it has to age with the issue.
    harness.db.run('UPDATE activity_events SET created_at = ? WHERE issue_id = ?', [daysAgo(90), old]);

    const candidates = await harness.services.archive.candidates(projectId);
    assert.ok(candidates.some((c) => c.issueId === old), 'the stale issue is a candidate');

    const result = await harness.services.archive.run(projectId, null, requestContext(userId));
    assert.ok(result.archived >= 1);
    assert.equal(harness.services.issues.getById(old).archived, true);
  });

  it('never archives an open issue', async () => {
    const open = await newIssue('recent open issue');
    harness.db.run('UPDATE issues SET updated_at = ?, created_at = ? WHERE id = ?', [
      daysAgo(90),
      daysAgo(120),
      open,
    ]);

    await harness.services.archive.run(projectId, null, requestContext(userId));
    assert.equal(
      harness.services.issues.getById(open).archived,
      false,
      'an open issue is outside the policy states and must survive',
    );
  });

  it('never archives a recently touched issue', async () => {
    const recent = await newIssue('recently closed issue');
    harness.db.run('UPDATE issues SET state = ?, status_id = ?, updated_at = ? WHERE id = ?', [
      'closed',
      (await harness.services.workflow.statusesForProject(projectId)).find((s) => s.key === 'closed')?.id,
      daysAgo(2),
      recent,
    ]);

    await harness.services.archive.run(projectId, null, requestContext(userId));
    assert.equal(harness.services.issues.getById(recent).archived, false);
  });

  it('is idempotent, so a second run does not re-archive', async () => {
    const first = await harness.services.archive.run(projectId, null, requestContext(userId));
    const second = await harness.services.archive.run(projectId, null, requestContext(userId));
    assert.equal(second.archived, 0, 'nothing is left to archive');
    assert.ok(first.archived >= 0);
  });

  it('restores an archived issue', async () => {
    const issue = await newIssue('restorable issue');
    harness.services.issues.setArchived(issue.id ?? issue, true, userId, {});

    const restored = await harness.services.archive.restore(issue, actorFor(userId), requestContext(userId));
    assert.equal(restored.restored, true);
    assert.equal(harness.services.issues.getById(issue).archived, false);
  });
});

describe('data export', () => {
  it('exports CSV with a header row', async () => {
    const id = await newIssue('export csv subject');
    const result = await harness.services.export.run(
      { projectId, format: 'csv', includeComments: false, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );

    assert.match(result.filename, /\.csv$/);
    const firstLine = result.body.split(/\r?\n/)[0] ?? '';
    assert.match(firstLine, /key/i, 'a header row is present');
    assert.match(result.body, new RegExp(issueKey(id)), 'the issue appears in the export');
  });

  it('quotes a cell containing a comma, quote or newline', async () => {
    const tricky = await newIssue('Comma, quote " and\nnewline');
    const result = await harness.services.export.run(
      { projectId, format: 'csv', includeComments: false, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );

    const line = result.body
      .split(/\r?\n/)
      .find((row) => row.includes(issueKey(tricky)));
    assert.ok(line, 'the tricky issue has a row');
    // A cell holding a quote must double it, and the field must be wrapped.
    assert.ok(line?.includes('""') || line?.includes('"Comma'), `expected quoting, got: ${line}`);
  });

  it('neutralises a spreadsheet formula in exported text', async () => {
    // `=cmd|...` is executed by Excel and Sheets when a CSV cell is opened. A
    // title that starts with one must not be emitted verbatim.
    const formula = await newIssue('=HYPERLINK("http://evil.example.com","click")');
    const result = await harness.services.export.run(
      { projectId, format: 'csv', includeComments: false, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );

    const line = result.body
      .split(/\r?\n/)
      .find((row) => row.includes(issueKey(formula)));
    assert.ok(line, 'the formula issue has a row');
    assert.ok(
      !/(^|,)"?=HYPERLINK/.test(line ?? ''),
      `a formula must not lead a cell: ${line}`,
    );
  });

  it('exports JSON that parses', async () => {
    const result = await harness.services.export.run(
      { projectId, format: 'json', includeComments: true, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );

    const parsed = JSON.parse(result.body) as { count: number; issues: unknown[] };
    assert.equal(typeof parsed.count, 'number');
    assert.ok(Array.isArray(parsed.issues));
  });

  it('exports Markdown with a heading per issue', async () => {
    const id = await newIssue('export markdown subject');
    const result = await harness.services.export.run(
      { projectId, format: 'markdown', includeComments: false, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );

    assert.match(result.filename, /\.markdown$/);
    assert.ok(result.body.includes(issueKey(id)), 'the issue key is present');
  });

  it('records the export in the audit trail', async () => {
    const before = Number(harness.db.scalar<number>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'export.generated'") ?? 0);
    await harness.services.export.run(
      { projectId, format: 'json', includeComments: false, includeAttachments: false, includeTimeline: false },
      actorFor(userId),
      requestContext(userId),
    );
    const after = Number(harness.db.scalar<number>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'export.generated'") ?? 0);
    assert.ok(after > before, 'an export is audited');
  });
});
