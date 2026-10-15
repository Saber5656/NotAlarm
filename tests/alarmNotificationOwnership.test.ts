/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { parseAlarmNotificationData } from '../src/alarmContracts';
import {
  isAmbiguousAlarmNotification,
  isOwnedAlarmNotification,
  type ScheduledNotificationSnapshot,
} from "../src/alarmNotificationOwnership";

function snapshot(
  overrides: Partial<ScheduledNotificationSnapshot["content"]> = {},
  identifier = "id-1",
): ScheduledNotificationSnapshot {
  return {
    identifier,
    content: {
      title: "⏰ 起きる時間です",
      categoryIdentifier: null,
      data: {
        owner: "already-up/v1",
        kind: "main_alarm",
        alarmId: "a1",
        cycleId: "c1",
      },
      ...overrides,
    },
  };
}

test("accepts a main alarm payload written by this app", () => {
  assert.equal(isOwnedAlarmNotification(snapshot()), true);
});

test("accepts a check-in only with its category and main alarm id", () => {
  const checkIn = snapshot({
    categoryIdentifier: "awake_checkin",
    data: {
      owner: "already-up/v1",
      kind: "awake_checkin",
      alarmId: "a1",
      cycleId: "c1",
      mainAlarmId: "m1",
    },
  });
  assert.equal(isOwnedAlarmNotification(checkIn), true);
  assert.equal(
    isOwnedAlarmNotification({
      ...checkIn,
      content: { ...checkIn.content, categoryIdentifier: "other" },
    }),
    false,
  );
  assert.equal(
    isOwnedAlarmNotification(
      snapshot({
        categoryIdentifier: "awake_checkin",
        data: {
          owner: "already-up/v1",
          kind: "awake_checkin",
          alarmId: "a1",
          cycleId: "c1",
        },
      }),
    ),
    false,
  );
});

test("rejects foreign or malformed payloads", () => {
  for (const data of [
    undefined,
    null,
    "main_alarm",
    {},
    { kind: "reminder", cycleId: "c1" },
    { kind: "main_alarm" },
    { kind: "main_alarm", cycleId: "" },
    { kind: "main_alarm", cycleId: 7 },
    { owner: "already-up/v1", kind: "main_alarm", cycleId: "c1", alarmId: 5 },
    { owner: "already-up/v1", kind: "main_alarm", cycleId: "c1" },
    { owner: "other", kind: "main_alarm", alarmId: "a1", cycleId: "c1" },
  ]) {
    assert.equal(isOwnedAlarmNotification(snapshot({ data })), false);
  }
  assert.equal(isOwnedAlarmNotification(snapshot({}, "")), false);
});

test("contract-shaped payloads without the marker are ambiguous, not owned", () => {
  const legacy = snapshot({
    data: { kind: "main_alarm", alarmId: "a1", cycleId: "c1" },
  });
  assert.equal(isOwnedAlarmNotification(legacy), false);
  assert.equal(isAmbiguousAlarmNotification(legacy), true);
  assert.equal(isAmbiguousAlarmNotification(snapshot()), false);
  assert.equal(
    isAmbiguousAlarmNotification(snapshot({ data: { kind: "x" } })),
    false,
  );
});

test('action responses without the marker still parse (legacy behaviour)', () => {
  const parsed = parseAlarmNotificationData({
    kind: 'awake_checkin',
    alarmId: 'a1',
    cycleId: 'c1',
    mainAlarmId: 'm1',
  });
  assert.equal(parsed?.kind, 'awake_checkin');
  assert.equal(parsed?.cycleId, 'c1');
  assert.equal(parsed?.owner, undefined);
});
