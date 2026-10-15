import { currentPlanningZone } from './planningZone';
import {
  applyEvidenceStamps,
  collectLogicalDateEvidence,
  dateKeyInZone,
  isLogicalDateEvidence,
  LOGICAL_DATE_REACH_MS,
  stampOccurrence,
} from './occurrenceIdentity';
import { getUpcomingAlarmTimes, SCHEDULED_OCCURRENCES_PER_ALARM } from './alarmSchedule';
import {
  type AlarmSchedulingGateway,
  scheduleAlarmNotificationsFailSafe,
} from './alarmOrchestrator';
import { getCheckInAtMs } from './alarmPolicy';
import {
  type ErrorCode,
  type ErrorNotice,
  describeErrorCode,
  errorCodeOf,
} from './errorCatalog';
import { classifyDueCycle } from './missedAlarms';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

export interface AlarmScheduleFillResult {
  definition: StoredAlarmDefinition;
  issues: AlarmScheduleIssue[];
  scheduledCycles: StoredAlarm[];
  /**
   * A stopped occurrence's date could not be established (no valid origin
   * zone): nothing was scheduled, because the day it stopped must not be
   * guessed. The alarm is left short, not recreated.
   */
  originUnverified?: boolean;
}

export type AlarmScheduleIssue =
  | {
      kind: 'main_schedule_failed';
      alarmId: string;
      cycleId: string;
      dueAtMs: number;
      code: ErrorCode;
    }
  | {
      kind: 'check_in_schedule_failed';
      alarmId: string;
      cycleId: string;
      dueAtMs: number;
      mainAlarmId: string;
      code: ErrorCode;
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
 * The notice for what a fill left unfinished, or null when nothing is wrong.
 * A main failure always wins over a check-in failure, and `lead` states what
 * did succeed first. The text never says the alarm is reserved while a main
 * notification is missing or unverified.
 */
export function describeScheduleIssues(
  issues: readonly AlarmScheduleIssue[],
  lead: string,
): ErrorNotice | null {
  const main = issues.find((issue) => issue.kind === 'main_schedule_failed');
  const first = main ?? issues[0];
  if (!first) {
    return null;
  }
  const { tone, message, recovery } = describeErrorCode(first.code);
  return {
    tone,
    code: first.code,
    text: `${lead}${main ? '予約が完了していない回があります。' : ''}${message}${recovery}`,
  };
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
  planningZone: string = currentPlanningZone(),
  /** The zone stored occurrences without their own identity were planned in. */
  originZone?: string | null,
): Promise<AlarmScheduleFillResult> {
  const normalizedCycles = normalizeCycles(definition.cycles, nowMs);
  if (!definition.enabled) {
    return {
      definition: { ...definition, cycles: normalizedCycles },
      issues: [],
      scheduledCycles: [],
    };
  }

  // Which logical days are already taken is decided by the same utility the
  // time-zone replan uses, not by absolute due times: after a zone change a
  // skipped day sits at a different instant.
  const evidence = collectLogicalDateEvidence({
    cycles: normalizedCycles,
    nowMs,
    hour: definition.hour,
    minute: definition.minute,
    repeat: definition.repeat,
    planningZone,
    originZone,
  });
  if (evidence.originUnknown) {
    return {
      definition: { ...definition, cycles: normalizedCycles },
      issues: [],
      scheduledCycles: [],
      originUnverified: true,
    };
  }
  const stampedCycles = applyEvidenceStamps(normalizedCycles, evidence.stamps);

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
  // A blocked day can sit past (its old instant) or ahead; each takes at most
  // one slot, so ask for enough to still fill the target around them.
  const evidenceCount = stampedCycles.filter((cycle) =>
    isLogicalDateEvidence(cycle, nowMs),
  ).length;
  const dueTimes = getUpcomingAlarmTimes(
    nowMs,
    definition.hour,
    definition.minute,
    definition.repeat,
    targetActiveCycles + Math.max(completedFutureCycleCount, evidenceCount),
  );
  if (
    dueTimes.length === 0 &&
    definition.repeat.kind === 'today' &&
    !normalizedCycles.some(
      (cycle) => cycle.phase === 'ringing' || cycle.phase === 'snoozed',
    )
  ) {
    return {
      definition: {
        ...definition,
        enabled: false,
        cycles: stampedCycles,
      },
      issues: [],
      scheduledCycles: [],
    };
  }
  const occupiedDueTimes = new Set(
    stampedCycles.map((cycle) => cycle.dueAtMs),
  );
  const cycles = [...stampedCycles];
  let skippedBlockedDay = false;
  const issues: AlarmScheduleIssue[] = [];
  const scheduledCycles: StoredAlarm[] = [];

  for (const dueAtMs of dueTimes) {
    if (activeCycleCount >= targetActiveCycles) {
      break;
    }
    if (occupiedDueTimes.has(dueAtMs)) {
      continue;
    }
    if (evidence.blockedDates.size > 0) {
      const dateKey = dateKeyInZone(dueAtMs, planningZone);
      // An unreadable date cannot be compared with the stopped days: not used.
      if (dateKey === null || evidence.blockedDates.has(dateKey)) {
        skippedBlockedDay = true;
        continue;
      }
    }

    const armedAtMs = nowMs;
    const cycleId = makeCycleId();
    try {
      const scheduled = await scheduleAlarmNotificationsFailSafe(gateway, {
        alarmId: definition.id,
        cycleId,
        dueAtMs,
        checkInAtMs: getCheckInAtMs(dueAtMs, armedAtMs),
        repeats: definition.repeat.kind !== 'today',
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
        // Every new cycle carries its own logical date and zone.
        ...stampOccurrence(dueAtMs, planningZone),
      };
      cycles.push(cycle);
      scheduledCycles.push(cycle);
      occupiedDueTimes.add(dueAtMs);
      activeCycleCount += 1;

      if (scheduled.checkInErrorCode) {
        issues.push({
          kind: 'check_in_schedule_failed',
          alarmId: definition.id,
          cycleId,
          dueAtMs,
          mainAlarmId: scheduled.mainAlarmId,
          code: scheduled.checkInErrorCode,
        });
      }
    } catch (error) {
      issues.push({
        kind: 'main_schedule_failed',
        alarmId: definition.id,
        cycleId,
        dueAtMs,
        // Only a catalog code survives; the thrown message is never kept.
        code: errorCodeOf(error, 'MAIN_REGISTER_FAILED'),
      });
      break;
    }
  }

  if (
    activeCycleCount === 0 &&
    definition.repeat.kind === 'today' &&
    (skippedBlockedDay ||
      normalizedCycles.some(
        (cycle) =>
          cycle.dueAtMs > nowMs &&
          (cycle.phase === 'suppressed' || cycle.phase === 'dismissed'),
      ))
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
  // A stopped occurrence is kept while its calendar date can still be the
  // date of a slot ahead (see LOGICAL_DATE_REACH_MS): the instant it had is
  // not what matters after a zone change. Older ones can no longer recur.
  return cycles
    .filter(
      (cycle) =>
        (cycle.phase !== 'suppressed' && cycle.phase !== 'dismissed') ||
        cycle.dueAtMs > nowMs - LOGICAL_DATE_REACH_MS,
    )
    .map((cycle) => classifyDueCycle(cycle, nowMs, 'resume'));
}

function defaultCycleId(): string {
  return `cycle-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
