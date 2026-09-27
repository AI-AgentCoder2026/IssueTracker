/**
 * Customisable, role-scoped dashboards.
 *
 * A dashboard is a grid of widgets restricted to a set of roles. Each viewer
 * only sees dashboards whose role filter includes them, and a widget whose
 * required permission the viewer lacks is hidden rather than shown empty.
 */

import { z } from 'zod';
import type { DashboardId, IsoDateTime, ProjectId, UserId } from './ids.ts';
import { ROLES, type Role } from './rbac.ts';

export const WIDGET_TYPES = [
  'issue_list',
  'status_breakdown',
  'priority_breakdown',
  'burndown',
  'velocity',
  'sla_countdown',
  'overdue_watchlist',
  'unassigned_queue',
  'throughput',
  'workload_by_assignee',
  'age_distribution',
  'recent_activity',
  'cycle_time',
  'type_breakdown',
  'blocked_dependencies',
  'gitlab_sync_health',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_TYPE_LABEL: Record<WidgetType, string> = {
  issue_list: 'Issue list',
  status_breakdown: 'Breakdown by status',
  priority_breakdown: 'Breakdown by priority',
  burndown: 'Burndown',
  velocity: 'Velocity',
  sla_countdown: 'SLA countdown',
  overdue_watchlist: 'Overdue watchlist',
  unassigned_queue: 'Unassigned queue',
  throughput: 'Throughput',
  workload_by_assignee: 'Workload by assignee',
  age_distribution: 'Age distribution',
  recent_activity: 'Recent activity',
  cycle_time: 'Cycle time',
  type_breakdown: 'Breakdown by type',
  blocked_dependencies: 'Blocked dependencies',
  gitlab_sync_health: 'GitLab sync health',
};

export interface WidgetPosition {
  /** Grid column start, 0-based. */
  x: number;
  /** Grid row start, 0-based. */
  y: number;
  /** Width in grid columns. */
  w: number;
  /** Height in grid rows. */
  h: number;
}

export interface DashboardWidget {
  id: number;
  dashboardId: DashboardId;
  type: WidgetType;
  title: string;
  position: WidgetPosition;
  /** Per-widget filter, e.g. `{ state: ['open','in_progress'] }`. */
  filters: Record<string, unknown>;
  /** Optional hard limit on rows for list-style widgets. */
  limit: number;
  /** Roles excluded from this widget; empty means every permitted viewer. */
  hiddenFromRoles: Role[];
}

export interface Dashboard {
  id: DashboardId;
  projectId: ProjectId | null;
  name: string;
  description: string;
  /** Empty means visible to all project members. */
  roles: Role[];
  /** True for dashboards every new project starts with. */
  isDefault: boolean;
  widgets: DashboardWidget[];
  createdBy: UserId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Rendered widget data, produced server-side per viewer. */
export type WidgetData =
  | { kind: 'table'; columns: string[]; rows: Array<Record<string, unknown>>; total: number }
  | { kind: 'bar'; series: Array<{ label: string; value: number; color?: string }> }
  | { kind: 'line'; points: Array<{ label: string; value: number | null }> }
  | { kind: 'stat'; value: number | string; label: string; delta?: number }
  | { kind: 'list'; items: Array<{ id: string; title: string; subtitle?: string; href?: string; tone?: string }> }
  | { kind: 'empty'; reason: string };

/** Widget payload plus the permission decision that made it visible. */
export interface RenderedWidget extends DashboardWidget {
  data: WidgetData;
}

export interface RenderedDashboard extends Omit<Dashboard, 'widgets'> {
  widgets: RenderedWidget[];
}

const widgetPositionSchema = z.object({
  x: z.number().int().min(0).max(23),
  y: z.number().int().min(0).max(199),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
});

export const createWidgetSchema = z.object({
  type: z.enum(WIDGET_TYPES),
  title: z.string().trim().min(1).max(120).optional(),
  position: widgetPositionSchema,
  filters: z.record(z.unknown()).default({}),
  limit: z.number().int().min(1).max(500).default(10),
  hiddenFromRoles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
});

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;

export const updateWidgetSchema = createWidgetSchema
  .partial()
  .extend({ id: z.number().int().positive() });

export const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  projectId: z.number().int().positive().nullable().default(null),
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  widgets: z.array(createWidgetSchema).max(40).default([]),
});

export type CreateDashboardInput = z.infer<typeof createDashboardSchema>;

export const updateDashboardSchema = createDashboardSchema
  .partial()
  .omit({ widgets: true })
  .extend({ widgets: z.array(updateWidgetSchema).max(40).optional() });

/**
 * Starter dashboards provisioned for a new project, each aimed at a different
 * audience so the "different role sees a different view" requirement is
 * satisfied out of the box.
 */
