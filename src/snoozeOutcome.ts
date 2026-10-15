import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import { type ErrorCode, noticeFromCodes } from './errorCatalog';
import type { NoticeTone } from './noticeTone';
import type { CleanupReport, CommittedSnapshot, SnoozeResult } from './snooze';
import { getSnoozeCopy } from './snoozeCopy';

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

/** What the banner shows; `code` is set only for catalog outcomes. */
export interface OutcomeNotice {
  tone: NoticeTone;
  text: string;
  code?: ErrorCode;
}

export interface OutcomeEffects extends AdoptEffects {
  stopSound(): void;
  /** Refills the schedule after a stop; may throw. */
  refill(cycle: StoredAlarm): Promise<unknown>;
  isResetPending(error: unknown): boolean;
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * A durable stop reaches the screen in a fixed order: sound, committed
 * snapshot, then the fallible refill. The notice names the operation outcome
 * (stopped) separately from the follow-up (refill) and from the cleanup of
 * notifications, and a later success never hides an earlier warning.
 */
export async function presentStopped(
  result: { cycle: StoredAlarm } & CleanupReport & CommittedSnapshot,
  effects: OutcomeEffects,
): Promise<{ notice: OutcomeNotice; deletionPending: boolean }> {
  presentCommittedOutcome(result, effects);
  let refillError: unknown = null;
  let refillFailed = false;
  try {
    await effects.refill(result.cycle);
  } catch (error) {
    refillFailed = true;
    refillError = error;
  }
  await adoptStoredAlarms(result, effects);
  const deletionPending = refillFailed && effects.isResetPending(refillError);
  const codes: ErrorCode[] = [];
  if (deletionPending) {
    codes.push('STOP_FOLLOWUP_RESET_PENDING');
  } else if (refillFailed) {
    codes.push('STOP_FOLLOWUP_FAILED');
  }
  const cleanup = getSnoozeCopy.stopCleanupCode(result);
  if (cleanup) {
    codes.push(cleanup);
  }
  const [first, ...rest] = codes;
  if (!first) {
    return {
      notice: { tone: 'neutral', text: 'アラームを停止しました。' },
      deletionPending,
    };
  }
  return { notice: noticeFromCodes([first, ...rest]), deletionPending };
}

/** An accepted snooze: sound and snapshot first, nothing fallible between. */
export async function presentSnoozed(
  result: Extract<SnoozeResult, { status: 'snoozed' }>,
  effects: OutcomeEffects,
): Promise<OutcomeNotice> {
  const applied = presentCommittedOutcome(result, effects);
  if (!applied) {
    await adoptStoredAlarms(result, effects);
  }
  const cleanup = getSnoozeCopy.acceptedCleanupCode(result);
  if (cleanup) {
    return noticeFromCodes([cleanup]);
  }
  return {
    tone: 'neutral',
    text: `スヌーズしました。${clock(result.dueAtMs)}にもう一度鳴ります。`,
  };
}

/**
 * A refused snooze left the alarm ringing: the sound is untouched. Stored
 * state is read best effort, and the notice carries the rejection's own code.
 */
export async function presentSnoozeRejected(
  result: Extract<SnoozeResult, { status: 'rejected' }>,
  effects: AdoptEffects,
): Promise<OutcomeNotice> {
  await adoptStoredAlarms({}, effects);
  return noticeFromCodes([getSnoozeCopy.failureCode(result.reason, result)]);
}
