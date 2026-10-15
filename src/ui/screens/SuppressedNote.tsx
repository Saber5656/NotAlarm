import { StyleSheet, Text, View } from 'react-native';
import { HOME_COLORS, BEDSIDE_FOOTER_COLORS } from '../tokens';

interface SuppressedNoteProps {
  suppressedOccurrence: { text: string };
}

export function SuppressedNote({ suppressedOccurrence }: SuppressedNoteProps) {
  return (
      <View
        accessible
        accessibilityLabel={suppressedOccurrence.text}
        style={styles.suppressedNote}
        testID="suppressed-occurrence"
      >
        <Text style={styles.suppressedMark}>✓</Text>
        <Text style={styles.suppressedText}>{suppressedOccurrence.text}</Text>
      </View>
  );
}

const styles = StyleSheet.create({
  suppressedNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: BEDSIDE_FOOTER_COLORS.backdrop,
  },
  suppressedMark: {
    color: HOME_COLORS.summaryText.progress,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '900',
  },
  suppressedText: {
    flex: 1,
    color: BEDSIDE_FOOTER_COLORS.title,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
});
