import {
  AccessibilityInfo,
  findNodeHandle,
  Platform,
  type View,
} from 'react-native';

/** Moves screen-reader focus to the element behind `ref`, when it is mounted. */
export function focusElement(ref: { current: View | null }): void {
  const handle = findNodeHandle(ref.current);
  if (handle) {
    AccessibilityInfo.setAccessibilityFocus(handle);
  }
}

/** Polite announcement; focus is never moved. */
export function announcePolitely(text: string): void {
  if (Platform.OS === 'web') {
    return;
  }
  if (Platform.OS === 'ios') {
    // Queue behind current VoiceOver speech instead of interrupting it.
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
  } else {
    AccessibilityInfo.announceForAccessibility(text);
  }
}
