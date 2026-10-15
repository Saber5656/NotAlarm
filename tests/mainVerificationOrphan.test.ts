/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALREADY_UP_OWNER,
  MAIN_ALARM_KIND,
} from '../src/alarmContracts';
import type { ScheduledNotificationSnapshot } from '../src/alarmNotificationOwnership';
import type { AlarmSchedulingGateway } from '../src/alarmOrchestrator';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import { fillAlarmDefinitionSchedule } from '../src/alarmScheduling';
import type { StoredAlarmDefinition } from '../src/alarmStorage';
import { noticeFromCode } from '../src/errorCatalog';
import { withMainVerification } from '../src/mainAlarmVerification';
import { createOrphanStore } from '../src/orphanedNotifications';
import type { QueueInspection } from '../src/queueInspection';
import { reconcileAlarmSchedules } from '../src/scheduleReconciliation';
import { createStorageResetService } from '../src/storageReset';

const NOW = new Date(2026, 9, 15, 6, 0, 0).getTime();
const SECRET = 'EACCES /var/mobile/Containers/abc token=sk-live-123';

const definition: StoredAlarmDefinition = {
  id: 'alarm-1',
  hour: 7,
  minute: 0,
  repeat: makeAlarmRepeat('today', NOW),
  enabled: true,
  createdAtMs: NOW,
  cycles: [],
};

function makeStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: async (key: string) => {
      data.delete(key);
    },
  };
}

