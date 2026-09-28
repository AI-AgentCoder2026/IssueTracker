/**
 * Project service: creation with its dependent records, membership, labels and
 * milestones, and per-project statistics.
 *
 * Creating a project is the one place that must fan out across many tables, so
 * it runs in a single transaction: workflow + statuses + transitions, default
 * labels, default dashboards. A half-created project is worse than none.
 */

import {
  ROLE_RANK,
  type CreateLabelInput,
  type CreateMilestoneInput,
  type CreateProjectInput,
  type Label,
  type Milestone,
  type Project,
  type Role,
  type UpdateProjectInput,
} from '@tracker/shared';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';
import type { RequestAuditContext, Services } from './context.ts';
/** Labels every new project starts with, so triage can begin immediately. */
const DEFAULT_LABELS: ReadonlyArray<Omit<CreateLabelInput, 'description'>> = [
  { name: 'Bug', color: '#ef4444' },
  { name: 'Feature', color: '#3b82f6' },
  { name: 'Documentation', color: '#8b5cf6' },
  { name: 'Technical debt', color: '#f59e0b' },
  { name: 'Good first issue', color: '#10b981' },
];

export interface ProjectStats {
  projectId: number;
  totalIssues: number;
  openIssues: number;
  closedIssues: number;
  archivedIssues: number;
  overdueIssues: number;
  unassignedIssues: number;
  issuesByState: Array<{ state: string; count: number }>;
  issuesByPriority: Array<{ priority: string; count: number }>;
  issuesByType: Array<{ type: string; count: number }>;
  memberCount: number;
  commentCount: number;
  /** Issues created per day for the last 30 days, oldest first. */
  createdTrend: Array<{ date: string; count: number }>;
}

