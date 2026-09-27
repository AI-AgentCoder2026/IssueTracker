/**
 * Version-control linkage routes: repositories, per-issue references, and the
 * branch-name rules that infer links automatically.
 */

import {
  createBranchLinkRuleSchema,
  createReferenceSchema,
  createRepositorySchema,
  parseIssueKeyFromRef,
  updateReferenceSchema,
  type ReferenceKind,
} from '@tracker/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { API } from '@tracker/shared';
import { badRequest } from '../errors.ts';
import { parseId } from '../services/context.ts';
import { requireAuth, requirePermission } from '../plugins/auth.plugin.ts';

const projectIdOf = (params: unknown): number =>
  parseId((params as { projectId: string }).projectId, 'project');

export const versionControlRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // -- repositories --------------------------------------------------------
  app.get(API.versionControl.repositories, async (request) => {
    const projectId = projectIdOf(request.params);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return {
      repositories: ctx.services.versionControl.listRepositories(projectId),
      rules: ctx.services.versionControl.listRules(projectId),
    };
  });

  app.post(API.versionControl.createRepository, async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const input = createRepositorySchema.parse(request.body);
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings', projectId);

    const repository = ctx.services.versionControl.createRepository(projectId, input, ctx.auditContext);
    return reply.status(201).send({ repository });
  });

  app.delete(API.versionControl.removeRepository, async (request) => {
    const params = request.params as { projectId: string; id: string };
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings', parseId(params.projectId, 'project'));
    ctx.services.versionControl.removeRepository(
      parseId(params.projectId, 'project'),
      parseId(params.id, 'repository'),
      ctx.auditContext,
    );
    return { deleted: true };
  });

  // -- project-wide view ---------------------------------------------------
  app.get(API.versionControl.projectReferences, async (request) => {
    const projectId = projectIdOf(request.params);
    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);
    return { references: ctx.services.versionControl.listForProject(projectId) };
  });

  // -- per-issue references ------------------------------------------------
  app.get(API.issues.references, async (request) => {
    const params = request.params as { issueId: string };
    const issueId = parseId(params.issueId, 'issue');
    const ctx = requireAuth(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));

    const query = request.query as { kind?: string };
    return {
      references: ctx.services.versionControl.listForIssue(issueId, {
        kind: query.kind as ReferenceKind | undefined,
      }),
      summary: ctx.services.versionControl.summary(issueId),
    };
  });

  app.post(API.issues.addReference, async (request, reply) => {
    const params = request.params as { issueId: string };
    const issueId = parseId(params.issueId, 'issue');
    const input = createReferenceSchema.parse(request.body);
    const ctx = requireAuth(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.update', Number(issue.projectId));

    const reference = ctx.services.versionControl.addReference(
      issueId,
      input,
      Number(ctx.actor.userId),
      ctx.auditContext,
    );
    return reply.status(201).send({ reference });
  });

  app.patch(API.issues.updateReference, async (request) => {
    const params = request.params as { issueId: string; id: string };
    const issueId = parseId(params.issueId, 'issue');
    const referenceId = parseId(params.id, 'reference');
    const patch = updateReferenceSchema.parse(request.body);
    const ctx = requireAuth(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.update', Number(issue.projectId));

    return {
      reference: ctx.services.versionControl.updateReference(
        issueId,
        referenceId,
        patch,
        Number(ctx.actor.userId),
        ctx.auditContext,
      ),
    };
  });

  app.delete(API.issues.removeReference, async (request) => {
    const params = request.params as { issueId: string; id: string };
    const issueId = parseId(params.issueId, 'issue');
    const referenceId = parseId(params.id, 'reference');
    const ctx = requireAuth(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.update', Number(issue.projectId));

    ctx.services.versionControl.removeReference(
      issueId,
      referenceId,
      Number(ctx.actor.userId),
      ctx.auditContext,
    );
    return { deleted: true };
  });

  app.get(API.issues.linkageSummary, async (request) => {
    const params = request.params as { issueId: string };
    const issueId = parseId(params.issueId, 'issue');
    const ctx = requireAuth(request);
    const issue = ctx.services.issues.getById(issueId);
    requirePermission(request, 'issue.read', Number(issue.projectId));
    return ctx.services.versionControl.summary(issueId);
  });

  // -- branch naming rules -------------------------------------------------
  app.post(API.versionControl.createBranchRule, async (request, reply) => {
    const params = request.params as { projectId: string; id: string };
    const projectId = parseId(params.projectId, 'project');
    const repositoryId = parseId(params.id, 'repository');

    // `repositoryId` is supplied by the path. It is merged into the body before
    // validation so the schema still sees a complete, checkable input rather
    // than being told a required field is missing.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = createBranchLinkRuleSchema.parse({ ...body, repositoryId });

    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings', projectId);

    const rule = ctx.services.versionControl.createRule(
      projectId,
      { ...input, repositoryId },
      ctx.auditContext,
    );
    return reply.status(201).send({ rule });
  });

  app.delete(API.versionControl.removeBranchRule, async (request) => {
    const params = request.params as { projectId: string; id: string; ruleId: string };
    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings', parseId(params.projectId, 'project'));
    ctx.services.versionControl.removeRule(
      parseId(params.projectId, 'project'),
      parseId(params.ruleId, 'rule'),
      ctx.auditContext,
    );
    return { deleted: true };
  });

  /**
   * Import branch names for inference.
   *
   * Accepts the branch list from a client or a webhook rather than calling the
   * provider itself, so the same code path serves both a manual "rescan" and an
   * automatic one.
   */
  app.post(API.versionControl.importBranches, async (request) => {
    const params = request.params as { projectId: string; id: string };
    const projectId = parseId(params.projectId, 'project');
    const body = request.body as { branches?: unknown } | undefined;
    const branches = Array.isArray(body?.branches) ? body.branches : [];

    if (branches.length > 2000) {
      throw badRequest('At most 2000 branches can be imported in one pass');
    }

    const ctx = requireAuth(request);
    requirePermission(request, 'instance.settings', projectId);

    // Validate shape here so the service can stay free of defensive parsing.
    const parsed = branches.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw badRequest(`Branch at index ${index} is not an object`);
      }
      const record = entry as Record<string, unknown>;
      if (typeof record['name'] !== 'string' || record['name'].trim().length === 0) {
        throw badRequest(`Branch at index ${index} has no name`);
      }
      return {
        name: record['name'].trim().slice(0, 400),
        headSha: typeof record['headSha'] === 'string' ? record['headSha'].slice(0, 64) : null,
        url: typeof record['url'] === 'string' ? record['url'].slice(0, 1000) : null,
      };
    });

    return {
      result: ctx.services.versionControl.importBranches(
        parseId(params.id, 'repository'),
        parsed,
        ctx.auditContext,
      ),
    };
  });

  /**
   * Dry-run the naming rules against a single branch name. Exposed so the UI
   * can show a developer what a branch name will resolve to before they push.
   */
  app.post(API.versionControl.branchRules + '/preview', async (request) => {
    const params = request.params as { projectId: string; id: string };
    const projectId = parseId(params.projectId, 'project');
    const body = request.body as { branch?: unknown };
    const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';

    const ctx = requireAuth(request);
    requirePermission(request, 'project.read', projectId);

    if (branch.length === 0) throw badRequest('A branch name is required');

    const rules = ctx.services.versionControl
      .listRules(projectId)
      .filter((rule) => rule.repositoryId === parseId(params.id, 'repository') && rule.enabled);

    const issueKey = rules.length
      ? parseIssueKeyFromRef(branch, rules[0] as { pattern: string; stripPrefixes: readonly string[] })
      : null;

    const issue = issueKey
      ? ctx.services.db.get<{ id: number; title: string }>(
          'SELECT id, title FROM issues WHERE project_id = ? AND key = ?',
          [projectId, issueKey],
        )
      : undefined;

    return {
      branch,
      issueKey,
      matchedRule: rules.length > 0 ? rules[0]?.id ?? null : null,
      issue: issue ? { id: issue.id, key: issueKey, title: issue.title } : null,
    };
  });
};

export default versionControlRoutes;
