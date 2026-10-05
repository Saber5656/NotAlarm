/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AlarmSchedulingGateway } from '../src/alarmOrchestrator';
import { STEP_WINDOW_LEAD_MS } from '../src/alarmPolicy';
import { fillAlarmDefinitionSchedule } from '../src/alarmScheduling';
import type {
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  applySuppressionStepFloor,
  getStepCountingFloorMs,
  getStepCountingStartMs,
  getStepWindow,
  getStepWindowPhase,
  getWindowStepCount,
  mergeWindowStepCount,
  shouldWatchSteps,
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

test('the counting start is the latest of the lead, armedAt, floor, and stored start', () => {
  const target = cycle();
  const suppressedEarlier = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630',
    dueAtMs: at(6, 30),
    phase: 'suppressed',
    confirmedAtMs: at(6, 10),
  });

  assert.equal(getStepCountingStartMs([definition('alarm-0700', [target])], target), at(6));
  assert.equal(
    getStepCountingStartMs(
      [
        definition('alarm-0630', [suppressedEarlier]),
        definition('alarm-0700', [target]),
      ],
      target,
    ),
    at(6, 10),
  );
  const stored = cycle({ stepCountFromMs: at(6, 20) });
  assert.equal(
    getStepCountingStartMs(
      [
        definition('alarm-0630', [suppressedEarlier]),
        definition('alarm-0700', [stored]),
      ],
      stored,
    ),
    at(6, 20),
  );
  const armedLate = cycle({ armedAtMs: at(6, 40) });
  assert.equal(
    getStepCountingStartMs([definition('alarm-0700', [armedLate])], armedLate),
    at(6, 40),
  );
});

test('a suppression moves every overlapping monitoring cycle past its confirmation', () => {
  const suppressed = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630',
    dueAtMs: at(6, 30),
    phase: 'suppressed',
    stepCount: 100,
    stepCountFromMs: at(5, 30),
    confirmedAtMs: at(6, 10),
  });
  const sameAlarmTomorrow = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630-tomorrow',
    dueAtMs: at(24 + 6, 30),
  });
  const counting = cycle({
    alarmId: 'alarm-0640',
    cycleId: 'cycle-0640',
    dueAtMs: at(6, 40),
    phase: 'step_candidate',
    stepCount: 60,
    stepCountFromMs: at(5, 40),
  });
  const target = cycle();
  const laterStart = cycle({
    alarmId: 'alarm-0705',
    cycleId: 'cycle-0705',
    dueAtMs: at(7, 5),
    stepCount: 12,
    stepCountFromMs: at(6, 20),
  });
  const windowNotOpen = cycle({
    alarmId: 'alarm-0710',
    cycleId: 'cycle-0710',
    dueAtMs: at(7, 10),
  });
  const ringing = cycle({
    alarmId: 'alarm-0615',
    cycleId: 'cycle-0615',
    dueAtMs: at(6, 15),
    phase: 'ringing',
    stepCount: 3,
    stepCountFromMs: at(5, 15),
  });
  const alarms = [
    definition('alarm-0615', [ringing]),
    definition('alarm-0630', [suppressed, sameAlarmTomorrow]),
    definition('alarm-0640', [counting]),
    definition('alarm-0700', [target]),
    definition('alarm-0705', [laterStart]),
    definition('alarm-0710', [windowNotOpen]),
  ];

  const next = applySuppressionStepFloor(alarms, suppressed);
  const byId = new Map(
    next.flatMap((alarm) => alarm.cycles).map((entry) => [entry.cycleId, entry]),
  );

  // Overlapping armed / step_candidate cycles of any alarm restart at 06:10.
  assert.deepEqual(
    [byId.get('cycle-0640')?.stepCountFromMs, byId.get('cycle-0640')?.stepCount],
    [at(6, 10), 0],
  );
  assert.deepEqual(
    [byId.get('cycle-0700')?.stepCountFromMs, byId.get('cycle-0700')?.stepCount],
    [at(6, 10), 0],
  );
  // The suppressed cycle, a later start, a window that opens after 06:10
  // (07:10 opens at exactly 06:10), another day, and a ringing cycle keep
  // their progress.
  assert.deepEqual(byId.get('cycle-0630'), suppressed);
  assert.deepEqual(byId.get('cycle-0705'), laterStart);
  assert.deepEqual(byId.get('cycle-0710'), windowNotOpen);
  assert.deepEqual(byId.get('cycle-0630-tomorrow'), sameAlarmTomorrow);
  assert.deepEqual(byId.get('cycle-0615'), ringing);
});

