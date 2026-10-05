import { getUpcomingAlarmTimes, SCHEDULED_OCCURRENCES_PER_ALARM } from './alarmSchedule';
import {
  type AlarmSchedulingGateway,
  scheduleAlarmNotificationsFailSafe,
} from './alarmOrchestrator';
import { getCheckInAtMs } from './alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

export interface AlarmScheduleFillResult {
  definition: StoredAlarmDefinition;
  issues: AlarmScheduleIssue[];
  scheduledCycles: StoredAlarm[];
}

export type AlarmScheduleIssue =
  | {
      kind: 'main_schedule_failed';
      alarmId: string;
      cycleId: string;
      dueAtMs: number;
      message: string;
    }
  | {
      kind: 'check_in_schedule_failed';
      alarmId: string;
      cycleId: string;
      dueAtMs: number;
      mainAlarmId: string;
      message: string;
    };

export type AlarmScheduleIssueSeverity = 'none' | 'warning' | 'danger';

export function getAlarmScheduleIssueSeverity(
  issues: readonly AlarmScheduleIssue[],
): AlarmScheduleIssueSeverity {
  if (issues.some((issue) => issue.kind === 'main_schedule_failed')) {
    return 'danger';
  }
  return issues.length > 0 ? 'warning' : 'none';
}

/**
 * Identifies a scheduling problem across refills. Every attempt creates a new
 * cycle ID (and recovery failures use the current time), so only the alarm and
 * the kind of failure are compared.
 */
export function getAlarmScheduleIssueKey(issue: AlarmScheduleIssue): string {
  return `${issue.kind}:${issue.alarmId}`;
}

/**
 * Decides whether a refill should show a notice. A problem is new when the
 * previous refill did not report it; problems that went away are forgotten so
 * they are reported again if they come back.
 */
export function reconcileReportedScheduleProblems(
  reported: ReadonlySet<string>,
  current: readonly string[],
): { hasNew: boolean; reported: Set<string> } {
  return {
    hasNew: current.some((key) => !reported.has(key)),
    reported: new Set(current),
  };
}

/**
 * Tracks the alarms whose latest refill attempt left them short, so a row does
 * not tell the user to open the app while the app is open and could not
 * reserve later occurrences. An attempt replaces the earlier result for every
 * alarm it covered: an alarm is short when the attempt reported any issue for
 * it or skipped it (an unfinished stop/disable, or a refill that failed as a
 * whole). Alarms the attempt did not cover keep their earlier result.
 */
export interface RefillAttempt {
  attemptedAlarmIds: Iterable<string>;
  issues: readonly AlarmScheduleIssue[];
  skippedAlarmIds?: Iterable<string>;
}

export function recordRefillAttempt(
  previous: ReadonlySet<string>,
  attempt: RefillAttempt,
): Set<string> {
  const next = new Set(previous);
  for (const alarmId of attempt.attemptedAlarmIds) {
    next.delete(alarmId);
  }
  for (const issue of attempt.issues) {
    next.add(issue.alarmId);
  }
  for (const alarmId of attempt.skippedAlarmIds ?? []) {
    next.add(alarmId);
  }
  return next;
}

/** A refill that could not run at all leaves every enabled alarm short. */
export function getSkippedRefillAttempt(
  alarms: readonly StoredAlarmDefinition[],
): RefillAttempt {
  return {
    attemptedAlarmIds: alarms.map((alarm) => alarm.id),
    issues: [],
    skippedAlarmIds: alarms
      .filter((alarm) => alarm.enabled)
      .map((alarm) => alarm.id),
  };
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
      issues: [],
      scheduledCycles: [],
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
      issues: [],
      scheduledCycles: [],
    };
  }
  const occupiedDueTimes = new Set(
    normalizedCycles.map((cycle) => cycle.dueAtMs),
  );
  const cycles = [...normalizedCycles];
  const issues: AlarmScheduleIssue[] = [];
  const scheduledCycles: StoredAlarm[] = [];

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
      scheduledCycles.push(cycle);
      occupiedDueTimes.add(dueAtMs);
      activeCycleCount += 1;

      if (scheduled.checkInWarning) {
        issues.push({
          kind: 'check_in_schedule_failed',
          alarmId: definition.id,
          cycleId,
          dueAtMs,
          mainAlarmId: scheduled.mainAlarmId,
          message: scheduled.checkInWarning,
        });
      }
    } catch (error) {
      issues.push({
        kind: 'main_schedule_failed',
        alarmId: definition.id,
        cycleId,
        dueAtMs,
        message:
          error instanceof Error
            ? error.message
            : 'アラーム通知を予約できませんでした。',
      });
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
      issues,
      scheduledCycles,
    };
  }

  return {
    definition: {
      ...definition,
      cycles: cycles.sort((left, right) => left.dueAtMs - right.dueAtMs),
    },
    issues,
    scheduledCycles,
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
