/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { RECOVERY_WINDOW_MS } from '../src/missedAlarms';
import * as storage from '../src/alarmStorage';
import * as gate from '../src/storageResetGate';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';

// Real alarm storage and queue code against an in-memory Storage (the web
// build of AsyncStorage reads window.localStorage at call time).
const data = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  },
});

const DUE_MS = 10_000;
const identity = { cycleId: 'c1', mainAlarmId: 'm1', dueAtMs: DUE_MS };

const at = (ms: number) => () => ms;

function armedCycle(): StoredAlarm {
  return {
    alarmId: 'a1',
    cycleId: 'c1',
    mainAlarmId: 'm1',
    armedAtMs: 1,
    dueAtMs: DUE_MS,
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function seed(cycle: StoredAlarm = armedCycle()): void {
  const definition: StoredAlarmDefinition = {
    id: 'a1',
    hour: 7,
    minute: 0,
    repeat: { kind: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    enabled: true,
    createdAtMs: 1,
    cycles: [cycle],
  };
  data.clear();
  data.set(
    storage.ALARM_DEFINITIONS_STORAGE_KEY,
    JSON.stringify({ version: 2, alarms: [definition] }),
  );
}

async function storedPhase(): Promise<string | undefined> {
  return (await storage.loadStoredAlarmByCycleId('c1'))?.phase;
}

test('a delivery racing a stop cannot overwrite the finished cycle, in either order', async () => {
  for (const terminal of ['suppressed', 'dismissed'] as const) {
    for (const deliveryFirst of [true, false]) {
      seed();
      const finish = () =>
        storage.saveStoredAlarm({ ...armedCycle(), phase: terminal });
      const deliver = () => storage.saveCycleRinging(identity, at(DUE_MS + 500));

      if (deliveryFirst) {
        await Promise.all([deliver(), finish()]);
      } else {
        await Promise.all([finish(), deliver()]);
      }
      assert.equal(await storedPhase(), terminal, `${terminal} deliveryFirst=${deliveryFirst}`);
    }
  }
});

test('a delivery racing a missed-cycle acknowledgement keeps it dismissed', async () => {
  seed({ ...armedCycle(), phase: 'missed' });
  await Promise.all([
    storage.saveStoredAlarm({ ...armedCycle(), phase: 'dismissed' }),
    storage.saveCycleRinging(identity, at(DUE_MS + 500)),
  ]);
  assert.equal(await storedPhase(), 'dismissed');
});

test('duplicate deliveries ring once and a later stop is not undone', async () => {
  seed();
  const results = await Promise.all([
    storage.saveCycleRinging(identity, at(DUE_MS + 500)),
    storage.saveCycleRinging(identity, at(DUE_MS + 501)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'already_ringing',
    'ringing',
  ]);
  await storage.saveStoredAlarm({ ...armedCycle(), phase: 'dismissed' });
  const late = await storage.saveCycleRinging(identity, at(DUE_MS + 900));
  assert.equal(late.status, 'not_awaiting');
  assert.equal(await storedPhase(), 'dismissed');
});

test('a delivery for an older main notification leaves the current cycle armed', async () => {
  seed();
  const result = await storage.saveCycleRinging(
    { ...identity, mainAlarmId: 'old-main' },
    at(DUE_MS + 500),
  );
  assert.equal(result.status, 'mismatch');
  assert.equal(await storedPhase(), 'armed');
});

test('an empty or unreadable store is never repaired by a delivery', async () => {
  data.clear();
  assert.equal((await storage.saveCycleRinging(identity, at(DUE_MS))).status, 'not_found');
  assert.equal(data.size, 0);

  data.set(storage.ALARM_DEFINITIONS_STORAGE_KEY, '{broken');
  await assert.rejects(storage.saveCycleRinging(identity, at(DUE_MS)));
  assert.equal(data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY), '{broken');

  data.set(
    storage.ALARM_DEFINITIONS_STORAGE_KEY,
    JSON.stringify({ version: 1, alarms: [] }),
  );
  await assert.rejects(storage.saveCycleRinging(identity, at(DUE_MS)));
  assert.equal(
    data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY),
    JSON.stringify({ version: 1, alarms: [] }),
  );
});

test('the clock is read inside the queued transaction, after a blocker finishes', async () => {
  for (const [clockAfter, expected, phase] of [
    [DUE_MS - 1, 'not_due', 'armed'],
    [DUE_MS + RECOVERY_WINDOW_MS + 1, 'missed', 'missed'],
  ] as const) {
    seed();
    let now = DUE_MS + 500;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blocker = storage.transactAlarmDefinitions(async (current) => {
      await gate;
      return current;
    });
    const delivery = storage.saveCycleRinging(identity, () => now);
    now = clockAfter; // manual clock change while the delivery is still queued
    release();
    await blocker;
    assert.equal((await delivery).status, expected);
    assert.equal(await storedPhase(), phase);
  }
});

test('while a reset is pending, a delivery is refused and writes nothing', async () => {
  seed();
  const before = data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY);
  gate.installStorageResetGate(async () => true);
  try {
    await assert.rejects(
      storage.saveCycleRinging(identity, at(DUE_MS + 500)),
      gate.StorageResetPendingError,
    );
  } finally {
    gate.installStorageResetGate(async () => false);
  }
  assert.equal(data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY), before);
  assert.equal(await storedPhase(), 'armed');
});

