import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { StoredAlarmDefinition } from '../alarmStorage';
import { getCircadianTheme } from '../circadianTheme';
import type { ErrorCode } from '../errorCatalog';
import type { SuppressionWarningKind } from '../homeStatus';
import { noticeFromCodeIn } from '../i18n';
import {
  isStaleStorageResult,
  isStorageResetPendingError,
} from '../storageResetGate';
import { useSunBackground } from '../useSunBackground';
import { buildHomeView } from './core/homeView';
import { pedometerEdge } from './platform/pedometerEdge';
import { sunStorageCoordination } from './platform/gateways';
import type { Notice } from './types';
import { useAlarmLifecycle } from './useAlarmLifecycle';
import { useAlarmMutations } from './useAlarmMutations';
import { useAlarmView } from './useAlarmView';
import { useBedsideAwake } from './useBedsideAwake';
import { useClockTick } from './useClockTick';
import { useComposerForm } from './useComposerForm';
import { useDeviceText } from './useDeviceText';
import { useLocalDataDeletion } from './useLocalDataDeletion';
import { useNotificationDelivery } from './useNotificationDelivery';
import { useNotificationEvents } from './useNotificationEvents';
import { useRingingActions } from './useRingingActions';
import { useRingingPresentation } from './useRingingPresentation';
import { useScheduleCoordination } from './useScheduleCoordination';
import { useStepCandidate } from './useStepCandidate';
import { useSuppressionResponses } from './useSuppressionResponses';

/**
 * The one owner of the alarm list and of the state every screen shares: the
 * list and its ref, loading, busy, notice, deletion and suppression flags.
 * Each responsibility lives in its own hook and receives exactly the state and
 * setters it needs; none of them keeps a second copy of the alarm list. The
 * hooks are called in the order their effects must register.
 */
