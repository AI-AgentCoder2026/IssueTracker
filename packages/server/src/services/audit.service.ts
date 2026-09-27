/**
 * Append-only audit trail with a hash chain.
 *
 * Each entry stores the SHA-256 of its own canonical contents together with the
 * previous entry's hash:
 *
 *     rowHash_n = SHA256(canonical({ actorId, action, entityType, entityId,
 *                                    projectId, before, after, createdAt }))
 *     prevHash_n = rowHash_{n-1}
 *
 * The `audit_log` table additionally refuses UPDATE and DELETE at the database
 * level, so the chain cannot be rewritten even by a bug. `verifyChain()`
 * recomputes the whole chain to prove nothing was altered out of band.
 */

import type { AuditAction, AuditChainVerification, AuditEntry } from '@tracker/shared';
import { canonicalJson } from '@tracker/shared';
import type { Database } from '../db/connection.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { nowIso } from '../lib/time.ts';

/** Canonical, order-independent serialisation used for hashing. */
export function canonicalAuditPayload(entry: {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId: string | null;
  projectId: number | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}): string {
  return canonicalJson({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    projectId: entry.projectId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    createdAt: entry.createdAt,
  });
}

export function computeRowHash(payload: string): string {
  return sha256Hex(payload);
}

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | number | null;
  projectId?: number | null;
  /** State before the change; omit for creations. */
  before?: unknown;
  /** State after the change; omit for deletions. */
  after?: unknown;
  actorId?: number | null;
  actorName?: string;
  actorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Overrides the timestamp; used only by tests and imports. */
  createdAt?: string;
}

export interface AuditActorContext {
  actorId: number | null;
  actorName: string;
  actorEmail: string;
  ipAddress: string;
  userAgent: string;
}

/** Context attached to a request so services can record who did what. */
export interface RequestAuditContext extends Partial<AuditActorContext> {}

