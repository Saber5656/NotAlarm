import type { PedometerState } from './homeStatus';

export interface PedometerAccessGateway {
  isAvailable(): Promise<boolean>;
  requestPermission(): Promise<{ status: string }>;
}

/**
 * Availability, permission and the later step reads fail in different ways
 * with different recovery, so each outcome is its own state. A call that
 * throws is "unknown", never "denied" or "unavailable".
 */
export async function resolvePedometerAccess(
  gateway: PedometerAccessGateway,
): Promise<'ready' | Exclude<PedometerState, 'preparing' | 'counting' | 'error'>> {
  let available: boolean;
  try {
    available = await gateway.isAvailable();
  } catch {
    return 'availability_unknown';
  }
  if (!available) {
    return 'unavailable';
  }
  try {
    const permission = await gateway.requestPermission();
    return permission.status === 'granted' ? 'ready' : 'denied';
  } catch {
    return 'permission_unknown';
  }
}
