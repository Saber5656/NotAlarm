/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SuppressionIntent } from '../src/alarmOrchestrator';
import type { StoredAlarm } from '../src/alarmStorage';
import { createSuppressionReconciler } from '../src/app/core/suppressionReconciler';
import {
  createSuppressionJournal,
  type KeyValueStore,
} from '../src/suppressionJournal';

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

function cycleOf(cycleId: string): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId,
    mainAlarmId: `main-${cycleId}`,
    checkInNotificationId: `check-${cycleId}`,
    armedAtMs: 1_000,
    dueAtMs: 100_000,
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function intentOf(
  cycleId: string,
  stage: 'cancelling' | 'cancelled',
): SuppressionIntent {
  const base = cycleOf(cycleId);
  return {
    cycleId,
    alarmId: base.alarmId,
    mainAlarmId: base.mainAlarmId,
    checkInNotificationId: base.checkInNotificationId,
    armedAtMs: base.armedAtMs,
    dueAtMs: base.dueAtMs,
    stage,
    suppressed: { ...base, phase: 'suppressed', confirmedAtMs: 60_000 },
  };
}

function harness(options: { failSave?: boolean; failCancel?: boolean } = {}) {
  const journal = createSuppressionJournal(memoryStore());
  const stored = new Map<string, StoredAlarm>();
  const calls: string[] = [];
  let loads = 0;
  const reconcile = createSuppressionReconciler({
    journal,
    loadAlarm: async (cycleId) => {
      loads += 1;
      calls.push(`load:${cycleId}`);
      await Promise.resolve();
      return stored.get(cycleId) ?? null;
    },
    saveAlarm: async (cycle) => {
      calls.push(`save:${cycle.cycleId}`);
      if (options.failSave) throw new Error('disk full');
      stored.set(cycle.cycleId, cycle);
    },
    listScheduledIds: async () => new Set<string>(),
    cancelCheckIn: async (id) => {
      calls.push(`cancel:${id}`);
      if (options.failCancel) throw new Error('already gone');
    },
  });
  return { journal, stored, calls, reconcile, loadCount: () => loads };
}

test('with nothing journaled the state is ok and nothing is cancelled', async () => {
  const { reconcile, calls } = harness();
  assert.deepEqual(await reconcile(), { state: 'ok', recovered: 0 });
  assert.deepEqual(calls, []);
});

test('a confirmed cancellation is saved, cleared, and only its own check-in is cancelled', async () => {
  const { journal, stored, calls, reconcile } = harness();
  stored.set('c1', cycleOf('c1'));
  await journal.record(intentOf('c1', 'cancelled'));

  assert.deepEqual(await reconcile(), { state: 'ok', recovered: 1 });
  assert.equal(stored.get('c1')?.phase, 'suppressed');
  assert.deepEqual(await journal.load(), []);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('cancel:')),
    ['cancel:check-c1'],
  );
});

test('a cancel failure of the check-in never changes the recovered state', async () => {
  const { journal, stored, reconcile } = harness({ failCancel: true });
  stored.set('c1', cycleOf('c1'));
  await journal.record(intentOf('c1', 'cancelled'));
  assert.deepEqual(await reconcile(), { state: 'ok', recovered: 1 });
});

test('a stop that cannot be saved is reported as save_failed and stays journaled for retry', async () => {
  const { journal, stored, reconcile } = harness({ failSave: true });
  stored.set('c1', cycleOf('c1'));
  await journal.record(intentOf('c1', 'cancelled'));

  assert.deepEqual(await reconcile(), { state: 'save_failed', recovered: 0 });
  assert.equal((await journal.load()).length, 1);
});

test('an unreadable journal is treated as unknown and the next call retries', async () => {
  let readable = false;
  const base = createSuppressionJournal(memoryStore());
  const journal = {
    ...base,
    load: async () => {
      if (!readable) throw new Error('corrupt');
      return base.load();
    },
  };
  const reconcile = createSuppressionReconciler({
    journal,
    loadAlarm: async () => null,
    saveAlarm: async () => undefined,
    listScheduledIds: async () => new Set<string>(),
    cancelCheckIn: async () => undefined,
  });

  assert.deepEqual(await reconcile(), { state: 'status_unknown', recovered: 0 });
  readable = true;
  assert.deepEqual(await reconcile(), { state: 'ok', recovered: 0 });
});

test('concurrent callers share one run, and a later call starts a fresh one', async () => {
  const { journal, stored, reconcile, loadCount } = harness();
  stored.set('c1', cycleOf('c1'));
  await journal.record(intentOf('c1', 'cancelled'));

  const first = reconcile();
  const second = reconcile();
  assert.equal(first, second, 'the in-flight promise is shared');
  assert.deepEqual(await first, { state: 'ok', recovered: 1 });
  assert.equal(loadCount(), 1);

  // Settled: the flight is released, so this is a new run over an empty journal.
  const third = reconcile();
  assert.notEqual(third, first);
  assert.deepEqual(await third, { state: 'ok', recovered: 0 });
});
