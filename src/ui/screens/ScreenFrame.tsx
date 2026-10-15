import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

export interface ScreenFrameProps {
  accessibilityMinHeight: number;
  children: ReactNode;
  useAccessibilityScroll: boolean;
}

export function ScreenFrame({
  accessibilityMinHeight,
  children,
  useAccessibilityScroll,
}: ScreenFrameProps) {
  if (useAccessibilityScroll) {
    return (
      <ScrollView
        bounces
        contentContainerStyle={styles.screenScrollerContent}
        showsVerticalScrollIndicator
        style={styles.screenScroller}
      >
        <View
          style={[styles.screen, { minHeight: accessibilityMinHeight }]}
        >
          {children}
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screenViewport}>
      <View style={styles.screen}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  screenViewport: {
    flex: 1,
    minHeight: 0,
    width: '100%',
  },
  screenScroller: {
    flex: 1,
  },
  screenScrollerContent: {
    flexGrow: 1,
    width: '100%',
  },
});
