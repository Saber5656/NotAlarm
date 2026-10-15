import { useCallback, useMemo, useRef } from 'react';
import { Alert } from 'react-native';

import { CONFIRM_AWAKE_ACTION } from '../alarmContracts';
import {
  processAwakeResponseFailSafe,
  processUserSkipFailSafe,
} from '../alarmOrchestrator';
import {
  type StoredAlarm,
  loadStoredAlarmByCycleId,
  saveStoredAlarm,
} from '../alarmStorage';
import {
  classifySuppressionFailure,
  describeAlarmRemains,
  type SuppressionWarningKind,
} from '../homeStatus';
import { noticeFromCodeIn, type TextContext } from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import {
  cancelNotificationIfPresent,
  cancelScheduledNotification,
  dismissDeliveredNotification,
  readAlarmNotificationData,
} from '../notificationService';
import {
  createSuppressionSaver,
  finishSuppression,
  type SuppressionCleanup,
} from '../suppressionFollowUp';
import { suppressionJournal } from '../suppressionJournalStorage';
import {
  captureUserSkipTarget,
  describeUserSkipConfirmation,
  type UserSkipTarget,
} from '../userSkip';
import type { NotificationResponse } from './platform/notificationEdge';
import { reconcileSuppressions } from './platform/coordinators';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
} from './types';

/**
 * Suppression by notification action and by an explicit in-app skip. Each path
 * has its own in-flight guard, persists through the journal and the epoch-safe
 * setter, and reports a half-done stop through the dedicated warning.
 */
