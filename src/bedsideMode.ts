import type { StoredAlarmDefinition } from './alarmStorage';

/**
 * Bedside mode (owner decision 2026-10-05): until a native alarm build exists,
 * the official procedure is to leave the app on screen while charging. With
 * the app closed or the screen locked, an alarm is only one notification
 * sound and steps are not checked, so the app keeps the screen on while an
 * alarm is close.
 */
export const KEEP_AWAKE_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/** expo-keep-awake tag owned by bedside mode. */
export const BEDSIDE_KEEP_AWAKE_TAG = 'already-up/bedside';

export const BEDSIDE_GUIDANCE = {
  title: '寝るときはアプリを開いたまま充電してください',
  detail: '閉じると通知音1回だけ・歩数確認なし',
} as const;

/**
 * True while any cycle is ringing, or while an enabled alarm has a monitoring
 * cycle due within the next 24 hours. A monitoring cycle that is already due
 * counts too: it is about to be marked ringing, and sleeping in between would
 * suspend the app before the loop sound starts.
 */
export function shouldKeepScreenAwake(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
): boolean {
  const horizonMs = nowMs + KEEP_AWAKE_LOOKAHEAD_MS;
  return alarms.some((alarm) =>
    alarm.cycles.some(
      (cycle) =>
        // The ringing card and sound do not depend on `enabled`.
        cycle.phase === 'ringing' ||
        (alarm.enabled &&
          (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
          cycle.dueAtMs <= horizonMs),
    ),
  );
}

/**
 * Whether the app is on screen for keep-awake purposes. Only `background`
 * releases the lock: iOS reports `inactive` while an overlay such as Control
 * Center is shown, and an unreadable state must not let the screen sleep.
 */
export function isForegroundAppState(
  state: string | null | undefined,
): boolean {
  return state !== 'background';
}
