/**
 * Project, membership, label, milestone and board routes.
 */

import {
  API,
  addMemberSchema,
  can,
  createLabelSchema,
  createMilestoneSchema,
  createProjectSchema,
  createStatusSchema,
  createTransitionSchema,
  updateProjectSchema,
  updateStatusSchema,
  type Role,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { parseId } from '../services/context.ts';
import { requireAuth, requirePermission } from '../plugins/auth.plugin.ts';

const projectIdOf = (request: { params: unknown }): number =>
  parseId((request.params as { projectId: string }).projectId, 'project');

export const projectRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- projects ------------------------------------------------------------
  app.get('/api/projects', async (request) => {
    const ctx = requireAuth(request);
    return { projects: ctx.services.projects.listVisible(ctx.actor) };
  });

  app.post('/api/projects', async (request) => {
    const body = createProjectSchema.parse(request.body);
    const ctx = requireAuth(request);
    return {
      project: ctx.services.projects.create(body, Number(ctx.actor.userId), ctx.auditContext),
    };
  });

  app.get('/api/projects/:projectId', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return { project: ctx.services.projects.getById(projectId) };
  });

  app.patch('/api/projects/:projectId', async (request) => {
    const projectId = projectIdOf(request);
    const body = updateProjectSchema.parse(request.body);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.update', projectId);
    return { project: ctx.services.projects.update(projectId, body, ctx.auditContext) };
  });

  app.delete('/api/projects/:projectId', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.delete', projectId);
    ctx.services.projects.remove(projectId, ctx.auditContext);
    return { deleted: true };
  });

  app.get('/api/projects/:projectId/stats', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return ctx.services.projects.stats(projectId);
  });

  // -- members -------------------------------------------------------------
  app.get('/api/projects/:projectId/members', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'member.read', projectId);
    return { members: ctx.services.projects.listMembers(projectId) };
  });

  app.post('/api/projects/:projectId/members', async (request) => {
    const projectId = projectIdOf(request);
    const body = addMemberSchema.parse(request.body);
    const ctx = requireAuth(request);
    requirePermission(request, 'member.invite', projectId);

    const user = ctx.services.db.get<{ id: number }>(
      'SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)',
      [body.usernameOrEmail, body.usernameOrEmail],
    );
    if (!user) throw notFound('User', body.usernameOrEmail);

    ctx.services.projects.setMemberRole(projectId, Number(user.id), body.role, {
      actorId: Number(ctx.actor.userId),
    });

    return { members: ctx.services.projects.listMembers(projectId) };
  });

  app.patch('/api/projects/:projectId/members/:userId', async (request) => {
    const projectId = projectIdOf(request);
    const userId = parseId((request.params as { userId: string }).userId, 'user');
    const body = request.body as { role?: Role };
    if (!body.role) throw badRequest('A role is required');

    const ctx = requireAuth(request);
    requirePermission(request, 'member.manageRole', projectId);

    ctx.services.projects.setMemberRole(projectId, userId, body.role, {
      actorId: Number(ctx.actor.userId),
    });
    return { members: ctx.services.projects.listMembers(projectId) };
  });

  app.delete('/api/projects/:projectId/members/:userId', async (request) => {
    const projectId = projectIdOf(request);
    const userId = parseId((request.params as { userId: string }).userId, 'user');
    const ctx = requireAuth(request);
    requirePermission(request, 'member.remove', projectId);

    ctx.services.projects.removeMember(projectId, userId, ctx.auditContext);
    return { members: ctx.services.projects.listMembers(projectId) };
  });

  // -- labels --------------------------------------------------------------
  app.get('/api/projects/:projectId/labels', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return { labels: ctx.services.projects.listLabels(projectId) };
  });

  app.post('/api/projects/:projectId/labels', async (request) => {
    const projectId = projectIdOf(request);
    const body = createLabelSchema.parse(request.body);
    const ctx = requireAuth(request);
    requirePermission(request, 'label.manage', projectId);
    return { label: ctx.services.projects.createLabel(projectId, body, ctx.auditContext) };
  });

  app.patch('/api/projects/:projectId/labels/:id', async (request) => {
    const projectId = projectIdOf(request);
    const labelId = parseId((request.params as { id: string }).id, 'label');
    const ctx = requireAuth(request);
    requirePermission(request, 'label.manage', projectId);
    return {
      label: ctx.services.projects.updateLabel(projectId, labelId, request.body ?? {}, ctx.auditContext),
    };
  });

  app.delete('/api/projects/:projectId/labels/:id', async (request) => {
    const projectId = projectIdOf(request);
    const labelId = parseId((request.params as { id: string }).id, 'label');
    const ctx = requireAuth(request);
    requirePermission(request, 'label.manage', projectId);
    ctx.services.projects.removeLabel(projectId, labelId, ctx.auditContext);
    return { deleted: true };
  });

  // -- milestones ----------------------------------------------------------
  app.get('/api/projects/:projectId/milestones', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return { milestones: ctx.services.projects.listMilestones(projectId) };
  });

  app.post('/api/projects/:projectId/milestones', async (request) => {
    const projectId = projectIdOf(request);
    const body = createMilestoneSchema.parse(request.body);
    const ctx = requireAuth(request);
    requirePermission(request, 'milestone.manage', projectId);
    return { milestone: ctx.services.projects.createMilestone(projectId, body, ctx.auditContext) };
  });

  app.patch('/api/projects/:projectId/milestones/:id', async (request) => {
    const projectId = projectIdOf(request);
    const milestoneId = parseId((request.params as { id: string }).id, 'milestone');
    const ctx = requireAuth(request);
    requirePermission(request, 'milestone.manage', projectId);
    return {
      milestone: ctx.services.projects.updateMilestone(
        projectId,
        milestoneId,
        request.body ?? {},
        ctx.auditContext,
      ),
    };
  });

  app.delete('/api/projects/:projectId/milestones/:id', async (request) => {
    const projectId = projectIdOf(request);
    const milestoneId = parseId((request.params as { id: string }).id, 'milestone');
    const ctx = requireAuth(request);
    requirePermission(request, 'milestone.manage', projectId);
    ctx.services.projects.removeMilestone(projectId, milestoneId, ctx.auditContext);
    return { deleted: true };
  });

  // -- workflow ------------------------------------------------------------
  app.get('/api/projects/:projectId/workflow', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.read', projectId);
    return {
      workflow: ctx.services.workflow.getForProject(projectId),
      isUsingDefaults: ctx.services.workflow.isUsingDefaultStatuses(projectId),
    };
  });

  app.put('/api/projects/:projectId/workflow', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);

    const body = request.body as {
      statuses?: unknown[];
      transitions?: unknown[];
      removedStatusIds?: number[];
      removedTransitionIds?: number[];
      updatedStatuses?: Array<{ id: number; patch: Record<string, unknown> }>;
    };

    // Validate the add-paths with the shared schemas so the API and the UI
    // enforce exactly the same rules.
    const statuses = (body.statuses ?? []).map((status) => createStatusSchema.parse(status));
    const transitions = (body.transitions ?? []).map((transition) =>
      createTransitionSchema.parse(transition),
    );

    return {
      workflow: ctx.services.workflow.update(
        projectId,
        {
          statuses,
          transitions,
          removedStatusIds: body.removedStatusIds ?? [],
          removedTransitionIds: body.removedTransitionIds ?? [],
          updatedStatuses: body.updatedStatuses ?? [],
        },
        { actorId: Number(ctx.actor.userId) },
      ),
    };
  });

  // -- workflow: single statuses -------------------------------------------
  // The PUT above replaces the whole document, which is what the board editor
  // wants. These are for adding or removing one column at a time, so a client
  // does not have to read the entire workflow, merge, and write it back.

  app.get(API.workflow.statuses, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.read', projectId);
    return { statuses: ctx.services.workflow.statusesForProject(projectId) };
  });

  app.post(API.workflow.createStatus, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);
    const body = createStatusSchema.parse(request.body);
    return {
      status: ctx.services.workflow.createStatus(
        projectId,
        body,
        { actorId: Number(ctx.actor.userId) },
      ),
    };
  });

  app.patch(API.workflow.updateStatus, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);
    const statusId = parseId((request.params as { id: string }).id, 'status');
    return {
      status: ctx.services.workflow.updateStatus(
        projectId,
        statusId,
        updateStatusSchema.parse(request.body),
        { actorId: Number(ctx.actor.userId) },
      ),
    };
  });

  app.delete(API.workflow.removeStatus, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);
    const statusId = parseId((request.params as { id: string }).id, 'status');
    ctx.services.workflow.removeStatus(projectId, statusId, { actorId: Number(ctx.actor.userId) });
    return { removed: true, statusId };
  });

  // -- workflow: transitions ------------------------------------------------

  app.get(API.workflow.transitions, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.read', projectId);
    return { transitions: ctx.services.workflow.getForProject(projectId).transitions };
  });

  app.post(API.workflow.createTransition, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);
    const body = createTransitionSchema.parse(request.body);
    return {
      transition: ctx.services.workflow.createTransition(
        projectId,
        body,
        { actorId: Number(ctx.actor.userId) },
      ),
    };
  });

  app.delete(API.workflow.removeTransition, async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'workflow.manage', projectId);
    const transitionId = parseId((request.params as { id: string }).id, 'transition');
    ctx.services.workflow.removeTransition(projectId, transitionId, {
      actorId: Number(ctx.actor.userId),
    });
    return { removed: true, transitionId };
  });
};

