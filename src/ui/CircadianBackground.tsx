import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { CircadianTheme } from '../circadianTheme';

interface CircadianBackgroundProps {
  theme: CircadianTheme;
}

const STARS = [
  { x: 0.08, y: 0.09, size: 2 },
  { x: 0.2, y: 0.18, size: 3 },
  { x: 0.32, y: 0.08, size: 2 },
  { x: 0.44, y: 0.23, size: 2 },
  { x: 0.58, y: 0.12, size: 3 },
  { x: 0.7, y: 0.26, size: 2 },
  { x: 0.82, y: 0.1, size: 2 },
  { x: 0.92, y: 0.2, size: 3 },
  { x: 0.13, y: 0.33, size: 2 },
  { x: 0.37, y: 0.37, size: 3 },
  { x: 0.64, y: 0.34, size: 2 },
  { x: 0.87, y: 0.39, size: 2 },
] as const;

export function CircadianBackground({ theme }: CircadianBackgroundProps) {
  const { height, width } = useWindowDimensions();
  const celestialSize = Math.min(104, Math.max(76, width * 0.23));
  const glowSize = celestialSize * 2.15;
  const celestialTopLimit = Math.max(360, height * 0.72);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.root}
      testID="circadian-background"
    >
      <LinearGradient
        colors={theme.skyColors}
        end={{ x: 0.56, y: 1 }}
        locations={[0, 0.34, 0.72, 1]}
        start={{ x: 0.42, y: 0 }}
        style={StyleSheet.absoluteFill}
      />

      <View style={[styles.stars, { opacity: theme.starsOpacity }]}>
        {STARS.map((star, index) => (
          <View
            key={`${star.x}-${star.y}`}
            style={[
              styles.star,
              {
                height: star.size,
                left: `${star.x * 100}%`,
                opacity: index % 3 === 0 ? 0.66 : 1,
                top: `${star.y * 100}%`,
                width: star.size,
              },
            ]}
          />
        ))}
      </View>

      <View
        style={[
          styles.celestialGlow,
          styles.sunGlow,
          {
            height: glowSize,
            left: theme.sun.x * width - glowSize / 2,
            opacity: theme.sun.opacity * 0.74,
            top: theme.sun.y * celestialTopLimit - glowSize / 2,
            width: glowSize,
          },
        ]}
      />
      <LinearGradient
        colors={['#FFF8D6', '#FFD38A', '#FFAA55']}
        end={{ x: 0.82, y: 0.88 }}
        start={{ x: 0.18, y: 0.12 }}
        style={[
          styles.celestial,
          styles.sun,
          {
            height: celestialSize,
            left: theme.sun.x * width - celestialSize / 2,
            opacity: theme.sun.opacity,
            top: theme.sun.y * celestialTopLimit - celestialSize / 2,
            width: celestialSize,
          },
        ]}
      />

      <View
        style={[
          styles.celestialGlow,
          styles.moonGlow,
          {
            height: glowSize,
            left: theme.moon.x * width - glowSize / 2,
            opacity: theme.moon.opacity * 0.54,
            top: theme.moon.y * celestialTopLimit - glowSize / 2,
            width: glowSize,
          },
        ]}
      />
      <View
        style={[
          styles.celestial,
          styles.moon,
          {
            height: celestialSize,
            left: theme.moon.x * width - celestialSize / 2,
            opacity: theme.moon.opacity,
            top: theme.moon.y * celestialTopLimit - celestialSize / 2,
            width: celestialSize,
          },
        ]}
      >
        <View style={styles.moonCraterLarge} />
        <View style={styles.moonCraterSmall} />
      </View>

      <LinearGradient
        colors={['transparent', `${theme.horizonColor}D9`]}
        locations={[0, 1]}
        style={styles.horizonGlow}
      />
      <View style={styles.hillBack} />
      <View style={styles.hillFront} />
      <View style={styles.ground} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  stars: {
    ...StyleSheet.absoluteFillObject,
  },
  star: {
    position: 'absolute',
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    ...Platform.select({
      web: { boxShadow: '0 0 6px rgba(255, 255, 255, 0.9)' },
      default: {
        shadowColor: '#FFFFFF',
        shadowOpacity: 0.8,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 0 },
      },
    }),
  },
  celestialGlow: {
    position: 'absolute',
    borderRadius: 999,
  },
  sunGlow: {
    backgroundColor: 'rgba(255, 188, 93, 0.22)',
  },
  moonGlow: {
    backgroundColor: 'rgba(188, 220, 255, 0.16)',
  },
  celestial: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: 999,
  },
  sun: {
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.42)',
    ...Platform.select({
      web: { boxShadow: '0 0 28px rgba(255, 193, 99, 0.52)' },
      default: {
        shadowColor: '#FFD38A',
        shadowOpacity: 0.48,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 0 },
      },
    }),
  },
  moon: {
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.62)',
    backgroundColor: '#F7F1DB',
    ...Platform.select({
      web: { boxShadow: '0 0 26px rgba(213, 231, 255, 0.42)' },
      default: {
        shadowColor: '#D5E7FF',
        shadowOpacity: 0.42,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 0 },
      },
    }),
  },
  moonCraterLarge: {
    position: 'absolute',
    top: '19%',
    right: '15%',
    width: '29%',
    height: '29%',
    borderRadius: 999,
    backgroundColor: 'rgba(133, 153, 166, 0.18)',
  },
  moonCraterSmall: {
    position: 'absolute',
    bottom: '22%',
    left: '20%',
    width: '17%',
    height: '17%',
    borderRadius: 999,
    backgroundColor: 'rgba(133, 153, 166, 0.16)',
  },
  horizonGlow: {
    position: 'absolute',
    right: 0,
    bottom: '13%',
    left: 0,
    height: '33%',
  },
  hillBack: {
    position: 'absolute',
    right: '-28%',
    bottom: '-6%',
    width: '112%',
    height: '26%',
    borderRadius: 999,
    backgroundColor: 'rgba(8, 31, 48, 0.4)',
    transform: [{ rotate: '-7deg' }],
  },
  hillFront: {
    position: 'absolute',
    bottom: '-12%',
    left: '-42%',
    width: '134%',
    height: '31%',
    borderRadius: 999,
    backgroundColor: 'rgba(3, 20, 35, 0.58)',
    transform: [{ rotate: '8deg' }],
  },
  ground: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: '10%',
    backgroundColor: 'rgba(2, 14, 28, 0.64)',
  },
});
