/**
 * RBAC: the permission matrix and the ownership fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_RANK,
  can,
  permissionsForRole,
  roleAtLeast,
  roleHasPermission,
  type Actor,
  type ProjectId,
  type Role,
  type UserId,
} from '@tracker/shared';

const projectId = 1 as ProjectId;
const otherProjectId = 2 as ProjectId;

function actorWith(roles: Role[], projectRoles: Record<number, Role> = { [projectId]: 'viewer' }): Actor {
  return {
    userId: 7 as UserId,
    isInstanceAdmin: false,
    roles,
    projectRoles: new Map(
      Object.entries(projectRoles).map(([id, role]) => [Number(id) as ProjectId, role]),
    ),
  };
}

describe('role permissions', () => {
  it('grants strictly more capability as rank increases', () => {
    const order: Role[] = ['viewer', 'reporter', 'developer', 'maintainer', 'admin', 'owner'];
    for (let i = 1; i < order.length; i += 1) {
      const previous = permissionsForRole(order[i - 1] as Role);
      const current = permissionsForRole(order[i] as Role);
      // Each role must be a superset of the one below it.
      for (const permission of previous) {
        assert.ok(
          current.includes(permission),
          `${order[i]} should inherit ${permission} from ${order[i - 1]}`,
        );
      }
      assert.ok(current.length >= previous.length);
    }
  });

  it('assigns a consistent rank to every role', () => {
    const ranks = Object.values(ROLE_RANK);
    assert.equal(new Set(ranks).size, ranks.length, 'ranks must be unique');
    assert.ok(roleAtLeast('admin', 'developer'));
    assert.ok(!roleAtLeast('developer', 'admin'));
    assert.ok(roleAtLeast('viewer', 'viewer'), 'a role satisfies its own minimum');
  });

  it('never lets a viewer mutate anything', () => {
    const destructive: Array<[Role, string]> = [
      ['viewer', 'issue.create'],
      ['viewer', 'issue.update'],
      ['viewer', 'issue.delete'],
      ['viewer', 'comment.create'],
      ['viewer', 'workflow.manage'],
      ['viewer', 'project.delete'],
      ['viewer', 'gitlab.manage'],
    ];
    for (const [role, permission] of destructive) {
      assert.ok(!roleHasPermission(role, permission as never), `${role} must not have ${permission}`);
    }
  });

  it('keeps instance-level capabilities off non-admin roles', () => {
    assert.ok(!roleHasPermission('admin', 'instance.settings'), 'project admin is not instance admin');
    assert.ok(roleHasPermission('owner', 'instance.settings'));
  });
});

describe('can()', () => {
  it('denies a non-member of the project', () => {
    const actor = actorWith(['admin'], { [otherProjectId]: 'admin' });
    const decision = can(actor, 'issue.read', { projectId });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /not a member/);
  });

  it('grants according to the project role', () => {
    const actor = actorWith(['developer'], { [projectId]: 'developer' });
    assert.equal(can(actor, 'issue.create', { projectId }).allowed, true);
    assert.equal(can(actor, 'workflow.manage', { projectId }).allowed, false);
  });

  it('ignores platform roles when a project scope is supplied', () => {
    // The actor is an `admin` in one project but only a `viewer` here.
    const actor = actorWith(['admin'], { [projectId]: 'viewer' });
    assert.equal(can(actor, 'issue.update', { projectId }).allowed, false);
  });

  it('lets an instance admin bypass membership entirely', () => {
    const actor: Actor = {
      userId: 1 as UserId,
      isInstanceAdmin: true,
      roles: ['user'],
      projectRoles: new Map(),
    };
    const decision = can(actor, 'project.delete', { projectId: otherProjectId as ProjectId });
    assert.equal(decision.allowed, true);
    assert.match(decision.reason, /instance administrator/);
  });

  it('falls back to the ownership variant for .own permissions', () => {
    // A reporter may edit their own comment but not someone else's.
    const actor = actorWith(['reporter'], { [projectId]: 'reporter' });

    assert.equal(
      can(actor, 'comment.update.own', { projectId, isOwnerOfResource: true }).allowed,
      true,
    );
    assert.equal(
      can(actor, 'comment.update.any', { projectId, isOwnerOfResource: true }).allowed,
      false,
      'ownership must not grant the .any variant',
    );
    assert.equal(
      can(actor, 'comment.update.own', { projectId, isOwnerOfResource: false }).allowed,
      true,
      'a reporter holds comment.update.own directly',
    );
  });

  it('denies an ownership fallback when the base capability is absent', () => {
    const actor = actorWith(['viewer'], { [projectId]: 'viewer' });
    assert.equal(
      can(actor, 'comment.update.any', { projectId, isOwnerOfResource: true }).allowed,
      false,
    );
  });

  it('works without a project scope using platform roles', () => {
    const actor = actorWith(['maintainer']);
    assert.equal(can(actor, 'issue.read').allowed, true);
    assert.equal(can(actor, 'instance.settings').allowed, false);
  });

  it('always explains its decision', () => {
    const actor = actorWith(['viewer'], { [projectId]: 'viewer' });
    for (const decision of [
      can(actor, 'issue.read', { projectId }),
      can(actor, 'issue.delete', { projectId }),
    ]) {
      assert.equal(typeof decision.reason, 'string');
      assert.ok(decision.reason.length > 0);
    }
  });
});
