/**
 * Response normalisers.
 *
 * This is the layer that stands between a server payload and a React render.
 * Its stated contract is that every function is total: a malformed payload
 * degrades to an empty list rather than throwing inside a component. That
 * property is worth defending, because a normaliser that quietly returns
 * defaults fails silently and renders a page full of plausible-looking
 * zeroes.
 *
 * The regression these were written for: `unwrap` peels a `{ data }` envelope,
 * and a *rendered* dashboard widget carries a `data` key of its own. Unwrapping
 * one handed back that payload instead of the widget, so every widget on every
 * dashboard arrived as a default "Issue list" with no data -- the entire
 * dashboard rendering feature, broken while still looking like it worked.
 */

import { describe, it, expect } from 'vitest';
import {
  asArray,
  asRecord,
  bool,
  enumValue,
  isRecord,
  num,
  str,
  strOrNull,
  toComment,
  toDashboard,
  toIssue,
  toIssueTiming,
  toRenderedDashboard,
  toRenderedWidget,
  toWidget,
  unwrap,
} from './normalize.ts';

describe('primitives', () => {
  it('recognises plain objects and nothing else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('peels a data or result envelope', () => {
    expect(unwrap({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrap({ result: [1, 2] })).toEqual([1, 2]);
    // A bare payload is returned as-is.
    expect(unwrap({ a: 1 })).toEqual({ a: 1 });
    expect(unwrap(null)).toBeNull();
  });

  it('peels an envelope that also carries meta or a request id', () => {
    expect(unwrap({ data: [1], meta: { totalCount: 1 } })).toEqual([1]);
    expect(unwrap({ result: { ok: true }, requestId: 'abc' })).toEqual({ ok: true });
  });

  it('refuses to peel a domain row that has a data field of its own', () => {
    // The systemic guard. `RenderedWidget` is `{ ...widget, data }`, so
    // peeling it handed the normaliser the payload instead of the widget and
    // every field fell back to a default. A row is recognised by carrying
    // identity keys alongside the envelope-shaped ones.
    const row = { id: 42, type: 'sla_countdown', data: { kind: 'list' } };
    expect(unwrap(row)).toBe(row);
    expect(unwrap({ id: 1, result: { x: 1 } })).toEqual({ id: 1, result: { x: 1 } });
  });

  it('coerces scalars without inventing values', () => {
    expect(str('x')).toBe('x');
    expect(str(5, 'fallback')).toBe('fallback');
    expect(strOrNull('')).toBeNull();
    expect(strOrNull('x')).toBe('x');
    expect(num(5)).toBe(5);
    expect(num('5')).toBe(0);
    expect(num(Number.NaN, 7)).toBe(7);
    expect(num(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(bool(true)).toBe(true);
    expect(bool('true', true)).toBe(true);
  });

  it('narrows an enum or falls back rather than passing junk through', () => {
    expect(enumValue('a', ['a', 'b'] as const, 'a')).toBe('a');
    expect(enumValue('z', ['a', 'b'] as const, 'a')).toBe('a');
    expect(enumValue(7, ['a', 'b'] as const, 'a')).toBe('a');
  });

  it('reads lists in either shape and never returns a non-array', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ items: [1] }, 'items')).toEqual([1]);
    expect(asArray({ data: [1] })).toEqual([1]);
    expect(asArray(null)).toEqual([]);
    expect(asArray('nope')).toEqual([]);
    expect(asRecord('nope')).toEqual({});
  });
});

describe('total behaviour', () => {
  it('degrades rather than throwing on junk', () => {
    const junk = [undefined, null, 0, '', 'nonsense', [], {}, NaN];
    for (const value of junk) {
      expect(() => toIssue(value)).not.toThrow();
      expect(() => toComment(value)).not.toThrow();
      expect(() => toIssueTiming(value)).not.toThrow();
      expect(() => toDashboard(value)).not.toThrow();
      expect(() => toWidget(value)).not.toThrow();
      expect(() => toRenderedWidget(value)).not.toThrow();
    }
  });
});

describe('rendered widgets', () => {
  /** Exactly the shape the server's `render` endpoint returns. */
  const rendered = {
    id: 42,
    dashboardId: 7,
    type: 'sla_countdown',
    title: 'SLA at risk',
    position: { x: 0, y: 1, w: 2, h: 1 },
    filters: { assigneeId: 3 },
    limit: 25,
    hiddenFromRoles: [],
    // `data.kind` is the rendering shape, distinct from the widget `type`.
    data: { kind: 'list', items: [{ id: '1', title: 'Checkout times out' }] },
  };

  it('keeps the widget’s own fields, not just its data', () => {
    const widget = toRenderedWidget(rendered);
    expect(widget.id).toBe(42);
    expect(widget.dashboardId).toBe(7);
    expect(widget.type).toBe('sla_countdown');
    expect(widget.title).toBe('SLA at risk');
    expect(widget.limit).toBe(25);
    expect(widget.filters).toEqual({ assigneeId: 3 });
  });

  it('keeps the rendered data attached', () => {
    const widget = toRenderedWidget(rendered);
    expect(widget.data.kind).toBe('list');
    expect(JSON.stringify(widget.data)).toContain('Checkout times out');
  });

  it('survives the same payload inside a data envelope', () => {
    const widget = toRenderedWidget({ data: rendered });
    expect(widget.id).toBe(42);
    expect(widget.type).toBe('sla_countdown');
  });

  it('does not blank out every widget on a rendered dashboard', () => {
    const dashboard = toRenderedDashboard({
      id: 7,
      projectId: 1,
      name: 'Ops',
      roles: [],
      isDefault: false,
      widgets: [rendered, { ...rendered, id: 43, type: 'issue_list', title: 'Recent issues' }],
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(dashboard.widgets).toHaveLength(2);
    expect(dashboard.widgets.map((w) => w.title)).toEqual(['SLA at risk', 'Recent issues']);
    for (const widget of dashboard.widgets) {
      expect(widget.id).toBeGreaterThan(0);
      expect(widget.limit).toBe(25);
    }
  });
});

describe('an unwrapped widget definition', () => {
  it('has no data key, so unwrapping it is safe', () => {
    // This is the distinction the fix relies on: a stored widget definition
    // carries no `data`, a rendered one does.
    expect(toWidget({ id: 1, type: 'issue_list', title: 'T', limit: 5 }).id).toBe(1);
  });
});
