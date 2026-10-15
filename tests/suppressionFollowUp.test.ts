/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processUserSkipFailSafe,
  type AwakeResponseDependencies,
} from '../src/alarmOrchestrator';
import { STEP_WINDOW_LEAD_MS } from '../src/alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';
import {
  createSuppressionSaver,
  finishSuppression,
} from '../src/suppressionFollowUp';
import { createSuppressionJournal } from '../src/suppressionJournal';
import { buildUserSkipTarget } from '../src/userSkip';

const DUE = 10_000_000;
const START = DUE - STEP_WINDOW_LEAD_MS;

const cycle: StoredAlarm = {
  alarmId: 'alarm-1',
  cycleId: 'cycle-1',
  mainAlarmId: 'main-1',
  checkInNotificationId: 'checkin-1',
  armedAtMs: 0,
  dueAtMs: DUE,
  phase: 'armed',
  stepCount: 12,
  stepCandidateRecorded: false,
};

function definition(
  c: StoredAlarm,
  kind: 'today' | 'daily' = 'daily',
): StoredAlarmDefinition {
  return {
    id: c.alarmId,
    hour: 7,
    minute: 0,
    repeat: { kind, weekdays: [], dateKey: undefined } as never,
    enabled: true,
    createdAtMs: 0,
    cycles: [c],
  } as StoredAlarmDefinition;
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  };
}

// Small harness mirroring App.tsx: storage + rendered list + OS state.
function harness(nowMs = START + 1) {
  let stored: StoredAlarm = cycle;
  let rendered: StoredAlarmDefinition[] = [definition(cycle)];
  const log: string[] = [];
  const save = async (next: StoredAlarm) => {
    stored = next;
    log.push('save');
    return [definition(next)];
  };
  const deps: AwakeResponseDependencies = {
    loadAlarm: async () => stored,
    saveAlarm: createSuppressionSaver(save, (next) => {
      log.push('apply');
      rendered = next;
    }),
    cancelScheduled: async () => true,
    nowMs: () => nowMs,
    journal: createSuppressionJournal(memoryStore()),
  };
  return {
    deps,
    log,
    get stored() {
      return stored;
    },
    get rendered() {
      return rendered;
    },
  };
}

test('saved definitions are applied right after persist, before cleanup', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  assert.equal(result.status, 'suppressed');
  assert.deepEqual(h.log, ['save', 'apply']);
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
});

test('a failed persist applies nothing', async () => {
  const applied: unknown[] = [];
  const saver = createSuppressionSaver(
    async () => {
      throw new Error('disk');
    },
    (next) => applied.push(next),
  );
  await assert.rejects(saver(cycle));
  assert.deepEqual(applied, []);
});

test('refill failure after persist keeps the stopped state (not reverted)', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  assert.equal(result.status, 'suppressed');
  await assert.rejects(
    finishSuppression((result as { alarm: StoredAlarm }).alarm, {
      cancelCheckIn: async () => undefined,
      dismissDelivered: async () => undefined,
      refill: async () => {
        throw new Error('refill');
      },
    }),
    /refill/,
  );
  assert.equal(h.stored.phase, 'suppressed');
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
  assert.equal(h.rendered[0].cycles[0].suppressedBy, 'user_skip');
});

test('check-in cleanup failure keeps the stopped state and still dismisses the delivered check-in', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  const calls: string[] = [];
  await assert.rejects(
    finishSuppression((result as { alarm: StoredAlarm }).alarm, {
      cancelCheckIn: async (id) => {
        calls.push(`cancel:${id}`);
        throw new Error('cancel');
      },
      dismissDelivered: async (id) => void calls.push(`dismiss:${id}`),
      refill: async () => void calls.push('refill'),
    }),
    /cancel/,
  );
  assert.deepEqual(calls, ['cancel:checkin-1', 'dismiss:checkin-1']);
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
});

test('delivered check-in is dismissed on success and a dismiss failure is non-fatal', async () => {
  const calls: string[] = [];
  await finishSuppression(
    { ...cycle, phase: 'suppressed' },
    {
      cancelCheckIn: async (id) => void calls.push(`cancel:${id}`),
      dismissDelivered: async (id) => {
        calls.push(`dismiss:${id}`);
        throw new Error('not delivered');
      },
      refill: async () => void calls.push('refill'),
    },
  );
  assert.deepEqual(calls, ['cancel:checkin-1', 'dismiss:checkin-1', 'refill']);
});

