import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TextContext } from '../../i18n';
import type { getNotificationDeliveryWarningCopy } from '../../notificationDelivery';
import { sharedStyles } from './sharedStyles';

interface DeliveryWarningCardProps {
  text: TextContext;
  deliveryWarningCopy: NonNullable<
    ReturnType<typeof getNotificationDeliveryWarningCopy>
  >;
  skipAction: ReactNode;
  openNotificationSettings(): void;
}

export function DeliveryWarningCard({
  text,
  deliveryWarningCopy,
  skipAction,
  openNotificationSettings,
}: DeliveryWarningCardProps) {
  const { messages } = text;
  return (
      <View
        style={sharedStyles.deliveryWarningCard}
        testID="notification-delivery-warning"
      >
        <View style={styles.deliveryWarningHeader}>
          <Text
            accessibilityRole="header"
            style={sharedStyles.deliveryWarningTitle}
          >
            {deliveryWarningCopy.title}
          </Text>
          <Pressable
            accessibilityHint={messages.delivery.openSettingsHint}
            accessibilityRole="button"
            hitSlop={4}
            onPress={openNotificationSettings}
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && sharedStyles.buttonDimmed,
            ]}
          >
            <Text style={sharedStyles.settingsButtonText}>
              {messages.common.openSettings}
            </Text>
          </Pressable>
        </View>
        <Text style={sharedStyles.deliveryWarningBody}>
          {deliveryWarningCopy.body}
        </Text>
        {skipAction}
      </View>
  );
}

const styles = StyleSheet.create({
  deliveryWarningHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  settingsButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
});
