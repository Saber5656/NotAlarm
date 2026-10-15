/**
 * iOS (expo-notifications 57): a DATE trigger becomes a relative
 * UNTimeIntervalNotificationTrigger, so the absolute fire time cannot be read
 * back. A CALENDAR trigger with explicit UTC date components can: it is a
 * UNCalendarNotificationTrigger whose dateComponents (with timeZone) are
 * returned by getAllScheduledNotificationsAsync. Resolution is one second.
 */

/** The earliest whole-second instant that is not before `ms`. */
export function ceilToSecondMs(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

export interface UtcCalendarFields {
  timezone: 'UTC';
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Full UTC components, rounded up so the alarm never rings before it is due. */
export function toUtcCalendarFields(dueAtMs: number): UtcCalendarFields {
  const date = new Date(ceilToSecondMs(dueAtMs));
  return {
    timezone: 'UTC',
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function integerIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/**
 * Absolute epoch ms of a returned calendar trigger, or null when it is not
 * provably one absolute UTC second (other zone, missing or out-of-range
 * field, impossible date). Null means "cannot verify", never "matches".
 */
export function parseCalendarDateComponents(components: unknown): number | null {
  if (typeof components !== 'object' || components === null) {
    return null;
  }
  const c = components as Record<string, unknown>;
  // Apple may report the UTC identifier as GMT; both have no offset or DST.
  if (c.timeZone !== 'UTC' && c.timeZone !== 'GMT') {
    return null;
  }
  if (c.isLeapMonth === true) {
    return null;
  }
  const year = integerIn(c.year, 1, 9999);
  const month = integerIn(c.month, 1, 12);
  const day = integerIn(c.day, 1, 31);
  const hour = integerIn(c.hour, 0, 23);
  const minute = integerIn(c.minute, 0, 59);
  const second = integerIn(c.second, 0, 59);
  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  // Date normalises 30 Feb to 2 Mar; a changed day or month means invalid.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.getTime();
}
