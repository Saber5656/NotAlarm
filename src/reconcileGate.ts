import type { StoredAlarmDefinition } from './alarmStorage';
import type { AlarmQueueStatus } from './scheduleReconciliation';
import { isStaleStorageResult } from './storageResetGate';

export interface ScheduleReconcileResult {
  /** The saved alarms, or null when they could not be read back. */
  alarms: StoredAlarmDefinition[] | null;
  statuses: Record<string, AlarmQueueStatus>;
  repaired: number;
  replanned: number;
  zoneChanged: boolean;
  /** Scheduled ids a failed save could not keep or cancel (still tracked). */
  unrecoveredNotificationIds: string[];
  /** The run threw part way; its in-memory result was not trusted. */
  aborted: boolean;
  /** The OS queue was read, so every status above rests on a real snapshot. */
  queueVerified: boolean;
  /** The orphan journal could not be read, so leftover ids are unknown. */
  orphansUnreadable: boolean;
  /** Scheduled ids still pending in the OS: cancellation is unconfirmed. */
  pendingOrphanIds?: string[];
}

export type RefillBlockReason =
  | 'not_run'
  | 'reload_failed'
  | 'aborted'
  | 'unrecovered_notifications'
  | 'queue_unverified'
  | 'orphans_unreadable'
  | 'orphans_pending'
  | 'cancellation_pending'
  | 'storage_reset';

export interface ReconciledState {
  /** skipped: no reconciliation ran (web). fresh: durable state. stale: not. */
  freshness: 'skipped' | 'fresh' | 'stale';
  /** Best known alarms; for `stale` they are for display only. */
  alarms: StoredAlarmDefinition[];
  safeToRefill: boolean;
  reason?: RefillBlockReason;
}

/**
 * True when the result was read before a deletion that has since finished: its
 * alarms, statuses and warnings describe data that no longer exists.
 */
export function isObsoleteReconcileResult(
  result: ScheduleReconcileResult | null,
): boolean {
  return (
    result !== null &&
    result.alarms !== null &&
    isStaleStorageResult(result.alarms)
  );
}

/**
 * Decides whether new reservations may be added after a reconciliation. A
 * refill reads neither the OS queue nor the orphan list, so it is only safe
 * from a durable snapshot, a readable queue and no unresolved scheduled ids.
 * Otherwise it waits for the next valid reconciliation (next launch/return).
 */
export function assessReconciledState(
  result: ScheduleReconcileResult | null,
  knownAlarms: StoredAlarmDefinition[],
  options: { cancellationPending?: boolean } = {},
): ReconciledState {
  if (!result) {
    return {
      freshness: 'skipped',
      alarms: knownAlarms,
      safeToRefill: false,
      reason: 'not_run',
    };
  }
  if (isObsoleteReconcileResult(result)) {
    return {
      freshness: 'stale',
      alarms: knownAlarms,
      safeToRefill: false,
      reason: 'storage_reset',
    };
  }
  if (result.alarms === null) {
    return {
      freshness: 'stale',
      alarms: knownAlarms,
      safeToRefill: false,
      reason: 'reload_failed',
    };
  }
  const block = (reason: RefillBlockReason): ReconciledState => ({
    freshness: 'fresh',
    alarms: result.alarms!,
    safeToRefill: false,
    reason,
  });
  if (options.cancellationPending) {
    return block('cancellation_pending');
  }
  if (result.aborted) {
    return block('aborted');
  }
  if (result.unrecoveredNotificationIds.length > 0) {
    return block('unrecovered_notifications');
  }
  if (result.orphansUnreadable) {
    return block('orphans_unreadable');
  }
  if ((result.pendingOrphanIds ?? []).length > 0) {
    return block('orphans_pending');
  }
  if (!result.queueVerified) {
    return block('queue_unverified');
  }
  return { freshness: 'fresh', alarms: result.alarms, safeToRefill: true };
}
