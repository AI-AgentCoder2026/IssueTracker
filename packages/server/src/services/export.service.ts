/**
 * Data export.
 *
 * Three formats (`json`, `csv`, `markdown`) over one shared pipeline:
 *
 *   request -> issue id set -> full issue rows (+ optional extras) -> format
 *
 * The issue set comes from `SearchService.search()` when a filter is supplied —
 * this module never re-implements filter resolution — or from an explicit id
 * list. Because `searchQuerySchema` caps `limit` at 500, a filter export pages
 * through the service with its keyset cursor rather than bypassing it.
 *
 * Every run writes an `export.generated` audit entry carrying the filter and the
 * row count. The exported content is deliberately **not** audited: it can be
 * hundreds of megabytes and duplicating it into the tamper-evident trail would
 * be a liability, not a control.
 */

import type {
  ActivityEvent,
  Actor,
  Comment,
  ExportRequest,
  Issue,
  IssueAttachment,
  IssuePriority,
  IssueSearchQuery,
  IssueState,
  IssueSummary,
  IssueType,
  ProjectId,
} from '@tracker/shared';
import {
  asCommentId,
  asIssueId,
  asMilestoneId,
  asUserId,
  exportRequestSchema,
  isTerminalState,
  searchQuerySchema,
} from '@tracker/shared';
import { inClause, type Database } from '../db/connection.ts';
import { badRequest } from '../errors.ts';
import { nowIso } from '../lib/time.ts';
import type { RequestContext, Services } from './context.ts';

export interface ExportResult {
  contentType: string;
  filename: string;
  body: string;
}

/** Hard ceiling on a single export, so one request cannot exhaust memory. */
export const MAX_EXPORT_ROWS = 50_000;

/** Ids per `IN (...)` batch; keeps every statement well inside SQLite limits. */
const ID_CHUNK = 500;

const CONTENT_TYPES: Record<ExportRequest['format'], string> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};

const CSV_COLUMNS = [
  'key',
  'title',
  'type',
  'priority',
  'state',
  'status',
  'assignee',
  'reporter',
  'parent',
  'due_date',
  'created_at',
  'updated_at',
  'resolved_at',
  'closed_at',
  'estimate_hours',
  'time_spent_hours',
  'labels',
  'milestone',
  'comment_count',
  'attachment_count',
  'time_to_resolve_ms',
  'overdue_ms',
] as const;

/** One issue joined to everything the flat formats need. */
type ExportRow = {
  id: number;
  project_id: number;
  sequence: number;
  key: string;
  title: string;
  description: string;
  type: IssueType;
  priority: IssuePriority;
  state: IssueState;
  status_id: number;
  assignee_id: number | null;
  reporter_id: number | null;
  parent_id: number | null;
  due_date: string | null;
  started_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  estimate_hours: number | null;
  time_spent_hours: number;
  position: number;
  milestone_id: number | null;
  archived: number;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  status_name: string | null;
  assignee_name: string | null;
  reporter_name: string | null;
  parent_key: string | null;
  label_names: string | null;
  milestone_title: string | null;
  comment_count: number;
  attachment_count: number;
};

