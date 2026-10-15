/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAlarmRepeat } from '../src/alarmSchedule';
import type { StoredAlarmDefinition } from '../src/alarmStorage';
import {
  createQueueReconciler,
  type QueueReconcilerDeps,
} from '../src/app/core/queueReconciler';
import {
  advanceStorageEpoch,
  stampStorageResult,
} from '../src/storageResetGate';

const NOW = new Date(2026, 7, 20, 6, 0, 0).getTime();

function alarm(id: string): StoredAlarmDefinition {
  return {
    id,
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled: true,
    createdAtMs: NOW,
    cycles: [],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Reconcile = QueueReconcilerDeps['reconcileSchedules'];

interface Options {
  isSupported?: boolean;
  resetPending?: boolean;
  stored?: StoredAlarmDefinition[];
  durable?: StoredAlarmDefinition[] | Error;
  pendingCancellations?: string[];
  pendingEdits?: string[];
  suppressionIntents?: string[];
  gate?: Promise<void>;
  /** Simulates a deletion finishing right after the turn stamped its result. */
  finishDeletionAfterTurn?: boolean;
  reconcile?: (input: Parameters<Reconcile>[0], calls: string[]) => ReturnType<Reconcile>;
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const captured: Parameters<Reconcile>[0][] = [];
  const stored = options.stored ?? [alarm('a'), alarm('b')];
  const abandoned: string[][] = [];
  const savedZones: string[] = [];
  let reconcileRuns = 0;

  const defaultReconcile: Reconcile = async (input) => {
    reconcileRuns += 1;
    captured.push(input);
    calls.push('reconcile');
    await input.readQueue();
    await options.gate;
    return {
      alarms: input.alarms,
      statuses: Object.fromEntries(input.alarms.map((a) => [a.id, 'verified' as const])),
      issues: [],
      repaired: 0,
      replanned: 0,
      queueKnown: true,
      orphansUnreadable: false,
      pendingOrphanIds: [],
    };
  };

  const deps: QueueReconcilerDeps = {
    isSupported: options.isSupported ?? true,
    nowMs: () => NOW,
    exclusive: async (run) => {
      calls.push('exclusive');
      return run();
    },
    hasPendingReset: async () => {
      calls.push('hasPendingReset');
      return options.resetPending ?? false;
    },
    assertNoPendingReset: async () => void calls.push('assertNoPendingReset'),
    gateway: {
      scheduleMain: async ({ cycleId }) => `main-${cycleId}`,
      scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
      cancelScheduled: async () => undefined,
    },
    flushUnresolved: async () => void calls.push('flushUnresolved'),
    abandonProvisional: (ids) => void abandoned.push([...ids]),
    prepareNotificationsIfGranted: async () => {
      calls.push('prepareIfGranted');
      return true;
    },
    loadPlanningZone: async () => {
      calls.push('loadPlanningZone');
      return null;
    },
    savePlanningZone: async (zone) => void savedZones.push(zone),
    storage: {
      transact: async (transaction) => {
        calls.push('transact');
        const next = await transaction(stored, async () => undefined);
        const stamped = stampStorageResult(next);
        if (options.finishDeletionAfterTurn) advanceStorageEpoch();
        return stamped;
      },
      load: async () => {
        if (options.durable instanceof Error) throw options.durable;
        return options.durable ?? stored;
      },
    },
    loadPendingAlarmCancellations: async () =>
      (options.pendingCancellations ?? []).map((alarmId) => ({ alarmId })),
    loadPendingAlarmEdits: async () =>
      (options.pendingEdits ?? []).map((alarmId) => ({ alarmId })),
    loadSuppressionIntents: async () =>
      (options.suppressionIntents ?? []).map((alarmId) => ({ alarmId })),
    readQueue: async () => {
      calls.push('readQueue');
      return { kind: 'known', entries: [] };
    },
    orphans: {
      load: async () => [],
      add: async () => undefined,
      remove: async () => undefined,
    },
    reconcileSchedules: options.reconcile
      ? (input) => options.reconcile!(input, calls)
      : defaultReconcile,
  };
  const reconcile = createQueueReconciler(deps);
  return {
    calls,
    captured,
    abandoned,
    savedZones,
    reconcile,
    stored,
    runs: () => reconcileRuns,
  };
}

test('the web build never reconciles and touches nothing', async () => {
  const h = harness({ isSupported: false });
  assert.equal(await h.reconcile(h.stored), null);
  assert.deepEqual(h.calls, []);
});

test('an unfinished reset owns the notifications: nothing is prepared, stored or read', async () => {
  const h = harness({ resetPending: true });
  const result = await h.reconcile(h.stored);
  assert.equal(result?.alarms, null);
  assert.equal(result?.aborted, false);
  assert.equal(result?.queueVerified, false);
  assert.deepEqual(h.calls, ['exclusive', 'hasPendingReset']);
});

test('lock order is suppression lock, then storage turn, and the OS queue is read inside the turn', async () => {
  const h = harness();
  const result = await h.reconcile(h.stored);
  const order = h.calls;
  assert.ok(result && !result.aborted && result.queueVerified);
  const at = (name: string) => order.indexOf(name);
  assert.ok(at('exclusive') < at('hasPendingReset'));
  assert.ok(at('hasPendingReset') < at('flushUnresolved'));
  assert.ok(at('flushUnresolved') < at('prepareIfGranted'));
  assert.ok(at('prepareIfGranted') < at('transact'));
  assert.ok(at('transact') < at('assertNoPendingReset'));
  assert.ok(at('assertNoPendingReset') < at('reconcile'));
  assert.ok(at('reconcile') < at('readQueue'));
  assert.equal(h.abandoned.length, 1, 'the pass settles its provisional ids when it ends');
});

test('alarms with an unfinished cancel, stop or edit are excluded from the pass', async () => {
  const h = harness({
    stored: [alarm('a'), alarm('b'), alarm('c'), alarm('d')],
    pendingCancellations: ['a'],
    suppressionIntents: ['b'],
    pendingEdits: ['c'],
  });
  await h.reconcile(h.stored);
  assert.deepEqual([...h.captured[0].excludedAlarmIds].sort(), ['a', 'b', 'c']);
});

test('concurrent callers share one run; a settled run is not reused', async () => {
  const gate = deferred();
  const h = harness({ gate: gate.promise });

  const first = h.reconcile(h.stored);
  const second = h.reconcile(h.stored);
  assert.equal(first, second, 'the in-flight promise is shared');
  gate.resolve();
  await first;
  assert.equal(h.runs(), 1);

  const third = h.reconcile(h.stored);
  assert.notEqual(third, first);
  await third;
  assert.equal(h.runs(), 2);
});

test('a pass that fails part way reads the durable checkpoint back, abandons its ids, and a retry runs', async () => {
  const durable = [alarm('durable')];
  let failing = true;
  const h = harness({
    durable,
    reconcile: async (input, calls) => {
      if (!failing) {
        calls.push('retry-ok');
        return {
          alarms: input.alarms,
          statuses: {},
          issues: [],
          repaired: 0,
          replanned: 0,
          queueKnown: true,
          orphansUnreadable: false,
          pendingOrphanIds: [],
        };
      }
      await input.gateway.scheduleMain({
        alarmId: 'a',
        cycleId: 'c1',
        dueAtMs: NOW + 1,
        repeats: true,
      });
      throw new Error('journal write failed');
    },
  });

  const aborted = await h.reconcile(h.stored);
  assert.equal(aborted?.aborted, true);
  assert.equal(aborted?.queueVerified, false);
  assert.deepEqual(aborted?.alarms, durable, 'the durable state is used, not the caller copy');
  assert.deepEqual(aborted?.statuses, { durable: 'unverified' });
  assert.deepEqual(h.abandoned, [['main-c1']]);

  failing = false;
  const retried = await h.reconcile(h.stored);
  assert.equal(retried?.aborted, false);
  assert.ok(h.calls.includes('retry-ok'));
});

test('an unreadable durable state after a failure yields no alarms rather than the stale input', async () => {
  const h = harness({
    durable: new Error('storage unreadable'),
    reconcile: async () => {
      throw new Error('boom');
    },
  });
  const result = await h.reconcile(h.stored);
  assert.equal(result?.aborted, true);
  assert.equal(result?.alarms, null);
});

test('the planning zone is remembered only for a non-stale, settled result', async () => {
  const settled = harness();
  await settled.reconcile(settled.stored);
  assert.equal(settled.savedZones.length, 1);

  const stale = harness({ finishDeletionAfterTurn: true });
  await stale.reconcile(stale.stored);
  assert.deepEqual(stale.savedZones, []);
});
