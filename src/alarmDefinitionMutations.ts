import type { StoredAlarmDefinition } from './alarmStorage';
import { mergeWindowStepCount } from './stepWindow';

export type MonitoringStepUpdateStatus =
  | 'updated'
  | 'not_monitoring'
  | 'not_found';

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
