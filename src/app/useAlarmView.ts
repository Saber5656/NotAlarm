import { useMemo } from 'react';
import { Platform } from 'react-native';

import {
  getNextMonitoringCycle,
  getRingingCycle,
} from '../alarmScheduling';
import type { StoredAlarmDefinition } from '../alarmStorage';
import { getMissedCycles, getMissedPreview } from '../missedAlarms';
import {
  getStepCountingStartMs,
  getStepWindowPhase,
  shouldWatchSteps,
  type StepWindow,
} from '../stepWindow';
import { getUserSkipOffer } from '../userSkip';
import { nextCycleForDefinition } from './core/formatters';

/**
 * What the alarm list means right now: the ringing, snoozed and missed
 * occurrences, the next one being monitored, its step window and the rows in
 * display order. Pure derivation of the alarms, the clock and foreground state.
 */
export function useAlarmView(input: {
  alarms: StoredAlarmDefinition[];
  nowMs: number;
  isAppForeground: boolean;
}) {
  const { alarms, nowMs, isAppForeground } = input;
  const ringingCycle = useMemo(() => getRingingCycle(alarms), [alarms]);
  const snoozedCycle = useMemo(
    () =>
      alarms
        .flatMap((alarm) => alarm.cycles)
        .filter((cycle) => cycle.phase === 'snoozed')
        .sort(
          (left, right) =>
            (left.snooze?.dueAtMs ?? left.dueAtMs) -
            (right.snooze?.dueAtMs ?? right.dueAtMs),
        )[0] ?? null,
    [alarms],
  );
  const missedCycles = useMemo(() => getMissedCycles(alarms), [alarms]);
  const missedPreview = useMemo(
    () => getMissedPreview(missedCycles),
    [missedCycles],
  );
  const monitoringCycle = useMemo(
    () => (ringingCycle ? null : getNextMonitoringCycle(alarms, nowMs)),
    [alarms, nowMs, ringingCycle],
  );
  const stepWindow = useMemo<StepWindow | null>(
    () =>
      monitoringCycle
        ? {
            startMs: getStepCountingStartMs(alarms, monitoringCycle),
            dueAtMs: monitoringCycle.dueAtMs,
          }
        : null,
    [alarms, monitoringCycle],
  );
  const stepWindowPhase = stepWindow
    ? getStepWindowPhase(stepWindow, nowMs)
    : null;
  // Steps count only inside the window and only while the app is on screen.
  const skipOffer =
    Platform.OS === 'web' ? null : getUserSkipOffer(monitoringCycle, nowMs);
  const isWatchingSteps =
    Platform.OS !== 'web' && shouldWatchSteps(stepWindowPhase, isAppForeground);

  const orderedAlarms = useMemo(
    () =>
      [...alarms].sort((left, right) => {
        const leftNext = nextCycleForDefinition(left, nowMs)?.dueAtMs;
        const rightNext = nextCycleForDefinition(right, nowMs)?.dueAtMs;
        if (leftNext !== undefined && rightNext !== undefined) {
          return leftNext - rightNext;
        }
        if (leftNext !== undefined) {
          return -1;
        }
        if (rightNext !== undefined) {
          return 1;
        }
        return left.hour * 60 + left.minute - (right.hour * 60 + right.minute);
      }),
    [alarms, nowMs],
  );

  return {
    ringingCycle,
    snoozedCycle,
    missedCycles,
    missedPreview,
    monitoringCycle,
    stepWindow,
    stepWindowPhase,
    skipOffer,
    isWatchingSteps,
    orderedAlarms,
  };
}
