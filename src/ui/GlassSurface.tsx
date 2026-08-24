import { BlurView, type BlurTint } from 'expo-blur';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  type GlassStyle,
} from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

interface GlassSurfaceProps extends ViewProps {
  blurTint?: BlurTint;
  fallbackColor?: string;
  glassEffectStyle?: GlassStyle;
  intensity?: number;
  isInteractive?: boolean;
  reducedTransparencyColor?: string;
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
}

function supportsNativeLiquidGlass(): boolean {
  if (Platform.OS !== 'ios') {
    return false;
  }

  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

const nativeLiquidGlassAvailable = supportsNativeLiquidGlass();

export function GlassSurface({
  blurTint = 'systemUltraThinMaterialLight',
  children,
  fallbackColor,
  glassEffectStyle = 'regular',
  intensity = 62,
  isInteractive = false,
  reducedTransparencyColor = 'rgba(248, 250, 255, 0.96)',
  style,
  tintColor = '#FFFFFF66',
  ...viewProps
}: GlassSurfaceProps) {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (
      Platform.OS !== 'ios' ||
      typeof AccessibilityInfo.isReduceTransparencyEnabled !== 'function'
    ) {
      return;
    }

    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((enabled) => {
        if (mounted) {
          setReduceTransparency(enabled);
        }
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency,
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  if (reduceTransparency) {
    return (
      <View
        {...viewProps}
        style={[
          styles.surface,
          style,
          { backgroundColor: reducedTransparencyColor },
        ]}
      >
        {children}
      </View>
    );
  }

  if (nativeLiquidGlassAvailable) {
    return (
      <GlassView
        {...viewProps}
        glassEffectStyle={glassEffectStyle}
        isInteractive={isInteractive}
        style={[styles.surface, style]}
        tintColor={tintColor}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      {...viewProps}
      experimentalBlurMethod="none"
      intensity={intensity}
      style={[styles.surface, style]}
      tint={blurTint}
    >
      {fallbackColor ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: fallbackColor }]}
        />
      ) : null}
      {children}
    </BlurView>
  );
}

export function isNativeLiquidGlassActive(): boolean {
  return nativeLiquidGlassAvailable;
}

const styles = StyleSheet.create({
  surface: {
    overflow: 'hidden',
  },
});
