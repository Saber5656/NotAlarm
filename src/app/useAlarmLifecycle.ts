import { useEffect } from 'react';
import { Platform } from 'react-native';

import { getSkippedRefillAttempt, type RefillAttempt } from '../alarmScheduling';
import {
  type StoredAlarmDefinition,
  markDueCyclesRinging,
} from '../alarmStorage';
import { AppError, type ErrorCode, errorCodeOf } from '../errorCatalog';
import type { SuppressionWarningKind } from '../homeStatus';
import { describeErrorIn, noticeFromCodeIn } from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import type { ReconciledState } from '../reconcileGate';
import {
  recoverPendingAlarmCancellations,
  recoverPendingAlarmEdits,
} from './platform/alarmServices';
import { subscribeAppState } from './platform/appStateEdge';
import { reconcileSuppressions } from './platform/coordinators';
import { storageReset } from './platform/gateways';
import type { ScheduleRefillTrigger } from './core/refillCoordinator';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
  TextRef,
} from './types';

export interface AlarmLifecycleInput {
  isLoaded: boolean;
  alarmsRef: AlarmsRef;
  messagesNow: MessagesNow;
  textRef: TextRef;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  setSuppressionWarning(warning: SuppressionWarningKind | null): void;
  setLoadFailed(failed: boolean): void;
  setLoadFailureCode(code: ErrorCode | null): void;
  setIsLoaded(loaded: boolean): void;
  setIsComposerOpen(open: boolean): void;
  recordRefill(attempt: RefillAttempt): void;
  recoverSnoozes(): Promise<void>;
  reconcileWithQueue(
    knownAlarms: StoredAlarmDefinition[],
    options?: { cancellationPending?: boolean },
  ): Promise<ReconciledState>;
  refillEnabledSchedules(
    trigger: ScheduleRefillTrigger,
    knownAlarms: readonly StoredAlarmDefinition[],
  ): Promise<StoredAlarmDefinition[] | null>;
  refreshNotificationDelivery(): Promise<void>;
}

/**
 * The launch sequence and the return-to-foreground sequence. The order is the
 * contract: a pending storage reset is checked first, then unfinished
 * cancellations and edits are settled, then half-done stops, then snoozes are
 * re-armed, then overdue cycles are classified, then the stored schedule is
 * compared with the OS queue, and only then may a refill add reservations.
 */
export function useAlarmLifecycle({
  isLoaded,
  alarmsRef,
  messagesNow,
  textRef,
  setNotice,
  setCurrentAlarms,
  setSuppressionWarning,
  setLoadFailed,
  setLoadFailureCode,
  setIsLoaded,
  setIsComposerOpen,
  recordRefill,
  recoverSnoozes,
  reconcileWithQueue,
  refillEnabledSchedules,
  refreshNotificationDelivery,
}: AlarmLifecycleInput): void {
  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        let cancellationRecoveryFailed = false;
        if (await storageReset.hasPendingReset()) {
          // An earlier reset stopped halfway: stay on the recovery card so the
          // user can finish it. Nothing is resumed automatically.
          throw new AppError('STORAGE_RESET_PENDING');
        }
        try {
          if ((await storageReset.readAmbiguousCount()) > 0 && mounted) {
            setNotice(
              localizedNotice(
                (t) => ({ tone: 'danger', text: t.messages.settings.ambiguousWarning }),
                textRef.current,
              ),
            );
          }
        } catch {
          // Advisory only; never blocks startup.
        }
        try {
          await recoverPendingAlarmCancellations();
        } catch {
          cancellationRecoveryFailed = true;
          if (mounted) {
            setNotice(noticeFromCodeIn(messagesNow(), 'CANCEL_RECOVERY_INCOMPLETE'));
          }
        }
        let editRecoveryFailed = false;
        try {
          await recoverPendingAlarmEdits();
        } catch (error) {
          editRecoveryFailed = true;
          if (mounted) {
            setNotice(describeErrorIn(messagesNow(), error, 'EDIT_CLEANUP_INCOMPLETE'));
          }
        }
        // Finish or report half-done stops before anything is marked due.
        const reconciled = await reconcileSuppressions();
        if (mounted) {
          setSuppressionWarning(
            reconciled.state === 'ok' ? null : reconciled.state,
          );
        }
        await recoverSnoozes();
        let restored = await markDueCyclesRinging(Date.now(), 'launch');

        // A refill adds reservations without reading the OS queue, so it only
        // follows a fresh, verified reconciliation; otherwise it waits for the
        // next launch or return to the app.
        let safeToRefill = !cancellationRecoveryFailed;
        if (Platform.OS !== 'web' && !cancellationRecoveryFailed) {
          // Compare with the OS queue before any refill adds new reservations.
          const state = await reconcileWithQueue(restored);
          if (state.freshness === 'fresh') {
            restored = state.alarms;
          }
          safeToRefill = state.safeToRefill;
        }

        if (
          Platform.OS !== 'web' &&
          restored.some((definition) => definition.enabled)
        ) {
          if (!safeToRefill || editRecoveryFailed) {
            // Startup does not refill until the stop and edit are finished.
            recordRefill(getSkippedRefillAttempt(restored));
          } else {
            restored =
              (await refillEnabledSchedules('startup', restored)) ?? restored;
          }
        }

        if (mounted) {
          setCurrentAlarms(restored);
          setIsComposerOpen(false);
        }
      } catch (error) {
        if (mounted) {
          // A persistent card explains this state; a banner would be lost
          // on the next tap.
          setLoadFailureCode(errorCodeOf(error, 'STORAGE_READ_FAILED'));
          setLoadFailed(true);
        }
      } finally {
        if (mounted) {
          setIsLoaded(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [
    reconcileWithQueue,
    recordRefill,
    recoverSnoozes,
    refillEnabledSchedules,
    setCurrentAlarms,
  ]);

  useEffect(() => {
    if (Platform.OS === 'web' || !isLoaded) {
      return;
    }

    void refreshNotificationDelivery();
    return subscribeAppState((state) => {
      if (state !== 'active') {
        return;
      }
      // Notifications can be turned off in Settings while the app is away.
      void refreshNotificationDelivery();
      // Occurrences stopped from a notification are only replaced while the
      // app runs, so returning to it tops the schedule back up.
      void (async () => {
        // An unfinished reset is checked before any recovery or refill.
        try {
          if (await storageReset.hasPendingReset()) {
            return;
          }
        } catch {
          return;
        }
        const reconciled = await reconcileSuppressions();
        setSuppressionWarning(
          reconciled.state === 'ok' ? null : reconciled.state,
        );
        await recoverSnoozes();
        try {
          // Cycles that came due while the app was away are classified here,
          // before the 1-second tick could treat them as freshly due.
          setCurrentAlarms(await markDueCyclesRinging(Date.now(), 'resume'));
        } catch {
          // Keep the in-memory list; the next load will show the result.
        }
        if (alarmsRef.current.some((alarm) => alarm.enabled)) {
          const state = await reconcileWithQueue(alarmsRef.current);
          if (state.freshness === 'fresh') {
            setCurrentAlarms(state.alarms);
          }
          if (state.safeToRefill) {
            const next = await refillEnabledSchedules(
              'foreground',
              state.alarms,
            );
            if (next) {
              setCurrentAlarms(next);
            }
          } else {
            recordRefill(getSkippedRefillAttempt(state.alarms));
          }
        }
      })();
    });
  }, [
    isLoaded,
    reconcileWithQueue,
    recordRefill,
    recoverSnoozes,
    refillEnabledSchedules,
    refreshNotificationDelivery,
    setCurrentAlarms,
  ]);
}
