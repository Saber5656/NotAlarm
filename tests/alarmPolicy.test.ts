/// <reference types="node" />

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  CHECK_IN_LEAD_MS,
  MIN_ARM_LEAD_MS,
  STEP_THRESHOLD,
  STEP_WINDOW_LEAD_MS,
  type AlarmRecord,
  canSuppressAlarm,
  classifyStepEvidence,
  finalizeSuppression,
  getCheckInAtMs,
  type WakeEvidence,
} from "../src/alarmPolicy";

const ARMED_AT_MS = 1_000;
const DUE_AT_MS = 100_000;
const CHECK_IN_AT_MS = getCheckInAtMs(DUE_AT_MS, ARMED_AT_MS);

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
    checkInNotificationId: activeAlarm.checkInNotificationId!,
    confirmedAtMs: 60_000,
    ...overrides,
  };
}

test("alarm timing and wake thresholds are fixed", () => {
  assert.equal(STEP_THRESHOLD, 100);
  assert.equal(CHECK_IN_LEAD_MS, 60_000);
  assert.equal(MIN_ARM_LEAD_MS, 10_000);
  assert.equal(getCheckInAtMs(120_000, 0), 60_000);
  assert.equal(getCheckInAtMs(30_000, 0), 15_000);
});

test("100 steps reaches the automatic suppression threshold", () => {
  assert.deepEqual(classifyStepEvidence(99, 2_000, ARMED_AT_MS), {
    kind: "STEP_MONITORING",
    observedAtMs: 2_000,
    steps: 99,
    countedFromMs: ARMED_AT_MS,
  });
  assert.deepEqual(classifyStepEvidence(100, 2_000, ARMED_AT_MS), {
    kind: "STEP_THRESHOLD_REACHED",
    observedAtMs: 2_000,
    steps: 100,
    countedFromMs: ARMED_AT_MS,
  });
});

test("invalid step samples become error evidence", () => {
  assert.deepEqual(classifyStepEvidence(Number.NaN, 2_000, ARMED_AT_MS), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
  assert.deepEqual(classifyStepEvidence(-1, 2_000, ARMED_AT_MS), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
});

test("step samples without a valid counting start become error evidence", () => {
  assert.deepEqual(classifyStepEvidence(100, 2_000, Number.NaN), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
  assert.deepEqual(classifyStepEvidence(100, 2_000, 2_001), {
    kind: "ERROR",
    reason: "INVALID_STEP_SAMPLE",
  });
});

test("step evidence below 100 never suppresses the alarm", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      classifyStepEvidence(99, 5_000, ARMED_AT_MS),
      5_000,
    ),
    { canSuppress: false, reason: "NOT_EXPLICIT_CONFIRMATION" },
  );
});

test("100 fresh steps authorize suppression", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      classifyStepEvidence(100, 5_000, ARMED_AT_MS),
      5_000,
    ),
    { canSuppress: true, reason: "STEP_THRESHOLD_REACHED" },
  );
});

test("stale or due-time step evidence never suppresses", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      classifyStepEvidence(100, ARMED_AT_MS - 1, ARMED_AT_MS - 1),
      5_000,
    ),
    { canSuppress: false, reason: "STALE_STEP_EVIDENCE" },
  );
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      classifyStepEvidence(100, DUE_AT_MS, ARMED_AT_MS),
      DUE_AT_MS,
    ),
    { canSuppress: false, reason: "ALARM_DUE_OR_PAST" },
  );
});

