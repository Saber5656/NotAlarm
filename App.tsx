import {
  initialWindowMetrics,
  SafeAreaProvider,
} from 'react-native-safe-area-context';

import { AlarmApp } from './src/app/AlarmApp';

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AlarmApp />
    </SafeAreaProvider>
  );
}