test('a delivery result from before a finished reset is stale, a later one is fresh', async () => {
  seed();
  const before = await storage.saveCycleRinging(identity, at(DUE_MS + 500));
  assert.equal(before.status, 'ringing');
  assert.equal(gate.isStaleStorageResult(before.alarms), false);

  gate.advanceStorageEpoch();
  assert.equal(gate.isStaleStorageResult(before.alarms), true);

  seed();
  const after = await storage.saveCycleRinging(identity, at(DUE_MS + 500));
  assert.equal(gate.isStaleStorageResult(after.alarms), false);
});

const SNOOZE_DUE_MS = DUE_MS + 5 * 60_000;
const snoozeIdentity = { cycleId: 'c1', mainAlarmId: 'snooze-1' };

function snoozedCycle(): StoredAlarm {
  return {
    ...armedCycle(),
    phase: 'snoozed',
    snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: SNOOZE_DUE_MS },
  };
}

test('a snoozed cycle rings only for its current snooze notification at its snooze due time', async () => {
  seed(snoozedCycle());
  // The original main notification cannot wake a snoozed cycle.
  const stale = await storage.saveCycleRinging(
    { ...identity, dueAtMs: undefined },
    at(SNOOZE_DUE_MS + 1),
  );
  assert.equal(stale.status, 'mismatch');
  assert.equal(await storedPhase(), 'snoozed');

  // Neither can an older snooze or the wrong snooze due time.
  assert.equal(
    (await storage.saveCycleRinging({ ...snoozeIdentity, mainAlarmId: 'snooze-0' }, at(SNOOZE_DUE_MS + 1))).status,
    'mismatch',
  );
  assert.equal(
    (await storage.saveCycleRinging({ ...snoozeIdentity, dueAtMs: DUE_MS }, at(SNOOZE_DUE_MS + 1))).status,
    'mismatch',
  );

  // The original deadline has long passed, but the snooze is not due yet.
  assert.equal(
    (await storage.saveCycleRinging(snoozeIdentity, at(SNOOZE_DUE_MS - 1))).status,
    'not_due',
  );
  assert.equal(await storedPhase(), 'snoozed');

  const rung = await storage.saveCycleRinging(
    { ...snoozeIdentity, dueAtMs: SNOOZE_DUE_MS },
    at(SNOOZE_DUE_MS),
  );
  assert.equal(rung.status, 'ringing');
  const stored = await storage.loadStoredAlarmByCycleId('c1');
  assert.equal(stored?.phase, 'ringing');
  assert.equal(stored?.dueAtMs, DUE_MS, 'the original deadline is immutable');
  assert.equal(stored?.snooze?.notificationId, 'snooze-1');

  // A duplicate of the same snooze delivery changes nothing.
  assert.equal(
    (await storage.saveCycleRinging(snoozeIdentity, at(SNOOZE_DUE_MS + 10))).status,
    'already_ringing',
  );
});

test('a snooze delivery found past the recovery window becomes silent missed', async () => {
  seed(snoozedCycle());
  const late = await storage.saveCycleRinging(
    snoozeIdentity,
    at(SNOOZE_DUE_MS + RECOVERY_WINDOW_MS + 1),
  );
  assert.equal(late.status, 'missed');
  assert.equal(await storedPhase(), 'missed');
});

test('a snooze delivery racing a stop never revives the stopped cycle', async () => {
  for (const deliveryFirst of [true, false]) {
    seed(snoozedCycle());
    const stop = () =>
      storage.saveStoredAlarm({ ...snoozedCycle(), phase: 'dismissed' });
    const deliver = () => storage.saveCycleRinging(snoozeIdentity, at(SNOOZE_DUE_MS + 1));
    if (deliveryFirst) {
      await Promise.all([deliver(), stop()]);
    } else {
      await Promise.all([stop(), deliver()]);
    }
    assert.equal(await storedPhase(), 'dismissed');
    // A repeat of the snooze delivery is ignored, whatever the label.
    assert.notEqual((await deliver()).status, 'ringing');
    assert.equal(await storedPhase(), 'dismissed');
  }
});

test('the snooze clock is read inside the queued transaction', async () => {
  seed(snoozedCycle());
  let now = SNOOZE_DUE_MS + 1;
  let release!: () => void;
  const gateOpen = new Promise<void>((resolve) => (release = resolve));
  const blocker = storage.transactAlarmDefinitions(async (current) => {
    await gateOpen;
    return current;
  });
  const delivery = storage.saveCycleRinging(snoozeIdentity, () => now);
  now = SNOOZE_DUE_MS - 1;
  release();
  await blocker;
  assert.equal((await delivery).status, 'not_due');
  assert.equal(await storedPhase(), 'snoozed');
});
