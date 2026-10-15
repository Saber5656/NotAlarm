import type { LocaleSettings } from './locale';

/**
 * Locale-aware date and time formatting. Pure: all device input arrives in
 * `LocaleSettings`, so tests inject a locale, a 12/24-hour preference and a
 * time zone. Display only; stored times, IDs and policy use raw numbers.
 */
export interface Formatter {
  /** A wall-clock time such as 7:05 (hour 0-23, minute 0-59). */
  clock(hour: number, minute: number): string;
  /** The wall-clock time of a timestamp in the formatter's zone. */
  clockAt(timestampMs: number): string;
  /** Month, day and short weekday, e.g. "10/15(水)" or "Wed, 10/15". */
  day(timestampMs: number): string;
  /** Short weekday name for 0 (Sunday) to 6 (Saturday). */
  weekdayShort(weekday: number): string;
  /** Full weekday name, for spoken labels. */
  weekdayLong(weekday: number): string;
}

// 2024-01-07 is a Sunday, so day offsets map straight onto weekday numbers.
const SUNDAY_UTC_MS = Date.UTC(2024, 0, 7);
const DAY_MS = 24 * 60 * 60 * 1000;

export function createFormatter(settings: LocaleSettings): Formatter {
  const zone = settings.timeZone ? { timeZone: settings.timeZone } : {};
  // A 24-hour display pads the hour ("07:05") like the previous UI did.
  // Japanese keeps that padding when the device gives no preference.
  const padsHour =
    settings.hour12 === false ||
    (settings.hour12 === null && settings.locale === 'ja');
  const clockOptions = (): Intl.DateTimeFormatOptions => ({
    hour: padsHour ? '2-digit' : 'numeric',
    minute: '2-digit',
    // h23 (not hour12: false) so midnight reads 00:05, never 24:05.
    ...(settings.hour12 === null
      ? {}
      : { hourCycle: settings.hour12 ? ('h12' as const) : ('h23' as const) }),
  });

  return {
    clock(hour, minute) {
      return new Intl.DateTimeFormat(settings.intlTag, {
        ...clockOptions(),
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
    },
    clockAt(timestampMs) {
      return new Intl.DateTimeFormat(settings.intlTag, {
        ...clockOptions(),
        ...zone,
      }).format(new Date(timestampMs));
    },
    day(timestampMs) {
      return new Intl.DateTimeFormat(settings.intlTag, {
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        ...zone,
      }).format(new Date(timestampMs));
    },
    weekdayShort(weekday) {
      return new Intl.DateTimeFormat(settings.intlTag, {
        weekday: 'short',
        timeZone: 'UTC',
      }).format(new Date(SUNDAY_UTC_MS + weekday * DAY_MS));
    },
    weekdayLong(weekday) {
      return new Intl.DateTimeFormat(settings.intlTag, {
        weekday: 'long',
        timeZone: 'UTC',
      }).format(new Date(SUNDAY_UTC_MS + weekday * DAY_MS));
    },
  };
}
