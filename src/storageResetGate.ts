/**
 * Process-wide guard for an unfinished "delete all data". A reset removes
 * several keys one by one, so a failure can leave some gone and some present;
 * until a retry finishes, nothing may write alarm state or reserve
 * notifications, or it would bring deleted data back. The check runs inside the
 * storage locks, at the moment of the actual operation, so a stale dialog or
 * an in-flight task cannot skip it.
 */
export class StorageResetPendingError extends Error {
  readonly code = 'STORAGE_RESET_PENDING' as const;
  constructor() {
    super(
      'データの削除が途中で止まっています。設定の「データを削除」をもう一度実行して完了させてください。',
    );
    this.name = 'StorageResetPendingError';
  }
}

export function isStorageResetPendingError(
  error: unknown,
): error is StorageResetPendingError {
  return error instanceof StorageResetPendingError;
}

let isPending: () => Promise<boolean> = async () => false;
let epoch = 0;
const producedIn = new WeakMap<object, number>();

export function installStorageResetGate(
  hasPendingReset: () => Promise<boolean>,
): void {
  isPending = hasPendingReset;
}

/** Throws StorageResetPendingError while an earlier reset is unfinished. */
export async function assertNoPendingReset(): Promise<void> {
  if (await isPending()) {
    throw new StorageResetPendingError();
  }
}

/** Called under the storage locks when a reset has fully finished. */
export function advanceStorageEpoch(): void {
  epoch += 1;
}

/** Remembers which reset generation produced a stored result. */
export function stampStorageResult<T extends object>(value: T): T {
  producedIn.set(value, epoch);
  return value;
}

/**
 * True when the result was read or written before a reset that has since
 * finished, so showing it would resurrect deleted alarms in memory.
 * Values that never came from storage are never stale.
 */
export function isStaleStorageResult(value: object): boolean {
  const stamped = producedIn.get(value);
  return stamped !== undefined && stamped !== epoch;
}
