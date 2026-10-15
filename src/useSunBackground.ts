import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { CircadianSchedule } from './circadianTheme';
import { expoLocationGateway } from './expoLocationGateway';
import {
  createSunBackgroundController,
  type DeviceLocationOutcome,
  type SunBackgroundController,
} from './sunBackgroundController';
import { FIXED_SUN_PREFERENCE, type SunPreference } from './sunPreference';
import { resolveSunBackground } from './sunSchedule';
import { isStorageResetPendingError } from './storageResetGate';
import type { SunStatusKey } from './sunStatusText';

function readDeviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** Lets the owner share its storage lock and reset gate with this hook. */
export interface SunStorageCoordination {
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  assertWritable(): Promise<void>;
}

export interface SunBackgroundState {
  preference: SunPreference;
  /** Pass to getCircadianTheme(date, schedule); undefined means fixed. */
  schedule: CircadianSchedule | undefined;
  /** Why the fixed time is in use when a place was chosen but not usable. */
  status: SunStatusKey | null;
  isBusy: boolean;
  /** A deletion is running or unfinished: choices and permission are off. */
  writesBlocked: boolean;
  chooseFixed(): Promise<void>;
  chooseRegion(regionId: string): Promise<void>;
  /** Only ever call from an explicit button press. */
  useDeviceLocation(): Promise<void>;
  /** Call the moment the user confirms deletion, before awaiting anything. */
  beginDeletion(): void;
  /** Deletion finished: forget everything in memory and allow choices. */
  completeDeletion(): void;
  /** Deletion stopped midway: stay blocked until a retry succeeds. */
  failDeletion(): void;
}

/**
 * State for the optional sunrise/sunset background. Owns no UI and no entry
 * point; a settings sheet reads it. Nothing here touches alarm scheduling.
 * Location is read only inside `useDeviceLocation`, never on mount.
 * Pass the same module-level `coordination` object on every render.
 */
export function useSunBackground(
  nowMs: number,
  coordination?: SunStorageCoordination,
): SunBackgroundState {
  const controllerRef = useRef<SunBackgroundController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createSunBackgroundController({
      store: AsyncStorage,
      location: expoLocationGateway,
      nowMs: () => Date.now(),
      deviceTimeZone: readDeviceTimeZone,
      exclusive: coordination?.exclusive,
      assertWritable: coordination?.assertWritable,
    });
  }
  const controller = controllerRef.current;
  // Bumped by a deletion; any async result begun earlier is then ignored.
  const epochRef = useRef(0);
  const [preference, setPreference] =
    useState<SunPreference>(FIXED_SUN_PREFERENCE);
  const [loadNotice, setLoadNotice] = useState<SunStatusKey | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [writesBlocked, setWritesBlocked] = useState(false);

  const reload = useCallback(async () => {
    const epoch = epochRef.current;
    try {
      const loaded = await controller.load();
      if (loaded.stale || epoch !== epochRef.current) {
        return;
      }
      setPreference(loaded.preference);
      setLoadNotice(loaded.notice ?? null);
    } catch {
      if (epoch !== epochRef.current) {
        return;
      }
      setPreference(FIXED_SUN_PREFERENCE);
      setLoadNotice('invalid-saved');
    }
  }, [controller]);

  useEffect(() => {
    void reload();
    // Permission or time zone can change while the app is away.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reload();
      }
    });
    return () => subscription.remove();
  }, [reload]);

  // The cache keeps this cheap; a new local day or zone change recomputes.
  const localMinuteKey = Math.floor(nowMs / 60_000);
  const resolved = useMemo(
    () =>
      resolveSunBackground({
        preference,
        nowMs,
        deviceTimeZone: readDeviceTimeZone(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preference, localMinuteKey],
  );

  const apply = useCallback(
    async (run: () => Promise<SunPreference>) => {
      const epoch = epochRef.current;
      setIsBusy(true);
      try {
        const next = await run();
        if (epoch === epochRef.current) {
          setPreference(next);
          setLoadNotice(null);
        }
      } catch (error) {
        if (epoch === epochRef.current) {
          if (isStorageResetPendingError(error)) {
            setWritesBlocked(true);
            setLoadNotice('reset-pending');
          } else {
            setLoadNotice('error');
          }
        }
      } finally {
        if (epoch === epochRef.current) {
          setIsBusy(false);
        }
      }
    },
    [],
  );

  const chooseFixed = useCallback(
    () => apply(() => controller.chooseFixed()),
    [apply, controller],
  );
  const chooseRegion = useCallback(
    (regionId: string) => apply(() => controller.chooseRegion(regionId)),
    [apply, controller],
  );

  const useDeviceLocation = useCallback(async () => {
    const epoch = epochRef.current;
    setIsBusy(true);
    try {
      const outcome: DeviceLocationOutcome =
        await controller.useDeviceLocation();
      if (epoch !== epochRef.current) {
        return;
      }
      if (outcome.kind === 'saved') {
        setPreference(outcome.preference);
        setLoadNotice(null);
      } else if (outcome.kind === 'reset-pending') {
        setWritesBlocked(true);
        setLoadNotice('reset-pending');
      } else if (outcome.kind !== 'cancelled') {
        setLoadNotice(outcome.kind);
      }
    } finally {
      if (epoch === epochRef.current) {
        setIsBusy(false);
      }
    }
  }, [controller]);

  const beginDeletion = useCallback(() => {
    // Synchronous: a GPS answer or save landing after this must do nothing.
    controller.invalidate();
    epochRef.current += 1;
    setWritesBlocked(true);
    setIsBusy(false);
  }, [controller]);

  const completeDeletion = useCallback(() => {
    controller.invalidate();
    epochRef.current += 1;
    setPreference(FIXED_SUN_PREFERENCE);
    setLoadNotice(null);
    setIsBusy(false);
    setWritesBlocked(false);
  }, [controller]);

  const failDeletion = useCallback(() => {
    controller.invalidate();
    epochRef.current += 1;
    setPreference(FIXED_SUN_PREFERENCE);
    setLoadNotice('reset-pending');
    setIsBusy(false);
    setWritesBlocked(true);
  }, [controller]);

  const schedule = resolved.schedule ?? undefined;
  const status = resolved.fallback ?? loadNotice;
  return useMemo(
    () => ({
      preference,
      schedule,
      status,
      isBusy,
      writesBlocked,
      chooseFixed,
      chooseRegion,
      useDeviceLocation,
      beginDeletion,
      completeDeletion,
      failDeletion,
    }),
    [
      preference,
      schedule,
      status,
      isBusy,
      writesBlocked,
      chooseFixed,
      chooseRegion,
      useDeviceLocation,
      beginDeletion,
      completeDeletion,
      failDeletion,
    ],
  );
}
