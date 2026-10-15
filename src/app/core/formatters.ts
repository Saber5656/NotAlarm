import type { StoredAlarm, StoredAlarmDefinition } from '../../alarmStorage';

export function makeAlarmId(): string {
  return `alarm-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function defaultWakeTime(): Date {
  const wakeTime = new Date();
  wakeTime.setHours(7, 0, 0, 0);
  return wakeTime;
}

export function isMonitoring(cycle: StoredAlarm): boolean {
  return cycle.phase === 'armed' || cycle.phase === 'step_candidate';
}

export function nextCycleForDefinition(
  definition: StoredAlarmDefinition,
  nowMs: number,
): StoredAlarm | null {
  return (
    definition.cycles
      .filter((cycle) => isMonitoring(cycle) && cycle.dueAtMs > nowMs)
      .sort((left, right) => left.dueAtMs - right.dueAtMs)[0] ?? null
  );
}
