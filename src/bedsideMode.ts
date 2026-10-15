import type { Messages } from './i18n/messages';
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

/**
 * Bedside guidance for the footer, the composer and the keep-awake failure
 * notice. What an alarm does once the app is off screen: only a delivered
 * notification makes a sound then, so the other states must not promise one.
 * `null` (not checked yet, and always on web) is treated like `unknown`:
 * nothing may be promised before the permission check completes.
 */
export function getBedsideGuidance(
  delivery: NotificationDeliveryState | null,
  messages: Messages,
): BedsideGuidance {
  const b = messages.bedside;
  const consequence = {
    ok: { detail: b.detailOk, whenScreenOff: b.whenScreenOffOk },
    off: { detail: b.detailOff, whenScreenOff: b.whenScreenOffOff },
    silent: { detail: b.detailSilent, whenScreenOff: b.whenScreenOffSilent },
    unknown: { detail: b.detailUnknown, whenScreenOff: b.whenScreenOffUnknown },
  }[delivery ?? 'unknown'];
  return {
    title: b.title,
    detail: `${b.leavesScreen}${consequence.detail}`,
    keepAwakeFailure: b.keepAwakeFailure(consequence.whenScreenOff),
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
        // The in-app sound can only start while the app stays on screen.
        cycle.phase === 'snoozed' ||
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
