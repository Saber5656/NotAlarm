/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECK_IN_KIND,
  CONFIRM_AWAKE_ACTION,
} from '../src/alarmContracts';
import {
  type AlarmSchedulingGateway,
  type AwakeResponseDependencies,
  processAwakeResponseFailSafe,
  processStepThresholdFailSafe,
  scheduleAlarmNotificationsFailSafe,
} from '../src/alarmOrchestrator';
import type { StoredAlarm } from '../src/alarmStorage';

const activeAlarm: StoredAlarm = {
  alarmId: 'alarm-current',
  cycleId: 'cycle-current',
  mainAlarmId: 'main-current',
  checkInNotificationId: 'check-in-current',
  armedAtMs: 1_000,
  dueAtMs: 100_000,
  phase: 'armed',
  stepCount: 99,
  stepCandidateRecorded: true,
};

const validResponse = {
  actionIdentifier: CONFIRM_AWAKE_ACTION,
  kind: CHECK_IN_KIND,
  cycleId: activeAlarm.cycleId,
  mainAlarmId: activeAlarm.mainAlarmId,
  checkInNotificationId: activeAlarm.checkInNotificationId!,
  confirmedAtMs: 60_000,
};

function createResponseDependencies(options?: {
  alarm?: StoredAlarm | null;
  cancellationSucceeded?: boolean;
}) {
  const calls: string[] = [];
  const saved: StoredAlarm[] = [];
  const dependencies: AwakeResponseDependencies = {
    loadAlarm: async () => {
      calls.push('load');
      return options && 'alarm' in options ? options.alarm ?? null : activeAlarm;
    },
    cancelScheduled: async (notificationId) => {
      calls.push(`cancel:${notificationId}`);
      return options?.cancellationSucceeded ?? true;
    },
    saveAlarm: async (alarm) => {
      calls.push(`save:${alarm.phase}`);
      saved.push(alarm);
    },
  };

  return { calls, dependencies, saved };
}

test('main notification is scheduled before the check-in notification', async () => {
  const calls: string[] = [];
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async ({ cycleId, dueAtMs }) => {
      calls.push(`main:${cycleId}:${dueAtMs}`);
      return 'main-id';
    },
    scheduleCheckIn: async ({ cycleId, mainAlarmId, checkInAtMs }) => {
      calls.push(`check-in:${cycleId}:${mainAlarmId}:${checkInAtMs}`);
      return 'check-in-id';
    },
  };

  const result = await scheduleAlarmNotificationsFailSafe(gateway, {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    dueAtMs: 100_000,
    checkInAtMs: 40_000,
  });

  assert.deepEqual(calls, [
    'main:cycle-1:100000',
    'check-in:cycle-1:main-id:40000',
  ]);
  assert.deepEqual(result, {
    mainAlarmId: 'main-id',
    checkInNotificationId: 'check-in-id',
    checkInAtMs: 40_000,
  });
});

test('a check-in scheduling failure preserves the scheduled main alarm', async () => {
  const calls: string[] = [];
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async () => {
      calls.push('main');
      return 'main-id';
    },
    scheduleCheckIn: async () => {
      calls.push('check-in');
      throw new Error('check-in unavailable');
    },
  };

  const result = await scheduleAlarmNotificationsFailSafe(gateway, {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    dueAtMs: 100_000,
    checkInAtMs: 40_000,
  });

  assert.deepEqual(calls, ['main', 'check-in']);
  assert.equal(result.mainAlarmId, 'main-id');
  assert.equal(result.checkInNotificationId, undefined);
  assert.equal(result.checkInWarning, 'check-in unavailable');
});

test('a main scheduling failure never attempts to schedule a check-in', async () => {
  let checkInAttempted = false;
  const gateway: AlarmSchedulingGateway = {
    scheduleMain: async () => {
      throw new Error('main unavailable');
    },
    scheduleCheckIn: async () => {
      checkInAttempted = true;
      return 'unexpected';
    },
  };

  await assert.rejects(
    scheduleAlarmNotificationsFailSafe(gateway, {
      alarmId: 'alarm-1',
      cycleId: 'cycle-1',
      dueAtMs: 100_000,
      checkInAtMs: 40_000,
    }),
    /main unavailable/,
  );
  assert.equal(checkInAttempted, false);
});

test('a fully matching awake response cancels then saves suppressed state', async () => {
  const { calls, dependencies, saved } = createResponseDependencies();

  const result = await processAwakeResponseFailSafe(
    dependencies,
    validResponse,
  );

  assert.deepEqual(calls, [
    'load',
    `cancel:${activeAlarm.mainAlarmId}`,
    'save:suppressed',
  ]);
  assert.equal(result.status, 'suppressed');
  assert.equal(saved[0]?.confirmedAtMs, validResponse.confirmedAtMs);
});

test('100 fresh steps cancel then save suppressed state', async () => {
  const { calls, dependencies, saved } = createResponseDependencies({
    alarm: { ...activeAlarm, checkInNotificationId: undefined },
  });

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 100,
    observedAtMs: 50_000,
  });

  assert.deepEqual(calls, [
    'load',
    `cancel:${activeAlarm.mainAlarmId}`,
    'save:suppressed',
  ]);
  assert.equal(result.status, 'suppressed');
  assert.equal(saved[0]?.stepCount, 100);
  assert.equal(saved[0]?.confirmedAtMs, 50_000);
});

