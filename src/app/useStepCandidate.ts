import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { processStepThresholdFailSafe } from '../alarmOrchestrator';
import { classifyStepEvidence } from '../alarmPolicy';
import { getNextMonitoringCycle } from '../alarmScheduling';
import {
  type StoredAlarm,
  loadStoredAlarmByCycleId,
  saveMonitoringCycleStepCount,
  saveStoredAlarm,
} from '../alarmStorage';
import {
  classifySuppressionFailure,
  type PedometerState,
  type SuppressionWarningKind,
} from '../homeStatus';
import { noticeFromCodeIn } from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import { isForegroundAppState } from '../bedsideMode';
import { cancelScheduledNotification } from '../notificationService';
import { resolvePedometerAccess } from '../pedometerAccess';
import { getWindowStepCount, type StepWindow } from '../stepWindow';
import {
  createSuppressionSaver,
  finishSuppression,
  type SuppressionCleanup,
} from '../suppressionFollowUp';
import { suppressionJournal } from '../suppressionJournalStorage';
import { subscribeAppState } from './platform/appStateEdge';
import { reconcileSuppressions } from './platform/coordinators';
import type { PedometerEdge } from './platform/pedometerEdge';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
  TextRef,
} from './types';

export interface StepCandidateInput {
  /** Steps are watched only inside the pre-alarm window and on screen. */
  isWatchingSteps: boolean;
  monitoringCycle: StoredAlarm | null;
  stepWindow: StepWindow | null;
  alarmsRef: AlarmsRef;
  pedometer: PedometerEdge;
  suppressionCleanup: SuppressionCleanup;
  messagesNow: MessagesNow;
  textRef: TextRef;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  setSuppressionWarning(warning: SuppressionWarningKind | null): void;
}

/**
 * Pedometer lifecycle for the occurrence being monitored. Owns the pedometer
 * state and the step-suppression in-flight guard; a reached threshold goes
 * through the same journaled suppression as a notification confirmation.
 */
