import { getUpcomingAlarmTimes, SCHEDULED_OCCURRENCES_PER_ALARM } from './alarmSchedule';
import {
  type AlarmSchedulingGateway,
  scheduleAlarmNotificationsFailSafe,
} from './alarmOrchestrator';
import { getCheckInAtMs } from './alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

export interface AlarmScheduleFillResult {
  definition: StoredAlarmDefinition;
  warnings: string[];
}

export async function fillAlarmDefinitionSchedule(
  definition: StoredAlarmDefinition,
  nowMs: number,
  gateway: AlarmSchedulingGateway,
  makeCycleId: () => string = defaultCycleId,
): Promise<AlarmScheduleFillResult> {
  const normalizedCycles = normalizeCycles(definition.cycles, nowMs);
  if (!definition.enabled) {
    return {
      definition: { ...definition, cycles: normalizedCycles },
      warnings: [],
    };
  }

  const targetActiveCycles =
    definition.repeat.kind === 'today'
      ? 1
      : SCHEDULED_OCCURRENCES_PER_ALARM;
  let activeCycleCount = normalizedCycles.filter(
    (cycle) =>
      (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
      cycle.dueAtMs > nowMs,
  ).length;
  const completedFutureCycleCount = normalizedCycles.filter(
    (cycle) =>
      cycle.dueAtMs > nowMs &&
      cycle.phase !== 'armed' &&
      cycle.phase !== 'step_candidate',
  ).length;
  const dueTimes = getUpcomingAlarmTimes(
    nowMs,
    definition.hour,
    definition.minute,
    definition.repeat,
    targetActiveCycles + completedFutureCycleCount,
  );
  if (
    dueTimes.length === 0 &&
    definition.repeat.kind === 'today' &&
    !normalizedCycles.some((cycle) => cycle.phase === 'ringing')
  ) {
    return {
      definition: {
        ...definition,
        enabled: false,
        cycles: normalizedCycles,
      },
      warnings: [],
    };
  }
  const occupiedDueTimes = new Set(
    normalizedCycles.map((cycle) => cycle.dueAtMs),
  );
  const cycles = [...normalizedCycles];
  const warnings: string[] = [];

  for (const dueAtMs of dueTimes) {
    if (activeCycleCount >= targetActiveCycles) {
      break;
    }
    if (occupiedDueTimes.has(dueAtMs)) {
      continue;
    }

    const armedAtMs = nowMs;
    const cycleId = makeCycleId();
    try {
      const scheduled = await scheduleAlarmNotificationsFailSafe(gateway, {
        alarmId: definition.id,
        cycleId,
        dueAtMs,
        checkInAtMs: getCheckInAtMs(dueAtMs, armedAtMs),
      });

      const cycle: StoredAlarm = {
        alarmId: definition.id,
        cycleId,
        mainAlarmId: scheduled.mainAlarmId,
        checkInNotificationId: scheduled.checkInNotificationId,
        armedAtMs,
        dueAtMs,
        phase: 'armed',
        stepCount: 0,
        stepCandidateRecorded: false,
      };
      cycles.push(cycle);
      occupiedDueTimes.add(dueAtMs);
      activeCycleCount += 1;

      if (scheduled.checkInWarning) {
        warnings.push(scheduled.checkInWarning);
      }
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? error.message
          : 'アラーム通知を予約できませんでした。',
      );
      break;
    }
  }

  if (
    activeCycleCount === 0 &&
    definition.repeat.kind === 'today' &&
    normalizedCycles.some(
      (cycle) =>
        cycle.dueAtMs > nowMs &&
        (cycle.phase === 'suppressed' || cycle.phase === 'dismissed'),
    )
  ) {
    return {
      definition: {
        ...definition,
        enabled: false,
        cycles: cycles.sort((left, right) => left.dueAtMs - right.dueAtMs),
      },
      warnings,
    };
  }
  if (dueTimes.length > 0 && activeCycleCount === 0) {
    throw new Error(warnings[0] ?? 'アラーム通知を予約できませんでした。');
  }

  return {
    definition: {
      ...definition,
      cycles: cycles.sort((left, right) => left.dueAtMs - right.dueAtMs),
    },
    warnings,
  };
}

export function getNextMonitoringCycle(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
): StoredAlarm | null {
  return (
    alarms
      .flatMap((alarm) => alarm.cycles)
      .filter(
        (cycle) =>
          (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
          cycle.dueAtMs > nowMs,
      )
      .sort((left, right) => left.dueAtMs - right.dueAtMs)[0] ?? null
  );
}

export function getRingingCycle(
  alarms: readonly StoredAlarmDefinition[],
): StoredAlarm | null {
  return (
    alarms
      .flatMap((alarm) => alarm.cycles)
      .filter((cycle) => cycle.phase === 'ringing')
      .sort((left, right) => left.dueAtMs - right.dueAtMs)[0] ?? null
  );
}

function normalizeCycles(
  cycles: readonly StoredAlarm[],
  nowMs: number,
): StoredAlarm[] {
  return cycles
    .filter(
      (cycle) =>
        (cycle.phase !== 'suppressed' && cycle.phase !== 'dismissed') ||
        cycle.dueAtMs >= nowMs,
    )
    .map((cycle) =>
      (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
      cycle.dueAtMs <= nowMs
        ? { ...cycle, phase: 'ringing' as const }
        : cycle,
    );
}

function defaultCycleId(): string {
  return `cycle-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
