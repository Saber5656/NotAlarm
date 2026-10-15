/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { makeAlarmRepeat } from '../src/alarmSchedule';
import { RECOVERY_WINDOW_MS } from '../src/missedAlarms';
import {
  type MainDeliveryIdentity,
  markCycleRinging,
  prepareAlarmEnable,
  replaceStoredCycle,
  updateMonitoringCycleStepCount,
} from '../src/alarmDefinitionMutations';
import type {
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';

const WINDOW_START_MS = 1_000;

function cycle(
  phase: StoredAlarm['phase'],
  stepCount = 0,
  stepCountFromMs?: number,
): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: 1_000,
    dueAtMs: 10_000,
    phase,
    stepCount,
    ...(stepCountFromMs === undefined ? {} : { stepCountFromMs }),
    stepCandidateRecorded: false,
  };
}

function definition(currentCycle: StoredAlarm): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: { kind: 'daily', weekdays: [] },
    enabled: true,
    createdAtMs: 1_000,
    cycles: [currentCycle],
  };
}

test('updates only the latest monitoring cycle step count', () => {
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('armed', 12, WINDOW_START_MS))],
    'alarm-1',
    'cycle-1',
    24,
    WINDOW_START_MS,
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 24);
  assert.equal(result.alarms[0]?.cycles[0]?.stepCountFromMs, WINDOW_START_MS);
});

test('never lets a stale step callback rearm or overwrite a suppressed cycle', () => {
  const suppressed = {
    ...cycle('suppressed', 100),
    confirmedAtMs: 5_000,
  };
  const result = updateMonitoringCycleStepCount(
    [definition(suppressed)],
    'alarm-1',
    'cycle-1',
    42,
    WINDOW_START_MS,
  );

  assert.equal(result.status, 'not_monitoring');
  assert.deepEqual(result.alarms[0]?.cycles[0], suppressed);
});

test('keeps persisted step progress monotonic within the same window', () => {
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('step_candidate', 80, WINDOW_START_MS))],
    'alarm-1',
    'cycle-1',
    60,
    WINDOW_START_MS,
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 80);
  assert.equal(result.alarms[0]?.cycles[0]?.stepCountFromMs, WINDOW_START_MS);
});

test('a new counting window replaces progress from an older window', () => {
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('armed', 80, WINDOW_START_MS))],
    'alarm-1',
    'cycle-1',
    12,
    WINDOW_START_MS + 500,
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 12);
  assert.equal(
    result.alarms[0]?.cycles[0]?.stepCountFromMs,
    WINDOW_START_MS + 500,
  );
});

test('legacy progress without a counting start is replaced', () => {
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('armed', 95))],
    'alarm-1',
    'cycle-1',
    3,
    WINDOW_START_MS,
  );

  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 3);
  assert.equal(result.alarms[0]?.cycles[0]?.stepCountFromMs, WINDOW_START_MS);
});

test('rejects a step update without a valid counting start', () => {
  assert.throws(() =>
    updateMonitoringCycleStepCount(
      [definition(cycle('armed', 10, WINDOW_START_MS))],
      'alarm-1',
      'cycle-1',
      20,
      Number.NaN,
    ),
  );
});

test('uses the definition id as well as the cycle id', () => {
  const otherCycle = {
    ...cycle('armed', 7),
    alarmId: 'alarm-2',
  };
  const otherDefinition = {
    ...definition(otherCycle),
    id: 'alarm-2',
  };
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('armed', 10)), otherDefinition],
    'alarm-1',
    'cycle-1',
    30,
    WINDOW_START_MS,
  );

  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 30);
  assert.equal(result.alarms[1]?.cycles[0]?.stepCount, 7);
});

test('ignores progress counted from before the stored counting start', () => {
  // Another suppression moved this cycle's start to WINDOW_START_MS + 500
  // while an older step callback was still counting from WINDOW_START_MS.
  const floored = cycle('armed', 0, WINDOW_START_MS + 500);
  const result = updateMonitoringCycleStepCount(
    [definition(floored)],
    'alarm-1',
    'cycle-1',
    90,
    WINDOW_START_MS,
  );

  assert.equal(result.status, 'stale_window');
  assert.deepEqual(result.alarms[0]?.cycles[0], floored);
});

test('saving a suppressed cycle writes its confirmation time into overlapping cycles', () => {
  const MINUTE = 60_000;
  const due = 10_000_000;
  const suppressedTarget = {
    ...cycle('armed', 40, due - 60 * MINUTE),
    dueAtMs: due,
  };
  const other: StoredAlarm = {
    ...cycle('armed', 25, due - 50 * MINUTE),
    alarmId: 'alarm-2',
    cycleId: 'cycle-2',
    dueAtMs: due + 30 * MINUTE,
  };
  const alarms: StoredAlarmDefinition[] = [
    { ...definition(suppressedTarget) },
    { ...definition(other), id: 'alarm-2' },
  ];
  const suppressed: StoredAlarm = {
    ...suppressedTarget,
    phase: 'suppressed',
    stepCount: 100,
    confirmedAtMs: due - 20 * MINUTE,
  };

  const next = replaceStoredCycle(alarms, suppressed);

  assert.deepEqual(next[0]?.cycles[0], suppressed);
  assert.equal(next[1]?.cycles[0]?.stepCountFromMs, due - 20 * MINUTE);
  assert.equal(next[1]?.cycles[0]?.stepCount, 0);
});

