/**
 * Presentation helpers. Everything here is pure so it can be unit-reasoned
 * about and reused from any component.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact human duration, e.g. `2d 4h`, `45m`, `<1m`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < MINUTE) return '<1m';
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const hours = Math.floor(abs / HOUR);
    const minutes = Math.floor((abs % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  if (abs < WEEK) {
    const days = Math.floor(abs / DAY);
    const hours = Math.floor((abs % DAY) / HOUR);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  const days = Math.floor(abs / DAY);
  return `${days}d`;
}

/** Duration with an explicit sign, for SLA/overdue deltas. */
export function formatSignedDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms === 0) return '0m';
  return `${ms < 0 ? '-' : '+'}${formatDuration(ms)}`;
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours === 0) return '0h';
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, DATE_TIME);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

/** "3 minutes ago" / "in 2 days"; falls back to an absolute date past a month. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const delta = then - now;
  const past = delta < 0;
  const abs = Math.abs(delta);
  const phrase = relativePhrase(abs, past);
  return phrase ?? formatDateTime(iso);
}

function relativePhrase(abs: number, past: boolean): string | null {
  if (abs < 45_000) return past ? 'just now' : 'in a moment';
  if (abs < HOUR) {
    const minutes = Math.round(abs / MINUTE);
    return past ? `${minutes} min ago` : `in ${minutes} min`;
  }
  if (abs < DAY) {
    const hours = Math.round(abs / HOUR);
    return past ? `${hours}h ago` : `in ${hours}h`;
  }
  if (abs < WEEK) {
    const days = Math.round(abs / DAY);
    return past ? `${days}d ago` : `in ${days}d`;
  }
  if (abs < 30 * DAY) {
    const weeks = Math.round(abs / WEEK);
    return past ? `${weeks}w ago` : `in ${weeks}w`;
  }
  return null;
}

/** `2026-09-27T12:00:00.000Z` for a `datetime-local` input, in local time. */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Inverse of `toDateTimeLocal`: local wall time back to an ISO instant. */
export function fromDateTimeLocal(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** Renders an arbitrary `unknown` cell value from a dashboard table. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => formatCellValue(v)).join(', ');
  return JSON.stringify(value);
}

/** Joins class names, dropping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ');
}
