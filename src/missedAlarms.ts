import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/**
 * A due cycle first discovered later than this is shown as a silent missed
 * alarm instead of starting the loop sound.
 */
export const RECOVERY_WINDOW_MS = 30 * 60_000;

/**
 * `resume` runs on ticks and foreground returns: a cycle already ringing in
 * this process keeps ringing until the user stops it. `launch` runs once per
 * process start, where a stored `ringing` record has no live audio behind it.
 */
export type ClassificationSource = 'launch' | 'resume';

export function classifyDueCycle(
  cycle: StoredAlarm,
  nowMs: number,
  source: ClassificationSource,
): StoredAlarm {
  const lateMs = nowMs - cycle.dueAtMs;
  if (cycle.phase === 'armed' || cycle.phase === 'step_candidate') {
    if (lateMs < 0) {
      return cycle;
    }
    return {
      ...cycle,
      phase: lateMs > RECOVERY_WINDOW_MS ? 'missed' : 'ringing',
    };
  }
  if (cycle.phase === 'snoozed') {
    // A snooze is judged from its own delivery time, never the original one.
    const snoozeLateMs = nowMs - (cycle.snooze?.dueAtMs ?? cycle.dueAtMs);
    if (snoozeLateMs < 0) {
      return cycle;
    }
    return {
      ...cycle,
      phase: snoozeLateMs > RECOVERY_WINDOW_MS ? 'missed' : 'ringing',
    };
  }
  if (cycle.phase === 'ringing' && source === 'launch') {
    // After a snooze rang again, the lateness counts from that snooze.
    const ringingLateMs = nowMs - (cycle.snooze?.dueAtMs ?? cycle.dueAtMs);
    if (ringingLateMs > RECOVERY_WINDOW_MS) {
      return { ...cycle, phase: 'missed' };
    }
  }
  return cycle;
}

export function classifyOverdueCycles(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
  source: ClassificationSource,
): StoredAlarmDefinition[] {
  return alarms.map((alarm) => ({
    ...alarm,
    cycles: alarm.cycles.map((cycle) => classifyDueCycle(cycle, nowMs, source)),
  }));
}

export function getMissedCycles(
  alarms: readonly StoredAlarmDefinition[],
): StoredAlarm[] {
  return alarms
    .flatMap((alarm) => alarm.cycles)
    .filter((cycle) => cycle.phase === 'missed')
    .sort((left, right) => left.dueAtMs - right.dueAtMs);
}

export const MISSED_PREVIEW_LIMIT = 3;

/** Compact preview of the (oldest-first) missed list; total is never reduced. */
export function getMissedPreview<T>(
  missed: readonly T[],
  limit: number = MISSED_PREVIEW_LIMIT,
): { visible: T[]; hiddenCount: number; total: number } {
  const visible = missed.slice(0, Math.max(0, limit));
  return {
    visible,
    hiddenCount: missed.length - visible.length,
    total: missed.length,
  };
}

/** Marks only the listed missed cycles handled; nothing else changes. */
export function acknowledgeMissedCycles(
  alarms: readonly StoredAlarmDefinition[],
  cycleIds: readonly string[],
): StoredAlarmDefinition[] {
  const ids = new Set(cycleIds);
  return alarms.map((alarm) => ({
    ...alarm,
    cycles: alarm.cycles.map((cycle) =>
      cycle.phase === 'missed' && ids.has(cycle.cycleId)
        ? { ...cycle, phase: 'dismissed' as const }
        : cycle,
    ),
  }));
}
