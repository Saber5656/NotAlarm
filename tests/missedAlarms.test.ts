/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECOVERY_WINDOW_MS,
  acknowledgeMissedCycles,
  classifyOverdueCycles,
  getMissedCycles,
} from '../src/missedAlarms';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';

const DUE = new Date(2026, 9, 14, 7, 0, 0).getTime();

function cycle(
  cycleId: string,
  phase: AlarmPhase,
  dueAtMs = DUE,
): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId,
    mainAlarmId: `main-${cycleId}`,
    armedAtMs: dueAtMs - 3_600_000,
    dueAtMs,
    phase,
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function definition(cycles: StoredAlarm[]): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', DUE),
    enabled: true,
    createdAtMs: DUE - 86_400_000,
    cycles,
  };
}

function phases(alarms: StoredAlarmDefinition[]): Record<string, string> {
  return Object.fromEntries(
    alarms.flatMap((a) => a.cycles.map((c) => [c.cycleId, c.phase])),
  );
}

test('the recovery window is 30 minutes', () => {
  assert.equal(RECOVERY_WINDOW_MS, 30 * 60_000);
});

test('an overdue cycle rings up to and including the 30-minute boundary', () => {
  const alarms = [definition([cycle('a', 'armed'), cycle('b', 'step_candidate')])];
  for (const lateMs of [0, 1_000, RECOVERY_WINDOW_MS]) {
    assert.deepEqual(phases(classifyOverdueCycles(alarms, DUE + lateMs, 'resume')), {
      a: 'ringing',
      b: 'ringing',
    });
  }
});

test('an overdue cycle past the 30-minute boundary becomes a silent missed cycle', () => {
  const alarms = [definition([cycle('a', 'armed'), cycle('b', 'step_candidate')])];
  assert.deepEqual(
    phases(classifyOverdueCycles(alarms, DUE + RECOVERY_WINDOW_MS + 1, 'resume')),
    { a: 'missed', b: 'missed' },
  );
});

test('cycles that are not due yet are left alone', () => {
  const alarms = [definition([cycle('a', 'armed', DUE + 1)])];
  assert.deepEqual(phases(classifyOverdueCycles(alarms, DUE, 'launch')), {
    a: 'armed',
  });
});

test('several missed cycles never produce more than the in-window ringing one', () => {
  const day = 86_400_000;
  const alarms = [
    definition([
      cycle('d1', 'armed', DUE),
      cycle('d2', 'armed', DUE + day),
      cycle('d3', 'armed', DUE + 2 * day),
    ]),
  ];
  const now = DUE + 2 * day + 60_000;
  assert.deepEqual(phases(classifyOverdueCycles(alarms, now, 'launch')), {
    d1: 'missed',
    d2: 'missed',
    d3: 'ringing',
  });
});

test('an actively ringing cycle is never silenced by elapsed time on resume', () => {
  const alarms = [definition([cycle('a', 'ringing')])];
  const hoursLater = DUE + 5 * 3_600_000;
  assert.deepEqual(phases(classifyOverdueCycles(alarms, hoursLater, 'resume')), {
    a: 'ringing',
  });
});

test('launch recovery: a stored ringing record older than the window becomes missed', () => {
  const alarms = [definition([cycle('a', 'ringing')])];
  assert.deepEqual(
    phases(classifyOverdueCycles(alarms, DUE + RECOVERY_WINDOW_MS + 1, 'launch')),
    { a: 'missed' },
  );
});

test('launch recovery: a stored ringing record inside the window keeps ringing', () => {
  const alarms = [definition([cycle('a', 'ringing')])];
  assert.deepEqual(
    phases(classifyOverdueCycles(alarms, DUE + RECOVERY_WINDOW_MS, 'launch')),
    { a: 'ringing' },
  );
});

test('classification does not touch finished cycles or infer wake evidence', () => {
  const alarms = [
    definition([
      cycle('s', 'suppressed'),
      cycle('d', 'dismissed'),
      cycle('m', 'missed'),
    ]),
  ];
  const result = classifyOverdueCycles(alarms, DUE + 10 * 3_600_000, 'launch');
  assert.deepEqual(phases(result), { s: 'suppressed', d: 'dismissed', m: 'missed' });
});

test('acknowledging marks only the listed missed cycles handled', () => {
  const other: StoredAlarmDefinition = {
    ...definition([cycle('x', 'missed'), cycle('y', 'ringing')]),
    id: 'alarm-2',
  };
  const alarms = [
    definition([
      cycle('a', 'missed'),
      cycle('b', 'missed'),
      cycle('c', 'armed', DUE + 86_400_000),
    ]),
    other,
  ];
  const result = acknowledgeMissedCycles(alarms, ['a', 'y', 'c']);
  assert.deepEqual(phases(result), {
    a: 'dismissed',
    b: 'missed',
    c: 'armed',
    x: 'missed',
    y: 'ringing',
  });
  assert.equal(result[0].enabled, true);
  assert.deepEqual(result[0].repeat, alarms[0].repeat);
});

test('getMissedCycles lists missed cycles oldest first', () => {
  const alarms = [
    definition([cycle('b', 'missed', DUE + 5), cycle('a', 'missed', DUE)]),
  ];
  assert.deepEqual(
    getMissedCycles(alarms).map((c) => c.cycleId),
    ['a', 'b'],
  );
});
