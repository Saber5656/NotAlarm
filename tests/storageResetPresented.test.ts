/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import type { ScheduledNotificationSnapshot } from "../src/alarmNotificationOwnership";
import { ALARM_DEFINITIONS_STORAGE_KEY } from "../src/alarmStorage";
import {
  STORAGE_RESET_INTENT_KEY,
  StorageResetIncompleteError,
  createStorageResetService,
  type StorageResetGateway,
} from "../src/storageReset";
import {
  canCloseSettings,
} from "../src/localDataDeletion";
import { en, ja } from "./support/text";

function owned(identifier: string): ScheduledNotificationSnapshot {
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

/** A fake OS whose scheduled->presented move can be triggered at any read. */
function makeOs(options: {
  scheduled?: ScheduledNotificationSnapshot[];
  presented?: ScheduledNotificationSnapshot[];
  failDismiss?: Set<string>;
  failListPresented?: boolean;
  /** Called after each listScheduled; may mutate the queues. */
  afterListScheduled?: (os: ReturnType<typeof makeOs>, call: number) => void;
}) {
  const os = {
    scheduled: [...(options.scheduled ?? [])],
    presented: [...(options.presented ?? [])],
    dismissed: [] as string[],
    cancelled: [] as string[],
    scheduledReads: 0,
    presentedReads: 0,
    gateway: undefined as unknown as StorageResetGateway,
  };
  os.gateway = {
    async listScheduled() {
      const snapshot = [...os.scheduled];
      os.scheduledReads += 1;
      options.afterListScheduled?.(os, os.scheduledReads);
      return snapshot;
    },
    async cancelScheduled(id) {
      os.cancelled.push(id);
      os.scheduled = os.scheduled.filter((item) => item.identifier !== id);
    },
    async listPresented() {
      os.presentedReads += 1;
      if (options.failListPresented) {
        throw new Error("presented unavailable");
      }
      return [...os.presented];
    },
    async dismissPresented(id) {
      if (options.failDismiss?.has(id)) {
        throw new Error("dismiss failed");
      }
      os.dismissed.push(id);
      os.presented = os.presented.filter((item) => item.identifier !== id);
    },
  };
  return os;
}

function build(store: ReturnType<typeof makeStore>, gateway: StorageResetGateway) {
  return createStorageResetService({
    store,
    gateway,
    exclusive: (run) => run(),
    nowMs: () => 1,
  });
}

test("dismisses an owned notification already presented, leaving foreign ones", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({ presented: [owned("p1"), foreign("other-project")] });

  await build(store, os.gateway).reset();

  assert.deepEqual(os.dismissed, ["p1"]);
  assert.deepEqual(
    os.presented.map((item) => item.identifier),
    ["other-project"],
  );
  assert.equal(store.data.has(ALARM_DEFINITIONS_STORAGE_KEY), false);
});

test("a notification delivered after the first scheduled read is still dismissed", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({
    scheduled: [owned("m1")],
    afterListScheduled: (state, call) => {
      if (call === 1) {
        const moved = state.scheduled.splice(0);
        state.presented.push(...moved);
      }
    },
  });

  await build(store, os.gateway).reset();

  assert.deepEqual(os.dismissed, ["m1"]);
  assert.deepEqual(os.presented, []);
  assert.equal(store.data.has(STORAGE_RESET_INTENT_KEY), false);
});

test("a delivery landing during the verification read is caught by the recheck", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({
    scheduled: [owned("m1")],
    afterListScheduled: (state, call) => {
      // The verification read of the first pass: m2 is delivered right then.
      if (call === 2) {
        state.presented.push(owned("m2"));
      }
    },
  });

  await build(store, os.gateway).reset();

  assert.deepEqual(os.presented, []);
  assert.deepEqual(os.dismissed, ["m2"]);
});

test("a dismiss failure keeps the data and the durable intent and is not reported as success", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({ presented: [owned("p1")], failDismiss: new Set(["p1"]) });
  const svc = build(store, os.gateway);

  await assert.rejects(svc.reset(), StorageResetIncompleteError);
  assert.equal(store.data.get(ALARM_DEFINITIONS_STORAGE_KEY), "{bad");
  assert.equal(await svc.hasPendingReset(), true);
  const intent = JSON.parse(store.data.get(STORAGE_RESET_INTENT_KEY)!);
  assert.ok(intent.ownedIds.includes("p1"));
});

test("an unreadable presented list is uncertain: failure, not success", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({ failListPresented: true });
  const svc = build(store, os.gateway);

  await assert.rejects(svc.reset());
  assert.equal(store.data.get(ALARM_DEFINITIONS_STORAGE_KEY), "{bad");
  assert.equal(await svc.hasPendingReset(), true);
});

test("a presented notification that stays after dismiss ends the bounded recheck as failure", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  const os = makeOs({ presented: [owned("p1")] });
  os.gateway.dismissPresented = async (id) => {
    os.dismissed.push(id);
  };

  await assert.rejects(build(store, os.gateway).reset(), StorageResetIncompleteError);
  assert.ok(os.presentedReads < 20, "recheck must be bounded");
  assert.equal(await build(store, os.gateway).hasPendingReset(), true);
});

test("a payload-owned id is persisted before cancellation, so a presented copy without payload still matches", async () => {
  const store = makeStore({ [ALARM_DEFINITIONS_STORAGE_KEY]: "{bad" });
  let intentAtCancel: string | null = null;
  const os = makeOs({
    scheduled: [owned("m1")],
  });
  const cancel = os.gateway.cancelScheduled;
  os.gateway.cancelScheduled = async (id) => {
    intentAtCancel = store.data.get(STORAGE_RESET_INTENT_KEY) ?? null;
    await cancel(id);
    // Delivered right after cancel, with no readable payload.
    os.presented.push({
      identifier: id,
      content: { title: null, categoryIdentifier: null, data: undefined },
    });
  };

  await build(store, os.gateway).reset();

  assert.ok(JSON.parse(intentAtCancel!).ownedIds.includes("m1"));
  assert.deepEqual(os.dismissed, ["m1"]);
});

test("settings cannot be closed while a deletion is in flight, and the failure copy tells how to retry from home", () => {
  assert.equal(canCloseSettings({ deletionInFlight: true }), false);
  assert.equal(canCloseSettings({ deletionInFlight: false }), true);
  assert.match(ja.settings.failedHome, /設定/);
  assert.match(ja.settings.failedHome, /データを削除/);
  // English users get the same home notice, with no Japanese-only UI.
  assert.match(en.settings.failedHome, /Settings/);
  assert.doesNotMatch(en.settings.failedHome, /[぀-ヿ㐀-鿿]/);
});
