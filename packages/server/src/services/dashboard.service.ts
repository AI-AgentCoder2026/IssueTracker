/**
 * Role-scoped, customisable dashboards.
 *
 * Two independent filters decide what a viewer sees:
 *   1. the dashboard's `roles` array decides whether the *dashboard* is listed
 *      for that viewer's role in the project, and
 *   2. each widget's `hidden_from_roles` plus its required `Permission` decide
 *      whether the *widget* renders.
 *
 * A dashboard the viewer may not see is reported as 404 rather than 403 so the
 * API does not leak the existence of role-restricted dashboards, and a widget
 * the viewer may not see is dropped rather than blanked — an empty panel would
 * suggest the data is missing, a hidden one does not.
 *
 * Every widget is one aggregate SQL query. Nothing here loops over issues in
 * JavaScript, because `render()` runs on every dashboard load.
 */

import type {
  Actor,
  CreateDashboardInput,
  CreateWidgetInput,
  Dashboard,
  DashboardId,
  DashboardWidget,
  IssuePriority,
  IssueState,
  IssueType,
  Permission,
  ProjectId,
  RenderedDashboard,
  RenderedWidget,
  Role,
  WidgetData,
  WidgetType,
} from '@tracker/shared';
import {
  ACTIVITY_LABEL,
  DASHBOARD_TEMPLATES,
  ISSUE_PRIORITIES,
  ISSUE_STATES,
  ISSUE_TYPE_LABEL,
  ISSUE_TYPES,
  PRIORITY_LABEL,
  PRIORITY_RANK,
  ROLES,
  ROLE_RANK,
  STATE_COLOR_HINT,
  WIDGET_TYPE_LABEL,
  can,
} from '@tracker/shared';
import type { SqlParam } from '../db/connection.ts';
import { inClause } from '../db/connection.ts';
import { badRequest, notFound } from '../errors.ts';
import { DAY_MS, formatDuration, nowIso, parseDuration } from '../lib/time.ts';
import type { Services } from './context.ts';
import type { AuditScope } from './sla.service.ts';
import { TimingService } from './timing.service.ts';

/**
 * The permission a viewer must hold for a widget to render. Instance admins
 * bypass every one of these. This is the single mapping the "different role
 * sees a different dashboard" requirement rests on.
 */
export const WIDGET_PERMISSIONS: Record<WidgetType, Permission> = {
  issue_list: 'issue.read',
  status_breakdown: 'issue.read',
  priority_breakdown: 'issue.read',
  type_breakdown: 'issue.read',
  burndown: 'issue.read',
  velocity: 'issue.read',
  throughput: 'issue.read',
  sla_countdown: 'dashboard.read',
  overdue_watchlist: 'issue.read',
  unassigned_queue: 'issue.read',
  workload_by_assignee: 'issue.read',
  age_distribution: 'issue.read',
  recent_activity: 'issue.read',
  cycle_time: 'issue.read',
  blocked_dependencies: 'issue.read',
  gitlab_sync_health: 'gitlab.read',
};

/** Client route for an issue row. The web client owns this shape. */
const issueHref = (issueId: number): string => `/issues/${issueId}`;

const AGE_BUCKET_ORDER = [
  'today',
  '1-2d',
  '3-6d',
  '1w',
  '2-4w',
  '1-3mo',
  '3-12mo',
  'over-1y',
] as const;

const TERMINAL_STATES: readonly IssueState[] = ['resolved', 'closed', 'wont_fix', 'duplicate'];

