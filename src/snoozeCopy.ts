import type { ErrorCode } from './errorCatalog';
import { noticeFromCodeIn } from './i18n/errorText';
import type { TextContext } from './i18n/context';
import type { Messages } from './i18n/messages';
import {
  SNOOZE_INTERVAL_MS,
  SNOOZE_MAX_COUNT,
  type SnoozeRecoveryOutcome,
  type SnoozeRejection,
} from './snooze';

export interface SnoozeCopy {
  title: string;
  detail: string;
  actionLabel: string;
  actionHint: string;
  actionDisabled: boolean;
}

const SNOOZE_MINUTES = SNOOZE_INTERVAL_MS / 60_000;

/**
 * Wording for the ringing card (secondary to stopping) and for the card shown
 * while a snooze waits. `nextAtMs` is when the next ring would be.
 */
export function getSnoozeCopy(
  input: {
    phase: 'ringing' | 'snoozed';
    used: number;
    nextAtMs: number;
  },
  { messages, formatter }: TextContext,
): SnoozeCopy {
  const copy = messages.snooze;
  const remaining = Math.max(0, SNOOZE_MAX_COUNT - input.used);
  const clock = formatter.clockAt(input.nextAtMs);
  if (input.phase === 'snoozed') {
    return {
      title: copy.waitingTitle,
      detail: copy.waitingDetail(clock, input.used, SNOOZE_MAX_COUNT),
      actionLabel: copy.stopLabel,
      actionHint: copy.stopHint,
      actionDisabled: false,
    };
  }
  if (remaining === 0) {
    return {
      title: copy.title,
      detail: copy.exhaustedDetail(SNOOZE_MAX_COUNT),
      actionLabel: copy.actionLabel(SNOOZE_MINUTES),
      actionHint: copy.exhaustedHint,
      actionDisabled: true,
    };
  }
  return {
    title: copy.title,
    detail: copy.availableDetail(clock, remaining),
    actionLabel: copy.actionLabel(SNOOZE_MINUTES),
    actionHint: copy.actionHint(SNOOZE_MINUTES),
    actionDisabled: false,
  };
}

const FAILURE_CODE: Record<SnoozeRejection, ErrorCode> = {
  NOT_FOUND: 'SNOOZE_NOT_FOUND',
  NOT_RINGING: 'SNOOZE_NOT_RINGING',
  LIMIT_REACHED: 'SNOOZE_LIMIT_REACHED',
  TOO_LATE: 'SNOOZE_TOO_LATE',
  CAPACITY_FULL: 'SNOOZE_CAPACITY_FULL',
  LIST_FAILED: 'SNOOZE_LIST_FAILED',
  INTENT_NOT_SAVED: 'SNOOZE_INTENT_NOT_SAVED',
  SCHEDULE_FAILED: 'SNOOZE_SCHEDULE_FAILED',
  VERIFY_FAILED: 'SNOOZE_VERIFY_FAILED',
  PERSIST_FAILED: 'SNOOZE_PERSIST_FAILED',
};

type CleanupReport = { cleanup?: 'unconfirmed'; tracking?: 'memory_only' };

function isMemoryOnly(report: CleanupReport): boolean {
  return report.tracking === 'memory_only';
}

/**
 * Catalog code of a refused snooze. An attempt whose cancellation is unsure
 * gets its own code: the attempted notification may still exist, and whether
 * it is recorded durably or only held in memory is told apart.
 */
getSnoozeCopy.failureCode = (
  reason: SnoozeRejection,
  report: CleanupReport = {},
): ErrorCode => {
  if (report.cleanup !== 'unconfirmed') {
    return FAILURE_CODE[reason];
  }
  return isMemoryOnly(report)
    ? 'SNOOZE_CLEANUP_MEMORY_ONLY'
    : 'SNOOZE_CLEANUP_UNCONFIRMED';
};

getSnoozeCopy.failure = (
  reason: SnoozeRejection,
  messages: Messages,
  report: CleanupReport = {},
): string => noticeFromCodeIn(messages, getSnoozeCopy.failureCode(reason, report)).text;

/** Warning code when an accepted snooze left a cancellation unconfirmed. */
getSnoozeCopy.acceptedCleanupCode = (report: CleanupReport): ErrorCode | null => {
  if (report.cleanup !== 'unconfirmed') {
    return null;
  }
  return isMemoryOnly(report)
    ? 'SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY'
    : 'SNOOZE_ACCEPTED_CLEANUP_UNCONFIRMED';
};

/** Warning code when a durable stop left a cancellation unconfirmed. */
getSnoozeCopy.stopCleanupCode = (report: CleanupReport): ErrorCode | null => {
  if (report.cleanup !== 'unconfirmed') {
    return null;
  }
  return isMemoryOnly(report)
    ? 'STOP_CLEANUP_MEMORY_ONLY'
    : 'STOP_CLEANUP_UNCONFIRMED';
};

/**
 * A stop that failed changed nothing: the first write-ahead save is the only
 * failing step, and no notification was cancelled before it.
 */
getSnoozeCopy.stopFailureCode = (
  _reason: 'CANCEL_FAILED' | 'SAVE_FAILED',
): ErrorCode => 'STOP_SAVE_FAILED';

/** Notice code for the startup recovery pass, most severe state first. */
getSnoozeCopy.recoveryCode = (outcome: SnoozeRecoveryOutcome): ErrorCode | null => {
  if ((outcome.memoryOnly?.length ?? 0) > 0) {
    return 'SNOOZE_RECOVERY_MEMORY_ONLY';
  }
  if (outcome.rearmFailed.length > 0) {
    return 'SNOOZE_REARM_FAILED';
  }
  if (outcome.unresolved.length > 0) {
    return 'SNOOZE_RECOVERY_UNRESOLVED';
  }
  return null;
};
