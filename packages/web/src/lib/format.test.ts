/**
 * Presentation helpers.
 *
 * These render every timestamp, duration and file size in the client, and the
 * client had no tests at all -- which is how a whole UI could ship with
 * mangled characters and nobody notice.
 *
 * The cases that matter are the boundaries and the absent: an SLA badge showing
 * "-<1m" is technically derived from real numbers and still useless, and every
 * one of these functions is called with `null` whenever an issue has not been
 * started, resolved or closed yet.
 */

import { describe, it, expect } from 'vitest';
import {
  cx,
  formatBytes,
  formatCellValue,
  formatDate,
  formatDateTime,
  formatDuration,
  formatHours,
  formatRelative,
  formatSignedDuration,
  fromDateTimeLocal,
  initialsOf,
  toDateTimeLocal,
} from './format.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('formatDuration', () => {
  it('renders an em dash for anything that is not a measurement', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('collapses sub-minute durations rather than showing 0m', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(59_999)).toBe('<1m');
  });

  it('picks a sensible unit at each boundary', () => {
    expect(formatDuration(MINUTE)).toBe('1m');
    expect(formatDuration(45 * MINUTE)).toBe('45m');
    expect(formatDuration(HOUR)).toBe('1h');
    expect(formatDuration(HOUR + 30 * MINUTE)).toBe('1h 30m');
    expect(formatDuration(DAY)).toBe('1d');
    expect(formatDuration(DAY + 4 * HOUR)).toBe('1d 4h');
    expect(formatDuration(WEEK)).toBe('7d');
  });

  it('measures magnitude, so a negative span reads the same as a positive one', () => {
    // Nothing in the UI shows a negative duration -- `formatSignedDuration`
    // owns the sign -- so this must not leak one.
    expect(formatDuration(-3 * HOUR)).toBe(formatDuration(3 * HOUR));
  });
});

describe('formatSignedDuration', () => {
  it('marks a positive and a negative span', () => {
    expect(formatSignedDuration(2 * HOUR)).toBe('+2h');
    expect(formatSignedDuration(-2 * HOUR)).toBe('-2h');
  });

  it('renders zero without a sign', () => {
    expect(formatSignedDuration(0)).toBe('0m');
  });

  it('shows an em dash for an absent span', () => {
    expect(formatSignedDuration(null)).toBe('—');
    expect(formatSignedDuration(undefined)).toBe('—');
  });

  it('never produces a signed "<1m"', () => {
    // The regression this guards: formatDuration collapses sub-minute values
    // to "<1m", so prefixing a sign produced "-<1m", which reads as broken.
    expect(formatSignedDuration(-30_000)).toBe('-0m');
    expect(formatSignedDuration(30_000)).toBe('+0m');
    expect(formatSignedDuration(-30_000)).not.toContain('<1m');
    expect(formatSignedDuration(30_000)).not.toContain('<1m');
  });
});

describe('formatHours', () => {
  it('handles absent and zero values', () => {
    expect(formatHours(null)).toBe('—');
    expect(formatHours(undefined)).toBe('—');
    expect(formatHours(0)).toBe('0h');
  });

  it('keeps whole hours exact and rounds others to one decimal', () => {
    expect(formatHours(2)).toBe('2h');
    expect(formatHours(2.5)).toBe('2.5h');
    expect(formatHours(2.46)).toBe('2.5h');
    expect(formatHours(0.04)).toBe('0.0h');
  });
});

describe('formatBytes', () => {
  it('scales through the usual units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('stops at gigabytes rather than inventing terabytes', () => {
    expect(formatBytes(1024 ** 4)).toMatch(/GB$/);
  });

  it('refuses a nonsensical size', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('dates', () => {
  const iso = '2026-03-15T09:30:00.000Z';

  it('renders an em dash for absent and unparseable values', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('renders a real date rather than "Invalid Date"', () => {
    expect(formatDateTime(iso)).not.toContain('Invalid');
    expect(formatDate(iso)).not.toContain('Invalid');
  });

  it('describes relative time in both directions', () => {
    const now = Date.parse(iso);
    expect(formatRelative(iso, now)).toBe('just now');
    expect(formatRelative(new Date(now - 5 * MINUTE).toISOString(), now)).toBe('5 min ago');
    expect(formatRelative(new Date(now + 2 * HOUR).toISOString(), now)).toBe('in 2h');
    expect(formatRelative(new Date(now - 3 * DAY).toISOString(), now)).toBe('3d ago');
    expect(formatRelative(new Date(now - 14 * DAY).toISOString(), now)).toBe('2w ago');
  });

  it('falls back to an absolute date beyond a month', () => {
    const now = Date.parse(iso);
    const old = new Date(now - 400 * DAY).toISOString();
    const rendered = formatRelative(old, now);
    expect(rendered).not.toMatch(/ago|^\d+[mhdw]$/);
    expect(rendered).not.toBe('—');
  });

  it('falls back rather than showing NaN for an unparseable value', () => {
    expect(formatRelative('not a date')).toBe('—');
    expect(formatRelative(null)).toBe('—');
  });
});

describe('datetime-local round trip', () => {
  it('survives a round trip at minute precision', () => {
    const iso = '2026-03-15T09:30:00.000Z';
    const local = toDateTimeLocal(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Seconds are dropped, so the instant is equal only to the minute.
    expect(fromDateTimeLocal(local)).toBe(new Date(iso).toISOString().slice(0, 16) + ':00.000Z');
  });

  it('treats an empty or invalid value as absent', () => {
    expect(toDateTimeLocal(null)).toBe('');
    expect(toDateTimeLocal('nonsense')).toBe('');
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('nonsense')).toBeNull();
  });
});

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('Grace Brewster Hopper')).toBe('GH');
    expect(initialsOf('Ada')).toBe('A');
  });

  it('copes with padding, blanks and nothing at all', () => {
    expect(initialsOf('   Ada   Lovelace  ')).toBe('AL');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('    ')).toBe('?');
  });
});

describe('formatCellValue', () => {
  it('renders each JSON-ish type a dashboard table can hold', () => {
    expect(formatCellValue(null)).toBe('—');
    expect(formatCellValue(undefined)).toBe('—');
    expect(formatCellValue(7)).toBe('7');
    expect(formatCellValue(7.5)).toBe('7.50');
    expect(formatCellValue(true)).toBe('Yes');
    expect(formatCellValue(false)).toBe('No');
    expect(formatCellValue('text')).toBe('text');
    expect(formatCellValue([1, 2])).toBe('1, 2');
  });

  it('never renders NaN into a table cell', () => {
    // A widget computing a ratio over an empty set yields NaN, and a cell
    // reading "NaN" looks like a bug in the tracker rather than in the data.
    expect(formatCellValue(Number.NaN)).toBe('—');
    expect(formatCellValue(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('cx', () => {
  it('joins the truthy class names only', () => {
    expect(cx('a', 'b')).toBe('a b');
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cx()).toBe('');
  });
});
