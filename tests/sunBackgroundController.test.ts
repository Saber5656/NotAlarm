/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSunBackgroundController,
  type LocationGateway,
  type LocationPermission,
} from "../src/sunBackgroundController";
import { SUN_PREFERENCE_KEY } from "../src/sunPreference";
import { StorageResetPendingError } from "../src/storageResetGate";
import type { KeyValueStore } from "../src/suppressionJournal";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
  return { data, store };
}

interface GatewayOptions {
  permission?: LocationPermission;
  requested?: LocationPermission;
  position?: () => Promise<{ latitude: number; longitude: number }>;
}

function gateway(options: GatewayOptions = {}) {
  const calls = { get: 0, request: 0, position: 0 };
  const value: LocationGateway = {
    getPermission: async () => {
      calls.get += 1;
      return options.permission ?? "undetermined";
    },
    requestPermission: async () => {
      calls.request += 1;
      return options.requested ?? "granted";
    },
    getApproximatePosition: async () => {
      calls.position += 1;
      return (
        options.position?.() ??
        Promise.resolve({ latitude: 35.68949, longitude: 139.69171 })
      );
    },
  };
  return { calls, gateway: value };
}

function controller(
  store: KeyValueStore,
  location: LocationGateway,
  overrides: { timeoutMs?: number; deviceTimeZone?: string | undefined } = {},
) {
  return createSunBackgroundController({
    store,
    location,
    nowMs: () => 1_800_000_000_000,
    deviceTimeZone: () =>
      "deviceTimeZone" in overrides ? overrides.deviceTimeZone : "Asia/Tokyo",
    timeoutMs: overrides.timeoutMs ?? 50,
  });
}

test("loading never asks for permission or position", async () => {
  const { store } = memoryStore();
  const g = gateway();
  const result = await controller(store, g.gateway).load();
  assert.deepEqual(result.preference, { version: 1, mode: "fixed" });
  assert.equal(g.calls.request, 0);
  assert.equal(g.calls.position, 0);
});

test("choosing a region saves it without any location call", async () => {
  const { store, data } = memoryStore();
  const g = gateway();
  await controller(store, g.gateway).chooseRegion("tokyo");
  assert.deepEqual(JSON.parse(data.get(SUN_PREFERENCE_KEY)!), {
    version: 1,
    mode: "region",
    regionId: "tokyo",
  });
  assert.deepEqual(g.calls, { get: 0, request: 0, position: 0 });
});

test("an unknown region is rejected and nothing is stored", async () => {
  const { store, data } = memoryStore();
  await assert.rejects(() =>
    controller(store, gateway().gateway).chooseRegion("atlantis"),
  );
  assert.equal(data.size, 0);
});

test("explicit device location stores only rounded coordinates", async () => {
  const { store, data } = memoryStore();
  const g = gateway();
  const outcome = await controller(store, g.gateway).useDeviceLocation();
  assert.equal(outcome.kind, "saved");
  const saved = JSON.parse(data.get(SUN_PREFERENCE_KEY)!);
  assert.equal(saved.mode, "device");
  assert.equal(saved.latitude, 35.7);
  assert.equal(saved.longitude, 139.7);
  assert.equal(saved.timeZone, "Asia/Tokyo");
  assert.equal(saved.savedAtMs, 1_800_000_000_000);
  assert.ok(!data.get(SUN_PREFERENCE_KEY)!.includes("35.68949"));
});

test("an already granted permission is not requested again", async () => {
  const g = gateway({ permission: "granted" });
  await controller(memoryStore().store, g.gateway).useDeviceLocation();
  assert.equal(g.calls.request, 0);
  assert.equal(g.calls.position, 1);
});

test("denied permission keeps the previous choice and reports denied", async () => {
  const { store, data } = memoryStore();
  const c = controller(store, gateway({ requested: "denied" }).gateway);
  await c.chooseRegion("london");
  const outcome = await c.useDeviceLocation();
  assert.equal(outcome.kind, "denied");
  assert.equal(JSON.parse(data.get(SUN_PREFERENCE_KEY)!).mode, "region");
});

test("a slow position times out and does not change the saved choice", async () => {
  const { store, data } = memoryStore();
  const g = gateway({ position: () => new Promise(() => {}) });
  const outcome = await controller(store, g.gateway, {
    timeoutMs: 10,
  }).useDeviceLocation();
  assert.equal(outcome.kind, "timeout");
  assert.equal(data.size, 0);
});

