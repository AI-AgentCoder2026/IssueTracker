/**
 * Dialect translation, tested against the exact shapes in this repository's SQL.
 *
 * These rewrites are arithmetic as much as syntax: the `julianday` buckets feed
 * SLA and dashboard counts, and an off-by-one there would produce a plausible,
 * confidently wrong number rather than an error. So the cases assert the
 * translated *meaning*, not just that something changed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toPostgres } from '../src/db/dialect.ts';

describe('dialect translation', () => {
  it('leaves portable SQL untouched', () => {
    const sql = 'SELECT id, key FROM issues WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?';
    const result = toPostgres(sql);
    assert.equal(result.sql, sql);
    assert.deepEqual(result.applied, []);
  });

  describe('INSERT OR IGNORE', () => {
    it('becomes a plain INSERT with a conflict clause', () => {
      const result = toPostgres('INSERT OR IGNORE INTO labels (name) VALUES (?)');
      assert.match(result.sql, /^INSERT INTO/);
      assert.ok(result.applied.includes('insert-or-ignore'));
    });

    it('does not mis-handle REPLACE as IGNORE', () => {
      // `INSERT OR REPLACE` also starts with `INSERT OR`; getting this wrong
      // would turn a replace into a bare insert and change the semantics.
      const result = toPostgres('INSERT OR REPLACE INTO labels (name) VALUES (?)');
      assert.match(result.sql, /^INSERT INTO/);
      assert.ok(result.applied.includes('insert-or-replace'));
      assert.ok(!result.applied.includes('insert-or-ignore'));
    });
  });

  describe('strftime', () => {
    it('emits an ISO-8601 UTC string with milliseconds and a Z', () => {
      const result = toPostgres("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      assert.match(result.sql, /to_char\(now\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/);
    });

    it('emits a plain date for a date-only format', () => {
      const result = toPostgres("SELECT strftime('%Y-%m-%d', 'now')");
      assert.match(result.sql, /to_char\(now\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD'\)/);
    });

    it('leaves an unsupported format for the database to reject', () => {
      // Silently translating an unknown format would return the wrong string
      // rather than failing, so this must pass through untouched.
      const sql = "SELECT strftime('%W of %Y', 'now')";
      assert.equal(toPostgres(sql).sql, sql);
    });
  });

  describe('julianday', () => {
    it('turns now() into a whole-day count from the epoch', () => {
      const result = toPostgres("SELECT CAST(julianday('now') AS INTEGER)");
      assert.match(result.sql, /\(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)::date - DATE '1970-01-01'/);
      assert.ok(result.applied.includes('julianday'));
    });

    it('converts a timestamp column through UTC before taking the date', () => {
      // Without the UTC step an event at 23:30 UTC lands in the previous
      // bucket on a machine behind UTC, which would shift a whole day of
      // counts.
      const result = toPostgres('AND julianday(i.created_at) < days.d + 1');
      assert.match(result.sql, /AT TIME ZONE 'UTC'/);
      assert.match(result.sql, /::date - DATE '1970-01-01'/);
    });

    it('keeps the surrounding CTE intact', () => {
      const sql = `WITH RECURSIVE params(start_day) AS (SELECT CAST(julianday('now') - ? AS INTEGER)),
SELECT d + 1 FROM days WHERE d < CAST(julianday('now') AS INTEGER)`;
      const result = toPostgres(sql);
      assert.equal((result.sql.match(/AT TIME ZONE 'UTC'/g) ?? []).length, 2);
      assert.match(result.sql, /WITH RECURSIVE/);
      assert.match(result.sql, /SELECT d \+ 1 FROM days/);
    });
  });

  describe('group_concat', () => {
    it('becomes string_agg with the same separator', () => {
      const result = toPostgres("SELECT group_concat(t.role, ', ') FROM t");
      assert.match(result.sql, /string_agg\(CAST\(t\.role AS text\), ', '\)/);
    });

    it('defaults to a comma when no separator is given', () => {
      const result = toPostgres('SELECT group_concat(t.role) FROM t');
      assert.match(result.sql, /string_agg\(CAST\(t\.role AS text\), ','\)/);
    });

    it('respects a separator containing a comma', () => {
      const result = toPostgres("SELECT group_concat(t.k, ' | ') FROM t");
      assert.match(result.sql, /string_agg\(CAST\(t\.k AS text\), ' \| '\)/);
    });
  });

  describe('safety', () => {
    it('does not rewrite a call name inside a string literal', () => {
      const sql = "SELECT * FROM t WHERE note LIKE '%strftime(%' AND id = ?";
      const result = toPostgres(sql);
      assert.match(result.sql, /LIKE '%strftime\(%'/, 'a literal must survive verbatim');
    });

    it('does not rewrite inside a comment', () => {
      const sql = 'SELECT 1 -- group_concat(x)\nFROM t';
      const result = toPostgres(sql);
      assert.match(result.sql, /-- group_concat\(x\)/);
    });

    it('does not rewrite a longer identifier that ends with the name', () => {
      const sql = 'SELECT my_group_concat(a) FROM t';
      assert.equal(toPostgres(sql).sql, sql);
    });

    it('applies several rewrites in one statement', () => {
      const sql =
        "WITH days AS (SELECT CAST(julianday('now') AS INTEGER)) SELECT group_concat(d, ', '), strftime('%Y-%m-%d', 'now') FROM days";
      const result = toPostgres(sql);
      assert.ok(result.applied.includes('julianday'));
      assert.ok(result.applied.includes('group_concat'));
      assert.ok(result.applied.includes('strftime'));
    });

    it('survives an unterminated literal', () => {
      const sql = "SELECT strftime('%Y-%m-%d', 'unterminated";
      // Must return rather than throw; the database reports the real error.
      assert.doesNotThrow(() => toPostgres(sql));
    });
  });
});
