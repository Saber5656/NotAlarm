import { Pedometer } from 'expo-sensors';

export interface PedometerEdge {
  isAvailable(): Promise<boolean>;
  requestPermission(): Promise<{ status: string }>;
  /** Counts steps taken since the call; `remove` stops the subscription. */
  watch(onSteps: (steps: number) => void): { remove(): void };
}

export const pedometerEdge: PedometerEdge = {
  isAvailable: () => Pedometer.isAvailableAsync(),
  requestPermission: () => Pedometer.requestPermissionsAsync(),
  watch: (onSteps) =>
    Pedometer.watchStepCount(({ steps }) => {
      onSteps(steps);
    }),
};