describe("step counting window", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  // Wall-clock labels below are relative to this arbitrary midnight.
  const DAY_START = 1_790_000_000_000;
  const at = (hours: number, minutes = 0) =>
    DAY_START + hours * HOUR + minutes * MINUTE;
  // A repeating 07:00 occurrence scheduled at 20:00 two evenings earlier.
  const morningAlarm: AlarmRecord = {
    cycleId: "cycle-0700",
    mainAlarmId: "main-0700",
    checkInNotificationId: "check-0700",
    armedAtMs: at(-28),
    dueAtMs: at(7),
  };
  const windowStartMs = at(7) - STEP_WINDOW_LEAD_MS;

  test("lead is 60 minutes", () => {
    assert.equal(STEP_WINDOW_LEAD_MS, 60 * MINUTE);
    assert.equal(windowStartMs, at(6));
  });

  test("100 steps counted from 21:00 the previous evening cannot suppress a 07:00 alarm", () => {
    assert.deepEqual(
      canSuppressAlarm(
        morningAlarm,
        classifyStepEvidence(100, at(-3, 30), at(-3)),
        at(-3, 30),
      ),
      { canSuppress: false, reason: "STEP_COUNT_OUTSIDE_WINDOW" },
    );
  });

  test("an evening walk observed inside the window still counts from outside it", () => {
    assert.deepEqual(
      canSuppressAlarm(
        morningAlarm,
        classifyStepEvidence(200, at(6, 30), at(-3)),
        at(6, 30),
      ),
      { canSuppress: false, reason: "STEP_COUNT_OUTSIDE_WINDOW" },
    );
  });

  test("one walk cannot also suppress tomorrow's occurrence", () => {
    const tomorrow: AlarmRecord = {
      ...morningAlarm,
      cycleId: "cycle-0700-tomorrow",
      mainAlarmId: "main-0700-tomorrow",
      dueAtMs: at(24 + 7),
    };
    assert.deepEqual(
      canSuppressAlarm(
        tomorrow,
        classifyStepEvidence(200, at(6, 30), windowStartMs),
        at(6, 30),
      ),
      { canSuppress: false, reason: "STEP_COUNT_OUTSIDE_WINDOW" },
    );
  });

  test("100 steps counted from exactly the window start are accepted", () => {
    assert.deepEqual(
      canSuppressAlarm(
        morningAlarm,
        classifyStepEvidence(100, at(6, 50), windowStartMs),
        at(6, 50),
      ),
      { canSuppress: true, reason: "STEP_THRESHOLD_REACHED" },
    );
  });

  test("counting that starts one millisecond before the window is rejected", () => {
    assert.deepEqual(
      canSuppressAlarm(
        morningAlarm,
        classifyStepEvidence(100, at(6, 50), windowStartMs - 1),
        at(6, 50),
      ),
      { canSuppress: false, reason: "STEP_COUNT_OUTSIDE_WINDOW" },
    );
  });

  test("counting that starts before armedAt is rejected", () => {
    const armedLate: AlarmRecord = { ...morningAlarm, armedAtMs: at(6, 30) };
    assert.deepEqual(
      canSuppressAlarm(
        armedLate,
        classifyStepEvidence(100, at(6, 50), at(6)),
        at(6, 50),
      ),
      { canSuppress: false, reason: "STEP_COUNT_OUTSIDE_WINDOW" },
    );
    assert.deepEqual(
      canSuppressAlarm(
        armedLate,
        classifyStepEvidence(100, at(6, 50), at(6, 30)),
        at(6, 50),
      ),
      { canSuppress: true, reason: "STEP_THRESHOLD_REACHED" },
    );
  });

  test("threshold evidence without a valid counting start is rejected", () => {
    const base = {
      kind: "STEP_THRESHOLD_REACHED" as const,
      observedAtMs: at(6, 50),
      steps: 100,
    };
    const scenarios: WakeEvidence[] = [
      base as unknown as WakeEvidence,
      { ...base, countedFromMs: Number.NaN },
      { ...base, countedFromMs: at(6, 51) },
    ];
    for (const evidence of scenarios) {
      assert.deepEqual(canSuppressAlarm(morningAlarm, evidence, at(6, 50)), {
        canSuppress: false,
        reason: "STEP_COUNT_OUTSIDE_WINDOW",
      });
    }
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
      60_000,
    ),
    { canSuppress: false, reason: "WRONG_CYCLE" },
  );
});

test("confirmation for a different main notification is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ mainAlarmId: "notification-old" }),
      60_000,
    ),
    { canSuppress: false, reason: "WRONG_MAIN_ALARM" },
  );
});

test("confirmation from a different check-in notification is rejected", () => {
  assert.deepEqual(
    canSuppressAlarm(
      activeAlarm,
      explicitConfirmation({ checkInNotificationId: "check-in-early" }),
      60_000,
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
      explicitConfirmation({ confirmedAtMs: 70_000 }),
      60_000,
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
    60_000,
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
