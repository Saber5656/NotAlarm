import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import { getNextAlarmTime } from './alarmSchedule';
import { MIN_ARM_LEAD_MS } from './alarmPolicy';
import { classifyDueCycle } from './missedAlarms';
import { applySuppressionStepFloor, mergeWindowStepCount } from './stepWindow';
import { AppError, type ErrorCode } from './errorCatalog';

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
    throw new AppError('STEP_COUNT_INVALID');
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
    throw new AppError('ALARM_NOT_FOUND');
  }
  return cycle.phase === 'suppressed'
    ? applySuppressionStepFloor(next, cycle)
    : next;
}

/** What a delivered main notification claims to be. `dueAtMs` is optional
 * because already-scheduled notifications do not carry it. */
export interface MainDeliveryIdentity {
  alarmId?: string;
  cycleId: string;
  mainAlarmId: string;
  dueAtMs?: number;
}

export type RingingTransitionStatus =
  | 'ringing'
  /** Discovered past the recovery window; stored as silent missed. */
  | 'missed'
  | 'already_ringing'
  /** Finished (or not waiting for the deadline); an old or duplicate delivery. */
  | 'not_awaiting'
  | 'not_due'
  | 'mismatch'
  | 'not_found';

/**
 * Moves one cycle to ringing for a delivered main or snooze notification.
 * Applies only to a cycle that is still armed, step_candidate or snoozed,
 * matches the delivery's cycle/notification/due identity exactly (a snoozed
 * cycle: its current snooze.notificationId at snooze.dueAtMs), and has
 * reached that deadline now.
 * Everything else is returned unchanged, so a late or repeated delivery can
 * never bring a suppressed, dismissed or missed cycle back.
 */
export function markCycleRinging(
  alarms: readonly StoredAlarmDefinition[],
  expected: MainDeliveryIdentity,
  nowMs: number,
): { alarms: StoredAlarmDefinition[]; status: RingingTransitionStatus } {
  const unchanged = (status: RingingTransitionStatus) => ({
    alarms: [...alarms],
    status,
  });
  const target = alarms
    .filter(
      (alarm) =>
        expected.alarmId === undefined || alarm.id === expected.alarmId,
    )
    .flatMap((alarm) => alarm.cycles)
    .find((cycle) => cycle.cycleId === expected.cycleId);
  if (!target) {
    return unchanged('not_found');
  }
  // A snoozed cycle answers only to its current snooze delivery, judged at
  // the snooze's own due time; the original main (or an older snooze) cannot
  // wake it. The original dueAtMs is never read or changed for that decision.
  const snooze = target.snooze;
  const wakeId =
    target.phase === 'snoozed' ? snooze?.notificationId : target.mainAlarmId;
  const wakeDueAtMs =
    target.phase === 'snoozed' ? snooze?.dueAtMs : target.dueAtMs;
  if (target.phase === 'ringing') {
    // A repeat of the main or of the snooze that is ringing changes nothing.
    return unchanged(
      expected.mainAlarmId === target.mainAlarmId ||
        expected.mainAlarmId === snooze?.notificationId
        ? 'already_ringing'
        : 'mismatch',
    );
  }
  if (
    wakeId === undefined ||
    wakeDueAtMs === undefined ||
    wakeId !== expected.mainAlarmId ||
    (expected.dueAtMs !== undefined && wakeDueAtMs !== expected.dueAtMs)
  ) {
    return unchanged('mismatch');
  }
  if (
    target.phase !== 'armed' &&
    target.phase !== 'step_candidate' &&
    target.phase !== 'snoozed'
  ) {
    return unchanged('not_awaiting');
  }
  if (!Number.isFinite(nowMs) || nowMs < wakeDueAtMs) {
    return unchanged('not_due');
  }

  const next = classifyDueCycle(target, nowMs, 'resume');
  return {
    alarms: alarms.map((alarm) => ({
      ...alarm,
      cycles: alarm.cycles.map((cycle) => (cycle === target ? next : cycle)),
    })),
    status: next.phase === 'missed' ? 'missed' : 'ringing',
  };
}

export type AlarmEnablePreparation =
  | { ok: true; definition: StoredAlarmDefinition }
  | { ok: false; code: ErrorCode };

/**
 * Turning an alarm on never changes what it is: a today-only alarm keeps its
 * saved date, so an expired one is refused instead of adopting a new date.
 */
export function prepareAlarmEnable(
  definition: StoredAlarmDefinition,
  nowMs: number,
): AlarmEnablePreparation {
  const nextAtMs = getNextAlarmTime(
    nowMs,
    definition.hour,
    definition.minute,
    definition.repeat,
  );
  if (!nextAtMs || nextAtMs - nowMs < MIN_ARM_LEAD_MS) {
    return {
      ok: false,
      code:
        definition.repeat.kind === 'today'
          ? 'ALARM_TODAY_ENDED'
          : 'ARM_LEAD_TOO_SHORT',
    };
  }
  return {
    ok: true,
    definition: { ...definition, enabled: true, cycles: [] },
  };
}
