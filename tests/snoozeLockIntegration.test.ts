/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ALREADY_UP_OWNER,
  CHECK_IN_KIND,
  MAIN_ALARM_KIND,
} from '../src/alarmContracts';
import { cancelAlarmDefinitionWithCheckpoints } from '../src/alarmCancellation';
import {
  AlarmEditError,
  editAlarmDefinition,
  recoverPendingAlarmEdit,
  type AlarmEditGateway,
  type AlarmEditJournal,
  type PendingAlarmEdit,
} from '../src/alarmEdit';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import * as storage from '../src/alarmStorage';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';
import { findAlarmListLock } from '../src/homeStatus';
import {
  QueueIndex,
  describeScheduledRequest,
  isMarkedOwned,
  type QueueEntry,
} from '../src/queueInspection';
import {
  reconcileAlarmSchedules,
  type OrphanStore,
  type ReconcileGateway,
} from '../src/scheduleReconciliation';
import {
  createSnoozeService,
  getSnoozeIds,
  markDeliveredCycleRinging,
} from '../src/snooze';
import { createSnoozeTransaction } from '../src/snoozeTransaction';
import * as gateModule from '../src/storageResetGate';
import { createStorageResetService } from '../src/storageReset';
import * as journals from '../src/suppressionJournal';

// The real alarm storage, suppression lock, reset service and snooze service
// run together here; only the device (AsyncStorage's web backend and the
// notification queue) is replaced by in-memory fakes.
const data = new Map<string, string>();
const failures = {
  removeKey: null as string | null,
  /** Makes a real alarm-definitions write fail, decided on the stored JSON. */
  setWhen: null as ((key: string, value: string) => boolean) | null,
};
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failures.setWhen?.(key, value)) {
          throw new Error('disk write failed');
        }
        data.set(key, value);
      },
      removeItem: (key: string) => {
        if (failures.removeKey === key) {
          failures.removeKey = null;
          throw new Error('disk error');
        }
        data.delete(key);
      },
    },
  },
});

const MINUTE = 60_000;
const DUE = new Date(2026, 9, 15, 7, 0, 0).getTime();
const NOW = DUE + 2 * MINUTE;

function cycle(overrides: Partial<StoredAlarm> = {}): StoredAlarm {
  return {
    alarmId: 'a1',
    cycleId: 'c1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: DUE - 10 * MINUTE,
    dueAtMs: DUE,
    phase: 'ringing',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...overrides,
  };
}

function definition(cycles: StoredAlarm[]): StoredAlarmDefinition {
  return {
    id: 'a1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', DUE),
    enabled: true,
    createdAtMs: DUE - 86_400_000,
    cycles,
  };
}

/** The shared device queue; `data` is the notification payload if known. */
class FakeQueue {
  ids = new Set<string>();
  scheduleCalls = 0;
  cancelCalls: string[] = [];
  holdSchedule: Promise<void> | null = null;
  holdCancel: Promise<void> | null = null;
  /** The OS answers a schedule with this id instead of the requested one. */
  returnId: string | null = null;
  cancelFailIds = new Set<string>();
  scheduleEntered = deferred();
  cancelEntered = deferred();

