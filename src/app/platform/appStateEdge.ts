import { AppState, type AppStateStatus } from 'react-native';

export type { AppStateStatus };

/** The app's current foreground/background state, read at call time. */
export function currentAppState(): AppStateStatus {
  return AppState.currentState;
}

/** Subscribes to app state changes; the returned function unsubscribes. */
export function subscribeAppState(
  listener: (state: AppStateStatus) => void,
): () => void {
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}
