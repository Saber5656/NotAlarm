import {
  isAmbiguousAlarmNotification,
  isOwnedAlarmNotification,
} from './alarmNotificationOwnership';
import type { ScheduledNotificationSnapshot } from './alarmNotificationOwnership';
import {
  ACTIVE_ALARM_STORAGE_KEY,
  ALARM_CANCELLATION_JOURNAL_KEY,
  ALARM_DEFINITIONS_STORAGE_KEY,
  readValidAlarmDefinitions,
  readValidLegacyAlarm,
} from './alarmStorage';
import {
  ORPHANED_NOTIFICATIONS_KEY,
  parseOrphanJournal,
} from './orphanedNotifications';
import { PLANNING_ZONE_KEY } from './planningZone';
import {
  SUPPRESSION_JOURNAL_KEY,
  readValidSuppressionIntents,
  type KeyValueStore,
} from './suppressionJournal';

export const STORAGE_RESET_INTENT_KEY = 'already-up/storage-reset-intent/v1';
/** Survives restarts after a reset that left unidentifiable notifications. */
export const STORAGE_RESET_LIMITATION_KEY =
  'already-up/storage-reset-limitation/v1';

/**
 * Every key that holds alarm state; the intent key is removed after them.
 * Any new persisted store (e.g. the edit journal, the orphan journal) must be
 * added here and have its notification ids read in readOwnedIds, otherwise
 * "delete all data" leaves it behind. See docs/PRIVACY.md.
 */
const ALARM_STORAGE_KEYS = [
  ALARM_DEFINITIONS_STORAGE_KEY,
  ACTIVE_ALARM_STORAGE_KEY,
  ALARM_CANCELLATION_JOURNAL_KEY,
  SUPPRESSION_JOURNAL_KEY,
  // Marked orphans are cancelled with the other owned requests above; the
  // journal is dropped only with the rest, after cancellation is confirmed.
  ORPHANED_NOTIFICATIONS_KEY,
  // Not alarm data, but local state; a missing zone is simply a no-op.
  PLANNING_ZONE_KEY,
] as const;

const MAX_REMEMBERED_IDS = 1_000;

export interface StorageResetGateway {
  listScheduled(): Promise<ScheduledNotificationSnapshot[]>;
  /** Must cancel exactly this identifier; never the whole shared queue. */
  cancelScheduled(notificationId: string): Promise<void>;
}

export interface StorageResetDependencies {
  store: KeyValueStore;
  gateway: StorageResetGateway;
  /** Serialises the reset against stops, adds and recovery in this process. */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  nowMs(): number;
  /** Runs under the lock once every key and the intent are gone. */
  onCompleted?(): void;
}

export interface StorageResetService {
  /** Explicit user action only. Throws unless cancellation was confirmed. */
  reset(): Promise<StorageResetResult>;
  /**
   * Count of older-looking notifications that could not be proven ours and
   * were left scheduled. Self-clears once none remain.
   */
  readAmbiguousCount(): Promise<number>;
  /** True while an earlier reset was started but not finished. */
  hasPendingReset(): Promise<boolean>;
}

export interface StorageResetResult {
  /** Unmarked, unidentifiable notifications left in place; they may still ring. */
  ambiguousCount: number;
}

export class StorageResetIncompleteError extends Error {
  constructor() {
    super(
      '削除を最後まで完了できませんでした。一部の通知やデータはすでに消えている場合があります。もう一度実行すると続きから再開します。',
    );
    this.name = 'StorageResetIncompleteError';
  }
}

interface StorageResetIntentV1 {
  version: 1;
  requestedAtMs: number;
  /** Exact identifiers read from valid storage before it is cleared. */
  ownedIds: string[];
}

function readIntent(raw: string | null): StorageResetIntentV1 | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<StorageResetIntentV1>;
    if (
      value?.version === 1 &&
      typeof value.requestedAtMs === 'number' &&
      Number.isFinite(value.requestedAtMs) &&
      Array.isArray(value.ownedIds) &&
      value.ownedIds.length <= MAX_REMEMBERED_IDS &&
      value.ownedIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      return value as StorageResetIntentV1;
    }
  } catch {
    // An unreadable intent is rewritten below; the reset was user-initiated.
  }
  return null;
}