export class ExportService {
  private readonly db: Database;
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.services = services;
  }

  /**
   * Produce an export. `ctx` supplies the audit context so the `export.generated`
   * entry is attributed to the request.
   */
  async run(request: ExportRequest, actor: Actor, ctx: RequestContext): Promise<ExportResult> {
    const input = exportRequestSchema.parse(request);
    const visible = visibleProjectIds(actor);
    const { ids, truncated } = await this.resolveIds(input, visible);

    if (ids.length === 0) {
      throw badRequest('The export matched no issues', { filter: input.filter ?? null });
    }

    const rows = this.loadRows(ids);
    const comments = input.includeComments ? this.loadComments(ids) : null;
    const attachments = input.includeAttachments ? this.loadAttachments(ids) : null;
    const timeline = input.includeTimeline ? this.loadTimeline(ids) : null;

    const stamp = nowIso().slice(0, 10);
    const filename = `issues-${stamp}.${input.format}`;
    let body: string;
    switch (input.format) {
      case 'csv':
        body = renderCsv(rows, nowIso());
        break;
      case 'markdown':
        body = renderMarkdown(rows, nowIso());
        break;
      case 'json':
      default:
        body = renderJson({
          rows,
          comments,
          attachments,
          timeline,
          exportedAt: nowIso(),
        });
        break;
    }

    this.services.audit.record(
      {
        action: 'export.generated',
        entityType: 'issue_export',
        entityId: `${input.format}:${rows.length}`,
        projectId: input.projectId ?? null,
        after: {
          format: input.format,
          rowCount: rows.length,
          truncated,
          includeComments: input.includeComments,
          includeAttachments: input.includeAttachments,
          includeTimeline: input.includeTimeline,
          filter: input.filter ?? (input.issueIds ? { issueIds: input.issueIds.length } : null),
        },
        actorId: Number(actor.userId),
      },
      ctx.auditContext,
    );

    return { contentType: CONTENT_TYPES[input.format], filename, body };
  }

  // -------------------------------------------------------------------------
  // Issue set resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the export's issue ids, either from an explicit list or by paging
   * `SearchService.search`. Visibility is enforced here, not by the caller.
   */
  private async resolveIds(
    input: ExportRequest,
    visible: number[] | null,
  ): Promise<{ ids: number[]; truncated: boolean }> {
    if (input.issueIds && input.issueIds.length > 0) {
      const found: number[] = [];
      for (const chunk of chunks(input.issueIds)) {
        const rows = this.db.all<{ id: number }>(
          `SELECT id FROM issues WHERE id IN ${inClause(chunk.length)}`,
          chunk,
        );
        for (const row of rows) found.push(row.id);
      }
      const ids = this.applyVisibility(found, visible).sort((a, b) => a - b);
      return { ids: ids.slice(0, MAX_EXPORT_ROWS), truncated: ids.length > MAX_EXPORT_ROWS };
    }

    if (!input.filter) {
      // The request type advertises a top-level `projectId`, but it was only
      // read inside this filter branch — so `{ projectId }` on its own either
      // threw or was silently ignored. Honour it: that is what the type
      // promises, and it is what "export this project" should mean.
      if (input.projectId !== undefined) {
        input = { ...input, filter: { projectId: input.projectId } as unknown as typeof input.filter };
      } else {
        throw badRequest('An export needs `issueIds`, a `filter`, or a `projectId`');
      }
    }

    // `searchQuerySchema.partial()` is what the contract accepts; re-applying the
    // full schema restores the defaults, then the service does the filtering.
    const base = searchQuerySchema.parse({ ...input.filter, limit: 500 }) as IssueSearchQuery;
    if (input.projectId !== undefined) {
      // The search filter is `projectIds` — a plural array. Assigning a singular
      // `projectId` set a key the schema does not declare, so it was stripped
      // on parse and the search ran unfiltered: "export this project" returned
      // every project the caller could see, which for an instance admin is the
      // whole instance. This is the field the search actually understands.
      base.projectIds = [Number(input.projectId) as ProjectId];
    }
    const options = visible ? { visibleProjectIds: visible } : {};

    const ids: number[] = [];
    let cursor: number | undefined;
    let total = 0;
    for (let page = 0; page < 200; page += 1) {
      const result = await this.services.search.search({ ...base, cursor }, options);
      total = result.total;
      for (const issue of result.issues) ids.push(Number(issue.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      if (ids.length >= MAX_EXPORT_ROWS) break;
    }
    return { ids: ids.slice(0, MAX_EXPORT_ROWS), truncated: total > MAX_EXPORT_ROWS };
  }

  private applyVisibility(ids: number[], visible: number[] | null): number[] {
    if (!visible) return ids;
    const allowed = new Set(visible);
    return ids.filter((id) => allowed.has(id));
  }

  // -------------------------------------------------------------------------
  // Row loading
  // -------------------------------------------------------------------------

  /**
   * Load full issues with every flat-format column, in id-ordered chunks.
   * Counts come from derived aggregates rather than per-row subqueries so the
   * whole export is one statement per chunk regardless of row count.
   */
  private loadRows(ids: number[]): ExportRow[] {
    const rows: ExportRow[] = [];
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      const chunk = ids.slice(start, start + ID_CHUNK);
      rows.push(
        ...this.db.all<ExportRow>(
          `SELECT i.*,
                  ws.name   AS status_name,
                  au.display_name AS assignee_name,
                  ru.display_name AS reporter_name,
                  p.key     AS parent_key,
                  (SELECT group_concat(l.name, ';') FROM issue_labels il
                     JOIN labels l ON l.id = il.label_id
                    WHERE il.issue_id = i.id) AS label_names,
                  m.title   AS milestone_title,
                  COALESCE(cc.c, 0) AS comment_count,
                  COALESCE(ac.c, 0) AS attachment_count
             FROM issues i
             LEFT JOIN workflow_statuses ws ON ws.id = i.status_id
             LEFT JOIN users au ON au.id = i.assignee_id
             LEFT JOIN users ru ON ru.id = i.reporter_id
             LEFT JOIN issues p ON p.id = i.parent_id
             LEFT JOIN milestones m ON m.id = i.milestone_id
             LEFT JOIN (SELECT issue_id, COUNT(*) AS c FROM comments GROUP BY issue_id) cc ON cc.issue_id = i.id
             LEFT JOIN (SELECT issue_id, COUNT(*) AS c FROM attachments GROUP BY issue_id) ac ON ac.issue_id = i.id
            WHERE i.id IN ${inClause(chunk.length)}
            ORDER BY i.id`,
          chunk,
        ),
      );
    }
    return rows;
  }

  private loadComments(issueIds: number[]): Map<number, Comment[]> {
    const out = new Map<number, Comment[]>();
    for (const chunk of chunks(issueIds)) {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM comments WHERE issue_id IN ${inClause(chunk.length)} ORDER BY issue_id, created_at, id`,
        chunk,
      );
      for (const row of rows) {
        const issueId = Number(row.issue_id);
        const list = out.get(issueId) ?? [];
        list.push({
          id: asCommentId(Number(row.id)),
          issueId: asIssueId(issueId),
          authorId: asUserId(Number(row.author_id ?? 0)),
          body: String(row.body),
          isSystem: Number(row.is_system) === 1,
          resolvesThreadId: row.resolves_thread_id === null ? null : asCommentId(Number(row.resolves_thread_id)),
          editedAt: row.edited_at === null ? null : String(row.edited_at),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        });
        out.set(issueId, list);
      }
    }
    return out;
  }

  private loadAttachments(issueIds: number[]): Map<number, IssueAttachment[]> {
    const out = new Map<number, IssueAttachment[]>();
    for (const chunk of chunks(issueIds)) {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM attachments WHERE issue_id IN ${inClause(chunk.length)} ORDER BY issue_id, id`,
        chunk,
      );
      for (const row of rows) {
        const issueId = Number(row.issue_id);
        const list = out.get(issueId) ?? [];
        list.push({
          id: Number(row.id),
          issueId: asIssueId(issueId),
          commentId: row.comment_id === null ? null : asCommentId(Number(row.comment_id)),
          filename: String(row.filename),
          storedName: String(row.stored_name),
          mimeType: String(row.mime_type),
          sizeBytes: Number(row.size_bytes),
          checksum: String(row.checksum),
          // `IssueAttachment.uploadedBy` is non-nullable in the shared contract
          // while the column is `ON DELETE SET NULL`; a deleted uploader is
          // mapped to 0 rather than inventing a user.
          uploadedBy: asUserId(Number(row.uploaded_by ?? 0)),
          createdAt: String(row.created_at),
        });
        out.set(issueId, list);
      }
    }
    return out;
  }

  private loadTimeline(issueIds: number[]): Map<number, ActivityEvent[]> {
    const out = new Map<number, ActivityEvent[]>();
    for (const chunk of chunks(issueIds)) {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM activity_events WHERE issue_id IN ${inClause(chunk.length)} ORDER BY issue_id, created_at, id`,
        chunk,
      );
      for (const row of rows) {
        const issueId = Number(row.issue_id);
        const list = out.get(issueId) ?? [];
        list.push({
          id: Number(row.id),
          issueId: asIssueId(issueId),
          projectId: Number(row.project_id) as ProjectId,
          actorId: row.actor_id === null ? null : asUserId(Number(row.actor_id)),
          type: String(row.type) as ActivityEvent['type'],
          summary: String(row.summary),
          changes: parseJson<ActivityEvent['changes']>(row.changes, []),
          metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
          isSystemGenerated: Number(row.is_system_generated) === 1,
          createdAt: String(row.created_at),
        });
        out.set(issueId, list);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

function renderJson(input: {
  rows: ExportRow[];
  comments: Map<number, Comment[]> | null;
  attachments: Map<number, IssueAttachment[]> | null;
  timeline: Map<number, ActivityEvent[]> | null;
  exportedAt: string;
}): string {
  const payload: Record<string, unknown> = {
    exportedAt: input.exportedAt,
    count: input.rows.length,
    issues: input.rows.map((row) => stripExportColumns(row)),
  };
  if (input.comments) {
    payload.comments = Object.fromEntries(
      input.rows.map((row) => [row.key, input.comments?.get(row.id) ?? []]),
    );
  }
  if (input.attachments) {
    payload.attachments = Object.fromEntries(
      input.rows.map((row) => [row.key, input.attachments?.get(row.id) ?? []]),
    );
  }
  if (input.timeline) {
    payload.timeline = Object.fromEntries(
      input.rows.map((row) => [row.key, input.timeline?.get(row.id) ?? []]),
    );
  }
  return JSON.stringify(payload, null, 2);
}

/** Drop the joined display columns so the JSON shape matches `Issue`. */
function stripExportColumns(row: ExportRow): Issue {
  return {
    id: asIssueId(row.id),
    key: row.key,
    projectId: row.project_id as ProjectId,
    sequence: row.sequence,
    title: row.title,
    description: row.description,
    type: row.type,
    priority: row.priority,
    state: row.state,
    statusId: row.status_id,
    assigneeId: row.assignee_id === null ? null : asUserId(row.assignee_id),
    reporterId: row.reporter_id === null ? null : asUserId(row.reporter_id),
    parentId: row.parent_id === null ? null : asIssueId(row.parent_id),
    dueDate: row.due_date,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    estimateHours: row.estimate_hours,
    timeSpentHours: row.time_spent_hours,
    position: row.position,
    milestoneId: row.milestone_id === null ? null : asMilestoneId(row.milestone_id),
    archived: Number(row.archived) === 1,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** RFC 4180: quote when the field holds a comma, quote, CR or LF; double quotes. */
/**
 * Render one CSV cell.
 *
 * Two things are handled, and the second is the important one:
 *
 *  * RFC 4180 quoting — a value containing a comma, quote or newline is wrapped
 *    and its quotes doubled, so a row cannot be split by a crafted title.
 *  * **Formula neutralisation.** A cell whose first character is `=`, `+`, `-`
 *    or `@` is executed by Excel, LibreOffice and Google Sheets when the file is
 *    opened — `=HYPERLINK("http://evil", "click")` in an issue title becomes a
 *    live link in the reader's session. Prefixing a single quote makes the value
 *    text to the spreadsheet while keeping it readable, which is the standard
 *    mitigation. Tab and carriage return are the same attack with a different
 *    first byte.
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);

  const needsQuoting = /[",\r\n]/.test(text) || /^[=+\-@\t\r]/.test(text);
  if (!needsQuoting) return text;

  // A leading apostrophe is only needed for the formula characters; the rest
  // are handled by ordinary quoting.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function renderCsv(rows: ExportRow[], now: string): string {
  const lines: string[] = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const row of rows) {
    const timeToResolve =
      row.resolved_at === null
        ? ''
        : String(new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime());
    const overdueMs =
      row.due_date !== null && row.due_date < now
        ? String(new Date(now).getTime() - new Date(row.due_date).getTime())
        : row.due_date === null
          ? ''
          : '0';
    const cells: Array<[string, unknown]> = [
      ['key', row.key],
      ['title', row.title],
      ['type', row.type],
      ['priority', row.priority],
      ['state', row.state],
      ['status_name', row.status_name],
      ['assignee_name', row.assignee_name],
      ['reporter_name', row.reporter_name],
      ['parent_key', row.parent_key],
      ['due_date', row.due_date],
      ['created_at', row.created_at],
      ['updated_at', row.updated_at],
      ['resolved_at', row.resolved_at],
      ['closed_at', row.closed_at],
      ['estimate_hours', row.estimate_hours],
      ['time_spent_hours', row.time_spent_hours],
      ['label_names', row.label_names],
      ['milestone_title', row.milestone_title],
      ['comment_count', row.comment_count],
      ['attachment_count', row.attachment_count],
      ['time_to_resolve_ms', timeToResolve],
      ['overdue_ms', overdueMs],
    ];
    lines.push(cells.map(([, value]) => csvCell(value)).join(','));
  }
  // RFC 4180 mandates CRLF record separators.
  return `${lines.join('\r\n')}\r\n`;
}

/** Escape a value for a GitHub-flavoured Markdown table cell. */
function mdCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderMarkdown(rows: ExportRow[], now: string): string {
  const byProject = new Map<number, ExportRow[]>();
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }

  const open = rows.filter((row) => !isTerminalState(row.state)).length;
  const overdue = rows.filter((row) => row.due_date !== null && row.due_date < now).length;

  const lines: string[] = [];
  lines.push('# Issue export');
  lines.push('');
  lines.push(`Generated ${now} · ${rows.length} issue(s) · ${open} open · ${overdue} overdue`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Project | Issues | Open | Overdue |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [projectId, projectRows] of byProject) {
    const projectOpen = projectRows.filter((row) => !isTerminalState(row.state)).length;
    const projectOverdue = projectRows.filter((row) => row.due_date !== null && row.due_date < now).length;
    lines.push(
      `| ${mdCell(projectRows[0]?.key.split('-')[0] ?? projectId)} | ${projectRows.length} | ${projectOpen} | ${projectOverdue} |`,
    );
  }
  lines.push('');

  for (const row of rows) {
    lines.push(`## ${mdCell(row.key)} · ${mdCell(row.title)}`);
    lines.push('');
    lines.push(`- **Type**: ${mdCell(row.type)} · **Priority**: ${mdCell(row.priority)} · **State**: ${mdCell(row.state)}`);
    lines.push(`- **Status**: ${mdCell(row.status_name ?? 'unknown')}`);
    lines.push(`- **Assignee**: ${mdCell(row.assignee_name ?? 'unassigned')}`);
    lines.push(`- **Reporter**: ${mdCell(row.reporter_name ?? 'unassigned')}`);
    if (row.parent_key) lines.push(`- **Parent**: ${mdCell(row.parent_key)}`);
    if (row.due_date) lines.push(`- **Due**: ${mdCell(row.due_date)}`);
    if (row.label_names) lines.push(`- **Labels**: ${mdCell(row.label_names)}`);
    if (row.milestone_title) lines.push(`- **Milestone**: ${mdCell(row.milestone_title)}`);
    lines.push(`- **Activity**: ${row.comment_count} comment(s), ${row.attachment_count} attachment(s)`);
    lines.push('');
    if (row.description.trim() !== '') {
      lines.push('### Description');
      lines.push('');
      lines.push(row.description.trim());
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunks(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    out.push(ids.slice(index, index + ID_CHUNK));
  }
  return out;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Projects the actor may read. Instance admins see everything (null), everyone
 * else is limited to the projects they hold a membership in.
 */
export function visibleProjectIds(actor: Actor): number[] | null {
  if (actor.isInstanceAdmin) return null;
  const ids: number[] = [];
  for (const projectId of actor.projectRoles.keys()) ids.push(Number(projectId));
  return ids;
}
