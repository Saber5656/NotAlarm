/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { SuppressionIntent } from '../src/alarmOrchestrator';
import {
  SUPPRESSION_JOURNAL_KEY,
  createSuppressionJournal,
  type KeyValueStore,
} from '../src/suppressionJournal';

function memoryStore(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(SUPPRESSION_JOURNAL_KEY, initial);
  }
  let failWrites = false;
  let writeDelay = 0;
  const store: KeyValueStore = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      if (writeDelay) await new Promise((r) => setTimeout(r, writeDelay));
      if (failWrites) throw new Error('disk full');
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return {
    data,
    store,
    setFailWrites: (v: boolean) => {
      failWrites = v;
    },
    setWriteDelay: (v: number) => {
      writeDelay = v;
    },
  };
}

function intent(cycleId: string, stage: 'cancelling' | 'cancelled' = 'cancelling'): SuppressionIntent {
  const base = {
    alarmId: 'alarm-1',
    cycleId,
    mainAlarmId: `main-${cycleId}`,
    checkInNotificationId: `check-${cycleId}`,
    armedAtMs: 1_000,
    dueAtMs: 100_000,
    stepCount: 0,
    stepCandidateRecorded: false,
  };
  return {
    cycleId,
    alarmId: 'alarm-1',
    mainAlarmId: base.mainAlarmId,
    checkInNotificationId: base.checkInNotificationId,
    armedAtMs: 1_000,
    dueAtMs: 100_000,
    stage,
    suppressed: { ...base, phase: 'suppressed', confirmedAtMs: 60_000 },
  };
}

describe('createSuppressionJournal', () => {
  test('persists, upserts by cycleId and clears', async () => {
    const { data, store } = memoryStore();
    const journal = createSuppressionJournal(store);
    assert.deepEqual(await journal.load(), []);

    await journal.record(intent('c1'));
    await journal.record(intent('c2'));
    await journal.record(intent('c1', 'cancelled'));
    const loaded = await journal.load();
    assert.deepEqual(
      loaded.map((entry) => [entry.cycleId, entry.stage]),
      [
        ['c2', 'cancelling'],
        ['c1', 'cancelled'],
      ],
    );

    await journal.clear('c1');
    await journal.clear('c2');
    assert.equal(data.has(SUPPRESSION_JOURNAL_KEY), false);
  });

  test('a fresh journal instance reads what a previous one wrote', async () => {
    const { store } = memoryStore();
    await createSuppressionJournal(store).record(intent('c1', 'cancelled'));
    const loaded = await createSuppressionJournal(store).load();
    assert.equal(loaded[0]?.stage, 'cancelled');
  });

  test('serialises concurrent mutations without losing entries', async () => {
    const { store, setWriteDelay } = memoryStore();
    setWriteDelay(5);
    const journal = createSuppressionJournal(store);
    await Promise.all([
      journal.record(intent('c1')),
      journal.record(intent('c2')),
      journal.record(intent('c3')),
    ]);
    assert.equal((await journal.load()).length, 3);
    await Promise.all([journal.clear('c1'), journal.record(intent('c4'))]);
    assert.deepEqual(
      (await journal.load()).map((entry) => entry.cycleId).sort(),
      ['c2', 'c3', 'c4'],
    );
  });

  test('a failed write rejects and leaves earlier entries intact', async () => {
    const { store, setFailWrites } = memoryStore();
    const journal = createSuppressionJournal(store);
    await journal.record(intent('c1'));
    setFailWrites(true);
    await assert.rejects(journal.record(intent('c2')));
    setFailWrites(false);
    assert.deepEqual(
      (await journal.load()).map((entry) => entry.cycleId),
      ['c1'],
    );
    // the queue keeps working after a failure
    await journal.record(intent('c2'));
    assert.equal((await journal.load()).length, 2);
  });

  test('corrupt or invalid stored data rejects and is never overwritten', async () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: [{ cycleId: 'x' }] }),
      JSON.stringify({
        version: 1,
        entries: [{ ...intent('c1'), stage: 'weird' }],
      }),
      // embedded state must be a suppressed state for the same ids
      JSON.stringify({
        version: 1,
        entries: [{ ...intent('c1'), suppressed: { ...intent('c1').suppressed, phase: 'armed' } }],
      }),
      JSON.stringify({
        version: 1,
        entries: [{ ...intent('c1'), suppressed: { ...intent('c1').suppressed, mainAlarmId: 'other' } }],
      }),
      JSON.stringify({ version: 1, entries: [intent('c1'), intent('c1')] }),
    ]) {
      const { data, store } = memoryStore(raw);
      const journal = createSuppressionJournal(store);
      await assert.rejects(journal.load(), raw);
      await assert.rejects(journal.record(intent('c9')), raw);
      await assert.rejects(journal.clear('c1'), raw);
      assert.equal(data.get(SUPPRESSION_JOURNAL_KEY), raw, 'record kept as-is');
    }
  });

  test('rejects recording an invalid intent', async () => {
    const { store } = memoryStore();
    const journal = createSuppressionJournal(store);
    await assert.rejects(
      journal.record({ ...intent('c1'), dueAtMs: Number.NaN }),
    );
  });
});
