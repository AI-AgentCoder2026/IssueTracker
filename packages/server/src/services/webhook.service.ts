/**
 * Outgoing webhooks.
 *
 * A webhook is an HTTPS endpoint a project owner registers; the tracker POSTs
 * a JSON envelope to it whenever something happens in the project. Delivery is
 * out of band: `enqueue()` only writes a row, and the actual HTTP call happens
 * on a detached promise (or later, from `processPending`, when the endpoint was
 * down). That keeps a slow or dead endpoint off the request path.
 *
 * Every delivery is signed with `X-Tracker-Signature: sha256=<hmac>` so the
 * receiver can verify authenticity, and the same signature is stored on the row
 * so a delivery can be re-verified while debugging.
 *
 * A webhook that keeps failing is disabled after `FAILURE_THRESHOLD` consecutive
 * failures rather than being retried forever.
 */

import type { WebhookId } from '@tracker/shared';
import { badRequest, notFound } from '../errors.ts';
import { generateToken, hmacSha256Hex } from '../lib/crypto.ts';
import { MINUTE_MS, nowIso } from '../lib/time.ts';
import type { RequestContext, Services } from './context.ts';

/** Consecutive failures before a webhook is disabled. */
const FAILURE_THRESHOLD = 10;
/** Attempts before a delivery is given up on. */
const MAX_ATTEMPTS = 5;
/** Response bodies are stored for debugging; keep them small. */
const MAX_RESPONSE_BYTES = 2_048;
/** Most deliveries a single `processPending` tick will attempt. */
const DEFAULT_BATCH = 25;

export type WebhookRow = {
  id: number;
  project_id: number | null;
  name: string;
  target_url: string;
  secret: string;
  events: string;
  enabled: number;
  failure_count: number;
  disabled_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryRow = {
  id: number;
  webhook_id: number;
  event: string;
  payload: string;
  status_code: number | null;
  response_body: string | null;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  error: string | null;
  request_signature: string | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
};

/** What the API returns; the signing secret is only ever included at creation. */
export interface WebhookPublic {
  id: WebhookId;
  projectId: number;
  name: string;
  targetUrl: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only in the response that created the webhook. */
  secret?: string;
}

export interface CreateWebhookInput {
  name: string;
  targetUrl: string;
  events: string[];
  enabled: boolean;
}

export type WebhookPatch = Partial<CreateWebhookInput>;

export interface DeliverySummary {
  id: number;
  webhookId: number;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  statusCode: number | null;
  attempt: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** Events the tracker can emit. Kept loose so new events need no migration. */
const KNOWN_EVENTS = [
  'issue.created',
  'issue.updated',
  'issue.transitioned',
  'issue.deleted',
  'issue.archived',
  'comment.created',
  'gitlab.sync',
  'gitlab.conflict',
  'ping',
] as const;

function bool(value: number | null | undefined): boolean {
  return Number(value) === 1;
}

/**
 * Backoff before the next attempt: 1, 2, 4, 8 … minutes, capped at an hour.
 * Applied against `completed_at` so no extra column is needed.
 */
function backoffMs(attempt: number): number {
  return Math.min(MINUTE_MS * 2 ** Math.max(0, attempt - 1), 60 * MINUTE_MS);
}

/** Only http(s) targets, and never a credential-bearing URL. */
function assertTargetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Webhook targetUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Webhook targetUrl must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw badRequest('Webhook targetUrl must not embed credentials');
  }
  return url.toString();
}

export class WebhookService {
  private readonly services: Services;

  constructor(services: Services) {
    this.services = services;
  }

  // =========================================================================
  // CRUD
  // =========================================================================

