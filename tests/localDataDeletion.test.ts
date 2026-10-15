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
  LOCAL_DATA_COPY,
  deleteAllLocalData,
  getLocalDataDeletionAvailability,
} from "../src/localDataDeletion";
import {
  STORAGE_RESET_INTENT_KEY,
  StorageResetIncompleteError,
  createStorageResetService,
  type StorageResetGateway,
} from "../src/storageReset";
import { SUPPRESSION_JOURNAL_KEY } from "../src/suppressionJournal";

const ALARM_KEYS = [
  ALARM_DEFINITIONS_STORAGE_KEY,
  ACTIVE_ALARM_STORAGE_KEY,
  ALARM_CANCELLATION_JOURNAL_KEY,
  SUPPRESSION_JOURNAL_KEY,
];

function ownedMain(identifier: string): ScheduledNotificationSnapshot {
  return {
    identifier,
    content: {
      title: "⏰ 起きる時間です",
      categoryIdentifier: null,
      data: {
        owner: "already-up/v1",
        kind: "main_alarm",
        alarmId: "a1",
        cycleId: `cycle-${identifier}`,
      },
    },
  };
}

function foreign(identifier: string): ScheduledNotificationSnapshot {
  return {
    identifier,
    content: { title: "Other", categoryIdentifier: null, data: { kind: "x" } },
  };
}

function ringingDefinitions(mainAlarmId: string) {
  return JSON.stringify({
    version: 2,
    alarms: [
      {
        id: "a1",
        hour: 7,
        minute: 0,
        repeat: { kind: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        enabled: true,
        createdAtMs: 1,
        cycles: [
          {
            alarmId: "a1",
            cycleId: `cycle-${mainAlarmId}`,
            mainAlarmId,
            armedAtMs: 1,
            dueAtMs: 2,
            phase: "ringing",
            stepCount: 12,
            stepCandidateRecorded: false,
          },
        ],
      },
    ],
  });
}

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async getItem(key: string) {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      data.set(key, value);
    },
    async removeItem(key: string) {
      data.delete(key);
    },
  };
}

function makeGateway(
  initial: ScheduledNotificationSnapshot[],
  options: { stuck?: Set<string>; gate?: Promise<void> } = {},
) {
  const scheduled = [...initial];
  const gateway: StorageResetGateway = {
    async listScheduled() {
      await options.gate;
      return [...scheduled];
    },
    async cancelScheduled(id) {
      if (options.stuck?.has(id)) {
        return;
      }
      const index = scheduled.findIndex((item) => item.identifier === id);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
  };
  return { gateway, scheduled };
}

function chainExclusive() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}

function build(
  store: ReturnType<typeof makeStore>,
  gateway: StorageResetGateway,
  exclusive = chainExclusive(),
) {
  return createStorageResetService({
    store,
    gateway,
    exclusive,
    nowMs: () => 9_000,
  });
}

test("deletes every alarm key and only this app's notifications, keeping foreign data", async () => {
  const store = makeStore({
    ...Object.fromEntries(ALARM_KEYS.map((key) => [key, "{}"])),
    [ALARM_DEFINITIONS_STORAGE_KEY]: ringingDefinitions("m1"),
    other: "keep",
  });
  const { gateway, scheduled } = makeGateway([ownedMain("m1"), foreign("h1")]);

  const outcome = await deleteAllLocalData(build(store, gateway));

  assert.deepEqual(outcome, { kind: "deleted", ambiguousCount: 0 });
  assert.deepEqual(
    scheduled.map((n) => n.identifier),
    ["h1"],
  );
  for (const key of [...ALARM_KEYS, STORAGE_RESET_INTENT_KEY]) {
    assert.equal(store.data.has(key), false, key);
  }
  assert.equal(store.data.get("other"), "keep");
});

test("reports unidentifiable notifications that were left scheduled", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const lookalike: ScheduledNotificationSnapshot = {
    identifier: "legacy",
    content: {
      title: "x",
      categoryIdentifier: null,
      data: { kind: "main_alarm", alarmId: "a", cycleId: "c" },
    },
  };
  const { gateway } = makeGateway([lookalike]);

  const outcome = await deleteAllLocalData(build(store, gateway));

  assert.deepEqual(outcome, { kind: "deleted", ambiguousCount: 1 });
});

