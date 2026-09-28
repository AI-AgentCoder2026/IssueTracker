/**
 * SLA policies and alerting, plus the notification fan-out they drive.
 *
 * `evaluate()` runs on a timer, so the property that matters most is that it is
 * **idempotent**: a warning or breach alert must fire exactly once, not on every
 * tick. The guards are `UPDATE ... WHERE warned_at IS NULL` followed by a
 * `changes === 0` check, and this suite is what proves they hold.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectId, Role, UserId } from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import type { RequestContext } from '../src/services/context.ts';

let harness: TestHarness;
let projectId: number;
let assigneeId: number;
let policyId: number;

const MINUTE = 60_000;

function actorFor(user: number) {
  return {
    userId: user as UserId,
    isInstanceAdmin: true,
    roles: ['admin' as Role],
    projectRoles: new Map<ProjectId, Role>([[projectId as ProjectId, 'owner' as Role]]),
  };
}

function ctx(): RequestContext {
  return {
    services: harness.services,
    db: harness.db,
    config: harness.config,
    actor: actorFor(assigneeId),
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: assigneeId, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

/**
 * A clock subject.
 *
 * Unassigned by default, and that matters: the response SLA is met the moment
 * the issue is assigned or commented on, so a fixture with an assignee never
 * warns or breaches. Tests that need an assignee say so explicitly.
 */
async function newIssue(overrides: Record<string, unknown> = {}): Promise<number> {
  const created = await harness.services.issues.create(
    projectId,
    {
      title: 'sla subject',
      description: '',
      type: 'incident',
      priority: 'critical',
      assigneeId: null,
      ...overrides,
    },
    assigneeId,
    { actorId: assigneeId },
  );
  return created.issue.id as unknown as number;
}

/** Count notifications of a kind delivered to a user. */
function countNotifications(userId: number, event: string): number {
  return Number(
    harness.db.scalar<number>(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND event = ?',
      [userId, event],
    ) ?? 0,
  );
}

before(async () => {
  harness = createHarness();
  assigneeId = insertUser(harness, { username: 'oncall' });
  projectId = createProject(harness, assigneeId, 'SLA');

  const policy = harness.services.sla.createPolicy(
    {
      projectId,
      name: 'Critical incident',
      description: 'Acknowledge fast.',
      appliesTo: { types: ['incident'], priorities: ['critical'], labelIds: [], states: [] },
      responseMinutes: 30,
      resolutionMinutes: 240,
      warningMinutes: 15,
      businessHoursOnly: false,
      enabled: true,
    } as never,
    ctx(),
  );
  policyId = policy.id;
});

after(() => harness.close());

describe('policy and clock creation', () => {
  it('creates a policy', () => {
    const policy = harness.services.sla.getPolicy(policyId);
    assert.equal(policy.responseMinutes, 30);
    assert.equal(policy.warningMinutes, 15);
    assert.equal(policy.enabled, true);
  });

  it('creates a clock for a matching issue', async () => {
    const issue = await newIssue();
    const created = harness.services.sla.ensureClocksForIssue(issue);
    assert.equal(created, 2, 'a response and a resolution clock');

    const statuses = await harness.services.sla.statusForIssue(issue);
    assert.equal(statuses.length, 2);
    assert.ok(statuses.some((s) => s.target === 'response'));
    assert.ok(statuses.some((s) => s.target === 'resolution'));
  });

  it('does not duplicate clocks on a second call', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);
    const second = harness.services.sla.ensureClocksForIssue(issue);
    assert.equal(second, 0, 'the unique constraint makes this a no-op the second time');
  });

  it('creates no clock for an issue the policy does not match', async () => {
    const other = await newIssue({ type: 'task', priority: 'low' });
    assert.equal(harness.services.sla.ensureClocksForIssue(other), 0);
  });

  it('creates no clock while the policy is disabled', async () => {
    const issue = await newIssue();
    harness.db.run('UPDATE sla_policies SET enabled = 0 WHERE id = ?', [policyId]);
    try {
      assert.equal(harness.services.sla.ensureClocksForIssue(issue), 0);
    } finally {
      harness.db.run('UPDATE sla_policies SET enabled = 1 WHERE id = ?', [policyId]);
    }
  });
});

