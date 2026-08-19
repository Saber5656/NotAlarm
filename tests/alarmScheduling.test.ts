/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { fillAlarmDefinitionSchedule } from '../src/alarmScheduling';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import type { AlarmSchedulingGateway } from '../src/alarmOrchestrator';
import type { StoredAlarmDefinition } from '../src/alarmStorage';

test('an enabled daily alarm receives three independent notification cycles', async () => {
  const now = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const definition: StoredAlarmDefinition = {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', now),
    enabled: true,
    createdAtMs: now,
    cycles: [],
  };
  const calls: string[] = [];
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ alarmId, cycleId, dueAtMs }) => {
      calls.push(`main:${alarmId}:${cycleId}:${dueAtMs}`);
      return `main-${cycleId}`;
    },
    scheduleCheckIn: async ({ alarmId, cycleId, mainAlarmId }) => {
      calls.push(`check:${alarmId}:${cycleId}:${mainAlarmId}`);
      return `check-${cycleId}`;
    },
  };
  let sequence = 0;

  const result = await fillAlarmDefinitionSchedule(
    definition,
    now,
    gateway,
    () => `cycle-${++sequence}`,
  );

  assert.equal(result.definition.cycles.length, 3);
  assert.deepEqual(
    result.definition.cycles.map((cycle) => cycle.dueAtMs),
    [
      new Date(2026, 7, 20, 7, 0, 0).getTime(),
      new Date(2026, 7, 21, 7, 0, 0).getTime(),
      new Date(2026, 7, 22, 7, 0, 0).getTime(),
    ],
  );
  assert.deepEqual(
    result.definition.cycles.map((cycle) => cycle.alarmId),
    ['alarm-1', 'alarm-1', 'alarm-1'],
  );
  assert.deepEqual(calls.slice(0, 2), [
    `main:alarm-1:cycle-1:${new Date(2026, 7, 20, 7, 0, 0).getTime()}`,
    'check:alarm-1:cycle-1:main-cycle-1',
  ]);
});

test('refilling does not duplicate an existing occurrence', async () => {
  const now = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ cycleId }) => `main-${cycleId}`,
    scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
  };
  let sequence = 0;
  const definition: StoredAlarmDefinition = {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', now),
    enabled: true,
    createdAtMs: now,
    cycles: [],
  };

  const first = await fillAlarmDefinitionSchedule(
    definition,
    now,
    gateway,
    () => `cycle-${++sequence}`,
  );
  const second = await fillAlarmDefinitionSchedule(
    first.definition,
    now,
    gateway,
    () => `cycle-${++sequence}`,
  );

  assert.equal(second.definition.cycles.length, 3);
  assert.equal(sequence, 3);
});

test('check-in failure keeps the main cycle and reports a warning', async () => {
  const now = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const definition: StoredAlarmDefinition = {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('today', now),
    enabled: true,
    createdAtMs: now,
    cycles: [],
  };
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async () => 'main-1',
    scheduleCheckIn: async () => {
      throw new Error('check-in unavailable');
    },
  };

  const result = await fillAlarmDefinitionSchedule(
    definition,
    now,
    gateway,
    () => 'cycle-1',
  );

  assert.equal(result.definition.cycles[0]?.mainAlarmId, 'main-1');
  assert.equal(result.definition.cycles[0]?.checkInNotificationId, undefined);
  assert.deepEqual(result.warnings, ['check-in unavailable']);
});

test('an expired today-only alarm is disabled without creating tomorrow work', async () => {
  const createdAt = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const now = new Date(2026, 7, 20, 8, 0, 0).getTime();
  const calls: string[] = [];
  const definition: StoredAlarmDefinition = {
    id: 'alarm-today',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('today', createdAt),
    enabled: true,
    createdAtMs: createdAt,
    cycles: [],
  };
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async () => {
      calls.push('main');
      return 'main';
    },
    scheduleCheckIn: async () => {
      calls.push('check');
      return 'check';
    },
  };

  const result = await fillAlarmDefinitionSchedule(definition, now, gateway);

  assert.equal(result.definition.enabled, false);
  assert.deepEqual(result.definition.cycles, []);
  assert.deepEqual(calls, []);
});

test('a completed occurrence is pruned after due and the rolling window refills', async () => {
  const createdAt = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ cycleId }) => `main-${cycleId}`,
    scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
  };
  let sequence = 0;
  const definition: StoredAlarmDefinition = {
    id: 'alarm-daily',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', createdAt),
    enabled: true,
    createdAtMs: createdAt,
    cycles: [],
  };
  const initial = await fillAlarmDefinitionSchedule(
    definition,
    createdAt,
    gateway,
    () => `cycle-${++sequence}`,
  );
  const completed = {
    ...initial.definition,
    cycles: initial.definition.cycles.map((cycle, index) =>
      index === 0 ? { ...cycle, phase: 'suppressed' as const } : cycle,
    ),
  };
  const nextDay = new Date(2026, 7, 20, 8, 0, 0).getTime();

  const refilled = await fillAlarmDefinitionSchedule(
    completed,
    nextDay,
    gateway,
    () => `cycle-${++sequence}`,
  );

  assert.equal(refilled.definition.cycles.length, 3);
  assert.deepEqual(
    refilled.definition.cycles.map((cycle) => cycle.dueAtMs),
    [
      new Date(2026, 7, 21, 7, 0, 0).getTime(),
      new Date(2026, 7, 22, 7, 0, 0).getTime(),
      new Date(2026, 7, 23, 7, 0, 0).getTime(),
    ],
  );
  assert.equal(sequence, 4);
});

test('suppression before due refills three still-active future occurrences', async () => {
  const now = new Date(2026, 7, 20, 6, 0, 0).getTime();
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ cycleId }) => `main-${cycleId}`,
    scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
  };
  let sequence = 0;
  const initial = await fillAlarmDefinitionSchedule(
    {
      id: 'alarm-daily',
      hour: 7,
      minute: 0,
      repeat: makeAlarmRepeat('daily', now),
      enabled: true,
      createdAtMs: now,
      cycles: [],
    },
    now,
    gateway,
    () => `cycle-${++sequence}`,
  );
  const completed = {
    ...initial.definition,
    cycles: initial.definition.cycles.map((cycle, index) =>
      index === 0 ? { ...cycle, phase: 'suppressed' as const } : cycle,
    ),
  };

  const refilled = await fillAlarmDefinitionSchedule(
    completed,
    now + 1,
    gateway,
    () => `cycle-${++sequence}`,
  );

  assert.equal(
    refilled.definition.cycles.filter(
      (cycle) =>
        (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
        cycle.dueAtMs > now + 1,
    ).length,
    3,
  );
  assert.equal(refilled.definition.cycles.length, 4);
  assert.equal(sequence, 4);
});
