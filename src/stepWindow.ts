import { STEP_WINDOW_LEAD_MS } from './alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/**
 * The span in which steps may count as wake evidence for one alarm cycle:
 * from `startMs` (inclusive) until `dueAtMs` (exclusive).
 */
export interface StepWindow {
  startMs: number;
  dueAtMs: number;
}

export type StepWindowPhase = 'before' | 'active' | 'ended';

/**
 * Returns the latest instant at which another cycle was suppressed before this
 * cycle is due. Steps up to that instant were already used (or the user was
 * already confirmed awake), so they never count again for this cycle.
 */
export function getStepCountingFloorMs(
  alarms: readonly StoredAlarmDefinition[],
  cycle: StoredAlarm,
): number | undefined {
  let floorMs: number | undefined;
  for (const candidate of alarms.flatMap((alarm) => alarm.cycles)) {
    if (
      (candidate.alarmId === cycle.alarmId &&
        candidate.cycleId === cycle.cycleId) ||
      candidate.phase !== 'suppressed' ||
      typeof candidate.confirmedAtMs !== 'number' ||
      !Number.isFinite(candidate.confirmedAtMs) ||
      candidate.confirmedAtMs >= cycle.dueAtMs
    ) {
      continue;
    }
    if (floorMs === undefined || candidate.confirmedAtMs > floorMs) {
      floorMs = candidate.confirmedAtMs;
    }
  }
  return floorMs;
}

export function getStepWindow(cycle: StoredAlarm, floorMs?: number): StepWindow {
  const starts = [cycle.dueAtMs - STEP_WINDOW_LEAD_MS, cycle.armedAtMs];
  if (typeof floorMs === 'number' && Number.isFinite(floorMs)) {
    starts.push(floorMs);
  }
  // A start already used for this cycle never moves earlier, even after the
  // suppressed cycle that set the floor has been pruned from storage.
  if (
    typeof cycle.stepCountFromMs === 'number' &&
    Number.isFinite(cycle.stepCountFromMs) &&
    cycle.stepCountFromMs < cycle.dueAtMs
  ) {
    starts.push(cycle.stepCountFromMs);
  }
  return { startMs: Math.max(...starts), dueAtMs: cycle.dueAtMs };
}

/**
 * The instant from which steps count for `cycle`:
 * max(due - 60 min, armedAt, latest other suppression before due, stored
 * `stepCountFromMs`). The stored start carries floors from suppressions that
 * have since been pruned (see `applySuppressionStepFloor`).
 */
export function getStepCountingStartMs(
  alarms: readonly StoredAlarmDefinition[],
  cycle: StoredAlarm,
): number {
  return getStepWindow(cycle, getStepCountingFloorMs(alarms, cycle)).startMs;
}

/**
 * Makes the "steps already used" floor durable. When `suppressed` stops its
 * alarm at `confirmedAtMs`, every other armed / step_candidate cycle (any
 * alarm) whose window is open at that instant restarts counting from it, so the
 * same steps cannot also stop that cycle after the suppressed cycle is pruned.
 * Cycles that already count from a later start keep their progress.
 */
export function applySuppressionStepFloor(
  alarms: readonly StoredAlarmDefinition[],
  suppressed: StoredAlarm,
): StoredAlarmDefinition[] {
  const floorMs = suppressed.confirmedAtMs;
  if (
    suppressed.phase !== 'suppressed' ||
    typeof floorMs !== 'number' ||
    !Number.isFinite(floorMs)
  ) {
    return [...alarms];
  }

  return alarms.map((alarm) => ({
    ...alarm,
    cycles: alarm.cycles.map((cycle) => {
      if (
        (cycle.alarmId === suppressed.alarmId &&
          cycle.cycleId === suppressed.cycleId) ||
        (cycle.phase !== 'armed' && cycle.phase !== 'step_candidate') ||
        !(cycle.dueAtMs - STEP_WINDOW_LEAD_MS < floorMs) ||
        !(floorMs < cycle.dueAtMs) ||
        (typeof cycle.stepCountFromMs === 'number' &&
          cycle.stepCountFromMs >= floorMs)
      ) {
        return cycle;
      }
      return { ...cycle, stepCount: 0, stepCountFromMs: floorMs };
    }),
  }));
}

export function getStepWindowPhase(
  window: StepWindow,
  nowMs: number,
): StepWindowPhase {
  if (nowMs >= window.dueAtMs) {
    return 'ended';
  }
  return nowMs < window.startMs ? 'before' : 'active';
}

/**
 * Steps count only while the window is open and the app is on screen. Step
 * history recorded while the app was closed or in the background is never
 * added, so walking with the app closed and going back to sleep cannot stop
 * the alarm.
 */
export function shouldWatchSteps(
  phase: StepWindowPhase | null,
  isAppForeground: boolean,
): boolean {
  return phase === 'active' && isAppForeground;
}

/**
 * Persisted progress only belongs to the window it was counted in. Progress
 * from another start (or legacy progress without a start) counts as zero.
 */
export function getWindowStepCount(
  cycle: StoredAlarm,
  window: StepWindow,
): number {
  return cycle.stepCountFromMs === window.startMs ? cycle.stepCount : 0;
}

/**
 * Keeps step progress monotonic within one window and restarts it when a new
 * window begins counting from its own start.
 */
export function mergeWindowStepCount(
  cycle: StoredAlarm,
  stepCount: number,
  countedFromMs: number,
): Pick<StoredAlarm, 'stepCount' | 'stepCountFromMs'> {
  if (!Number.isFinite(stepCount) || !Number.isFinite(countedFromMs)) {
    throw new Error('歩数が不正です。');
  }
  return {
    stepCount:
      cycle.stepCountFromMs === countedFromMs
        ? Math.max(cycle.stepCount, stepCount)
        : stepCount,
    stepCountFromMs: countedFromMs,
  };
}
