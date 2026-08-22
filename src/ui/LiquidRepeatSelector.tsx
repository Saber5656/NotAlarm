import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { RepeatKind } from '../alarmSchedule';
import { GlassSurface } from './GlassSurface';
import { UI_COLORS } from './tokens';
import { useReducedMotion } from './useReducedMotion';

interface LiquidRepeatSelectorProps {
  onChange: (kind: RepeatKind) => void;
  value: RepeatKind;
}

const OPTIONS: Array<{ kind: RepeatKind; label: string }> = [
  { kind: 'today', label: '今日だけ' },
  { kind: 'daily', label: '毎日' },
  { kind: 'weekdays', label: '平日' },
  { kind: 'custom', label: '曜日指定' },
];

export function LiquidRepeatSelector({
  onChange,
  value,
}: LiquidRepeatSelectorProps) {
  const reduceMotion = useReducedMotion();
  const selectedIndex = OPTIONS.findIndex((option) => option.kind === value);
  const selection = useRef(new Animated.Value(selectedIndex)).current;
  const [trackWidth, setTrackWidth] = useState(0);
  const segmentWidth = Math.max((trackWidth - 8) / OPTIONS.length, 0);
  const translateX = useMemo(
    () =>
      selection.interpolate({
        inputRange: OPTIONS.map((_, index) => index),
        outputRange: OPTIONS.map((_, index) => index * segmentWidth),
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
      damping: 22,
      mass: 0.78,
      stiffness: 245,
      toValue: selectedIndex,
      useNativeDriver: true,
    }).start();
  }, [reduceMotion, selectedIndex, selection]);

  return (
    <View
      accessibilityLabel="繰り返し"
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={styles.track}
      testID="repeat-selector"
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.selectionMotion,
            {
              transform: [{ translateX }],
              width: segmentWidth,
            },
          ]}
          testID="repeat-selection-lens"
        >
          <GlassSurface
            fallbackColor="rgba(220, 226, 255, 0.92)"
            glassEffectStyle="regular"
            intensity={90}
            reducedTransparencyColor="#E1E5F8"
            style={styles.selectionLens}
            tintColor="#C9D2FFB8"
          >
            <View style={styles.selectionHighlight} />
          </GlassSurface>
        </Animated.View>
      ) : null}

      {OPTIONS.map((option) => {
        const selected = value === option.kind;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={option.kind}
            onPress={() => onChange(option.kind)}
            style={({ pressed }) => [
              styles.segment,
              pressed && styles.segmentPressed,
            ]}
            testID={`repeat-${option.kind}`}
          >
            <Text
              numberOfLines={1}
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
    minHeight: 52,
    flexDirection: 'row',
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(122, 136, 180, 0.2)',
    borderRadius: 18,
    backgroundColor: 'rgba(224, 228, 240, 0.7)',
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
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 14,
  },
  selectionHighlight: {
    position: 'absolute',
    top: 1,
    right: 8,
    left: 8,
    height: 1,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  segment: {
    zIndex: 1,
    minWidth: 0,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderRadius: 14,
  },
  segmentPressed: {
    transform: [{ scale: 0.96 }],
  },
  label: {
    color: UI_COLORS.textMuted,
    fontSize: 11,
    fontWeight: '800',
  },
  labelSelected: {
    color: '#3548B6',
    fontWeight: '900',
  },
});
