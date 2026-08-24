/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { updateMonitoringCycleStepCount } from '../src/alarmDefinitionMutations';
import type {
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';

function cycle(
  phase: StoredAlarm['phase'],
  stepCount = 0,
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
    [definition(cycle('armed', 12))],
    'alarm-1',
    'cycle-1',
    24,
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 24);
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
  );

  assert.equal(result.status, 'not_monitoring');
  assert.deepEqual(result.alarms[0]?.cycles[0], suppressed);
});

test('keeps persisted step progress monotonic', () => {
  const result = updateMonitoringCycleStepCount(
    [definition(cycle('step_candidate', 80))],
    'alarm-1',
    'cycle-1',
    60,
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 80);
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
  );

  assert.equal(result.alarms[0]?.cycles[0]?.stepCount, 30);
  assert.equal(result.alarms[1]?.cycles[0]?.stepCount, 7);
});