/** Widget position supplied on create/patch, flattened to its four columns. */
export interface WidgetPositionInput {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface WidgetPatch extends WidgetPositionInput {
  type?: WidgetType;
  title?: string;
  filters?: Record<string, unknown>;
  limit?: number;
  hiddenFromRoles?: Role[];
}

export interface DashboardPatch {
  name?: string;
  description?: string;
  roles?: Role[];
  isDefault?: boolean;
  projectId?: number | null;
  /** Widgets carrying an `id` are updated in place; the rest are added. */
  widgets?: Array<Partial<CreateWidgetInput> & { id?: number }>;
}

export interface ReorderEntry {
  id: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

type DashboardRow = {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  roles: string;
  is_default: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

type WidgetRow = {
  id: number;
  dashboard_id: number;
  type: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  filters: string;
  limit_value: number;
  hidden_from_roles: string;
};

/** Filters common to the issue-backed widgets, parsed once per widget. */
type IssueFilters = {
  /** `undefined` means "any assignee"; `null` means "nobody"; `'me'` is resolved per viewer. */
  assigneeId: number | 'me' | null | undefined;
  states: IssueState[];
  types: IssueType[];
  priorities: IssuePriority[];
  dueWithinMs: number | null;
  archived: boolean;
  limit: number;
};

type RenderScope = {
  actor: Actor;
  projectId: number | null;
  /** Projects the actor may read; instance-wide widgets are scoped to these. */
  projectIds: number[];
};

/** `createDashboardSchema` has no `isDefault`, but provisioning and the API both want it. */
export type CreateDashboardRequest = CreateDashboardInput & { isDefault?: boolean };

export class DashboardService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  /**
   * The registry builds `TimingService` first, so the shared instance is used
   * rather than a second one; the indirection keeps the constructor order out
   * of this class's contract.
   */
  private get timing(): TimingService {
    return this.services.timing;
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  /**
   * Seed the five role-scoped starter dashboards for a new project. Idempotent
   * by dashboard name, so re-running it after a partial failure fills the gaps
   * without duplicating what already landed. Called by `ProjectService`.
   */
  provisionDefaultDashboards(projectId: number, ctx?: AuditScope): Dashboard[] {
    const db = this.services.db;
    const existing = new Set(
      db
        .all<{ name: string }>('SELECT name FROM dashboards WHERE project_id = ?', [projectId])
        .map((row) => row.name),
    );

    const created: Dashboard[] = [];
    const now = nowIso();

    for (const template of DASHBOARD_TEMPLATES) {
      if (existing.has(template.name)) continue;

      const dashboardId = db.transaction(() => {
        const result = db.run(
          `INSERT INTO dashboards
             (project_id, name, description, roles, is_default, created_by, created_at, updated_at)
           VALUES (?,?,?,?,1,?,?,?)`,
          [
            projectId,
            template.name,
            template.description,
            JSON.stringify(template.roles),
            ctx?.actorId ?? null,
            now,
            now,
          ],
        );
        const newId = result.lastInsertRowid;
        for (const widget of template.widgets) {
          this.insertWidget(newId, widget);
        }
        return newId;
      });

      const dashboard = this.get(dashboardId);
      created.push(dashboard);
      this.audit(ctx, {
        action: 'dashboard.changed',
        entityType: 'dashboard',
        entityId: dashboardId,
        projectId,
        after: { name: dashboard.name, roles: dashboard.roles, provisioned: true },
      });
    }

    return created;
  }

  // -------------------------------------------------------------------------
  // Dashboard CRUD
  // -------------------------------------------------------------------------

  /**
   * Every dashboard in a project, regardless of role filter. The role-scoped
   * listing is `visibleTo()`; this one backs the settings screen.
   */
  list(projectId: number | null): Dashboard[] {
    const rows =
      projectId === null
        ? this.services.db.all<DashboardRow>('SELECT * FROM dashboards ORDER BY name ASC')
        : this.services.db.all<DashboardRow>(
            'SELECT * FROM dashboards WHERE project_id = ? ORDER BY name ASC',
            [projectId],
          );
    return this.withWidgets(rows);
  }

  /** One dashboard with its widgets, or `notFound('Dashboard')`. */
  get(id: number): Dashboard {
    const row = this.services.db.get<DashboardRow>('SELECT * FROM dashboards WHERE id = ?', [id]);
    if (!row) throw notFound('Dashboard', id);
    return this.withWidgets([row])[0] as Dashboard;
  }

  /** Create a dashboard together with any widgets supplied inline. */
  create(input: CreateDashboardRequest, ctx?: AuditScope): Dashboard {
    const db = this.services.db;
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw badRequest('Dashboard name is required');
    }

    const id = db.transaction(() => {
      const result = db.run(
        `INSERT INTO dashboards
           (project_id, name, description, roles, is_default, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          input.projectId ?? null,
          input.name.trim(),
          input.description ?? '',
          JSON.stringify(input.roles ?? []),
          input.isDefault === true ? 1 : 0,
          ctx?.actorId ?? null,
          nowIso(),
          nowIso(),
        ],
      );
      const newId = result.lastInsertRowid;
      for (const widget of input.widgets ?? []) {
        this.insertWidget(newId, widget);
      }
      return newId;
    });

    const dashboard = this.get(id);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard',
      entityId: id,
      projectId: dashboard.projectId,
      after: { name: dashboard.name, roles: dashboard.roles },
    });
    return dashboard;
  }

  /** Patch a dashboard. Widgets in the patch are upserted by id. */
  update(id: number, patch: DashboardPatch, ctx?: AuditScope): Dashboard {
    const before = this.get(id);
    const db = this.services.db;

    const name = patch.name?.trim() ?? before.name;
    const description = patch.description ?? before.description;
    const roles = patch.roles ?? before.roles;
    const isDefault = patch.isDefault ?? before.isDefault;
    const projectId = patch.projectId === undefined ? before.projectId : patch.projectId;

    db.run(
      `UPDATE dashboards
          SET name = ?, description = ?, roles = ?, is_default = ?, project_id = ?, updated_at = ?
        WHERE id = ?`,
      [name, description, JSON.stringify(roles), isDefault ? 1 : 0, projectId, nowIso(), id],
    );

    for (const widget of patch.widgets ?? []) {
      if (widget.id !== undefined) {
        this.applyWidgetPatch(id, widget.id, toWidgetPatch(widget));
        continue;
      }
      if (widget.type === undefined) {
        throw badRequest('A new widget must declare its type');
      }
      this.insertWidget(id, {
        type: widget.type,
        title: widget.title,
        position: widget.position,
        filters: widget.filters,
        limit: widget.limit,
        hiddenFromRoles: widget.hiddenFromRoles,
      });
    }

    const after = this.get(id);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard',
      entityId: id,
      projectId: after.projectId,
      before: { name: before.name, description: before.description, roles: before.roles, isDefault: before.isDefault },
      after: { name: after.name, description: after.description, roles: after.roles, isDefault: after.isDefault },
    });
    return after;
  }

  /** Delete a dashboard; its widgets cascade. */
  remove(id: number, ctx?: AuditScope): void {
    const before = this.get(id);
    this.services.db.run('DELETE FROM dashboards WHERE id = ?', [id]);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard',
      entityId: id,
      projectId: before.projectId,
      before: { name: before.name, roles: before.roles },
    });
  }

  // -------------------------------------------------------------------------
  // Widget CRUD
  // -------------------------------------------------------------------------

  /** Append a widget to a dashboard. */
  addWidget(dashboardId: number, input: CreateWidgetInput, ctx?: AuditScope): DashboardWidget {
    const dashboard = this.get(dashboardId);
    const id = this.services.db.transaction(() => this.insertWidget(dashboardId, input));
    const widget = this.getWidget(dashboardId, id);
    this.touch(dashboardId);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard_widget',
      entityId: id,
      projectId: dashboard.projectId,
      after: widget as unknown as Record<string, unknown>,
    });
    return widget;
  }

  /** Patch one widget of one dashboard. */
  updateWidget(
    dashboardId: number,
    widgetId: number,
    patch: WidgetPatch,
    ctx?: AuditScope,
  ): DashboardWidget {
    const dashboard = this.get(dashboardId);
    const before = this.getWidget(dashboardId, widgetId);
    this.applyWidgetPatch(dashboardId, widgetId, patch);
    const after = this.getWidget(dashboardId, widgetId);
    this.touch(dashboardId);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard_widget',
      entityId: widgetId,
      projectId: dashboard.projectId,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });
    return after;
  }

  /** Remove one widget. */
  removeWidget(dashboardId: number, widgetId: number, ctx?: AuditScope): void {
    const dashboard = this.get(dashboardId);
    const before = this.getWidget(dashboardId, widgetId);
    this.services.db.run('DELETE FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?', [
      widgetId,
      dashboardId,
    ]);
    this.touch(dashboardId);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard_widget',
      entityId: widgetId,
      projectId: dashboard.projectId,
      before: before as unknown as Record<string, unknown>,
    });
  }

  /** Apply a bulk drag-and-drop layout in one transaction and one audit entry. */
  reorder(dashboardId: number, positions: readonly ReorderEntry[], ctx?: AuditScope): DashboardWidget[] {
    const db = this.services.db;
    const dashboard = this.get(dashboardId);
    const valid = positions.filter((entry) => Number.isInteger(entry.id) && entry.id > 0);
    if (valid.length === 0) throw badRequest('At least one widget position is required');

    const before: Array<Record<string, number>> = [];
    db.transaction(() => {
      for (const entry of valid) {
        const current = db.get<WidgetRow>(
          'SELECT * FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?',
          [entry.id, dashboardId],
        );
        if (!current) throw notFound('DashboardWidget', entry.id);
        before.push({ id: current.id, x: current.x, y: current.y, w: current.w, h: current.h });
        db.run(
          `UPDATE dashboard_widgets SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND dashboard_id = ?`,
          [
            entry.x ?? current.x,
            entry.y ?? current.y,
            entry.w ?? current.w,
            entry.h ?? current.h,
            entry.id,
            dashboardId,
          ],
        );
      }
    });

    this.touch(dashboardId);
    const widgets = this.get(dashboardId).widgets;
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard',
      entityId: dashboardId,
      projectId: dashboard.projectId,
      before: { positions: before },
      after: {
        positions: widgets.map((w) => ({
          id: w.id,
          x: w.position.x,
          y: w.position.y,
          w: w.position.w,
          h: w.position.h,
        })),
      },
    });
    return widgets;
  }

  /**
   * Copy a dashboard and its widgets. The copy is not a default and starts
   * unfiltered by role, so the usual starting point for a bespoke view.
   */
  duplicate(id: number, ctx?: AuditScope): Dashboard {
    const source = this.get(id);
    const db = this.services.db;

    const copyId = db.transaction(() => {
      const result = db.run(
        `INSERT INTO dashboards
           (project_id, name, description, roles, is_default, created_by, created_at, updated_at)
         VALUES (?,?,?,?,0,?,?,?)`,
        [
          source.projectId,
          `${source.name} (copy)`,
          source.description,
          JSON.stringify(source.roles),
          ctx?.actorId ?? null,
          nowIso(),
          nowIso(),
        ],
      );
      const newId = result.lastInsertRowid;
      for (const widget of source.widgets) {
        this.insertWidget(newId, {
          type: widget.type,
          title: widget.title,
          position: widget.position,
          filters: widget.filters,
          limit: widget.limit,
          hiddenFromRoles: widget.hiddenFromRoles,
        });
      }
      return newId;
    });

    const copy = this.get(copyId);
    this.audit(ctx, {
      action: 'dashboard.changed',
      entityType: 'dashboard',
      entityId: copyId,
      projectId: copy.projectId,
      after: { name: copy.name, roles: copy.roles, duplicatedFrom: id, widgets: copy.widgets.length },
    });
    return copy;
  }

  // -------------------------------------------------------------------------
  // Visibility & rendering
  // -------------------------------------------------------------------------

  /**
   * Dashboards this actor may open in a project. A dashboard with an empty
   * `roles` array is visible to every member; otherwise the viewer's role in
   * the project (or their highest platform role, for instance-wide dashboards)
   * must appear in it. Non-members see nothing; instance admins see everything.
   */
  visibleTo(actor: Actor, projectId: number | null): Dashboard[] {
    const dashboards = this.list(projectId);
    return dashboards.filter((dashboard) => this.maySee(dashboard, actor, projectId));
  }

  /**
   * Render a dashboard for one viewer: drop the dashboard if the viewer may not
   * see it, drop widgets they may not see, and compute the rest.
   */
  async render(dashboardId: number, actor: Actor, ctx?: AuditScope): Promise<RenderedDashboard> {
    const dashboard = this.get(dashboardId);
    if (!this.maySee(dashboard, actor, dashboard.projectId)) {
      // 404 rather than 403: existence is itself role-restricted information.
      throw notFound('Dashboard', dashboardId);
    }

    const scope: RenderScope = {
      actor,
      projectId: dashboard.projectId,
      projectIds: this.readableProjectIds(actor, dashboard.projectId),
    };

    const widgets: RenderedWidget[] = [];
    for (const widget of dashboard.widgets) {
      if (!this.maySeeWidget(widget, actor, dashboard.projectId)) continue;
      widgets.push({ ...widget, data: this.widgetData(widget, scope) });
    }

    const { widgets: _dropped, ...rest } = dashboard;
    return { ...rest, widgets };
  }

  // -------------------------------------------------------------------------
  // Widget data
  // -------------------------------------------------------------------------

  /**
   * Produce one widget's `WidgetData`. Every branch is a single aggregate query
   * and no branch throws: a widget that cannot be computed degrades to an
   * empty state so one broken panel never fails the whole dashboard.
   */
  private widgetData(widget: DashboardWidget, scope: RenderScope): WidgetData {
    try {
      return this.dispatch(widget, scope);
    } catch {
      // A widget must never take the whole dashboard down with it; the reason
      // is deliberately generic so no SQL or internal detail reaches a client.
      return { kind: 'empty', reason: 'This widget could not be rendered' };
    }
  }

  private dispatch(widget: DashboardWidget, scope: RenderScope): WidgetData {
    const projectId = scope.projectId;
    const filters = this.readFilters(widget.filters, widget.limit, scope);

    switch (widget.type) {
      case 'issue_list':
        return this.issueList(projectId, filters);
      case 'status_breakdown':
        return this.groupedBreakdown(projectId, 'state', filters);
      case 'priority_breakdown':
        return this.groupedBreakdown(projectId, 'priority', filters);
      case 'type_breakdown':
        return this.groupedBreakdown(projectId, 'type', filters);
      case 'burndown':
        return this.burndown(projectId, widget);
      case 'velocity':
        return this.periodSeries(projectId, widget, 'resolved_at');
      case 'throughput':
        return this.periodSeries(projectId, widget, 'closed_at');
      case 'sla_countdown':
        return this.slaCountdown(widget, scope);
      case 'overdue_watchlist':
        return this.overdueWatchlist(projectId, filters);
      case 'unassigned_queue':
        return this.unassignedQueue(projectId, filters);
      case 'workload_by_assignee':
        return this.workloadByAssignee(projectId, filters);
      case 'age_distribution':
        return this.ageDistribution(projectId, filters);
      case 'recent_activity':
        return this.recentActivity(projectId, widget, scope);
      case 'cycle_time':
        return this.cycleTime(projectId, widget);
      case 'blocked_dependencies':
        return this.blockedDependencies(projectId, filters);
      case 'gitlab_sync_health':
        return this.gitlabSyncHealth(projectId);
      default: {
        // Exhaustiveness guard: adding a widget type without a case is a
        // compile error rather than a blank panel at runtime.
        const unknown: never = widget.type;
        return { kind: 'empty', reason: `Unsupported widget type: ${String(unknown)}` };
      }
    }
  }

  /** Filtered issue list. Supports `assigneeId: 'me'`, states, type(s), dueWithin. */
  private issueList(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to list issues' };

    const { clauses, params } = this.issueClauses(projectId, filters);
    const rows = this.services.db.all<{
      id: number;
      key: string;
      title: string;
      state: string;
      priority: string;
      assignee_name: string | null;
      due_date: string | null;
    }>(
      `SELECT i.id, i.key, i.title, i.state, i.priority, i.due_date,
              u.display_name AS assignee_name
         FROM issues i
         LEFT JOIN users u ON u.id = i.assignee_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY (i.due_date IS NULL), i.due_date ASC, i.id DESC
        LIMIT ?`,
      [...params, filters.limit],
    );

    if (rows.length === 0) return { kind: 'empty', reason: 'No issues match these filters' };

    const now = Date.now();
    return {
      kind: 'list',
      items: rows.map((row) => ({
        id: String(row.id),
        title: `${row.key} ${row.title}`,
        subtitle: this.issueSubtitle(row.state, row.priority, row.assignee_name, row.due_date, now),
        href: issueHref(row.id),
        tone: row.due_date !== null && Date.parse(row.due_date) < now ? 'danger' : 'ok',
      })),
    };
  }

  /** Bar chart grouped by `state`, `priority` or `type`. */
  private groupedBreakdown(
    projectId: number | null,
    field: 'state' | 'priority' | 'type',
    filters: IssueFilters,
  ): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see a breakdown' };

    const { clauses, params } = this.issueClauses(projectId, filters, false);
    const rows = this.services.db.all<{ bucket: string; total: number }>(
      `SELECT ${field} AS bucket, COUNT(*) AS total
         FROM issues i
        WHERE ${clauses.join(' AND ')}
        GROUP BY ${field}
        ORDER BY total DESC`,
      params,
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'No issues to summarise yet' };

    const series = rows.map((row) => {
      const bucket = row.bucket;
      return {
        label: this.bucketLabel(field, bucket),
        value: Number(row.total),
        color: field === 'state' ? STATE_COLOR_HINT[bucket as IssueState] : undefined,
      };
    });

    return { kind: 'bar', series: this.orderBuckets(field, series) };
  }

  /** Remaining open issues per day across the last `weeks` weeks. */
  private burndown(projectId: number | null, widget: DashboardWidget): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see a burndown' };

    const weeks = clampWeeks(widget.filters);
    const rows = this.services.db.all<{ day: number; remaining: number }>(
      `WITH RECURSIVE params(start_day) AS (SELECT CAST(julianday('now') - ? AS INTEGER)),
         days(d) AS (
           SELECT start_day FROM params
           UNION ALL
           SELECT d + 1 FROM days WHERE d < CAST(julianday('now') AS INTEGER)
         )
       SELECT days.d AS day, COUNT(i.id) AS remaining
         FROM days
         LEFT JOIN issues i
           ON i.project_id = ?
          AND i.archived = 0
          AND julianday(i.created_at) < days.d + 1
          AND (i.resolved_at IS NULL OR julianday(i.resolved_at) >= days.d + 1)
        GROUP BY days.d
        ORDER BY days.d ASC`,
      [weeks * 7, projectId],
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'Not enough history to plot a burndown' };

    return {
      kind: 'line',
      points: rows.map((row) => ({ label: dayLabel(Number(row.day)), value: Number(row.remaining) })),
    };
  }

  /** Issues resolved or closed per ISO week over `weeks` weeks. */
  private periodSeries(
    projectId: number | null,
    widget: DashboardWidget,
    column: 'resolved_at' | 'closed_at',
  ): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see a trend' };

    const weeks = clampWeeks(widget.filters);
    const rows = this.services.db.all<{ week: number; total: number }>(
      `WITH RECURSIVE params(start_week) AS (SELECT CAST(julianday('now') - ? AS INTEGER)),
         weeks(w) AS (
           SELECT start_week FROM params
           UNION ALL
           SELECT w + 7 FROM weeks WHERE w < CAST(julianday('now') AS INTEGER)
         )
       SELECT weeks.w AS week, COUNT(i.id) AS total
         FROM weeks
         LEFT JOIN issues i
           ON i.project_id = ?
          AND i.archived = 0
          AND i.${column} IS NOT NULL
          AND julianday(i.${column}) >= weeks.w
          AND julianday(i.${column}) < weeks.w + 7
        GROUP BY weeks.w
        ORDER BY weeks.w ASC`,
      [weeks * 7, projectId],
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'Not enough history to plot a trend' };

    return {
      kind: 'line',
      points: rows.map((row) => ({ label: dayLabel(Number(row.week)), value: Number(row.total) })),
    };
  }

  /** Nearest SLA breaches, each toned by urgency. */
  private slaCountdown(widget: DashboardWidget, scope: RenderScope): WidgetData {
    const windowMs = parseDuration(asString(widget.filters['window']) ?? '') ?? DAY_MS;
    const issueType = asString(widget.filters['type']) ?? asString(widget.filters['issueType']);
    const limit = clampLimit(widget.limit, 15);

    // Both halves of the countdown — what is about to be missed and what has
    // already been missed — merged soonest-deadline first. The issue type is
    // filtered inside the query so a wide dashboard stays at two queries.
    const upcoming = this.services.sla.clocksForProjects(scope.projectIds, {
      windowMs,
      issueType,
    });
    const breached = this.services.sla.clocksForProjects(scope.projectIds, {
      includeBreached: true,
      issueType,
    });
    const relevant = [...breached, ...upcoming]
      .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))
      .slice(0, limit);

    if (relevant.length === 0) {
      return {
        kind: 'empty',
        reason: issueType === undefined ? 'No active SLA deadlines' : `No active SLA deadlines for ${issueType} issues`,
      };
    }

    return {
      kind: 'list',
      items: relevant.map((clock) => {
        const remaining = clock.remainingMs ?? 0;
        return {
          id: `${clock.issueId}:${clock.target}:${clock.policyId}`,
          title: `${clock.issueKey} ${clock.issueTitle}`,
          subtitle: `${clock.policyName} · ${clock.target} · ${
            remaining < 0
              ? `breached by ${formatDuration(-remaining)}`
              : `${formatDuration(remaining)} left`
          }`,
          href: issueHref(clock.issueId),
          tone: clock.breached ? 'danger' : clock.state === 'at_risk' ? 'warning' : 'ok',
        };
      }),
    };
  }

  /** Open issues already past their due date, most overdue first. */
  private overdueWatchlist(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see overdue work' };

    const now = Date.now();
    const { clauses, params } = this.issueClauses(projectId, filters, false);
    const rows = this.services.db.all<{
      id: number;
      key: string;
      title: string;
      priority: string;
      assignee_name: string | null;
      due_date: string;
    }>(
      `SELECT i.id, i.key, i.title, i.priority, i.due_date, u.display_name AS assignee_name
         FROM issues i
         LEFT JOIN users u ON u.id = i.assignee_id
        WHERE ${clauses.join(' AND ')}
          AND i.due_date IS NOT NULL
          AND julianday(i.due_date) < julianday('now')
        ORDER BY i.due_date ASC
        LIMIT ?`,
      [...params, filters.limit],
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'Nothing is overdue' };

    return {
      kind: 'list',
      items: rows.map((row) => ({
        id: String(row.id),
        title: `${row.key} ${row.title}`,
        subtitle: `${row.assignee_name ?? 'Unassigned'} · overdue by ${formatDuration(
          now - Date.parse(row.due_date),
        )}`,
        href: issueHref(row.id),
        tone: 'danger',
      })),
    };
  }

  /** Open issues with nobody assigned, oldest first. */
  private unassignedQueue(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see the queue' };

    const scoped: IssueFilters = { ...filters, assigneeId: null };
    const { clauses, params } = this.issueClauses(projectId, scoped, false);
    const rows = this.services.db.all<{
      id: number;
      key: string;
      title: string;
      priority: string;
      created_at: string;
      age: string;
    }>(
      `SELECT i.id, i.key, i.title, i.priority, i.created_at,
              CAST(julianday('now') - julianday(i.created_at) AS INTEGER) AS age
         FROM issues i
        WHERE ${clauses.join(' AND ')}
        ORDER BY i.created_at ASC
        LIMIT ?`,
      [...params, filters.limit],
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'Every open issue has an owner' };

    return {
      kind: 'list',
      items: rows.map((row) => ({
        id: String(row.id),
        title: `${row.key} ${row.title}`,
        subtitle: `${row.priority} · waiting ${Number(row.age)}d`,
        href: issueHref(row.id),
        tone: Number(row.age) > 30 ? 'warning' : 'ok',
      })),
    };
  }

  /** Open issues per assignee. */
  private workloadByAssignee(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see workload' };

    const { clauses, params } = this.issueClauses(projectId, filters, false);
    const rows = this.services.db.all<{ assignee_id: number | null; name: string | null; total: number }>(
      `SELECT i.assignee_id AS assignee_id, u.display_name AS name, COUNT(*) AS total
         FROM issues i
         LEFT JOIN users u ON u.id = i.assignee_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY i.assignee_id
        ORDER BY total DESC`,
      params,
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'No open work to distribute' };

    return {
      kind: 'bar',
      series: rows.map((row) => ({
        label: row.assignee_id === null ? 'Unassigned' : row.name ?? `User ${row.assignee_id}`,
        value: Number(row.total),
      })),
    };
  }

  /**
   * Open issues by age bucket. The SQL `CASE` mirrors the boundaries in
   * `ageBucket()` exactly so the axis and the bucket labels cannot drift.
   */
  private ageDistribution(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see issue age' };

    const { clauses, params } = this.issueClauses(projectId, filters, false);
    const rows = this.services.db.all<{ bucket: string; total: number }>(
      `SELECT CASE
                WHEN julianday('now') - julianday(i.created_at) <  1 THEN 'today'
                WHEN julianday('now') - julianday(i.created_at) <  3 THEN '1-2d'
                WHEN julianday('now') - julianday(i.created_at) <  7 THEN '3-6d'
                WHEN julianday('now') - julianday(i.created_at) < 14 THEN '1w'
                WHEN julianday('now') - julianday(i.created_at) < 30 THEN '2-4w'
                WHEN julianday('now') - julianday(i.created_at) < 90 THEN '1-3mo'
                WHEN julianday('now') - julianday(i.created_at) <365 THEN '3-12mo'
                ELSE 'over-1y'
              END AS bucket,
              COUNT(*) AS total
         FROM issues i
        WHERE ${clauses.join(' AND ')}
        GROUP BY bucket`,
      params,
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'No open issues to measure' };

    const counts = new Map(rows.map((row) => [row.bucket, Number(row.total)]));
    return {
      kind: 'bar',
      series: AGE_BUCKET_ORDER.map((bucket) => ({
        label: ageBucketLabel(bucket),
        value: counts.get(bucket) ?? 0,
      })),
    };
  }

  /** Project feed, or the viewer's own activity when `filters.mine` is set. */
  private recentActivity(projectId: number | null, widget: DashboardWidget, scope: RenderScope): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see activity' };

    const limit = clampLimit(widget.limit, 15);
    const mine = widget.filters['mine'] === true;
    const events = mine
      ? this.services.db.all<{
          id: number;
          issue_id: number;
          summary: string;
          type: string;
          created_at: string;
          issue_key: string;
        }>(
          `SELECT a.id, a.issue_id, a.summary, a.type, a.created_at, i.key AS issue_key
             FROM activity_events a
             JOIN issues i ON i.id = a.issue_id
            WHERE a.project_id = ? AND a.actor_id = ?
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ?`,
          [projectId, scope.actor.userId, limit],
        )
      : this.services.activity.forProject(projectId, { limit }).map((event) => ({
          id: event.id,
          issue_id: event.issueId,
          summary: event.summary,
          type: event.type,
          created_at: event.createdAt,
          issue_key: String(event.issueId),
        }));

    if (events.length === 0) return { kind: 'empty', reason: 'No activity recorded yet' };

    return {
      kind: 'list',
      items: events.map((event) => ({
        id: String(event.id),
        title: event.summary,
        subtitle: `${event.issue_key} · ${ACTIVITY_LABEL[event.type as keyof typeof ACTIVITY_LABEL] ?? event.type}`,
        href: issueHref(event.issue_id),
      })),
    };
  }

  /**
   * Average time-to-resolve per priority (default) or type. Computed in SQL;
   * the sub-task rollup is not needed because cycle time is a per-issue metric.
   */
  private cycleTime(projectId: number | null, widget: DashboardWidget): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see cycle time' };

    const groupBy = asString(widget.filters['groupBy']) === 'type' ? 'type' : 'priority';
    const rows = this.services.db.all<{ bucket: string; avg_ms: number; total: number }>(
      `SELECT ${groupBy} AS bucket,
              AVG(julianday(resolved_at) - julianday(created_at)) * 86400000.0 AS avg_ms,
              COUNT(*) AS total
         FROM issues
        WHERE project_id = ? AND archived = 0 AND resolved_at IS NOT NULL
        GROUP BY ${groupBy}`,
      [projectId],
    );
    if (rows.length === 0) {
      return { kind: 'empty', reason: 'No resolved issues to average yet' };
    }

    const entries = rows.map((row) => ({
      bucket: row.bucket,
      value: round1(Number(row.avg_ms) / 3_600_000),
      sampleSize: Number(row.total),
    }));
    const ordered = groupBy === 'type' ? sortBy(entries, (e) => e.bucket) : sortBy(entries, (e) => PRIORITY_RANK[e.bucket as IssuePriority] ?? 0);

    return {
      kind: 'bar',
      series: ordered.map((entry) => ({
        label: this.bucketLabel(groupBy, entry.bucket),
        value: entry.value,
      })),
    };
  }

  /** Open issues that something else blocks, most blocked-by links first. */
  private blockedDependencies(projectId: number | null, filters: IssueFilters): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see blocked work' };

    const rows = this.services.db.all<{
      id: number;
      key: string;
      title: string;
      state: string;
      blockers: number;
      blocker_keys: string;
    }>(
      `SELECT i.id, i.key, i.title, i.state,
              COUNT(DISTINCT s.id) AS blockers,
              GROUP_CONCAT(DISTINCT s.key) AS blocker_keys
         FROM issue_links l
         JOIN issues i ON i.id = l.target_issue_id
         JOIN issues s ON s.id = l.source_issue_id
        WHERE l.kind = 'blocks'
          AND i.project_id = ?
          AND i.archived = 0
          AND i.state NOT IN ${inClause(TERMINAL_STATES.length)}
        GROUP BY i.id
        ORDER BY blockers DESC, i.id ASC
        LIMIT ?`,
      [projectId, ...TERMINAL_STATES, filters.limit],
    );
    if (rows.length === 0) return { kind: 'empty', reason: 'Nothing is blocked' };

    return {
      kind: 'list',
      items: rows.map((row) => ({
        id: String(row.id),
        title: `${row.key} ${row.title}`,
        subtitle: `blocked by ${row.blockers} open: ${row.blocker_keys ?? 'unknown'}`,
        href: issueHref(row.id),
        tone: Number(row.blockers) > 1 ? 'danger' : 'warning',
      })),
    };
  }

  /**
   * GitLab connection and conflict summary. A project with no connection is a
   * legitimate state, so it reports an empty widget rather than an error.
   */
  private gitlabSyncHealth(projectId: number | null): WidgetData {
    if (projectId === null) return { kind: 'empty', reason: 'Select a project to see sync health' };

    const connection = this.services.db.get<{
      total: number;
      enabled: number;
      failing: number;
      last_sync_at: string | null;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
              SUM(CASE WHEN last_sync_status = 'error' THEN 1 ELSE 0 END) AS failing,
              MAX(last_sync_at) AS last_sync_at
         FROM gitlab_connections
        WHERE project_id = ?`,
      [projectId],
    );
    if (Number(connection?.total ?? 0) === 0) {
      return { kind: 'empty', reason: 'No GitLab connection configured' };
    }

    const conflicts = Number(
      this.services.db.scalar<number>(
        `SELECT COUNT(*)
           FROM gitlab_sync_conflicts c
           JOIN gitlab_connections g ON g.id = c.connection_id
          WHERE g.project_id = ? AND c.resolved_at IS NULL`,
        [projectId],
      ) ?? 0,
    );

    return {
      kind: 'bar',
      series: [
        { label: 'Connections', value: Number(connection?.total ?? 0) },
        { label: 'Enabled', value: Number(connection?.enabled ?? 0) },
        { label: 'Failing syncs', value: Number(connection?.failing ?? 0) },
        { label: 'Unresolved conflicts', value: conflicts },
      ],
    };
  }

  /**
   * Per-widget filter parsing. Unknown or invalid values are dropped rather than
   * thrown, and the literal `'me'` is resolved to the viewer here so the SQL
   * builder only ever sees a number, `null` (unassigned) or `undefined`.
   */
  private readFilters(filters: Record<string, unknown>, limit: number, scope: RenderScope): IssueFilters {
    const assigneeId = readAssignee(filters['assigneeId']);
    return {
      assigneeId: assigneeId === 'me' ? scope.actor.userId : assigneeId,
      states: enumArray(filters['states'] ?? filters['state'], ISSUE_STATES) as IssueState[],
      types: enumArray(filters['types'] ?? filters['type'], ISSUE_TYPES) as IssueType[],
      priorities: enumArray(filters['priorities'] ?? filters['priority'], ISSUE_PRIORITIES) as IssuePriority[],
      dueWithinMs: parseDuration(asString(filters['dueWithin']) ?? '') ?? null,
      archived: filters['archived'] === true,
      limit: clampLimit(limit, 10),
    };
  }
  /**
   * Shared WHERE builder for the issue-backed widgets. Open-only is the default
   * for queue-style widgets; breakdowns opt out so they can count everything.
   */
  private issueClauses(
    projectId: number,
    filters: IssueFilters,
    openOnly = true,
  ): { clauses: string[]; params: SqlParam[] } {
    const clauses = ['i.project_id = ?'];
    const params: SqlParam[] = [projectId];

    if (!filters.archived) clauses.push('i.archived = 0');
    if (openOnly) {
      clauses.push(`i.state NOT IN ${inClause(TERMINAL_STATES.length)}`);
      params.push(...TERMINAL_STATES);
    }

    if (filters.states.length > 0) {
      clauses.push(`i.state IN ${inClause(filters.states.length)}`);
      params.push(...filters.states);
    }
    if (filters.types.length > 0) {
      clauses.push(`i.type IN ${inClause(filters.types.length)}`);
      params.push(...filters.types);
    }
    if (filters.priorities.length > 0) {
      clauses.push(`i.priority IN ${inClause(filters.priorities.length)}`);
      params.push(...filters.priorities);
    }
    if (filters.assigneeId === null) {
      clauses.push('i.assignee_id IS NULL');
    } else if (typeof filters.assigneeId === 'number') {
      clauses.push('i.assignee_id = ?');
      params.push(filters.assigneeId);
    }
    if (filters.dueWithinMs !== null) {
      // Kept as a bound window value rather than a formatted date string so
      // "due in 3d" stays correct whatever the server clock does.
      clauses.push('i.due_date IS NOT NULL AND julianday(i.due_date) <= julianday(?)');
      params.push(new Date(Date.now() + filters.dueWithinMs).toISOString());
    }

    return { clauses, params };
  }

  private issueSubtitle(
    state: string,
    priority: string,
    assignee: string | null,
    dueDate: string | null,
    now: number,
  ): string {
    const parts = [state, priority, assignee ?? 'Unassigned'];
    if (dueDate !== null) {
      const remaining = Date.parse(dueDate) - now;
      parts.push(remaining < 0 ? `overdue ${formatDuration(-remaining)}` : `due in ${formatDuration(remaining)}`);
    }
    return parts.join(' · ');
  }

  private bucketLabel(field: 'state' | 'priority' | 'type', bucket: string): string {
    if (field === 'priority') return PRIORITY_LABEL[bucket as IssuePriority] ?? bucket;
    if (field === 'type') return ISSUE_TYPE_LABEL[bucket as IssueType] ?? bucket;
    return bucket;
  }

  /** Present breakdowns in a stable domain order rather than by count. */
  private orderBuckets(
    field: 'state' | 'priority' | 'type',
    series: Array<{ label: string; value: number; color?: string }>,
  ): Array<{ label: string; value: number; color?: string }> {
    if (field === 'priority') {
      return sortBy(series, (entry) => PRIORITY_RANK[entry.label.toLowerCase() as IssuePriority] ?? 0, true);
    }
    if (field === 'state') {
      return sortBy(series, (entry) => ISSUE_STATES.indexOf(entry.label as IssueState), true);
    }
    return sortBy(series, (entry) => ISSUE_TYPES.indexOf(entry.label.toLowerCase() as IssueType), true);
  }

  // -------------------------------------------------------------------------
  // Visibility helpers
  // -------------------------------------------------------------------------

  private maySee(dashboard: Dashboard, actor: Actor, requestedProjectId: number | null): boolean {
    if (actor.isInstanceAdmin) return true;

    const scopeProjectId = (dashboard.projectId ?? requestedProjectId) as ProjectId | null;
    if (scopeProjectId !== null && !actor.projectRoles.has(scopeProjectId)) return false;

    if (dashboard.roles.length === 0) return true;
    const role = this.roleFor(actor, scopeProjectId);
    return role !== null && dashboard.roles.includes(role);
  }

  private maySeeWidget(widget: DashboardWidget, actor: Actor, projectId: number | null): boolean {
    if (actor.isInstanceAdmin) return true;

    const permission = WIDGET_PERMISSIONS[widget.type];
    const decision = can(actor, permission, projectId === null ? {} : { projectId: projectId as ProjectId });
    if (!decision.allowed) return false;

    if (widget.hiddenFromRoles.length === 0) return true;
    const role = this.roleFor(actor, projectId);
    return role === null || !widget.hiddenFromRoles.includes(role);
  }

  /**
   * The role to match against a dashboard's filters: the project membership
   * when one is in scope, otherwise the viewer's highest platform role, which
   * mirrors how `can()` resolves an unscoped check.
   */
  private roleFor(actor: Actor, projectId: number | null): Role | null {
    if (projectId !== null) {
      return actor.projectRoles.get(projectId as ProjectId) ?? null;
    }
    let best: Role | null = null;
    for (const role of actor.roles) {
      if (best === null || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
    }
    return best;
  }

  /** Projects an actor may read; instance admins get every project. */
  private readableProjectIds(actor: Actor, projectId: number | null): number[] {
    if (projectId !== null) return [projectId];
    if (actor.isInstanceAdmin) {
      return this.services.db
        .all<{ id: number }>('SELECT id FROM projects')
        .map((row) => row.id);
    }
    return [...actor.projectRoles.keys()].map((id) => Number(id));
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private withWidgets(rows: DashboardRow[]): Dashboard[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const widgetRows = this.services.db.all<WidgetRow>(
      `SELECT * FROM dashboard_widgets WHERE dashboard_id IN ${inClause(ids.length)}
        ORDER BY dashboard_id ASC, y ASC, x ASC, id ASC`,
      ids,
    );

    const byDashboard = new Map<number, DashboardWidget[]>();
    for (const widgetRow of widgetRows) {
      const list = byDashboard.get(widgetRow.dashboard_id) ?? [];
      list.push(mapWidget(widgetRow));
      byDashboard.set(widgetRow.dashboard_id, list);
    }

    return rows.map((row) => ({ ...mapDashboard(row), widgets: byDashboard.get(row.id) ?? [] }));
  }

  private getWidget(dashboardId: number, widgetId: number): DashboardWidget {
    const row = this.services.db.get<WidgetRow>(
      'SELECT * FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?',
      [widgetId, dashboardId],
    );
    if (!row) throw notFound('DashboardWidget', widgetId);
    return mapWidget(row);
  }

  /** Insert a widget. `type` is the only required field; the rest default. */
  private insertWidget(
    dashboardId: number,
    input: Partial<CreateWidgetInput> & { type: WidgetType },
  ): number {
    const position = input.position ?? { x: 0, y: 0, w: 4, h: 3 };
    const result = this.services.db.run(
      `INSERT INTO dashboard_widgets
         (dashboard_id, type, title, x, y, w, h, filters, limit_value, hidden_from_roles)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        dashboardId,
        input.type,
        input.title?.trim() || WIDGET_TYPE_LABEL[input.type],
        position.x,
        position.y,
        position.w,
        position.h,
        JSON.stringify(input.filters ?? {}),
        input.limit ?? 10,
        JSON.stringify(input.hiddenFromRoles ?? []),
      ],
    );
    return result.lastInsertRowid;
  }

  /** Apply a partial widget patch; used by `updateWidget` and `update`. */
  private applyWidgetPatch(dashboardId: number, widgetId: number, patch: WidgetPatch): void {
    const current = this.services.db.get<WidgetRow>(
      'SELECT * FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?',
      [widgetId, dashboardId],
    );
    if (!current) throw notFound('DashboardWidget', widgetId);

    this.services.db.run(
      `UPDATE dashboard_widgets
          SET type = ?, title = ?, x = ?, y = ?, w = ?, h = ?, filters = ?, limit_value = ?,
              hidden_from_roles = ?
        WHERE id = ? AND dashboard_id = ?`,
      [
        patch.type ?? current.type,
        patch.title?.trim() || current.title,
        patch.x ?? current.x,
        patch.y ?? current.y,
        patch.w ?? current.w,
        patch.h ?? current.h,
        JSON.stringify(patch.filters ?? safeParse(current.filters)),
        patch.limit ?? current.limit_value,
        JSON.stringify(patch.hiddenFromRoles ?? safeParseRoles(current.hidden_from_roles)),
        widgetId,
        dashboardId,
      ],
    );
  }

  /** Bump the dashboard's `updated_at` after a widget change. */
  private touch(dashboardId: number): void {
    this.services.db.run('UPDATE dashboards SET updated_at = ? WHERE id = ?', [nowIso(), dashboardId]);
  }

  private audit(
    ctx: AuditScope | undefined,
    input: {
      action: 'dashboard.changed';
      entityType: string;
      entityId: number;
      projectId: number | null;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): void {
    this.services.audit.record(
      {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId,
        before: input.before,
        after: input.after,
        actorId: ctx?.actorId ?? null,
      },
      ctx ?? {},
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id as DashboardId,
    projectId: row.project_id === null ? null : (row.project_id as Dashboard['projectId']),
    name: row.name,
    description: row.description,
    roles: safeParseRoles(row.roles),
    isDefault: Number(row.is_default) === 1,
    widgets: [],
    createdBy: row.created_by === null ? null : (row.created_by as Dashboard['createdBy']),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWidget(row: WidgetRow): DashboardWidget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id as DashboardId,
    type: row.type as WidgetType,
    title: row.title,
    position: { x: row.x, y: row.y, w: row.w, h: row.h },
    filters: safeParse(row.filters),
    limit: row.limit_value,
    hiddenFromRoles: safeParseRoles(row.hidden_from_roles),
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `'me'` is the viewer (resolved by the caller), `null` is an explicit
 * "unassigned" filter, a number is that user, and `undefined` — the default —
 * means no assignee filter at all.
 */
function readAssignee(value: unknown): number | 'me' | null | undefined {
  if (value === 'me') return 'me';
  if (value === null) return null;
  const parsed = asFiniteNumber(value);
  if (parsed !== null && Number.isInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

/** Keep only values that are actually members of `allowed`. */
function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .filter((entry): entry is T => typeof entry === 'string' && (allowed as readonly string[]).includes(entry));
}

/**
 * Roles are stored as a JSON *array*, which `safeParse` deliberately rejects,
 * so they get their own reader. Unknown role names are dropped rather than
 * widening a filter to something the schema does not define.
 */
function safeParseRoles(raw: string): Role[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? enumArray(parsed, ROLES) : [];
  } catch {
    return [];
  }
}

function safeParse(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

/** `filters.weeks`, bounded to a chart that stays readable. */
function clampWeeks(filters: Record<string, unknown>): number {
  const weeks = asFiniteNumber(filters['weeks']);
  if (weeks === null) return 8;
  return Math.min(Math.max(Math.trunc(weeks), 1), 52);
}

function sortBy<T>(items: readonly T[], key: (item: T) => number | string, descending = false): T[] {
  return [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) return 0;
    if (typeof left === 'number' && typeof right === 'number') {
      return descending ? right - left : left - right;
    }
    return descending
      ? String(right).localeCompare(String(left))
      : String(left).localeCompare(String(right));
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A SQLite Julian day number as `YYYY-MM-DD` (JD 2440587.5 is the epoch). */
function dayLabel(julianDay: number): string {
  return new Date((julianDay - 2_440_587.5) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The shared schema nests geometry under `position`; the storage layer and the
 * single-widget endpoint keep it flat, so a widget arriving from
 * `updateDashboardSchema` is flattened here.
 */
function toWidgetPatch(input: Partial<CreateWidgetInput> & { id?: number }): WidgetPatch {
  const position = input.position;
  return {
    type: input.type,
    title: input.title,
    filters: input.filters,
    limit: input.limit,
    hiddenFromRoles: input.hiddenFromRoles,
    x: position?.x,
    y: position?.y,
    w: position?.w,
    h: position?.h,
  };
}

function ageBucketLabel(bucket: string): string {
  return bucket === 'today' ? 'today' : bucket.replace('-', ' to ');
}
