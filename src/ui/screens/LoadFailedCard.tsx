import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ErrorCode } from '../../errorCatalog';
import type { TextContext } from '../../i18n';
import { sharedStyles } from './sharedStyles';

interface LoadFailedCardProps {
  text: TextContext;
  loadFailureCode: ErrorCode | null;
  isBusy: boolean;
  confirmStorageReset(): void;
}

export function LoadFailedCard({
  text,
  loadFailureCode,
  isBusy,
  confirmStorageReset,
}: LoadFailedCardProps) {
  const { messages } = text;
  return (
      <View
        accessibilityRole="alert"
        style={sharedStyles.deliveryWarningCard}
        testID="storage-load-failed"
      >
        <Text accessibilityRole="header" style={sharedStyles.deliveryWarningTitle}>
          {messages.storageLoadFailed.title}
        </Text>
        <Text style={sharedStyles.deliveryWarningBody}>
          {messages.storageLoadFailed.body}
        </Text>
        <Text style={sharedStyles.deliveryWarningBody}>
          {messages.storageLoadFailed.addDisabledReason}
        </Text>
        {messages.storageLoadFailed.restartSteps.map((step, index) => (
          <Text key={step} style={sharedStyles.deliveryWarningBody}>
            {index + 1}. {step}
          </Text>
        ))}
        <Text style={sharedStyles.deliveryWarningBody}>
          {messages.storageLoadFailed.lastResort}
        </Text>
        {loadFailureCode ? (
          <Text
            selectable
            style={styles.errorCodeDetail}
            testID="storage-load-failed-code"
          >
            {messages.errors[loadFailureCode].message}
            {'\n'}
            {messages.common.errorCode}: {loadFailureCode}
          </Text>
        ) : null}
        <Pressable
          accessibilityHint={messages.storageLoadFailed.resetHint}
          accessibilityLabel={messages.storageLoadFailed.resetAction}
          accessibilityRole="button"
          accessibilityState={{ busy: isBusy, disabled: isBusy }}
          disabled={isBusy}
          onPress={confirmStorageReset}
          style={({ pressed }) => [
            styles.resetButton,
            (isBusy || pressed) && sharedStyles.buttonDimmed,
          ]}
          testID="storage-reset-button"
        >
          <Text style={sharedStyles.settingsButtonText}>
            {messages.storageLoadFailed.resetAction}
          </Text>
        </Pressable>
      </View>
  );
}

const styles = StyleSheet.create({
  errorCodeDetail: {
    marginTop: 10,
    color: '#FECDCA',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
  resetButton: {
    minHeight: 44,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
});
