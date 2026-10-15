import type { KeyValueStore } from './suppressionJournal';
import type { OrphanStore } from './scheduleReconciliation';

export const ORPHANED_NOTIFICATIONS_KEY = 'already-up/orphaned-notifications/v1';

/** Strict version 1 parser; throws on anything that cannot be trusted. */
export function parseOrphanJournal(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  const value = JSON.parse(raw) as { version?: unknown; ids?: unknown } | null;
  const ids = value?.ids;
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === 'string' && id !== '')
  ) {
    throw new Error('orphaned notification journal is unreadable');
  }
  return ids as string[];
}

/**
 * Scheduled notification ids that a failed save could not roll back. They are
 * not in the alarm definitions, so this is the only place that can find them
 * again; reconciliation cancels them once they are still this app's.
 */
export function createOrphanStore(
  store: KeyValueStore,
  key: string = ORPHANED_NOTIFICATIONS_KEY,
): OrphanStore {
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Only a missing value is an empty journal. Anything else that cannot be
   * trusted (read failure, bad JSON, other version, bad ids) rejects, so a
   * mutation never overwrites ids this build cannot interpret.
   */
  async function read(): Promise<string[]> {
    return parseOrphanJournal(await store.getItem(key));
  }

  function mutate(change: (ids: Set<string>) => void): Promise<void> {
    const operation = queue.then(async () => {
      const ids = new Set(await read());
      change(ids);
      await store.setItem(key, JSON.stringify({ version: 1, ids: [...ids] }));
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return {
    load: async () => {
      await queue;
      return read();
    },
    add: (ids) => mutate((set) => ids.forEach((id) => set.add(id))),
    remove: (ids) => mutate((set) => ids.forEach((id) => set.delete(id))),
  };
}