test('99 steps never attempt cancellation', async () => {
  const { calls, dependencies, saved } = createResponseDependencies();

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 99,
    observedAtMs: 50_000,
  });

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'NOT_EXPLICIT_CONFIRMATION',
  });
  assert.deepEqual(calls, ['load']);
  assert.deepEqual(saved, []);
});

test('100 steps at the due time never cancel', async () => {
  const { calls, dependencies } = createResponseDependencies();

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 100,
    observedAtMs: activeAlarm.dueAtMs,
  });

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'ALARM_DUE_OR_PAST',
  });
  assert.deepEqual(calls, ['load']);
});

test('unverified step cancellation never saves suppressed state', async () => {
  const { calls, dependencies, saved } = createResponseDependencies({
    cancellationSucceeded: false,
  });

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 100,
    observedAtMs: 50_000,
  });

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'CANCEL_NOT_VERIFIED',
  });
  assert.deepEqual(calls, ['load', `cancel:${activeAlarm.mainAlarmId}`]);
  assert.deepEqual(saved, []);
});

test('default taps are ignored before storage or cancellation is touched', async () => {
  const { calls, dependencies } = createResponseDependencies();

  const result = await processAwakeResponseFailSafe(dependencies, {
    ...validResponse,
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  });

  assert.deepEqual(result, {
    status: 'ignored',
    reason: 'NOT_CONFIRM_ACTION',
  });
  assert.deepEqual(calls, []);
});

test('old cycle, wrong check-in, and due-time responses never cancel', async (t) => {
  const scenarios = [
    {
      name: 'old cycle',
      input: { ...validResponse, cycleId: 'cycle-old' },
      reason: 'WRONG_CYCLE',
    },
    {
      name: 'wrong check-in',
      input: { ...validResponse, checkInNotificationId: 'check-in-old' },
      reason: 'WRONG_CHECK_IN',
    },
    {
      name: 'due time',
      input: { ...validResponse, confirmedAtMs: activeAlarm.dueAtMs },
      reason: 'ALARM_DUE_OR_PAST',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { calls, dependencies } = createResponseDependencies();
      const result = await processAwakeResponseFailSafe(
        dependencies,
        scenario.input,
      );

      assert.deepEqual(result, {
        status: 'alarm_remains',
        reason: scenario.reason,
      });
      assert.deepEqual(calls, ['load']);
    });
  }
});

test('an unverified cancellation never saves suppressed state', async () => {
  const { calls, dependencies, saved } = createResponseDependencies({
    cancellationSucceeded: false,
  });

  const result = await processAwakeResponseFailSafe(
    dependencies,
    validResponse,
  );

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'CANCEL_NOT_VERIFIED',
  });
  assert.deepEqual(calls, ['load', `cancel:${activeAlarm.mainAlarmId}`]);
  assert.deepEqual(saved, []);
});

test('a cancellation exception propagates without saving suppressed state', async () => {
  let saveCalled = false;
  const dependencies: AwakeResponseDependencies = {
    loadAlarm: async () => activeAlarm,
    cancelScheduled: async () => {
      throw new Error('native cancellation failed');
    },
    saveAlarm: async () => {
      saveCalled = true;
    },
  };

  await assert.rejects(
    processAwakeResponseFailSafe(dependencies, validResponse),
    /native cancellation failed/,
  );
  assert.equal(saveCalled, false);
});

test('a duplicate response sees suppressed storage and cancels only once', async () => {
  let stored: StoredAlarm = activeAlarm;
  let cancellationCount = 0;
  const dependencies: AwakeResponseDependencies = {
    loadAlarm: async () => stored,
    cancelScheduled: async () => {
      cancellationCount += 1;
      return true;
    },
    saveAlarm: async (alarm) => {
      stored = alarm;
    },
  };

  const first = await processAwakeResponseFailSafe(
    dependencies,
    validResponse,
  );
  const duplicate = await processAwakeResponseFailSafe(
    dependencies,
    validResponse,
  );

  assert.equal(first.status, 'suppressed');
  assert.deepEqual(duplicate, {
    status: 'alarm_remains',
    reason: 'NO_ACTIVE_ALARM',
  });
  assert.equal(cancellationCount, 1);
});

test('missing or inactive stored alarms never reach cancellation', async (t) => {
  const scenarios: Array<{ name: string; alarm: StoredAlarm | null }> = [
    { name: 'missing', alarm: null },
    {
      name: 'already dismissed',
      alarm: { ...activeAlarm, phase: 'dismissed' },
    },
    {
      name: 'no check-in id',
      alarm: { ...activeAlarm, checkInNotificationId: undefined },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { calls, dependencies } = createResponseDependencies({
        alarm: scenario.alarm,
      });
      const result = await processAwakeResponseFailSafe(
        dependencies,
        validResponse,
      );

      assert.deepEqual(result, {
        status: 'alarm_remains',
        reason: 'NO_ACTIVE_ALARM',
      });
      assert.deepEqual(calls, ['load']);
    });
  }
});
