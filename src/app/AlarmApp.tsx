import { StatusBar } from 'expo-status-bar';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getScreenScrollPolicy } from '../screenScroll';
import { AlarmComposerModal } from '../ui/AlarmComposerModal';
import { CircadianBackground } from '../ui/CircadianBackground';
import { I18nProvider } from '../ui/I18nContext';
import { NoticeBanner } from '../ui/NoticeBanner';
import { HomeScreen } from '../ui/screens/HomeScreen';
import { LoadingScreen } from '../ui/screens/LoadingScreen';
import { SettingsSheet } from '../ui/screens/SettingsSheet';
import { useAlarmController } from './useAlarmController';

/**
 * Composition of the app's views: the controller owns every service and all
 * state, the screens only render what they are handed.
 */
export function AlarmApp() {
  const { fontScale, height: viewportHeight } = useWindowDimensions();
  const controller = useAlarmController();
  const {
    text,
    view,
    composer,
    settings,
    isLoaded,
    isBusy,
    notice,
    ringingCycle,
    circadianTheme,
  } = controller;

  const screenScroll = getScreenScrollPolicy({
    fontScale,
    viewportHeight,
    loadFailed: controller.loadFailed,
    ringing: ringingCycle !== null,
  });

  if (!isLoaded) {
    return <LoadingScreen circadianTheme={circadianTheme} text={text} />;
  }

  return (
    <I18nProvider value={text}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <CircadianBackground theme={circadianTheme} />

        <HomeScreen
          actions={controller.homeActions}
          alarms={controller.alarms}
          bedsideGuidance={controller.bedsideGuidance}
          deletionPending={controller.deletionPending}
          isBusy={isBusy}
          loadFailed={controller.loadFailed}
          loadFailureCode={controller.loadFailureCode}
          missedCycles={controller.missedCycles}
          missedPreview={controller.missedPreview}
          monitoringCycle={controller.monitoringCycle}
          nowMs={controller.nowMs}
          orderedAlarms={controller.orderedAlarms}
          queueStatuses={controller.queueStatuses}
          refillFailedAlarmIds={controller.refillFailedAlarmIds}
          ringingCycle={ringingCycle}
          screenScroll={screenScroll}
          skipOffer={controller.skipOffer}
          snoozedCycle={controller.snoozedCycle}
          stepWindowPhase={controller.stepWindowPhase}
          stopButtonRef={controller.stopButtonRef}
          text={text}
          view={view}
        />

        <NoticeBanner
          notice={composer.isOpen ? null : notice}
          onDismiss={controller.dismissNotice}
        />

        <SettingsSheet
          closeSettings={settings.close}
          confirmLocalDataDeletion={settings.confirmLocalDataDeletion}
          deletionAvailability={view.deletionAvailability}
          deletionPending={controller.deletionPending}
          isBusy={isBusy}
          settingsNotice={settings.notice}
          sun={settings.sun}
          text={text}
          visible={settings.isOpen && !ringingCycle}
        />

        <AlarmComposerModal
          bedsideGuidance={controller.bedsideGuidance}
          canSubmit={view.canSubmitAlarm}
          onDismissed={composer.onDismissed}
          customWeekdays={composer.customWeekdays}
          formNotice={view.composerNotice}
          isBusy={isBusy}
          mode={view.isEditing ? 'edit' : 'add'}
          onClose={composer.close}
          onRepeatKindChange={composer.setRepeatKind}
          onSubmit={composer.submit}
          onTimeChange={composer.setSelectedTime}
          summary={view.newAlarmSummary}
          onToggleWeekday={composer.toggleCustomWeekday}
          repeatKind={composer.repeatKind}
          selectedTime={composer.selectedTime}
          visible={composer.isOpen && !ringingCycle}
        />
      </SafeAreaView>
    </I18nProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#07162D',
  },
});
