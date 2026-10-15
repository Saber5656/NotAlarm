import { Pressable, Text, View } from 'react-native';

import type { StoredAlarm } from '../../alarmStorage';
import type { TextContext } from '../../i18n';
import { getSnoozeCopy } from '../../snoozeCopy';
import { sharedStyles } from './sharedStyles';

interface SnoozedCardProps {
  snoozedCycle: StoredAlarm;
  text: TextContext;
  isBusy: boolean;
  stopOccurrence(cycle: StoredAlarm): Promise<void>;
}

export function SnoozedCard({
  snoozedCycle,
  text,
  isBusy,
  stopOccurrence,
}: SnoozedCardProps) {
  return (
      <View style={sharedStyles.ringingCard} testID="snoozed-alarm">
        {(() => {
          const waiting = getSnoozeCopy(
            {
              phase: 'snoozed',
              used: snoozedCycle.snooze?.count ?? 0,
              nextAtMs: snoozedCycle.snooze?.dueAtMs ?? snoozedCycle.dueAtMs,
            },
            text,
          );
          return (
            <>
              <Text accessibilityRole="header" style={sharedStyles.ringingLabel}>
                {waiting.title}
              </Text>
              <Text style={sharedStyles.ringingTitle}>{waiting.detail}</Text>
              <Pressable
                accessibilityHint={waiting.actionHint}
                accessibilityLabel={waiting.actionLabel}
                accessibilityRole="button"
                accessibilityState={{ disabled: isBusy }}
                disabled={isBusy}
                hitSlop={4}
                onPress={() => void stopOccurrence(snoozedCycle)}
                style={({ pressed }) => [
                  sharedStyles.stopButton,
                  (isBusy || pressed) && sharedStyles.buttonDimmed,
                ]}
              >
                <Text style={sharedStyles.stopButtonText}>
                  {waiting.actionLabel}
                </Text>
              </Pressable>
            </>
          );
        })()}
      </View>
  );
}
