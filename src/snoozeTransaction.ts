import { replaceStoredCycle } from './alarmDefinitionMutations';
import type { StoredAlarmDefinition } from './alarmStorage';
import { AppError } from './errorCatalog';
import type { SnoozeStore } from './snooze';
import { stampStorageResult } from './storageResetGate';

type TransactAlarmDefinitions = (
  transaction: (
    current: StoredAlarmDefinition[],
    checkpoint: (next: StoredAlarmDefinition[]) => Promise<void>,
  ) => Promise<StoredAlarmDefinition[]>,
) => Promise<StoredAlarmDefinition[]>;

export interface SnoozeTransactionDependencies {
  /** The outer lock (the suppression journal's), taken before the storage queue. */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  /** The storage queue turn; re-checks a pending reset before it starts. */
  transact: TransactAlarmDefinitions;
}

/**
 * One snooze, stop or recovery as a single storage transaction in the order
 * every other writer uses: outer lock, then the storage queue. Inside it the
 * service reads and writes a snapshot owned by the transaction, each write a
 * checkpoint (which re-checks a pending reset), so nothing inside waits on the
 * queue it already holds. The snapshot only advances after a checkpoint
 * succeeded, so a refused write is never mistaken for a stored one.
 *
 * A snooze or stop that took effect carries the definitions it committed as
 * `alarms`, stamped with the storage epoch under the same lock. The screen
 * applies that exact snapshot before any fallible reload or refill; a reset
 * that finishes afterwards makes it stale, so it can never bring deleted data
 * back, and nothing here copies older alarms forward.
 */
export function createSnoozeTransaction({
  exclusive,
  transact,
}: SnoozeTransactionDependencies) {
  return function snoozeTransaction<T>(
    run: (store: SnoozeStore) => Promise<T>,
  ): Promise<T> {
    return exclusive(async () => {
      let result: T | undefined;
      let finished = false;
      const committed = await transact(async (current, checkpoint) => {
        let snapshot = current;
        const store: SnoozeStore = {
          load: async (cycleId) =>
            snapshot
              .flatMap((alarm) => alarm.cycles)
              .find((cycle) => cycle.cycleId === cycleId) ?? null,
          save: async (cycle) => {
            const next = replaceStoredCycle(snapshot, cycle);
            await checkpoint(next);
            snapshot = next;
          },
          loadAll: async () => snapshot,
        };
        result = await run(store);
        finished = true;
        return snapshot;
      });
      if (!finished) {
        throw new AppError('SNOOZE_UNEXPECTED_FAILURE');
      }
      return withCommittedSnapshot(result as T, committed);
    });
  };
}

/** Only a result that changed the screen's truth carries the snapshot. */
function withCommittedSnapshot<T>(
  result: T,
  committed: StoredAlarmDefinition[],
): T {
  const status = (result as { status?: unknown } | null)?.status;
  if (status !== 'snoozed' && status !== 'stopped') {
    return result;
  }
  return { ...result, alarms: stampStorageResult(committed) };
}
