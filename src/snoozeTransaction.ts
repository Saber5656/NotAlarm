import { replaceStoredCycle } from './alarmDefinitionMutations';
import type { StoredAlarmDefinition } from './alarmStorage';
import type { SnoozeStore } from './snooze';

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
      await transact(async (current, checkpoint) => {
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
        throw new Error('スヌーズの処理が完了しませんでした。');
      }
      return result as T;
    });
  };
}
