import { LinearGradient } from 'expo-linear-gradient';
import { Image, StyleSheet, View } from 'react-native';

import type { CircadianTheme } from '../circadianTheme';

interface CircadianBackgroundProps {
  theme: CircadianTheme;
}

const BACKGROUND_LAYERS = [
  ['night', require('../../assets/backgrounds/circadian-night.jpg')],
  ['dawn', require('../../assets/backgrounds/circadian-dawn.jpg')],
  ['day', require('../../assets/backgrounds/circadian-day.jpg')],
  ['dusk', require('../../assets/backgrounds/circadian-dusk.jpg')],
] as const;

export function CircadianBackground({ theme }: CircadianBackgroundProps) {
  const brightSkyWeight = Math.min(
    1,
    theme.photoWeights.dawn + theme.photoWeights.day,
  );
  const topScrimOpacity = 0.3 + brightSkyWeight * 0.28;
  const midScrimOpacity = 0.08 + brightSkyWeight * 0.08;
  const scrimColors: [string, string, string, string] = [
    `rgba(2, 13, 32, ${topScrimOpacity})`,
    `rgba(2, 13, 32, ${midScrimOpacity})`,
    'rgba(2, 13, 32, 0.02)',
    'rgba(2, 13, 32, 0.12)',
  ];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.root}
      testID="circadian-background"
    >
      {BACKGROUND_LAYERS.map(([phase, source]) => {
        const opacity = theme.photoWeights[phase];
        return opacity > 0 ? (
          <Image
            fadeDuration={0}
            key={phase}
            resizeMode="cover"
            source={source}
            style={[styles.photo, { opacity }]}
          />
        ) : null;
      })}

      <LinearGradient
        colors={scrimColors}
        end={{ x: 0.52, y: 1 }}
        locations={[0, 0.36, 0.7, 1]}
        start={{ x: 0.48, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
    backgroundColor: '#06152D',
  },
  photo: {
    ...StyleSheet.absoluteFill,
    width: '100%',
    height: '100%',
  },
});