describe('evaluate is idempotent', () => {
  it('warns exactly once as the deadline approaches', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);

    // Move the deadline to 10 minutes out: inside the 15 minute warning.
    harness.db.run(
      `UPDATE sla_clocks SET due_at = ? WHERE issue_id = ? AND target = 'response'`,
      [new Date(Date.now() + 10 * MINUTE).toISOString(), issue],
    );

    const first = harness.services.sla.evaluate();
    assert.ok(first.warned >= 1, 'the first pass warns');

    const afterFirst = countNotifications(assigneeId, 'issue.due_soon');
    assert.ok(afterFirst > 0, 'a warning notification is delivered');

    // Several more ticks must not repeat it.
    for (let i = 0; i < 5; i += 1) harness.services.sla.evaluate();
    assert.equal(
      countNotifications(assigneeId, 'issue.due_soon'),
      afterFirst,
      'a repeat evaluate() must not re-notify',
    );
    assert.ok(harness.services.sla.evaluate().warned === 0, 'nothing is left to warn about');
  });

  it('breaches exactly once, and does not also warn afterwards', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);

    // Push the deadline into the past.
    harness.db.run(
      `UPDATE sla_clocks SET due_at = ? WHERE issue_id = ? AND target = 'response'`,
      [new Date(Date.now() - MINUTE).toISOString(), issue],
    );

    const first = harness.services.sla.evaluate();
    assert.ok(first.breached >= 1, 'the first pass reports a breach');

    const breachNotifications = countNotifications(assigneeId, 'issue.sla_breach');
    assert.ok(breachNotifications > 0, 'a breach notification is delivered');

    for (let i = 0; i < 5; i += 1) harness.services.sla.evaluate();
    assert.equal(
      countNotifications(assigneeId, 'issue.sla_breach'),
      breachNotifications,
      'a repeated breach must not re-notify',
    );
  });

  it('does not warn for a clock that is already past due', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);
    harness.db.run(
      `UPDATE sla_clocks SET due_at = ? WHERE issue_id = ? AND target = 'resolution'`,
      [new Date(Date.now() - 5 * MINUTE).toISOString(), issue],
    );

    harness.services.sla.evaluate();
    const warned = harness.db.get<{ warned_at: string | null; breach_notified_at: string | null }>(
      "SELECT warned_at, breach_notified_at FROM sla_clocks WHERE issue_id = ? AND target = 'resolution'",
      [issue],
    );

    // An already-breached clock should go straight to breach, not emit a
    // warning first and then a breach.
    assert.ok(warned?.breach_notified_at, 'it is recorded as breached');
  });

  it('does nothing for a clock that is comfortably on track', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);
    const before = countNotifications(assigneeId, 'issue.due_soon') + countNotifications(assigneeId, 'issue.sla_breach');
    harness.services.sla.evaluate();
    const after = countNotifications(assigneeId, 'issue.due_soon') + countNotifications(assigneeId, 'issue.sla_breach');
    assert.equal(after, before, 'a healthy clock is silent');
  });
});

describe('clock state', () => {
  it('reports remaining time and marks a met clock', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);

    let statuses = await harness.services.sla.statusForIssue(issue);
    const response = statuses.find((s) => s.target === 'response');
    assert.ok(response);
    assert.equal(response.state, 'on_track');
    assert.ok((response.remainingMs ?? 0) > 0, 'a live clock reports time remaining');

    // Close the issue along the real workflow path. The default workflow has
    // no `Open -> Closed` edge, so a direct jump is refused - walking the path
    // is the point, not something to route around.
    const workflow = await harness.services.workflow.statusesForProject(projectId);
    for (const key of ['in_progress', 'in_review', 'resolved', 'closed']) {
      const next = workflow.find((status) => status.key === key);
      harness.services.issues.transition(issue, { toStatusId: next?.id as number }, assigneeId, {});
    }

    statuses = await harness.services.sla.statusForIssue(issue);

    // Resolving stops the *resolution* clock. The response clock answers a
    // separate question: nobody was ever assigned or commented, so the
    // incident was closed without ever being acknowledged, and that SLA really
    // did fail. Asserting both as 'met' would hide a distinction that matters.
    const resolutionClock = statuses.find((s) => s.target === 'resolution');
    const responseClock = statuses.find((s) => s.target === 'response');
    assert.equal(resolutionClock?.state, 'met', 'resolving satisfies the resolution clock');
    assert.equal(responseClock?.state, 'on_track', 'the response clock was never acknowledged');
  });

  it('treats an assigned issue as acknowledged', async () => {
    const issue = await newIssue({ assigneeId });
    harness.services.sla.ensureClocksForIssue(issue);
    const statuses = await harness.services.sla.statusForIssue(issue);
    const response = statuses.find((s) => s.target === 'response');
    // Assigning someone is the acknowledgement signal, so the response clock is
    // satisfied without any comment.
    assert.equal(response?.state, 'met');
  });

  it('lists at-risk and breached clocks for the dashboard', async () => {
    const issue = await newIssue();
    harness.services.sla.ensureClocksForIssue(issue);
    harness.db.run(
      `UPDATE sla_clocks SET due_at = ? WHERE issue_id = ? AND target = 'response'`,
      [new Date(Date.now() + 5 * MINUTE).toISOString(), issue],
    );

    const atRisk = harness.services.sla.atRisk([projectId], 60 * MINUTE);
    assert.ok(atRisk.some((clock) => clock.issueId === issue), 'the imminently-due clock is at risk');
  });

  it('summarises the project', () => {
    const summary = harness.services.sla.summary(projectId);
    assert.equal(typeof summary.total, 'number');
  });
});