export function useStepCandidate({
  isWatchingSteps,
  monitoringCycle,
  stepWindow,
  alarmsRef,
  pedometer,
  suppressionCleanup,
  messagesNow,
  textRef,
  setNotice,
  setCurrentAlarms,
  setSuppressionWarning,
}: StepCandidateInput): { pedometerState: PedometerState } {
  const [pedometerState, setPedometerState] = useState<PedometerState>(
    Platform.OS === 'web' ? 'unavailable' : 'preparing',
  );
  const stepSuppressionInFlightRef = useRef(false);

  useEffect(() => {
    // Steps only count inside the hour before the alarm and while the app is
    // on screen, so nothing is subscribed or counted otherwise.
    if (!isWatchingSteps || !monitoringCycle || !stepWindow) {
      return;
    }

    let disposed = false;
    let subscription: ReturnType<PedometerEdge['watch']> | undefined;
    const countedFromMs = stepWindow.startMs;
    const stopWatching = () => {
      disposed = true;
      subscription?.remove();
      subscription = undefined;
    };
    // On iOS, expo-sensors resumes updates from the original start when the
    // app returns, which would add steps walked while it was away. Stop as
    // soon as the app leaves the screen; the effect then restarts from the
    // saved count of this window when the app is back on screen.
    const unsubscribeAppState = subscribeAppState((state) => {
      if (!isForegroundAppState(state)) {
        stopWatching();
      }
    });

    const evaluateSteps = (steps: number) => {
      if (disposed) {
        return;
      }
      const observedAtMs = Date.now();
      const current = getNextMonitoringCycle(alarmsRef.current, observedAtMs);
      if (!current || current.cycleId !== monitoringCycle.cycleId) {
        return;
      }

      const evidence = classifyStepEvidence(
        steps,
        observedAtMs,
        countedFromMs,
      );
      if (evidence.kind === 'ERROR') {
        setPedometerState('error');
        return;
      }
      // The subscription is alive and producing valid counts again.
      setPedometerState('counting');

      if (evidence.kind === 'STEP_THRESHOLD_REACHED') {
        if (stepSuppressionInFlightRef.current) {
          return;
        }
        stepSuppressionInFlightRef.current = true;
        let suppressedConfirmed = false;

        void processStepThresholdFailSafe(
          {
            loadAlarm: () => loadStoredAlarmByCycleId(current.cycleId),
            saveAlarm: createSuppressionSaver(saveStoredAlarm, setCurrentAlarms),
            cancelScheduled: cancelScheduledNotification,
            journal: suppressionJournal,
          },
          {
            steps: evidence.steps,
            observedAtMs: evidence.observedAtMs,
            countedFromMs,
          },
        )
          .then(async (result) => {
            if (
              result.status === 'alarm_remains' &&
              result.reason === 'SUPPRESSION_PENDING'
            ) {
              const reconciled = await reconcileSuppressions();
              setSuppressionWarning(
                reconciled.state === 'ok' ? null : reconciled.state,
              );
              return;
            }
            if (result.status === 'suppressed') {
              suppressedConfirmed = true;
              await finishSuppression(result.alarm, suppressionCleanup);
              setPedometerState('counting');
              setNotice({
                tone: 'success',
                text: messagesNow().checkIn.stepsDetected,
              });
              return;
            }

            const progress = await saveMonitoringCycleStepCount(
              current.alarmId,
              current.cycleId,
              evidence.steps,
              countedFromMs,
            );
            setCurrentAlarms(progress.alarms);
            if (progress.status !== 'updated') {
              return;
            }
            setNotice(
              localizedNotice(
                (t) => ({
                  ...noticeFromCodeIn(t.messages, 'CANCEL_NOT_VERIFIED'),
                  text: t.messages.checkIn.stepsCancelUnconfirmed,
                }),
                textRef.current,
              ),
            );
          })
          .catch((error: unknown) => {
            const failure = classifySuppressionFailure(error, messagesNow());
            if (failure) {
              setSuppressionWarning(failure.warning);
              setNotice(failure.notice);
            } else if (suppressedConfirmed) {
              setNotice(noticeFromCodeIn(messagesNow(), 'SUPPRESSION_FOLLOWUP_FAILED'));
            } else {
              setNotice(noticeFromCodeIn(messagesNow(), 'STEP_PROCESS_FAILED'));
            }
          })
          .finally(() => {
            stepSuppressionInFlightRef.current = false;
          });
        return;
      }

      void saveMonitoringCycleStepCount(
        current.alarmId,
        current.cycleId,
        evidence.steps,
        countedFromMs,
      )
        .then(({ alarms: next }) => {
          setCurrentAlarms(next);
          setPedometerState('counting');
        })
        .catch(() => {
          setPedometerState('error');
        });
    };

    // Clears any status left over from a previous cycle.
    setPedometerState('preparing');
    void (async () => {
      try {
        const access = await resolvePedometerAccess(pedometer);
        if (disposed) {
          return;
        }
        if (access !== 'ready') {
          setPedometerState(access);
          return;
        }

        // Only the saved count of this window plus steps observed while the
        // app is on screen count. Step history recorded while the app was
        // closed is never added.
        const baseSteps = getWindowStepCount(monitoringCycle, stepWindow);
        if (disposed) {
          return;
        }

        setPedometerState('counting');
        evaluateSteps(baseSteps);
        subscription = pedometer.watch((steps) => {
          evaluateSteps(baseSteps + steps);
        });
      } catch {
        if (!disposed) {
          setPedometerState('error');
        }
      }
    })();

    return () => {
      stopWatching();
      unsubscribeAppState();
    };
  }, [
    isWatchingSteps,
    monitoringCycle?.cycleId,
    stepWindow?.startMs,
    suppressionCleanup,
    setCurrentAlarms,
  ]);

  return { pedometerState };
}