  reset(): void {
    this.ids = new Set();
    this.scheduleCalls = 0;
    this.cancelCalls = [];
    this.holdSchedule = null;
    this.holdCancel = null;
    this.returnId = null;
    this.cancelFailIds = new Set();
    this.scheduleEntered = deferred();
    this.cancelEntered = deferred();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const queue = new FakeQueue();

const journal = journals.createSuppressionJournal(AsyncStorage, undefined, {
  beforeRecord: gateModule.assertNoPendingReset,
});

const resetService = createStorageResetService({
  store: AsyncStorage,
  gateway: {
    // Opaque payloads: only ids the stored state names can be recognised.
    listPresented: async () => [],
    dismissPresented: async () => {},
    listScheduled: async () =>
      [...queue.ids].map((identifier) => ({ identifier, content: {} })),
    cancelScheduled: async (id) => {
      queue.ids.delete(id);
    },
  },
  exclusive: (run) =>
    journal.exclusive(() => storage.runExclusiveAlarmStorage(run)),
  nowMs: () => NOW,
  // Same wiring as App: ids only the snooze service remembers are cancelled
  // by a deletion and forgotten once it has finished.
  extraKnownIds: () => snoozeService.unsettledIds(),
  onCompleted: () => {
    gateModule.advanceStorageEpoch();
    snoozeService.forgetUnsettled();
  },
});
gateModule.installStorageResetGate(() => resetService.hasPendingReset());

let idCounter = 0;
const snoozeService = createSnoozeService({
  gateway: {
    listScheduledIds: async () => new Set(queue.ids),
    schedule: async (input) => {
      queue.scheduleCalls += 1;
      queue.scheduleEntered.resolve();
      await queue.holdSchedule;
      const used = queue.returnId ?? input.identifier;
      queue.ids.add(used);
      return used;
    },
    cancelScheduled: async (id) => {
      queue.cancelCalls.push(id);
      queue.cancelEntered.resolve();
      await queue.holdCancel;
      if (queue.cancelFailIds.has(id)) {
        throw new Error('cancel failed');
      }
      queue.ids.delete(id);
    },
    dismissDelivered: async () => undefined,
  },
  // Using this directly would wait on the queue the transaction already holds.
  store: {
    load: async () => {
      throw new Error('the service must use its transaction-local store');
    },
    save: async () => {
      throw new Error('the service must use its transaction-local store');
    },
  },
  transact: createSnoozeTransaction({
    exclusive: (run) => journal.exclusive(run),
    transact: storage.transactAlarmDefinitions,
  }),
  nowMs: () => NOW,
  makeId: () => `snooze-new-${(idCounter += 1)}`,
});

function seed(alarms: StoredAlarmDefinition[]): void {
  data.clear();
  failures.removeKey = null;
  failures.setWhen = null;
  queue.reset();
  idCounter = 0;
  data.set(
    storage.ALARM_DEFINITIONS_STORAGE_KEY,
    JSON.stringify({ version: 2, alarms }),
  );
}

function stored(): StoredAlarmDefinition[] {
  const raw = data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY);
  return raw ? JSON.parse(raw).alarms : [];
}

async function settled<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock: ${label}`)), 2_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function ticks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a snooze racing a deletion completes first, then the deletion cancels its notification', async () => {
  seed([definition([cycle()])]);
  const gate = deferred();
  queue.holdSchedule = gate.promise;

  const snoozing = snoozeService.snooze('c1');
  await settled(queue.scheduleEntered.promise, 'snooze never reached the OS');

  let resetDone = false;
  const resetting = resetService.reset().then((value) => {
    resetDone = true;
    return value;
  });
  await ticks();
  // The deletion is waiting on the snooze's locks, not running beside it.
  assert.equal(resetDone, false);
  assert.ok(data.has(storage.ALARM_DEFINITIONS_STORAGE_KEY));

  const before = await storage.loadAlarmDefinitions();
  gate.resolve();
  const result = await settled(snoozing, 'snooze');
  assert.equal(result.status, 'snoozed');
  await settled(resetting, 'reset');

  assert.equal(data.size, 0);
  // The snooze's notification is gone with everything else the app owned.
  assert.deepEqual([...queue.ids], []);
  // What the screen could still hold from before is recognised as stale.
  assert.equal(gateModule.isStaleStorageResult(before), true);
  assert.deepEqual(await storage.loadAlarmDefinitions(), []);
});

test('a snooze that starts after a finished deletion schedules nothing and writes nothing', async () => {
  seed([definition([cycle()])]);
  await resetService.reset();

  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.deepEqual(result, { status: 'rejected', reason: 'NOT_FOUND' });
  assert.equal(queue.scheduleCalls, 0);
  assert.equal(data.size, 0);
});

test('while a deletion is unfinished snooze, stop and recovery are refused before any side effect', async () => {
  seed([
    definition([
      cycle({
        phase: 'snoozed',
        snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + MINUTE },
      }),
      cycle({ cycleId: 'c2', mainAlarmId: 'main-2', checkInNotificationId: 'check-2', dueAtMs: DUE + 86_400_000, phase: 'armed' }),
    ]),
  ]);
  queue.ids.add('snooze-1');
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  data.set(storage.ACTIVE_ALARM_STORAGE_KEY, '{}');
  await assert.rejects(resetService.reset());
  const snapshot = new Map(data);
  const queueBefore = new Set(queue.ids);

  await assert.rejects(
    settled(snoozeService.snooze('c1'), 'snooze'),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    settled(snoozeService.stop('c1'), 'stop'),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    settled(snoozeService.recover(), 'recover'),
    gateModule.StorageResetPendingError,
  );
  assert.equal(queue.scheduleCalls, 0);
  assert.deepEqual(queue.cancelCalls, []);
  assert.deepEqual([...queue.ids], [...queueBefore]);
  assert.deepEqual([...data], [...snapshot]);
});

test('a stop racing a deletion finishes first and its dismissed record is not brought back', async () => {
  seed([
    definition([
      cycle({
        phase: 'snoozed',
        snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + MINUTE },
      }),
    ]),
  ]);
  queue.ids.add('snooze-1');
  const gate = deferred();
  queue.holdCancel = gate.promise;

  const stopping = snoozeService.stop('c1');
  await settled(queue.cancelEntered.promise, 'stop never reached the OS');
  let resetDone = false;
  const resetting = resetService.reset().then(() => {
    resetDone = true;
  });
  await ticks();
  assert.equal(resetDone, false);

  const before = await storage.loadAlarmDefinitions();
  gate.resolve();
  const outcome = await settled(stopping, 'stop');
  assert.equal(outcome.status, 'stopped');
  await settled(resetting, 'reset');

  assert.equal(data.size, 0);
  assert.deepEqual([...queue.ids], []);
  assert.equal(gateModule.isStaleStorageResult(before), true);
});

test('a stop after a finished deletion is ignored and writes nothing', async () => {
  seed([definition([cycle()])]);
  await resetService.reset();
  const outcome = await settled(snoozeService.stop('c1'), 'stop');
  assert.deepEqual(outcome, { status: 'ignored' });
  assert.equal(data.size, 0);
});

test('a snooze and a stop of the same occurrence queue behind each other without deadlock', async () => {
  seed([definition([cycle()])]);
  const gate = deferred();
  queue.holdSchedule = gate.promise;

  const snoozing = snoozeService.snooze('c1');
  await settled(queue.scheduleEntered.promise, 'snooze never reached the OS');
  const stopping = snoozeService.stop('c1');
  await ticks();
  gate.resolve();

  assert.equal((await settled(snoozing, 'snooze')).status, 'snoozed');
  // The stop saw the snoozed state, so it cancelled the snooze it created.
  assert.equal((await settled(stopping, 'stop')).status, 'stopped');
  assert.deepEqual([...queue.ids], []);
  assert.equal(stored()[0].cycles[0].phase, 'dismissed');
  assert.equal(stored()[0].cycles[0].snooze, undefined);
});

test('a refused write inside the transaction does not look stored to later steps', async () => {
  seed([definition([cycle()])]);
  // The intent write fails: the notification must never be scheduled.
  const realSet = (globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window
    .localStorage.setItem;
  (globalThis as { window: { localStorage: { setItem: unknown } } }).window.localStorage.setItem = () => {
    throw new Error('disk full');
  };
  try {
    const result = await settled(snoozeService.snooze('c1'), 'snooze');
    assert.deepEqual(result, { status: 'rejected', reason: 'INTENT_NOT_SAVED' });
  } finally {
    (globalThis as { window: { localStorage: { setItem: unknown } } }).window.localStorage.setItem = realSet;
  }
  assert.equal(queue.scheduleCalls, 0);
  assert.equal(stored()[0].cycles[0].phase, 'ringing');
});

test('restart recovery after an interrupted edit keeps the snoozed occurrence and re-arms its own id', async () => {
  const snoozedCycle = cycle({
    phase: 'snoozed',
    snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + 3 * MINUTE },
  });
  seed([definition([snoozedCycle])]);
  // The OS lost the snooze (and the old main already fired).
  const entry: PendingAlarmEdit = {
    alarmId: 'a1',
    stage: 'replacing',
    requestedAtMs: DUE - 60 * MINUTE,
    hour: 8,
    minute: 0,
    repeat: makeAlarmRepeat('daily', DUE),
    oldNotificationIds: ['main-1', 'check-1'],
    newNotificationIds: ['new-main'],
    newCycles: [
      cycle({
        cycleId: 'new-c',
        mainAlarmId: 'new-main',
        checkInNotificationId: undefined,
        dueAtMs: DUE + 86_400_000,
        phase: 'armed',
      }),
    ],
  };
  const entries = [entry];
  const editJournal: AlarmEditJournal = {
    load: async () => entries,
    save: async () => undefined,
    remove: async (alarmId) => {
      const index = entries.findIndex((item) => item.alarmId === alarmId);
      if (index >= 0) entries.splice(index, 1);
    },
  };

  // Startup order: edits first, then snoozes, both under the same locks.
  await journal.exclusive(() =>
    storage.transactAlarmDefinitions((current, checkpoint) =>
      recoverPendingAlarmEdit({
        alarms: current,
        entry,
        gateway: {
          cancelScheduled: async (id) => {
            queue.ids.delete(id);
          },
          listScheduledIds: async () => new Set(queue.ids),
        },
        journal: editJournal,
        checkpoint,
        now: () => NOW,
      }),
    ),
  );
  assert.equal(entries.length, 0);
  const kept = stored()[0].cycles.find((item) => item.cycleId === 'c1');
  assert.equal(kept?.phase, 'snoozed', 'the edit recovery must not drop it');

  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.rearmed, ['c1']);
  assert.deepEqual([...queue.ids], ['snooze-1']);
  assert.equal(queue.scheduleCalls, 1);
});

test('restart recovery clears an interrupted attempt and an edit is refused until then', async () => {
  const interrupted = cycle({
    phase: 'missed',
    snooze: {
      count: 1,
      notificationId: 'snooze-1',
      dueAtMs: NOW - 40 * MINUTE,
      pending: { requestedId: 'snooze-try', dueAtMs: NOW, strayIds: ['stray-1'] },
    },
  });
  seed([definition([interrupted])]);
  queue.ids.add('snooze-try');
  queue.ids.add('stray-1');

  const failEverything = new Proxy({} as AlarmEditGateway, {
    get: () => async () => {
      throw new Error('the edit must stop before touching the OS');
    },
  });
  await assert.rejects(
    editAlarmDefinition({
      alarms: stored(),
      alarmId: 'a1',
      hour: 8,
      minute: 0,
      repeat: makeAlarmRepeat('daily', DUE),
      now: () => NOW,
      gateway: failEverything,
      journal: { load: async () => [], save: async () => undefined, remove: async () => undefined },
      checkpoint: async () => undefined,
      hasUnsettledWork: async () => false,
    }),
    (error: unknown) => error instanceof AlarmEditError && error.code === 'unsettled',
  );

  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.deepEqual([...queue.ids], [], 'requested and stray ids are both cancelled');
  assert.equal(stored()[0].cycles[0].snooze?.pending, undefined);
});

test('editing is refused for a ringing or waiting snooze instead of leaking its notification', async () => {
  for (const phase of ['ringing', 'snoozed'] as const) {
    const alarms = [
      definition([
        cycle({
          phase,
          snooze:
            phase === 'snoozed'
              ? { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + MINUTE }
              : undefined,
        }),
      ]),
    ];
    assert.equal(findAlarmListLock(alarms, NOW), phase);
    const failEverything = new Proxy({} as AlarmEditGateway, {
      get: () => async () => {
        throw new Error('the edit must stop before touching the OS');
      },
    });
    await assert.rejects(
      editAlarmDefinition({
        alarms,
        alarmId: 'a1',
        hour: 8,
        minute: 0,
        repeat: makeAlarmRepeat('daily', DUE),
        now: () => NOW,
        gateway: failEverything,
        journal: { load: async () => [], save: async () => undefined, remove: async () => undefined },
        checkpoint: async () => undefined,
        hasUnsettledWork: async () => false,
      }),
      (error: unknown) => error instanceof AlarmEditError && error.code === 'locked',
    );
  }
});

const everyId = ['snooze-1', 'snooze-try', 'stray-1', 'stray-2'];
function cycleWithEverySnoozeId(): StoredAlarm {
  return cycle({
    phase: 'snoozed',
    snooze: {
      count: 1,
      notificationId: 'snooze-1',
      dueAtMs: NOW + MINUTE,
      pending: {
        requestedId: 'snooze-try',
        dueAtMs: NOW + MINUTE,
        strayIds: ['stray-1', 'stray-2'],
      },
    },
  });
}

test('deleting an alarm cancels the current, pending and stray snooze ids', async () => {
  const cancelled: string[] = [];
  const result = await cancelAlarmDefinitionWithCheckpoints({
    alarms: [definition([cycleWithEverySnoozeId()])],
    alarmId: 'a1',
    completion: 'delete',
    gateway: {
      cancelScheduled: async (id) => {
        if (id) cancelled.push(id);
      },
      dismissDelivered: async () => undefined,
    },
    checkpoint: async () => undefined,
  });
  assert.deepEqual(result, []);
  for (const id of [...everyId, 'main-1', 'check-1']) {
    assert.ok(cancelled.includes(id), `${id} was not cancelled`);
  }
});

test('a deletion of all data cancels the current, pending and stray snooze ids it can only know from storage', async () => {
  seed([definition([cycleWithEverySnoozeId()])]);
  for (const id of everyId) queue.ids.add(id);
  queue.ids.add('other-app');

  await resetService.reset();
  assert.deepEqual([...queue.ids], ['other-app']);
  assert.equal(data.size, 0);
});

test('queue reconciliation keeps a live snooze, even one named by the orphan journal, and never rebuilds a snoozed main', async () => {
  const snoozedCycle = cycle({
    phase: 'snoozed',
    snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + 3 * MINUTE },
  });
  const nextDue = DUE + 86_400_000;
  const upcoming = cycle({
    cycleId: 'c2',
    mainAlarmId: 'main-2',
    checkInNotificationId: 'check-2',
    dueAtMs: nextDue,
    phase: 'armed',
  });
  const alarms = [definition([snoozedCycle, upcoming])];

  const os = new Map<string, QueueEntry>();
  os.set('main-2', {
    id: 'main-2',
    owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'a1', cycleId: 'c2' },
    trigger: { kind: 'date', atMs: nextDue },
  });
  // Check-in time is derived by the service; leave it absent so it is repaired
  // without touching anything of the snoozed occurrence.
  os.set('snooze-1', {
    id: 'snooze-1',
    owned: {
      owner: ALREADY_UP_OWNER,
      kind: MAIN_ALARM_KIND,
      alarmId: 'a1',
      cycleId: 'c1',
      snooze: 1,
    },
    trigger: { kind: 'date', atMs: NOW + 3 * MINUTE, resolutionMs: 1000 },
  });

  const cancelled: string[] = [];
  const scheduledFor: string[] = [];
  const orphanIds = new Set(['snooze-1']);
  const orphans: OrphanStore = {
    load: async () => [...orphanIds],
    add: async (ids) => ids.forEach((id) => orphanIds.add(id)),
    remove: async (ids) => ids.forEach((id) => orphanIds.delete(id)),
  };
  const gateway: ReconcileGateway = {
    scheduleMain: async (input) => {
      scheduledFor.push(input.cycleId);
      const id = `new-${input.cycleId}`;
      os.set(id, { id, owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'a1', cycleId: input.cycleId }, trigger: { kind: 'date', atMs: input.dueAtMs } });
      return id;
    },
    scheduleCheckIn: async (input) => {
      scheduledFor.push(`${input.cycleId}:checkin`);
      const id = `new-check-${input.cycleId}`;
      os.set(id, { id, owned: { owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND, alarmId: 'a1', cycleId: input.cycleId, mainAlarmId: input.mainAlarmId }, trigger: { kind: 'date', atMs: input.checkInAtMs } });
      return id;
    },
    cancelScheduled: async (id) => {
      cancelled.push(id);
      os.delete(id);
    },
  };
  const outcome = await reconcileAlarmSchedules({
    alarms,
    excludedAlarmIds: new Set(),
    readQueue: async () => ({ kind: 'known', entries: [...os.values()] }),
    canSchedule: true,
    nowMs: () => NOW,
    gateway,
    orphans,
    checkpoint: async () => undefined,
  });

  assert.ok(!cancelled.includes('snooze-1'), 'a live snooze was cancelled as an orphan');
  assert.ok(os.has('snooze-1'));
  assert.ok(!orphanIds.has('snooze-1'), 'it is only dropped from orphan tracking');
  // Neither the snoozed main nor its check-in is rebuilt.
  assert.ok(
    scheduledFor.every((id) => !id.startsWith('c1')),
    `rebuilt for the snoozed cycle: ${scheduledFor.join(',')}`,
  );
  assert.equal(
    outcome.alarms[0].cycles.find((item) => item.cycleId === 'c1')?.phase,
    'snoozed',
  );
});

test('a delivery is applied to the latest stored state and cannot undo a stop', async () => {
  seed([
    definition([
      cycle({
        phase: 'snoozed',
        snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + MINUTE },
      }),
    ]),
  ]);
  // A stale delivery id never rings a snoozed occurrence.
  const ignored = await storage.transactAlarmDefinitions(async (current) =>
    markDeliveredCycleRinging(current, 'c1', 'main-1'),
  );
  assert.equal(ignored[0].cycles[0].phase, 'snoozed');

  // The stop finishes while the delivery callback was already on its way.
  await snoozeService.stop('c1');
  const afterStop = await storage.transactAlarmDefinitions(async (current) =>
    markDeliveredCycleRinging(current, 'c1', 'snooze-1'),
  );
  assert.equal(afterStop[0].cycles[0].phase, 'dismissed');

  seed([
    definition([
      cycle({
        phase: 'snoozed',
        snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: NOW + MINUTE },
      }),
    ]),
  ]);
  const rung = await storage.transactAlarmDefinitions(async (current) =>
    markDeliveredCycleRinging(current, 'c1', 'snooze-1'),
  );
  assert.equal(rung[0].cycles[0].phase, 'ringing');
  assert.equal(rung[0].cycles[0].snooze?.notificationId, 'snooze-1');
  assert.equal(rung[0].cycles[0].dueAtMs, DUE, 'the original deadline is unchanged');
});

test('a snooze delivery reads back as this app\'s own absolute calendar notification', () => {
  const at = new Date(NOW + 5 * MINUTE);
  const entry = describeScheduledRequest({
    identifier: 'snooze-1',
    content: {
      data: {
        owner: ALREADY_UP_OWNER,
        kind: MAIN_ALARM_KIND,
        alarmId: 'a1',
        cycleId: 'c1',
        snooze: 1,
      },
    },
    trigger: {
      type: 'calendar',
      repeats: false,
      dateComponents: {
        timeZone: 'UTC',
        year: at.getUTCFullYear(),
        month: at.getUTCMonth() + 1,
        day: at.getUTCDate(),
        hour: at.getUTCHours(),
        minute: at.getUTCMinutes(),
        second: at.getUTCSeconds(),
      },
    },
  });
  assert.equal(entry.id, 'snooze-1');
  assert.equal(entry.owned?.snooze, 1);
  assert.equal(isMarkedOwned(entry.owned), true);
  assert.equal(
    new QueueIndex([entry]).match({
      id: 'snooze-1',
      kind: MAIN_ALARM_KIND,
      alarmId: 'a1',
      cycleId: 'c1',
      atMs: NOW + 5 * MINUTE,
    }),
    'present',
  );
});

test('a snooze that would ring after the same alarm\'s next occurrence is refused using the latest stored state', async () => {
  seed([
    definition([
      cycle(),
      cycle({
        cycleId: 'c2',
        mainAlarmId: 'main-2',
        checkInNotificationId: 'check-2',
        dueAtMs: NOW + 3 * MINUTE,
        phase: 'armed',
      }),
    ]),
  ]);
  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.deepEqual(result, { status: 'rejected', reason: 'TOO_LATE' });
  assert.equal(queue.scheduleCalls, 0);
  assert.equal(stored()[0].cycles[0].phase, 'ringing');
  // Typical finish: the snooze moves nothing of the original deadline.
  assert.equal(stored()[0].cycles[0].dueAtMs, DUE);
});

test('the snooze limit is three per occurrence and the original deadline never moves', async () => {
  seed([definition([cycle()])]);
  for (let round = 1; round <= 3; round += 1) {
    const result = await settled(snoozeService.snooze('c1'), 'snooze');
    assert.equal(result.status, 'snoozed');
    // The snooze rings: the delivery puts the occurrence back to ringing.
    await storage.transactAlarmDefinitions(async (current) =>
      markDeliveredCycleRinging(
        current,
        'c1',
        stored()[0].cycles[0].snooze!.notificationId!,
      ),
    );
    assert.equal(stored()[0].cycles[0].phase, 'ringing');
  }
  const fourth = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.deepEqual(fourth, { status: 'rejected', reason: 'LIMIT_REACHED' });
  assert.equal(stored()[0].cycles[0].dueAtMs, DUE);
  assert.equal(stored()[0].cycles[0].snooze?.count, 3);
});

// ---------------------------------------------------------------------------
// PR44 late findings: real storage writes, real transaction, real reset
// ---------------------------------------------------------------------------

function ringingSnoozeSeed(): void {
  seed([definition([cycle()])]);
  queue.ids.add('main-1');
}

function dismissedWrite(value: string, withPending: boolean): boolean {
  const cycles = JSON.parse(value).alarms?.[0]?.cycles ?? [];
  return cycles.some(
    (entry: StoredAlarm) =>
      entry.phase === 'dismissed' && (entry.snooze?.pending !== undefined) === withPending,
  );
}

test('late 2: a stop whose first real write fails cancels nothing and the snooze stays armed', async () => {
  ringingSnoozeSeed();
  assert.equal((await snoozeService.snooze('c1')).status, 'snoozed');
  const snoozeId = stored()[0].cycles[0].snooze!.notificationId!;
  failures.setWhen = (key) => key === storage.ALARM_DEFINITIONS_STORAGE_KEY;

  const result = await settled(snoozeService.stop('c1'), 'stop');
  failures.setWhen = null;
  assert.deepEqual(result, { status: 'failed', reason: 'SAVE_FAILED' });
  assert.equal(queue.ids.has(snoozeId), true);
  assert.equal(stored()[0].cycles[0].phase, 'snoozed');
  assert.deepEqual(queue.cancelCalls.filter((id) => id === snoozeId), []);
});

test('late 2: a real final-write failure after cancelling leaves a recoverable stop and no live alarm', async () => {
  ringingSnoozeSeed();
  await snoozeService.snooze('c1');
  const snoozeId = stored()[0].cycles[0].snooze!.notificationId!;
  failures.setWhen = (key, value) =>
    key === storage.ALARM_DEFINITIONS_STORAGE_KEY && dismissedWrite(value, false);

  const result = await settled(snoozeService.stop('c1'), 'stop');
  failures.setWhen = null;
  assert.equal(result.status, 'stopped');
  assert.equal(queue.ids.has(snoozeId), false);
  // Durable truth: dismissed, with the cleanup record recovery can finish.
  assert.equal(stored()[0].cycles[0].phase, 'dismissed');
  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.equal(stored()[0].cycles[0].snooze, undefined);
});

test('late 2: a stop whose cancel fails keeps the stop and the id for recovery before classification', async () => {
  ringingSnoozeSeed();
  await snoozeService.snooze('c1');
  const snoozeId = stored()[0].cycles[0].snooze!.notificationId!;
  queue.cancelFailIds.add(snoozeId);

  const result = await settled(snoozeService.stop('c1'), 'stop');
  assert.equal(result.status, 'stopped');
  assert.equal((result as { cleanup?: string }).cleanup, 'unconfirmed');
  assert.equal(stored()[0].cycles[0].phase, 'dismissed');
  // Write ahead covers every owned id (main, check-in, snooze), not only the snooze.
  assert.deepEqual(storedIds(), ['main-1', 'check-1', snoozeId]);

  // A restart: recovery runs before overdue cycles are classified.
  queue.cancelFailIds.clear();
  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.equal(queue.ids.has(snoozeId), false);
  const after = await storage.markDueCyclesRinging(NOW + MINUTE, 'resume');
  assert.equal(after[0].cycles[0].phase, 'dismissed');
});

test('stop on a just-ringing cycle writes ahead and cancels the still-pending main and check-in', async () => {
  ringingSnoozeSeed();
  queue.ids.add('check-1');
  failures.setWhen = (key, value) =>
    key === storage.ALARM_DEFINITIONS_STORAGE_KEY && dismissedWrite(value, false);
  const result = await settled(snoozeService.stop('c1'), 'stop');
  failures.setWhen = null;
  assert.equal(result.status, 'stopped');
  assert.equal(queue.ids.has('main-1'), false);
  assert.equal(queue.ids.has('check-1'), false);
  // The final clearing write was refused: the durable record still names both.
  assert.equal(stored()[0].cycles[0].phase, 'dismissed');
  assert.deepEqual(storedIds(), ['main-1', 'check-1']);
  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.equal(stored()[0].cycles[0].snooze, undefined);
});

function storedIds(): string[] {
  return getSnoozeIds(stored()[0].cycles[0]);
}

test('late 3: the committed snapshot of a snooze equals storage and is epoch-fresh', async () => {
  ringingSnoozeSeed();
  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.equal(result.status, 'snoozed');
  const snapshot = (result as { alarms?: StoredAlarmDefinition[] }).alarms;
  assert.ok(snapshot, 'the transaction exposes what it committed');
  assert.deepEqual(snapshot, stored());
  assert.equal(snapshot[0].cycles[0].phase, 'snoozed');
  assert.equal(gateModule.isStaleStorageResult(snapshot), false);

  // A deletion that finishes afterwards makes the very same snapshot stale,
  // so the screen can never bring the deleted alarm back from it.
  await resetService.reset();
  assert.equal(gateModule.isStaleStorageResult(snapshot), true);
});

test('late 3: the committed snapshot of a stop equals storage and is epoch-fresh', async () => {
  ringingSnoozeSeed();
  await snoozeService.snooze('c1');
  const result = await settled(snoozeService.stop('c1'), 'stop');
  assert.equal(result.status, 'stopped');
  const snapshot = (result as { alarms?: StoredAlarmDefinition[] }).alarms;
  assert.ok(snapshot);
  assert.deepEqual(snapshot, stored());
  assert.equal(snapshot[0].cycles[0].phase, 'dismissed');
  assert.equal(gateModule.isStaleStorageResult(snapshot), false);
  await resetService.reset();
  assert.equal(gateModule.isStaleStorageResult(snapshot), true);
});

test('late 3: the snapshot needs no readback, so a failing read cannot hide a persisted stop', async () => {
  ringingSnoozeSeed();
  await snoozeService.snooze('c1');
  const result = await settled(snoozeService.stop('c1'), 'stop');
  // Reading storage now fails, as it can right after a successful stop.
  const realGet = (globalThis as { window: { localStorage: { getItem: unknown } } }).window.localStorage.getItem;
  (globalThis as { window: { localStorage: { getItem: unknown } } }).window.localStorage.getItem = () => {
    throw new Error('read failed');
  };
  try {
    await assert.rejects(storage.loadAlarmDefinitions());
    const snapshot = (result as { alarms?: StoredAlarmDefinition[] }).alarms;
    assert.equal(snapshot?.[0].cycles[0].phase, 'dismissed');
  } finally {
    (globalThis as { window: { localStorage: { getItem: unknown } } }).window.localStorage.getItem = realGet;
  }
});

test('late 4: an unexpected id whose tracking writes all really fail is cancelled by a deletion', async () => {
  seed([definition([cycle()])]);
  queue.returnId = 'stray-os-id';
  queue.cancelFailIds.add('stray-os-id');
  failures.setWhen = (key, value) =>
    key === storage.ALARM_DEFINITIONS_STORAGE_KEY && value.includes('stray-os-id');

  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  failures.setWhen = null;
  assert.equal(result.status, 'rejected');
  assert.equal((result as { cleanup?: string }).cleanup, 'unconfirmed');
  assert.equal((result as { tracking?: string }).tracking, 'memory_only');
  assert.equal(queue.ids.has('stray-os-id'), true);
  // Nothing durable names it; only the service's memory does.
  assert.equal(JSON.stringify([...data]).includes('stray-os-id'), false);
  assert.deepEqual(snoozeService.unsettledIds(), ['stray-os-id']);

  queue.cancelFailIds.clear();
  queue.returnId = null;
  await settled(resetService.reset(), 'reset');
  assert.equal(queue.ids.has('stray-os-id'), false);
  assert.deepEqual(snoozeService.unsettledIds(), []);
});

test('late 5: the pending main notification is cancelled by a real snooze and survives no tick race', async () => {
  ringingSnoozeSeed();
  assert.equal(queue.ids.has('main-1'), true);
  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.equal(result.status, 'snoozed');
  assert.equal(queue.ids.has('main-1'), false);
  assert.equal(queue.ids.has(stored()[0].cycles[0].snooze!.notificationId!), true);
});

test('late 5: an uncancellable earlier delivery is tracked durably and recovery keeps the accepted snooze', async () => {
  ringingSnoozeSeed();
  queue.cancelFailIds.add('main-1');
  const result = await settled(snoozeService.snooze('c1'), 'snooze');
  assert.equal(result.status, 'snoozed');
  assert.equal((result as { cleanup?: string }).cleanup, 'unconfirmed');
  const accepted = stored()[0].cycles[0].snooze!.notificationId!;
  assert.ok(storedIds().includes('main-1'));

  queue.cancelFailIds.clear();
  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.equal(queue.ids.has('main-1'), false);
  assert.equal(queue.ids.has(accepted), true);
  assert.equal(stored()[0].cycles[0].snooze!.notificationId, accepted);
});

test('late 1: recovery after a cleaned pending re-arms a still-missing accepted snooze in the same pass', async () => {
  seed([
    definition([
      cycle({
        phase: 'snoozed',
        snooze: {
          count: 1,
          notificationId: 'snooze-keep',
          dueAtMs: NOW + 3 * MINUTE,
          pending: { requestedId: 'half', dueAtMs: NOW + 3 * MINUTE, strayIds: ['stray'] },
        },
      }),
    ]),
  ]);
  queue.ids.add('half');
  queue.ids.add('stray');
  const outcome = await settled(snoozeService.recover(), 'recover');
  assert.deepEqual(outcome.cleaned, ['c1']);
  assert.deepEqual(outcome.rearmed, ['c1']);
  assert.deepEqual([...queue.ids], ['snooze-keep']);
  assert.equal(stored()[0].cycles[0].snooze!.pending, undefined);
});
