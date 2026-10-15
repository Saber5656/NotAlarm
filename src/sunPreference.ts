import { findSunRegion } from './sunRegions';

export const SUN_PREFERENCE_KEY = 'already-up/sun-preference/v1';

export type SunPreference =
  | { version: 1; mode: 'fixed' }
  | { version: 1; mode: 'region'; regionId: string }
  | {
      version: 1;
      mode: 'device';
      /** Rounded to 0.1 degree (about 11 km); never a raw reading. */
      latitude: number;
      longitude: number;
      timeZone: string;
      savedAtMs: number;
    };

export const FIXED_SUN_PREFERENCE: SunPreference = {
  version: 1,
  mode: 'fixed',
};

export type SunPreferenceRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; preference: SunPreference };

export function roundCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRoundedIn(value: unknown, limit: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit &&
    roundCoordinate(value) === value
  );
}

export function readSunPreference(raw: string | null): SunPreferenceRead {
  if (raw === null) {
    return { kind: 'absent' };
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (value?.version === 1) {
      if (value.mode === 'fixed') {
        return { kind: 'valid', preference: FIXED_SUN_PREFERENCE };
      }
      if (value.mode === 'region' && typeof value.regionId === 'string') {
        return {
          kind: 'valid',
          preference: { version: 1, mode: 'region', regionId: value.regionId },
        };
      }
      if (
        value.mode === 'device' &&
        isRoundedIn(value.latitude, 90) &&
        isRoundedIn(value.longitude, 180) &&
        typeof value.timeZone === 'string' &&
        value.timeZone.length > 0 &&
        typeof value.savedAtMs === 'number' &&
        Number.isFinite(value.savedAtMs)
      ) {
        return {
          kind: 'valid',
          preference: {
            version: 1,
            mode: 'device',
            latitude: value.latitude,
            longitude: value.longitude,
            timeZone: value.timeZone,
            savedAtMs: value.savedAtMs,
          },
        };
      }
    }
  } catch {
    // Falls through to invalid.
  }
  return { kind: 'invalid' };
}

/** Writes only the known fields so nothing else can be persisted by accident. */
export function serializeSunPreference(preference: SunPreference): string {
  switch (preference.mode) {
    case 'region':
      if (!findSunRegion(preference.regionId)) {
        throw new Error('Unknown sun region.');
      }
      return JSON.stringify({
        version: 1,
        mode: 'region',
        regionId: preference.regionId,
      });
    case 'device':
      return JSON.stringify({
        version: 1,
        mode: 'device',
        latitude: preference.latitude,
        longitude: preference.longitude,
        timeZone: preference.timeZone,
        savedAtMs: preference.savedAtMs,
      });
    default:
      return JSON.stringify({ version: 1, mode: 'fixed' });
  }
}
