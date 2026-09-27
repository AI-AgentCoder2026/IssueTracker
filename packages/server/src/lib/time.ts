/**
 * Time helpers.
 *
 * Everything stored is an ISO-8601 UTC string produced through `nowIso()` so
 * timestamps are byte-identical regardless of the host timezone. Durations are
 * always milliseconds, named `Ms` in the type names used across the codebase.
 */

/** Current instant as `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date | number | string): string {
  return new Date(date).toISOString();
}

export function addMs(iso: string | Date | number, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function addMinutes(iso: string | Date | number, minutes: number): string {
  return addMs(iso, minutes * 60_000);
}

export function addDays(iso: string | Date | number, days: number): string {
  return addMs(iso, days * 86_400_000);
}

/** Milliseconds until `iso`; negative when already past. */
export function msUntil(iso: string | Date | number, from: Date = new Date()): number {
  return new Date(iso).getTime() - from.getTime();
}

export function isPast(iso: string | null | undefined, from: Date = new Date()): boolean {
  if (!iso) return false;
  return msUntil(iso, from) < 0;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Parse a compact duration such as `1h30m`, `7d`, `45m`, `90s`. */
export function parseDuration(input: string): number | null {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(input.trim());
  if (!match || match.every((group) => !group)) return null;
  const [, d, h, m, s] = match;
  return (
    Number(d ?? 0) * DAY_MS + Number(h ?? 0) * HOUR_MS + Number(m ?? 0) * MINUTE_MS + Number(s ?? 0) * 1000
  );
}

/** Render a duration compactly, e.g. `2d 4h`, `3h 12m`, `45s`. */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const negative = ms < 0;
  let remaining = Math.abs(ms);

  const days = Math.floor(remaining / DAY_MS);
  remaining -= days * DAY_MS;
  const hours = Math.floor(remaining / HOUR_MS);
  remaining -= hours * HOUR_MS;
  const minutes = Math.floor(remaining / MINUTE_MS);
  remaining -= minutes * MINUTE_MS;
  const seconds = Math.floor(remaining / 1000);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || (seconds > 0 && parts.length < 2)) parts.push(`${seconds}s`);

  return `${negative ? '-' : ''}${parts.slice(0, 2).join(' ')}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Default working window for SLA business-hour policies: 09:00–17:00 UTC. */
export const DEFAULT_BUSINESS_HOURS = { startHour: 9, endHour: 17, workingDays: [1, 2, 3, 4, 5] } as const;

export interface BusinessHoursOptions {
  startHour?: number;
  endHour?: number;
  workingDays?: readonly number[];
}

/**
 * Add `durationMs` to `from`, skipping non-working time when
 * `businessHoursOnly` is set. This is what makes a "4 business hour" SLA mean
 * four hours of staffed time rather than four elapsed hours.
 */
export function addBusinessMs(
  from: string | Date | number,
  durationMs: number,
  options: BusinessHoursOptions = {},
): string {
  const startHour = options.startHour ?? DEFAULT_BUSINESS_HOURS.startHour;
  const endHour = options.endHour ?? DEFAULT_BUSINESS_HOURS.endHour;
  const workingDays = options.workingDays ?? DEFAULT_BUSINESS_HOURS.workingDays;

  let cursor = new Date(from);
  let remaining = durationMs;

  // Guard against pathological input; a 10-year cap is far beyond any real SLA.
  const maxIterations = 200_000;
  let iterations = 0;

  while (remaining > 0 && iterations < maxIterations) {
    iterations += 1;
    cursor = new Date(cursor.getTime());

    if (!workingDays.includes(cursor.getUTCDay())) {
      // Jump to the start of the next working day.
      cursor.setUTCHours(startHour, 0, 0, 0);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      continue;
    }

    if (cursor.getUTCHours() < startHour) {
      cursor.setUTCHours(startHour, 0, 0, 0);
      continue;
    }
    if (cursor.getUTCHours() >= endHour) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(startHour, 0, 0, 0);
      continue;
    }

    const endOfDay = new Date(cursor);
    endOfDay.setUTCHours(endHour, 0, 0, 0);
    const available = endOfDay.getTime() - cursor.getTime();

    if (available >= remaining) {
      cursor = new Date(cursor.getTime() + remaining);
      remaining = 0;
    } else {
      // Consume the rest of the working day, then jump to the next working
      // morning. `setUTCDate` mutates in place; constructing a Date from the
      // day-of-month would be read as an epoch offset.
      remaining -= available;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(startHour, 0, 0, 0);
    }
  }

  return cursor.toISOString();
}

export function weekdayName(day: number): string {
  return WEEKDAYS[day] ?? 'Unknown';
}

/** Start of the ISO week (Monday) containing `iso`, at UTC midnight. */
export function startOfIsoWeek(iso: string | Date | number): Date {
  const date = new Date(iso);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function daysBetween(from: string | Date | number, to: string | Date | number): number {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS);
}

/** Age bucket used by the age-distribution dashboard widget. */
export function ageBucket(from: string | Date | number, now: Date = new Date()): string {
  const days = Math.max(0, daysBetween(from, now));
  if (days < 1) return 'today';
  if (days < 3) return '1-2d';
  if (days < 7) return '3-6d';
  if (days < 14) return '1w';
  if (days < 30) return '2-4w';
  if (days < 90) return '1-3mo';
  if (days < 365) return '3-12mo';
  return 'over-1y';
}