  /**
   * Create a webhook. The signing secret is generated here and returned
   * exactly once — it is never readable again, only its hint.
   */
  create(projectId: number, input: CreateWebhookInput, ctx: RequestContext): WebhookPublic {
    const targetUrl = assertTargetUrl(input.targetUrl);
    const events = this.validateEvents(input.events);
    const secret = generateToken(32);
    const timestamp = nowIso();

    const id = this.services.db.transaction(() => {
      const result = this.services.db.run(
        `INSERT INTO webhooks
           (project_id, name, target_url, secret, events, enabled, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          projectId,
          input.name.trim(),
          targetUrl,
          secret,
          JSON.stringify(events),
          input.enabled ? 1 : 0,
          ctx.actor.userId,
          timestamp,
          timestamp,
        ],
      );
      return result.lastInsertRowid;
    });

    this.services.audit.record(
      {
        action: 'webhook.created',
        entityType: 'Webhook',
        entityId: id,
        projectId,
        after: { name: input.name.trim(), targetUrl, events, enabled: input.enabled },
      },
      ctx.auditContext,
    );

    const row = this.loadOwned(projectId, id);
    // The signing secret is returned exactly once, here.
    return { ...this.toPublic(row), secret };
  }

  /** Webhooks registered for a project. */
  list(projectId: number): WebhookPublic[] {
    return this.services.db
      .all<WebhookRow>(
        'SELECT * FROM webhooks WHERE project_id = ? ORDER BY id ASC',
        [projectId],
      )
      .map((row) => this.toPublic(row));
  }

  /**
   * Update a webhook. The signing secret cannot be changed here — rotating it
   * means creating a new webhook, so an endpoint never silently stops
   * verifying mid-flight.
   */
  update(projectId: number, id: number, patch: WebhookPatch, ctx: RequestContext): WebhookPublic {
    const before = this.loadOwned(projectId, id);
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name.trim());
    }
    if (patch.targetUrl !== undefined) {
      sets.push('target_url = ?');
      params.push(assertTargetUrl(patch.targetUrl));
    }
    if (patch.events !== undefined) {
      sets.push('events = ?');
      params.push(JSON.stringify(this.validateEvents(patch.events)));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?', 'disabled_at = ?');
      params.push(patch.enabled ? 1 : 0, null);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), before.id);
      this.services.db.run(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    this.services.audit.record(
      {
        action: 'webhook.updated',
        entityType: 'Webhook',
        entityId: before.id,
        projectId,
        before: {
          name: before.name,
          targetUrl: before.target_url,
          events: JSON.parse(before.events) as string[],
          enabled: bool(before.enabled),
        },
        after: {
          name: patch.name?.trim() ?? before.name,
          targetUrl: patch.targetUrl ?? before.target_url,
          events: patch.events ?? (JSON.parse(before.events) as string[]),
          enabled: patch.enabled ?? bool(before.enabled),
        },
      },
      ctx.auditContext,
    );

    const after = this.loadOwned(projectId, id);
    return this.toPublic(after);
  }

  /** Delete a webhook; its deliveries cascade away with it. */
  remove(projectId: number, id: number, ctx: RequestContext): void {
    const row = this.loadOwned(projectId, id);
    this.services.db.run('DELETE FROM webhooks WHERE id = ?', [row.id]);
    this.services.audit.record(
      {
        action: 'webhook.deleted',
        entityType: 'Webhook',
        entityId: row.id,
        projectId,
        before: { name: row.name, targetUrl: row.target_url },
      },
      ctx.auditContext,
    );
  }

  /** Recent deliveries for one webhook, newest first. */
  listDeliveries(projectId: number, webhookId: number, limit = 50): DeliverySummary[] {
    this.loadOwned(projectId, webhookId);
    return this.services.db
      .all<DeliveryRow>(
        `SELECT d.* FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id
          WHERE w.project_id = ? AND d.webhook_id = ?
          ORDER BY d.id DESC
          LIMIT ?`,
        [projectId, webhookId, Math.min(Math.max(limit, 1), 200)],
      )
      .map((row) => this.toSummary(row));
  }

  // =========================================================================
  // Delivery
  // =========================================================================

  /**
   * Queue an event for every enabled webhook of a project that subscribes to
   * it, then attempt delivery out of band. Returns the delivery ids created so
   * a caller can correlate them with a sync run.
   */
  enqueue(event: string, projectId: number, payload: unknown): number[] {
    const body = JSON.stringify({ event, projectId, at: nowIso(), data: payload ?? {} });
    const rows = this.services.db.all<WebhookRow>(
      'SELECT * FROM webhooks WHERE project_id = ? AND enabled = 1 AND disabled_at IS NULL',
      [projectId],
    );

    const ids: number[] = [];
    for (const webhook of rows) {
      if (!this.subscribesTo(webhook, event)) continue;
      const result = this.services.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, attempt, created_at)
         VALUES (?,?,?, 'pending', 0, ?)`,
        [webhook.id, event, body, nowIso()],
      );
      ids.push(result.lastInsertRowid);
    }

    for (const id of ids) {
      void this.deliver(id).catch(() => {
        /* recorded on the delivery row */
      });
    }

    return ids;
  }

  /**
   * Attempt one delivery. A 2xx is a success; anything else is a failure that
   * increments the webhook's failure count and, at the threshold, disables the
   * webhook. Retries use the `attempt` column for backoff.
   */
  async deliver(deliveryId: number): Promise<boolean> {
    const delivery = this.services.db.get<DeliveryRow>(
      'SELECT * FROM webhook_deliveries WHERE id = ?',
      [deliveryId],
    );
    if (!delivery) throw notFound('WebhookDelivery', deliveryId);
    if (delivery.status === 'delivered') return true;

    const webhook = this.services.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', [
      delivery.webhook_id,
    ]);
    if (!webhook) throw notFound('Webhook', delivery.webhook_id);
    if (!bool(webhook.enabled) || webhook.disabled_at !== null) {
      this.services.db.run(
        "UPDATE webhook_deliveries SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
        ['Webhook is disabled', nowIso(), delivery.id],
      );
      return false;
    }

