/**
 * Activity timeline service.
 *
 * Every meaningful change to an issue appends one row here. The per-issue
 * timeline, the "recent activity" dashboard widget and the audit view all read
 * from this table, so recording an event is the single way to make a change
 * visible to users.
 */

import type { ActivityEvent, ActivityType } from '@tracker/shared';
import type { Database } from '../db/connection.ts';
import { nowIso } from '../lib/time.ts';

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ActivityInput {
  issueId: number;
  projectId: number;
  type: ActivityType;
  /** Human-readable line rendered directly in the timeline. */
  summary: string;
  actorId?: number | null;
  changes?: FieldChange[];
  metadata?: Record<string, unknown>;
  /** Suppress the in-app notification for this event. */
  isSystemGenerated?: boolean;
  createdAt?: string;
}

export class ActivityService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }
  /** Append one event and return the stored row. */
  record(input: ActivityInput): ActivityEvent {
    const createdAt = input.createdAt ?? nowIso();
    const result = this.db.run(
      `INSERT INTO activity_events
         (issue_id, project_id, actor_id, type, summary, changes, metadata, is_system_generated, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.issueId,
        input.projectId,
        input.actorId ?? null,
        input.type,
        input.summary,
        JSON.stringify(input.changes ?? []),
        JSON.stringify(input.metadata ?? {}),
        input.isSystemGenerated ? 1 : 0,
        createdAt,
      ],
    );

    return {
      id: result.lastInsertRowid,
      issueId: input.issueId as ActivityEvent['issueId'],
      projectId: input.projectId as ActivityEvent['projectId'],
      actorId: (input.actorId ?? null) as ActivityEvent['actorId'],
      type: input.type,
      summary: input.summary,
      changes: input.changes ?? [],
      metadata: input.metadata ?? {},
      isSystemGenerated: input.isSystemGenerated ?? false,
      createdAt,
    };
  }

  /**
   * Build a `changes` array by diffing two snapshots, keeping only the fields
   * that actually differ. Passing `undefined` for both sides is ignored.
   */
  static diff(
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
    fields: string[],
  ): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const field of fields) {
      const from = before?.[field];
      const to = after?.[field];
      if (from === to) continue;
      if (from === undefined && to === undefined) continue;
      changes.push({ field, from: from ?? null, to: to ?? null });
    }
    return changes;
  }

  /**
   * Record a field-change event with an auto-generated summary such as
   * `changed priority from medium to high`.
   */
  recordFieldChange(input: {
    issueId: number;
    projectId: number;
    actorId?: number | null;
    type: ActivityType;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    fields: string[];
    /** `field` -> human label used in the summary. */
    labels?: Record<string, string>;
  }): ActivityEvent {
    const changes = ActivityService.diff(input.before, input.after, input.fields);
    const first = changes[0];
    const summary = first
      ? this.describeChange(first, input.labels)
      : `updated ${input.type.replace('issue.', '')}`;

    return this.record({
      issueId: input.issueId,
      projectId: input.projectId,
      actorId: input.actorId,
      type: input.type,
      summary,
      changes,
      isSystemGenerated: input.actorId === undefined || input.actorId === null,
    });
  }

  private describeChange(
    change: FieldChange,
    labels?: Record<string, string>,
  ): string {
    const label = labels?.[change.field] ?? change.field.replace(/_/g, ' ');
    const render = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return 'none';
      if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      return String(value);
    };
    return `changed ${label} from ${render(change.from)} to ${render(change.to)}`;
  }

  /** Timeline for one issue, newest first, with optional type filter. */
  forIssue(issueId: number, options: { limit?: number; types?: ActivityType[] } = {}): ActivityEvent[] {
    const clauses = ['issue_id = ?'];
    const params: Array<string | number> = [issueId];

    if (options.types && options.types.length > 0) {
      clauses.push(`type IN (${options.types.map(() => '?').join(', ')})`);
      params.push(...options.types);
    }

    const limit = Math.min(options.limit ?? 200, 500);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM activity_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Project-wide activity feed, used by the dashboard widget and the home page.
   */
  forProject(
    projectId: number,
    options: { limit?: number; since?: string; types?: ActivityType[] } = {},
  ): ActivityEvent[] {
    const clauses = ['project_id = ?'];
    const params: Array<string | number> = [projectId];

    if (options.since) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.types && options.types.length > 0) {
      clauses.push(`type IN (${options.types.map(() => '?').join(', ')})`);
      params.push(...options.types);
    }

    const limit = Math.min(options.limit ?? 25, 200);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM activity_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((row) => this.mapRow(row));
  }

  /** Everything a given user did, for the "my activity" view. */
  forActor(actorId: number, limit = 50): ActivityEvent[] {
    const rows = this.db.all<Record<string, unknown>>(
      'SELECT * FROM activity_events WHERE actor_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [actorId, Math.min(limit, 200)],
    );
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): ActivityEvent {
    const parseArray = (value: unknown): FieldChange[] => {
      if (typeof value !== 'string') return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? (parsed as FieldChange[]) : [];
      } catch {
        return [];
      }
    };
    const parseObject = (value: unknown): Record<string, unknown> => {
      if (typeof value !== 'string') return {};
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    return {
      id: Number(row.id),
      issueId: Number(row.issue_id) as ActivityEvent['issueId'],
      projectId: Number(row.project_id) as ActivityEvent['projectId'],
      actorId: row.actor_id === null ? null : (Number(row.actor_id) as ActivityEvent['actorId']),
      type: String(row.type) as ActivityType,
      summary: String(row.summary ?? ''),
      changes: parseArray(row.changes),
      metadata: parseObject(row.metadata),
      isSystemGenerated: Number(row.is_system_generated) === 1,
      createdAt: String(row.created_at ?? ''),
    };
  }
}
