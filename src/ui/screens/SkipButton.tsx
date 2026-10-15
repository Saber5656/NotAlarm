import { Pressable, StyleSheet, Text } from 'react-native';

import type { TextContext } from '../../i18n';
import type { UserSkipTarget } from '../../userSkip';
import { sharedStyles } from './sharedStyles';

interface SkipButtonProps {
  skipOffer: UserSkipTarget;
  text: TextContext;
  isBusy: boolean;
  confirmUserSkip(): void;
}

/**
 * Independent of the delivery-warning card: the foreground loop still runs
 * with notifications off, so the user must keep this control.
 */

export function SkipButton({
  skipOffer,
  text,
  isBusy,
  confirmUserSkip,
}: SkipButtonProps) {
  const { messages, formatter } = text;
  return (
    <Pressable
      accessibilityHint={messages.skip.hint}
      accessibilityLabel={messages.skip.spoken(
        `${formatter.day(skipOffer.dueAtMs)} ${formatter.clockAt(
          skipOffer.dueAtMs,
        )}`,
      )}
      accessibilityRole="button"
      disabled={isBusy}
      hitSlop={4}
      onPress={confirmUserSkip}
      style={({ pressed }) => [
        styles.skipButton,
        pressed && sharedStyles.buttonDimmed,
      ]}
      testID="skip-this-occurrence"
    >
      <Text style={styles.skipButtonText}>{messages.skip.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  skipButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  skipButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
