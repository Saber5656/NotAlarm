import { getTimes } from 'suncalc';

import type { SunPreference } from './sunPreference';
import { findSunRegion } from './sunRegions';

export interface SunScheduleInput {
  latitude: number;
  longitude: number;
  timeZone: string;
  nowMs: number;
}

export type SunScheduleResult =
  | {
      kind: 'ok';
      /**
       * Minutes after local midnight in `timeZone`. `sunsetMinute` exceeds
       * 1440 when the sunset falls after midnight of the next civil day.
       */
      sunriseMinute: number;
      sunsetMinute: number;
      /** Civil date in `timeZone`, YYYY-MM-DD. */
      dateKey: string;
    }
  | { kind: 'polar-day' }
  | { kind: 'polar-night' }
  | { kind: 'invalid' };

export interface SunSchedule {
  sunriseMinute: number;
  sunsetMinute: number;
  timeZone: string;
}

export type SunFallbackReason =
  | 'invalid-saved'
  | 'timezone-changed'
  | 'polar';

export interface ResolvedSunBackground {
  /** null means the fixed 06:00/18:00 appearance. */
  schedule: SunSchedule | null;
  source: 'fixed' | 'region' | 'device';
  fallback?: SunFallbackReason;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  const { year, month, day, hour, minute, second } = parts;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    throw new RangeError('Unreadable zoned date.');
  }
  return { year, month, day, hour, minute, second };
}

/** Minutes east of UTC that `timeZone` uses at `ms`. */
function offsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

export function localDateKey(nowMs: number, timeZone: string): string | null {
  try {
    const p = zonedParts(nowMs, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

function minuteOfCivilDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute + p.second / 60;
}

/** Whole civil days from `from` to `to` as read on the clock of `timeZone`. */
function civilDaysBetween(from: number, to: number, timeZone: string): number {
  const a = zonedParts(from, timeZone);
  const b = zonedParts(to, timeZone);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) -
      Date.UTC(a.year, a.month - 1, a.day)) /
      86_400_000,
  );
}

/**
 * Sun times for the civil day (in `timeZone`) that contains `nowMs`. Pure and
 * offline. Anything that cannot be computed truthfully is reported, not guessed.
 */
export function computeSunSchedule({
  latitude,
  longitude,
  timeZone,
  nowMs,
}: SunScheduleInput): SunScheduleResult {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(nowMs) ||
    typeof timeZone !== 'string' ||
    timeZone.length === 0
  ) {
    return { kind: 'invalid' };
  }
  try {
    const p = zonedParts(nowMs, timeZone);
    // Local noon of the civil day, expressed as an instant in that zone.
    const noonAsUtc = Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0);
    const firstGuess = noonAsUtc - offsetMinutes(noonAsUtc, timeZone) * 60_000;
    const offset = offsetMinutes(firstGuess, timeZone);
    const noon = new Date(noonAsUtc - offset * 60_000);
    const times = getTimes(noon, latitude, longitude, 0, offset);
    if (times.alwaysUp) {
      return { kind: 'polar-day' };
    }
    if (times.alwaysDown) {
      return { kind: 'polar-night' };
    }
    const { sunrise, sunset } = times;
    if (
      !sunrise ||
      !sunset ||
      Number.isNaN(sunrise.getTime()) ||
      Number.isNaN(sunset.getTime())
    ) {
      return { kind: 'invalid' };
    }
    const sunriseMinute = minuteOfCivilDay(sunrise.getTime(), timeZone);
    // Near the midnight-sun seasons the sunset can fall after local midnight;
    // it is then expressed as minutes past 24:00 of the sunrise's civil day.
    const extraDays = civilDaysBetween(
      sunrise.getTime(),
      sunset.getTime(),
      timeZone,
    );
    const sunsetMinute =
      minuteOfCivilDay(sunset.getTime(), timeZone) + extraDays * 24 * 60;
    if (
      sunset.getTime() <= sunrise.getTime() ||
      extraDays < 0 ||
      extraDays > 1 ||
      sunriseMinute >= sunsetMinute
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'ok',
      sunriseMinute,
      sunsetMinute,
      dateKey: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    };
  } catch {
    return { kind: 'invalid' };
  }
}

export interface SunScheduleCache {
  get(input: SunScheduleInput): SunScheduleResult;
  size(): number;
}

/**
 * Remembers results per place and civil day so a re-render or foreground
 * return does not recompute; a new local day (or DST change of day) misses.
 */
export function createSunScheduleCache({
  maxEntries = 8,
  compute = computeSunSchedule,
}: {
  maxEntries?: number;
  compute?: (input: SunScheduleInput) => SunScheduleResult;
} = {}): SunScheduleCache {
  const entries = new Map<string, SunScheduleResult>();
  return {
    get(input) {
      const dateKey = localDateKey(input.nowMs, input.timeZone);
      if (dateKey === null) {
        return { kind: 'invalid' };
      }
      const key = `${input.latitude}|${input.longitude}|${input.timeZone}|${dateKey}`;
      const hit = entries.get(key);
      if (hit) {
        return hit;
      }
      const result = compute(input);
      entries.set(key, result);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value as string);
      }
      return result;
    },
    size: () => entries.size,
  };
}

const defaultCache = createSunScheduleCache();

export interface ResolveSunBackgroundInput {
  preference: SunPreference;
  nowMs: number;
  /** The device's current IANA zone, or undefined when it cannot be read. */
  deviceTimeZone: string | undefined;
  cache?: SunScheduleCache;
}

export function resolveSunBackground({
  preference,
  nowMs,
  deviceTimeZone,
  cache = defaultCache,
}: ResolveSunBackgroundInput): ResolvedSunBackground {
  const fixed = (fallback?: SunFallbackReason): ResolvedSunBackground => ({
    schedule: null,
    source: 'fixed',
    ...(fallback ? { fallback } : {}),
  });
  if (preference.mode === 'fixed') {
    return fixed();
  }

  let place: { latitude: number; longitude: number; timeZone: string };
  if (preference.mode === 'region') {
    const region = findSunRegion(preference.regionId);
    if (!region) {
      return fixed('invalid-saved');
    }
    place = region;
  } else {
    // Only the zone the position was taken in is trustworthy for its civil day.
    if (!deviceTimeZone || deviceTimeZone !== preference.timeZone) {
      return fixed('timezone-changed');
    }
    place = preference;
  }

  const result = cache.get({
    latitude: place.latitude,
    longitude: place.longitude,
    timeZone: place.timeZone,
    nowMs,
  });
  if (result.kind === 'polar-day' || result.kind === 'polar-night') {
    return fixed('polar');
  }
  if (result.kind === 'invalid') {
    return fixed('invalid-saved');
  }
  // Yesterday's own times, only so a sunset after midnight is not cut off.
  const dayStartMs =
    nowMs - minuteOfCivilDay(nowMs, place.timeZone) * 60_000;
  const yesterday = cache.get({
    latitude: place.latitude,
    longitude: place.longitude,
    timeZone: place.timeZone,
    nowMs: dayStartMs - 12 * 3_600_000,
  });
  return {
    schedule: {
      sunriseMinute: result.sunriseMinute,
      sunsetMinute: result.sunsetMinute,
      timeZone: place.timeZone,
      ...(yesterday.kind === 'ok' &&
      yesterday.sunsetMinute + 210 > 24 * 60
        ? {
            previous: {
              sunriseMinute: yesterday.sunriseMinute,
              sunsetMinute: yesterday.sunsetMinute,
            },
          }
        : {}),
    },
    source: preference.mode,
  };
}