export class ProjectService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }
  private get db(): Database {
    return this.services.db;
  }

  /**
   * Create a project and everything a usable project needs.
   *
   * The creator is inserted as `owner` so they retain full control without
   * needing a separate invitation step.
   */
  create(
    input: CreateProjectInput,
    actorId: number,
    ctx: RequestAuditContext = {},
  ): Project {
    const existing = this.db.get<{ id: number }>('SELECT id FROM projects WHERE key = ?', [input.key]);
    if (existing) {
      throw conflict(`A project with the key "${input.key}" already exists`, { key: input.key });
    }

    const projectId = this.db.transaction(() => {
      const id = Number(
        this.db.run(
          `INSERT INTO projects
             (key, name, description, visibility, default_issue_type, default_priority,
              next_issue_number, source_of_truth, archive_policy, created_by)
           VALUES (?,?,?,?,?,?,1,'local',?,?)`,
          [
            input.key,
            input.name,
            input.description,
            input.visibility,
            input.defaultIssueType,
            input.defaultPriority,
            input.archivePolicy === null ? null : JSON.stringify(input.archivePolicy),
            actorId,
          ],
        ).lastInsertRowid,
      );

      this.db.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)',
        [id, actorId, 'owner'],
      );

      this.services.workflow.provisionDefaultWorkflow(id);

      for (const label of DEFAULT_LABELS) {
        this.db.run(
          'INSERT INTO labels (project_id, name, slug, color) VALUES (?,?,?,?)',
          [id, label.name, slugify(label.name), label.color],
        );
      }

      return id;
    });

    // Dashboards are provisioned outside the transaction: another agent owns
    // that service, and it is safe to retry if it fails.
    try {
      this.services.dashboards.provisionDefaultDashboards(projectId, {
        actorId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    } catch (error) {
      // A missing dashboard must not lose the project; the UI can retry.
      this.services.realtime.publish({
        event: 'error',
        projectId,
        data: { scope: 'dashboard.provision', message: (error as Error).message },
      });
    }

    this.services.audit.record(
      {
        action: 'project.created',
        entityType: 'project',
        entityId: projectId,
        projectId,
        actorId,
        after: { key: input.key, name: input.name, visibility: input.visibility },
      },
      ctx,
    );

    return this.getById(projectId);
  }

  getById(projectId: number): Project {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!row) throw notFound('Project', projectId);
    return this.mapProject(row);
  }

  findByKey(key: string): Project | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM projects WHERE key = ?', [key]);
    return row ? this.mapProject(row) : null;
  }

  /**
   * Projects the actor can see: everything they are a member of, plus public
   * projects. Instance admins see all.
   */
  listVisible(actor: { isInstanceAdmin: boolean; userId: number }): Project[] {
    if (actor.isInstanceAdmin) {
      return this.db
        .all<Record<string, unknown>>('SELECT * FROM projects ORDER BY name ASC')
        .map((row) => this.mapProject(row));
    }

    return this.db
      .all<Record<string, unknown>>(
        `SELECT p.* FROM projects p
         LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
         WHERE m.user_id IS NOT NULL OR p.visibility = 'public'
         ORDER BY p.name ASC`,
        [actor.userId],
      )
      .map((row) => this.mapProject(row));
  }

  update(
    projectId: number,
    input: UpdateProjectInput,
    ctx: RequestAuditContext = {},
  ): Project {
    const before = this.getById(projectId);

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    const assign = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value as string | number | null);
    };

    if (input.name !== undefined) assign('name', input.name);
    if (input.description !== undefined) assign('description', input.description);
    if (input.visibility !== undefined) assign('visibility', input.visibility);
    if (input.defaultIssueType !== undefined) assign('default_issue_type', input.defaultIssueType);
    if (input.defaultPriority !== undefined) assign('default_priority', input.defaultPriority);
    if (input.sourceOfTruth !== undefined) assign('source_of_truth', input.sourceOfTruth);
    if (input.archivePolicy !== undefined) {
      assign('archive_policy', input.archivePolicy === null ? null : JSON.stringify(input.archivePolicy));
    }

    if (sets.length === 0) return before;

    sets.push('updated_at = ?');
    params.push(nowIso(), projectId);

    this.db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = this.getById(projectId);

    this.services.audit.record(
      {
        action: 'project.updated',
        entityType: 'project',
        entityId: projectId,
        projectId,
        actorId: ctx.actorId,
        before: { ...before, archivePolicy: before.archivePolicy },
        after: { ...after, archivePolicy: after.archivePolicy },
      },
      ctx,
    );

    return after;
  }

  remove(projectId: number, ctx: RequestAuditContext = {}): void {
    const before = this.getById(projectId);
    // Issues, comments, workflows and integrations cascade from the project.
    this.db.run('DELETE FROM projects WHERE id = ?', [projectId]);
    this.services.audit.record(
      {
        action: 'project.deleted',
        entityType: 'project',
        entityId: projectId,
        projectId,
        actorId: ctx.actorId,
        before: { key: before.key, name: before.name },
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  listMembers(projectId: number): Array<{ userId: number; role: Role; user: Record<string, unknown> }> {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT m.user_id, m.role, m.created_at,
                u.username, u.display_name, u.email, u.avatar_url, u.is_active, u.last_login_at
         FROM project_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY m.role ASC, u.display_name ASC`,
        [projectId],
      )
      .map((row) => ({
        userId: Number(row.user_id),
        role: String(row.role) as Role,
        user: {
          id: Number(row.user_id),
          username: String(row.username),
          displayName: String(row.display_name),
          email: String(row.email),
          avatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
          isActive: Number(row.is_active) === 1,
          lastLoginAt: row.last_login_at === null ? null : String(row.last_login_at),
        },
      }));
  }

  /**
   * Add or update a member. Roles are ordered, so a change is only rejected
   * when it would demote someone above the actor's own rank — that prevents an
   * admin from silently stripping an owner.
   */
  setMemberRole(
    projectId: number,
    userId: number,
    role: Role,
    ctx: RequestAuditContext & { actorRole?: Role } = {},
  ): void {
    const target = this.db.get<{ id: number; role: string }>(
      'SELECT id, role FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, userId],
    );

    // Adding a member that does not exist would otherwise fail on the
    // `project_members.user_id` foreign key, which surfaces as an opaque
    // database error instead of naming the thing that is missing.
    if (!target) {
      const user = this.db.get<{ id: number }>('SELECT id FROM users WHERE id = ?', [userId]);
      if (!user) throw notFound('User', userId);
    }

    if (ctx.actorRole && ROLE_RANK[ctx.actorRole] < ROLE_RANK[role]) {
      throw forbidden(`Your role cannot grant "${role}" — it outranks you`);
    }
    if (target && ctx.actorRole && ROLE_RANK[ctx.actorRole] < ROLE_RANK[target.role as Role]) {
      throw forbidden('You cannot change the role of someone who outranks you');
    }

    const before = target ? { role: target.role } : null;

    if (target) {
      this.db.run(
        'UPDATE project_members SET role = ?, updated_at = ? WHERE id = ?',
        [role, nowIso(), target.id],
      );
    } else {
      this.db.run('INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)', [
        projectId,
        userId,
        role,
      ]);
    }

    this.services.audit.record(
      {
        action: before ? 'member.role_changed' : 'member.added',
        entityType: 'project_member',
        entityId: `${projectId}:${userId}`,
        projectId,
        actorId: ctx.actorId,
        before,
        after: { role },
      },
      ctx,
    );
  }

  removeMember(projectId: number, userId: number, ctx: RequestAuditContext = {}): void {
    const existing = this.db.get<{ id: number; role: string }>(
      'SELECT id, role FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, userId],
    );
    if (!existing) throw notFound('Project member', userId);

    if (existing.role === 'owner') {
      const owners = Number(
        this.db.scalar<number>(
          "SELECT COUNT(*) AS c FROM project_members WHERE project_id = ? AND role = 'owner'",
          [projectId],
        ) ?? 0,
      );
      // Removing the last owner would orphan the project permanently.
      if (owners <= 1) {
        throw conflict('A project must keep at least one owner', { projectId });
      }
    }

    this.db.run('DELETE FROM project_members WHERE id = ?', [existing.id]);
    this.services.audit.record(
      {
        action: 'member.removed',
        entityType: 'project_member',
        entityId: `${projectId}:${userId}`,
        projectId,
        actorId: ctx.actorId,
        before: { role: existing.role },
      },
      ctx,
    );
  }

  /** Projects a user belongs to, as an id set for permission filtering. */
  projectIdsForUser(userId: number): number[] {
    return this.db
      .all<{ project_id: number }>('SELECT project_id FROM project_members WHERE user_id = ?', [userId])
      .map((row) => Number(row.project_id));
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  listLabels(projectId: number): Label[] {
    return this.db
      .all<Record<string, unknown>>(
        // Project labels plus the instance-wide ones.
        'SELECT * FROM labels WHERE project_id = ? OR project_id IS NULL ORDER BY name ASC',
        [projectId],
      )
      .map((row) => this.mapLabel(row));
  }

  createLabel(
    projectId: number,
    input: CreateLabelInput,
    ctx: RequestAuditContext = {},
  ): Label {
    const slug = slugify(input.name);
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM labels WHERE project_id = ? AND slug = ?',
      [projectId, slug],
    );
    if (existing) throw conflict(`A label named "${input.name}" already exists`, { slug });

    const id = Number(
      this.db.run(
        'INSERT INTO labels (project_id, name, slug, color, description) VALUES (?,?,?,?,?)',
        [projectId, input.name, slug, input.color, input.description],
      ).lastInsertRowid,
    );

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'label',
        entityId: id,
        projectId,
        actorId: ctx.actorId,
        after: { name: input.name, slug, color: input.color },
      },
      ctx,
    );

    const created = this.db.get<Record<string, unknown>>('SELECT * FROM labels WHERE id = ?', [id]);
    if (!created) throw notFound('Label', id);
    return this.mapLabel(created);
  }

  updateLabel(
    projectId: number,
    labelId: number,
    patch: Partial<CreateLabelInput>,
    ctx: RequestAuditContext = {},
  ): Label {
    const before = this.db.get<Record<string, unknown>>('SELECT * FROM labels WHERE id = ? AND project_id = ?', [
      labelId,
      projectId,
    ]);
    if (!before) throw notFound('Label', labelId);

    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.name !== undefined) {
      // Renaming re-slugs the row, so the slug can collide with another label
      // in this project. The unique index would reject it, but as an opaque
      // database error; check first so the caller gets a real conflict.
      const slug = slugify(patch.name);
      const clash = this.db.get<{ id: number }>(
        'SELECT id FROM labels WHERE project_id = ? AND slug = ? AND id <> ?',
        [projectId, slug, labelId],
      );
      if (clash) throw conflict(`A label named "${patch.name}" already exists`, { slug });

      sets.push('name = ?', 'slug = ?');
      params.push(patch.name, slug);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    if (sets.length > 0) {
      params.push(labelId);
      this.db.run(`UPDATE labels SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'label',
        entityId: labelId,
        projectId,
        actorId: ctx.actorId,
        before: this.mapLabel(before) as unknown as Record<string, unknown>,
        after: this.mapLabel(
          this.db.get<Record<string, unknown>>('SELECT * FROM labels WHERE id = ?', [labelId]) ?? before,
        ) as unknown as Record<string, unknown>,
      },
      ctx,
    );

    return this.mapLabel(
      this.db.get<Record<string, unknown>>('SELECT * FROM labels WHERE id = ?', [labelId]) ?? before,
    );
  }

  removeLabel(projectId: number, labelId: number, ctx: RequestAuditContext = {}): void {
    const existing = this.db.get<Record<string, unknown>>(
      'SELECT * FROM labels WHERE id = ? AND project_id = ?',
      [labelId, projectId],
    );
    if (!existing) throw notFound('Label', labelId);
    this.db.run('DELETE FROM labels WHERE id = ?', [labelId]);
    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'label',
        entityId: labelId,
        projectId,
        actorId: ctx.actorId,
        before: this.mapLabel(existing) as unknown as Record<string, unknown>,
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Milestones
  // -------------------------------------------------------------------------

  listMilestones(projectId: number): Milestone[] {
    return this.db
      .all<Record<string, unknown>>(
        // Milestones without a due date sort last rather than first.
        `SELECT * FROM milestones WHERE project_id = ?
         ORDER BY (due_date IS NULL), due_date ASC, id ASC`,
        [projectId],
      )
      .map((row) => this.mapMilestone(row));
  }

  createMilestone(
    projectId: number,
    input: CreateMilestoneInput,
    ctx: RequestAuditContext = {},
  ): Milestone {
    const id = Number(
      this.db.run(
        `INSERT INTO milestones (project_id, title, description, state, due_date, start_date)
         VALUES (?,?,?,?,?,?)`,
        [projectId, input.title, input.description, input.state, input.dueDate, input.startDate],
      ).lastInsertRowid,
    );
    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'milestone',
        entityId: id,
        projectId,
        actorId: ctx.actorId,
        after: input as unknown as Record<string, unknown>,
      },
      ctx,
    );
    return this.mapMilestone(
      this.db.get<Record<string, unknown>>('SELECT * FROM milestones WHERE id = ?', [id]) as Record<
        string,
        unknown
      >,
    );
  }

  updateMilestone(
    projectId: number,
    milestoneId: number,
    patch: Partial<CreateMilestoneInput>,
    ctx: RequestAuditContext = {},
  ): Milestone {
    const before = this.db.get<Record<string, unknown>>(
      'SELECT * FROM milestones WHERE id = ? AND project_id = ?',
      [milestoneId, projectId],
    );
    if (!before) throw notFound('Milestone', milestoneId);

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    const assign = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value as string | number | null);
    };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.description !== undefined) assign('description', patch.description);
    if (patch.state !== undefined) assign('state', patch.state);
    if (patch.dueDate !== undefined) assign('due_date', patch.dueDate);
    if (patch.startDate !== undefined) assign('start_date', patch.startDate);
    if (patch.state === 'closed') assign('closed_at', nowIso());
    // Reopening must forget when it was closed, otherwise a live milestone
    // still reports a closure time and "time to close" is measured from a
    // moment it was not actually closed.
    if (patch.state !== undefined && patch.state !== 'closed') assign('closed_at', null);

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), milestoneId);
      this.db.run(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const after = this.db.get<Record<string, unknown>>('SELECT * FROM milestones WHERE id = ?', [
      milestoneId,
    ]) as Record<string, unknown>;

    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'milestone',
        entityId: milestoneId,
        projectId,
        actorId: ctx.actorId,
        before: this.mapMilestone(before) as unknown as Record<string, unknown>,
        after: this.mapMilestone(after) as unknown as Record<string, unknown>,
      },
      ctx,
    );

    return this.mapMilestone(after);
  }

  removeMilestone(projectId: number, milestoneId: number, ctx: RequestAuditContext = {}): void {
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM milestones WHERE id = ? AND project_id = ?',
      [milestoneId, projectId],
    );
    if (!existing) throw notFound('Milestone', milestoneId);
    this.db.run('DELETE FROM milestones WHERE id = ?', [milestoneId]);
    this.services.audit.record(
      {
        action: 'settings.changed',
        entityType: 'milestone',
        entityId: milestoneId,
        projectId,
        actorId: ctx.actorId,
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /** Aggregate counts for the project overview. Each is a single query. */
  stats(projectId: number): ProjectStats {
    const counts = this.db.get<Record<string, number>>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN state NOT IN ('closed','resolved','wont_fix','duplicate') THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN state IN ('closed','resolved') THEN 1 ELSE 0 END) AS closed,
         SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
         -- Overdue means "live work past its deadline", matching the timing
         -- service, which measures lateness to resolution. A delivered issue
         -- was late once and is now done; counting it makes a project look
         -- permanently in breach, and an archived issue is off the board.
         SUM(CASE WHEN archived = 0
                   AND state NOT IN ('closed','resolved','wont_fix','duplicate')
                   AND due_date IS NOT NULL
                   AND due_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')
              THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned
       FROM issues WHERE project_id = ?`,
      [projectId],
    ) ?? ({} as Record<string, number>);

    // `column` is a literal from this file, never user input; only the value is
    // bound. The alias is neutral so the result type stays uniform.
    const groupBy = <K extends string>(column: K, alias: K): Array<Record<K, string> & { count: number }> =>
      this.db
        .all<Record<string, unknown>>(
          `SELECT ${column} AS ${alias}, COUNT(*) AS count FROM issues
           WHERE project_id = ? AND archived = 0 GROUP BY ${column}`,
          [projectId],
        )
        .map((row) => ({ [alias]: String(row[alias]), count: Number(row['count']) }) as Record<
          K,
          string
        > & { count: number });

    const createdTrend = this.db
      .all<Record<string, unknown>>(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
         FROM issues
         WHERE project_id = ? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
         GROUP BY date ORDER BY date ASC`,
        [projectId],
      )
      .map((row) => ({ date: String(row.date), count: Number(row.count) }));

    return {
      projectId,
      totalIssues: Number(counts.total ?? 0),
      openIssues: Number(counts.open ?? 0),
      closedIssues: Number(counts.closed ?? 0),
      archivedIssues: Number(counts.archived ?? 0),
      overdueIssues: Number(counts.overdue ?? 0),
      unassignedIssues: Number(counts.unassigned ?? 0),
      issuesByState: groupBy('state', 'state'),
      issuesByPriority: groupBy('priority', 'priority'),
      issuesByType: groupBy('type', 'type'),
      memberCount: Number(
        this.db.scalar<number>('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?', [
          projectId,
        ]) ?? 0,
      ),
      commentCount: Number(
        this.db.scalar<number>(
          'SELECT COUNT(*) AS c FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)',
          [projectId],
        ) ?? 0,
      ),
      createdTrend,
    };
  }

  private mapProject(row: Record<string, unknown>): Project {
    let archivePolicy: Project['archivePolicy'] = null;
    if (typeof row.archive_policy === 'string' && row.archive_policy.length > 0) {
      try {
        archivePolicy = JSON.parse(row.archive_policy) as Project['archivePolicy'];
      } catch {
        archivePolicy = null;
      }
    }

    return {
      id: Number(row.id) as Project['id'],
      key: String(row.key),
      name: String(row.name),
      description: String(row.description ?? ''),
      visibility: String(row.visibility) as Project['visibility'],
      defaultIssueType: String(row.default_issue_type) as Project['defaultIssueType'],
      defaultPriority: String(row.default_priority) as Project['defaultPriority'],
      nextIssueNumber: Number(row.next_issue_number ?? 1),
      sourceOfTruth: String(row.source_of_truth ?? 'local') as Project['sourceOfTruth'],
      archivePolicy,
      createdBy: row.created_by === null ? null : (Number(row.created_by) as Project['createdBy']),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private mapLabel(row: Record<string, unknown>): Label {
    return {
      id: Number(row.id),
      projectId: row.project_id === null ? null : (Number(row.project_id) as Label['projectId']),
      name: String(row.name),
      slug: String(row.slug),
      color: String(row.color ?? '#6b7280'),
      description: String(row.description ?? ''),
      createdAt: String(row.created_at ?? ''),
    };
  }

  private mapMilestone(row: Record<string, unknown>): Milestone {
    return {
      id: Number(row.id) as Milestone['id'],
      projectId: Number(row.project_id) as Milestone['projectId'],
      title: String(row.title),
      description: String(row.description ?? ''),
      state: String(row.state ?? 'planned') as Milestone['state'],
      dueDate: row.due_date === null ? null : String(row.due_date),
      startDate: row.start_date === null ? null : String(row.start_date),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }
}

/** URL-safe slug used for label lookup. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      // Truncating can cut mid-token and expose a dangling dash, which would
      // not match the untruncated slug on the way back in.
      .slice(0, 60)
      .replace(/-+$/, '')
  );
}

export type { CreateLabelInput, CreateMilestoneInput, CreateProjectInput, UpdateProjectInput };
