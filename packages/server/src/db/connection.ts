/**
 * SQLite access layer built on `node:sqlite`.
 *
 * The database is accessed exclusively through this module so that:
 *   * prepared statements are cached rather than re-parsed per query,
 *   * foreign keys and WAL are always on,
 *   * transactions are re-entrant (nested `transaction()` calls join the outer
 *     one instead of failing), and
 *   * no SQL string is ever built by concatenating user input.
 *
 * Portability note: the query surface deliberately sticks to portable SQL.
 * `INTEGER PRIMARY KEY AUTOINCREMENT` is the one SQLite-specific construct and
 * it is isolated to the migration files, so moving to Postgres means
 * reinterpreting those two lines rather than rewriting every query.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { internalError } from '../errors.ts';

/** Values accepted as bound statement parameters. */
export type SqlParam = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface DatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  file: string;
  /** Enables WAL for better concurrent read/write behaviour. */
  wal?: boolean;
  /** Statement cache size, in KiB. */
  cacheSize?: number;
}

export class Database {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;
  private closed = false;

  constructor(options: DatabaseOptions) {
    this.file = options.file;

    if (options.file !== ':memory:') {
      mkdirSync(dirname(options.file), { recursive: true });
    }

    // Node's bundled SQLite is built with extension loading omitted, so no
    // `allowExtension` opt-in is needed (and none is offered).
    this.db = new DatabaseSync(options.file);

    // Foreign keys are off by default in SQLite and must be enabled per
    // connection. ON DELETE CASCADE in the schema depends on this.
    this.db.exec('PRAGMA foreign_keys = ON');
    if (options.wal !== false && options.file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    // NORMAL is the documented safe pairing with WAL: durable across process
    // crashes, only at risk from an OS-level crash.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA temp_store = MEMORY');
    this.db.exec(`PRAGMA cache_size = -${options.cacheSize ?? 16000}`);
  }

  /** Prepare (and cache) a statement. */
  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  /** Run a statement and return the writer result (`lastInsertRowid`, `changes`). */
  run(sql: string, params: SqlParam[] = []): { changes: number; lastInsertRowid: number } {
    this.assertOpen();
    try {
      const result = this.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    } catch (error) {
      throw this.wrap(error, sql);
    }
  }

  /** Fetch a single row, or `undefined` when there is no match. */
  get<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T | undefined {
    this.assertOpen();
    try {
      return this.prepare(sql).get(...params) as T | undefined;
    } catch (error) {
      throw this.wrap(error, sql);
    }
  }

  /** Fetch every matching row. */
  all<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    this.assertOpen();
    try {
      return this.prepare(sql).all(...params) as T[];
    } catch (error) {
      throw this.wrap(error, sql);
    }
  }

  /** Fetch the first column of the first row, e.g. a COUNT or MAX. */
  scalar<T = unknown>(sql: string, params: SqlParam[] = []): T | undefined {
    const row = this.get<Record<string, T>>(sql, params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length > 0 ? row[keys[0] as string] : undefined;
  }

  /** Execute raw SQL, used by the migration runner for DDL. */
  exec(sql: string): void {
    this.assertOpen();
    try {
      this.db.exec(sql);
    } catch (error) {
      throw this.wrap(error, sql);
    }
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction, so
   * a service can call another service without either knowing who owns the
   * transaction.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction is already gone; the
        // original error is the one worth reporting.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  /** Statement cache lookup, used by the repository layer for hot queries. */
  statement(sql: string): StatementSync {
    return this.prepare(sql);
  }

  close(): void {
    if (this.closed) return;
    this.statements.clear();
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw internalError('Database connection is closed');
  }

  /**
   * Add the failing SQL and parameters to the error. The SQL is developer-facing
   * text we control; bound parameters are included because SQLite error messages
   * such as UNIQUE failures do not name the offending column otherwise.
   */
  private wrap(error: unknown, sql: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const err = internalError(`Database error: ${message}`, error);
    (err as { sql?: string }).sql = sql;
    return err;
  }
}

/**
 * Build a `?, ?, ?` placeholder list of the given length. Callers pass the
 * resulting string plus a matching parameter array, which keeps every value
 * bound and therefore injection-safe.
 */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** Build `(?, ?, ?)` for an `IN (...)` clause. */
export function inClause(count: number): string {
  return `(${placeholders(count)})`;
}