export class AuditService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }
  /**
   * Append one entry. The chain is read and extended inside the caller's
   * transaction, so two concurrent writers cannot both read the same tail hash.
   */
  record(input: AuditInput, context: RequestAuditContext = {}): AuditEntry {
    const createdAt = input.createdAt ?? nowIso();
    const actorId = input.actorId ?? context.actorId ?? null;
    const projectId = input.projectId ?? null;
    const entityId =
      input.entityId === undefined || input.entityId === null ? null : String(input.entityId);

    const payload = canonicalAuditPayload({
      actorId,
      action: input.action,
      entityType: input.entityType,
      entityId,
      projectId,
      before: input.before ?? null,
      after: input.after ?? null,
      createdAt,
    });

    // Reading the tail inside the enclosing transaction is what makes the chain
    // linear; SQLite serialises writers, so the read-then-append is atomic.
    const tail = this.db.get<{ row_hash: string }>(
      'SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1',
    );
    const prevHash = tail?.row_hash ?? null;
    const rowHash = computeRowHash(`${prevHash ?? ''}${payload}`);

    const result = this.db.run(
      `INSERT INTO audit_log
         (actor_id, actor_name, actor_email, ip_address, user_agent,
          action, entity_type, entity_id, project_id,
          before_json, after_json, row_hash, prev_hash, created_at)
       VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)`,
      [
        actorId,
        input.actorName ?? context.actorName ?? '',
        input.actorEmail ?? context.actorEmail ?? '',
        input.ipAddress ?? context.ipAddress ?? 'system',
        input.userAgent ?? context.userAgent ?? '',
        input.action,
        input.entityType,
        entityId,
        projectId,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        rowHash,
        prevHash,
        createdAt,
      ],
    );

    return {
      id: result.lastInsertRowid,
      actorId: actorId as AuditEntry['actorId'],
      actorName: input.actorName ?? context.actorName ?? '',
      actorEmail: input.actorEmail ?? context.actorEmail ?? '',
      ipAddress: input.ipAddress ?? context.ipAddress ?? 'system',
      userAgent: input.userAgent ?? context.userAgent ?? '',
      action: input.action,
      entityType: input.entityType,
      entityId,
      projectId: projectId as AuditEntry['projectId'],
      before: (input.before ?? null) as AuditEntry['before'],
      after: (input.after ?? null) as AuditEntry['after'],
      rowHash,
      prevHash,
      createdAt,
    };
  }

  /** Record several entries atomically, keeping the chain consistent. */
  recordMany(inputs: AuditInput[], context: RequestAuditContext = {}): AuditEntry[] {
    return this.db.transaction(() => inputs.map((input) => this.record(input, context)));
  }

  /**
   * Recompute every row hash and confirm each `prevHash` matches the row above.
   * This is the evidence that the trail has not been tampered with.
   */
  verifyChain(options: { limit?: number; since?: string } = {}): AuditChainVerification {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.since) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.all<{
      id: number;
      actor_id: number | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      project_id: number | null;
      before_json: string | null;
      after_json: string | null;
      row_hash: string;
      prev_hash: string | null;
      created_at: string;
    }>(`SELECT * FROM audit_log ${where} ORDER BY id ASC`, params);

    const toVerify = options.limit ? rows.slice(-options.limit) : rows;
    // Chain validation is only meaningful from the true genesis entry, so the
    // expected predecessor for the first verified row is read from the row above.
    const startIndex = rows.length - toVerify.length;
    let expectedPrev = startIndex > 0 ? (rows[startIndex - 1] as { row_hash: string }).row_hash : null;

    for (const row of toVerify) {
      if ((row.prev_hash ?? null) !== expectedPrev) {
        return {
          valid: false,
          brokenAtId: row.id,
          entriesChecked: toVerify.length,
          message:
            `Chain break at audit entry ${row.id}: prev_hash does not match the preceding entry. ` +
            'An audit row was altered or removed outside the application.',
        };
      }

      let before: unknown = null;
      let after: unknown = null;
      try {
        before = row.before_json === null ? null : JSON.parse(row.before_json);
        after = row.after_json === null ? null : JSON.parse(row.after_json);
      } catch {
        return {
          valid: false,
          brokenAtId: row.id,
          entriesChecked: toVerify.length,
          message: `Audit entry ${row.id} contains malformed JSON and cannot be verified`,
        };
      }

      const payload = canonicalAuditPayload({
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        projectId: row.project_id,
        before,
        after,
        createdAt: row.created_at,
      });

      const expectedHash = computeRowHash(`${row.prev_hash ?? ''}${payload}`);
      if (expectedHash !== row.row_hash) {
        return {
          valid: false,
          brokenAtId: row.id,
          entriesChecked: toVerify.length,
          message:
            `Hash mismatch at audit entry ${row.id}: the stored contents no longer match ` +
            'the recorded row hash.',
        };
      }

      expectedPrev = row.row_hash;
    }

    return {
      valid: true,
      brokenAtId: null,
      entriesChecked: toVerify.length,
      message: `Verified ${toVerify.length} audit entries; the hash chain is intact.`,
    };
  }

  /** Paginated read for the audit viewer, newest first. */
  list(query: {
    actorId?: number;
    action?: string;
    entityType?: string;
    entityId?: string;
    projectId?: number;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: number;
  }): { entries: AuditEntry[]; total: number; nextCursor: number | null } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.actorId !== undefined) {
      clauses.push('actor_id = ?');
      params.push(query.actorId);
    }
    if (query.action) {
      clauses.push('action = ?');
      params.push(query.action);
    }
    if (query.entityType) {
      clauses.push('entity_type = ?');
      params.push(query.entityType);
    }
    if (query.entityId) {
      clauses.push('entity_id = ?');
      params.push(query.entityId);
    }
    if (query.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(query.projectId);
    }
    if (query.from) {
      clauses.push('created_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('created_at <= ?');
      params.push(query.to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(
      this.db.scalar<number>(`SELECT COUNT(*) AS c FROM audit_log ${where}`, params) ?? 0,
    );

    const limit = Math.min(query.limit ?? 100, 500);

    // Keyset pagination: `id < cursor` stays stable while new rows arrive.
    // The clause is only appended when there is actually a cursor — emitting
    // `WHERE id < ?` with no bound value would be a placeholder/param mismatch.
    let sql = `SELECT * FROM audit_log`;
    const bind: Array<string | number> = [...params];

    if (where) {
      sql += ` WHERE ${where}`;
    }
    if (query.cursor) {
      sql += `${where ? ' AND' : ' WHERE'} id < ?`;
      bind.push(query.cursor);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    bind.push(limit + 1);

    const rows = this.db.all<Record<string, unknown>>(sql, bind);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      entries: page.map((row) => this.mapRow(row)),
      total,
      nextCursor: hasMore && last ? Number(last.id) : null,
    };
  }

  /** Full detail for a single entity, used by the "history" panel in the UI. */
  historyFor(entityType: string, entityId: string | number, limit = 50): AuditEntry[] {
    return this.list({ entityType, entityId: String(entityId), limit }).entries;
  }

  private mapRow(row: Record<string, unknown>): AuditEntry {
    const parse = (value: unknown): Record<string, unknown> | null => {
      if (typeof value !== 'string' || value === '') return null;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    };

    return {
      id: Number(row.id),
      actorId: row.actor_id === null ? null : (Number(row.actor_id) as AuditEntry['actorId']),
      actorName: String(row.actor_name ?? ''),
      actorEmail: String(row.actor_email ?? ''),
      ipAddress: String(row.ip_address ?? ''),
      userAgent: String(row.user_agent ?? ''),
      action: String(row.action) as AuditAction,
      entityType: String(row.entity_type ?? ''),
      entityId: row.entity_id === null ? null : String(row.entity_id),
      projectId: row.project_id === null ? null : (Number(row.project_id) as AuditEntry['projectId']),
      before: parse(row.before_json),
      after: parse(row.after_json),
      rowHash: String(row.row_hash ?? ''),
      prevHash: row.prev_hash === null ? null : String(row.prev_hash),
      createdAt: String(row.created_at ?? ''),
    };
  }
}