export function useSuppressionResponses(input: {
  alarmsRef: AlarmsRef;
  textRef: { current: TextContext };
  skipCycleId: string | undefined;
  messagesNow: MessagesNow;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  setSuppressionWarning(warning: SuppressionWarningKind | null): void;
  refreshAfterCycleCompletion(
    completedCycle: StoredAlarm,
  ): Promise<'none' | 'warning' | 'danger'>;
}) {
  const {
    alarmsRef,
    textRef,
    skipCycleId,
    messagesNow,
    setNotice,
    setCurrentAlarms,
    setSuppressionWarning,
    refreshAfterCycleCompletion,
  } = input;
  const responseInFlightRef = useRef<string | null>(null);
  const skipInFlightRef = useRef(false);

  const suppressionCleanup = useMemo<SuppressionCleanup>(
    () => ({
      cancelCheckIn: cancelNotificationIfPresent,
      dismissDelivered: dismissDeliveredNotification,
      refill: refreshAfterCycleCompletion,
    }),
    [refreshAfterCycleCompletion],
  );

  const handleAwakeResponse = useCallback(
    async (response: NotificationResponse) => {
      if (response.actionIdentifier !== CONFIRM_AWAKE_ACTION) {
        return;
      }

      const data = readAlarmNotificationData(response);
      const responseKey = `${data?.cycleId ?? 'invalid'}:${
        response.notification.request.identifier
      }`;
      if (responseInFlightRef.current === responseKey) {
        return;
      }
      responseInFlightRef.current = responseKey;

      let suppressedConfirmed = false;
      try {
        const cycleId = data?.cycleId;
        const result = await processAwakeResponseFailSafe(
          {
            loadAlarm: () =>
              typeof cycleId === 'string'
                ? loadStoredAlarmByCycleId(cycleId)
                : Promise.resolve(null),
            saveAlarm: createSuppressionSaver(saveStoredAlarm, setCurrentAlarms),
            cancelScheduled: cancelScheduledNotification,
            journal: suppressionJournal,
          },
          {
            actionIdentifier: response.actionIdentifier,
            kind: data?.kind,
            cycleId: data?.cycleId,
            mainAlarmId: data?.mainAlarmId,
            checkInNotificationId:
              response.notification.request.identifier,
            confirmedAtMs: Date.now(),
          },
        );

        if (result.status === 'ignored') {
          return;
        }
        if (result.status === 'alarm_remains') {
          if (result.reason === 'SUPPRESSION_PENDING') {
            // An earlier stop for this cycle is half done: settle it.
            const reconciled = await reconcileSuppressions();
            setSuppressionWarning(
              reconciled.state === 'ok' ? null : reconciled.state,
            );
            return;
          }
          setNotice(describeAlarmRemains(result.reason, messagesNow()));
          return;
        }

        suppressedConfirmed = true;
        await finishSuppression(result.alarm, suppressionCleanup);
        setNotice({
          tone: 'success',
          text: messagesNow().checkIn.confirmed,
        });
      } catch (error) {
        const failure = classifySuppressionFailure(error, messagesNow());
        if (failure) {
          setSuppressionWarning(failure.warning);
          setNotice(failure.notice);
        } else if (suppressedConfirmed) {
          // The stop itself succeeded; only the follow-up failed.
          setNotice(noticeFromCodeIn(messagesNow(), 'SUPPRESSION_FOLLOWUP_FAILED'));
        } else {
          setNotice(noticeFromCodeIn(messagesNow(), 'CHECKIN_PROCESS_FAILED'));
        }
      } finally {
        responseInFlightRef.current = null;
      }
    },
    [setCurrentAlarms, suppressionCleanup],
  );

  // Explicit in-app skip of exactly one occurrence. The target is the
  // occurrence the dialog was opened for; a stale one is rejected, never
  // retargeted. Same suppression transaction, journal and locks as the others.
  const performUserSkip = useCallback(
    async (target: UserSkipTarget) => {
      if (skipInFlightRef.current) {
        return;
      }
      skipInFlightRef.current = true;
      let suppressedConfirmed = false;
      try {
        const result = await processUserSkipFailSafe(
          {
            loadAlarm: () => loadStoredAlarmByCycleId(target.cycleId),
            saveAlarm: createSuppressionSaver(saveStoredAlarm, setCurrentAlarms),
            cancelScheduled: cancelScheduledNotification,
            journal: suppressionJournal,
          },
          target,
        );
        if (result.status === 'alarm_remains') {
          if (result.reason === 'SUPPRESSION_PENDING') {
            const reconciled = await reconcileSuppressions();
            setSuppressionWarning(
              reconciled.state === 'ok' ? null : reconciled.state,
            );
            return;
          }
          setNotice(describeAlarmRemains(result.reason, messagesNow()));
          return;
        }
        if (result.status !== 'suppressed') {
          return;
        }
        suppressedConfirmed = true;
        await finishSuppression(result.alarm, suppressionCleanup);
        setNotice({
          tone: 'success',
          text: messagesNow().skip.done,
        });
      } catch (error) {
        const failure = classifySuppressionFailure(error, messagesNow());
        if (failure) {
          setSuppressionWarning(failure.warning);
          setNotice(failure.notice);
        } else if (suppressedConfirmed) {
          setNotice(
            localizedNotice(
              (t) => ({ tone: 'warning', text: t.messages.skip.stoppedRefillFailed }),
              textRef.current,
            ),
          );
        } else {
          setNotice(
            localizedNotice(
              (t) => ({ tone: 'danger', text: t.messages.skip.failed }),
              textRef.current,
            ),
          );
        }
      } finally {
        skipInFlightRef.current = false;
      }
    },
    [setCurrentAlarms, suppressionCleanup],
  );

  const confirmUserSkip = useCallback(() => {
    // Capture the occurrence now; the dialog confirms exactly this one.
    const target = captureUserSkipTarget(
      alarmsRef.current.flatMap((alarm) => alarm.cycles),
      skipCycleId,
      Date.now(),
    );
    if (!target) {
      setNotice(describeAlarmRemains('SKIP_BEFORE_WINDOW', messagesNow()));
      return;
    }
    const copy = describeUserSkipConfirmation(target, textRef.current);
    Alert.alert(copy.title, copy.body, [
      { text: copy.cancelLabel, style: 'cancel' },
      {
        text: copy.confirmLabel,
        style: 'destructive',
        onPress: () => void performUserSkip(target),
      },
    ]);
  }, [performUserSkip, skipCycleId]);

  return { suppressionCleanup, handleAwakeResponse, confirmUserSkip };
}
