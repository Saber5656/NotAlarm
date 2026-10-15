import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/**
 * Persists a suppressed cycle and hands the saved definitions to `apply`
 * straight away, before any fallible cleanup or refill runs. A later failure
 * then cannot leave the screen, step watcher or countdown on the old armed
 * state. `apply` must be the epoch-safe setter; it is not called on failure.
 */
export function createSuppressionSaver(
  save: (cycle: StoredAlarm) => Promise<StoredAlarmDefinition[]>,
  apply: (next: StoredAlarmDefinition[]) => void,
): (cycle: StoredAlarm) => Promise<void> {
  return async (cycle) => {
    const saved = await save(cycle);
    apply(saved);
  };
}

export interface SuppressionCleanup {
  /** Cancels the still-scheduled check-in; may throw. */
  cancelCheckIn(notificationId: string | undefined): Promise<void>;
  /** Removes an already-delivered check-in; best effort. */
  dismissDelivered(notificationId: string | undefined): Promise<void>;
  refill(alarm: StoredAlarm): Promise<unknown>;
}

/**
 * Work after a confirmed, persisted suppression. The delivered check-in is
 * always dismissed (even when cancelling failed); a cancel failure is then
 * rethrown and skips the refill. Nothing here changes the suppressed state.
 */
export async function finishSuppression(
  alarm: StoredAlarm,
  cleanup: SuppressionCleanup,
): Promise<void> {
  const notificationId = alarm.checkInNotificationId;
  let cancelFailure: { error: unknown } | null = null;
  try {
    await cleanup.cancelCheckIn(notificationId);
  } catch (error) {
    cancelFailure = { error };
  }
  await cleanup.dismissDelivered(notificationId).catch(() => undefined);
  if (cancelFailure) {
    throw cancelFailure.error;
  }
  await cleanup.refill(alarm);
}