test("a failed cancellation keeps the ringing alarm and all data, and leaves a retryable intent", async () => {
  const definitions = ringingDefinitions("m1");
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: definitions });
  const { gateway, scheduled } = makeGateway([ownedMain("m1")], {
    stuck: new Set(["m1"]),
  });

  const outcome = await deleteAllLocalData(build(store, gateway));

  assert.deepEqual(outcome, { kind: "failed" });
  assert.equal(store.data.get(ALARM_DEFINITIONS_STORAGE_KEY), definitions);
  assert.equal(scheduled.length, 1);
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), true);
});

test("after a failure and restart the pending deletion is visible and never auto-completes", async () => {
  const store = makeStore({
    [ALARM_DEFINITIONS_STORAGE_KEY]: ringingDefinitions("m1"),
  });
  const stuck = makeGateway([ownedMain("m1")], { stuck: new Set(["m1"]) });
  await deleteAllLocalData(build(store, stuck.gateway));

  // New process: a fresh service over the same persistent store.
  const restarted = build(store, makeGateway([ownedMain("m1")]).gateway);
  assert.equal(await restarted.hasPendingReset(), true);
  assert.equal(store.data.has(ALARM_DEFINITIONS_STORAGE_KEY), true);

  // Only an explicit second request finishes it.
  const retry = await deleteAllLocalData(restarted);
  assert.equal(retry.kind, "deleted");
  assert.equal(await restarted.hasPendingReset(), false);
  assert.equal(store.data.has(ALARM_DEFINITIONS_STORAGE_KEY), false);
});

test("a listing failure is reported as failed without touching data", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const gateway: StorageResetGateway = {
    async listScheduled() {
      throw new Error("unavailable");
    },
    async cancelScheduled() {},
  };

  assert.deepEqual(await deleteAllLocalData(build(store, gateway)), {
    kind: "failed",
  });
  assert.equal(store.data.get(ALARM_DEFINITIONS_STORAGE_KEY), "{bad");
});

test("deletion serialises with an in-flight mutation instead of interleaving", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const exclusive = chainExclusive();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = makeGateway([], { gate }).gateway;
  const gateway: StorageResetGateway = {
    ...base,
    async listScheduled() {
      events.push("delete-run");
      return base.listScheduled();
    },
  };
  const service = build(store, gateway, exclusive);

  const mutation = exclusive(async () => {
    events.push("mutation-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("mutation-end");
  });
  const deletion = deleteAllLocalData(service);
  const lateMutation = exclusive(async () => {
    events.push("late-mutation");
  });
  release();
  await Promise.all([mutation, deletion, lateMutation]);

  // Deletion lists the queue several times; only its position matters.
  assert.deepEqual(
    events.filter((event, index) => event !== events[index - 1]),
    ["mutation-start", "mutation-end", "delete-run", "late-mutation"],
  );
});

test("deletion is unavailable while ringing, busy or not loaded, and says why", () => {
  assert.deepEqual(
    getLocalDataDeletionAvailability({
      isRinging: false,
      isBusy: false,
      isLoaded: true,
    }),
    { allowed: true },
  );
  for (const state of [
    { isRinging: true, isBusy: false, isLoaded: true },
    { isRinging: false, isBusy: true, isLoaded: true },
    { isRinging: false, isBusy: false, isLoaded: false },
  ]) {
    const result = getLocalDataDeletionAvailability(state);
    assert.equal(result.allowed, false);
    assert.ok("reason" in result && result.reason.length > 0);
  }
});

test("confirmation copy is two steps and states the limits honestly", () => {
  assert.notEqual(
    LOCAL_DATA_COPY.firstConfirmTitle,
    LOCAL_DATA_COPY.finalConfirmTitle,
  );
  assert.match(LOCAL_DATA_COPY.finalConfirmBody, /元に戻せません/);
  assert.match(LOCAL_DATA_COPY.firstConfirmBody, /他のアプリ/);
  assert.doesNotMatch(
    LOCAL_DATA_COPY.summary.join(""),
    /(一切|絶対|完全に安全|ネットワークに接続しません)/,
  );
});

test("failure wording does not claim that nothing was deleted", () => {
  const claims = /何も消(さ|し)ない|何も消しません|消していません|変更(され)?ません/;
  for (const text of [
    LOCAL_DATA_COPY.failed,
    LOCAL_DATA_COPY.deleteHint,
    new StorageResetIncompleteError().message,
  ]) {
    assert.doesNotMatch(text, claims);
  }
  // It must tell the user that part of the data may already be gone and
  // that running the deletion again continues it.
  assert.match(LOCAL_DATA_COPY.failed, /一部/);
  assert.match(LOCAL_DATA_COPY.failed, /もう一度/);
});
