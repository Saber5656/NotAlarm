import { Linking } from 'react-native';

export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}