/** The real OS queue: scheduling always stores, listing can fail. */
function makeOs() {
  const scheduled = new Map<string, ScheduledNotificationSnapshot>();
  let counter = 0;
  const os = {
    scheduled,
    listFails: false,
    cancelFails: false,
    ids: () => [...scheduled.keys()],
    gateway: {
      async scheduleMain({
        alarmId,
        cycleId,
        identifier: requested,
      }: {
        alarmId: string;
        cycleId: string;
        identifier?: string;
      }) {
        counter += 1;
        // Like expo-notifications, honour a requested identifier.
        const identifier = requested ?? `os-main-${counter}`;
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
    async list(): Promise<ReadonlySet<string>> {
      if (os.listFails) throw new Error(SECRET);
      return new Set(scheduled.keys());
    },
    async cancel(id: string): Promise<void> {
      if (os.cancelFails) throw new Error(SECRET);
      scheduled.delete(id);
    },
    inspection(): QueueInspection {
      if (os.listFails) return { kind: 'unknown' };
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

function setup() {
  const os = makeOs();
  const store = makeStore();
  const orphans = createOrphanStore(store);
  const gateway = withMainVerification(os.gateway, (() => os.list()), {
    orphans,
    cancelScheduled: (id) => os.cancel(id),
  });
  return { os, store, orphans, gateway };
}

test('P0: OS scheduled + list throws + retry + reset leaves no orphaned and no duplicate notification', async () => {
  const { os, store, orphans, gateway } = setup();

  // 1. The OS really holds the notification but the verifying read throws.
  os.listFails = true;
  const first = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');
  assert.equal(first.definition.cycles.length, 0, 'no cycle is stored for an unverified main');
  assert.equal(first.issues[0]?.code, 'MAIN_UNVERIFIED');
  assert.equal(os.ids().length, 1, 'the real notification exists');
  // The exact id must have been remembered durably.
  assert.deepEqual(await orphans.load(), os.ids());

  // 2. The list recovers; a manual retry must not create a second notification.
  os.listFails = false;
  const retry = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c2');
  assert.equal(retry.definition.cycles.length, 0, 'retry is blocked until reconciled');
  assert.equal(retry.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  assert.equal(os.ids().length, 1, 'no duplicate was registered');

  // 3. A reset cancels the remembered exact id.
  const reset = createStorageResetService({
    store,
    gateway: {
      listScheduled: async () => [...os.scheduled.values()],
      cancelScheduled: (id) => os.cancel(id),
    },
    exclusive: (run) => run(),
    nowMs: () => NOW,
  });
  await reset.reset();
  assert.deepEqual(os.ids(), [], 'nothing of ours keeps ringing after the reset');
});

test('the remembered id is cancelled by reconciliation, after which scheduling resumes', async () => {
  const { os, orphans, gateway } = setup();
  os.listFails = true;
  await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');
  os.listFails = false;
  const stale = os.ids()[0];

  const outcome = await reconcileAlarmSchedules({
    alarms: [definition],
    excludedAlarmIds: new Set(),
    readQueue: async () => os.inspection(),
    orphans,
    canSchedule: false,
    nowMs: () => NOW,
    gateway: {
      ...os.gateway,
      cancelScheduled: (id) => os.cancel(id),
    },
    checkpoint: async () => undefined,
  });
  assert.equal(outcome.orphansUnreadable, false);
  assert.ok(!os.ids().includes(stale), 'the unverified notification was cancelled');
  assert.deepEqual(await orphans.load(), []);

  const next = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c3');
  assert.equal(next.definition.cycles.length, 1);
  assert.equal(os.ids().length, 1);
});

test('a journal that cannot record the id refuses the request, nothing reaches the OS', async () => {
  const os = makeOs();
  const failing = {
    load: async () => [],
    add: async () => {
      throw new Error(SECRET);
    },
    remove: async () => undefined,
  };
  const gateway = withMainVerification(os.gateway, () => os.list(), {
    orphans: failing,
    cancelScheduled: (id) => os.cancel(id),
  });
  const first = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');
  assert.equal(first.issues[0]?.code, 'STORAGE_JOURNAL_SAVE_FAILED');
  assert.deepEqual(os.ids(), [], 'no id is requested that could be forgotten');
});

test('the id is journaled before the OS request and kept until its owner settles it', async () => {
  const { os, orphans, gateway } = setup();
  let journalDuringRequest: string[] = [];
  const inner = os.gateway.scheduleMain;
  os.gateway.scheduleMain = async (input) => {
    journalDuringRequest = await orphans.load();
    assert.equal(input.identifier, journalDuringRequest[0]);
    return inner(input);
  };
  const ok = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');
  assert.equal(ok.definition.cycles.length, 1);
  assert.equal(journalDuringRequest.length, 1);
  assert.deepEqual(await orphans.load(), os.ids(), 'a verified id stays recorded until the checkpoint');
  await gateway.releaseProvisional(ok.scheduledCycles.map((cycle) => cycle.mainAlarmId));
  assert.deepEqual(await orphans.load(), [], 'settling the checkpoint drops it');
});

test('a crash after the OS request still finds the id after a restart', async () => {
  const { os, store, gateway: first } = setup();
  const inner = os.gateway.scheduleMain;
  os.gateway.scheduleMain = async (input) => {
    await inner(input);
    throw new Error('process killed');
  };
  await fillAlarmDefinitionSchedule(definition, NOW, first, () => 'c1');
  assert.equal(os.ids().length, 1, 'the OS holds the notification');

  // Fresh wrapper and store instance, as after a restart.
  const orphans = createOrphanStore(store);
  assert.deepEqual(await orphans.load(), os.ids());
  const restarted = withMainVerification(os.gateway, () => os.list(), {
    orphans,
    cancelScheduled: (id) => os.cancel(id),
  });
  os.gateway.scheduleMain = inner;
  const retry = await fillAlarmDefinitionSchedule(definition, NOW, restarted, () => 'c2');
  assert.equal(retry.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  assert.equal(os.ids().length, 1, 'no duplicate after the restart');
});

test('journal and cancel both failing is reported as memory-only, never as recorded', async () => {
  const os = makeOs();
  const failing = {
    load: async () => [],
    add: async () => {
      throw new Error(SECRET);
    },
    remove: async () => undefined,
  };
  const gateway = withMainVerification(os.gateway, () => os.list(), {
    orphans: failing,
    cancelScheduled: (id) => os.cancel(id),
  });
  os.listFails = true;
  os.cancelFails = true;
  // A caller that chose its own identifier journals it itself (the edit does).
  await assert.rejects(
    gateway.scheduleMain({
      alarmId: 'alarm-1',
      cycleId: 'c1',
      dueAtMs: NOW + 3_600_000,
      repeats: false,
      identifier: 'edit-main-1',
    }),
    (error) => (error as { code?: string }).code === 'MAIN_UNVERIFIED_MEMORY_ONLY',
  );
  assert.deepEqual(os.ids(), ['edit-main-1']);
  const notice = noticeFromCode('MAIN_UNVERIFIED_MEMORY_ONLY');
  assert.doesNotMatch(notice.text, /記録しています|記録済み/);

  os.listFails = false;
  os.cancelFails = false;
  const retry = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c2');
  assert.equal(retry.issues[0]?.code, 'MAIN_RECONCILE_PENDING');
  assert.deepEqual(gateway.unresolvedMainIds?.(), ['edit-main-1']);
});

test('a cancelled unverified id is reported as cancelled, not as recorded', async () => {
  const os = makeOs();
  const failing = {
    load: async () => [],
    add: async () => {
      throw new Error(SECRET);
    },
    remove: async () => undefined,
  };
  const gateway = withMainVerification(os.gateway, () => os.list(), {
    orphans: failing,
    cancelScheduled: (id) => os.cancel(id),
  });
  os.listFails = true;
  await assert.rejects(
    gateway.scheduleMain({
      alarmId: 'alarm-1',
      cycleId: 'c1',
      dueAtMs: NOW + 3_600_000,
      repeats: false,
      identifier: 'edit-main-1',
    }),
    (error) => (error as { code?: string }).code === 'MAIN_UNVERIFIED_CANCELLED',
  );
  assert.deepEqual(os.ids(), [], 'the exact id was cancelled');
  assert.doesNotMatch(noticeFromCode('MAIN_UNVERIFIED_CANCELLED').text, /記録/);
});

test('a missing id (list works, id absent) is also remembered', async () => {
  const { os, orphans, gateway } = setup();
  const original = os.list;
  os.list = async () => new Set();
  const first = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');
  os.list = original;
  assert.equal(first.issues[0]?.code, 'MAIN_UNVERIFIED');
  assert.deepEqual(await orphans.load(), os.ids());
});