test("a thrown position error is reported as error", async () => {
  const g = gateway({ position: () => Promise.reject(new Error("off")) });
  const outcome = await controller(
    memoryStore().store,
    g.gateway,
  ).useDeviceLocation();
  assert.equal(outcome.kind, "error");
});

test("an unreadable device time zone refuses to save a position", async () => {
  const { store, data } = memoryStore();
  const outcome = await controller(store, gateway().gateway, {
    deviceTimeZone: undefined,
  }).useDeviceLocation();
  assert.equal(outcome.kind, "unsupported-timezone");
  assert.equal(data.size, 0);
});

test("a late position after choosing fixed is discarded", async () => {
  const { store, data } = memoryStore();
  let release!: (v: { latitude: number; longitude: number }) => void;
  const g = gateway({
    position: () => new Promise((resolve) => (release = resolve)),
  });
  const c = controller(store, g.gateway, { timeoutMs: 1_000 });
  const pending = c.useDeviceLocation();
  await new Promise((r) => setTimeout(r, 5));
  await c.chooseFixed();
  release({ latitude: 10.04, longitude: 20.04 });
  assert.equal((await pending).kind, "cancelled");
  assert.deepEqual(JSON.parse(data.get(SUN_PREFERENCE_KEY)!), {
    version: 1,
    mode: "fixed",
  });
});

test("a late position after deleting data is discarded", async () => {
  const { store, data } = memoryStore();
  let release!: (v: { latitude: number; longitude: number }) => void;
  const g = gateway({
    position: () => new Promise((resolve) => (release = resolve)),
  });
  const c = controller(store, g.gateway, { timeoutMs: 1_000 });
  const pending = c.useDeviceLocation();
  await new Promise((r) => setTimeout(r, 5));
  await c.clear();
  release({ latitude: 10.04, longitude: 20.04 });
  assert.equal((await pending).kind, "cancelled");
  assert.equal(data.size, 0);
});

test("choosing fixed after a device position removes the stored location", async () => {
  const { store, data } = memoryStore();
  const c = controller(store, gateway().gateway);
  await c.useDeviceLocation();
  await c.chooseFixed();
  const raw = data.get(SUN_PREFERENCE_KEY)!;
  assert.ok(!raw.includes("latitude") && !raw.includes("timeZone"));
});

test("revoked permission reverts a saved device choice to fixed", async () => {
  const device = JSON.stringify({
    version: 1,
    mode: "device",
    latitude: 35.7,
    longitude: 139.7,
    timeZone: "Asia/Tokyo",
    savedAtMs: 1,
  });
  const { store, data } = memoryStore({ [SUN_PREFERENCE_KEY]: device });
  const g = gateway({ permission: "denied" });
  const result = await controller(store, g.gateway).load();
  assert.equal(result.preference.mode, "fixed");
  assert.equal(result.notice, "permission-revoked");
  assert.equal(g.calls.request, 0);
  assert.ok(!data.get(SUN_PREFERENCE_KEY)?.includes("latitude"));
});

test("a changed device time zone reverts a saved device choice to fixed", async () => {
  const device = JSON.stringify({
    version: 1,
    mode: "device",
    latitude: 35.7,
    longitude: 139.7,
    timeZone: "Asia/Tokyo",
    savedAtMs: 1,
  });
  const { store } = memoryStore({ [SUN_PREFERENCE_KEY]: device });
  const result = await controller(
    store,
    gateway({ permission: "granted" }).gateway,
    { deviceTimeZone: "Europe/London" },
  ).load();
  assert.equal(result.preference.mode, "fixed");
  assert.equal(result.notice, "timezone-changed");
});