export function useAlarmController() {
  const [nowMs, setNowMs] = useState(Date.now());
  const localMinuteKey = Math.floor(nowMs / 60_000);
  const sun = useSunBackground(nowMs, sunStorageCoordination);
  const circadianTheme = useMemo(
    () => getCircadianTheme(new Date(nowMs), sun.schedule),
    [localMinuteKey, sun.schedule],
  );

  const [notice, setNotice] = useState<Notice | null>(null);
  const { text, textRef, messagesNow } = useDeviceText(setNotice);
  const { messages } = text;

  const [alarms, setAlarms] = useState<StoredAlarmDefinition[]>([]);
  const alarmsRef = useRef<StoredAlarmDefinition[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  // Saved alarms could not be read: this is not the same as having none.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadFailureCode, setLoadFailureCode] = useState<ErrorCode | null>(
    null,
  );
  const [deletionPending, setDeletionPending] = useState(false);
  // A stop whose cancel/save outcome is not fully known; persistent.
  const [suppressionWarning, setSuppressionWarning] =
    useState<SuppressionWarningKind | null>(null);

  const setCurrentAlarms = useCallback((next: StoredAlarmDefinition[]) => {
    // A result read before a finished deletion would bring deleted alarms
    // back on screen (stale Alert closure, in-flight refill or tick).
    if (isStaleStorageResult(next)) {
      return;
    }
    alarmsRef.current = next;
    setAlarms(next);
  }, []);

  // An alarm write was refused because a deletion is unfinished: keep the
  // list as it is (never reload stale or half-removed data) and say why.
  const reportResetPending = useCallback((error: unknown): boolean => {
    if (!isStorageResetPendingError(error)) {
      return false;
    }
    setDeletionPending(true);
    setNotice(noticeFromCodeIn(messagesNow(), 'STORAGE_RESET_PENDING'));
    return true;
  }, []);

  const delivery = useNotificationDelivery(messagesNow, setNotice);
  const schedule = useScheduleCoordination({
    messagesNow,
    textRef,
    setNotice,
    setCurrentAlarms,
  });
  const composer = useComposerForm(notice, setNotice);

  useAlarmLifecycle({
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
    setIsComposerOpen: composer.setIsComposerOpen,
    recordRefill: schedule.recordRefill,
    recoverSnoozes: schedule.recoverSnoozes,
    reconcileWithQueue: schedule.reconcileWithQueue,
    refillEnabledSchedules: schedule.refillEnabledSchedules,
    refreshNotificationDelivery: delivery.refreshNotificationDelivery,
  });

  const bedside = useBedsideAwake({
    alarms,
    nowMs,
    notificationDelivery: delivery.notificationDelivery,
    messages,
    textRef,
    setNotice,
  });

  const alarmView = useAlarmView({
    alarms,
    nowMs,
    isAppForeground: bedside.isAppForeground,
  });
  const { ringingCycle, missedCycles, monitoringCycle } = alarmView;

  const presentation = useRingingPresentation({
    ringingCycle,
    missedCycles,
    isComposerOpen: composer.isComposerOpen,
    isAppActive: bedside.isAppActive,
    closeComposerForRinging: composer.closeComposerForRinging,
    messagesNow,
    setNotice,
  });

  const suppression = useSuppressionResponses({
    alarmsRef,
    textRef,
    skipCycleId: alarmView.skipOffer?.cycleId,
    messagesNow,
    setNotice,
    setCurrentAlarms,
    setSuppressionWarning,
    refreshAfterCycleCompletion: schedule.refreshAfterCycleCompletion,
  });

  useNotificationEvents({
    isLoaded,
    handleAwakeResponse: suppression.handleAwakeResponse,
    reportResetPending,
    messagesNow,
    textRef,
    setNotice,
    setCurrentAlarms,
  });

  useClockTick({
    alarmsRef,
    setNowMs,
    setDeletionPending,
    messagesNow,
    setNotice,
    setCurrentAlarms,
  });

  const { pedometerState } = useStepCandidate({
    isWatchingSteps: alarmView.isWatchingSteps,
    monitoringCycle,
    stepWindow: alarmView.stepWindow,
    alarmsRef,
    pedometer: pedometerEdge,
    suppressionCleanup: suppression.suppressionCleanup,
    messagesNow,
    textRef,
    setNotice,
    setCurrentAlarms,
    setSuppressionWarning,
  });

  const mutations = useAlarmMutations({
    alarmsRef,
    text,
    textRef,
    messagesNow,
    isBusy,
    setIsBusy,
    deletionPending,
    composer,
    setNotice,
    setCurrentAlarms,
    reportResetPending,
    recordRefill: schedule.recordRefill,
    clearQueueStatus: schedule.clearQueueStatus,
    refreshNotificationDelivery: delivery.refreshNotificationDelivery,
  });

  const ringingActions = useRingingActions({
    isBusy,
    setIsBusy,
    ringingCycle,
    missedCycles,
    textRef,
    messagesNow,
    setNotice,
    setCurrentAlarms,
    setDeletionPending,
    refreshAfterCycleCompletion: schedule.refreshAfterCycleCompletion,
  });

  const deletion = useLocalDataDeletion({
    alarmsRef,
    messages,
    messagesNow,
    textRef,
    isBusy,
    setIsBusy,
    isLoaded,
    loadFailed,
    ringingCycle,
    sun,
    setNotice,
    setCurrentAlarms,
    setLoadFailed,
    setLoadFailureCode,
    setDeletionPending,
    setSuppressionWarning,
    forgetDeletedAlarms: schedule.forgetDeletedAlarms,
  });

  const view = buildHomeView({
    text,
    alarms,
    nowMs,
    isWeb: Platform.OS === 'web',
    isLoaded,
    isBusy,
    loadFailed,
    deletionPending,
    isComposerOpen: composer.isComposerOpen,
    notice,
    ringingCycle,
    snoozedCycle: alarmView.snoozedCycle,
    monitoringCycle,
    stepWindow: alarmView.stepWindow,
    notificationDelivery: delivery.notificationDelivery,
    pedometerState,
    suppressionWarning,
    editingAlarmId: composer.editingAlarmId,
    selectedTime: composer.selectedTime,
    repeatKind: composer.repeatKind,
    customWeekdays: composer.customWeekdays,
  });

  return {
    text,
    circadianTheme,
    isLoaded,
    nowMs,
    alarms,
    isBusy,
    notice,
    dismissNotice: () => setNotice(null),
    loadFailed,
    loadFailureCode,
    deletionPending,
    ...alarmView,
    refillFailedAlarmIds: schedule.refillFailedAlarmIds,
    queueStatuses: schedule.queueStatuses,
    bedsideGuidance: bedside.bedsideGuidance,
    stopButtonRef: presentation.stopButtonRef,
    view,
    homeActions: {
      openSettings: deletion.openSettings,
      openAddComposer: composer.openAddComposer,
      openNotificationSettings: delivery.openNotificationSettings,
      confirmUserSkip: suppression.confirmUserSkip,
      stopOccurrence: ringingActions.stopOccurrence,
      stopRinging: ringingActions.stopRinging,
      snoozeRinging: ringingActions.snoozeRinging,
      acknowledgeMissed: ringingActions.acknowledgeMissed,
      confirmStorageReset: deletion.confirmStorageReset,
      toggleAlarm: mutations.toggleAlarm,
      openEditComposer: mutations.openEditComposer,
      confirmDeleteAlarm: mutations.confirmDeleteAlarm,
    },
    settings: {
      isOpen: deletion.isSettingsOpen,
      notice: deletion.settingsNotice,
      sun,
      close: deletion.closeSettings,
      confirmLocalDataDeletion: deletion.confirmLocalDataDeletion,
    },
    composer: {
      isOpen: composer.isComposerOpen,
      customWeekdays: composer.customWeekdays,
      repeatKind: composer.repeatKind,
      selectedTime: composer.selectedTime,
      setRepeatKind: composer.setRepeatKind,
      setSelectedTime: composer.setSelectedTime,
      toggleCustomWeekday: composer.toggleCustomWeekday,
      close: composer.closeComposer,
      onDismissed: presentation.handleComposerDismissed,
      submit: () =>
        void (view.editingDefinition
          ? mutations.editAlarm(view.editingDefinition.id)
          : mutations.addAlarm()),
    },
  };
}

export type AlarmController = ReturnType<typeof useAlarmController>;
