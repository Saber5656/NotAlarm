import type { KeyValueStore } from './suppressionJournal';
import { CHECK_IN_KIND, MAIN_ALARM_KIND } from './alarmContracts';
import type { OrphanExpectation, OrphanStore } from './scheduleReconciliation';

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
 * Optional exact payloads recorded next to the ids (journal version 1 with an
 * extra `exact` map). Older journals have none; a malformed entry is dropped,
 * which only means that id is not cancelled when it lacks the owner marker.
 */
export function parseOrphanExact(
  raw: string | null | undefined,
): Record<string, OrphanExpectation> {
  if (raw === null || raw === undefined) {
    return {};
  }
  const exact = (JSON.parse(raw) as { exact?: unknown } | null)?.exact;
  if (typeof exact !== 'object' || exact === null || Array.isArray(exact)) {
    return {};
  }
  const result: Record<string, OrphanExpectation> = {};
  for (const [id, value] of Object.entries(exact)) {
    const { kind, alarmId, cycleId, mainAlarmId } = (value ?? {}) as Record<
      string,
      unknown
    >;
    if (
      (kind === MAIN_ALARM_KIND || kind === CHECK_IN_KIND) &&
      typeof alarmId === 'string' &&
      alarmId !== '' &&
      typeof cycleId === 'string' &&
      cycleId !== '' &&
      (mainAlarmId === undefined || typeof mainAlarmId === 'string')
    ) {
      result[id] = {
        kind,
        alarmId,
        cycleId,
        ...(mainAlarmId === undefined ? {} : { mainAlarmId }),
      };
    }
  }
  return result;
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
  async function read(): Promise<{
    ids: string[];
    exact: Record<string, OrphanExpectation>;
  }> {
    const raw = await store.getItem(key);
    return { ids: parseOrphanJournal(raw), exact: parseOrphanExact(raw) };
  }

  function mutate(
    change: (
      ids: Set<string>,
      exact: Record<string, OrphanExpectation>,
    ) => void,
  ): Promise<void> {
    const operation = queue.then(async () => {
      const current = await read();
      const ids = new Set(current.ids);
      const exact = current.exact;
      change(ids, exact);
      for (const id of Object.keys(exact)) {
        if (!ids.has(id)) {
          delete exact[id];
        }
      }
      const journal: Record<string, unknown> = { version: 1, ids: [...ids] };
      if (Object.keys(exact).length > 0) {
        journal.exact = exact;
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
    load: async () => {
      await queue;
      return (await read()).ids;
    },
    loadExact: async () => {
      await queue;
      return (await read()).exact;
    },
    add: (ids, records) =>
      mutate((set, exact) => {
        ids.forEach((id) => set.add(id));
        for (const id of ids) {
          if (records?.[id]) {
            exact[id] = records[id];
          }
        }
      }),
    remove: (ids) => mutate((set) => ids.forEach((id) => set.delete(id))),
  };
}
