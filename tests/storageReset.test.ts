/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import type { ScheduledNotificationSnapshot } from "../src/alarmNotificationOwnership";
import {
  ACTIVE_ALARM_STORAGE_KEY,
  ALARM_CANCELLATION_JOURNAL_KEY,
  ALARM_DEFINITIONS_STORAGE_KEY,
} from "../src/alarmStorage";
import {
  STORAGE_RESET_INTENT_KEY,
  STORAGE_RESET_LIMITATION_KEY,
  StorageResetIncompleteError,
  createStorageResetService,
  type StorageResetGateway,
} from "../src/storageReset";
import { SUPPRESSION_JOURNAL_KEY } from "../src/suppressionJournal";

const OWNED_KEYS = [
  ALARM_DEFINITIONS_STORAGE_KEY,
  ACTIVE_ALARM_STORAGE_KEY,
  ALARM_CANCELLATION_JOURNAL_KEY,
  SUPPRESSION_JOURNAL_KEY,
];

function ownedMain(identifier: string, cycleId = `cycle-${identifier}`) {
  return {
    identifier,
    content: {
      title: "⏰ 起きる時間です",
      categoryIdentifier: null,
      data: {
        owner: "already-up/v1",
        kind: "main_alarm",
        alarmId: "a1",
        cycleId,
      },
    },
  } satisfies ScheduledNotificationSnapshot;
}

function foreign(identifier: string): ScheduledNotificationSnapshot {
  return {
    identifier,
    content: {
      title: "Other app",
      categoryIdentifier: null,
      data: { kind: "x" },
    },
  };
}

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    removed: [] as string[],
    async getItem(key: string) {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      data.set(key, value);
    },
    async removeItem(key: string) {
      this.removed.push(key);
      data.delete(key);
    },
  };
}

function makeGateway(
  initial: ScheduledNotificationSnapshot[],
  options: { failCancel?: Set<string>; ignoreCancel?: Set<string> } = {},
) {
  const scheduled = [...initial];
  const cancelled: string[] = [];
  const gateway: StorageResetGateway = {
    async listScheduled() {
      return [...scheduled];
    },
    async cancelScheduled(id) {
      if (options.failCancel?.has(id)) {
        throw new Error("cancel failed");
      }
      cancelled.push(id);
      if (options.ignoreCancel?.has(id)) {
        return;
      }
      const index = scheduled.findIndex((item) => item.identifier === id);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
  };
  return { gateway, scheduled, cancelled };
}

function service(
  store: ReturnType<typeof makeStore>,
  gateway: StorageResetGateway,
) {
  return createStorageResetService({
    store,
    gateway,
    exclusive: (run) => run(),
    nowMs: () => 5_000,
  });
}

const corrupt = Object.fromEntries(OWNED_KEYS.map((key) => [key, "{not json"]));

test("cancels only owned notifications, then clears every alarm key and the intent", async () => {
  const store = makeStore({ ...corrupt, unrelated: "keep" });
  const { gateway, scheduled, cancelled } = makeGateway([
    ownedMain("m1"),
    foreign("host-1"),
    ownedMain("m2"),
  ]);

  await service(store, gateway).reset();

  assert.deepEqual(cancelled.sort(), ["m1", "m2"]);
  assert.deepEqual(
    scheduled.map((item) => item.identifier),
    ["host-1"],
  );
  for (const key of OWNED_KEYS) {
    assert.equal(store.data.has(key), false, key);
  }
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), false);
  assert.equal(store.data.get("unrelated"), "keep");
});

test("writes the durable intent before the first cancellation", async () => {
  const store = makeStore(corrupt);
  const { gateway } = makeGateway([ownedMain("m1")]);
  let intentAtCancel: string | null = null;
  const spying: StorageResetGateway = {
    ...gateway,
    async cancelScheduled(id) {
      intentAtCancel = store.data.get(STORAGE_RESET_INTENT_KEY) ?? null;
      return gateway.cancelScheduled(id);
    },
  };

  await service(store, spying).reset();

  assert.ok(intentAtCancel);
  assert.equal(JSON.parse(intentAtCancel).version, 1);
});

test("uses exact ids from readable sources even when the payload is not recognisable", async () => {
  const definitions = {
    version: 2,
    alarms: [
      {
        id: "a1",
        hour: 7,
        minute: 0,
        repeat: { kind: "weekdays", weekdays: [1, 2, 3, 4, 5] },
        enabled: true,
        createdAtMs: 1,
        cycles: [
          {
            alarmId: "a1",
            cycleId: "c1",
            mainAlarmId: "owned-main",
            checkInNotificationId: "owned-checkin",
            armedAtMs: 1,
            dueAtMs: 2,
            phase: "armed",
            stepCount: 0,
            stepCandidateRecorded: false,
          },
        ],
      },
    ],
  };
  const store = makeStore({
    [ALARM_DEFINITIONS_STORAGE_KEY]: JSON.stringify(definitions),
  });
  const { gateway, cancelled } = makeGateway([
    foreign("owned-main"),
    foreign("owned-checkin"),
    foreign("host-1"),
  ]);

  await service(store, gateway).reset();

  assert.deepEqual(cancelled.sort(), ["owned-checkin", "owned-main"]);
});

