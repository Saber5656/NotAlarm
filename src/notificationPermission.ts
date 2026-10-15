import { AppError } from './errorCatalog';

export interface NotificationPermissionGateway {
  getPermission(): Promise<{ status: string }>;
  requestPermission(): Promise<{ status: string }>;
}

/**
 * Asks for notification permission, telling "the user said no" apart from
 * "the state could not be read". Either way nothing has been reserved yet, and
 * a read failure is never treated as a grant. The prompt is shown at most once
 * per call and nothing is retried here.
 */
export async function ensureNotificationPermission(
  gateway: NotificationPermissionGateway,
): Promise<void> {
  let status: string;
  try {
    const current = await gateway.getPermission();
    status =
      current.status === 'granted'
        ? current.status
        : (await gateway.requestPermission()).status;
  } catch (error) {
    throw new AppError('NTF_PERMISSION_CHECK_FAILED', error);
  }
  if (status !== 'granted') {
    throw new AppError('NTF_PERMISSION_DENIED');
  }
}
