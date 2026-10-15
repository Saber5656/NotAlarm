import { StyleSheet, Text, View } from 'react-native';

import type { BedsideGuidance } from '../../bedsideMode';
import type { TextContext } from '../../i18n';
import { BEDSIDE_FOOTER_COLORS } from '../tokens';

// The bedside guidance is pinned below the scrolling content and follows
// Dynamic Type up to 2x, so at the largest sizes it still leaves the content
// (which scrolls above `fontScale > 1.3`) most of the screen.
const FOOTER_MAX_FONT_SCALE = 2;

interface BedsideFooterProps {
  text: TextContext;
  bedsideGuidance: BedsideGuidance;
}

/**
 * Pinned outside the scrolling frame so it is visible on first view at every
 * text size; as a flex sibling it takes its height from the content instead of
 * covering it.
 */

export function BedsideFooter({ text, bedsideGuidance }: BedsideFooterProps) {
  const { messages } = text;
  return (
    <View style={styles.footerDock}>
      <View
        accessible
        accessibilityLabel={messages.composer.bedsideNote(
          bedsideGuidance.title,
          bedsideGuidance.detail,
        )}
        style={styles.footerNote}
        testID="bedside-guidance"
      >
        <View style={styles.footerDot} />
        <View style={styles.footerCopy}>
          <Text
            allowFontScaling
            maxFontSizeMultiplier={FOOTER_MAX_FONT_SCALE}
            style={styles.footerTitle}
          >
            {bedsideGuidance.title}
          </Text>
          <Text
            allowFontScaling
            maxFontSizeMultiplier={FOOTER_MAX_FONT_SCALE}
            style={styles.footerText}
          >
            {bedsideGuidance.detail}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footerDock: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 5,
  },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: BEDSIDE_FOOTER_COLORS.backdrop,
  },
  footerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#91D8CC',
  },
  footerCopy: {
    flexShrink: 1,
  },
  footerTitle: {
    color: BEDSIDE_FOOTER_COLORS.title,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  footerText: {
    color: BEDSIDE_FOOTER_COLORS.detail,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
});
