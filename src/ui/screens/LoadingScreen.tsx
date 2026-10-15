import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CircadianTheme } from '../../circadianTheme';
import type { TextContext } from '../../i18n';
import { CircadianBackground } from '../CircadianBackground';

interface LoadingScreenProps {
  circadianTheme: CircadianTheme;
  text: TextContext;
}

export function LoadingScreen({ circadianTheme, text }: LoadingScreenProps) {
  const { messages } = text;
  return (
    <SafeAreaView style={styles.loadingScreen}>
      <StatusBar style="light" />
      <CircadianBackground theme={circadianTheme} />
      <ActivityIndicator color="#FFFFFF" size="large" />
      <Text style={styles.loadingText}>{messages.alarmList.loading}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#07162D',
  },
  loadingText: {
    color: 'rgba(255, 255, 255, 0.82)',
    fontSize: 14,
  },
});
