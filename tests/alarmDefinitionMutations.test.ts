/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { updateMonitoringCycleStepCount } from '../src/alarmDefinitionMutations';
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
