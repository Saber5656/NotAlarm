import { useCallback } from 'react';

import type { AlarmScheduleIssue } from '../alarmScheduling';
import { stopForegroundAlarmSound } from '../alarmSound';
import {
  type StoredAlarm,
  loadAlarmDefinitions,
  mutateAlarmDefinitions,
} from '../alarmStorage';
import { noticeFromCodeIn, type TextContext } from '../i18n';
import {
  acknowledgeMissedAlarms,
  getMissedAcknowledgementNotice,
} from '../missedAcknowledgement';
import { acknowledgeMissedCycles, getMissedCycles } from '../missedAlarms';
import { dismissDeliveredNotification } from '../notificationService';
import { getSnoozeCopy } from '../snoozeCopy';
import {
  presentSnoozeRejected,
  presentSnoozed,
  presentStopped,
} from '../snoozeOutcome';
import { isStorageResetPendingError } from '../storageResetGate';
import { snoozeService } from './platform/gateways';
import type { MessagesNow, SetCurrentAlarms, SetNotice } from './types';

/**
 * Acting on a ringing, snoozed or missed occurrence: acknowledge what was
 * missed, stop, and snooze. Stop and snooze go through the shared snooze
 * service (one locked transaction), never through raw cancellation.
 */
export function useRingingActions(input: {
  isBusy: boolean;
  setIsBusy(busy: boolean): void;
  ringingCycle: StoredAlarm | null;
  missedCycles: StoredAlarm[];
  textRef: { current: TextContext };
  messagesNow: MessagesNow;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  setDeletionPending(pending: boolean): void;
  refreshAfterCycleCompletion(
    completedCycle: StoredAlarm,
    collectedIssues?: AlarmScheduleIssue[],
  ): Promise<'none' | 'warning' | 'danger'>;
}) {
  const {
    isBusy,
    setIsBusy,
    ringingCycle,
    missedCycles,
    textRef,
    messagesNow,
    setNotice,
    setCurrentAlarms,
    setDeletionPending,
    refreshAfterCycleCompletion,
  } = input;

  const acknowledgeMissed = useCallback(async () => {
    if (isBusy || missedCycles.length === 0) {
      return;
    }

    setIsBusy(true);
    const refillIssues: AlarmScheduleIssue[] = [];
    try {
      const result = await acknowledgeMissedAlarms(missedCycles, {
        persist: async (cycleIds) => {
          let changed: StoredAlarm[] = [];
          const next = await mutateAlarmDefinitions((current) => {
            const wanted = new Set(cycleIds);
            changed = getMissedCycles(current).filter((cycle) =>
              wanted.has(cycle.cycleId),
            );
            return acknowledgeMissedCycles(current, cycleIds);
          });
          setCurrentAlarms(next);
          return changed;
        },
        // Only each persisted cycle's own main, check-in and accepted snooze ids are dismissed.
        dismissDelivered: dismissDeliveredNotification,
        refill: (completed) => refreshAfterCycleCompletion(completed, refillIssues),
      });
      const ackNotice = getMissedAcknowledgementNotice(
        result,
        refillIssues,
        messagesNow(),
      );
      if (ackNotice) {
        setNotice(ackNotice);
      }
    } catch {
      setNotice(noticeFromCodeIn(messagesNow(), 'MISSED_ACK_FAILED'));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, missedCycles, refreshAfterCycleCompletion, setCurrentAlarms]);

  const outcomeEffects = useCallback(
    () => ({
      stopSound: stopForegroundAlarmSound,
      apply: setCurrentAlarms,
      reload: loadAlarmDefinitions,
      refill: async () => undefined,
      isResetPending: isStorageResetPendingError,
    }),
    [setCurrentAlarms],
  );

  const stopOccurrence = useCallback(
    async (cycle: StoredAlarm) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      // The stop is "applied" once the service reports it; only then is a
      // later failure a failed refill rather than a failed stop.
      let stoppedCycle: StoredAlarm | null = null;
      try {
        // Also cancels a waiting snooze, so nothing rings after the stop.
        const result = await snoozeService.stop(cycle.cycleId);
        if (result.status !== 'stopped') {
          setNotice(
            noticeFromCodeIn(messagesNow(),
              result.status === 'failed'
                ? getSnoozeCopy.stopFailureCode(result.reason)
                : 'STOP_ALREADY_ENDED',
            ),
          );
          return;
        }
        stoppedCycle = result.cycle;
        // Sound, then the committed snapshot, then the fallible refill: a later
        // failure can neither leave the ringing card up nor hide a cleanup warning.
        const presented = await presentStopped(
          result,
          {
            ...outcomeEffects(),
            refill: refreshAfterCycleCompletion,
          },
          textRef.current,
        );
        if (presented.deletionPending) {
          setDeletionPending(true);
        }
        setNotice(presented.notice);
      } catch (error) {
        if (isStorageResetPendingError(error) && !stoppedCycle) {
          // Fail-safe: the sound and the delivered notification are stopped
          // here, but the stop is not written while a deletion is unfinished,
          // so no old alarm record is brought back. The retried deletion
          // cancels every notification, a waiting snooze's included.
          stopForegroundAlarmSound();
          await dismissDeliveredNotification(cycle.mainAlarmId).catch(
            () => undefined,
          );
          setDeletionPending(true);
          setNotice(noticeFromCodeIn(messagesNow(), 'STOP_RESET_PENDING'));
        } else if (stoppedCycle) {
          if (isStorageResetPendingError(error)) {
            setDeletionPending(true);
          }
          // The stop is saved; only reading back or refilling failed.
          setNotice(noticeFromCodeIn(messagesNow(), 'STOP_FOLLOWUP_FAILED'));
        } else {
          setNotice(noticeFromCodeIn(messagesNow(), 'STOP_RINGING_FAILED'));
        }
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, outcomeEffects, refreshAfterCycleCompletion],
  );

  const stopRinging = useCallback(async () => {
    if (ringingCycle) {
      await stopOccurrence(ringingCycle);
    }
  }, [ringingCycle, stopOccurrence]);

  const snoozeRinging = useCallback(async () => {
    if (!ringingCycle || isBusy) {
      return;
    }

    setIsBusy(true);
    try {
      // The next occurrence that bounds a snooze is read inside the service's
      // transaction, from the latest stored state.
      const result = await snoozeService.snooze(ringingCycle.cycleId);
      if (result.status === 'snoozed') {
        // Sound and the committed snapshot first: nothing fallible runs
        // between the accepted snooze and the screen showing it.
        setNotice(await presentSnoozed(result, outcomeEffects(), textRef.current));
        return;
      }
      // Rejected: the alarm keeps ringing and stored state is the truth; reading
      // it is best effort and never turns the rejection into another failure.
      setNotice(await presentSnoozeRejected(result, outcomeEffects(), textRef.current));
    } catch (error) {
      if (isStorageResetPendingError(error)) {
        // Nothing was scheduled or written; the alarm keeps ringing.
        setDeletionPending(true);
        setNotice(noticeFromCodeIn(messagesNow(), 'SNOOZE_RESET_PENDING'));
      } else {
        setNotice(noticeFromCodeIn(messagesNow(), 'SNOOZE_UNEXPECTED_FAILURE'));
      }
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, outcomeEffects, ringingCycle]);

  return { acknowledgeMissed, stopOccurrence, stopRinging, snoozeRinging };
}
