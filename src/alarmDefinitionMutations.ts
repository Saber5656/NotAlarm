import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import { applySuppressionStepFloor, mergeWindowStepCount } from './stepWindow';

export type MonitoringStepUpdateStatus =
  | 'updated'
  | 'not_monitoring'
  | 'not_found'
  /** Counted from before the stored start; an older callback is ignored. */
  | 'stale_window';

export interface MonitoringStepUpdateResult {
  alarms: StoredAlarmDefinition[];
  status: MonitoringStepUpdateStatus;
}

export function updateMonitoringCycleStepCount(
  alarms: readonly StoredAlarmDefinition[],
  alarmId: string,
  cycleId: string,
  stepCount: number,
  countedFromMs: number,
): MonitoringStepUpdateResult {
  if (!Number.isFinite(stepCount) || !Number.isFinite(countedFromMs)) {
    throw new Error('歩数が不正です。');
  }

  const target = alarms
    .find((alarm) => alarm.id === alarmId)
    ?.cycles.find((cycle) => cycle.cycleId === cycleId);

  if (!target) {
    return { alarms: [...alarms], status: 'not_found' };
  }
  if (target.phase !== 'armed' && target.phase !== 'step_candidate') {
    return { alarms: [...alarms], status: 'not_monitoring' };
  }
  // The stored start only moves later (for example when another suppression
  // used the steps before it), so progress from an earlier start is stale.
  if (
    typeof target.stepCountFromMs === 'number' &&
    !(countedFromMs >= target.stepCountFromMs)
  ) {
    return { alarms: [...alarms], status: 'stale_window' };
  }

  const next = alarms.map((alarm) => ({
    ...alarm,
    cycles: alarm.cycles.map((cycle) => {
      if (alarm.id !== alarmId || cycle.cycleId !== cycleId) {
        return cycle;
      }
      return {
        ...cycle,
        ...mergeWindowStepCount(cycle, stepCount, countedFromMs),
      };
    }),
  }));

  return {
    alarms: next,
    status: 'updated',
  };
}

/**
 * Replaces one stored cycle. Saving a suppressed cycle also stores its
 * confirmation time as the counting start of overlapping cycles in the same
 * write, so the floor survives later pruning of the suppressed cycle.
 */
export function replaceStoredCycle(
  alarms: readonly StoredAlarmDefinition[],
  cycle: StoredAlarm,
): StoredAlarmDefinition[] {
  let found = false;
  const next = alarms.map((alarm) => {
    if (alarm.id !== cycle.alarmId) {
      return alarm;
    }

    const cycles = alarm.cycles.map((candidate) => {
      if (candidate.cycleId !== cycle.cycleId) {
        return candidate;
      }
      found = true;
      return cycle;
    });
    return { ...alarm, cycles };
  });

  if (!found) {
    throw new Error('対象のアラーム周期が見つかりません。');
  }
  return cycle.phase === 'suppressed'
    ? applySuppressionStepFloor(next, cycle)
    : next;
}
