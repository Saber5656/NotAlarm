/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  SUN_PREFERENCE_KEY,
  readSunPreference,
  roundCoordinate,
  serializeSunPreference,
} from "../src/sunPreference";

test("coordinates are rounded to 0.1 degree", () => {
  assert.equal(roundCoordinate(35.68949), 35.7);
  assert.equal(roundCoordinate(-122.4194), -122.4);
  assert.equal(roundCoordinate(139.0), 139);
});

test("absent storage is distinguished from corrupt storage", () => {
  assert.deepEqual(readSunPreference(null), { kind: "absent" });
  assert.deepEqual(readSunPreference("{nope"), { kind: "invalid" });
  assert.deepEqual(readSunPreference('{"version":2,"mode":"fixed"}'), {
    kind: "invalid",
  });
  assert.deepEqual(readSunPreference('{"version":1,"mode":"gps"}'), {
    kind: "invalid",
  });
});

test("round trips each mode", () => {
  for (const preference of [
    { version: 1, mode: "fixed" },
    { version: 1, mode: "region", regionId: "tokyo" },
    {
      version: 1,
      mode: "device",
      latitude: 35.7,
      longitude: 139.7,
      timeZone: "Asia/Tokyo",
      savedAtMs: 1_700_000_000_000,
    },
  ] as const) {
    assert.deepEqual(readSunPreference(serializeSunPreference(preference)), {
      kind: "valid",
      preference,
    });
  }
});

test("a device preference with out-of-range or unrounded data is invalid", () => {
  const base = {
    version: 1,
    mode: "device",
    latitude: 35.7,
    longitude: 139.7,
    timeZone: "Asia/Tokyo",
    savedAtMs: 1,
  };
  for (const bad of [
    { ...base, latitude: 95 },
    { ...base, longitude: 35.68949 },
    { ...base, timeZone: "" },
    { ...base, savedAtMs: "x" },
  ]) {
    assert.equal(readSunPreference(JSON.stringify(bad)).kind, "invalid");
  }
});

test("extra fields such as a raw trace are dropped on write", () => {
  const written = serializeSunPreference({
    version: 1,
    mode: "fixed",
    latitude: 35.123456,
  } as never);
  assert.deepEqual(JSON.parse(written), { version: 1, mode: "fixed" });
  assert.match(SUN_PREFERENCE_KEY, /v1$/);
});
