import { useEffect, useRef } from 'react';

import { markDueCyclesRinging } from '../alarmStorage';
import { noticeFromCodeIn } from '../i18n';
import { isStorageResetPendingError } from '../storageResetGate';
import { isMonitoring } from './core/formatters';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
} from './types';

/**
 * The one-second clock. Every tick publishes the time; when a cycle has come
 * due while the app is running, it is moved to ringing through the storage
 * transition, one at a time.
 */
export function useClockTick(input: {
  alarmsRef: AlarmsRef;
  setNowMs(nowMs: number): void;
  setDeletionPending(pending: boolean): void;
  messagesNow: MessagesNow;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
}): void {
  const {
    alarmsRef,
    setNowMs,
    setDeletionPending,
    messagesNow,
    setNotice,
    setCurrentAlarms,
  } = input;
  const dueTransitionInFlightRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const tick = Date.now();
      setNowMs(tick);

      const hasDueCycle = alarmsRef.current.some((definition) =>
        definition.cycles.some(
          (cycle) =>
            (isMonitoring(cycle) && cycle.dueAtMs <= tick) ||
            (cycle.phase === 'snoozed' &&
              (cycle.snooze?.dueAtMs ?? cycle.dueAtMs) <= tick),
        ),
      );
      if (!hasDueCycle || dueTransitionInFlightRef.current) {
        return;
      }

      dueTransitionInFlightRef.current = true;
      void markDueCyclesRinging(tick)
        .then(setCurrentAlarms)
        .catch((error: unknown) => {
          if (isStorageResetPendingError(error)) {
            // The record is not updated while a deletion is unfinished; the
            // notification itself still rings.
            setDeletionPending(true);
            setNotice(noticeFromCodeIn(messagesNow(), 'STORAGE_RESET_PENDING'));
            return;
          }
          setNotice(noticeFromCodeIn(messagesNow(), 'DUE_TRANSITION_FAILED'));
        })
        .finally(() => {
          dueTransitionInFlightRef.current = false;
        });
    }, 1_000);

    return () => clearInterval(interval);
  }, [setCurrentAlarms]);
}
