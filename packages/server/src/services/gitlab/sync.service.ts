/**
 * GitLab sync engine.
 *
 * One adapter serves all three sync modes; only conflict resolution differs:
 *
 *   local_authoritative   local wins. A remote edit is never applied: it is
 *                         pushed back over and recorded as a conflict so a
 *                         human can see what GitLab had.
 *   gitlab_authoritative  GitLab wins. A local edit is pushed to GitLab
 *                         immediately (see `onIssueChanged`) and recorded as a
 *                         conflict so a human can see it was overwritten.
 *   bidirectional         newest `updated_at` wins; a gap of <= 2s counts as a
 *                         tie and the tie goes to GitLab. Either way the losing
 *                         value is written to `gitlab_sync_conflicts`.
 *
 * The invariant that shapes this whole file: **a sync never discards data on
 * either side**. Whenever the two sides disagree, one of them is applied and
 * the other is preserved in a conflict row.
 *
 * Local issue writes go straight to SQL rather than through `IssueService`:
 * importing an issue must bypass the optimistic-concurrency guard that assumes
 * a human is editing, and the adapter records provenance in the same
 * transaction.
 */

import {
  asGitLabConnectionId,
  asIssueId,
  asProjectId,
  type GitLabConnection,
  type GitLabConnectionPublic,
  type GitLabIssuePayload,
  type IssuePriority,
  type IssueState,
  type IssueType,
  type SyncConflict,
  type SyncMode,
  type SyncRun,
} from '@tracker/shared';
import { conflict, integrationError, notFound } from '../../errors.ts';
import { decrypt, encrypt, generateToken, maskSecret, safeEqual } from '../../lib/crypto.ts';
import { nowIso } from '../../lib/time.ts';
import type { RequestContext, Services } from '../context.ts';
import { GitLabClientFactory, type GitLabClient } from './client.ts';
import {
  buildNoteBody,
  contentHash,
  gitlabIssueToLocal,
  hasNoteMarker,
  labelSlug,
  localIssueToGitlabPayload,
  mapGitLabStateToLocalState,
  resolveLabelMapping,
  resolveStatusIdForState,
  stripNoteMarker,
  type GitLabConnectionSettings,
  type LocalIssueLike,
  type MappedIssue,
  type StatusByKey,
  type StatusByKeyEntry,
} from './mapper.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type ConnectionRow = {
  id: number;
  project_id: number;
  base_url: string;
  gitlab_project_path: string;
  access_token_encrypted: string;
  sync_mode: SyncMode;
  enabled: number;
  sync_hierarchy: number;
  sync_comments: number;
  sync_labels: number;
  sync_incidents: number;
  title_prefix: string;
  last_sync_at: string | null;
  last_sync_status: 'never' | 'ok' | 'error' | 'running';
  last_sync_error: string | null;
  webhook_secret: string | null;
  created_at: string;
  updated_at: string;
};

type LinkRow = {
  id: number;
  connection_id: number;
  issue_id: number;
  external_id: string;
  external_key: string | null;
  external_url: string | null;
  last_pushed_hash: string | null;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  remote_updated_at: string | null;
  sync_state: string;
  last_error: string | null;
  created_at: string;
};

