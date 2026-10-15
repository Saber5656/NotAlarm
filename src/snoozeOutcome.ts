import type { StoredAlarmDefinition } from './alarmStorage';
import type { CommittedSnapshot } from './snooze';

export interface CommittedOutcomeEffects {
  stopSound(): void;
  /** Must be the epoch-safe setter: it drops a snapshot from before a reset. */
  apply(alarms: StoredAlarmDefinition[]): void;
}

/**
 * What the screen does with a snooze or stop that took effect, before any
 * fallible reload or refill: the sound stops, then the exact committed
 * snapshot replaces the list. A failure after this point cannot leave the
 * ringing card up for an occurrence that is no longer ringing. Returns whether
 * a snapshot was applied.
 */
export function presentCommittedOutcome(
  result: CommittedSnapshot,
  effects: CommittedOutcomeEffects,
): boolean {
  try {
    effects.stopSound();
  } catch {
    // The state is what matters; a sound that will not stop is reported by
    // the foreground handler, not here.
  }
  if (!result.alarms) {
    return false;
  }
  effects.apply(result.alarms);
  return true;
}

export interface AdoptEffects {
  apply(alarms: StoredAlarmDefinition[]): void;
  reload(): Promise<StoredAlarmDefinition[]>;
}

/**
 * Brings the screen to stored truth after an outcome. A committed snapshot is
 * already the truth and needs no read; without one the read is best effort and
 * its failure is not an error of the operation that already finished.
 */
export async function adoptStoredAlarms(
  result: CommittedSnapshot,
  effects: AdoptEffects,
): Promise<void> {
  if (result.alarms) {
    return;
  }
  try {
    effects.apply(await effects.reload());
  } catch {
    // Keep what the screen shows; the next tick or resume reads again.
  }
}