test("corrupt saved data is replaced by fixed with a notice", async () => {
  const { store, data } = memoryStore({ [SUN_PREFERENCE_KEY]: "{bad" });
  const result = await controller(store, gateway().gateway).load();
  assert.equal(result.preference.mode, "fixed");
  assert.equal(result.notice, "invalid-saved");
  assert.equal(data.has(SUN_PREFERENCE_KEY), false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function guardedController(
  store: KeyValueStore,
  location: LocationGateway,
  pending: { value: boolean },
) {
  return createSunBackgroundController({
    store,
    location,
    nowMs: () => 1_800_000_000_000,
    deviceTimeZone: () => "Asia/Tokyo",
    timeoutMs: 50,
    assertWritable: async () => {
      if (pending.value) {
        throw new StorageResetPendingError();
      }
    },
  });
}

test("a permission answer arriving after deletion starts saves nothing and asks for no position", async () => {
  const { store, data } = memoryStore();
  const answer = deferred<LocationPermission>();
  const g = gateway();
  g.gateway.requestPermission = () => answer.promise;
  const c = controller(store, g.gateway);
  const lookup = c.useDeviceLocation();
  await new Promise((r) => setImmediate(r));
  c.invalidate(); // deletion confirmed
  await c.clear();
  answer.resolve("granted");
  assert.equal((await lookup).kind, "cancelled");
  assert.equal(g.calls.position, 0);
  assert.equal(data.size, 0);
});

test("a position arriving after deletion started is dropped", async () => {
  const { store, data } = memoryStore();
  const position = deferred<{ latitude: number; longitude: number }>();
  const g = gateway({ position: () => position.promise });
  const c = controller(store, g.gateway);
  const lookup = c.useDeviceLocation();
  await new Promise((r) => setImmediate(r));
  c.invalidate();
  position.resolve({ latitude: 35.68, longitude: 139.69 });
  assert.equal((await lookup).kind, "cancelled");
  assert.equal(data.size, 0);
});

test("a load that was reading when deletion started is marked stale", async () => {
  const { store } = memoryStore({
    [SUN_PREFERENCE_KEY]: JSON.stringify({
      version: 1,
      mode: "region",
      regionId: "london",
    }),
  });
  const gate = deferred<string | null>();
  const slow: KeyValueStore = { ...store, getItem: () => gate.promise };
  const c = controller(slow, gateway().gateway);
  const loading = c.load();
  c.invalidate();
  gate.resolve(await store.getItem(SUN_PREFERENCE_KEY));
  const result = await loading;
  assert.equal(result.stale, true);
  assert.deepEqual(result.preference, { version: 1, mode: "fixed" });
});

test("while a deletion is pending nothing is written and no prompt is shown", async () => {
  const saved = JSON.stringify({ version: 1, mode: "region", regionId: "london" });
  const { store, data } = memoryStore({ [SUN_PREFERENCE_KEY]: saved });
  const pending = { value: true };
  const g = gateway();
  const c = guardedController(store, g.gateway, pending);
  await assert.rejects(() => c.chooseRegion("tokyo"), StorageResetPendingError);
  await assert.rejects(() => c.chooseFixed(), StorageResetPendingError);
  assert.equal((await c.useDeviceLocation()).kind, "reset-pending");
  assert.deepEqual(g.calls, { get: 0, request: 0, position: 0 });
  assert.equal(data.get(SUN_PREFERENCE_KEY), saved);
  // The stored place is not applied to the theme while deletion is pending.
  assert.deepEqual((await c.load()).preference, { version: 1, mode: "fixed" });
  pending.value = false;
  assert.equal((await c.load()).preference.mode, "region");
});

test("saves run inside the shared storage lock", async () => {
  const { store } = memoryStore();
  const events: string[] = [];
  const c = createSunBackgroundController({
    store,
    location: gateway().gateway,
    nowMs: () => 1,
    deviceTimeZone: () => "Asia/Tokyo",
    exclusive: async (run) => {
      events.push("lock");
      const value = await run();
      events.push("unlock");
      return value;
    },
  });
  await c.chooseRegion("tokyo");
  assert.deepEqual(events, ["lock", "unlock"]);
});

test("starting with an unfinished deletion reports reset-pending immediately", async () => {
  const saved = JSON.stringify({ version: 1, mode: "region", regionId: "london" });
  const { store } = memoryStore({ [SUN_PREFERENCE_KEY]: saved });
  const pending = { value: true };
  const c = guardedController(store, gateway().gateway, pending);
  const loaded = await c.load();
  assert.deepEqual(loaded.preference, { version: 1, mode: "fixed" });
  assert.equal(loaded.notice, "reset-pending");
  pending.value = false;
  assert.equal((await c.load()).notice, undefined);
});

test("a corrupt value found while a deletion is pending still reports reset-pending", async () => {
  const { store } = memoryStore({ [SUN_PREFERENCE_KEY]: "{not json" });
  const c = guardedController(store, gateway().gateway, { value: true });
  assert.equal((await c.load()).notice, "reset-pending");
});
