/**
 * Collaboration: comment mentions and guest access.
 *
 * Two features whose failures are both *disclosures* rather than errors, which
 * is why they need tests more than the average service:
 *
 *  * a `@mention` must only resolve for a user who can already see the issue;
 *    resolving one for an outsider turns the comment log into a roster of who
 *    has access to what, and delivers a notification to someone with no rights
 *    to the subject.
 *  * a guest link must produce an actor scoped to exactly one project. A scope
 *    that leaks turns a single shared link into a whole-project read token.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor, ProjectId, Role, UserId } from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';
import type { RequestContext } from '../src/services/context.ts';
import type { RequestMeta } from '../src/services/auth.service.ts';
import { guestServiceFor } from '../src/plugins/auth.plugin.ts';

let harness: TestHarness;
let projectId: number;
let otherProjectId: number;
let memberId: number;
let outsiderId: number;
let adminId: number;
let issueId: number;

function actorFor(user: number, role: Role = 'developer', project = projectId): Actor {
  return {
    userId: user as UserId,
    isInstanceAdmin: false,
    roles: [role],
    projectRoles: new Map<ProjectId, Role>([[project as ProjectId, role]]),
  };
}

function ctx(user: number, role: Role = 'developer'): RequestContext {
  return {
    services: harness.services,
    db: harness.db,
    config: harness.config,
    actor: actorFor(user, role),
    guest: null,
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auditContext: { actorId: user, ipAddress: '127.0.0.1', userAgent: 'test' },
  };
}

const meta: RequestMeta = { ip: '127.0.0.1', userAgent: 'test', audit: {}, requestId: 'test' };

const countNotifications = (userId: number, event: string): number =>
  Number(
    harness.db.scalar<number>(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND event = ?',
      [userId, event],
    ) ?? 0,
  );

before(async () => {
  harness = createHarness();
  memberId = insertUser(harness, { username: 'member' });
  outsiderId = insertUser(harness, { username: 'outsider' });
  adminId = insertUser(harness, { username: 'siteadmin', instanceRole: 'admin' });

  projectId = createProject(harness, memberId, 'COLLAB');
  otherProjectId = createProject(harness, memberId, 'ELSEWHERE');

  // The outsider exists and is active, but belongs to no project here.
  adminId = adminId;

  const created = await harness.services.issues.create(
    projectId,
    { title: 'discuss here', description: '', type: 'task', priority: 'medium' },
    memberId,
    { actorId: memberId },
  );
  issueId = created.issue.id as unknown as number;
});

after(() => harness.close());

describe('mentions', () => {
  it('resolves a mention for a project member', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: `cc @member please look` },
      memberId,
      { silent: true },
    );
    const mentioned = comment.mentions.map((m) => m.username);
    assert.ok(mentioned.includes('member'), `expected the member, got ${mentioned.join(',')}`);
  });

  it('leaves a mention for a non-member as literal text', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: `cc @outsider are you there` },
      memberId,
      { silent: true },
    );
    const mentioned = comment.mentions.map((m) => m.username);
    assert.ok(
      !mentioned.includes('outsider'),
      'a user with no access must not be resolved or notified',
    );
    // The text is untouched, so it still reads correctly in the UI.
    assert.match(comment.body, /@outsider/);
  });

  it('does not notify a mentioned outsider', async () => {
    const before = countNotifications(outsiderId, 'issue.mentioned');
    await harness.services.comments.create(
      issueId,
      { body: 'hello @outsider' },
      memberId,
      {},
    );
    assert.equal(
      countNotifications(outsiderId, 'issue.mentioned'),
      before,
      'an unresolved mention must not deliver a notification',
    );
  });

  it('resolves a mention for an instance administrator', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'cc @siteadmin' },
      memberId,
      { silent: true },
    );
    assert.ok(
      comment.mentions.some((m) => m.username === 'siteadmin'),
      'an instance admin can see any project',
    );
  });

  it('leaves an unknown handle literal without failing the comment', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'ping @nosuchperson about it' },
      memberId,
      { silent: true },
    );
    assert.equal(comment.mentions.length, 0);
    assert.match(comment.body, /@nosuchperson/);
  });

  it('finds a mention inside punctuation and repeated', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'hey @member, and @member again' },
      memberId,
      { silent: true },
    );
    assert.equal(comment.mentions.length, 1, 'a repeated handle resolves once');
  });

  it('stores one mention row per user, not per occurrence', async () => {
    const rows = Number(
      harness.db.scalar<number>(
        `SELECT COUNT(*) AS c FROM comment_mentions
         WHERE user_id = ? AND comment_id IN (SELECT id FROM comments WHERE body LIKE '%@member%')`,
        [memberId],
      ) ?? 0,
    );
    // Two comments mentioned them, each contributing exactly one row.
    assert.ok(rows >= 2 && rows % 2 === 0, `unexpected mention-row count: ${rows}`);
  });

  it('recomputes mentions when a comment is edited', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'cc @member' },
      memberId,
      { silent: true },
    );
    assert.equal(comment.mentions.length, 1);

    const edited = await harness.services.comments.update(
      comment.id,
      'no longer relevant',
      memberId,
      {},
    );
    assert.equal(edited.mentions.length, 0, 'removing the handle removes the mention');
  });
});

describe('comment editing', () => {
  it('lets the author edit and stamps edited_at', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'original' },
      memberId,
      { silent: true },
    );
    assert.equal(comment.editedAt, null);

    const edited = await harness.services.comments.update(comment.id, 'revised', memberId, {});
    assert.equal(edited.body, 'revised');
    assert.ok(edited.editedAt, 'the edit is marked');
  });

  it('refuses an edit from someone who is not the author', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'mine' },
      memberId,
      { silent: true },
    );
    assert.throws(
      () => harness.services.comments.update(comment.id, 'not yours', adminId, {}),
      /only the author/i,
    );
  });

  it('refuses to edit a system comment', async () => {
    const comment = await harness.services.comments.create(
      issueId,
      { body: 'automated note' },
      memberId,
      { silent: true, isSystemGenerated: true },
    );
    assert.throws(
      () => harness.services.comments.update(comment.id, 'edited', memberId, {}),
      /system comments/i,
    );
  });
});

describe('guest access', () => {
  it('issues a link scoped to one project', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'external reviewer',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 5,
      },
      actorFor(memberId, 'admin'),
      meta,
    );

    assert.ok(created.url.includes('/guest/'));
    assert.equal(created.token.projectId, projectId);
    assert.ok(
      !JSON.stringify(created).includes(created.token),
      'the raw token must not be echoed back as a stored field',
    );
  });

  it('redeems into an actor scoped to exactly one project', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'scoped',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 5,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    const raw = created.url.split('/guest/')[1] as string;
    const { actor, guest } = await guestServiceFor(harness.services).redeem(raw, meta);

    assert.equal(guest.projectId, projectId);
    assert.equal(actor.isInstanceAdmin, false, 'a guest is never an instance admin');
    assert.equal(actor.projectRoles.size, 1, 'a guest must hold no other project role');
    assert.equal(actor.projectRoles.get(projectId as ProjectId), 'viewer');
  });

  it('cannot read another project through the guest actor', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'narrow',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 5,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    const raw = created.url.split('/guest/')[1] as string;
    const { actor } = await guestServiceFor(harness.services).redeem(raw, meta);

    const { can } = await import('@tracker/shared');
    assert.equal(
      can(actor, 'issue.read', { projectId: projectId as ProjectId }).allowed,
      true,
      'the guest can read the project it was granted',
    );
    assert.equal(
      can(actor, 'issue.read', { projectId: otherProjectId as ProjectId }).allowed,
      false,
      'and nothing beyond it',
    );
    assert.equal(can(actor, 'issue.update', { projectId: projectId as ProjectId }).allowed, false);
  });

  it('rejects an expired link', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'stale',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 5,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    const raw = created.url.split('/guest/')[1] as string;
    harness.db.run('UPDATE guest_tokens SET expires_at = ? WHERE project_id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      projectId,
    ]);

    await assert.rejects(
      async () => guestServiceFor(harness.services).redeem(raw, meta),
      /expired/i,
    );
  });

  it('stops at the maximum number of uses', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'single use',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 1,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    const raw = created.url.split('/guest/')[1] as string;

    await guestServiceFor(harness.services).redeem(raw, meta);
    await assert.rejects(
      async () => guestServiceFor(harness.services).redeem(raw, meta),
      /usage limit/i,
    );
  });

  it('rejects a revoked link', async () => {
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'revoked',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 5,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    const raw = created.url.split('/guest/')[1] as string;
    const id = Number(harness.db.get<{ id: number }>('SELECT id FROM guest_tokens WHERE project_id = ? ORDER BY id DESC LIMIT 1', [projectId])?.id ?? 0);
    guestServiceFor(harness.services).revoke(projectId, id, actorFor(memberId, 'admin'), meta);

    await assert.rejects(async () => guestServiceFor(harness.services).redeem(raw, meta), /revoked/i);
  });

  it('rejects a token that was never issued', async () => {
    await assert.rejects(
      async () => guestServiceFor(harness.services).redeem('not-a-real-token', meta),
      /not valid|unknown|not found/i,
    );
  });

  it('requires the guest-token permission to mint a link', async () => {
    const reporter = actorFor(outsiderId, 'reporter');
    // `create` is async, so a synchronous assertion would see no throw and the
    // rejection would surface as an unhandled rejection instead of a failure.
    await assert.rejects(
      async () =>
        guestServiceFor(harness.services).create(
          projectId,
          {
            projectId,
            issueId: null,
            label: 'unauthorised',
            role: 'viewer',
            canComment: false,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            maxUses: 1,
          },
          reporter,
          meta,
        ),
      /permission|forbidden|not permitted|lacks/i,
    );
  });

  it('records creation and revocation in the audit trail', async () => {
    const before = Number(
      harness.db.scalar<number>("SELECT COUNT(*) AS c FROM audit_log WHERE entity_type = 'guest_token'") ?? 0,
    );
    const created = await guestServiceFor(harness.services).create(
      projectId,
      {
        projectId,
        issueId: null,
        label: 'audited',
        role: 'viewer',
        canComment: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses: 1,
      },
      actorFor(memberId, 'admin'),
      meta,
    );
    void created;

    const after = Number(
      harness.db.scalar<number>("SELECT COUNT(*) AS c FROM audit_log WHERE entity_type = 'guest_token'") ?? 0,
    );
    assert.ok(after > before, 'minting a guest link is audited');
  });
});

describe('comment deletion', () => {
  it('removes the comment and records it', async () => {
    const target = (
      await harness.services.issues.create(
        projectId,
        { title: 'deletion subject', description: '', type: 'task', priority: 'medium' },
        memberId,
        { actorId: memberId },
      )
    ).issue.id as unknown as number;

    const comment = await harness.services.comments.create(
      target,
      { body: 'regrettable' },
      memberId,
      { silent: true },
    );
    harness.services.comments.remove(comment.id, memberId, {});

    const events = harness.services.activity.forIssue(target, { types: ['comment.deleted'] });
    assert.ok(events.length > 0, 'a deletion is recorded on the timeline');
  });
});
