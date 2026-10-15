import * as Location from 'expo-location';

import type {
  LocationGateway,
  LocationPermission,
} from './sunBackgroundController';

function toPermission(response: Location.LocationPermissionResponse) {
  return (
    response.granted
      ? 'granted'
      : response.canAskAgain && response.status === 'undetermined'
        ? 'undetermined'
        : 'denied'
  ) satisfies LocationPermission;
}

/**
 * Foreground, one-shot, approximate (about 3 km) reading. There is no watcher,
 * no background task and no geocoding; the caller rounds before saving.
 */
export const expoLocationGateway: LocationGateway = {
  getPermission: async () =>
    toPermission(await Location.getForegroundPermissionsAsync()),
  requestPermission: async () =>
    toPermission(await Location.requestForegroundPermissionsAsync()),
  getApproximatePosition: async () => {
    const { coords } = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Lowest,
    });
    return { latitude: coords.latitude, longitude: coords.longitude };
  },
};
