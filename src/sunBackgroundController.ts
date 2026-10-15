import {
  FIXED_SUN_PREFERENCE,
  SUN_PREFERENCE_KEY,
  readSunPreference,
  roundCoordinate,
  serializeSunPreference,
  type SunPreference,
} from './sunPreference';
import { findSunRegion } from './sunRegions';
import { isStorageResetPendingError } from './storageResetGate';
import type { KeyValueStore } from './suppressionJournal';

export type LocationPermission = 'granted' | 'denied' | 'undetermined';

/** Thin seam over expo-location so the rules are testable without a device. */
export interface LocationGateway {
  /** Reads the current state; must never show a prompt. */
  getPermission(): Promise<LocationPermission>;
  /** Shows the system prompt. Called only from an explicit button press. */
  requestPermission(): Promise<LocationPermission>;
  /** One foreground reading at the lowest (approximate) accuracy. */
  getApproximatePosition(): Promise<{ latitude: number; longitude: number }>;
}

export const DEFAULT_LOCATION_TIMEOUT_MS = 10_000;

export type SunNotice =
  | 'invalid-saved'
  | 'permission-revoked'
  | 'timezone-changed'
  /** A deletion is unfinished; every choice stays off until it is retried. */
  | 'reset-pending';

export type DeviceLocationOutcome =
  | { kind: 'saved'; preference: SunPreference }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'unsupported-timezone' }
  /** A data deletion is unfinished; nothing may be written until it is retried. */
  | { kind: 'reset-pending' };

export interface SunBackgroundLoad {
  preference: SunPreference;
  notice?: SunNotice;
  /** A deletion or choice happened while reading; do not apply this result. */
  stale?: boolean;
}

export interface SunBackgroundController {
  /** Reads the saved choice and downgrades it to fixed when it is unsafe. */
  load(): Promise<SunBackgroundLoad>;
  chooseFixed(): Promise<SunPreference>;
  chooseRegion(regionId: string): Promise<SunPreference>;
  useDeviceLocation(): Promise<DeviceLocationOutcome>;
  /** Data deletion: removes the key and invalidates any pending lookup. */
  clear(): Promise<void>;
  /**
   * Synchronously makes every in-flight lookup, load and save obsolete. Call
   * the moment a deletion is confirmed, before it starts awaiting anything.
   */
  invalidate(): void;
}

export interface SunBackgroundControllerDependencies {
  store: KeyValueStore;
  location: LocationGateway;
  nowMs(): number;
  /** Device IANA zone, or undefined when it cannot be read reliably. */
  deviceTimeZone(): string | undefined;
  timeoutMs?: number;
  /** Shares the storage reset's lock so a save cannot interleave with it. */
  exclusive?<T>(run: () => Promise<T>): Promise<T>;
  /** Throws while a deletion is unfinished (the storage reset gate). */
  assertWritable?(): Promise<void>;
}

class Obsolete extends Error {}
class LookupTimeout extends Error {}

