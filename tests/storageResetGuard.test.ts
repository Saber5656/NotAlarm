/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { PendingAlarmEdit } from "../src/alarmEdit";
import * as storage from "../src/alarmStorage";
import * as gateModule from "../src/storageResetGate";
import {
  STORAGE_RESET_INTENT_KEY,
  createStorageResetService,
} from "../src/storageReset";
import * as journals from "../src/suppressionJournal";

// AsyncStorage's web build reads window.localStorage at call time, so the
// real alarm storage and lock code run here against an in-memory Storage.
const data = new Map<string, string>();
const failures = { removeKey: null as string | null };
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => {
        if (failures.removeKey === key) {
          failures.removeKey = null;
          throw new Error("disk error");
        }
        data.delete(key);
      },
    },
  },
});

const definition = {
  id: "a1",
  hour: 7,
  minute: 0,
  repeat: { kind: "daily" as const, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  enabled: true,
  createdAtMs: 1,
  cycles: [
    {
      alarmId: "a1",
      cycleId: "c1",
      mainAlarmId: "m1",
      armedAtMs: 1,
      dueAtMs: 2,
      phase: "armed" as const,
      stepCount: 0,
      stepCandidateRecorded: false,
    },
  ],
};
const legacy = {
  cycleId: "legacy-c",
  mainAlarmId: "legacy-m",
  armedAtMs: 1,
  dueAtMs: 2,
  phase: "armed",
  stepCount: 0,
  stepCandidateRecorded: false,
};

const service = createStorageResetService({
  store: AsyncStorage,
  gateway: {
    listPresented: async () => [],
    dismissPresented: async () => {},
    listScheduled: async () => [],
    cancelScheduled: async () => undefined,
  },
  exclusive: storage.runExclusiveAlarmStorage,
  nowMs: () => 1,
  onCompleted: gateModule.advanceStorageEpoch,
});
gateModule.installStorageResetGate(() => service.hasPendingReset());

function seed() {
  data.clear();
  failures.removeKey = null;
  data.set(
    storage.ALARM_DEFINITIONS_STORAGE_KEY,
    JSON.stringify({ version: 2, alarms: [definition] }),
  );
  data.set(storage.ACTIVE_ALARM_STORAGE_KEY, JSON.stringify(legacy));
}

test("a partial removal failure leaves the intent and retry resumes it", async () => {
  seed();
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());
  // Some keys are already gone, the rest and the intent remain.
  assert.equal(data.has(storage.ALARM_DEFINITIONS_STORAGE_KEY), false);
  assert.equal(data.has(STORAGE_RESET_INTENT_KEY), true);
  assert.equal(await service.hasPendingReset(), true);

  await service.reset();
  assert.equal(data.size, 0);
  assert.equal(await service.hasPendingReset(), false);
});

test("while a reset is pending, definition mutations never run the mutator", async () => {
  seed();
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());

  let scheduled = 0;
  await assert.rejects(
    storage.mutateAlarmDefinitions(async (current) => {
      scheduled += 1; // stands in for a notification reservation
      return current;
    }),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    storage.transactAlarmDefinitions(async (current) => {
      scheduled += 1;
      return current;
    }),
    gateModule.StorageResetPendingError,
  );
  assert.equal(scheduled, 0);
});

test("partial removal is not resurrected by load, stop, due or cancellation writes", async () => {
  seed();
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());
  const snapshot = new Map(data);

  // The legacy record is still there but must not migrate back.
  await assert.rejects(storage.loadAlarmDefinitions());
  await assert.rejects(
    storage.saveStoredAlarm({ ...definition.cycles[0], phase: "ringing" }),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    storage.markDueCyclesRinging(10),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    storage.upsertPendingAlarmCancellation({
      alarmId: "a1",
      completion: "delete",
      cycleIds: ["c1"],
      requestedAtMs: 1,
    }),
    gateModule.StorageResetPendingError,
  );
  assert.deepEqual([...data], [...snapshot]);
});

test("the suppression journal refuses new records while a reset is pending", async () => {
  seed();
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());
  const journal = journals.createSuppressionJournal(AsyncStorage, undefined, {
    beforeRecord: gateModule.assertNoPendingReset,
  });
  await assert.rejects(
    journal.record({
      alarmId: "a1",
      cycleId: "c1",
      mainAlarmId: "m1",
      checkInNotificationId: "k1",
      recordedAtMs: 1,
    } as never),
    gateModule.StorageResetPendingError,
  );
  assert.equal(data.has(journals.SUPPRESSION_JOURNAL_KEY), false);
});

test("a result produced before a successful reset is stale afterwards", async () => {
  seed();
  const before = await storage.mutateAlarmDefinitions((current) => current);
  assert.equal(gateModule.isStaleStorageResult(before), false);

  await service.reset();
  assert.equal(gateModule.isStaleStorageResult(before), true);

  const after = await storage.mutateAlarmDefinitions((current) => current);
  assert.equal(gateModule.isStaleStorageResult(after), false);
  // Arrays that never came from storage (e.g. the cleared list) are accepted.
  assert.equal(gateModule.isStaleStorageResult([]), false);
});

test("mutations are allowed again once the retried reset finishes", async () => {
  seed();
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());
  await service.reset();
  const next = await storage.mutateAlarmDefinitions((current) => current);
  assert.deepEqual(next, []);
});

const pendingEdit: PendingAlarmEdit = {
  alarmId: "a1",
  stage: "scheduling",
  requestedAtMs: 1,
  hour: 6,
  minute: 30,
  repeat: { kind: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  oldNotificationIds: ["m1"],
  newNotificationIds: ["n1"],
  newCycles: [],
};

test("while a reset is pending, the edit journal refuses writes and removals", async () => {
  seed();
  const kept = JSON.stringify({ version: 1, entries: [pendingEdit] });
  data.set(storage.ALARM_EDIT_JOURNAL_KEY, kept);
  failures.removeKey = storage.ACTIVE_ALARM_STORAGE_KEY;
  await assert.rejects(service.reset());

  await assert.rejects(
    storage.savePendingAlarmEdit({ ...pendingEdit, alarmId: "a2" }),
    gateModule.StorageResetPendingError,
  );
  await assert.rejects(
    storage.removePendingAlarmEdit("a1"),
    gateModule.StorageResetPendingError,
  );
  // The unfinished reset still owns the journal; nothing else touched it.
  assert.equal(data.get(storage.ALARM_EDIT_JOURNAL_KEY), kept);

  await service.reset();
  assert.equal(data.has(storage.ALARM_EDIT_JOURNAL_KEY), false);
  await storage.savePendingAlarmEdit(pendingEdit);
  assert.equal(data.has(storage.ALARM_EDIT_JOURNAL_KEY), true);
});

test("edit journal results from before a finished reset are stale", async () => {
  seed();
  await storage.savePendingAlarmEdit(pendingEdit);
  const before = await storage.loadPendingAlarmEdits();
  assert.equal(gateModule.isStaleStorageResult(before), false);
  await service.reset();
  assert.equal(gateModule.isStaleStorageResult(before), true);
  assert.equal(gateModule.isStaleStorageResult(await storage.loadPendingAlarmEdits()), false);
});