test("keeps all data and the intent when a cancellation cannot be confirmed, then retries", async () => {
  const store = makeStore({ ...corrupt });
  const first = makeGateway([ownedMain("m1"), ownedMain("m2")], {
    ignoreCancel: new Set(["m2"]),
  });

  await assert.rejects(
    () => service(store, first.gateway).reset(),
    StorageResetIncompleteError,
  );
  for (const key of OWNED_KEYS) {
    assert.equal(store.data.has(key), true, key);
  }
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), true);

  const retry = makeGateway([ownedMain("m2")]);
  await service(store, retry.gateway).reset();
  assert.deepEqual(retry.cancelled, ["m2"]);
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), false);
  for (const key of OWNED_KEYS) {
    assert.equal(store.data.has(key), false, key);
  }
});

test("a thrown cancel that leaves the notification scheduled does not clear storage", async () => {
  const store = makeStore({ ...corrupt });
  const { gateway } = makeGateway([ownedMain("m1")], {
    failCancel: new Set(["m1"]),
  });

  await assert.rejects(() => service(store, gateway).reset());
  assert.equal(store.data.has(ALARM_DEFINITIONS_STORAGE_KEY), true);
});

test("keeps ids remembered in the intent when a restart interrupted an earlier reset", async () => {
  const store = makeStore({
    [STORAGE_RESET_INTENT_KEY]: JSON.stringify({
      version: 1,
      requestedAtMs: 1,
      ownedIds: ["remembered"],
    }),
  });
  const { gateway, cancelled } = makeGateway([foreign("remembered")]);

  assert.equal(await service(store, gateway).hasPendingReset(), true);
  await service(store, gateway).reset();

  assert.deepEqual(cancelled, ["remembered"]);
  assert.equal(await service(store, gateway).hasPendingReset(), false);
});

test("a failure while listing leaves storage untouched", async () => {
  const store = makeStore({ ...corrupt });
  const gateway: StorageResetGateway = {
    async listScheduled() {
      throw new Error("unavailable");
    },
    async cancelScheduled() {},
  };

  await assert.rejects(() => service(store, gateway).reset());
  for (const key of OWNED_KEYS) {
    assert.equal(store.data.has(key), true, key);
  }
});

test("runs inside the supplied exclusive lock", async () => {
  const store = makeStore({ ...corrupt });
  const { gateway } = makeGateway([]);
  let locked = 0;
  await createStorageResetService({
    store,
    gateway,
    exclusive: async (run) => {
      locked += 1;
      return run();
    },
    nowMs: () => 1,
  }).reset();
  assert.equal(locked, 1);
});

function foreignContractShaped(
  identifier: string,
  kind: "main_alarm" | "awake_checkin",
) {
  return {
    identifier,
    content: {
      title: "Other project",
      categoryIdentifier: kind === "awake_checkin" ? "awake_checkin" : null,
      data: {
        kind,
        alarmId: "x",
        cycleId: "y",
        mainAlarmId: kind === "awake_checkin" ? "z" : undefined,
      },
    },
  } satisfies ScheduledNotificationSnapshot;
}

test("foreign contract-shaped main and check-in survive and are reported", async () => {
  const store = makeStore(corrupt);
  const { gateway, scheduled, cancelled } = makeGateway([
    ownedMain("m1"),
    foreignContractShaped("f-main", "main_alarm"),
    foreignContractShaped("f-check", "awake_checkin"),
  ]);

  const result = await service(store, gateway).reset();

  assert.deepEqual(cancelled, ["m1"]);
  assert.deepEqual(scheduled.map((i) => i.identifier).sort(), [
    "f-check",
    "f-main",
  ]);
  assert.equal(result.ambiguousCount, 2);
  for (const key of OWNED_KEYS) {
    assert.equal(store.data.has(key), false, key);
  }
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), false);
  assert.equal(store.data.has(STORAGE_RESET_LIMITATION_KEY), true);
});

test("ambiguous warning survives restart and clears once none remain; repeat reset works", async () => {
  const store = makeStore(corrupt);
  const { gateway, scheduled } = makeGateway([
    foreignContractShaped("f-main", "main_alarm"),
  ]);
  const svc = service(store, gateway);
  assert.equal((await svc.reset()).ambiguousCount, 1);
  assert.equal(await svc.readAmbiguousCount(), 1);
  assert.equal((await svc.reset()).ambiguousCount, 1);

  scheduled.length = 0;
  assert.equal(await svc.readAmbiguousCount(), 0);
  assert.equal(store.data.has(STORAGE_RESET_LIMITATION_KEY), false);
  assert.equal((await svc.reset()).ambiguousCount, 0);
});

test("legacy notifications cancel when their exact id is stored", async () => {
  const legacy = {
    identifier: "old-1",
    content: {
      title: "⏰ 起きる時間です",
      categoryIdentifier: null,
      data: { kind: "main_alarm", alarmId: "a1", cycleId: "c1" },
    },
  } satisfies ScheduledNotificationSnapshot;
  const store = makeStore({
    ...corrupt,
    [ACTIVE_ALARM_STORAGE_KEY]: JSON.stringify({}),
    [SUPPRESSION_JOURNAL_KEY]: "{not json",
  });
  const { gateway, cancelled } = makeGateway([legacy]);
  // Seed the durable intent as an interrupted reset would have remembered it.
  store.data.set(
    STORAGE_RESET_INTENT_KEY,
    JSON.stringify({ version: 1, requestedAtMs: 1, ownedIds: ["old-1"] }),
  );
  const result = await service(store, gateway).reset();
  assert.deepEqual(cancelled, ["old-1"]);
  assert.equal(result.ambiguousCount, 0);
});
