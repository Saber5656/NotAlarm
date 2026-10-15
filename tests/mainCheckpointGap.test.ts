/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { ALREADY_UP_OWNER, MAIN_ALARM_KIND } from '../src/alarmContracts';
import type { ScheduledNotificationSnapshot } from '../src/alarmNotificationOwnership';
import type { AlarmSchedulingGateway } from '../src/alarmOrchestrator';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import {
  ScheduledNotificationRollbackError,
  withScheduledNotificationRollback,
} from '../src/alarmScheduleRollback';
import { fillAlarmDefinitionSchedule } from '../src/alarmScheduling';
import type { StoredAlarmDefinition } from '../src/alarmStorage';
import { withMainVerification } from '../src/mainAlarmVerification';
import { createOrphanStore } from '../src/orphanedNotifications';
import type { QueueInspection } from '../src/queueInspection';
import { reconcileAlarmSchedules } from '../src/scheduleReconciliation';

const NOW = new Date(2026, 9, 15, 6, 0, 0).getTime();

const today: StoredAlarmDefinition = {
  id: 'alarm-1',
  hour: 7,
  minute: 0,
  repeat: makeAlarmRepeat('today', NOW),
  enabled: true,
  createdAtMs: NOW,
  cycles: [],
};
const daily: StoredAlarmDefinition = { ...today, repeat: makeAlarmRepeat('daily', NOW) };

function makeStore() {
  const data = new Map<string, string>();
  return {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: async (key: string) => {
      data.delete(key);
    },
  };
}

function makeOs(options: { returnOtherId?: boolean } = {}) {
  const scheduled = new Map<string, ScheduledNotificationSnapshot>();
  let counter = 0;
  const os = {
    scheduled,
    cancelFails: false,
    ids: () => [...scheduled.keys()],
    gateway: {
      async scheduleMain({ alarmId, cycleId, identifier: requested }: {
        alarmId: string;
        cycleId: string;
        identifier?: string;
      }) {
        counter += 1;
        const identifier = options.returnOtherId ? `os-main-${counter}` : (requested ?? `os-main-${counter}`);
        scheduled.set(identifier, {
          identifier,
          content: {
            categoryIdentifier: null,
            data: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId, cycleId },
          },
        });
        return identifier;
      },
      async scheduleCheckIn() {
        counter += 1;
        return `os-check-${counter}`;
      },
    } as AlarmSchedulingGateway,
    async cancel(id: string) {
      if (os.cancelFails) throw new Error('cancel unconfirmed');
      scheduled.delete(id);
    },
    inspection(): QueueInspection {
      return {
        kind: 'known',
        entries: [...scheduled.values()].map((request) => ({
          id: request.identifier,
          owned: request.content.data as never,
          trigger: { kind: 'date' as const, atMs: NOW + 3_600_000 },
        })),
      };
    },
  };
  return os;
}

function wrap(os: ReturnType<typeof makeOs>, store: ReturnType<typeof makeStore>) {
  const orphans = createOrphanStore(store);
  const gateway = withMainVerification(os.gateway, async () => new Set(os.scheduled.keys()), {
    orphans,
    cancelScheduled: (id) => os.cancel(id),
  });
  return { orphans, gateway };
}

