import { Pressable, StyleSheet, Text } from 'react-native';

import type { SettingsNotice } from '../../app/types';
import type { TextContext } from '../../i18n';
import type { getLocalDataDeletionAvailability } from '../../localDataDeletion';
import type { SunBackgroundState } from '../../useSunBackground';
import { SettingsModal } from '../SettingsModal';
import { SunriseSettings } from '../SunriseSettings';
import { sharedStyles } from './sharedStyles';

interface SettingsSheetProps {
  text: TextContext;
  visible: boolean;
  settingsNotice: SettingsNotice | null;
  sun: SunBackgroundState;
  deletionPending: boolean;
  isBusy: boolean;
  deletionAvailability: ReturnType<typeof getLocalDataDeletionAvailability>;
  closeSettings(): void;
  confirmLocalDataDeletion(): void;
}

export function SettingsSheet({
  text,
  visible,
  settingsNotice,
  sun,
  deletionPending,
  isBusy,
  deletionAvailability,
  closeSettings,
  confirmLocalDataDeletion,
}: SettingsSheetProps) {
  const { messages } = text;
  return (
    <SettingsModal
      closeLabel={messages.common.close}
      onClose={closeSettings}
      subtitle={messages.settings.subtitle}
      title={messages.settings.title}
      visible={visible}
    >
      <Text accessibilityRole="header" style={styles.settingsHeading}>
        {messages.settings.summaryHeading}
      </Text>
      {messages.settings.summary.map((line) => (
        <Text key={line} style={styles.settingsBody}>
          {line}
        </Text>
      ))}
      <Text accessibilityRole="header" style={styles.settingsHeading}>
        {messages.settings.deleteHeading}
      </Text>
      <Text style={styles.settingsBody}>{messages.settings.deleteBody}</Text>
      {settingsNotice ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.settingsNotice}
          testID="settings-notice"
        >
          {settingsNotice.text(messages)}
        </Text>
      ) : null}
      <SunriseSettings resetPending={deletionPending} state={sun} />
      <Pressable
        accessibilityHint={messages.settings.deleteHint}
        accessibilityLabel={messages.settings.deleteAction}
        accessibilityRole="button"
        accessibilityState={{
          busy: isBusy,
          disabled: !deletionAvailability.allowed,
        }}
        disabled={!deletionAvailability.allowed}
        onPress={confirmLocalDataDeletion}
        style={({ pressed }) => [
          styles.deleteDataButton,
          (!deletionAvailability.allowed || pressed) && sharedStyles.buttonDimmed,
        ]}
        testID="delete-data-button"
      >
        <Text style={styles.deleteDataText}>
          {messages.settings.deleteAction}
        </Text>
      </Pressable>
    </SettingsModal>
  );
}

const styles = StyleSheet.create({
  settingsHeading: {
    color: '#0B1A33',
    fontSize: 16,
    fontWeight: '600',
  },
  settingsBody: {
    color: '#44536C',
    fontSize: 14,
    lineHeight: 21,
  },
  settingsNotice: {
    color: '#B42318',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
  },
  deleteDataButton: {
    minHeight: 48,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 24, 0.4)',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  deleteDataText: {
    color: '#B42318',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
});
