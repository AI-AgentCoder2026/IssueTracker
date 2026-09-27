/**
 * Role-Based Access Control.
 *
 * Roles are ordered by privilege within a project. `owner` > `admin` >
 * `maintainer` > `developer` > `reporter` > `viewer`. Custom roles may be added
 * later; the built-in six cover the required collaboration and access matrix.
 *
 * Permissions are capability strings rather than role checks so that the web
 * layer, the API and background jobs all ask the same question:
 * `can(actor, 'issue.delete', ctx)`.
 */

import { z } from 'zod';
import type { ProjectId, UserId } from './ids.ts';

export const ROLES = [
  'owner',
  'admin',
  'maintainer',
  'developer',
  'reporter',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

/** Higher number = more privilege. Used for `at least role` comparisons. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 60,
  admin: 50,
  maintainer: 40,
  developer: 30,
  reporter: 20,
  viewer: 10,
};

export const PERMISSIONS = [
  // issue lifecycle
  'issue.create',
  'issue.read',
  'issue.update',
  'issue.delete',
  'issue.transition',
  'issue.assign',
  'issue.link', // parent/child + dependencies
  'issue.bulkEdit',
  'issue.export',
  // collaboration
  'comment.create',
  'comment.update.own',
  'comment.update.any',
  'comment.delete.own',
  'comment.delete.any',
  'attachment.create',
  'attachment.delete.own',
  'attachment.delete.any',
  // workflow & schema administration
  'workflow.read',
  'workflow.manage',
  'label.manage',
  'milestone.manage',
  // project administration
  'project.read',
  'project.update',
  'project.delete',
  'member.read',
  'member.invite',
  'member.manageRole',
  'member.remove',
  // access control
  'audit.read',
  'guestToken.create',
  // analytics
  'dashboard.read',
  'dashboard.manage',
  // integrations
  'gitlab.read',
  'gitlab.manage',
  'gitlab.sync',
  'webhook.read',
  'webhook.manage',
  // instance administration
  'instance.settings',
  'instance.audit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permission grants per role. Deny is intentionally absent: a role either has
 * a capability or it does not, which keeps audit reasoning straightforward.
 */
const VIEWER: Permission[] = [
  'issue.read',
  'workflow.read',
  'project.read',
  'member.read',
  'dashboard.read',
  'gitlab.read',
  'webhook.read',
];

const REPORTER: Permission[] = [
  ...VIEWER,
  'issue.create',
  'issue.update',
  'issue.transition',
  'issue.link',
  'issue.export',
  'comment.create',
  'comment.update.own',
  'comment.delete.own',
  'attachment.create',
  'attachment.delete.own',
];

const DEVELOPER: Permission[] = [
  ...REPORTER,
  'issue.assign',
  'issue.bulkEdit',
  'comment.update.any',
  'comment.delete.any',
  'attachment.delete.any',
];

const MAINTAINER: Permission[] = [
  ...DEVELOPER,
  'label.manage',
  'milestone.manage',
  'project.update',
  'member.invite',
  'webhook.manage',
  'dashboard.manage',
];

const ADMIN: Permission[] = [
  ...MAINTAINER,
  'workflow.manage',
  'member.manageRole',
  'member.remove',
  'audit.read',
  'guestToken.create',
  'gitlab.manage',
  'gitlab.sync',
];

const OWNER: Permission[] = [
  ...ADMIN,
  'project.delete',
  'instance.settings',
  'instance.audit',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  reporter: REPORTER,
  developer: DEVELOPER,
  maintainer: MAINTAINER,
  admin: ADMIN,
  owner: OWNER,
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.viewer;
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Where a permission check is being performed. */
export interface AccessContext {
  /** Present when the permission is scoped to a single project. */
  projectId?: ProjectId;
  /**
   * The caller asserts the actor owns the resource under test.
   *
   * This is recorded for the audit trail and included in the decision reason.
   * It deliberately does **not** widen the check: a caller must ask for the
   * `*.own` variant explicitly. Auto-upgrading `comment.update.any` to
   * `comment.update.own` when the actor happens to own the resource would let
   * a reporter edit other people's comments, so the mapping is intentionally
   * not performed here.
   */
  isOwnerOfResource?: boolean;
}

/**
 * The actor performing an action. `roles` is the set of roles the actor holds
 * across all projects; `projectRoles` narrows that to the project in context.
 */
export interface Actor {
  userId: UserId;
  /** True for instance administrators who bypass project membership checks. */
  isInstanceAdmin: boolean;
  /** Platform-level roles, used when no project is in context. */
  roles: readonly Role[];
  /** Per-project membership roles. */
  projectRoles: ReadonlyMap<ProjectId, Role>;
}

export interface Decision {
  allowed: boolean;
  /** Human-readable explanation, surfaced in the UI and the audit trail. */
  reason: string;
}

const DENY: Decision = { allowed: false, reason: 'not permitted' };

/**
 * Central permission check. Instance admins are allow-listed; otherwise the
 * actor's role in the project under evaluation decides.
 *
 * The permission is evaluated exactly as requested — see `AccessContext` for
 * why ownership never widens the check.
 */
export function can(
  actor: Actor,
  permission: Permission,
  ctx: AccessContext = {},
): Decision {
  if (actor.isInstanceAdmin) {
    return { allowed: true, reason: 'instance administrator' };
  }

  return canWithoutOwnership(actor, permission, ctx);
}

function canWithoutOwnership(
  actor: Actor,
  permission: Permission,
  ctx: AccessContext,
): Decision {
  const owned = ctx.isOwnerOfResource ? ' (actor owns the resource)' : '';

  if (ctx.projectId !== undefined) {
    const role = actor.projectRoles.get(ctx.projectId);
    if (!role) {
      // No membership in the project. Only instance admins pass, and those
      // were already handled above.
      return { ...DENY, reason: `not a member of this project${owned}` };
    }
    return roleHasPermission(role, permission)
      ? { allowed: true, reason: `project role ${role} grants ${permission}${owned}` }
      : { ...DENY, reason: `project role ${role} lacks ${permission}${owned}` };
  }

  // No project scope: allow if *any* role grants it, so instance-wide listings
  // work without enumerating projects first.
  const granting = actor.roles.find((role) => roleHasPermission(role, permission));
  return granting
    ? { allowed: true, reason: `role ${granting} grants ${permission}${owned}` }
    : { ...DENY, reason: `no role grants ${permission}${owned}` };
}

export const roleSchema = z.enum(ROLES);
export const permissionSchema = z.enum(PERMISSIONS);
