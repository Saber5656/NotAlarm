import type { RefObject } from 'react';
import { Text, View } from 'react-native';

import type { StoredAlarm, StoredAlarmDefinition } from '../../alarmStorage';
import type { HomeView } from '../../app/core/homeView';
import type { BedsideGuidance } from '../../bedsideMode';
import type { ErrorCode } from '../../errorCatalog';
import type { TextContext } from '../../i18n';
import type { AlarmQueueStatus } from '../../scheduleReconciliation';
import type { ScreenScrollPolicy } from '../../screenScroll';
import type { StepWindowPhase } from '../../stepWindow';
import type { UserSkipTarget } from '../../userSkip';
import { AlarmListPanel } from './AlarmListPanel';
import { BedsideFooter } from './BedsideFooter';
import { DeliveryWarningCard } from './DeliveryWarningCard';
import { HomeHeader } from './HomeHeader';
import { IdleCard } from './IdleCard';
import { LoadFailedCard } from './LoadFailedCard';
import { MissedCard } from './MissedCard';
import { NextAlarmCard } from './NextAlarmCard';
import { RingingCard } from './RingingCard';
import { ScreenFrame } from './ScreenFrame';
import { SkipButton } from './SkipButton';
import { SnoozedCard } from './SnoozedCard';
import { SuppressedNote } from './SuppressedNote';
import { sharedStyles } from './sharedStyles';

export interface HomeScreenActions {
  openSettings(): void;
  openAddComposer(): void;
  openNotificationSettings(): void;
  confirmUserSkip(): void;
  stopOccurrence(cycle: StoredAlarm): Promise<void>;
  stopRinging(): Promise<void>;
  snoozeRinging(): Promise<void>;
  acknowledgeMissed(): Promise<void>;
  confirmStorageReset(): void;
  toggleAlarm(definition: StoredAlarmDefinition, enabled: boolean): Promise<unknown>;
  openEditComposer(definition: StoredAlarmDefinition): Promise<unknown>;
  confirmDeleteAlarm(definition: StoredAlarmDefinition): void;
}

export interface HomeScreenProps {
  text: TextContext;
  nowMs: number;
  alarms: StoredAlarmDefinition[];
  orderedAlarms: StoredAlarmDefinition[];
  isBusy: boolean;
  loadFailed: boolean;
  loadFailureCode: ErrorCode | null;
  deletionPending: boolean;
  ringingCycle: StoredAlarm | null;
  snoozedCycle: StoredAlarm | null;
  missedCycles: StoredAlarm[];
  missedPreview: { visible: StoredAlarm[]; hiddenCount: number };
  monitoringCycle: StoredAlarm | null;
  stepWindowPhase: StepWindowPhase | null;
  skipOffer: UserSkipTarget | null;
  refillFailedAlarmIds: ReadonlySet<string>;
  queueStatuses: Record<string, AlarmQueueStatus>;
  bedsideGuidance: BedsideGuidance;
  screenScroll: ScreenScrollPolicy;
  stopButtonRef: RefObject<View | null>;
  view: HomeView;
  actions: HomeScreenActions;
}

/**
 * The home screen in every state: header, then one status card chosen by the
 * state (ringing, missed, load failure, delivery warning, next alarm or idle),
 * then the list and the pinned bedside note. It only renders what it is given.
 */
