/**
 * Version-control linkage service.
 *
 * Links issues to the artefacts of the work — branches, commits, merge
 * requests, tags — and can infer links from a branch naming convention so a
 * developer who opens `feature/PROJ-42-add-login` gets the linkage for free.
 *
 * Two things this deliberately does *not* do:
 *
 *  * It never treats a ref as trustworthy input. Every stored `url` is
 *    validated to be `http(s)` at the edge, because it is later rendered as an
 *    anchor `href` and a `javascript:` value would be an XSS sink.
 *  * It does not delete references when a branch disappears. A closed branch is
 *    still evidence of work; the sync marks it rather than removing it.
 */

import {
  isTerminalReferenceState,
  parseIssueKeyFromRef,
  type BranchImportResult,
  type BranchLinkRule,
  type CreateBranchLinkRuleInput,
  type CreateReferenceInput,
  type CreateRepositoryInput,
  type IssueLinkageSummary,
  type IssueReference,
  type IssueReferenceView,
  type ReferenceKind,
  type ReferenceState,
  type Repository,
  type VcsProvider,
} from '@tracker/shared';
import { badRequest, conflict, notFound } from '../errors.ts';
import { placeholders, type Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';
import type { RequestAuditContext, Services } from './context.ts';

/** Cap on a single import pass so a large repository cannot stall a sync. */
const MAX_BRANCHES_PER_IMPORT = 1000;

export class VersionControlService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  private get db(): Database {
    return this.services.db;
  }

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------

  listRepositories(projectId: number): Repository[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM project_repositories WHERE project_id = ? ORDER BY provider, name',
        [projectId],
      )
      .map((row) => this.mapRepository(row));
  }

  getRepository(repositoryId: number): Repository {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM project_repositories WHERE id = ?',
      [repositoryId],
    );
    if (!row) throw notFound('Repository', repositoryId);
    return this.mapRepository(row);
  }

  createRepository(
    projectId: number,
    input: CreateRepositoryInput,
    ctx: RequestAuditContext = {},
  ): Repository {
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM project_repositories WHERE project_id = ? AND provider = ? AND name = ?',
      [projectId, input.provider, input.name],
    );
    if (existing) {
      throw conflict(`A ${input.provider} repository named "${input.name}" already exists`, {
        repositoryId: existing.id,
      });
    }

    const id = Number(
      this.db.run(
        `INSERT INTO project_repositories
           (project_id, provider, name, base_url, external_id, default_branch)
         VALUES (?,?,?,?,?,?)`,
        [projectId, input.provider, input.name, input.baseUrl, input.externalId, input.defaultBranch],
      ).lastInsertRowid,
    );

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'repository',
        entityId: id,
        projectId,
        actorId: ctx.actorId,
        after: { provider: input.provider, name: input.name, defaultBranch: input.defaultBranch },
      },
      ctx,
    );

    return this.getRepository(id);
  }

  removeRepository(projectId: number, repositoryId: number, ctx: RequestAuditContext = {}): void {
    const before = this.db.get<Record<string, unknown>>(
      'SELECT * FROM project_repositories WHERE id = ? AND project_id = ?',
      [repositoryId, projectId],
    );
    if (!before) throw notFound('Repository', repositoryId);

    this.db.run('DELETE FROM project_repositories WHERE id = ?', [repositoryId]);
    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'repository',
        entityId: repositoryId,
        projectId,
        actorId: ctx.actorId,
        before: this.mapRepository(before) as unknown as Record<string, unknown>,
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------

  /**
   * Attach a reference to an issue.
   *
   * A branch belongs to exactly one issue: two issues claiming the same branch
   * is a genuine data conflict, not a convenience case, so it is rejected.
   */
  addReference(
    issueId: number,
    input: CreateReferenceInput,
    actorId: number,
    ctx: RequestAuditContext = {},
    options: { autoDetected?: boolean } = {},
  ): IssueReference {
    const issue = this.services.issues.getById(issueId);
    const projectId = Number(issue.projectId);

    // A repository from another project would make the linkage unreachable and
    // leak the wrong project's names into this issue's page.
    const repository = this.db.get<{ id: number; project_id: number }>(
      'SELECT id, project_id FROM project_repositories WHERE id = ?',
      [input.repositoryId],
    );
    if (!repository) throw notFound('Repository', input.repositoryId);
    if (Number(repository.project_id) !== projectId) {
      throw badRequest('That repository belongs to a different project');
    }

    const duplicate = this.db.get<{ id: number }>(
      'SELECT id FROM issue_references WHERE repository_id = ? AND kind = ? AND ref = ?',
      [input.repositoryId, input.kind, input.ref],
    );
    if (duplicate) {
      // Re-linking the same ref to the same issue is a no-op, not an error:
      // a sync will legitimately rediscover it on every pass.
      const existingIssue = this.db.get<{ issue_id: number }>(
        'SELECT issue_id FROM issue_references WHERE id = ?',
        [duplicate.id],
      );
      if (existingIssue && Number(existingIssue.issue_id) === issueId) {
        return this.getReference(duplicate.id);
      }
      throw conflict(
        `A ${input.kind} named "${input.ref}" is already linked to another issue`,
        { referenceId: duplicate.id, issueId: existingIssue?.issue_id },
      );
    }

    const at = nowIso();
    const id = Number(
      this.db.run(
        `INSERT INTO issue_references
           (issue_id, repository_id, kind, provider, ref, head_sha, title, state, url,
            auto_detected, linked_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          issueId,
          input.repositoryId,
          input.kind,
          this.getRepository(input.repositoryId).provider,
          input.ref,
          input.headSha,
          input.title || (input.ref.length > 120 ? `${input.ref.slice(0, 117)}...` : input.ref),
          input.state,
          input.url,
          options.autoDetected ? 1 : 0,
          actorId,
          at,
          at,
        ],
      ).lastInsertRowid,
    );

    if (!options.autoDetected) {
      this.services.activity.record({
        issueId,
        projectId,
        actorId,
        type: 'issue.linked',
        summary: `linked ${input.kind.replace('_', ' ')} "${input.ref}"`,
        metadata: { referenceId: id, kind: input.kind, ref: input.ref },
      });
    }

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue_reference',
        entityId: id,
        projectId,
        actorId,
        after: { issueId, kind: input.kind, ref: input.ref, autoDetected: options.autoDetected ?? false },
      },
      ctx,
    );

    return this.getReference(id);
  }

  /**
   * Create or refresh a reference during a sync.
   *
   * Returns whether the row is new, so the caller can report accurate counts
   * without re-querying.
   */
  upsertReference(input: {
    issueId: number;
    repositoryId: number;
    kind: ReferenceKind;
    ref: string;
    headSha?: string | null;
    title?: string;
    state?: ReferenceState;
    url?: string | null;
  }): { reference: IssueReference; created: boolean } {
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM issue_references WHERE repository_id = ? AND kind = ? AND ref = ?',
      [input.repositoryId, input.kind, input.ref],
    );

    if (existing) {
      this.db.run(
        'UPDATE issue_references SET head_sha = ?, title = ?, state = ?, url = ?, updated_at = ? WHERE id = ?',
        [
          input.headSha ?? null,
          input.title ?? '',
          input.state ?? 'open',
          input.url ?? null,
          nowIso(),
          existing.id,
        ],
      );
      return { reference: this.getReference(existing.id), created: false };
    }

    const issue = this.services.issues.getById(input.issueId);
    const repository = this.getRepository(input.repositoryId);
    const at = nowIso();
    const id = Number(
      this.db.run(
        `INSERT INTO issue_references
           (issue_id, repository_id, kind, provider, ref, head_sha, title, state, url,
            auto_detected, linked_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,NULL,?,?)`,
        [
          input.issueId,
          input.repositoryId,
          input.kind,
          repository.provider,
          input.ref,
          input.headSha ?? null,
          input.title ?? input.ref,
          input.state ?? 'open',
          input.url ?? null,
          at,
          at,
        ],
      ).lastInsertRowid,
    );

    // An auto-detected link is still worth a timeline line the first time.
    if (repository.provider !== 'generic') {
      this.services.activity.record({
        issueId: input.issueId,
        projectId: Number(issue.projectId),
        actorId: null,
        type: 'issue.linked',
        summary: `linked ${input.kind.replace('_', ' ')} "${input.ref}" automatically`,
        metadata: { referenceId: id, kind: input.kind, ref: input.ref, autoDetected: true },
        isSystemGenerated: true,
      });
    }

    return { reference: this.getReference(id), created: true };
  }

  updateReference(
    issueId: number,
    referenceId: number,
    patch: { title?: string; state?: ReferenceState; headSha?: string | null; url?: string | null },
    actorId: number,
    ctx: RequestAuditContext = {},
  ): IssueReference {
    const before = this.getReference(referenceId);
    if (before.issueId !== issueId) throw notFound('Issue reference', referenceId);

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    const assign = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.state !== undefined) assign('state', patch.state);
    if (patch.headSha !== undefined) assign('head_sha', patch.headSha);
    if (patch.url !== undefined) assign('url', patch.url);

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), referenceId);
      this.db.run(`UPDATE issue_references SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const after = this.getReference(referenceId);
    if (after.state !== before.state) {
      const issue = this.services.issues.getById(issueId);
      this.services.activity.record({
        issueId,
        projectId: Number(issue.projectId),
        actorId,
        type: 'issue.linked',
        summary: `marked ${after.kind.replace('_', ' ')} "${after.ref}" as ${after.state}`,
        metadata: { referenceId, from: before.state, to: after.state },
      });
    }

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue_reference',
        entityId: referenceId,
        projectId: this.projectIdForIssue(issueId),
        actorId,
        before: { state: before.state, title: before.title },
        after: { state: after.state, title: after.title },
      },
      ctx,
    );

    return after;
  }

  removeReference(issueId: number, referenceId: number, actorId: number, ctx: RequestAuditContext = {}): void {
    const before = this.getReference(referenceId);
    if (before.issueId !== issueId) throw notFound('Issue reference', referenceId);

    this.db.run('DELETE FROM issue_references WHERE id = ?', [referenceId]);

    const projectId = this.projectIdForIssue(issueId);
    this.services.activity.record({
      issueId,
      projectId,
      actorId,
      type: 'issue.unlinked',
      summary: `unlinked ${before.kind.replace('_', ' ')} "${before.ref}"`,
      metadata: { referenceId, kind: before.kind },
    });

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'issue_reference',
        entityId: referenceId,
        projectId,
        actorId,
        before: { kind: before.kind, ref: before.ref },
      },
      ctx,
    );
  }

  getReference(referenceId: number): IssueReference {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM issue_references WHERE id = ?',
      [referenceId],
    );
    if (!row) throw notFound('Issue reference', referenceId);
    return this.mapReference(row);
  }

  /** References for one issue, joined with the fields the UI renders. */
  listForIssue(issueId: number, options: { kind?: ReferenceKind } = {}): IssueReferenceView[] {
    const clauses = ['r.issue_id = ?'];
    const params: Array<string | number> = [issueId];
    if (options.kind) {
      clauses.push('r.kind = ?');
      params.push(options.kind);
    }

    const rows = this.db.all<Record<string, unknown>>(
      `SELECT r.*, repo.name AS repository_name, repo.provider AS repository_provider,
              i.key AS issue_key, i.title AS issue_title
       FROM issue_references r
       JOIN project_repositories repo ON repo.id = r.repository_id
       JOIN issues i ON i.id = r.issue_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.kind, r.updated_at DESC`,
      params,
    );

    return rows.map((row) => ({
      ...this.mapReference(row),
      repositoryName: String(row.repository_name ?? ''),
      repositoryProvider: String(row.repository_provider ?? 'generic') as VcsProvider,
      issueKey: String(row.issue_key ?? ''),
      issueTitle: String(row.issue_title ?? ''),
      isMerged: isTerminalReferenceState(String(row.state) as ReferenceState),
    }));
  }

  /** Aggregate counts for the issue header badge. */
  summary(issueId: number): IssueLinkageSummary {
    const rows = this.db.all<{ kind: string; state: string; id: number; ref: string; url: string | null; updated_at: string }>(
      'SELECT kind, state, id, ref, url, updated_at FROM issue_references WHERE issue_id = ? ORDER BY updated_at DESC',
      [issueId],
    );

    const count = (kind: ReferenceKind): number => rows.filter((row) => row.kind === kind).length;
    const latest = rows[0];

    return {
      issueId,
      branches: count('branch'),
      commits: count('commit'),
      mergeRequests: count('merge_request') + count('pull_request'),
      merged: rows.filter((row) => isTerminalReferenceState(row.state as ReferenceState)).length,
      latest: latest
        ? { id: latest.id, kind: latest.kind as ReferenceKind, ref: latest.ref, url: latest.url }
        : null,
    };
  }

  /**
   * Repository-wide view, used by the project "development" panel.
   */
  listForProject(projectId: number): Array<IssueReferenceView & { referenceCount: number }> {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT r.*, repo.name AS repository_name, repo.provider AS repository_provider,
              i.key AS issue_key, i.title AS issue_title
       FROM issue_references r
       JOIN project_repositories repo ON repo.id = r.repository_id
       JOIN issues i ON i.id = r.issue_id
       WHERE i.project_id = ?
       ORDER BY r.updated_at DESC
       LIMIT 200`,
      [projectId],
    );

    const counts = new Map<number, number>();
    for (const row of this.db.all<{ repository_id: number; count: number }>(
      'SELECT repository_id, COUNT(*) AS count FROM issue_references GROUP BY repository_id',
    )) {
      counts.set(Number(row.repository_id), Number(row.count));
    }

    return rows.map((row) => ({
      ...this.mapReference(row),
      repositoryName: String(row.repository_name ?? ''),
      repositoryProvider: String(row.repository_provider ?? 'generic') as VcsProvider,
      issueKey: String(row.issue_key ?? ''),
      issueTitle: String(row.issue_title ?? ''),
      isMerged: isTerminalReferenceState(String(row.state) as ReferenceState),
      referenceCount: counts.get(Number(row.repository_id)) ?? 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Branch naming rules
  // -------------------------------------------------------------------------

  listRules(projectId: number): BranchLinkRule[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM branch_link_rules WHERE project_id = ? ORDER BY id', [projectId])
      .map((row) => this.mapRule(row));
  }

  createRule(
    projectId: number,
    input: CreateBranchLinkRuleInput,
    ctx: RequestAuditContext = {},
  ): BranchLinkRule {
    const repository = this.db.get<{ id: number; project_id: number }>(
      'SELECT id, project_id FROM project_repositories WHERE id = ?',
      [input.repositoryId],
    );
    if (!repository) throw notFound('Repository', input.repositoryId);
    if (Number(repository.project_id) !== projectId) {
      throw badRequest('That repository belongs to a different project');
    }

    const id = Number(
      this.db.run(
        `INSERT INTO branch_link_rules (project_id, repository_id, pattern, strip_prefixes, enabled)
         VALUES (?,?,?,?,?)`,
        [projectId, input.repositoryId, input.pattern, JSON.stringify(input.stripPrefixes), input.enabled ? 1 : 0],
      ).lastInsertRowid,
    );

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'branch_link_rule',
        entityId: id,
        projectId,
        actorId: ctx.actorId,
        after: { repositoryId: input.repositoryId, pattern: input.pattern },
      },
      ctx,
    );

    return this.mapRule(
      this.db.get<Record<string, unknown>>('SELECT * FROM branch_link_rules WHERE id = ?', [id]) as Record<
        string,
        unknown
      >,
    );
  }

  removeRule(projectId: number, ruleId: number, ctx: RequestAuditContext = {}): void {
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM branch_link_rules WHERE id = ? AND project_id = ?',
      [ruleId, projectId],
    );
    if (!existing) throw notFound('Branch link rule', ruleId);
    this.db.run('DELETE FROM branch_link_rules WHERE id = ?', [ruleId]);
    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'branch_link_rule',
        entityId: ruleId,
        projectId,
        actorId: ctx.actorId,
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  /**
   * Link branches to issues by name convention.
   *
   * A branch whose extracted key names no local issue is reported in
   * `unresolved` rather than being dropped — that list is how a team discovers
   * a typo in a branch name.
   */
  importBranches(
    repositoryId: number,
    branches: Array<{ name: string; headSha?: string | null; url?: string | null }>,
    ctx: RequestAuditContext = {},
  ): BranchImportResult {
    const result: BranchImportResult = { scanned: 0, linked: 0, updated: 0, unresolved: [], skipped: [] };
    const rules = this.db
      .all<Record<string, unknown>>('SELECT * FROM branch_link_rules WHERE repository_id = ? AND enabled = 1', [
        repositoryId,
      ])
      .map((row) => this.mapRule(row));

    if (rules.length === 0) return result;

    const repository = this.getRepository(repositoryId);
    const capped = branches.slice(0, MAX_BRANCHES_PER_IMPORT);

    for (const branch of capped) {
      result.scanned += 1;

      let issueKey: string | null = null;
      for (const rule of rules) {
        const candidate = parseIssueKeyFromRef(branch.name, rule);
        if (candidate) {
          issueKey = candidate;
          break;
        }
      }

      if (!issueKey) {
        result.skipped.push({ branch: branch.name, reason: 'no rule matched the branch name' });
        continue;
      }

      const issue = this.db.get<{ id: number }>(
        'SELECT id FROM issues WHERE project_id = ? AND key = ?',
        [repository.projectId, issueKey],
      );
      if (!issue) {
        result.unresolved.push({ branch: branch.name, issueKey });
        continue;
      }

      try {
        const { created } = this.upsertReference({
          issueId: Number(issue.id),
          repositoryId,
          kind: 'branch',
          ref: branch.name,
          headSha: branch.headSha ?? null,
          title: branch.name,
          state: 'open',
          url: branch.url ?? null,
        });
        if (created) result.linked += 1;
        else result.updated += 1;
      } catch (error) {
        // One bad branch must not abort the pass.
        result.skipped.push({ branch: branch.name, reason: (error as Error).message });
      }
    }

    this.db.run('UPDATE branch_link_rules SET last_imported_at = ? WHERE repository_id = ?', [
      nowIso(),
      repositoryId,
    ]);

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'branch_import',
        entityId: repositoryId,
        projectId: repository.projectId,
        actorId: ctx.actorId,
        after: {
          scanned: result.scanned,
          linked: result.linked,
          updated: result.updated,
          unresolved: result.unresolved.length,
          skipped: result.skipped.length,
        },
      },
      ctx,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private projectIdForIssue(issueId: number): number {
    const row = this.db.get<{ project_id: number }>('SELECT project_id FROM issues WHERE id = ?', [issueId]);
    if (!row) throw notFound('Issue', issueId);
    return Number(row.project_id);
  }

  private mapRepository(row: Record<string, unknown>): Repository {
    return {
      id: Number(row.id),
      projectId: Number(row.project_id) as Repository['projectId'],
      provider: String(row.provider ?? 'generic') as VcsProvider,
      name: String(row.name),
      baseUrl: String(row.base_url ?? ''),
      externalId: row.external_id === null ? null : String(row.external_id),
      defaultBranch: String(row.default_branch ?? 'main'),
      gitlabConnectionId:
        row.gitlab_connection_id === null ? null : Number(row.gitlab_connection_id),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private mapReference(row: Record<string, unknown>): IssueReference {
    return {
      id: Number(row.id),
      issueId: Number(row.issue_id),
      repositoryId: Number(row.repository_id),
      kind: String(row.kind) as ReferenceKind,
      provider: String(row.provider ?? 'generic') as VcsProvider,
      ref: String(row.ref),
      headSha: row.head_sha === null ? null : String(row.head_sha),
      title: String(row.title ?? ''),
      state: String(row.state ?? 'open') as ReferenceState,
      url: row.url === null ? null : String(row.url),
      autoDetected: Number(row.auto_detected) === 1,
      linkedBy: row.linked_by === null ? null : (Number(row.linked_by) as IssueReference['linkedBy']),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private mapRule(row: Record<string, unknown>): BranchLinkRule {
    let stripPrefixes: string[] = [];
    if (typeof row.strip_prefixes === 'string') {
      try {
        const parsed = JSON.parse(row.strip_prefixes) as unknown;
        if (Array.isArray(parsed)) stripPrefixes = parsed.map(String);
      } catch {
        stripPrefixes = [];
      }
    }

    return {
      id: Number(row.id),
      projectId: Number(row.project_id) as BranchLinkRule['projectId'],
      repositoryId: Number(row.repository_id),
      pattern: String(row.pattern),
      stripPrefixes,
      enabled: Number(row.enabled) === 1,
      lastImportedAt: row.last_imported_at === null ? null : String(row.last_imported_at),
    };
  }
}