export const boardRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/api/projects/:projectId/board', async (request) => {
    const projectId = projectIdOf(request);
    const ctx = requireAuth(request);
    requirePermission(request, 'issue.read', projectId);
    return ctx.services.issues.board(projectId);
  });

  /**
   * Move a card. The client sends the destination column and the ids of the
   * cards it was dropped between; the server derives a fractional position and
   * validates the workflow transition.
   */
  app.post('/api/projects/:projectId/board/move', async (request) => {
    const projectId = projectIdOf(request);
    const body = request.body as {
      issueId?: unknown;
      toStatusId?: unknown;
      beforeIssueId?: unknown;
      afterIssueId?: unknown;
    };

    const ctx = requireAuth(request);
    requirePermission(request, 'issue.transition', projectId);

    const issueId = parseId(body.issueId, 'issue');
    const toStatusId = parseId(body.toStatusId, 'status');

    // Moving a card implies permission to edit it too.
    const editDecision = can(ctx.actor, 'issue.update', { projectId });
    if (!editDecision.allowed) throw forbidden(editDecision.reason);

    const board = ctx.services.issues.moveOnBoard({
      issueId,
      toStatusId,
      beforeIssueId: body.beforeIssueId === null || body.beforeIssueId === undefined ? null : parseId(body.beforeIssueId, 'issue'),
      afterIssueId: body.afterIssueId === null || body.afterIssueId === undefined ? null : parseId(body.afterIssueId, 'issue'),
      actorId: Number(ctx.actor.userId),
    });

    return { board };
  });
};

export default projectRoutes;
