import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GlassSurface } from './GlassSurface';
import { UI_COLORS } from './tokens';
import { useReducedMotion } from './useReducedMotion';

export type ComposerSection = 'time' | 'repeat';

interface LiquidComposerTabsProps {
  disabled: boolean;
  onChange: (section: ComposerSection) => void;
  repeatDisabled: boolean;
  style?: StyleProp<ViewStyle>;
  value: ComposerSection;
}

const OPTIONS: Array<{ label: string; section: ComposerSection }> = [
  { label: '時刻', section: 'time' },
  { label: '繰り返し', section: 'repeat' },
];

export function LiquidComposerTabs({
  disabled,
  onChange,
  repeatDisabled,
  style,
  value,
}: LiquidComposerTabsProps) {
  const reduceMotion = useReducedMotion();
  const selectedIndex = OPTIONS.findIndex(
    (option) => option.section === value,
  );
  const selection = useRef(new Animated.Value(selectedIndex)).current;
  const [trackWidth, setTrackWidth] = useState(0);
  const segmentWidth = Math.max((trackWidth - 8) / OPTIONS.length, 0);
  const translateX = useMemo(
    () =>
      selection.interpolate({
        inputRange: [0, 1],
        outputRange: [0, segmentWidth],
      }),
    [segmentWidth, selection],
  );

  useEffect(() => {
    selection.stopAnimation();
    if (reduceMotion) {
      selection.setValue(selectedIndex);
      return;
    }

    Animated.spring(selection, {
      damping: 21,
      mass: 0.76,
      stiffness: 250,
      toValue: selectedIndex,
      useNativeDriver: true,
    }).start();
  }, [reduceMotion, selectedIndex, selection]);

  return (
    <View
      accessibilityLabel="設定項目"
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[styles.track, style]}
      testID="composer-section-tabs"
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.selectionMotion,
            { transform: [{ translateX }], width: segmentWidth },
          ]}
          testID="composer-section-lens"
        >
          <GlassSurface
            fallbackColor="rgba(218, 225, 255, 0.94)"
            glassEffectStyle="regular"
            intensity={90}
            reducedTransparencyColor="#DCE3FC"
            style={styles.selectionLens}
            tintColor="#CED8FFC0"
          >
            <View style={styles.selectionHighlight} />
          </GlassSurface>
        </Animated.View>
      ) : null}

      {OPTIONS.map((option) => {
        const selected = option.section === value;
        const optionDisabled =
          disabled || (option.section === 'repeat' && repeatDisabled);

        return (
          <Pressable
            accessibilityHint={
              option.section === 'repeat' && repeatDisabled
                ? '時刻を確定またはキャンセルしてから切り替えられます'
                : undefined
            }
            accessibilityLabel={option.label}
            accessibilityRole="button"
            accessibilityState={{
              disabled: optionDisabled,
              selected,
            }}
            disabled={optionDisabled}
            key={option.section}
            onPress={() => onChange(option.section)}
            style={({ pressed }) => [
              styles.segment,
              optionDisabled && styles.segmentDisabled,
              pressed && styles.segmentPressed,
            ]}
            testID={`composer-tab-${option.section}`}
          >
            <Text
              style={[styles.label, selected && styles.labelSelected]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'relative',
    minHeight: 54,
    flexDirection: 'row',
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.18)',
    borderRadius: 19,
    backgroundColor: 'rgba(224, 228, 240, 0.62)',
  },
  selectionMotion: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
  },
  selectionLens: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 15,
  },
  selectionHighlight: {
    position: 'absolute',
    top: 1,
    right: 12,
    left: 12,
    height: 1,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
  },
  segment: {
    zIndex: 1,
    minWidth: 0,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  segmentDisabled: {
    opacity: 0.48,
  },
  segmentPressed: {
    transform: [{ scale: 0.97 }],
  },
  label: {
    color: UI_COLORS.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  labelSelected: {
    color: '#4054C5',
  },
});