test('saving a non-suppressed cycle leaves other cycles alone', () => {
  const ringing = { ...cycle('ringing', 10, WINDOW_START_MS), confirmedAtMs: 5_000 };
  const other: StoredAlarm = {
    ...cycle('armed', 25, WINDOW_START_MS),
    alarmId: 'alarm-2',
    cycleId: 'cycle-2',
  };
  const alarms: StoredAlarmDefinition[] = [
    definition(cycle('armed', 10, WINDOW_START_MS)),
    { ...definition(other), id: 'alarm-2' },
  ];

  const next = replaceStoredCycle(alarms, ringing);

  assert.deepEqual(next[0]?.cycles[0], ringing);
  assert.deepEqual(next[1]?.cycles[0], other);
});

test('saving an unknown cycle throws', () => {
  assert.throws(() =>
    replaceStoredCycle([definition(cycle('armed'))], {
      ...cycle('suppressed'),
      cycleId: 'missing',
    }),
  );
});

describe('prepareAlarmEnable', () => {
  const created = new Date(2026, 9, 15, 6, 0).getTime();
  const base = (repeat: StoredAlarmDefinition['repeat']): StoredAlarmDefinition => ({
    id: 'a',
    hour: 7,
    minute: 0,
    repeat,
    enabled: false,
    createdAtMs: created,
    cycles: [],
  });

  test('expired today-only keeps its date and cannot be enabled', () => {
    const def = base(makeAlarmRepeat('today', created));
    const result = prepareAlarmEnable(def, new Date(2026, 9, 16, 5, 0).getTime());
    assert.equal(result.ok, false);
    assert.equal(def.repeat.dateKey, '2026-10-15');
  });

  test('same-day past time is rejected without rebinding', () => {
    const def = base(makeAlarmRepeat('today', created));
    const result = prepareAlarmEnable(def, new Date(2026, 9, 15, 8, 0).getTime());
    assert.equal(result.ok, false);
  });

  test('future today-only keeps its original repeat object values', () => {
    const def = base(makeAlarmRepeat('today', created));
    const result = prepareAlarmEnable(def, created);
    assert.ok(result.ok);
    assert.equal(result.ok && result.definition.repeat.dateKey, '2026-10-15');
  });

  test('repeating alarms are unchanged', () => {
    const def = base(makeAlarmRepeat('daily', created));
    const result = prepareAlarmEnable(def, new Date(2026, 9, 20, 8, 0).getTime());
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.definition.repeat, def.repeat);
  });

  test('repeating alarms retain the minimum lead-time guard when enabled', () => {
    const def = base(makeAlarmRepeat('daily', created));
    const due = new Date(2026, 9, 15, 7, 0).getTime();
    assert.equal(prepareAlarmEnable(def, due - 9_999).ok, false);
    assert.equal(prepareAlarmEnable(def, due - 10_000).ok, true);
  });
});

describe('markCycleRinging', () => {
  const identity = { cycleId: 'cycle-1', mainAlarmId: 'main-1' };
  const NOW_MS = 10_500;

  function mark(
    stored: StoredAlarm,
    expected: Partial<MainDeliveryIdentity> = {},
    nowMs = NOW_MS,
  ) {
    return markCycleRinging(
      [definition(stored)],
      { ...identity, ...expected },
      nowMs,
    );
  }

  test('rings an armed or step_candidate cycle that matches and is due', () => {
    for (const phase of ['armed', 'step_candidate'] as const) {
      const result = mark(cycle(phase, 40), { dueAtMs: 10_000 });
      assert.equal(result.status, 'ringing');
      assert.equal(result.alarms[0]?.cycles[0]?.phase, 'ringing');
      assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 40);
    }
  });

  test('never revives a finished cycle from an old or duplicate delivery', () => {
    for (const phase of ['suppressed', 'dismissed', 'missed'] as const) {
      const stored = cycle(phase);
      const result = mark(stored);
      assert.equal(result.status, 'not_awaiting');
      assert.deepEqual(result.alarms[0]?.cycles[0], stored);
    }
  });

  test('a repeated delivery of a ringing cycle changes nothing', () => {
    const stored = cycle('ringing');
    const result = mark(stored);
    assert.equal(result.status, 'already_ringing');
    assert.deepEqual(result.alarms[0]?.cycles[0], stored);
  });

  test('a phase this build does not know is left alone', () => {
    const stored = { ...cycle('armed'), phase: 'future_phase' } as unknown as StoredAlarm;
    const result = mark(stored);
    assert.equal(result.status, 'not_awaiting');
    assert.deepEqual(result.alarms[0]?.cycles[0], stored);
  });

  test('requires the exact cycle, main notification and due time', () => {
    const stored = cycle('armed');
    assert.equal(mark(stored, { cycleId: 'cycle-2' }).status, 'not_found');
    assert.equal(mark(stored, { mainAlarmId: 'main-0' }).status, 'mismatch');
    assert.equal(mark(stored, { dueAtMs: 9_999 }).status, 'mismatch');
    assert.equal(mark(stored, { alarmId: 'alarm-2' }).status, 'not_found');
    for (const status of ['mismatch', 'not_found']) {
      assert.notEqual(status, 'ringing');
    }
    assert.equal(mark(stored, { mainAlarmId: 'main-0' }).alarms[0]?.cycles[0]?.phase, 'armed');
  });

  test('does not ring before the stored deadline', () => {
    const result = mark(cycle('armed'), {}, 9_999);
    assert.equal(result.status, 'not_due');
    assert.equal(result.alarms[0]?.cycles[0]?.phase, 'armed');
  });

  test('a delivery discovered after the recovery window becomes silent missed', () => {
    const result = mark(cycle('armed'), {}, 10_000 + RECOVERY_WINDOW_MS + 1);
    assert.equal(result.status, 'missed');
    assert.equal(result.alarms[0]?.cycles[0]?.phase, 'missed');
  });
});
