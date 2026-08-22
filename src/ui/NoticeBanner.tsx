import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from './GlassSurface';
import { useReducedMotion } from './useReducedMotion';

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface AppNotice {
  text: string;
  tone: NoticeTone;
}

interface NoticeBannerProps {
  notice: AppNotice | null;
  onDismiss: () => void;
}

const SOLID_COLORS: Record<NoticeTone, string> = {
  neutral: '#F4F6FC',
  success: '#E2F6F0',
  warning: '#FFF5D9',
  danger: '#FDE8E6',
};

const FALLBACK_COLORS: Record<NoticeTone, string> = {
  neutral: 'rgba(244, 247, 255, 0.9)',
  success: 'rgba(226, 249, 243, 0.92)',
  warning: 'rgba(255, 247, 222, 0.94)',
  danger: 'rgba(255, 235, 233, 0.94)',
};

const TINT_COLORS: Record<NoticeTone, string> = {
  neutral: '#E9EDFFB8',
  success: '#BDEFE1B8',
  warning: '#FFE7A8C4',
  danger: '#FFC7C2C4',
};

const SYMBOLS: Record<NoticeTone, string> = {
  neutral: 'i',
  success: '✓',
  warning: '!',
  danger: '!',
};

export function NoticeBanner({ notice, onDismiss }: NoticeBannerProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const translateY = useRef(new Animated.Value(-84)).current;

  useEffect(() => {
    if (!notice || Platform.OS !== 'ios') {
      return;
    }

    AccessibilityInfo.announceForAccessibilityWithOptions(notice.text, {
      queue: notice.tone !== 'danger',
    });
  }, [notice?.text, notice?.tone]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    translateY.stopAnimation();
    if (reduceMotion) {
      translateY.setValue(0);
      return;
    }

    translateY.setValue(-84);
    Animated.spring(translateY, {
      damping: 20,
      mass: 0.82,
      stiffness: 230,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [notice?.text, notice?.tone, reduceMotion, translateY]);

  if (!notice) {
    return null;
  }

  const dismiss = () => {
    translateY.stopAnimation();
    if (reduceMotion) {
      onDismiss();
      return;
    }

    Animated.timing(translateY, {
      duration: 180,
      toValue: -84,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        onDismiss();
      }
    });
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { top: insets.top + 6 }]}
    >
      <Animated.View
        style={[styles.motion, { transform: [{ translateY }] }]}
      >
        <GlassSurface
          accessibilityLiveRegion={
            notice.tone === 'danger' ? 'assertive' : 'polite'
          }
          accessibilityRole={notice.tone === 'danger' ? 'alert' : undefined}
          fallbackColor={FALLBACK_COLORS[notice.tone]}
          glassEffectStyle="regular"
          intensity={92}
          reducedTransparencyColor={SOLID_COLORS[notice.tone]}
          style={[styles.banner, styles[`banner_${notice.tone}`]]}
          tintColor={TINT_COLORS[notice.tone]}
        >
          <View style={[styles.symbol, styles[`symbol_${notice.tone}`]]}>
            <Text style={styles.symbolText}>{SYMBOLS[notice.tone]}</Text>
          </View>
          <Text style={styles.text}>{notice.text}</Text>
          <Pressable
            accessibilityLabel="お知らせを閉じる"
            accessibilityRole="button"
            hitSlop={10}
            onPress={dismiss}
            style={({ pressed }) => [
              styles.close,
              pressed && styles.closePressed,
            ]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    right: 12,
    left: 12,
    zIndex: 40,
    alignItems: 'center',
  },
  motion: {
    width: '100%',
    maxWidth: 560,
  },
  banner: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 20,
    ...Platform.select({
      web: { boxShadow: '0 12px 26px rgba(40, 54, 94, 0.24)' },
      default: {
        shadowColor: '#28365E',
        shadowOpacity: 0.24,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 12 },
        elevation: 14,
      },
    }),
  },
  banner_neutral: {
    borderColor: 'rgba(121, 135, 176, 0.34)',
  },
  banner_success: {
    borderColor: 'rgba(54, 139, 119, 0.42)',
  },
  banner_warning: {
    borderColor: 'rgba(177, 121, 24, 0.42)',
  },
  banner_danger: {
    borderColor: 'rgba(180, 65, 57, 0.42)',
  },
  symbol: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  symbol_neutral: {
    backgroundColor: '#6675B8',
  },
  symbol_success: {
    backgroundColor: '#28796D',
  },
  symbol_warning: {
    backgroundColor: '#9A6800',
  },
  symbol_danger: {
    backgroundColor: '#AA3E36',
  },
  symbolText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  text: {
    flex: 1,
    color: '#25304C',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 18,
  },
  close: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.72)',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.46)',
  },
  closePressed: {
    transform: [{ scale: 0.94 }],
  },
  closeText: {
    marginTop: -1,
    color: '#5A657F',
    fontSize: 21,
    lineHeight: 23,
  },
});