export interface DashboardTemplate {
  name: string;
  description: string;
  roles: Role[];
  widgets: Array<Omit<CreateWidgetInput, 'position'> & { position: WidgetPosition }>;
}

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  {
    name: 'Team overview',
    description: 'Flow, blockers and throughput for everyone working in the project.',
    roles: ['developer', 'maintainer', 'admin', 'owner'],
    widgets: [
      {
        type: 'status_breakdown',
        title: 'Issues by status',
        position: { x: 0, y: 0, w: 4, h: 3 },
        filters: { archived: false },
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'unassigned_queue',
        title: 'Needs an owner',
        position: { x: 4, y: 0, w: 4, h: 3 },
        filters: { assigneeId: null },
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'blocked_dependencies',
        title: 'Blocked work',
        position: { x: 8, y: 0, w: 4, h: 3 },
        filters: {},
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'throughput',
        title: 'Throughput (last 8 weeks)',
        position: { x: 0, y: 3, w: 6, h: 3 },
        filters: { weeks: 8 },
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'cycle_time',
        title: 'Cycle time',
        position: { x: 6, y: 3, w: 3, h: 3 },
        filters: {},
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'recent_activity',
        title: 'Latest activity',
        position: { x: 9, y: 3, w: 3, h: 3 },
        filters: {},
        limit: 15,
        hiddenFromRoles: [],
      },
    ],
  },
  {
    name: 'Leadership',
    description: 'SLA exposure, overdue risk and delivery trend. Read-only for viewers.',
    roles: ['maintainer', 'admin', 'owner', 'viewer'],
    widgets: [
      {
        type: 'sla_countdown',
        title: 'SLA at risk',
        position: { x: 0, y: 0, w: 6, h: 3 },
        filters: { window: '24h' },
        limit: 15,
        hiddenFromRoles: [],
      },
      {
        type: 'overdue_watchlist',
        title: 'Overdue',
        position: { x: 6, y: 0, w: 6, h: 3 },
        filters: {},
        limit: 15,
        hiddenFromRoles: [],
      },
      {
        type: 'velocity',
        title: 'Velocity trend',
        position: { x: 0, y: 3, w: 6, h: 3 },
        filters: { weeks: 12 },
        limit: 10,
        hiddenFromRoles: [],
      },
      {
        type: 'age_distribution',
        title: 'Issue age',
        position: { x: 6, y: 3, w: 6, h: 3 },
        filters: {},
        limit: 10,
        hiddenFromRoles: [],
      },
    ],
  },
  {
    name: 'My work',
    description: 'Personal queue: what is assigned to me and what is due soon.',
    roles: ['developer', 'maintainer', 'admin', 'owner', 'reporter'],
    widgets: [
      {
        type: 'issue_list',
        title: 'Assigned to me',
        position: { x: 0, y: 0, w: 6, h: 4 },
        filters: { assigneeId: 'me', states: ['open', 'in_progress', 'review'] },
        limit: 20,
        hiddenFromRoles: [],
      },
      {
        type: 'issue_list',
        title: 'Due soon',
        position: { x: 6, y: 0, w: 6, h: 4 },
        filters: { assigneeId: 'me', dueWithin: '3d' },
        limit: 20,
        hiddenFromRoles: [],
      },
      {
        type: 'recent_activity',
        title: 'Mentions and replies',
        position: { x: 0, y: 4, w: 12, h: 3 },
        filters: { mine: true },
        limit: 20,
        hiddenFromRoles: [],
      },
    ],
  },
  {
    name: 'Triage',
    description: 'Incoming queue for reporters and maintainers deciding what to pick up.',
    roles: ['reporter', 'developer', 'maintainer', 'admin', 'owner'],
    widgets: [
      {
        type: 'unassigned_queue',
        title: 'Awaiting triage',
        position: { x: 0, y: 0, w: 6, h: 4 },
        filters: { state: 'backlog' },
        limit: 25,
        hiddenFromRoles: [],
      },
      {
        type: 'priority_breakdown',
        title: 'Priority mix',
        position: { x: 6, y: 0, w: 6, h: 4 },
        filters: {},
        limit: 10,
        hiddenFromRoles: [],
      },
    ],
  },
  {
    name: 'Incident response',
    description: 'Live incidents with countdown timers and current blast radius.',
    roles: ['developer', 'maintainer', 'admin', 'owner'],
    widgets: [
      {
        type: 'issue_list',
        title: 'Active incidents',
        position: { x: 0, y: 0, w: 7, h: 4 },
        filters: { type: 'incident', states: ['open', 'in_progress', 'blocked', 'review'] },
        limit: 25,
        hiddenFromRoles: [],
      },
      {
        type: 'sla_countdown',
        title: 'Response SLA',
        position: { x: 7, y: 0, w: 5, h: 4 },
        filters: { type: 'incident' },
        limit: 15,
        hiddenFromRoles: [],
      },
    ],
  },
];
