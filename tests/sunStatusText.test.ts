/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { sunStatusText } from "../src/sunStatusText";

test("every fallback and failed outcome has a truthful fixed-time message", () => {
  for (const key of [
    "invalid-saved",
    "permission-revoked",
    "timezone-changed",
    "polar",
    "denied",
    "timeout",
    "error",
    "unsupported-timezone",
  ] as const) {
    const text = sunStatusText(key);
    assert.ok(text.length > 0 && text.length <= 60, key);
    assert.match(text, /固定/, key);
  }
});

test("messages never claim alarms depend on the background", () => {
  assert.doesNotMatch(sunStatusText("timeout"), /アラームが(鳴|止)/);
});

test("a failed lookup never claims the fixed time while a place schedule stays active", () => {
  for (const key of ["denied", "timeout", "error", "unsupported-timezone"] as const) {
    const active = sunStatusText(key, { scheduleActive: true });
    assert.doesNotMatch(active, /固定/, key);
    assert.match(active, /これまでの設定/, key);
    assert.match(sunStatusText(key, { scheduleActive: false }), /固定/, key);
    assert.equal(sunStatusText(key), sunStatusText(key, { scheduleActive: false }));
  }
});