/** Identifiers from sources that validate on their own; nothing is guessed. */
async function readOwnedIds(store: KeyValueStore): Promise<string[]> {
  const ids = new Set<string>();
  const add = (id: string | undefined) => {
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  };

  const definitions = await store.getItem(ALARM_DEFINITIONS_STORAGE_KEY);
  for (const alarm of (definitions && readValidAlarmDefinitions(definitions)) ||
    []) {
    for (const cycle of alarm.cycles) {
      add(cycle.mainAlarmId);
      add(cycle.checkInNotificationId);
    }
  }

  const legacy = await store.getItem(ACTIVE_ALARM_STORAGE_KEY);
  const legacyAlarm = legacy ? readValidLegacyAlarm(legacy) : null;
  if (legacyAlarm) {
    add(legacyAlarm.mainAlarmId);
    add(legacyAlarm.checkInNotificationId);
  }

  const suppression = await store.getItem(SUPPRESSION_JOURNAL_KEY);
  for (const intent of (suppression &&
    readValidSuppressionIntents(suppression)) ||
    []) {
    add(intent.mainAlarmId);
    add(intent.checkInNotificationId);
  }

  // A valid journal can hold this app's legacy unmarked main, whose id the
  // stored cycle no longer carries. An untrusted journal contributes nothing.
  try {
    for (const id of parseOrphanJournal(
      await store.getItem(ORPHANED_NOTIFICATIONS_KEY),
    )) {
      add(id);
    }
  } catch {
    // Only namespace-owned requests are cancelled; the rest stays ambiguous.
  }

  return [...ids];
}

export function createStorageResetService({
  store,
  gateway,
  exclusive,
  nowMs,
  onCompleted,
}: StorageResetDependencies): StorageResetService {
  async function ownedScheduledIds(
    knownIds: ReadonlySet<string>,
  ): Promise<string[]> {
    const scheduled = await gateway.listScheduled();
    return scheduled
      .filter(
        (request) =>
          knownIds.has(request.identifier) || isOwnedAlarmNotification(request),
      )
      .map((request) => request.identifier);
  }

  async function countAmbiguous(
    knownIds: ReadonlySet<string>,
  ): Promise<number> {
    return (await gateway.listScheduled()).filter(
      (request) =>
        !knownIds.has(request.identifier) &&
        isAmbiguousAlarmNotification(request),
    ).length;
  }

  async function performReset(): Promise<StorageResetResult> {
    const previous = readIntent(await store.getItem(STORAGE_RESET_INTENT_KEY));
    const knownIds = new Set([
      ...(previous?.ownedIds ?? []),
      ...(await readOwnedIds(store)),
    ]);
    const intent: StorageResetIntentV1 = {
      version: 1,
      requestedAtMs: previous?.requestedAtMs ?? nowMs(),
      ownedIds: [...knownIds].slice(0, MAX_REMEMBERED_IDS),
    };
    // Durable before any cancellation, so a crash can be retried.
    await store.setItem(STORAGE_RESET_INTENT_KEY, JSON.stringify(intent));

    for (const id of await ownedScheduledIds(knownIds)) {
      try {
        await gateway.cancelScheduled(id);
      } catch {
        // Confirmed below by reading the queue again.
      }
    }

    if ((await ownedScheduledIds(knownIds)).length > 0) {
      throw new StorageResetIncompleteError();
    }

    const ambiguousCount = await countAmbiguous(knownIds);
    if (ambiguousCount > 0) {
      await store.setItem(
        STORAGE_RESET_LIMITATION_KEY,
        JSON.stringify({ version: 1 }),
      );
    } else {
      await store.removeItem(STORAGE_RESET_LIMITATION_KEY);
    }
    for (const key of ALARM_STORAGE_KEYS) {
      await store.removeItem(key);
    }
    await store.removeItem(STORAGE_RESET_INTENT_KEY);
    onCompleted?.();
    return { ambiguousCount };
  }

  return {
    reset: () => exclusive(performReset),
    readAmbiguousCount: async () => {
      if ((await store.getItem(STORAGE_RESET_LIMITATION_KEY)) === null) {
        return 0;
      }
      const count = await countAmbiguous(new Set());
      if (count === 0) {
        await store.removeItem(STORAGE_RESET_LIMITATION_KEY);
      }
      return count;
    },
    hasPendingReset: async () =>
      (await store.getItem(STORAGE_RESET_INTENT_KEY)) !== null,
  };
}
