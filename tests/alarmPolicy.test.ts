/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_IN_LEAD_MS,
  MIN_ARM_LEAD_MS,
  STEP_THRESHOLD,
  type AlarmRecord,
  canSuppressAlarm,
  classifyStepEvidence,
  finalizeSuppression,
  getCheckInAtMs,
  type WakeEvidence,
} from "../src/alarmPolicy";

const ARMED_AT_MS = 1_000;
const DUE_AT_MS = 100_000;
const CHECK_IN_AT_MS = DUE_AT_MS - CHECK_IN_LEAD_MS;

const activeAlarm: AlarmRecord = {
  cycleId: "cycle-current",
  mainAlarmId: "notification-current",
  checkInNotificationId: "check-in-current",
  armedAtMs: ARMED_AT_MS,
  dueAtMs: DUE_AT_MS,
};

function explicitConfirmation(
  overrides: Partial<Extract<WakeEvidence, { kind: "EXPLICIT_AWAKE_CONFIRMATION" }>> = {},
): Extract<WakeEvidence, { kind: "EXPLICIT_AWAKE_CONFIRMATION" }> {
  return {
    kind: "EXPLICIT_AWAKE_CONFIRMATION",
    cycleId: activeAlarm.cycleId,
    mainAlarmId: activeAlarm.mainAlarmId,
    checkInNotificationId: activeAlarm.checkInNotificationId,
    confirmedAtMs: 50_000,
    ...overrides,
  };
}

test("MVP timing constants are fixed", () => {
  assert.equal(STEP_THRESHOLD, 20);
  assert.equal(CHECK_IN_LEAD_MS, 60_000);
  assert.equal(MIN_ARM_LEAD_MS, 90_000);
  assert.equal(getCheckInAtMs(120_000), 60_000);
});

test("20 steps is only STEP_CANDIDATE", () => {
  assert.deepEqual(classifyStepEvidence(19, 2_000), {
    kind: "STEP_MONITORING",
    observedAtMs: 2_000,
    steps: 19,
  });
  assert.deepEqual(classifyStepEvidence(20, 2_000), {
    kind: "STEP_CANDIDATE",
    observedAtMs: 2_000,
    steps: 20,
  });
});

test("invalid step samples become error evidence", () => {
  assert.deepEqual(classifyStepEvidence(Number.NaN, 2_000), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
  assert.deepEqual(classifyStepEvidence(-1, 2_000), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
});

test("step evidence alone never suppresses the alarm", () => {
  const decision = canSuppressAlarm(
    activeAlarm,
    classifyStepEvidence(20, 5_000),
    50_000,
  );

  assert.deepEqual(decision, {
    canSuppress: false,
    reason: "NOT_EXPLICIT_CONFIRMATION",
  });
});

test("unknown and error evidence never suppress the alarm", () => {
  assert.equal(
    canSuppressAlarm(activeAlarm, { kind: "UNKNOWN" }, 50_000).canSuppress,
    false,
  );
  assert.equal(
    canSuppressAlarm(
      activeAlarm,
      { kind: "ERROR", reason: "notification response unavailable" },
      50_000,
    ).canSuppress,
    false,
  );
});

test("matching explicit confirmation at the check-in boundary is accepted", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: CHECK_IN_AT_MS }),
      CHECK_IN_AT_MS,
    ),
    { canSuppress: true, reason: "CONFIRMED_AWAKE" },
  );
});

test("confirmation from a different cycle is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ cycleId: "cycle-old" }),
      50_000,
    ),
    { canSuppress: false, reason: "WRONG_CYCLE" },
  );
});

test("confirmation for a different main notification is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ mainAlarmId: "notification-old" }),
      50_000,
    ),
    { canSuppress: false, reason: "WRONG_MAIN_ALARM" },
  );
});

test("confirmation from a different check-in notification is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ checkInNotificationId: "check-in-early" }),
      50_000,
    ),
    { canSuppress: false, reason: "WRONG_CHECK_IN" },
  );
});

test("confirmation before armedAt is stale and rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: ARMED_AT_MS - 1 }),
      50_000,
    ),
    { canSuppress: false, reason: "STALE_CONFIRMATION" },
  );
});

test("confirmation before the final check-in window is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: CHECK_IN_AT_MS - 1 }),
      CHECK_IN_AT_MS - 1,
    ),
    {
      canSuppress: false,
      reason: "CONFIRMATION_BEFORE_CHECK_IN_WINDOW",
    },
  );
});

test("confirmation exactly at or after dueAt is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: DUE_AT_MS }),
      DUE_AT_MS - 1,
    ),
    { canSuppress: false, reason: "CONFIRMATION_AT_OR_AFTER_DUE" },
  );
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: DUE_AT_MS + 1 }),
      DUE_AT_MS - 1,
    ),
    { canSuppress: false, reason: "CONFIRMATION_AT_OR_AFTER_DUE" },
  );
});

test("processing exactly at or after dueAt is rejected even for valid evidence", () => {
  assert.deepEqual(
    canSuppressAlarm(activeAlarm, explicitConfirmation(), DUE_AT_MS),
    { canSuppress: false, reason: "ALARM_DUE_OR_PAST" },
  );
  assert.deepEqual(
    canSuppressAlarm(activeAlarm, explicitConfirmation(), DUE_AT_MS + 1),
    { canSuppress: false, reason: "ALARM_DUE_OR_PAST" },
  );
});

test("a future-dated confirmation fails closed", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ confirmedAtMs: 60_000 }),
      50_000,
    ),
    { canSuppress: false, reason: "CONFIRMATION_IN_FUTURE" },
  );
});

test("malformed alarm records fail closed", () => {
  assert.deepEqual(
    canSuppressAlarm(
      { ...activeAlarm, dueAtMs: ARMED_AT_MS },
      explicitConfirmation(),
      50_000,
    ),
    { canSuppress: false, reason: "INVALID_ALARM_RECORD" },
  );
});

test("cancellation must succeed before the alarm is considered suppressed", () => {
  const accepted = canSuppressAlarm(
    activeAlarm,
    explicitConfirmation(),
    50_000,
  );

  assert.equal(finalizeSuppression(accepted, true), "SUPPRESSED");
  assert.equal(finalizeSuppression(accepted, false), "ALARM_REMAINS_ARMED");
  assert.equal(finalizeSuppression(accepted, undefined), "ALARM_REMAINS_ARMED");
});

test("a successful cancellation result cannot override a rejected policy decision", () => {
  const rejected = canSuppressAlarm(
    activeAlarm,
    { kind: "UNKNOWN" },
    50_000,
  );

  assert.equal(finalizeSuppression(rejected, true), "ALARM_REMAINS_ARMED");
});
