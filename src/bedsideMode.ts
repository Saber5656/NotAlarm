import type { StoredAlarmDefinition } from './alarmStorage';
import type { NotificationDeliveryState } from './notificationDelivery';

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

export interface BedsideGuidance {
  /** Footer headline: the bedside procedure itself. */
  title: string;
  /** Footer second line: what happens when the app leaves the screen. */
  detail: string;
  /** Warning shown when expo-keep-awake cannot keep the screen on. */
  keepAwakeFailure: string;
}

const BEDSIDE_TITLE = '寝るときはアプリを画面に表示したまま充電してください';
const LEAVES_SCREEN = '画面ロック・アプリを閉じると';

// What an alarm does once the app is off screen. Only a delivered
// notification makes a sound then, so the other states must not promise one.
const OFF_SCREEN_CONSEQUENCES: Record<
  NotificationDeliveryState,
  { detail: string; whenScreenOff: string }
> = {
  ok: {
    detail: '通知音1回だけ・歩数確認なし',
    whenScreenOff: 'アラームは通知音1回だけ・歩数確認なしになる',
  },
  off: {
    detail: '鳴りません',
    whenScreenOff: 'アラームが鳴らない',
  },
  silent: {
    detail: '音が出ません',
    whenScreenOff: 'アラームの音が出ない',
  },
  unknown: {
    detail: '鳴るか確認できません',
    whenScreenOff: 'アラームが鳴るか確認できない',
  },
};

/**
 * Bedside guidance for the footer, the composer and the keep-awake failure
 * notice. `null` (not checked yet, and always on web) is treated like
 * `unknown`: nothing may be promised before the permission check completes.
 */
export function getBedsideGuidance(
  delivery: NotificationDeliveryState | null,
): BedsideGuidance {
  const consequence = OFF_SCREEN_CONSEQUENCES[delivery ?? 'unknown'];
  return {
    title: BEDSIDE_TITLE,
    detail: `${LEAVES_SCREEN}${consequence.detail}`,
    keepAwakeFailure: `画面を点けたままにできませんでした。画面が消えると${consequence.whenScreenOff}ため、端末の自動ロックをオフにしてください。`,
  };
}

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
