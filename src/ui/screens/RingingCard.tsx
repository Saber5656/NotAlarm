import type { RefObject } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { StoredAlarm } from '../../alarmStorage';
import { getRingingDisplay, getRingingStopA11yLabel } from '../../homeStatus';
import type { TextContext } from '../../i18n';
import { getSnoozeAvailability } from '../../snooze';
import { getSnoozeCopy } from '../../snoozeCopy';
import { sharedStyles } from './sharedStyles';

interface RingingCardProps {
  ringingCycle: StoredAlarm;
  text: TextContext;
  nowMs: number;
  isBusy: boolean;
  stopButtonRef: RefObject<View | null>;
  stopRinging(): Promise<void>;
  snoozeRinging(): Promise<void>;
}

export function RingingCard({
  ringingCycle,
  text,
  nowMs,
  isBusy,
  stopButtonRef,
  stopRinging,
  snoozeRinging,
}: RingingCardProps) {
  const { messages, formatter } = text;
  return (
      <View style={sharedStyles.ringingCard}>
        <Text accessibilityRole="header" style={sharedStyles.ringingLabel}>
          {messages.ringing.badge}
        </Text>
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          numberOfLines={1}
          style={styles.ringingTime}
        >
          {formatter.clockAt(getRingingDisplay(ringingCycle).timeMs)}
        </Text>
        <Text style={styles.ringingDate}>
          {formatter.day(getRingingDisplay(ringingCycle).dateMs)}
        </Text>
        <Text style={sharedStyles.ringingTitle}>{messages.ringing.title}</Text>
        <Pressable
          accessibilityHint={messages.ringing.stopHint}
          accessibilityLabel={getRingingStopA11yLabel(
            new Date(getRingingDisplay(ringingCycle).timeMs).getHours(),
            new Date(getRingingDisplay(ringingCycle).timeMs).getMinutes(),
            text,
            formatter.day(getRingingDisplay(ringingCycle).dateMs),
          )}
          accessibilityRole="button"
          accessibilityState={{ disabled: isBusy }}
          disabled={isBusy}
          hitSlop={4}
          onPress={() => void stopRinging()}
          ref={stopButtonRef}
          style={({ pressed }) => [
            sharedStyles.stopButton,
            (isBusy || pressed) && sharedStyles.buttonDimmed,
          ]}
        >
          <Text style={sharedStyles.stopButtonText}>
            {messages.ringing.stopLabel}
          </Text>
        </Pressable>
        {(() => {
          const snoozeCopy = getSnoozeCopy(
            {
              phase: 'ringing',
              ...getSnoozeAvailability(ringingCycle, nowMs),
            },
            text,
          );
          const snoozeDisabled = isBusy || snoozeCopy.actionDisabled;
          return (
            <View testID="snooze-section">
              <Text style={styles.snoozeDetail}>{snoozeCopy.detail}</Text>
              <Pressable
                accessibilityHint={snoozeCopy.actionHint}
                accessibilityLabel={snoozeCopy.actionLabel}
                accessibilityRole="button"
                accessibilityState={{ disabled: snoozeDisabled }}
                disabled={snoozeDisabled}
                hitSlop={4}
                onPress={() => void snoozeRinging()}
                style={({ pressed }) => [
                  styles.snoozeButton,
                  (snoozeDisabled || pressed) && sharedStyles.buttonDimmed,
                ]}
              >
                <Text style={styles.snoozeButtonText}>
                  {snoozeCopy.actionLabel}
                </Text>
              </Pressable>
            </View>
          );
        })()}
      </View>
  );
}

const styles = StyleSheet.create({
  ringingTime: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 41,
    fontWeight: '900',
    letterSpacing: -1.5,
  },
  ringingDate: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  snoozeDetail: {
    marginTop: 12,
    color: '#FECDCA',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  snoozeButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.85)',
    borderRadius: 14,
    backgroundColor: 'transparent',
  },
  snoozeButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
});
