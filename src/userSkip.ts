import { STEP_WINDOW_LEAD_MS } from './alarmPolicy';
import type { StoredAlarm } from './alarmStorage';

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

export const USER_SKIP_LABEL = '今回分だけ止める';

export function describeUserSkipConfirmation(
  cycle: Pick<StoredAlarm, 'dueAtMs'>,
  formatDate: (timestampMs: number) => string,
  formatClock: (timestampMs: number) => string,
): { title: string; body: string; confirmLabel: string; cancelLabel: string } {
  return {
    title: '今回分だけ止めますか？',
    body: `${formatDate(cycle.dueAtMs)} ${formatClock(
      cycle.dueAtMs,
    )} の回だけ止めます。繰り返しの設定は変わらず、次の日以降は予定どおり鳴ります。`,
    confirmLabel: USER_SKIP_LABEL,
    cancelLabel: 'キャンセル',
  };
}
