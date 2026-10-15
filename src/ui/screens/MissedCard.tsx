import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { StoredAlarm } from '../../alarmStorage';
import type { TextContext } from '../../i18n';
import { sharedStyles } from './sharedStyles';

interface MissedCardProps {
  text: TextContext;
  missedCycles: StoredAlarm[];
  missedPreview: { visible: StoredAlarm[]; hiddenCount: number };
  isBusy: boolean;
  acknowledgeMissed(): Promise<void>;
}

export function MissedCard({
  text,
  missedCycles,
  missedPreview,
  isBusy,
  acknowledgeMissed,
}: MissedCardProps) {
  const { messages, formatter } = text;
  return (
      <View style={sharedStyles.ringingCard} testID="missed-alarms">
        <Text accessibilityRole="header" style={sharedStyles.ringingLabel}>
          {messages.missed.title}
        </Text>
        <Text style={sharedStyles.ringingTitle}>
          {messages.missed.explanation}
        </Text>
        <Text style={styles.missedItem}>
          {messages.missed.total(missedCycles.length)}
        </Text>
        {missedPreview.visible.map((cycle) => (
          <Text key={cycle.cycleId} style={styles.missedItem}>
            {formatter.day(cycle.dueAtMs)} {formatter.clockAt(cycle.dueAtMs)}
          </Text>
        ))}
        {missedPreview.hiddenCount > 0 ? (
          <Text style={styles.missedItem}>
            {messages.missed.hidden(missedPreview.hiddenCount)}
          </Text>
        ) : null}
        <Pressable
          accessibilityHint={messages.missed.acknowledgeAllHint}
          accessibilityLabel={messages.missed.acknowledgeAllSpoken(
            missedCycles.length,
          )}
          accessibilityRole="button"
          accessibilityState={{ disabled: isBusy }}
          disabled={isBusy}
          hitSlop={4}
          onPress={() => void acknowledgeMissed()}
          style={({ pressed }) => [
            sharedStyles.stopButton,
            (isBusy || pressed) && sharedStyles.buttonDimmed,
          ]}
        >
          <Text style={sharedStyles.stopButtonText}>
            {messages.missed.acknowledgeAll}
          </Text>
        </Pressable>
      </View>
  );
}

const styles = StyleSheet.create({
  missedItem: {
    marginTop: 4,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
});