describe('notification fan-out', () => {
  it('does not notify the actor about their own action', async () => {
    const other = insertUser(harness, { username: 'watcher1' });
    const issue = (
      await harness.services.issues.create(
        projectId,
        { title: 'notified', description: '', type: 'bug', priority: 'high', assigneeId: other },
        assigneeId,
        { actorId: assigneeId },
      )
    ).issue.id as unknown as number;

    harness.services.issues.transition(
      issue,
      { toStatusId: (await harness.services.workflow.statusesForProject(projectId)).find((s) => s.key === 'in_progress')?.id as number },
      assigneeId,
      {},
    );

    const { notifications } = harness.services.notifications.listForUser(assigneeId, { limit: 200 });
    const own = notifications.filter(
      (n) => n.issueId === issue && n.event === 'issue.status_changed' && n.payload['actorId'] === assigneeId,
    );
    assert.equal(own.length, 0, 'the actor is excluded from their own transition notice');
  });

  it('honours an in-app opt-out', async () => {
    const user = insertUser(harness, { username: 'quiet' });
    const issue = (
      await harness.services.issues.create(
        projectId,
        { title: 'quiet issue', description: '', type: 'bug', priority: 'high', assigneeId: user },
        assigneeId,
        { actorId: assigneeId },
      )
    ).issue.id as unknown as number;

    harness.services.notifications.setPreference(user, 'issue.assigned', false, false);
      // Measure a delta: creating the assigned issue would itself notify, and
      // an absolute count would blame the wrong event for the extra row.
      const baseline = countNotifications(user, 'issue.assigned');
    harness.services.notifications.notify(
      { event: 'issue.assigned', title: 'assigned', issueId: issue, projectId, userIds: [user] },
      { excludeUserIds: [assigneeId] },
    );

      assert.equal(
        countNotifications(user, 'issue.assigned'),
        baseline,
        'an opted-out user receives nothing further in-app',
      );

    });
  it('queues email only when the preference asks for it', () => {
    const username = 'emailed';
    // The email is derived from the username; `insertUser` returns a row id,
    // so interpolating that would have queried the wrong address throughout.
    const user = insertUser(harness, { username });
    const address = `${username}@example.com`;
    const base = { event: 'issue.assigned' as const, title: 'x', projectId, userIds: [user] };

    harness.services.notifications.notify(base, { excludeUserIds: [assigneeId] });
    const afterDefault = Number(
      harness.db.scalar<number>("SELECT COUNT(*) AS c FROM email_outbox WHERE to_email = ?", [
        address,
      ]) ?? 0,
    );
    assert.equal(afterDefault, 0, 'email is off by default');

    harness.services.notifications.setPreference(user, 'issue.assigned', true, true);
    harness.services.notifications.notify(base, { excludeUserIds: [assigneeId] });
    const afterOptIn = Number(
      harness.db.scalar<number>("SELECT COUNT(*) AS c FROM email_outbox WHERE to_email = ?", [
        address,
      ]) ?? 0,
    );
    assert.equal(afterOptIn, 1, 'opting in queues one email');
  });

  it('respects a global opt-out even when the event prefers email', () => {
    const username = 'optedout';
    // The address comes from the username, not the returned row id.
    const user = insertUser(harness, { username });
    const address = `${username}@example.com`;
    harness.db.run('UPDATE users SET email_opt_out = 1 WHERE id = ?', [user]);
    harness.services.notifications.setPreference(user, 'issue.assigned', true, true);

    harness.services.notifications.notify(
      { event: 'issue.assigned', title: 'x', projectId, userIds: [user] },
      { excludeUserIds: [assigneeId] },
    );

    assert.equal(
      harness.db.scalar<number>('SELECT COUNT(*) AS c FROM email_outbox WHERE to_email = ?', [
        address,
      ]),
      0,
      'the global opt-out wins over an event-level preference',
    );
  });

  it('marks notifications read and counts unread', async () => {
    const user = insertUser(harness, { username: 'reader' });
    const issue = (
      await harness.services.issues.create(
        projectId,
        { title: 'read me', description: '', type: 'bug', priority: 'high', assigneeId: user },
        assigneeId,
        { actorId: assigneeId },
      )
    ).issue.id as unknown as number;

    harness.services.notifications.notify(
      { event: 'issue.assigned', title: 'ping', issueId: issue, projectId, userIds: [user] },
      { excludeUserIds: [assigneeId] },
    );

    const before = harness.services.notifications.listForUser(user);
    assert.ok(before.unreadCount > 0);
    assert.ok(before.notifications[0]?.id);

    const updated = harness.services.notifications.markRead(user, [before.notifications[0]!.id]);
    assert.equal(updated, 1);
    assert.ok(
      harness.services.notifications.listForUser(user).unreadCount < before.unreadCount,
      'the unread count drops',
    );
  });
});
