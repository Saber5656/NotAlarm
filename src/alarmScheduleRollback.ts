import type { StoredAlarm } from './alarmStorage';
import { describeErrorCode, type ErrorCode } from './errorCatalog';

export interface ScheduledNotificationRollbackGateway {
  cancelScheduled(notificationId: string | undefined): Promise<void>;
}

export type TrackScheduledCycles = (cycles: readonly StoredAlarm[]) => void;

export interface ScheduledNotificationRollbackFailure {
  notificationId: string;
  code: ErrorCode;
}

/** Durable list of notification ids a later pass must cancel. */
export interface RollbackFailureRecorder {
  add(ids: string[]): Promise<void>;
}

/** Settles the journal records kept for ids that were verified but not yet stored. */
export interface ProvisionalSettlement {
  releaseProvisional(mainIds: readonly string[]): Promise<void>;
  abandonProvisional(mainIds?: readonly string[]): void;
}

function mainIdsOf(cycles: readonly StoredAlarm[]): string[] {
  return cycles
    .map((cycle) => cycle.mainAlarmId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export class ScheduledNotificationRollbackError extends Error {
  readonly code: 'ROLLBACK_INCOMPLETE' | 'ROLLBACK_INCOMPLETE_RECORDED';
  readonly failures: ScheduledNotificationRollbackFailure[];
  readonly originalError: unknown;
  /**
   * True only when every failed id was written to the durable record. When
   * false the ids exist in memory alone and no later launch will find them.
   */
  readonly recorded: boolean;

  constructor(
    originalError: unknown,
    failures: ScheduledNotificationRollbackFailure[],
    recorded = false,
  ) {
    const code = recorded ? 'ROLLBACK_INCOMPLETE_RECORDED' : 'ROLLBACK_INCOMPLETE';
    super(describeErrorCode(code).message);
    this.name = 'ScheduledNotificationRollbackError';
    this.code = code;
    this.failures = failures;
    this.originalError = originalError;
    this.recorded = recorded;
  }
}

/**
 * Writes the ids that could not be cancelled to the durable record. Resolves
 * true only if the write succeeded.
 */
export async function recordRollbackFailures(
  failures: readonly ScheduledNotificationRollbackFailure[],
  recorder: RollbackFailureRecorder | undefined,
): Promise<boolean> {
  if (!recorder || failures.length === 0) {
    return false;
  }
  try {
    await recorder.add(failures.map((failure) => failure.notificationId));
    return true;
  } catch {
    return false;
  }
}

export async function rollbackScheduledCycles(
  cycles: readonly StoredAlarm[],
  gateway: ScheduledNotificationRollbackGateway,
): Promise<ScheduledNotificationRollbackFailure[]> {
  const ids = [
    ...new Set(
      cycles.flatMap((cycle) =>
        [cycle.checkInNotificationId, cycle.mainAlarmId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ),
  ];
  const failures: ScheduledNotificationRollbackFailure[] = [];

  for (const notificationId of ids) {
    try {
      await gateway.cancelScheduled(notificationId);
    } catch {
      failures.push({
        notificationId,
        code: 'NOTIFICATION_CANCEL_UNVERIFIED',
      });
    }
  }

  return failures;
}

export async function withScheduledNotificationRollback<T>(
  operation: (track: TrackScheduledCycles) => Promise<T>,
  gateway: ScheduledNotificationRollbackGateway,
  recorder?: RollbackFailureRecorder,
  settlement?: ProvisionalSettlement,
): Promise<T> {
  const scheduledCycles: StoredAlarm[] = [];
  const track: TrackScheduledCycles = (cycles) => {
    scheduledCycles.push(...cycles);
  };

  try {
    const result = await operation(track);
    // The operation (and its definition checkpoint) completed: the cycles own
    // their ids now, so only these records are dropped.
    await settlement?.releaseProvisional(mainIdsOf(scheduledCycles));
    return result;
  } catch (error) {
    const failures = await rollbackScheduledCycles(scheduledCycles, gateway);
    if (settlement) {
      const failed = new Set(failures.map((failure) => failure.notificationId));
      const mainIds = mainIdsOf(scheduledCycles);
      // Settle only this operation's registrations. Another operation may
      // already have a verified registration awaiting its own checkpoint.
      await settlement.releaseProvisional(mainIds.filter((id) => !failed.has(id)));
      settlement.abandonProvisional(mainIds);
    }
    if (failures.length > 0) {
      throw new ScheduledNotificationRollbackError(
        error,
        failures,
        await recordRollbackFailures(failures, recorder),
      );
    }
    throw error;
  }
}
