/**
 * Placeholder translation, tested against the shapes that appear in this
 * repository's own SQL.
 *
 * The risk is silent: a `?` translated inside a string literal, or skipped
 * because it looked like a jsonb operator, would bind a value to the wrong
 * argument without anything throwing. So the cases below are adversarial
 * rather than representative.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { positional, toPositionalPlaceholders } from '../src/db/placeholders.ts';

describe('placeholder translation', () => {
  it('numbers placeholders in order', () => {
    assert.equal(positional('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
    assert.equal(positional('SELECT ?'), 'SELECT $1');
  });

  it('reports how many it rewrote', () => {
    assert.equal(toPositionalPlaceholders('SELECT ?, ?, ?').count, 3);
    assert.equal(toPositionalPlaceholders('SELECT 1').count, 0);
  });

  it('leaves nothing alone when there is nothing to do', () => {
    const sql = 'SELECT id, title FROM issues WHERE project_id = 1 ORDER BY id DESC';
    assert.equal(positional(sql), sql);
  });

  it('ignores a question mark inside a string literal', () => {
    assert.equal(
      positional("SELECT * FROM issues WHERE title LIKE '%needs? review%'"),
      "SELECT * FROM issues WHERE title LIKE '%needs? review%'",
    );
    // A placeholder before the string must still be numbered.
    assert.equal(
      positional("SELECT * FROM issues WHERE title = ? AND note = 'why?'"),
      "SELECT * FROM issues WHERE title = $1 AND note = 'why?'",
    );
  });

  it('handles a doubled quote inside a string', () => {
    assert.equal(
      positional("SELECT * FROM t WHERE a = ? AND b = 'it''s here? really'"),
      "SELECT * FROM t WHERE a = $1 AND b = 'it''s here? really'",
    );
  });

  it('ignores a question mark inside a quoted identifier', () => {
    assert.equal(positional('SELECT "odd?name" FROM t'), 'SELECT "odd?name" FROM t');
    assert.equal(positional('SELECT `odd?name` FROM t'), 'SELECT `odd?name` FROM t');
  });

  it('ignores a question mark inside comments', () => {
    assert.equal(positional('SELECT 1 -- really?\n'), 'SELECT 1 -- really?\n');
    assert.equal(positional('SELECT ? /* really? */'), 'SELECT $1 /* really? */');
  });

  it('ignores a question mark inside a dollar-quoted body', () => {
    // PL/pgSQL in the migrations writes these, and a trigger body is full of
    // `?`-looking text. Translating inside it would corrupt the function.
    const plpgsql = `CREATE FUNCTION f() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'why?';
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`;
    assert.equal(positional(plpgsql), plpgsql);

    const tagged = `$body$ what? $body$`;
    assert.equal(positional(tagged), tagged);
  });

  it('translates around a dollar-quoted body rather than into it', () => {
    const sql = 'SELECT $1_placeholder FROM t WHERE a = $tag$ has ? inside $tag$ AND b = ?';
    // The leading `$1_placeholder` is not a dollar quote, so the first real `?`
    // becomes $1.
    assert.equal(
      positional('SELECT a FROM t WHERE a = $tag$ ? $tag$ AND b = ?'),
      'SELECT a FROM t WHERE a = $tag$ ? $tag$ AND b = $1',
    );
  });

  it('translates every question mark outside a literal, with no lookahead rule', () => {
    // jsonb's `?` operator is indistinguishable from a placeholder by what
    // follows, and this schema has no jsonb -- it stores JSON as TEXT. A rule
    // that changed meaning based on the next character would be a trap, so
    // every `?` outside a literal or comment is a placeholder, always.
    assert.equal(positional("SELECT * FROM t WHERE meta = ? AND id = ?"), 'SELECT * FROM t WHERE meta = $1 AND id = $2');
    assert.equal(
      positional("SELECT * FROM t WHERE a = ? OR b = ?"),
      'SELECT * FROM t WHERE a = $1 OR b = $2',
    );
  });

  it('translates a realistic service query', () => {
    const sql = `
      SELECT id, key, title FROM issues
      WHERE project_id = ? AND state = ? AND archived = 0
      ORDER BY updated_at DESC
      LIMIT ?`;
    assert.equal(
      positional(sql),
      `
      SELECT id, key, title FROM issues
      WHERE project_id = $1 AND state = $2 AND archived = 0
      ORDER BY updated_at DESC
      LIMIT $3`,
    );
  });

  it('handles an unterminated string without hanging or losing the rest', () => {
    // Malformed SQL should still return; the database reports the syntax error.
    assert.equal(positional("SELECT ? FROM t WHERE a = 'unterminated"), "SELECT $1 FROM t WHERE a = 'unterminated");
  });

  it('handles an unterminated block comment', () => {
    assert.equal(positional('SELECT ? /* unterminated'), 'SELECT $1 /* unterminated');
  });

  it('handles an unterminated dollar quote', () => {
    assert.equal(positional('SELECT ? FROM $$ never closed'), 'SELECT $1 FROM $$ never closed');
  });

  it('does not treat a placeholder-shaped dollar as a dollar quote', () => {
    // `$1` must not be read as the start of a `$1$` tag.
    assert.equal(positional('SELECT $1'), 'SELECT $1');
  });
});