export function HomeScreen({
  text,
  nowMs,
  alarms,
  orderedAlarms,
  isBusy,
  loadFailed,
  loadFailureCode,
  deletionPending,
  ringingCycle,
  snoozedCycle,
  missedCycles,
  missedPreview,
  monitoringCycle,
  stepWindowPhase,
  skipOffer,
  refillFailedAlarmIds,
  queueStatuses,
  bedsideGuidance,
  screenScroll,
  stopButtonRef,
  view,
  actions,
}: HomeScreenProps) {
  const {
    monitoringDefinition,
    windowStepCount,
    stepWindowStartLabel,
    deliveryWarningCopy,
    listLocked,
    suppressedOccurrence,
    suppressionCopy,
    stepGuidance,
    canOpenComposer,
    editAvailable,
  } = view;
  // Independent of the delivery-warning card: the foreground loop still
  // runs with notifications off, so the user must keep this control.
  const skipAction = skipOffer ? (
    <SkipButton
      confirmUserSkip={actions.confirmUserSkip}
      isBusy={isBusy}
      skipOffer={skipOffer}
      text={text}
    />
  ) : null;

  return (
    <>
      <ScreenFrame
        accessibilityMinHeight={screenScroll.minHeight}
        useAccessibilityScroll={screenScroll.scroll}
      >
        <HomeHeader
          canOpenComposer={canOpenComposer}
          loadFailed={loadFailed}
          openAddComposer={actions.openAddComposer}
          openSettings={actions.openSettings}
          ringing={!!ringingCycle}
          text={text}
        />

        {suppressionCopy && !ringingCycle ? (
          <View
            accessibilityRole="alert"
            style={sharedStyles.deliveryWarningCard}
            testID="suppression-warning"
          >
            <Text accessibilityRole="header" style={sharedStyles.deliveryWarningTitle}>
              {suppressionCopy.title}
            </Text>
            <Text style={sharedStyles.deliveryWarningBody}>
              {suppressionCopy.body}
            </Text>
          </View>
        ) : null}

        {!ringingCycle && snoozedCycle ? (
          <SnoozedCard
            isBusy={isBusy}
            snoozedCycle={snoozedCycle}
            stopOccurrence={actions.stopOccurrence}
            text={text}
          />
        ) : null}

        {ringingCycle ? (
          <RingingCard
            isBusy={isBusy}
            nowMs={nowMs}
            ringingCycle={ringingCycle}
            snoozeRinging={actions.snoozeRinging}
            stopButtonRef={stopButtonRef}
            stopRinging={actions.stopRinging}
            text={text}
          />
        ) : missedCycles.length > 0 ? (
          <MissedCard
            acknowledgeMissed={actions.acknowledgeMissed}
            isBusy={isBusy}
            missedCycles={missedCycles}
            missedPreview={missedPreview}
            text={text}
          />
        ) : loadFailed ? (
          <LoadFailedCard
            confirmStorageReset={actions.confirmStorageReset}
            isBusy={isBusy}
            loadFailureCode={loadFailureCode}
            text={text}
          />
        ) : deliveryWarningCopy ? (
          <DeliveryWarningCard
            deliveryWarningCopy={deliveryWarningCopy}
            openNotificationSettings={actions.openNotificationSettings}
            skipAction={skipAction}
            text={text}
          />
        ) : monitoringCycle && monitoringDefinition ? (
          <NextAlarmCard
            monitoringCycle={monitoringCycle}
            monitoringDefinition={monitoringDefinition}
            nowMs={nowMs}
            openNotificationSettings={actions.openNotificationSettings}
            screenScroll={screenScroll}
            skipAction={skipAction}
            stepGuidance={stepGuidance}
            stepWindowPhase={stepWindowPhase}
            stepWindowStartLabel={stepWindowStartLabel}
            text={text}
            windowStepCount={windowStepCount}
          />
        ) : (
          <IdleCard alarms={alarms} screenScroll={screenScroll} text={text} />
        )}

        {suppressedOccurrence && !ringingCycle ? (
          <SuppressedNote suppressedOccurrence={suppressedOccurrence} />
        ) : null}

        <AlarmListPanel
          alarms={alarms}
          confirmDeleteAlarm={actions.confirmDeleteAlarm}
          deletionPending={deletionPending}
          deliveryWarningCopy={deliveryWarningCopy}
          editAvailable={editAvailable}
          isBusy={isBusy}
          listLocked={listLocked}
          loadFailed={loadFailed}
          nowMs={nowMs}
          openEditComposer={actions.openEditComposer}
          orderedAlarms={orderedAlarms}
          queueStatuses={queueStatuses}
          refillFailedAlarmIds={refillFailedAlarmIds}
          suppressedOccurrence={suppressedOccurrence}
          text={text}
          toggleAlarm={actions.toggleAlarm}
        />
      </ScreenFrame>

      <BedsideFooter bedsideGuidance={bedsideGuidance} text={text} />
    </>
  );
}