    const body = delivery.payload;
    const signature = hmacSha256Hex(webhook.secret, body);
    const attempt = Number(delivery.attempt) + 1;
    const startedAt = Date.now();

    let statusCode: number | null = null;
    let responseText = '';
    let error: string | null = null;

    try {
      const response = await fetch(webhook.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'IssueTracker-Webhook/1.0',
          'X-Tracker-Event': delivery.event,
          'X-Tracker-Delivery': String(delivery.id),
          'X-Tracker-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(this.services.config.webhookTimeoutMs),
      });
      statusCode = response.status;
      responseText = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
      if (!response.ok) error = `Endpoint returned ${response.status}`;
    } catch (caught) {
      error =
        caught instanceof Error
          ? `Delivery failed: ${caught.message}`
          : 'Delivery failed for an unknown reason';
    }

    const durationMs = Date.now() - startedAt;
    const succeeded = error === null && statusCode !== null && statusCode >= 200 && statusCode < 300;
    const willRetry = !succeeded && attempt < MAX_ATTEMPTS;

    this.services.db.run(
      `UPDATE webhook_deliveries
          SET status = ?, status_code = ?, response_body = ?, error = ?, attempt = ?,
              request_signature = ?, duration_ms = ?, completed_at = ?
        WHERE id = ?`,
      [
        succeeded ? 'delivered' : willRetry ? 'pending' : 'failed',
        statusCode,
        responseText === '' ? null : responseText,
        succeeded ? null : error?.slice(0, 500) ?? null,
        attempt,
        signature,
        durationMs,
        nowIso(),
        delivery.id,
      ],
    );

    if (!succeeded) this.registerFailure(webhook);

    return succeeded;
  }

  /**
   * Deliver everything currently due. Called by the scheduler; the backoff is
   * enforced per row against `completed_at`, so no extra column is needed.
   */
  async processPending(limit = DEFAULT_BATCH): Promise<{ delivered: number; failed: number }> {
    const rows = this.services.db.all<DeliveryRow>(
      `SELECT * FROM webhook_deliveries
        WHERE status = 'pending' AND attempt < ?
        ORDER BY id ASC
        LIMIT ?`,
      [MAX_ATTEMPTS, Math.min(Math.max(limit, 1), 200)],
    );

    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      // A retried row waits for its own backoff window to elapse.
      if (row.completed_at !== null) {
        const dueAt = new Date(row.completed_at).getTime() + backoffMs(Number(row.attempt));
        if (dueAt > Date.now()) continue;
      }
      try {
        if (await this.deliver(row.id)) delivered += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    return { delivered, failed };
  }

  /** Send a `ping` so an operator can verify an endpoint end to end. */
  async test(projectId: number, id: number, ctx: RequestContext): Promise<DeliverySummary> {
    const row = this.loadOwned(projectId, id);
    const body = JSON.stringify({
      event: 'ping',
      projectId,
      at: nowIso(),
      data: { webhookId: row.id, name: row.name, message: 'This is a test delivery' },
    });
    const inserted = this.services.db.run(
      `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, attempt, created_at)
       VALUES (?,'ping',?, 'pending', 0, ?)`,
      [row.id, body, nowIso()],
    );
    const deliveryId = inserted.lastInsertRowid;

    this.services.audit.record(
      {
        action: 'webhook.updated',
        entityType: 'Webhook',
        entityId: row.id,
        projectId,
        actorId: ctx.actor.userId,
        after: { action: 'test', deliveryId },
      },
      ctx.auditContext,
    );

    await this.deliver(deliveryId);

    const delivery = this.services.db.get<DeliveryRow>(
      'SELECT * FROM webhook_deliveries WHERE id = ?',
      [deliveryId],
    );
    if (!delivery) throw notFound('WebhookDelivery', deliveryId);
    return this.toSummary(delivery);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private loadOwned(projectId: number, id: number): WebhookRow {
    const row = this.services.db.get<WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ? AND project_id = ?',
      [id, projectId],
    );
    if (!row) throw notFound('Webhook', id);
    return row;
  }

  /** An empty subscription list means "nothing", not "everything". */
  private subscribesTo(webhook: WebhookRow, event: string): boolean {
    const events = parseEvents(webhook.events);
    return events.includes(event) || events.includes('*');
  }

  private validateEvents(events: string[]): string[] {
    const unique = [...new Set(events.map((event) => event.trim()).filter((event) => event !== ''))];
    if (unique.length === 0) throw badRequest('A webhook must subscribe to at least one event');
    if (unique.length > 50) throw badRequest('A webhook may subscribe to at most 50 events');
    const unknown = unique.filter(
      (event) => event !== '*' && !(KNOWN_EVENTS as readonly string[]).includes(event),
    );
    if (unknown.length > 0) {
      throw badRequest(`Unknown webhook event: ${unknown[0] ?? ''}`);
    }
    return unique;
  }

  /** Count a failure and disable a webhook that has given up. */
  private registerFailure(webhook: WebhookRow): void {
    const failures = Number(webhook.failure_count) + 1;
    if (failures >= FAILURE_THRESHOLD) {
      this.services.db.run(
        'UPDATE webhooks SET enabled = 0, disabled_at = ?, failure_count = ?, updated_at = ? WHERE id = ?',
        [nowIso(), failures, nowIso(), webhook.id],
      );
      return;
    }
    this.services.db.run('UPDATE webhooks SET failure_count = ?, updated_at = ? WHERE id = ?', [
      failures,
      nowIso(),
      webhook.id,
    ]);
  }

  private toPublic(row: WebhookRow): WebhookPublic {
    return {
      id: row.id as WebhookId,
      projectId: row.project_id ?? 0,
      name: row.name,
      targetUrl: row.target_url,
      events: parseEvents(row.events),
      enabled: bool(row.enabled),
      failureCount: Number(row.failure_count),
      disabledAt: row.disabled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toSummary(row: DeliveryRow): DeliverySummary {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      event: row.event,
      status: row.status,
      statusCode: row.status_code === null ? null : Number(row.status_code),
      attempt: Number(row.attempt),
      error: row.error,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

/** Tolerate a malformed `events` column rather than failing a whole listing. */
function parseEvents(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
