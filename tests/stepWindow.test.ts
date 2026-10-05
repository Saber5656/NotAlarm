/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { STEP_WINDOW_LEAD_MS } from '../src/alarmPolicy';
import type {
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  getStepCountingFloorMs,
  getStepWindow,
  getStepWindowPhase,
  getWindowStepCount,
  mergeWindowStepCount,
} from '../src/stepWindow';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Wall-clock labels below are relative to this arbitrary midnight.
const DAY_START = 1_790_000_000_000;
const at = (hours: number, minutes = 0) =>
  DAY_START + hours * HOUR + minutes * MINUTE;

function cycle(overrides: Partial<StoredAlarm> = {}): StoredAlarm {
  return {
    alarmId: 'alarm-0700',
    cycleId: 'cycle-0700',
    mainAlarmId: 'main-0700',
    checkInNotificationId: 'check-0700',
    // Scheduled the previous evening, as repeat cycles usually are.
    armedAtMs: at(-4),
    dueAtMs: at(7),
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...overrides,
  };
}

function definition(
  id: string,
  cycles: StoredAlarm[],
): StoredAlarmDefinition {
  return {
    id,
    hour: 7,
    minute: 0,
    repeat: { kind: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    enabled: true,
    createdAtMs: at(-24),
    cycles,
  };
}

test('the step window opens 60 minutes before the alarm', () => {
  assert.equal(STEP_WINDOW_LEAD_MS, 60 * MINUTE);
  assert.deepEqual(getStepWindow(cycle()), {
    startMs: at(6),
    dueAtMs: at(7),
  });
});

test('a cycle armed inside the lead starts counting at armedAt', () => {
  assert.equal(getStepWindow(cycle({ armedAtMs: at(6, 30) })).startMs, at(6, 30));
});

test('a later floor moves the window start so steps are not reused', () => {
  assert.equal(getStepWindow(cycle(), at(6, 10)).startMs, at(6, 10));
  assert.equal(getStepWindow(cycle(), at(5, 0)).startMs, at(6));
  assert.equal(getStepWindow(cycle(), Number.NaN).startMs, at(6));
});

test('a window already used for counting never moves earlier', () => {
  // The suppressed cycle that set the 06:10 floor may be pruned from storage
  // after its due time; the persisted start keeps the window conservative.
  const counted = cycle({ stepCount: 30, stepCountFromMs: at(6, 10) });
  const window = getStepWindow(counted);
  assert.equal(window.startMs, at(6, 10));
  assert.equal(getWindowStepCount(counted, window), 30);
  // A corrupt start at or after the due time is ignored.
  assert.equal(
    getStepWindow(cycle({ stepCountFromMs: at(7) })).startMs,
    at(6),
  );
});

test('window phase is start-inclusive and due-exclusive', () => {
  const window = getStepWindow(cycle());
  assert.equal(getStepWindowPhase(window, at(5, 59) + 59_999), 'before');
  assert.equal(getStepWindowPhase(window, at(6)), 'active');
  assert.equal(getStepWindowPhase(window, at(7) - 1), 'active');
  assert.equal(getStepWindowPhase(window, at(7)), 'ended');
  assert.equal(getStepWindowPhase(window, at(8)), 'ended');
});

test('step count is only reused when it was counted from the same start', () => {
  const window = getStepWindow(cycle());
  assert.equal(
    getWindowStepCount(
      cycle({ stepCount: 37, stepCountFromMs: at(6) }),
      window,
    ),
    37,
  );
  assert.equal(
    getWindowStepCount(
      cycle({ stepCount: 37, stepCountFromMs: at(6) }),
      { ...window, startMs: at(6, 10) },
    ),
    0,
  );
  // Legacy counts have no start and were collected from armedAt.
  assert.equal(getWindowStepCount(cycle({ stepCount: 95 }), window), 0);
});

test('the counting floor is the latest suppression of another cycle before due', () => {
  const target = cycle();
  const earlier = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630',
    dueAtMs: at(6, 30),
    phase: 'suppressed',
    confirmedAtMs: at(6, 10),
  });
  const yesterday = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630-yesterday',
    dueAtMs: at(-17, -30),
    phase: 'suppressed',
    confirmedAtMs: at(-17, -40),
  });
  const alarms = [
    definition('alarm-0630', [yesterday, earlier]),
    definition('alarm-0700', [target]),
  ];

  assert.equal(getStepCountingFloorMs(alarms, target), at(6, 10));
  assert.equal(
    getStepWindow(target, getStepCountingFloorMs(alarms, target)).startMs,
    at(6, 10),
  );
});

test('the counting floor ignores the cycle itself, active, late, and invalid cycles', () => {
  const target = cycle({ phase: 'suppressed', confirmedAtMs: at(6, 50) });
  const alarms = [
    definition('alarm-0700', [target]),
    definition('alarm-other', [
      cycle({
        alarmId: 'alarm-other',
        cycleId: 'armed',
        phase: 'armed',
        confirmedAtMs: at(6, 40),
      }),
      cycle({
        alarmId: 'alarm-other',
        cycleId: 'dismissed',
        phase: 'dismissed',
        confirmedAtMs: at(6, 41),
      }),
      cycle({
        alarmId: 'alarm-other',
        cycleId: 'after-due',
        phase: 'suppressed',
        confirmedAtMs: at(7),
      }),
      cycle({
        alarmId: 'alarm-other',
        cycleId: 'invalid',
        phase: 'suppressed',
        confirmedAtMs: Number.NaN,
      }),
      cycle({
        alarmId: 'alarm-other',
        cycleId: 'missing',
        phase: 'suppressed',
      }),
    ]),
  ];

  assert.equal(getStepCountingFloorMs(alarms, target), undefined);
});

test('merging keeps the larger count within a window and resets for a new one', () => {
  assert.deepEqual(
    mergeWindowStepCount(
      cycle({ stepCount: 80, stepCountFromMs: at(6) }),
      60,
      at(6),
    ),
    { stepCount: 80, stepCountFromMs: at(6) },
  );
  assert.deepEqual(
    mergeWindowStepCount(
      cycle({ stepCount: 80, stepCountFromMs: at(6) }),
      12,
      at(6, 10),
    ),
    { stepCount: 12, stepCountFromMs: at(6, 10) },
  );
  assert.deepEqual(mergeWindowStepCount(cycle({ stepCount: 150 }), 5, at(6)), {
    stepCount: 5,
    stepCountFromMs: at(6),
  });
  assert.throws(() => mergeWindowStepCount(cycle(), 5, Number.NaN));
});
