import type {
  SuppressionIntent,
  SuppressionJournal,
} from './alarmOrchestrator';
import { MAX_ALARM_COUNT } from './alarmSchedule';
import { AppError } from './errorCatalog';

export const SUPPRESSION_JOURNAL_KEY = 'already-up/suppression-journal/v1';

/** The subset of AsyncStorage the journal needs, so tests can inject a fake. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface SuppressionJournalV1 {
  version: 1;
  entries: SuppressionIntent[];
}

// A cycle needs at most one entry; a few cycles per alarm can be in flight.
const MAX_ENTRIES = MAX_ALARM_COUNT * 8;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSuppressionIntent(value: unknown): value is SuppressionIntent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const intent = value as Partial<SuppressionIntent>;
  const state = intent.suppressed;
  return (
    isNonEmptyString(intent.cycleId) &&
    isNonEmptyString(intent.alarmId) &&
    isNonEmptyString(intent.mainAlarmId) &&
    (intent.checkInNotificationId === undefined ||
      isNonEmptyString(intent.checkInNotificationId)) &&
    isFiniteNumber(intent.armedAtMs) &&
    isFiniteNumber(intent.dueAtMs) &&
    (intent.stage === 'cancelling' || intent.stage === 'cancelled') &&
    !!state &&
    typeof state === 'object' &&
    // The state to restore must describe exactly the intended cycle.
    state.phase === 'suppressed' &&
    state.cycleId === intent.cycleId &&
    state.alarmId === intent.alarmId &&
    state.mainAlarmId === intent.mainAlarmId &&
    state.checkInNotificationId === intent.checkInNotificationId &&
    state.armedAtMs === intent.armedAtMs &&
    state.dueAtMs === intent.dueAtMs &&
    isFiniteNumber(state.stepCount) &&
    typeof state.stepCandidateRecorded === 'boolean' &&
    (state.suppressedBy === undefined ||
      (state.suppressedBy === 'user_skip' && isFiniteNumber(state.skippedAtMs)))
  );
}

function isJournal(value: unknown): value is SuppressionJournalV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const journal = value as Partial<SuppressionJournalV1>;
  return (
    journal.version === 1 &&
    Array.isArray(journal.entries) &&
    journal.entries.length <= MAX_ENTRIES &&
    journal.entries.every(isSuppressionIntent) &&
    new Set(journal.entries.map((entry) => entry.cycleId)).size ===
      journal.entries.length
  );
}

/** Strictly validated read for recovery code; unreadable data yields null. */
export function readValidSuppressionIntents(
  raw: string,
): SuppressionIntent[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJournal(parsed) ? parsed.entries : null;
  } catch {
    return null;
  }
}

/**
 * Durable record of suppressions that may be half done. Every mutation is
 * serialised and validated; unreadable data rejects and is never overwritten,
 * because it may be the only evidence that an alarm was cancelled.
 */
export function createSuppressionJournal(
  store: KeyValueStore,
  key: string = SUPPRESSION_JOURNAL_KEY,
  options: { beforeRecord?: () => Promise<void> } = {},
): SuppressionJournal {
  let queue: Promise<unknown> = Promise.resolve();
  let lock: Promise<unknown> = Promise.resolve();

  async function read(): Promise<SuppressionIntent[]> {
    const raw = await store.getItem(key);
    if (!raw) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError('STORAGE_JOURNAL_CORRUPT');
    }
    if (!isJournal(parsed)) {
      throw new AppError('STORAGE_JOURNAL_CORRUPT');
    }
    return parsed.entries;
  }

  function mutate(
    update: (entries: SuppressionIntent[]) => SuppressionIntent[],
    before?: () => Promise<void>,
  ): Promise<void> {
    const operation = queue.then(async () => {
      await before?.();
      const entries = update(await read());
      if (entries.length === 0) {
        await store.removeItem(key);
        return;
      }
      const journal: SuppressionJournalV1 = { version: 1, entries };
      if (!isJournal(journal)) {
        throw new AppError('STORAGE_JOURNAL_SAVE_FAILED');
      }
      await store.setItem(key, JSON.stringify(journal));
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return {
    record: (intent) =>
      mutate(
        (entries) => [
          ...entries.filter((entry) => entry.cycleId !== intent.cycleId),
          intent,
        ],
        options.beforeRecord,
      ),
    load: () => {
      const operation = queue.then(read);
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    exclusive: (run) => {
      const operation = lock.then(run);
      lock = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    clear: (cycleId) =>
      mutate((entries) => entries.filter((entry) => entry.cycleId !== cycleId)),
  };
}
