import { STEP_WINDOW_LEAD_MS } from './alarmPolicy';
import type { StoredAlarm } from './alarmStorage';
import type { TextContext } from './i18n/context';

/** The exact occurrence a skip dialog was opened for. */
export interface UserSkipTarget {
  cycleId: string;
  mainAlarmId: string;
  dueAtMs: number;
}

export function buildUserSkipTarget(cycle: StoredAlarm): UserSkipTarget {
  return {
    cycleId: cycle.cycleId,
    mainAlarmId: cycle.mainAlarmId,
    dueAtMs: cycle.dueAtMs,
  };
}

/**
 * The skip button is offered for a monitoring occurrence only inside
 * [due - 60 min, due); it disappears the instant the alarm is due.
 */
export function getUserSkipOffer(
  cycle: StoredAlarm | null,
  nowMs: number,
): UserSkipTarget | null {
  if (
    !cycle ||
    (cycle.phase !== 'armed' && cycle.phase !== 'step_candidate') ||
    !Number.isFinite(nowMs) ||
    nowMs < cycle.dueAtMs - STEP_WINDOW_LEAD_MS ||
    nowMs < cycle.armedAtMs ||
    nowMs >= cycle.dueAtMs
  ) {
    return null;
  }
  return buildUserSkipTarget(cycle);
}

/**
 * The exact target the dialog confirms: looked up by the offered cycle id and
 * re-checked against the window at tap time, never retargeted.
 */
export function captureUserSkipTarget(
  cycles: readonly StoredAlarm[],
  offeredCycleId: string | undefined,
  nowMs: number,
): UserSkipTarget | null {
  if (offeredCycleId === undefined) {
    return null;
  }
  return getUserSkipOffer(
    cycles.find((cycle) => cycle.cycleId === offeredCycleId) ?? null,
    nowMs,
  );
}

export function describeUserSkipConfirmation(
  cycle: Pick<StoredAlarm, 'dueAtMs'>,
  { messages, formatter }: TextContext,
): { title: string; body: string; confirmLabel: string; cancelLabel: string } {
  return {
    title: messages.skip.confirmTitle,
    body: messages.skip.confirmBody(
      `${formatter.day(cycle.dueAtMs)} ${formatter.clockAt(cycle.dueAtMs)}`,
    ),
    confirmLabel: messages.skip.label,
    cancelLabel: messages.common.cancel,
  };
}