test('only a suppressed cycle with a valid confirmation time sets a floor', () => {
  const target = cycle();
  const alarms = [definition('alarm-0700', [target])];
  for (const source of [
    cycle({ alarmId: 'x', cycleId: 'x', dueAtMs: at(6, 30), confirmedAtMs: at(6, 10) }),
    cycle({ alarmId: 'x', cycleId: 'x', dueAtMs: at(6, 30), phase: 'suppressed' }),
    cycle({
      alarmId: 'x',
      cycleId: 'x',
      dueAtMs: at(6, 30),
      phase: 'suppressed',
      confirmedAtMs: Number.NaN,
    }),
  ]) {
    assert.deepEqual(applySuppressionStepFloor(alarms, source), alarms);
  }
});

test('steps used for 06:30 stay unusable for 07:00 after 06:30 is pruned', async () => {
  // Daily alarms at 06:30, 06:40 and 07:00. 100 steps between 06:00 and 06:10
  // suppress 06:30 at 06:10; monitoring then moves to 06:40.
  const suppressed = cycle({
    alarmId: 'alarm-0630',
    cycleId: 'cycle-0630',
    dueAtMs: at(6, 30),
    phase: 'suppressed',
    stepCount: 100,
    stepCountFromMs: at(5, 30),
    confirmedAtMs: at(6, 10),
  });
  const next0640 = cycle({
    alarmId: 'alarm-0640',
    cycleId: 'cycle-0640',
    dueAtMs: at(6, 40),
  });
  const target = cycle();
  const saved = applySuppressionStepFloor(
    [
      definition('alarm-0630', [suppressed]),
      definition('alarm-0640', [next0640]),
      definition('alarm-0700', [target]),
    ],
    suppressed,
  );

  // A later startup / foreground refill prunes the past suppressed cycle.
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ cycleId }) => `main-${cycleId}`,
    scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
  };
  let sequence = 0;
  const refilled = await fillAlarmDefinitionSchedule(
    saved[0]!,
    at(6, 45),
    gateway,
    () => `refill-${++sequence}`,
  );
  assert.equal(
    refilled.definition.cycles.some((entry) => entry.cycleId === 'cycle-0630'),
    false,
  );
  const alarms = [refilled.definition, saved[1]!, saved[2]!];
  assert.equal(getStepCountingFloorMs(alarms, saved[2]!.cycles[0]!), undefined);

  assert.equal(getStepCountingStartMs(alarms, saved[2]!.cycles[0]!), at(6, 10));
  // Without the stored floor, the same pruning reopens 06:00-06:10.
  assert.equal(
    getStepCountingStartMs(
      [refilled.definition, definition('alarm-0700', [target])],
      target,
    ),
    at(6),
  );
});

test('steps are watched only inside the window while the app is on screen', () => {
  assert.equal(shouldWatchSteps('active', true), true);
  // Steps walked while the app is in the background (for example a trip to
  // the bathroom before going back to sleep) are never counted.
  assert.equal(shouldWatchSteps('active', false), false);
  assert.equal(shouldWatchSteps('before', true), false);
  assert.equal(shouldWatchSteps('ended', true), false);
  assert.equal(shouldWatchSteps(null, true), false);
});
