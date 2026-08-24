/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelAlarmDefinitionWithCheckpoints,
  type AlarmCancellationGateway,
} from '../src/alarmCancellation';
import type {
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';

function cycle(index: number): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: `cycle-${index}`,
    mainAlarmId: `main-${index}`,
    checkInNotificationId: `check-${index}`,
    armedAtMs: 1_000,
    dueAtMs: 10_000 * index,
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function definition(cycles = [cycle(1), cycle(2)]): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: { kind: 'daily', weekdays: [] },
    enabled: true,
    createdAtMs: 1_000,
    cycles,
  };
}

function clone(alarms: StoredAlarmDefinition[]): StoredAlarmDefinition[] {
  return structuredClone(alarms);
}

test('checkpoints every verified cancellation before attempting the next cycle', async () => {
  const checkpoints: StoredAlarmDefinition[][] = [];
  const cancelled: string[] = [];
  const gateway: AlarmCancellationGateway = {
    async cancelScheduled(notificationId) {
      if (notificationId === 'main-2') {
        throw new Error('second main cancellation failed');
      }
      if (notificationId) {
        cancelled.push(notificationId);
      }
    },
    async dismissDelivered() {},
  };

  await assert.rejects(
    cancelAlarmDefinitionWithCheckpoints({
      alarms: [definition()],
      alarmId: 'alarm-1',
      completion: 'disable',
      gateway,
      async checkpoint(alarms) {
        checkpoints.push(clone(alarms));
      },
    }),
    /second main cancellation failed/,
  );

  assert.deepEqual(cancelled, ['check-1', 'main-1', 'check-2']);
  const persisted = checkpoints.at(-1)?.[0];
  assert.equal(persisted?.enabled, true);
  assert.deepEqual(
    persisted?.cycles.map((item) => ({
      cycleId: item.cycleId,
      checkInNotificationId: item.checkInNotificationId,
    })),
    [{ cycleId: 'cycle-2', checkInNotificationId: undefined }],
  );
});

test('disables the definition in the same checkpoint that removes its last cycle', async () => {
  const checkpoints: StoredAlarmDefinition[][] = [];
  const result = await cancelAlarmDefinitionWithCheckpoints({
    alarms: [definition([cycle(1)])],
    alarmId: 'alarm-1',
    completion: 'disable',
    gateway: {
      async cancelScheduled() {},
      async dismissDelivered() {},
    },
    async checkpoint(alarms) {
      checkpoints.push(clone(alarms));
    },
  });

  assert.equal(result[0]?.enabled, false);
  assert.deepEqual(result[0]?.cycles, []);
  assert.equal(checkpoints.at(-1)?.[0]?.enabled, false);
  assert.deepEqual(checkpoints.at(-1)?.[0]?.cycles, []);
});

test('deletes the definition only after all scheduled notifications are cancelled', async () => {
  const checkpoints: StoredAlarmDefinition[][] = [];
  const result = await cancelAlarmDefinitionWithCheckpoints({
    alarms: [definition([cycle(1)])],
    alarmId: 'alarm-1',
    completion: 'delete',
    gateway: {
      async cancelScheduled() {},
      async dismissDelivered() {},
    },
    async checkpoint(alarms) {
      checkpoints.push(clone(alarms));
    },
  });

  assert.deepEqual(result, []);
  assert.deepEqual(checkpoints.at(-1), []);
});

test('delivered-notification cleanup cannot resurrect a cancelled cycle', async () => {
  const result = await cancelAlarmDefinitionWithCheckpoints({
    alarms: [definition([cycle(1)])],
    alarmId: 'alarm-1',
    completion: 'disable',
    gateway: {
      async cancelScheduled() {},
      async dismissDelivered() {
        throw new Error('delivered cleanup failed');
      },
    },
    async checkpoint() {},
  });

  assert.equal(result[0]?.enabled, false);
  assert.deepEqual(result[0]?.cycles, []);
});

test('a durable target can reconcile cancellation after a checkpoint failure', async () => {
  const original = [definition([cycle(1)])];
  const scheduled = new Set(['check-1', 'main-1']);
  const gateway: AlarmCancellationGateway = {
    async cancelScheduled(notificationId) {
      if (notificationId) {
        scheduled.delete(notificationId);
      }
    },
    async dismissDelivered() {},
  };

  await assert.rejects(
    cancelAlarmDefinitionWithCheckpoints({
      alarms: original,
      alarmId: 'alarm-1',
      completion: 'disable',
      targetCycleIds: ['cycle-1'],
      gateway,
      async checkpoint() {
        throw new Error('storage unavailable');
      },
    }),
    /storage unavailable/,
  );
  assert.deepEqual([...scheduled], ['main-1']);

  let persisted = clone(original);
  const recovered = await cancelAlarmDefinitionWithCheckpoints({
    alarms: persisted,
    alarmId: 'alarm-1',
    completion: 'disable',
    targetCycleIds: ['cycle-1'],
    gateway,
    async checkpoint(alarms) {
      persisted = clone(alarms);
    },
  });

  assert.deepEqual([...scheduled], []);
  assert.equal(recovered[0]?.enabled, false);
  assert.deepEqual(persisted[0]?.cycles, []);
});

test('recovery never cancels cycles created after the durable request', async () => {
  const newerCycle = {
    ...cycle(2),
    cycleId: 'cycle-new',
    mainAlarmId: 'main-new',
    checkInNotificationId: 'check-new',
  };
  const original = [definition([newerCycle])];
  const cancelled: string[] = [];
  let checkpointed = false;

  const result = await cancelAlarmDefinitionWithCheckpoints({
    alarms: original,
    alarmId: 'alarm-1',
    completion: 'disable',
    targetCycleIds: ['cycle-old'],
    gateway: {
      async cancelScheduled(notificationId) {
        if (notificationId) {
          cancelled.push(notificationId);
        }
      },
      async dismissDelivered() {},
    },
    async checkpoint() {
      checkpointed = true;
    },
  });

  assert.deepEqual(result, original);
  assert.deepEqual(cancelled, []);
  assert.equal(checkpointed, false);
});