export function createSunBackgroundController({
  store,
  location,
  nowMs,
  deviceTimeZone,
  timeoutMs = DEFAULT_LOCATION_TIMEOUT_MS,
  exclusive = (run) => run(),
  assertWritable = async () => {},
}: SunBackgroundControllerDependencies): SunBackgroundController {
  /** Bumped by every user choice; a lookup that started earlier is obsolete. */
  let generation = 0;

  /**
   * Every write re-checks, inside the storage lock, that no deletion is
   * pending and that nothing newer happened since `started`.
   */
  async function guarded<T>(
    started: number,
    write: () => Promise<T>,
  ): Promise<T> {
    return exclusive(async () => {
      await assertWritable();
      if (started !== generation) {
        throw new Obsolete();
      }
      return write();
    });
  }

  async function save(
    preference: SunPreference,
    started: number,
  ): Promise<SunPreference> {
    const text = serializeSunPreference(preference);
    await guarded(started, () => store.setItem(SUN_PREFERENCE_KEY, text));
    return preference;
  }

  async function downgrade(
    started: number,
    notice: SunNotice,
    remove = false,
  ): Promise<SunBackgroundLoad> {
    try {
      await guarded(started, () =>
        remove
          ? store.removeItem(SUN_PREFERENCE_KEY)
          : store.setItem(
              SUN_PREFERENCE_KEY,
              serializeSunPreference(FIXED_SUN_PREFERENCE),
            ),
      );
    } catch (error) {
      if (error instanceof Obsolete) {
        return { preference: FIXED_SUN_PREFERENCE, stale: true };
      }
      if (isStorageResetPendingError(error)) {
        // Shown as fixed; the saved value is deleted by the pending retry.
        return { preference: FIXED_SUN_PREFERENCE, notice: 'reset-pending' };
      }
      throw error;
    }
    return { preference: FIXED_SUN_PREFERENCE, notice };
  }

  async function withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LookupTimeout()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return {
    async load() {
      const started = generation;
      const raw = await store.getItem(SUN_PREFERENCE_KEY);
      if (started !== generation) {
        return { preference: FIXED_SUN_PREFERENCE, stale: true };
      }
      const read = readSunPreference(raw);
      if (read.kind === 'absent') {
        return { preference: FIXED_SUN_PREFERENCE };
      }
      if (read.kind === 'invalid') {
        return downgrade(started, 'invalid-saved', true);
      }
      const { preference } = read;
      if (preference.mode === 'region' && !findSunRegion(preference.regionId)) {
        return downgrade(started, 'invalid-saved');
      }
      if (preference.mode === 'device') {
        let permission: LocationPermission = 'denied';
        try {
          permission = await location.getPermission();
        } catch {
          // Treated as revoked: the position cannot be justified any more.
        }
        if (started !== generation) {
          return { preference: FIXED_SUN_PREFERENCE, stale: true };
        }
        if (permission !== 'granted') {
          return downgrade(started, 'permission-revoked');
        }
        if (deviceTimeZone() !== preference.timeZone) {
          return downgrade(started, 'timezone-changed');
        }
      }
      try {
        await exclusive(assertWritable);
      } catch (error) {
        if (isStorageResetPendingError(error)) {
          // Deletion unfinished: the saved place must not drive the theme.
          return { preference: FIXED_SUN_PREFERENCE, notice: 'reset-pending' };
        }
        throw error;
      }
      return { preference };
    },

    async chooseFixed() {
      return save(FIXED_SUN_PREFERENCE, ++generation);
    },

    async chooseRegion(regionId) {
      if (!findSunRegion(regionId)) {
        throw new Error('Unknown sun region.');
      }
      return save({ version: 1, mode: 'region', regionId }, ++generation);
    },

    async clear() {
      const started = ++generation;
      await guarded(started, () => store.removeItem(SUN_PREFERENCE_KEY));
    },

    invalidate() {
      generation += 1;
    },

    async useDeviceLocation() {
      const zone = deviceTimeZone();
      if (!zone) {
        return { kind: 'unsupported-timezone' };
      }
      const started = ++generation;
      try {
        await exclusive(assertWritable);
        let permission = await location.getPermission();
        if (permission !== 'granted') {
          permission = await location.requestPermission();
        }
        if (started !== generation) {
          return { kind: 'cancelled' };
        }
        if (permission !== 'granted') {
          return { kind: 'denied' };
        }
        const position = await withTimeout(location.getApproximatePosition());
        // A choice made while waiting (fixed, region, deletion) wins.
        if (started !== generation) {
          return { kind: 'cancelled' };
        }
        if (
          !Number.isFinite(position.latitude) ||
          !Number.isFinite(position.longitude) ||
          Math.abs(position.latitude) > 90 ||
          Math.abs(position.longitude) > 180
        ) {
          return { kind: 'error' };
        }
        const preference = await save(
          {
            version: 1,
            mode: 'device',
            latitude: roundCoordinate(position.latitude),
            longitude: roundCoordinate(position.longitude),
            timeZone: zone,
            savedAtMs: nowMs(),
          },
          started,
        );
        return { kind: 'saved', preference };
      } catch (error) {
        if (isStorageResetPendingError(error)) {
          return { kind: 'reset-pending' };
        }
        if (error instanceof Obsolete || started !== generation) {
          return { kind: 'cancelled' };
        }
        return { kind: error instanceof LookupTimeout ? 'timeout' : 'error' };
      }
    },
  };
}
