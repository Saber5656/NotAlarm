import { MAX_ALARM_COUNT, type RepeatKind, type Weekday } from '../../alarmSchedule';
import type { StoredAlarm, StoredAlarmDefinition } from '../../alarmStorage';
import {
  canEditAlarm,
  canSubmitComposer,
  describeSuppressedOccurrence,
  getStepGuidance,
  getSuppressionWarningCopy,
  isAlarmListLocked,
  summarizeNewAlarm,
  type PedometerState,
  type SuppressionWarningKind,
} from '../../homeStatus';
import type { TextContext } from '../../i18n';
import { getLocalDataDeletionAvailability } from '../../localDataDeletion';
import {
  type NotificationDeliveryState,
  getNotificationDeliveryWarningCopy,
  shouldWarnNotificationDelivery,
} from '../../notificationDelivery';
import { getWindowStepCount, type StepWindow } from '../../stepWindow';
import type { Notice } from '../types';

/**
 * Everything the home screen, settings sheet and composer show that is a plain
 * function of the current state. Pure: no storage, notification or React
 * Native access, so a screen can render it without owning any service.
 */
export interface HomeViewInput {
  text: TextContext;
  alarms: StoredAlarmDefinition[];
  nowMs: number;
  isWeb: boolean;
  isLoaded: boolean;
  isBusy: boolean;
  loadFailed: boolean;
  deletionPending: boolean;
  isComposerOpen: boolean;
  notice: Notice | null;
  ringingCycle: StoredAlarm | null;
  snoozedCycle: StoredAlarm | null;
  monitoringCycle: StoredAlarm | null;
  stepWindow: StepWindow | null;
  notificationDelivery: NotificationDeliveryState | null;
  pedometerState: PedometerState;
  suppressionWarning: SuppressionWarningKind | null;
  editingAlarmId: string | null;
  selectedTime: Date;
  repeatKind: RepeatKind;
  customWeekdays: Weekday[];
}

export function buildHomeView(input: HomeViewInput) {
  const {
    text,
    alarms,
    nowMs,
    isWeb,
    isLoaded,
    isBusy,
    loadFailed,
    deletionPending,
    isComposerOpen,
    notice,
    ringingCycle,
    snoozedCycle,
    monitoringCycle,
    stepWindow,
    notificationDelivery,
    pedometerState,
    suppressionWarning,
    editingAlarmId,
    selectedTime,
    repeatKind,
    customWeekdays,
  } = input;
  const { messages, formatter } = text;

  const monitoringDefinition = monitoringCycle
    ? alarms.find((alarm) => alarm.id === monitoringCycle.alarmId)
    : undefined;
  const windowStepCount =
    monitoringCycle && stepWindow
      ? getWindowStepCount(monitoringCycle, stepWindow)
      : 0;
  const stepWindowStartLabel = stepWindow
    ? formatter.clockAt(stepWindow.startMs)
    : '';
  const deliveryWarning =
    notificationDelivery &&
    notificationDelivery !== 'ok' &&
    shouldWarnNotificationDelivery(notificationDelivery, alarms)
      ? notificationDelivery
      : null;
  const deliveryWarningCopy = deliveryWarning
    ? getNotificationDeliveryWarningCopy(
        deliveryWarning,
        monitoringCycle
          ? `${formatter.day(monitoringCycle.dueAtMs)} ${formatter.clockAt(
              monitoringCycle.dueAtMs,
            )}`
          : null,
        messages,
      )
    : null;
  const listLocked = isAlarmListLocked(ringingCycle ?? snoozedCycle);
  const suppressedOccurrence = describeSuppressedOccurrence(alarms, nowMs, text);
  const suppressionCopy = suppressionWarning
    ? getSuppressionWarningCopy(suppressionWarning, messages)
    : null;
  const stepGuidance = getStepGuidance(pedometerState, messages);

  const canOpenComposer =
    !ringingCycle &&
    !loadFailed &&
    !deletionPending &&
    alarms.length < MAX_ALARM_COUNT &&
    !isBusy;
  const deletionAvailability = getLocalDataDeletionAvailability(
    {
      isRinging: ringingCycle !== null,
      isBusy,
      isLoaded,
    },
    messages,
  );
  const editingDefinition = editingAlarmId
    ? alarms.find((alarm) => alarm.id === editingAlarmId)
    : undefined;
  const isEditing = editingDefinition !== undefined;
  const newAlarmSummary = summarizeNewAlarm({
    existingRepeat: editingDefinition?.repeat,
    enabled: editingDefinition?.enabled,
    nowMs,
    hour: selectedTime.getHours(),
    minute: selectedTime.getMinutes(),
    repeatKind,
    customWeekdays,
    text,
  });
  const editAvailable = canEditAlarm({
    isBusy,
    listLocked,
    deletionPending,
    isWeb,
  });
  const canSubmitAlarm = canSubmitComposer({
    isEditing,
    ringing: ringingCycle !== null,
    loadFailed,
    deletionPending,
    isBusy,
    isWeb,
    listFull: alarms.length >= MAX_ALARM_COUNT,
    canAdd: newAlarmSummary.canAdd,
  });
  const composerNotice =
    isComposerOpen &&
    notice &&
    (notice.tone === 'danger' || notice.tone === 'warning')
      ? { text: notice.text, tone: notice.tone }
      : undefined;

  return {
    monitoringDefinition,
    windowStepCount,
    stepWindowStartLabel,
    deliveryWarningCopy,
    listLocked,
    suppressedOccurrence,
    suppressionCopy,
    stepGuidance,
    canOpenComposer,
    deletionAvailability,
    editingDefinition,
    isEditing,
    newAlarmSummary,
    editAvailable,
    canSubmitAlarm,
    composerNotice,
  };
}

export type HomeView = ReturnType<typeof buildHomeView>;