type IssueRow = {
  id: number;
  key: string;
  title: string;
  description: string;
  type: IssueType;
  priority: IssuePriority;
  state: IssueState;
  status_id: number;
  assignee_id: number | null;
  reporter_id: number | null;
  due_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type IssueWithLabels = IssueRow & { labelNames: string[]; assigneeUsername: string | null };

type RunRow = {
  id: number;
  connection_id: number;
  direction: SyncDirection;
  trigger: SyncTrigger;
  status: 'running' | 'ok' | 'error';
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
};

export type SyncDirection = 'push' | 'pull' | 'full';
export type SyncTrigger = 'manual' | 'webhook' | 'schedule' | 'issue_change';

export interface SyncOptions {
  direction: SyncDirection;
  trigger: SyncTrigger;
  actorId: number | null;
}

/**
 * Connection fields accepted from a client. Everything but the three required
 * fields is optional because the shared zod schema supplies defaults; the
 * service applies its own defaults rather than trusting the caller.
 */
export interface ConnectionPublicInput {
  baseUrl: string;
  accessToken: string;
  gitlabProjectPath: string;
  syncMode?: SyncMode;
  enabled?: boolean;
  syncHierarchy?: boolean;
  syncComments?: boolean;
  syncLabels?: boolean;
  syncIncidents?: boolean;
  titlePrefix?: string;
}

export type ConnectionPatch = Partial<Omit<ConnectionPublicInput, 'accessToken'>> & {
  accessToken?: string;
};

export interface SyncStatus {
  connection: {
    id: number;
    projectId: number;
    syncMode: SyncMode;
    enabled: boolean;
    baseUrl: string;
    gitlabProjectPath: string;
    lastSyncAt: string | null;
    lastSyncStatus: 'never' | 'ok' | 'error' | 'running';
    lastSyncError: string | null;
  } | null;
  lastRun: SyncRun | null;
  unresolvedConflicts: number;
  bySyncState: Record<string, number>;
  /** True while a sync for this connection is in flight. */
  running: boolean;
}

export interface InboundWebhookResult {
  accepted: true;
  duplicate: boolean;
}

/** Fields compared when deciding whether the two sides disagree. */
const COMPARED_FIELDS = [
  'title',
  'description',
  'state',
  'priority',
  'dueDate',
  'labels',
  'assignee',
] as const;
type ComparedField = (typeof COMPARED_FIELDS)[number];

/** Two timestamps this close are treated as simultaneous. */
const CONFLICT_TIE_WINDOW_MS = 2_000;

/** Ceiling on issues a single pull will import; protects against a runaway API. */
const MAX_PULL_ITEMS = 20_000;

function bool(value: number | null | undefined): boolean {
  return Number(value) === 1;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/** Whether `candidate` is strictly newer than `baseline` (null = always). */
function isNewer(candidate: string | null, baseline: string | null): boolean {
  if (candidate === null) return false;
  if (baseline === null) return true;
  return new Date(candidate).getTime() > new Date(baseline).getTime();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GitLabService {
  private readonly services: Services;
  /** Connection ids with a sync in flight; a second run is refused. */
  private readonly inFlight = new Set<number>();

  constructor(services: Services) {
    this.services = services;
  }

  // =========================================================================
  // Connections
  // =========================================================================

  /** Every GitLab connection for a project, with the token redacted. */
  listConnections(projectId: number): GitLabConnectionPublic[] {
    const rows = this.services.db.all<ConnectionRow>(
      'SELECT * FROM gitlab_connections WHERE project_id = ? ORDER BY id ASC',
      [projectId],
    );
    return rows.map((row) => this.toPublic(row));
  }

  /** The project's connection, or null when none is configured. */
  getConnection(projectId: number): GitLabConnectionPublic | null {
    const row = this.loadConnectionRow(projectId);
    return row ? this.toPublic(row) : null;
  }

  /** Create a connection. The token is encrypted at rest and never returned. */
  createConnection(
    projectId: number,
    input: ConnectionPublicInput,
    ctx: RequestContext,
  ): GitLabConnectionPublic {
    const timestamp = nowIso();
    // Defaults mirror the shared schema so the service is safe to call directly.
    const settings = {
      syncMode: input.syncMode ?? ('bidirectional' as SyncMode),
      enabled: input.enabled ?? true,
      syncHierarchy: input.syncHierarchy ?? true,
      syncComments: input.syncComments ?? true,
      syncLabels: input.syncLabels ?? true,
      syncIncidents: input.syncIncidents ?? false,
      titlePrefix: input.titlePrefix ?? '',
    };
    let connectionId = 0;

    try {
      connectionId = this.services.db.transaction(() => {
        const result = this.services.db.run(
          `INSERT INTO gitlab_connections
             (project_id, base_url, gitlab_project_path, access_token_encrypted,
              sync_mode, enabled, sync_hierarchy, sync_comments, sync_labels,
              sync_incidents, title_prefix, webhook_secret, created_at, updated_at)
           VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
          [
            projectId,
            input.baseUrl,
            input.gitlabProjectPath,
            encrypt(input.accessToken, this.services.config.encryptionKey),
            settings.syncMode,
            settings.enabled ? 1 : 0,
            settings.syncHierarchy ? 1 : 0,
            settings.syncComments ? 1 : 0,
            settings.syncLabels ? 1 : 0,
            settings.syncIncidents ? 1 : 0,
            settings.titlePrefix,
            generateToken(24),
            timestamp,
            timestamp,
          ],
        );
        return result.lastInsertRowid;
      });
    } catch (error) {
      // UNIQUE (base_url, gitlab_project_path) — report it as a conflict
      // instead of leaking the SQLite message.
      if (error instanceof Error && /gitlab_connections\.(base_url|gitlab_project_path)/.test(error.message)) {
        throw conflict('That GitLab instance and project path are already connected');
      }
      throw error;
    }

    this.services.audit.record(
      {
        action: 'gitlab.connection_created',
        entityType: 'GitLabConnection',
        entityId: connectionId,
        projectId,
        after: {
          baseUrl: input.baseUrl,
          gitlabProjectPath: input.gitlabProjectPath,
          ...settings,
        },
      },
      ctx.auditContext,
    );

    const row = this.services.db.get<ConnectionRow>('SELECT * FROM gitlab_connections WHERE id = ?', [
      connectionId,
    ]);
    if (!row) throw notFound('GitLabConnection', connectionId);
    return this.toPublic(row);
  }

  /**
   * Update a connection. A new token is optional; when supplied it is
   * encrypted and audited as a rotation, and never echoed back.
   */
  updateConnection(
    projectId: number,
    patch: ConnectionPatch,
    ctx: RequestContext,
  ): GitLabConnectionPublic {
    const before = this.loadConnectionRow(projectId);
    if (!before) throw notFound('GitLabConnection', projectId);

    const sets: string[] = [];
    const params: Array<string | number> = [];
    const push = (column: string, value: string | number): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl);
    if (patch.gitlabProjectPath !== undefined) push('gitlab_project_path', patch.gitlabProjectPath);
    if (patch.syncMode !== undefined) push('sync_mode', patch.syncMode);
    if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0);
    if (patch.syncHierarchy !== undefined) push('sync_hierarchy', patch.syncHierarchy ? 1 : 0);
    if (patch.syncComments !== undefined) push('sync_comments', patch.syncComments ? 1 : 0);
    if (patch.syncLabels !== undefined) push('sync_labels', patch.syncLabels ? 1 : 0);
    if (patch.syncIncidents !== undefined) push('sync_incidents', patch.syncIncidents ? 1 : 0);
    if (patch.titlePrefix !== undefined) push('title_prefix', patch.titlePrefix);
    if (patch.accessToken !== undefined) {
      push(
        'access_token_encrypted',
        encrypt(patch.accessToken, this.services.config.encryptionKey),
      );
    }
    // A connection that never had a secret gets one now, so the inbound
    // receiver is always usable.
    if (!before.webhook_secret) push('webhook_secret', generateToken(24));

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), before.id);
      this.services.db.run(`UPDATE gitlab_connections SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    this.services.audit.record(
      {
        action:
          patch.accessToken !== undefined
            ? 'gitlab.token_rotated'
            : 'gitlab.connection_updated',
        entityType: 'GitLabConnection',
        entityId: before.id,
        projectId,
        before: {
          baseUrl: before.base_url,
          gitlabProjectPath: before.gitlab_project_path,
          syncMode: before.sync_mode,
          enabled: bool(before.enabled),
          titlePrefix: before.title_prefix,
        },
        // The token itself is never part of an audit snapshot.
        after: {
          baseUrl: patch.baseUrl ?? before.base_url,
          gitlabProjectPath: patch.gitlabProjectPath ?? before.gitlab_project_path,
          syncMode: patch.syncMode ?? before.sync_mode,
          enabled: patch.enabled ?? bool(before.enabled),
          titlePrefix: patch.titlePrefix ?? before.title_prefix,
          tokenRotated: patch.accessToken !== undefined,
        },
      },
      ctx.auditContext,
    );

    const row = this.loadConnectionRow(projectId);
    if (!row) throw notFound('GitLabConnection', projectId);
    return this.toPublic(row);
  }

  /** Delete a connection; links, runs and conflicts cascade away with it. */
  deleteConnection(projectId: number, ctx: RequestContext): void {
    const row = this.loadConnectionRow(projectId);
    if (!row) throw notFound('GitLabConnection', projectId);

    this.services.db.run('DELETE FROM gitlab_connections WHERE id = ?', [row.id]);

    this.services.audit.record(
      {
        action: 'gitlab.connection_deleted',
        entityType: 'GitLabConnection',
        entityId: row.id,
        projectId,
        before: { baseUrl: row.base_url, gitlabProjectPath: row.gitlab_project_path },
      },
      ctx.auditContext,
    );
  }

  // =========================================================================
  // Sync engine
  // =========================================================================

  /**
   * Run a sync for one connection and return the finished run row.
   *
   * A concurrent run for the same connection is refused with `conflict()`; a
   * per-item failure is recorded on that item's link and counted in the run
   * rather than aborting the whole sync.
   */
  async sync(connectionId: number, options: SyncOptions): Promise<SyncRun> {
    if (this.inFlight.has(connectionId)) {
      throw conflict('A sync is already running for this GitLab connection');
    }
    this.inFlight.add(connectionId);

    let runId = 0;
    try {
      runId = this.startRun(connectionId, options);
      const connection = this.loadConnection(connectionId);

      if (!connection) {
        return this.finishRun(runId, 'error', { message: 'GitLab connection no longer exists' });
      }
      if (!bool(connection.enabled)) {
        return this.finishRun(runId, 'ok', {
          message: 'Connection is disabled; nothing to sync',
          connection,
        });
      }

      this.services.audit.record({
        action: 'gitlab.sync_triggered',
        entityType: 'GitLabSyncRun',
        entityId: runId,
        projectId: connection.project_id,
        actorId: options.actorId,
        after: { direction: options.direction, trigger: options.trigger, runId },
      });

      const result = await this.executeSync(connection, options);
      return this.finishRun(runId, result.failed > 0 ? 'error' : 'ok', { ...result, connection });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync failure';
      const connection = this.loadConnection(connectionId);
      if (connection) this.markConnectionFailed(connection, message);
      if (runId > 0) {
        return this.finishRun(runId, 'error', { message, failed: 1, connection });
      }
      throw error;
    } finally {
      this.inFlight.delete(connectionId);
    }
  }

  // =========================================================================
  // Inbound webhooks
  // =========================================================================

  /**
   * Handle an inbound GitLab event.
   *
   * The connection is found by its webhook secret, the secret is compared in
   * constant time, and the delivery is de-duplicated through
   * `webhook_receipts` (unique on provider + event id) so GitLab's retries are
   * ignored rather than replayed.
   */
  async handleInboundWebhook(
    secret: string,
    event: string,
    payload: unknown,
    ctx: RequestContext,
    tokenHeader?: string | null,
  ): Promise<InboundWebhookResult> {
    // Connections are few (one per project), so a scan is cheaper — and safer —
    // than looking the row up by a secret we never want in a query.
    const candidates = this.services.db.all<ConnectionRow>(
      'SELECT * FROM gitlab_connections WHERE webhook_secret IS NOT NULL',
    );
    const connection = candidates.find(
      (row) => row.webhook_secret !== null && safeEqual(secret, row.webhook_secret),
    );
    if (!connection) throw notFound('GitLabConnection', 'webhook secret');

    if (tokenHeader !== undefined && tokenHeader !== null && tokenHeader !== '') {
      if (!safeEqual(tokenHeader, connection.webhook_secret ?? '')) {
        throw integrationError('GitLab webhook token header did not match the connection secret');
      }
    }

    const serialized = JSON.stringify(payload ?? {});
    const eventId = inboundEventId(event, payload, serialized);

    const inserted = this.services.db.run(
      `INSERT OR IGNORE INTO webhook_receipts (provider, event_id, event, payload)
       VALUES ('gitlab', ?, ?, ?)`,
      [eventId, event, serialized],
    );
    if (inserted.changes === 0) {
      // A retry of a delivery we have already accepted.
      return { accepted: true, duplicate: true };
    }

    this.services.audit.record(
      {
        action: 'gitlab.sync_triggered',
        entityType: 'GitLabConnection',
        entityId: connection.id,
        projectId: connection.project_id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        after: { event, eventId, requestId: ctx.requestId },
      },
      { ...ctx.auditContext, actorId: null, actorName: 'gitlab', actorEmail: '' },
    );

    if (!bool(connection.enabled)) {
      this.markReceiptProcessed(eventId);
      return { accepted: true, duplicate: false };
    }

    // Fire-and-forget: the receiver must answer fast, and a failed sync is
    // visible in the sync-runs list.
    void this.runInboundSync(connection, event, readIid(payload))
      .then(() => {
        this.markReceiptProcessed(eventId);
      })
      .catch(() => {
        this.markConnectionFailed(connection, 'Inbound webhook sync failed');
        this.markReceiptProcessed(eventId);
      });

    return { accepted: true, duplicate: false };
  }

  private markReceiptProcessed(eventId: string): void {
    this.services.db.run(
      "UPDATE webhook_receipts SET processed_at = ? WHERE provider = 'gitlab' AND event_id = ?",
      [nowIso(), eventId],
    );
  }

  private async runInboundSync(
    connection: ConnectionRow,
    event: string,
    iid: number | null,
  ): Promise<void> {
    if (event.startsWith('Issue Hook') && iid !== null) {
      const client = this.factory().forRow(connection);
      const remote = await client.getIssue(this.projectRef(connection), iid);
      await this.pullOne(connection, remote, { pushed: 0, pulled: 0, conflicts: 0, failed: 0 });
      return;
    }
    await this.sync(connection.id, { direction: 'pull', trigger: 'webhook', actorId: null });
  }

  // =========================================================================
  // Conflicts
  // =========================================================================

  /** Conflicts for a project, newest first. */
  listConflicts(projectId: number, options: { unresolvedOnly?: boolean } = {}): SyncConflict[] {
    const rows = options.unresolvedOnly
      ? this.services.db.all<Record<string, unknown>>(
          `SELECT c.* FROM gitlab_sync_conflicts c
             JOIN gitlab_connections k ON k.id = c.connection_id
            WHERE k.project_id = ? AND c.resolved_at IS NULL
            ORDER BY c.id DESC`,
          [projectId],
        )
      : this.services.db.all<Record<string, unknown>>(
          `SELECT c.* FROM gitlab_sync_conflicts c
             JOIN gitlab_connections k ON k.id = c.connection_id
            WHERE k.project_id = ?
            ORDER BY c.id DESC`,
          [projectId],
        );
    return rows.map(mapConflictRow);
  }

  /**
   * Apply a human decision to a recorded conflict.
   *
   * `kept_local` pushes the local value back to GitLab, `kept_gitlab` applies
   * the remote value locally, and `merged` writes `mergedValue` locally and
   * then pushes it. Every resolution is audited.
   */
  async resolveConflict(
    conflictId: number,
    input: { resolution: 'kept_local' | 'kept_gitlab' | 'merged'; mergedValue?: string | null },
    ctx: RequestContext,
  ): Promise<SyncConflict> {
    const row = this.services.db.get<Record<string, unknown>>(
      'SELECT * FROM gitlab_sync_conflicts WHERE id = ?',
      [conflictId],
    );
    if (!row) throw notFound('SyncConflict', conflictId);
    if (row.resolved_at !== null) throw conflict('This conflict has already been resolved');
    if (input.resolution === 'merged' && (input.mergedValue === undefined || input.mergedValue === null)) {
      throw conflict('A merged resolution requires a mergedValue');
    }

    const connection = this.loadConnection(Number(row.connection_id));
    if (!connection) throw notFound('GitLabConnection', String(row.connection_id));

    const issueId = Number(row.issue_id);
    const field = String(row.field);
    const issue = this.loadIssue(issueId);
    if (!issue) throw notFound('Issue', issueId);

    if (input.resolution === 'kept_gitlab') {
      this.applyFieldLocally(connection, issue, field, row.gitlab_value === null ? null : String(row.gitlab_value));
    } else {
      if (input.resolution === 'merged') {
        this.applyFieldLocally(connection, issue, field, input.mergedValue ?? '');
      }
      const link = this.loadLinkByIssue(connection.id, issueId);
      const refreshed = this.loadIssueWithLabels(issueId);
      if (link && refreshed) {
        const client = this.factory().forRow(connection);
        await this.pushIssue(connection, client, refreshed, link);
      }
      this.services.db.run(
        "UPDATE gitlab_external_links SET sync_state = 'synced' WHERE connection_id = ? AND issue_id = ?",
        [connection.id, issueId],
      );
    }

    this.services.db.run(
      'UPDATE gitlab_sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?',
      [nowIso(), input.resolution, conflictId],
    );

    this.services.audit.record(
      {
        action: 'issue.updated',
        entityType: 'SyncConflict',
        entityId: conflictId,
        projectId: connection.project_id,
        actorId: ctx.actor.userId,
        before: { field, localValue: row.local_value, gitlabValue: row.gitlab_value },
        after: { field, resolution: input.resolution },
      },
      ctx.auditContext,
    );

    const updated = this.services.db.get<Record<string, unknown>>(
      'SELECT * FROM gitlab_sync_conflicts WHERE id = ?',
      [conflictId],
    );
    if (!updated) throw notFound('SyncConflict', conflictId);
    return mapConflictRow(updated);
  }

  // =========================================================================
  // Reporting
  // =========================================================================

  /** Recent runs for a project, newest first. */
  listRuns(projectId: number, limit = 25): SyncRun[] {
    const rows = this.services.db.all<RunRow>(
      `SELECT r.* FROM gitlab_sync_runs r
         JOIN gitlab_connections k ON k.id = r.connection_id
        WHERE k.project_id = ?
        ORDER BY r.id DESC
        LIMIT ?`,
      [projectId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(mapRunRow);
  }

  /** Health summary for the integration panel. */
  status(projectId: number): SyncStatus {
    const connection = this.loadConnectionRow(projectId);
    const lastRun = this.services.db.get<RunRow>(
      `SELECT r.* FROM gitlab_sync_runs r
         JOIN gitlab_connections k ON k.id = r.connection_id
        WHERE k.project_id = ?
        ORDER BY r.id DESC LIMIT 1`,
      [projectId],
    );

    const bySyncState: Record<string, number> = {};
    if (connection) {
      const rows = this.services.db.all<{ sync_state: string; count: number }>(
        'SELECT sync_state, COUNT(*) AS count FROM gitlab_external_links WHERE connection_id = ? GROUP BY sync_state',
        [connection.id],
      );
      for (const row of rows) bySyncState[row.sync_state] = Number(row.count);
    }

    const unresolvedConflicts = connection
      ? Number(
          this.services.db.scalar<number>(
            'SELECT COUNT(*) AS c FROM gitlab_sync_conflicts WHERE connection_id = ? AND resolved_at IS NULL',
            [connection.id],
          ) ?? 0,
        )
      : 0;

    return {
      connection: connection
        ? {
            id: connection.id,
            projectId: connection.project_id,
            syncMode: connection.sync_mode,
            enabled: bool(connection.enabled),
            baseUrl: connection.base_url,
            gitlabProjectPath: connection.gitlab_project_path,
            lastSyncAt: connection.last_sync_at,
            lastSyncStatus: connection.last_sync_status,
            lastSyncError: connection.last_sync_error,
          }
        : null,
      lastRun: lastRun ? mapRunRow(lastRun) : null,
      unresolvedConflicts,
      bySyncState,
      running: connection ? this.inFlight.has(connection.id) : false,
    };
  }

  // =========================================================================
  // Local change hook
  // =========================================================================

  /**
   * Called by other services after a local issue mutation.
   *
   * Cheap and non-blocking: the link is flagged `pending_push` and a targeted
   * push is fired. Failures land on the link and in the audit trail, never on
   * the request that edited the issue.
   */
  onIssueChanged(projectId: number, issueId: number, ctx?: RequestContext): void {
    try {
      const connection = this.loadConnectionRow(projectId);
      if (!connection || !bool(connection.enabled)) return;

      this.services.db.run(
        `UPDATE gitlab_external_links
            SET sync_state = CASE
                  WHEN sync_state IN ('synced','conflict','error') THEN 'pending_push'
                  ELSE sync_state
                END
          WHERE connection_id = ? AND issue_id = ?`,
        [connection.id, issueId],
      );

      void this.pushSingleIssue(connection, issueId, ctx?.actor.userId ?? null).catch(() => {
        /* already recorded on the link */
      });
    } catch {
      // An integration failure must never break the caller's mutation.
    }
  }

  // =========================================================================
  // Internals: loading & mapping
  // =========================================================================

  private factory(): GitLabClientFactory {
    return new GitLabClientFactory(this.services);
  }

  /** URL-encoded GitLab project reference, as every path segment needs. */
  private projectRef(connection: ConnectionRow): string {
    return encodeURIComponent(connection.gitlab_project_path);
  }

  private loadConnectionRow(projectId: number): ConnectionRow | undefined {
    return this.services.db.get<ConnectionRow>(
      'SELECT * FROM gitlab_connections WHERE project_id = ? ORDER BY id ASC LIMIT 1',
      [projectId],
    );
  }

  private loadConnection(connectionId: number): ConnectionRow | undefined {
    return this.services.db.get<ConnectionRow>('SELECT * FROM gitlab_connections WHERE id = ?', [
      connectionId,
    ]);
  }

  private loadLinkByIssue(connectionId: number, issueId: number): LinkRow | undefined {
    return this.services.db.get<LinkRow>(
      'SELECT * FROM gitlab_external_links WHERE connection_id = ? AND issue_id = ?',
      [connectionId, issueId],
    );
  }

  private loadLinkByExternal(connectionId: number, externalId: string): LinkRow | undefined {
    return this.services.db.get<LinkRow>(
      'SELECT * FROM gitlab_external_links WHERE connection_id = ? AND external_id = ?',
      [connectionId, externalId],
    );
  }

  private loadIssue(issueId: number): IssueRow | undefined {
    return this.services.db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
  }

  private loadIssueWithLabels(issueId: number): IssueWithLabels | undefined {
    const issue = this.loadIssue(issueId);
    if (!issue) return undefined;
    const labels = this.services.db.all<{ name: string }>(
      `SELECT l.name FROM issue_labels il
         JOIN labels l ON l.id = il.label_id
        WHERE il.issue_id = ?
        ORDER BY l.name ASC`,
      [issueId],
    );
    // The assignee is compared as a username because a local user id is not a
    // GitLab user id and must never be written to one.
    const assignee =
      issue.assignee_id === null
        ? undefined
        : this.services.db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', [
            issue.assignee_id,
          ]);
    return { ...issue, labelNames: labels.map((row) => row.name), assigneeUsername: assignee?.username ?? null };
  }

  /** Redact a connection row for transport; the token never leaves the server. */
  private toPublic(row: ConnectionRow): GitLabConnectionPublic {
    const base: Omit<GitLabConnection, 'accessTokenEncrypted'> = {
      id: asGitLabConnectionId(row.id),
      projectId: asProjectId(row.project_id),
      baseUrl: row.base_url,
      gitlabProjectPath: row.gitlab_project_path,
      syncMode: row.sync_mode,
      enabled: bool(row.enabled),
      syncHierarchy: bool(row.sync_hierarchy),
      syncComments: bool(row.sync_comments),
      syncLabels: bool(row.sync_labels),
      syncIncidents: bool(row.sync_incidents),
      titlePrefix: row.title_prefix,
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncError: row.last_sync_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return { ...base, hasToken: true, tokenHint: this.tokenHint(row.access_token_encrypted) };
  }

  /**
   * First few characters of the stored token, so a user can tell which token is
   * configured. A token that cannot be decrypted yields `null` rather than an
   * error, because this is a display concern.
   */
  private tokenHint(encrypted: string): string | null {
    try {
      return maskSecret(decrypt(encrypted, this.services.config.encryptionKey));
    } catch {
      return null;
    }
  }

  private settingsOf(row: ConnectionRow): GitLabConnectionSettings {
    return {
      syncMode: row.sync_mode,
      titlePrefix: row.title_prefix,
      syncIncidents: bool(row.sync_incidents),
    };
  }

  /** Workflow statuses of a project, keyed by their stable key. */
  private statusByKey(projectId: number): StatusByKey {
    const rows = this.services.db.all<StatusByKeyEntry>(
      `SELECT id, key, state, is_closed AS isClosed, position
         FROM workflow_statuses
        WHERE project_id = ?
        ORDER BY position ASC, id ASC`,
      [projectId],
    );
    const map = new Map<string, StatusByKeyEntry>();
    for (const row of rows) map.set(row.key, row);
    return map;
  }

  // =========================================================================
  // Internals: run bookkeeping
  // =========================================================================

  private startRun(connectionId: number, options: SyncOptions): number {
    const result = this.services.db.run(
      `INSERT INTO gitlab_sync_runs (connection_id, direction, trigger, status, started_at)
       VALUES (?,?,?,'running',?)`,
      [connectionId, options.direction, options.trigger, nowIso()],
    );
    return result.lastInsertRowid;
  }

  private finishRun(
    runId: number,
    status: 'ok' | 'error',
    result: {
      pushed?: number;
      pulled?: number;
      conflicts?: number;
      failed?: number;
      message?: string;
      connection?: ConnectionRow;
    },
  ): SyncRun {
    const timestamp = nowIso();
    this.services.db.run(
      `UPDATE gitlab_sync_runs
          SET status = ?, pushed = ?, pulled = ?, conflicts = ?, failed = ?, message = ?, finished_at = ?
        WHERE id = ?`,
      [
        status,
        result.pushed ?? 0,
        result.pulled ?? 0,
        result.conflicts ?? 0,
        result.failed ?? 0,
        result.message ?? null,
        timestamp,
        runId,
      ],
    );

    const connection = result.connection;
    if (connection) {
      this.services.db.run(
        `UPDATE gitlab_connections
            SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?
          WHERE id = ?`,
        [timestamp, status, status === 'error' ? (result.message ?? null) : null, connection.id],
      );
    }

    const row = this.services.db.get<RunRow>('SELECT * FROM gitlab_sync_runs WHERE id = ?', [runId]);
    if (!row) throw notFound('SyncRun', runId);
    const run = mapRunRow(row);

    if (connection) {
      this.services.realtime.publish({
        event: 'gitlab.sync',
        projectId: connection.project_id,
        data: {
          runId: run.id,
          status: run.status,
          pushed: run.pushed,
          pulled: run.pulled,
          conflicts: run.conflicts,
          failed: run.failed,
        },
      });
      if (run.status === 'error') {
        this.notifyAdmins(
          connection,
          'GitLab sync failed',
          run.message ?? 'The sync reported errors',
        );
      }
    }

    return run;
  }

  private markConnectionFailed(connection: ConnectionRow, message: string): void {
    this.services.db.run(
      'UPDATE gitlab_connections SET last_sync_status = ?, last_sync_error = ? WHERE id = ?',
      ['error', message.slice(0, 500), connection.id],
    );
  }

  /** Notify the project's admins about a sync failure or a conflict. */
  private notifyAdmins(
    connection: ConnectionRow,
    title: string,
    body: string,
    event: 'gitlab.sync_failed' | 'gitlab.sync_conflict' = 'gitlab.sync_failed',
  ): void {
    const admins = this.services.db.all<{ user_id: number }>(
      `SELECT user_id FROM project_members
        WHERE project_id = ? AND role IN ('owner','admin')`,
      [connection.project_id],
    );
    if (admins.length === 0) return;
    this.services.notifications.notify({
      event,
      title,
      body,
      projectId: connection.project_id,
      userIds: admins.map((row) => row.user_id),
      projectMembersOnly: true,
    });
  }

  /**
   * Links that still need a push. Everything else was either pushed or is
   * waiting on GitLab.
   *
   * Two sources matter here, and the second is the one that is easy to forget:
   * a **newly created local issue has no link row at all**. Iterating links
   * alone therefore never pushes it, so the first issue a project creates
   * would silently never appear in GitLab. A link row is created up front with
   * a NULL `external_id` and a `local_only` state, after which later passes
   * find it by the ordinary path.
   */
  private pushCandidates(connection: ConnectionRow): LinkRow[] {
    // 1. Give every never-mirrored local issue a pending link. NULL
    //    `external_id` marks "no remote object yet", and SQLite treats those
    //    as distinct, so several can queue at once.
    this.services.db.run(
      `INSERT OR IGNORE INTO gitlab_external_links
         (connection_id, issue_id, external_id, sync_state, created_at)
       SELECT ?, i.id, NULL, 'local_only', ?
       FROM issues i
       WHERE i.project_id = ? AND i.archived = 0
         AND NOT EXISTS (
           SELECT 1 FROM gitlab_external_links r
           WHERE r.connection_id = ? AND r.issue_id = i.id
         )
       ORDER BY i.id`,
      [connection.id, nowIso(), connection.project_id, connection.id],
    );

    // 2. Every link for this connection.
    //
    //    Selecting only the pending states would mean a *locally edited* issue
    //    is never pushed, because nothing flags it: the change hook is advisory
    //    and may not have run. Including synced links costs a local hash
    //    comparison each, which is cheap; `pushIssue` returns before any HTTP
    //    call when the hash matches, so no-op suppression is enforced by the
    //    hash rather than by the query — which is what stops the mirror from
    //    ping-ponging.
    return this.services.db.all<LinkRow>(
      `SELECT * FROM gitlab_external_links
       WHERE connection_id = ?
         AND ( sync_state <> 'gitlab_only'
               OR external_id IS NULL )`,
      [connection.id],
    );
  }

  /** Push every issue that needs it, isolating per-item failures. */
  private async pushAll(
    connection: ConnectionRow,
    client: GitLabClient,
    counters: SyncCounters,
  ): Promise<void> {
    for (const link of this.pushCandidates(connection)) {
      try {
        const issue = this.loadIssueWithLabels(link.issue_id);
        if (!issue) continue;
        if (!this.shouldPush(connection, issue)) continue;
        // Only count an actual remote write. `pushIssue` short-circuits when the
        // payload hash is unchanged, and that must not be reported as a push or
        // the run summary claims work that never happened.
        const outcome = await this.pushIssue(connection, client, issue, link);
        if (outcome.wrote) counters.pushed += 1;
      } catch (error) {
        counters.failed += 1;
        this.recordItemFailure(connection, link.issue_id, error);
      }
    }
  }

  /**
   * Whether this issue is in scope for the connection at all. Incidents are
   * only mirrored when the connection opted in; everything else always is.
   */
  private shouldPush(connection: ConnectionRow, issue: IssueRow): boolean {
    return bool(connection.sync_incidents) || issue.type !== 'incident';
  }

  /**
   * Create or update the GitLab issue for one local issue, then refresh the
   * link's provenance. The payload hash is stored so the next sync can prove
   * there is nothing to write and skip the round trip.
   */
  private async pushIssue(
    connection: ConnectionRow,
    client: GitLabClient,
    issue: IssueWithLabels,
    link: LinkRow,
    actorId: number | null = null,
  ): Promise<{ link: LinkRow; wrote: boolean }> {
    const local: LocalIssueLike = {
      key: issue.key,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority,
      type: issue.type,
      dueDate: issue.due_date,
      labelNames: issue.labelNames,
    };
    const payload = localIssueToGitlabPayload(local, {
      titlePrefix: connection.title_prefix,
      syncComments: bool(connection.sync_comments),
      syncIncidents: bool(connection.sync_incidents),
      syncLabels: bool(connection.sync_labels),
      // No `assigneeId`: a local user id is not a GitLab user id, so writing it
      // would assign the wrong person. Assignments are compared for conflicts
      // and preserved in the conflict row instead.
    });
    const hash = contentHash({
      ...payload,
      // Labels arrive as a comma-joined string; sort so reordering is a no-op.
      labels: payload.labels.split(',').map((l) => l.trim()).filter(Boolean).sort(),
    });
    const timestamp = nowIso();

    // A NULL `external_id` means there is nothing remote to update yet.
    if (link.external_id !== null && link.last_pushed_hash === hash) {
      // Nothing changed locally since the last successful push.
      this.services.db.run(
        "UPDATE gitlab_external_links SET sync_state = 'synced', last_error = NULL WHERE id = ?",
        [link.id],
      );
      // No change since the last successful push, so nothing was written.
      return { link: { ...link, sync_state: 'synced', last_error: null }, wrote: false };
    }

    const ref = this.projectRef(connection);
    const created =
      link.external_id === null
        ? await client.createIssue(ref, payload)
        : await client.updateIssue(ref, Number(link.external_id), payload);

    this.services.db.run(
      `UPDATE gitlab_external_links
          SET external_id = ?, external_key = ?, external_url = ?, last_pushed_at = ?,
              last_pushed_hash = ?, remote_updated_at = ?, sync_state = 'synced', last_error = NULL
        WHERE id = ?`,
      [
        String(created.iid),
        connection.gitlab_project_path,
        created.web_url ?? null,
        timestamp,
        hash,
        created.updated_at ?? timestamp,
        link.id,
      ],
    );

    this.services.activity.record({
      issueId: issue.id,
      projectId: connection.project_id,
      actorId,
      type: 'gitlab.pushed',
      summary: `pushed ${issue.key} to GitLab`,
      isSystemGenerated: true,
      metadata: { connectionId: connection.id, externalId: String(created.iid) },
    });

    return {
      link: {
        ...link,
        external_id: String(created.iid),
        external_url: created.web_url ?? null,
        last_pushed_at: timestamp,
        last_pushed_hash: hash,
        remote_updated_at: created.updated_at ?? timestamp,
        sync_state: 'synced',
        last_error: null,
      },
      wrote: true,
    };
  }

  /** Fire-and-forget single-issue push used by `onIssueChanged`. */
  private async pushSingleIssue(
    connection: ConnectionRow,
    issueId: number,
    actorId: number | null = null,
  ): Promise<void> {
    const issue = this.loadIssueWithLabels(issueId);
    if (!issue) return;

    if (!this.shouldPush(connection, issue)) {
      this.services.db.run(
        `INSERT INTO gitlab_external_links
           (connection_id, issue_id, external_id, sync_state, last_error, created_at)
         VALUES (?,?,'','local_only','incidents are not mirrored by this connection',?)
         ON CONFLICT (connection_id, issue_id) DO UPDATE SET
           sync_state = 'local_only',
           last_error = 'incidents are not mirrored by this connection'`,
        [connection.id, issueId, nowIso()],
      );
      return;
    }

    const client = this.factory().forRow(connection);
    const link = this.loadLinkByIssue(connection.id, issueId) ?? this.insertLocalOnlyLink(connection, issueId);
    await this.pushIssue(connection, client, issue, link, actorId);
  }

  /** Track an unpushed local issue so the next sync picks it up. */
  private insertLocalOnlyLink(connection: ConnectionRow, issueId: number): LinkRow {
    this.services.db.run(
      `INSERT OR IGNORE INTO gitlab_external_links
         (connection_id, issue_id, external_id, sync_state, created_at)
       VALUES (?,?,'','local_only',?)`,
      [connection.id, issueId, nowIso()],
    );
    const link = this.loadLinkByIssue(connection.id, issueId);
    if (!link) throw notFound('GitLabExternalLink', issueId);
    return link;
  }

  private recordItemFailure(connection: ConnectionRow, issueId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Client messages are already token-free; still clamp the length.
    this.services.db.run(
      `UPDATE gitlab_external_links
          SET sync_state = 'error', last_error = ?
        WHERE connection_id = ? AND issue_id = ?`,
      [message.slice(0, 500), connection.id, issueId],
    );
    this.services.activity.record({
      issueId,
      projectId: connection.project_id,
      type: 'gitlab.sync_failed',
      summary: 'GitLab sync failed for this issue',
      isSystemGenerated: true,
      metadata: { connectionId: connection.id, error: message.slice(0, 300) },
    });
  }

  // =========================================================================
  // Internals: pull & conflicts
  // =========================================================================

  private async pullAll(
    connection: ConnectionRow,
    client: GitLabClient,
    counters: SyncCounters,
  ): Promise<void> {
    const issues = await client.listIssues(this.projectRef(connection), {
      state: 'all',
      // A full read re-checks everything so a missed webhook cannot strand an
      // issue; the per-item `remote_updated_at` comparison keeps it a no-op.
      updatedAfter: connection.last_sync_at,
    });
    if (issues.length > MAX_PULL_ITEMS) {
      throw integrationError('GitLab returned more issues than the safety cap allows', {
        connectionId: connection.id,
      });
    }

    for (const remote of issues) {
      try {
        await this.pullOne(connection, remote, counters);
      } catch (error) {
        counters.failed += 1;
        const link = this.loadLinkByExternal(connection.id, String(remote.iid));
        if (link) this.recordItemFailure(connection, link.issue_id, error);
      }
    }
  }

  /**
   * Import one GitLab issue: create the local issue when it is new, or apply
   * the connection's conflict rule when both sides changed.
   */
  private async pullOne(
    connection: ConnectionRow,
    remote: GitLabIssuePayload,
    counters: SyncCounters,
  ): Promise<void> {
    const projectId = connection.project_id;
    const project = this.services.db.get<{
      key: string;
      default_priority: IssuePriority;
      default_issue_type: IssueType;
    }>('SELECT key, default_priority, default_issue_type FROM projects WHERE id = ?', [projectId]);
    if (!project) throw notFound('Project', projectId);

    const statusByKey = this.statusByKey(projectId);
    const link = this.loadLinkByExternal(connection.id, String(remote.iid));

    if (!link) {
      this.createLocalIssue(connection, remote, project, statusByKey);
      counters.pulled += 1;
      return;
    }

    const issue = this.loadIssueWithLabels(link.issue_id);
    if (!issue) {
      // The local issue is gone; re-create it rather than lose the mirror.
      this.createLocalIssue(connection, remote, project, statusByKey, link);
      counters.pulled += 1;
      return;
    }

    const baseline = maxIso(maxIso(link.last_pushed_at, link.last_pulled_at), link.created_at);
    const localChanged = isNewer(issue.updated_at, baseline);
    const remoteChanged = isNewer(remote.updated_at, link.remote_updated_at ?? baseline);

    if (!remoteChanged) {
      // Nothing to do; make sure a previous error no longer hides the state.
      this.services.db.run(
        "UPDATE gitlab_external_links SET sync_state = 'synced', last_error = NULL WHERE id = ?",
        [link.id],
      );
      return;
    }

    const mapped = this.mapRemote(connection, remote, project, statusByKey, issue.reporter_id);
  // Needed either to write a conflict or to decide there is nothing to do, so
  // they are computed even when the local side has not moved.
  const differences = this.diffFields(issue, mapped);

    if (!localChanged || differences.length === 0) {
      // Only the remote moved. Whether that edit is adopted must still
      // respect the source-of-truth choice: under `local_authoritative` a
      // change made directly in GitLab is discarded, the canonical value is
      // re-pushed, and the discarded value is recorded so a human can see it.
      // Taking the fast path unconditionally let GitLab win even when the
      // connection said it must not - which is the whole point of the setting.
      if (connection.sync_mode === 'local_authoritative') {
        for (const difference of differences) {
          this.recordConflict(
            connection,
            issue,
            difference.field,
            difference.localValue,
            difference.gitlabValue,
            issue.updated_at,
            remote.updated_at,
          );
          counters.conflicts += 1;
        }
        const client = this.factory().forRow(connection);
        const outcome = await this.pushIssue(connection, client, issue, link);
        if (outcome.wrote) counters.pushed += 1;
        return;
      }

      this.applyRemote(connection, issue, mapped, remote, link);
      counters.pulled += 1;
      return;
    }

    // Both sides moved. The mode decides; the loser is preserved in a conflict.
    const localWins = this.localWins(connection.sync_mode, issue.updated_at, remote.updated_at);

    for (const difference of differences) {
      this.recordConflict(
        connection,
        issue,
        difference.field,
        difference.localValue,
        difference.gitlabValue,
        issue.updated_at,
        remote.updated_at,
      );
      counters.conflicts += 1;
    }

    if (localWins) {
      const client = this.factory().forRow(connection);
      await this.pushIssue(connection, client, issue, link);
      counters.pushed += 1;
    } else {
      this.applyRemote(connection, issue, mapped, remote, link);
      counters.pulled += 1;
    }

    this.publishConflict(connection, issue, differences.length);
  }

  /**
   * The winner of a genuine two-sided change.
   *
   * `local_authoritative` always keeps local; `gitlab_authoritative` always
   * takes GitLab; `bidirectional` compares timestamps and treats anything
   * within two seconds as a tie, which GitLab wins.
   */
  private localWins(mode: SyncMode, localUpdatedAt: string, gitlabUpdatedAt: string): boolean {
    if (mode === 'local_authoritative') return true;
    if (mode === 'gitlab_authoritative') return false;
    const local = new Date(localUpdatedAt).getTime();
    const remote = new Date(gitlabUpdatedAt).getTime();
    if (!Number.isFinite(local) || !Number.isFinite(remote)) return false;
    if (Math.abs(local - remote) <= CONFLICT_TIE_WINDOW_MS) return false;
    return local > remote;
  }

  /** Map a remote payload with this project's workflow and defaults. */
  private mapRemote(
    connection: ConnectionRow,
    remote: GitLabIssuePayload,
    project: { default_priority: IssuePriority; default_issue_type: IssueType },
    statusByKey: StatusByKey,
    reporterId: number | null,
  ): MappedIssue {
    return gitlabIssueToLocal(remote, this.settingsOf(connection), {
      projectId: connection.project_id,
      type: project.default_issue_type,
      priority: project.default_priority,
      statusId: statusIdForRemote(remote, statusByKey),
      reporterId,
      statusByKey,
    });
  }

  /** Per-field comparison of what GitLab holds against what we hold. */
  private diffFields(
    issue: IssueWithLabels,
    mapped: MappedIssue,
  ): Array<{ field: ComparedField; localValue: string | null; gitlabValue: string | null }> {
    const pairs: Array<{ field: ComparedField; local: string | null; remote: string | null }> = [
      { field: 'title', local: issue.title, remote: mapped.title },
      { field: 'description', local: issue.description, remote: mapped.description },
      { field: 'state', local: issue.state, remote: mapped.state },
      { field: 'priority', local: issue.priority, remote: mapped.priority },
      { field: 'dueDate', local: issue.due_date, remote: mapped.dueDate },
      {
        field: 'labels',
        local: normaliseList(issue.labelNames),
        remote: normaliseList(mapped.labelNames),
      },
      // Usernames are comparable on both sides; ids are not.
      { field: 'assignee', local: issue.assigneeUsername, remote: mapped.assigneeUsername },
    ];

    const differences: Array<{
      field: ComparedField;
      localValue: string | null;
      gitlabValue: string | null;
    }> = [];
    for (const pair of pairs) {
      if ((pair.local ?? '') !== (pair.remote ?? '')) {
        differences.push({ field: pair.field, localValue: pair.local, gitlabValue: pair.remote });
      }
    }
    return differences;
  }

  /**
   * Record a disagreement, idempotently, through the table's unique key. A
   * field that is still in conflict loses its previous resolution, because the
   * values on both sides have moved again.
   */
  private recordConflict(
    connection: ConnectionRow,
    issue: IssueRow,
    field: string,
    localValue: string | null,
    gitlabValue: string | null,
    localUpdatedAt: string,
    gitlabUpdatedAt: string,
  ): void {
    this.services.db.run(
      `INSERT INTO gitlab_sync_conflicts
         (connection_id, issue_id, local_issue_key, field, local_value, gitlab_value,
          local_updated_at, gitlab_updated_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (connection_id, issue_id, field) DO UPDATE SET
         local_value = excluded.local_value,
         gitlab_value = excluded.gitlab_value,
         local_updated_at = excluded.local_updated_at,
         gitlab_updated_at = excluded.gitlab_updated_at,
         resolved_at = NULL,
         resolution = NULL,
         created_at = excluded.created_at`,
      [
        connection.id,
        issue.id,
        issue.key,
        field,
        localValue,
        gitlabValue,
        localUpdatedAt,
        gitlabUpdatedAt,
        nowIso(),
      ],
    );
  }

  private publishConflict(connection: ConnectionRow, issue: IssueRow, fieldCount: number): void {
    this.services.realtime.publish({
      event: 'gitlab.conflict',
      projectId: connection.project_id,
      issueId: issue.id,
      data: { connectionId: connection.id, issueKey: issue.key, fieldCount },
    });
    this.services.activity.record({
      issueId: issue.id,
      projectId: connection.project_id,
      type: 'gitlab.conflict',
      summary: `GitLab sync conflict on ${issue.key}`,
      isSystemGenerated: true,
      metadata: { connectionId: connection.id, fieldCount },
    });
    this.notifyAdmins(
      connection,
      `GitLab conflict on ${issue.key}`,
      `${fieldCount} field(s) changed on both sides and need a decision`,
      'gitlab.sync_conflict',
    );
  }

  // =========================================================================
  // Internals: local writes
  // =========================================================================

  /** Insert a new local issue for a GitLab issue that has no link yet. */
  private createLocalIssue(
    connection: ConnectionRow,
    remote: GitLabIssuePayload,
    project: { key: string; default_priority: IssuePriority; default_issue_type: IssueType },
    statusByKey: StatusByKey,
    existingLink?: LinkRow,
  ): number {
    const mapped = this.mapRemote(connection, remote, project, statusByKey, null);
    const createdAt = remote.created_at ?? nowIso();

    const issueId = this.services.db.transaction(() => {
      const sequence = this.nextSequence(connection.project_id);
      const result = this.services.db.run(
        `INSERT INTO issues
           (project_id, sequence, key, title, description, type, priority, state, status_id,
            due_date, position, version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?,?)`,
        [
          connection.project_id,
          sequence,
          `${project.key}-${sequence}`,
          mapped.title,
          mapped.description,
          mapped.type,
          mapped.priority,
          mapped.state,
          mapped.statusId,
          mapped.dueDate,
          createdAt,
          nowIso(),
        ],
      );
      this.attachLabels(connection.project_id, mapped.labelNames, result.lastInsertRowid);
      return result.lastInsertRowid;
    });

    this.writeLink(connection, issueId, remote, existingLink);

    this.services.activity.record({
      issueId,
      projectId: connection.project_id,
      type: 'gitlab.pulled',
      summary: `imported ${remote.title} from GitLab`,
      isSystemGenerated: true,
      metadata: { connectionId: connection.id, externalId: String(remote.iid) },
    });
    this.services.realtime.publish({
      event: 'gitlab.sync',
      projectId: connection.project_id,
      issueId,
      data: { connectionId: connection.id, action: 'imported' },
    });

    return issueId;
  }

  /**
   * Apply a GitLab payload to an existing local issue. One transaction, so a
   * failure cannot leave half-imported state behind.
   */
  private applyRemote(
    connection: ConnectionRow,
    issue: IssueWithLabels,
    mapped: MappedIssue,
    remote: GitLabIssuePayload,
    link: LinkRow,
  ): void {
    const timestamp = nowIso();
    const before = {
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority,
      dueDate: issue.due_date,
    };
    const after = {
      title: mapped.title,
      description: mapped.description,
      state: mapped.state,
      priority: mapped.priority,
      dueDate: mapped.dueDate,
    };

    this.services.db.transaction(() => {
      this.services.db.run(
        `UPDATE issues
            SET title = ?, description = ?, state = ?, priority = ?, type = ?, status_id = ?,
                due_date = ?, version = version + 1, updated_at = ?
          WHERE id = ?`,
        [
          mapped.title,
          mapped.description,
          mapped.state,
          mapped.priority,
          mapped.type,
          mapped.statusId,
          mapped.dueDate,
          timestamp,
          issue.id,
        ],
      );
      this.attachLabels(connection.project_id, mapped.labelNames, issue.id);
      this.services.db.run(
        `UPDATE gitlab_external_links
            SET last_pulled_at = ?, remote_updated_at = ?, sync_state = 'synced', last_error = NULL
          WHERE id = ?`,
        [timestamp, remote.updated_at, link.id],
      );
    });

    this.services.activity.recordFieldChange({
      issueId: issue.id,
      projectId: connection.project_id,
      type: 'gitlab.pulled',
      before,
      after,
      fields: ['title', 'description', 'state', 'priority', 'dueDate'],
    });
    this.services.realtime.publish({
      event: 'issue.updated',
      projectId: connection.project_id,
      issueId: issue.id,
      data: { source: 'gitlab', connectionId: connection.id },
    });
  }

  /**
   * Apply one conflict field locally. `assignee` is intentionally not applied:
   * a GitLab username cannot be mapped back to a local user without an
   * identity table, so the value stays in the conflict row rather than being
   * guessed at.
   */
  private applyFieldLocally(
    connection: ConnectionRow,
    issue: IssueRow,
    field: string,
    value: string | null,
  ): void {
    const timestamp = nowIso();
    const bump = 'version = version + 1, updated_at = ?';

    switch (field) {
      case 'title':
        this.services.db.run(`UPDATE issues SET title = ?, ${bump} WHERE id = ?`, [
          value ?? issue.title,
          timestamp,
          issue.id,
        ]);
        break;
      case 'description':
        this.services.db.run(`UPDATE issues SET description = ?, ${bump} WHERE id = ?`, [
          value ?? '',
          timestamp,
          issue.id,
        ]);
        break;
      case 'state':
        this.services.db.run(`UPDATE issues SET state = ?, ${bump} WHERE id = ?`, [
          (value ?? issue.state) as IssueState,
          timestamp,
          issue.id,
        ]);
        break;
      case 'priority':
        this.services.db.run(`UPDATE issues SET priority = ?, ${bump} WHERE id = ?`, [
          (value ?? issue.priority) as IssuePriority,
          timestamp,
          issue.id,
        ]);
        break;
      case 'dueDate':
        this.services.db.run(`UPDATE issues SET due_date = ?, ${bump} WHERE id = ?`, [
          value,
          timestamp,
          issue.id,
        ]);
        break;
      case 'labels':
        this.replaceLabels(connection.project_id, issue.id, value);
        this.services.db.run(`UPDATE issues SET ${bump} WHERE id = ?`, [timestamp, issue.id]);
        break;
      default:
        break;
    }
  }

  /** Allocate the next issue sequence for a project. */
  private nextSequence(projectId: number): number {
    const row = this.services.db.get<{ next_issue_number: number }>(
      'SELECT next_issue_number FROM projects WHERE id = ?',
      [projectId],
    );
    const next = row?.next_issue_number ?? 1;
    this.services.db.run('UPDATE projects SET next_issue_number = ? WHERE id = ?', [
      next + 1,
      projectId,
    ]);
    return next;
  }

  /**
   * Add the local labels a GitLab label list needs, creating the missing ones.
   * Import is additive: a label that exists only locally is kept, so a sync
   * never deletes a label a human added in the tracker.
   */
  private attachLabels(projectId: number, labelNames: string[], issueId: number): void {
    const mapping = resolveLabelMapping(labelNames, this.localLabels(projectId));

    for (const name of mapping.toCreateLocal) {
      const slug = labelSlug(name);
      if (!slug) continue;
      this.services.db.run(
        `INSERT OR IGNORE INTO labels (project_id, name, slug, color, created_at)
         VALUES (?,?,?,'#6b7280',?)`,
        [projectId, name, slug, nowIso()],
      );
    }

    const available = this.localLabels(projectId);
    for (const name of mapping.matched.map((entry) => entry.gitlab).concat(mapping.toCreateLocal)) {
      const slug = labelSlug(name);
      const label = available.find(
        (row) => row.slug === slug || row.name.toLowerCase() === name.toLowerCase(),
      );
      if (!label) continue;
      this.services.db.run(
        'INSERT OR IGNORE INTO issue_labels (issue_id, label_id, created_at) VALUES (?,?,?)',
        [issueId, label.id, nowIso()],
      );
    }
  }

  /** Replace an issue's labels with a comma-separated list. */
  private replaceLabels(projectId: number, issueId: number, value: string | null): void {
    const names = (value ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    this.services.db.run('DELETE FROM issue_labels WHERE issue_id = ?', [issueId]);
    this.attachLabels(projectId, names, issueId);
  }

  private localLabels(projectId: number): Array<{ id: number; name: string; slug: string }> {
    return this.services.db.all<{ id: number; name: string; slug: string }>(
      'SELECT id, name, slug FROM labels WHERE project_id = ? OR project_id IS NULL',
      [projectId],
    );
  }

  /** Insert or refresh the provenance link for an imported issue. */
  private writeLink(
    connection: ConnectionRow,
    issueId: number,
    remote: GitLabIssuePayload,
    existingLink?: LinkRow,
  ): void {
    const timestamp = nowIso();
    if (existingLink) {
      this.services.db.run(
        `UPDATE gitlab_external_links
            SET external_id = ?, external_key = ?, external_url = ?, remote_updated_at = ?,
                sync_state = 'synced', last_error = NULL,
                last_pulled_at = COALESCE(?, last_pulled_at)
          WHERE id = ?`,
        [
          String(remote.iid),
          connection.gitlab_project_path,
          remote.web_url ?? null,
          remote.updated_at,
          timestamp,
          existingLink.id,
        ],
      );
      return;
    }

    this.services.db.run(
      `INSERT INTO gitlab_external_links
         (connection_id, issue_id, external_id, external_key, external_url, last_pulled_at,
          remote_updated_at, sync_state, created_at)
       VALUES (?,?,?,?,?,?,?, 'synced', ?)
       ON CONFLICT (connection_id, issue_id) DO UPDATE SET
         external_id = excluded.external_id,
         external_key = excluded.external_key,
         external_url = excluded.external_url,
         last_pulled_at = excluded.last_pulled_at,
         remote_updated_at = excluded.remote_updated_at,
         sync_state = 'synced',
         last_error = NULL`,
      [
        connection.id,
        issueId,
        String(remote.iid),
        connection.gitlab_project_path,
        remote.web_url ?? null,
        timestamp,
        remote.updated_at,
        timestamp,
      ],
    );
  }

  // =========================================================================
  // Internals: comments
  // =========================================================================

  /**
   * Mirror comments in both directions.
   *
   * A pushed note carries a marker naming the tracker issue; on import any
   * note with a marker is skipped, so a comment can never bounce back and
   * forth. De-duplication of pushed notes is by exact body, so a genuinely new
   * comment is never mistaken for one already on GitLab.
   */
  private async syncComments(
    connection: ConnectionRow,
    client: GitLabClient,
    link: LinkRow,
    issue: IssueRow,
  ): Promise<{ pushed: number; pulled: number }> {
    if (!bool(connection.sync_comments) || link.external_id === null) {
      return { pushed: 0, pulled: 0 };
    }
    const iid = Number(link.external_id);
    if (!Number.isInteger(iid) || iid <= 0) return { pushed: 0, pulled: 0 };

    const ref = this.projectRef(connection);
    const localComments = this.services.db.all<{ id: number; body: string }>(
      'SELECT id, body FROM comments WHERE issue_id = ? AND is_system = 0 ORDER BY id ASC',
      [issue.id],
    );
    const notes = await client.listNotes(ref, iid);
    const existingBodies = new Set(notes.map((note) => note.body.trim()));

    let pushed = 0;
    for (const comment of localComments) {
      const body = buildNoteBody(comment.body, issue.key);
      if (existingBodies.has(body)) continue;
      await client.createNote(ref, iid, body);
      existingBodies.add(body);
      pushed += 1;
    }

    let pulled = 0;
    const known = new Set(localComments.map((comment) => comment.body.trim()));
    for (const note of notes) {
      if (note.system) continue;
      if (hasNoteMarker(note.body)) continue;
      const body = stripNoteMarker(note.body).trim();
      if (!body || known.has(body)) continue;
      this.services.db.run(
        `INSERT INTO comments (issue_id, author_id, body, is_system, created_at, updated_at)
         VALUES (?,NULL,?,0,?,?)`,
        [issue.id, body, note.created_at, note.updated_at ?? note.created_at],
      );
      known.add(body);
      pulled += 1;
    }

    return { pushed, pulled };
  }

  // =========================================================================
  // Internals: orchestration
  // =========================================================================

  /** Run the requested phases and collect the counters. */
  private async executeSync(
    connection: ConnectionRow,
    options: SyncOptions,
  ): Promise<{ pushed: number; pulled: number; conflicts: number; failed: number; message: string }> {
    const counters: SyncCounters = { pushed: 0, pulled: 0, conflicts: 0, failed: 0 };
    const client = this.factory().forRow(connection);
    this.services.db.run('UPDATE gitlab_connections SET last_sync_status = ? WHERE id = ?', [
      'running',
      connection.id,
    ]);

    if (options.direction === 'push' || options.direction === 'full') {
      await this.pushAll(connection, client, counters);
    }
    if (options.direction === 'pull' || options.direction === 'full') {
      await this.pullAll(connection, client, counters);
    }
    if (bool(connection.sync_comments)) {
      await this.syncAllComments(connection, client, counters);
    }

    return {
      ...counters,
      message:
        `pushed ${counters.pushed}, pulled ${counters.pulled}, ` +
        `conflicts ${counters.conflicts}, failed ${counters.failed}`,
    };
  }

  /** Push and pull comments for every linked issue. */
  private async syncAllComments(
    connection: ConnectionRow,
    client: GitLabClient,
    counters: SyncCounters,
  ): Promise<void> {
    const links = this.services.db.all<LinkRow>(
      `SELECT * FROM gitlab_external_links
        WHERE connection_id = ? AND external_id IS NOT NULL AND external_id <> ''`,
      [connection.id],
    );
    for (const link of links) {
      try {
        const issue = this.loadIssue(link.issue_id);
        if (!issue) continue;
        const result = await this.syncComments(connection, client, link, issue);
        counters.pushed += result.pushed;
        counters.pulled += result.pulled;
      } catch (error) {
        counters.failed += 1;
        this.recordItemFailure(connection, link.issue_id, error);
      }
    }
  }
}

interface SyncCounters {
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Row mapping & small free functions
// ---------------------------------------------------------------------------

function mapRunRow(row: RunRow): SyncRun {
  return {
    id: row.id,
    connectionId: asGitLabConnectionId(row.connection_id),
    direction: row.direction,
    trigger: row.trigger,
    status: row.status,
    pushed: Number(row.pushed),
    pulled: Number(row.pulled),
    conflicts: Number(row.conflicts),
    failed: Number(row.failed),
    message: row.message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapConflictRow(row: Record<string, unknown>): SyncConflict {
  return {
    id: Number(row.id),
    connectionId: asGitLabConnectionId(Number(row.connection_id)),
    issueId: asIssueId(Number(row.issue_id)),
    localIssueKey: String(row.local_issue_key),
    field: String(row.field),
    localValue: row.local_value === null ? null : String(row.local_value),
    gitlabValue: row.gitlab_value === null ? null : String(row.gitlab_value),
    localUpdatedAt: String(row.local_updated_at),
    gitlabUpdatedAt: String(row.gitlab_updated_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    resolution:
      row.resolution === null ? null : (String(row.resolution) as SyncConflict['resolution']),
    createdAt: String(row.created_at),
  };
}

/** Case-insensitive, order-independent label list for comparison. */
function normaliseList(names: readonly string[]): string | null {
  const sorted = names
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
    .sort();
  return sorted.length > 0 ? sorted.join(',') : null;
}

/** Status id a remote issue should land on, falling back to the first status. */
function statusIdForRemote(remote: GitLabIssuePayload, statusByKey: StatusByKey): number {
  const state = mapGitLabStateToLocalState(remote.state === 'closed' ? 'closed' : 'opened', statusByKey);
  return resolveStatusIdForState(state, statusByKey) ?? [...statusByKey.values()][0]?.id ?? 0;
}

/** Iid of an issue webhook payload, when present. */
export function readIid(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const attributes = (payload as { object_attributes?: { iid?: unknown } }).object_attributes;
  const iid = Number(attributes?.iid);
  return Number.isInteger(iid) && iid > 0 ? iid : null;
}

/**
 * Stable id for an inbound delivery. GitLab retries with the same
 * `object_attributes.id`, which makes it the natural de-duplication key;
 * anything else falls back to a hash of the body.
 */
export function inboundEventId(event: string, payload: unknown, serialized: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as { object_kind?: unknown; object_attributes?: { id?: unknown } };
    const objectId = Number(record.object_attributes?.id);
    if (Number.isInteger(objectId) && objectId > 0) {
      return `${String(record.object_kind ?? 'event')}:${objectId}:${event}`;
    }
  }
  return contentHash({ event, body: serialized });
}