test('verified id stays tracked until the definition checkpoint; a crash then neither forgets nor duplicates it', async () => {
  const os = makeOs();
  const store = makeStore();
  const first = wrap(os, store);
  const filled = await fillAlarmDefinitionSchedule(today, NOW, first.gateway, () => 'c1');
  assert.equal(filled.scheduledCycles.length, 1);
  // Process dies here: the definition was never persisted.
  assert.deepEqual(await first.orphans.load(), os.ids(), 'id is still on record after OS verify');

  const restarted = wrap(os, store);
  const retry = await fillAlarmDefinitionSchedule(today, NOW, restarted.gateway, () => 'c2');
  assert.equal(retry.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  assert.equal(os.ids().length, 1, 'no duplicate');

  await reconcileAlarmSchedules({
    alarms: [today],
    excludedAlarmIds: new Set(),
    readQueue: async () => os.inspection(),
    orphans: restarted.orphans,
    canSchedule: false,
    nowMs: () => NOW,
    gateway: { ...os.gateway, cancelScheduled: (id) => os.cancel(id) },
    checkpoint: async () => undefined,
  });
  assert.deepEqual(os.ids(), [], 'reconcile cancelled the unreferenced id');
  assert.deepEqual(await restarted.orphans.load(), []);
});

test('a full 3-occurrence batch is not blocked by its own ids and settles only the ids it owns', async () => {
  const os = makeOs();
  const store = makeStore();
  const { orphans, gateway } = wrap(os, store);
  const settled = await withScheduledNotificationRollback(
    async (track) => {
      const filled = await fillAlarmDefinitionSchedule(daily, NOW, gateway, (() => {
        let n = 0;
        return () => `c${(n += 1)}`;
      })());
      track(filled.scheduledCycles);
      assert.equal(filled.scheduledCycles.length, 3);
      assert.deepEqual(filled.issues, []);
      assert.equal((await orphans.load()).length, 3, 'all three tracked until checkpoint');
      await orphans.add(['foreign-unresolved']);
      return filled;
    },
    { cancelScheduled: (id) => os.cancel(id ?? '') },
    orphans,
    gateway,
  );
  assert.equal(settled.scheduledCycles.length, 3);
  assert.deepEqual(await orphans.load(), ['foreign-unresolved']);
  const next = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c9');
  assert.equal(next.issues[0]?.code, 'MAIN_RECONCILE_PENDING', 'unknown earlier work still blocks');
});

test('checkpoint failure with unconfirmed cancel keeps the ids tracked and blocking, across restart too', async () => {
  const os = makeOs();
  const store = makeStore();
  const { orphans, gateway } = wrap(os, store);
  os.cancelFails = true;
  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        const filled = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c1');
        track(filled.scheduledCycles);
        throw new Error('checkpoint failed');
      },
      { cancelScheduled: (id) => os.cancel(id ?? '') },
      orphans,
      gateway,
    ),
    (error) => error instanceof ScheduledNotificationRollbackError,
  );
  // The rollback also records the check-in id it could not cancel.
  assert.ok((await orphans.load()).includes(os.ids()[0]), 'main id still on record');
  const retry = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c2');
  assert.equal(retry.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  const restarted = wrap(os, store);
  const retry2 = await fillAlarmDefinitionSchedule(today, NOW, restarted.gateway, () => 'c3');
  assert.equal(retry2.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  assert.equal(os.ids().length, 1);
});

test('checkpoint failure with confirmed cancel releases the ids', async () => {
  const os = makeOs();
  const { orphans, gateway } = wrap(os, makeStore());
  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        track((await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c1')).scheduledCycles);
        throw new Error('checkpoint failed');
      },
      { cancelScheduled: (id) => os.cancel(id ?? '') },
      orphans,
      gateway,
    ),
    /checkpoint failed/,
  );
  assert.deepEqual(os.ids(), []);
  assert.deepEqual(await orphans.load(), []);
});

test('when the OS returns a different id, both the requested and returned ids are settled', async () => {
  const os = makeOs({ returnOtherId: true });
  const { orphans, gateway } = wrap(os, makeStore());
  await withScheduledNotificationRollback(
    async (track) => {
      const filled = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c1');
      track(filled.scheduledCycles);
      assert.equal((await orphans.load()).length, 2, 'requested and returned ids both tracked');
      return filled;
    },
    { cancelScheduled: (id) => os.cancel(id ?? '') },
    orphans,
    gateway,
  );
  assert.deepEqual(await orphans.load(), []);
  assert.equal(os.ids().length, 1);
});

// --- The reconciliation pass is an owner too: verify is not its checkpoint ---

async function staleDefinition(os: ReturnType<typeof makeOs>): Promise<StoredAlarmDefinition> {
  const filled = await fillAlarmDefinitionSchedule(today, NOW, os.gateway, () => 'c1');
  // The OS lost the notification, the stored cycle still points to it.
  for (const id of os.ids()) {
    os.scheduled.delete(id);
  }
  return filled.definition;
}

function reconcileInput(
  os: ReturnType<typeof makeOs>,
  wrapped: ReturnType<typeof wrap>,
  alarm: StoredAlarmDefinition,
  checkpoint: (alarms: StoredAlarmDefinition[]) => Promise<void>,
) {
  return {
    alarms: [alarm],
    excludedAlarmIds: new Set<string>(),
    readQueue: async () => os.inspection(),
    orphans: wrapped.orphans,
    canSchedule: true,
    nowMs: () => NOW,
    gateway: {
      scheduleMain: wrapped.gateway.scheduleMainForReconcile,
      scheduleCheckIn: wrapped.gateway.scheduleCheckIn,
      cancelScheduled: (id: string) => os.cancel(id),
      releaseMain: (ids: readonly string[]) => wrapped.gateway.releaseProvisional(ids),
    },
    checkpoint,
  };
}

