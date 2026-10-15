import type { Messages } from './i18n/messages';
import type { StorageResetService } from './storageReset';

export type LocalDataDeletionOutcome =
  | { kind: 'deleted'; ambiguousCount: number }
  | { kind: 'failed' };

/**
 * User-initiated deletion of this app's local data and its own notifications.
 * It is the same service as the corruption recovery reset. Stored data is only
 * removed after cancellation is verified, but a failure can still come midway
 * (some notifications cancelled, or some keys removed). The durable intent then
 * stays, alarm writes are refused, and running the deletion again resumes it.
 */
export async function deleteAllLocalData(
  service: Pick<StorageResetService, 'reset'>,
): Promise<LocalDataDeletionOutcome> {
  try {
    const { ambiguousCount } = await service.reset();
    return { kind: 'deleted', ambiguousCount };
  } catch {
    return { kind: 'failed' };
  }
}

export type LocalDataDeletionAvailability =
  | { allowed: true }
  | { allowed: false; reason: string };

export function getLocalDataDeletionAvailability(
  {
    isRinging,
    isBusy,
    isLoaded,
  }: {
    isRinging: boolean;
    isBusy: boolean;
    isLoaded: boolean;
  },
  messages: Messages,
): LocalDataDeletionAvailability {
  if (isRinging) {
    return { allowed: false, reason: messages.settings.blockedRinging };
  }
  if (isBusy) {
    return { allowed: false, reason: messages.settings.blockedBusy };
  }
  if (!isLoaded) {
    return { allowed: false, reason: messages.settings.blockedLoading };
  }
  return { allowed: true };
}

/**
 * Settings stay open while a deletion runs, so its outcome cannot be missed.
 * `deletionInFlight` must come from a ref, not render-time state, so back,
 * backdrop and close read the current value.
 */
export function canCloseSettings({
  deletionInFlight,
}: {
  deletionInFlight: boolean;
}): boolean {
  return !deletionInFlight;
}
