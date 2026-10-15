/**
 * Logical identity of one occurrence: the calendar date it was planned for and
 * the zone that date belongs to. Stamped when a cycle is created, so a later
 * zone change never has to be inferred from a global setting.
 */
export interface OccurrenceIdentity {
  /** `YYYY-MM-DD` in `planningZone`. */
  logicalDateKey: string;
  planningZone: string;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealDateKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = DATE_KEY.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Both fields or neither. Anything else (one field, wrong type, impossible
 * date, empty zone) is not trusted and not repaired: the cycle is legacy.
 */
export function readOccurrenceIdentity(value: {
  logicalDateKey?: unknown;
  planningZone?: unknown;
}): OccurrenceIdentity | null {
  if (
    isRealDateKey(value.logicalDateKey) &&
    typeof value.planningZone === 'string' &&
    value.planningZone.length > 0
  ) {
    return {
      logicalDateKey: value.logicalDateKey,
      planningZone: value.planningZone,
    };
  }
  return null;
}

/**
 * Stamp for a cycle planned in `planningZone`. The date is read in that
 * explicit zone, never the process zone, so a zone change while registration
 * awaits cannot pair the date with the wrong zone. An unknown zone stamps
 * nothing: the cycle stays legacy rather than getting an invented zone.
 */
export function stampOccurrence(
  dueAtMs: number,
  planningZone: string,
): OccurrenceIdentity | Record<string, never> {
  const logicalDateKey = dateKeyInZone(dueAtMs, planningZone);
  return logicalDateKey === null ? {} : { logicalDateKey, planningZone };
}

/** The calendar date an instant has in a zone, or null when it is unknown. */
export function dateKeyInZone(
  atMs: number,
  zone: string | null | undefined,
): string | null {
  if (!zone) {
    return null;
  }
  const offset = /^utc-offset:(-?\d+)$/.exec(zone);
  if (offset) {
    // Date#getTimezoneOffset: minutes west of UTC.
    return new Date(atMs - Number(offset[1]) * 60_000)
      .toISOString()
      .slice(0, 10);
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(atMs);
    const part = (type: string) =>
      parts.find((candidate) => candidate.type === type)?.value;
    const [year, month, day] = [part('year'), part('month'), part('day')];
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}