test('reconcile keeps its verified main id on record until its checkpoint is saved', async () => {
  const os = makeOs();
  const wrapped = wrap(os, makeStore());
  const alarm = await staleDefinition(os);
  let recordedAtCheckpoint: string[] = [];
  await reconcileAlarmSchedules(
    reconcileInput(os, wrapped, alarm, async () => {
      recordedAtCheckpoint = await wrapped.orphans.load();
    }),
  );
  assert.equal(recordedAtCheckpoint.length, 1, 'recorded while the checkpoint was pending');
  assert.ok(os.ids().includes(recordedAtCheckpoint[0]));
  assert.deepEqual(await wrapped.orphans.load(), [], 'released once the checkpoint was saved');
});

test('crash after verify and before the reconcile checkpoint: the restart still finds and resolves the id', async () => {
  const os = makeOs();
  const store = makeStore();
  const wrapped = wrap(os, store);
  const alarm = await staleDefinition(os);
  os.cancelFails = true;
  await assert.rejects(
    reconcileAlarmSchedules(
      reconcileInput(os, wrapped, alarm, async () => {
        throw new Error('process died');
      }),
    ),
  );
  assert.equal((await wrapped.orphans.load()).length >= 1, true, 'id not forgotten');
  assert.ok(os.ids().length >= 1);

  // Restart: a fresh wrapper over the same durable record and the same OS.
  os.cancelFails = false;
  const restarted = wrap(os, store);
  const blocked = await fillAlarmDefinitionSchedule(today, NOW, restarted.gateway, () => 'c9');
  assert.equal(blocked.issues[0]?.code, 'MAIN_RECONCILE_PENDING', 'no manual duplicate');
  await reconcileAlarmSchedules(
    reconcileInput(os, restarted, { ...alarm, cycles: [] }, async () => undefined),
  );
  assert.deepEqual(await restarted.orphans.load(), [], 'record settled');
});

test('a confirmed rollback of the reconcile pass releases the id; an unconfirmed one keeps it', async () => {
  const os = makeOs();
  const wrapped = wrap(os, makeStore());
  const alarm = await staleDefinition(os);
  await assert.rejects(
    reconcileAlarmSchedules(
      reconcileInput(os, wrapped, alarm, async () => {
        throw new Error('checkpoint failed');
      }),
    ),
    /checkpoint failed/,
  );
  assert.deepEqual(os.ids(), []);
  assert.deepEqual(await wrapped.orphans.load(), [], 'cancel confirmed, record released');
});

test('registration that throws after the request may have reached the OS is not reported as unscheduled', async () => {
  const os = makeOs();
  const store = makeStore();
  const orphans = createOrphanStore(store);
  const gateway = withMainVerification(
    {
      ...os.gateway,
      scheduleMain: async () => {
        throw new Error('bridge dropped the reply');
      },
    },
    async () => new Set(os.scheduled.keys()),
    { orphans, cancelScheduled: (id) => os.cancel(id) },
  );
  const filled = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'c1');
  assert.equal(filled.issues[0]?.code, 'MAIN_REGISTER_UNCONFIRMED');
  assert.equal((await orphans.load()).length, 1, 'requested id stays on record');
});


test("rollback leaves another operation's verified registrations settleable", async () => {
  const os = makeOs();
  const { orphans, gateway } = wrap(os, makeStore());
  let firstId = '';
  let secondId = '';
  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        const first = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'first');
        track(first.scheduledCycles);
        firstId = first.scheduledCycles[0].mainAlarmId;
        // The storage queue can release before an operation's asynchronous
        // rollback settles; another caller can already own a verified id.
        const second = await fillAlarmDefinitionSchedule(today, NOW, gateway, () => 'second');
        secondId = second.scheduledCycles[0].mainAlarmId;
        os.cancelFails = true;
        throw new Error('first checkpoint failed');
      },
      { cancelScheduled: (id) => os.cancel(id ?? '') },
      orphans,
      gateway,
    ),
    ScheduledNotificationRollbackError,
  );
  assert.ok((await orphans.load()).includes(secondId));
  await gateway.releaseProvisional([secondId]);
  assert.ok((await orphans.load()).includes(firstId), 'failed first cancellation remains recorded');
  assert.ok(!(await orphans.load()).includes(secondId), 'second checkpoint can settle its own record');
});
