import {
  recoverSuppressionJournal,
  type SuppressionRecoveryDependencies,
} from '../../alarmOrchestrator';
import type { StoredAlarm } from '../../alarmStorage';
import type { SuppressionWarningKind } from '../../homeStatus';

export interface SuppressionReconcileResult {
  /** 'ok' only when no half-finished suppression remains. */
  state: 'ok' | SuppressionWarningKind;
  recovered: number;
}

export interface SuppressionReconcilerDeps {
  journal: SuppressionRecoveryDependencies['journal'];
  loadAlarm(cycleId: string): Promise<StoredAlarm | null>;
  saveAlarm(cycle: StoredAlarm): Promise<void>;
  listScheduledIds: SuppressionRecoveryDependencies['listScheduledIds'];
  cancelCheckIn(notificationId: string | undefined): Promise<void>;
}

/**
 * Settles stops that were cancelled but not saved (restoring them) and
 * reports stops whose cancellation result is unknown. Never cancels anything
 * except the exact check-in id recorded for a recovered cycle. Concurrent
 * callers share one run.
 */
export function createSuppressionReconciler(
  deps: SuppressionReconcilerDeps,
): () => Promise<SuppressionReconcileResult> {
  let inFlight: Promise<SuppressionReconcileResult> | null = null;

  return function reconcileSuppressions() {
    if (inFlight) {
      return inFlight;
    }
    const run = (async (): Promise<SuppressionReconcileResult> => {
      try {
        const outcome = await recoverSuppressionJournal(
          {
            saveAlarm: deps.saveAlarm,
            journal: deps.journal,
            listScheduledIds: deps.listScheduledIds,
          },
          deps.loadAlarm,
        );
        for (const intent of outcome.recovered) {
          try {
            // The exact check-in id recorded for that cycle, nothing else.
            await deps.cancelCheckIn(intent.checkInNotificationId);
          } catch {
            // Best effort: the cycle itself is already suppressed.
          }
        }
        const state: SuppressionReconcileResult['state'] =
          outcome.saveFailed.length > 0
            ? 'save_failed'
            : outcome.unresolved.length > 0
              ? 'status_unknown'
              : 'ok';
        return { state, recovered: outcome.recovered.length };
      } catch {
        // The journal itself is unreadable: treat the state as unknown.
        return { state: 'status_unknown', recovered: 0 };
      }
    })().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
