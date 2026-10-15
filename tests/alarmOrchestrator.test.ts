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
  recoverSuppressionJournal,
  SuppressionCancelUnknownError,
  SuppressionSaveError,
  type SuppressionIntent,
  type SuppressionJournal,
  scheduleAlarmNotificationsFailSafe,
} from '../src/alarmOrchestrator';
import type { StoredAlarm } from '../src/alarmStorage';
import { createSuppressionJournal } from '../src/suppressionJournal';

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
    nowMs: () => 60_000,
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
    repeats: true,
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
    repeats: true,
  });

  assert.deepEqual(calls, ['main', 'check-in']);
  assert.equal(result.mainAlarmId, 'main-id');
  assert.equal(result.checkInNotificationId, undefined);
  assert.equal(result.checkInErrorCode, 'CHECKIN_REGISTER_FAILED');
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
      repeats: true,
    }),
    /main unavailable/,
  );
  assert.equal(checkInAttempted, false);
});

test('the main notification receives whether the alarm repeats', async () => {
  for (const repeats of [true, false]) {
    const seen: boolean[] = [];
    const gateway: AlarmSchedulingGateway = {
      scheduleMain: async (input) => {
        seen.push(input.repeats);
        return 'main-id';
      },
      scheduleCheckIn: async () => 'check-in-id',
    };

    await scheduleAlarmNotificationsFailSafe(gateway, {
      alarmId: 'alarm-1',
      cycleId: 'cycle-1',
      dueAtMs: 100_000,
      checkInAtMs: 40_000,
      repeats,
    });

    assert.deepEqual(seen, [repeats]);
  }
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
    countedFromMs: activeAlarm.armedAtMs,
  });

  assert.deepEqual(calls, [
    'load',
    `cancel:${activeAlarm.mainAlarmId}`,
    'save:suppressed',
  ]);
  assert.equal(result.status, 'suppressed');
  assert.equal(saved[0]?.stepCount, 100);
  assert.equal(saved[0]?.stepCountFromMs, activeAlarm.armedAtMs);
  assert.equal(saved[0]?.confirmedAtMs, 50_000);
});

test('the suppressed cycle keeps only step progress from the same window', async (t) => {
  const scenarios = [
    {
      name: 'same window keeps the larger count',
      alarm: { ...activeAlarm, stepCount: 140, stepCountFromMs: 1_000 },
      stepCount: 140,
    },
    {
      name: 'an older window is replaced',
      alarm: { ...activeAlarm, stepCount: 140, stepCountFromMs: 500 },
      stepCount: 100,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { dependencies, saved } = createResponseDependencies({
        alarm: scenario.alarm,
      });
      const result = await processStepThresholdFailSafe(dependencies, {
        steps: 100,
        observedAtMs: 50_000,
        countedFromMs: 1_000,
      });

      assert.equal(result.status, 'suppressed');
      assert.equal(saved[0]?.stepCount, scenario.stepCount);
      assert.equal(saved[0]?.stepCountFromMs, 1_000);
    });
  }
});

test('100 steps counted before the 60-minute window never cancel', async () => {
  const minute = 60_000;
  const dueAtMs = 1_790_000_000_000;
  const { calls, dependencies, saved } = createResponseDependencies({
    alarm: {
      ...activeAlarm,
      // Scheduled two days ahead, as repeat cycles are.
      armedAtMs: dueAtMs - 48 * 60 * minute,
      dueAtMs,
    },
  });

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 100,
    // Counted from 21:00 and observed at 21:30 the previous evening.
    observedAtMs: dueAtMs - 9.5 * 60 * minute,
    countedFromMs: dueAtMs - 10 * 60 * minute,
  });

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'STEP_COUNT_OUTSIDE_WINDOW',
  });
  assert.deepEqual(calls, ['load']);
  assert.deepEqual(saved, []);
});

test('steps already used for another suppression never cancel', async () => {
  const minute = 60_000;
  const dueAtMs = 1_790_000_000_000;
  // 06:30 was suppressed at 06:10 and has since been pruned; the suppression
  // left 06:10 in this 07:00 cycle as its earliest counting start.
  const { calls, dependencies, saved } = createResponseDependencies({
    alarm: {
      ...activeAlarm,
      armedAtMs: dueAtMs - 48 * 60 * minute,
      dueAtMs,
      stepCount: 0,
      stepCountFromMs: dueAtMs - 50 * minute,
    },
  });

  // A stale window that still starts at 06:00 includes the 06:00-06:10 steps.
  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 140,
    observedAtMs: dueAtMs - 20 * minute,
    countedFromMs: dueAtMs - 60 * minute,
  });

  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'STEP_COUNT_OUTSIDE_WINDOW',
  });
  assert.deepEqual(calls, ['load']);
  assert.deepEqual(saved, []);
});

test('steps counted from the stored start can still cancel', async () => {
  const minute = 60_000;
  const dueAtMs = 1_790_000_000_000;
  const { calls, dependencies, saved } = createResponseDependencies({
    alarm: {
      ...activeAlarm,
      armedAtMs: dueAtMs - 48 * 60 * minute,
      dueAtMs,
      stepCount: 0,
      stepCountFromMs: dueAtMs - 50 * minute,
    },
  });

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 100,
    observedAtMs: dueAtMs - 20 * minute,
    countedFromMs: dueAtMs - 50 * minute,
  });

  assert.equal(result.status, 'suppressed');
  assert.deepEqual(calls, [
    'load',
    `cancel:${activeAlarm.mainAlarmId}`,
    'save:suppressed',
  ]);
  assert.equal(saved[0]?.stepCountFromMs, dueAtMs - 50 * minute);
});

test('99 steps never attempt cancellation', async () => {
  const { calls, dependencies, saved } = createResponseDependencies();

  const result = await processStepThresholdFailSafe(dependencies, {
    steps: 99,
    observedAtMs: 50_000,
    countedFromMs: activeAlarm.armedAtMs,
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
    countedFromMs: activeAlarm.armedAtMs,
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
    countedFromMs: activeAlarm.armedAtMs,
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
    nowMs: () => 60_000,
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
    nowMs: () => 60_000,
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

function createJournal() {
  const entries = new Map<string, SuppressionIntent>();
  const journal: SuppressionJournal = {
    record: async (intent) => {
      entries.set(intent.cycleId, intent);
    },
    load: async () => [...entries.values()],
    clear: async (cycleId) => {
      entries.delete(cycleId);
    },
    exclusive: (run) => run(),
  };
  return { entries, journal };
}

test('cancel success then save failure keeps a recoverable journal and throws', async () => {
  const { entries, journal } = createJournal();
  let stored: StoredAlarm = activeAlarm;
  let failSaves = true;
  const dependencies: AwakeResponseDependencies = {
    loadAlarm: async () => stored,
    cancelScheduled: async () => true,
    saveAlarm: async (alarm) => {
      if (failSaves) throw new Error('disk full');
      stored = alarm;
    },
    nowMs: () => 60_000,
    journal,
  };

  await assert.rejects(
    processAwakeResponseFailSafe(dependencies, validResponse),
    SuppressionSaveError,
  );
  assert.equal(stored.phase, 'armed');
  assert.equal(entries.get(activeAlarm.cycleId)?.stage, 'cancelled');

  failSaves = false;
  await recoverSuppressionJournal(
    {
      saveAlarm: dependencies.saveAlarm,
      journal,
      listScheduledIds: async () => new Set(),
      nowMs: () => 60_000,
    },
    async () => stored,
  );
  assert.equal(stored.phase, 'suppressed');
  assert.equal(entries.size, 0);
});

function recoveryDeps(options: {
  journal: SuppressionJournal;
  scheduled?: string[];
  saved?: StoredAlarm[];
  nowMs?: number;
  failSave?: boolean;
}) {
  return {
    journal: options.journal,
    saveAlarm: async (a: StoredAlarm) => {
      if (options.failSave) throw new Error('disk full');
      options.saved?.push(a);
    },
    listScheduledIds: async () => new Set(options.scheduled ?? []),
    nowMs: () => options.nowMs ?? 60_000,
  };
}

const intentBase = {
  cycleId: activeAlarm.cycleId,
  alarmId: activeAlarm.alarmId,
  mainAlarmId: activeAlarm.mainAlarmId,
  checkInNotificationId: activeAlarm.checkInNotificationId,
  armedAtMs: activeAlarm.armedAtMs,
  dueAtMs: activeAlarm.dueAtMs,
  suppressed: { ...activeAlarm, phase: 'suppressed' as const },
};

test('cancelled intents with mismatched or missing cycles are dropped without saving', async () => {
  const { entries, journal } = createJournal();
  const saved: StoredAlarm[] = [];
  const deps = recoveryDeps({ journal, saved });

  for (const current of [
    { ...activeAlarm, mainAlarmId: 'main-other' },
    { ...activeAlarm, checkInNotificationId: 'check-other' },
    { ...activeAlarm, dueAtMs: activeAlarm.dueAtMs + 1 },
    { ...activeAlarm, armedAtMs: activeAlarm.armedAtMs + 1 },
    { ...activeAlarm, phase: 'ringing' as const },
    null,
  ]) {
    await journal.record({ ...intentBase, stage: 'cancelled' });
    const outcome = await recoverSuppressionJournal(deps, async () => current);
    assert.deepEqual(outcome, { recovered: [], unresolved: [], saveFailed: [] });
  }
  assert.deepEqual(saved, []);
  assert.equal(entries.size, 0);
});

test('a cancelled intent whose recovery save fails stays recorded and is reported', async () => {
  const { entries, journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelled' });
  const outcome = await recoverSuppressionJournal(
    recoveryDeps({ journal, failSave: true }),
    async () => activeAlarm,
  );
  assert.deepEqual(outcome.saveFailed.map((i) => i.cycleId), [activeAlarm.cycleId]);
  assert.equal(entries.size, 1);
});

test('a cancelling intent whose main notification is still scheduled is cleared: the alarm is still armed', async () => {
  const { entries, journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelling' });
  const saved: StoredAlarm[] = [];
  const outcome = await recoverSuppressionJournal(
    recoveryDeps({ journal, saved, scheduled: [activeAlarm.mainAlarmId] }),
    async () => activeAlarm,
  );
  assert.deepEqual(outcome, { recovered: [], unresolved: [], saveFailed: [] });
  assert.deepEqual(saved, []);
  assert.equal(entries.size, 0);
});

test('a cancelling intent absent from the OS is NOT treated as suppressed: it is kept and reported unresolved', async () => {
  const { entries, journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelling' });
  const saved: StoredAlarm[] = [];
  const outcome = await recoverSuppressionJournal(
    recoveryDeps({ journal, saved, scheduled: ['unrelated-notification'] }),
    async () => activeAlarm,
  );
  assert.deepEqual(saved, []);
  assert.deepEqual(outcome.unresolved.map((i) => i.cycleId), [activeAlarm.cycleId]);
  assert.equal(entries.size, 1);
});

test('an unresolved cancelling intent is retained across repeated recoveries', async () => {
  const { entries, journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelling' });
  for (let i = 0; i < 3; i += 1) {
    const outcome = await recoverSuppressionJournal(
      recoveryDeps({ journal }),
      async () => activeAlarm,
    );
    assert.equal(outcome.unresolved.length, 1);
  }
  assert.equal(entries.size, 1);
});

test('a cancelling intent is settled once the cycle moved on or the due time passed', async () => {
  const { entries, journal } = createJournal();
  for (const [current, nowMs] of [
    [{ ...activeAlarm, phase: 'suppressed' as const }, 60_000],
    [{ ...activeAlarm, mainAlarmId: 'main-new' }, 60_000],
    [null, 60_000],
    [activeAlarm, activeAlarm.dueAtMs],
  ] as const) {
    await journal.record({ ...intentBase, stage: 'cancelling' });
    const outcome = await recoverSuppressionJournal(
      recoveryDeps({ journal, nowMs }),
      async () => current,
    );
    assert.equal(outcome.unresolved.length, 0);
  }
  assert.equal(entries.size, 0);
});

test('recovery never cancels or touches any notification', async () => {
  const { journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelling' });
  await journal.record({ ...intentBase, cycleId: 'c2', stage: 'cancelled' });
  const deps = {
    ...recoveryDeps({ journal, scheduled: [activeAlarm.mainAlarmId, 'unrelated'] }),
    cancelScheduled: async () => assert.fail('recovery must not cancel'),
  };
  await recoverSuppressionJournal(deps, async () => activeAlarm);
});

test('an unreadable OS list or load keeps the intent as unresolved', async () => {
  const { entries, journal } = createJournal();
  await journal.record({ ...intentBase, stage: 'cancelling' });
  const outcome = await recoverSuppressionJournal(
    {
      ...recoveryDeps({ journal }),
      listScheduledIds: async () => {
        throw new Error('notifications unavailable');
      },
    },
    async () => activeAlarm,
  );
  assert.equal(outcome.unresolved.length, 1);
  assert.equal(entries.size, 1);
});

test('the clock is re-read after the journal write: a slow journal past due never cancels', async () => {
  const { entries, journal } = createJournal();
  const reads = [60_000, activeAlarm.dueAtMs];
  const { calls, dependencies } = createResponseDependencies();
  const result = await processAwakeResponseFailSafe(
    { ...dependencies, nowMs: () => reads.shift() ?? activeAlarm.dueAtMs, journal },
    validResponse,
  );
  assert.deepEqual(result, { status: 'alarm_remains', reason: 'ALARM_DUE_OR_PAST' });
  assert.equal(calls.some((c) => c.startsWith('cancel')), false);
  assert.equal(entries.size, 0, 'unused intent is cleared');
});

test('a cancel exception keeps the cancelling intent and surfaces an unknown-state error', async () => {
  const { entries, journal } = createJournal();
  const { dependencies } = createResponseDependencies();
  await assert.rejects(
    processAwakeResponseFailSafe(
      {
        ...dependencies,
        cancelScheduled: async () => {
          throw new Error('verify failed');
        },
        journal,
      },
      validResponse,
    ),
    SuppressionCancelUnknownError,
  );
  assert.equal(entries.get(activeAlarm.cycleId)?.stage, 'cancelling');
});

test('a slow load past the due time never cancels', async () => {
  const { entries, journal } = createJournal();
  const { calls, dependencies } = createResponseDependencies();
  const result = await processAwakeResponseFailSafe(
    { ...dependencies, nowMs: () => activeAlarm.dueAtMs, journal },
    validResponse,
  );
  assert.deepEqual(result, {
    status: 'alarm_remains',
    reason: 'ALARM_DUE_OR_PAST',
  });
  assert.equal(calls.some((c) => c.startsWith('cancel')), false);
  assert.equal(entries.size, 0);
});

test('an unverified cancellation clears the journal and keeps the alarm armed', async () => {
  const { entries, journal } = createJournal();
  const { dependencies } = createResponseDependencies({
    cancellationSucceeded: false,
  });
  const result = await processStepThresholdFailSafe(
    { ...dependencies, nowMs: () => 60_000, journal },
    { steps: 100, observedAtMs: 60_000, countedFromMs: 50_000 },
  );
  assert.equal(result.status, 'alarm_remains');
  assert.equal(entries.size, 0);
});

test('a pending journal entry for the cycle blocks a second attempt and is not overwritten', async () => {
  for (const stage of ['cancelled', 'cancelling'] as const) {
    const { entries, journal } = createJournal();
    await journal.record({ ...intentBase, stage });
    const { calls, dependencies } = createResponseDependencies();
    const result = await processStepThresholdFailSafe(
      { ...dependencies, journal },
      { steps: 100, observedAtMs: 60_000, countedFromMs: 50_000 },
    );
    assert.deepEqual(result, {
      status: 'alarm_remains',
      reason: 'SUPPRESSION_PENDING',
    });
    assert.equal(calls.some((c) => c.startsWith('cancel')), false);
    assert.equal(entries.get(activeAlarm.cycleId)?.stage, stage);
  }
});

test('an unreadable journal blocks the attempt before any cancellation', async () => {
  const { dependencies, calls } = createResponseDependencies();
  const result = await processAwakeResponseFailSafe(
    {
      ...dependencies,
      journal: {
        record: async () => undefined,
        load: async () => {
          throw new Error('corrupt');
        },
        clear: async () => undefined,
        exclusive: (run) => run(),
      },
    },
    validResponse,
  );
  assert.deepEqual(result, { status: 'alarm_remains', reason: 'JOURNAL_NOT_WRITTEN' });
  assert.equal(calls.some((c) => c.startsWith('cancel')), false);
});

function memoryJournalStore() {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: async (key: string) => {
        data.delete(key);
      },
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function raceHarness(options: { cancelResult?: () => boolean; failSaves?: boolean } = {}) {
  const { data, store } = memoryJournalStore();
  // A slow read lets both paths see an empty journal before either records.
  const journal = createSuppressionJournal({
    ...store,
    getItem: async (key) => {
      const value = await store.getItem(key);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    },
  });
  let stored: StoredAlarm = activeAlarm;
  let cancelCalls = 0;
  let loads = 0;
  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const dependencies: AwakeResponseDependencies = {
    // Both paths read before either writes unless the journal serialises them.
    loadAlarm: async () => {
      const snapshot = stored;
      loads += 1;
      // Barrier: wait for the other path to have read too. A serialised
      // second path never arrives, so give up after a short time.
      const deadline = Date.now() + 20;
      while (loads < 2 && Date.now() < deadline) await tick();
      return snapshot;
    },
    saveAlarm: async (alarm) => {
      if (options.failSaves) throw new Error('disk full');
      stored = alarm;
    },
    cancelScheduled: async () => {
      cancelCalls += 1;
      await cancelGate;
      return options.cancelResult ? options.cancelResult() : true;
    },
    nowMs: () => 60_000,
    journal,
  };
  return {
    data,
    journal,
    dependencies,
    releaseCancel,
    getStored: () => stored,
    getCancelCalls: () => cancelCalls,
  };
}

const stepInput = { steps: 100, observedAtMs: 60_000, countedFromMs: 50_000 };

test('an explicit confirmation and 100 steps at once cancel the cycle only once', async () => {
  const h = raceHarness();
  const both = Promise.all([
    processAwakeResponseFailSafe(h.dependencies, validResponse),
    processStepThresholdFailSafe(h.dependencies, stepInput),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.releaseCancel();
  const results = await both;
  assert.equal(h.getCancelCalls(), 1);
  assert.equal(results.filter((r) => r.status === 'suppressed').length, 1);
  assert.equal(h.getStored().phase, 'suppressed');
  assert.deepEqual(await h.journal.load(), []);
});

test('when the winner cannot save, the journal keeps the evidence against the other path', async () => {
  const h = raceHarness({ failSaves: true });
  const both = Promise.allSettled([
    processAwakeResponseFailSafe(h.dependencies, validResponse),
    processStepThresholdFailSafe(h.dependencies, stepInput),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.releaseCancel();
  const [first, second] = await both;
  assert.equal(h.getCancelCalls(), 1);
  assert.equal(first.status, 'rejected');
  assert.deepEqual(
    second.status === 'fulfilled' ? second.value : null,
    { status: 'alarm_remains', reason: 'SUPPRESSION_PENDING' },
  );
  const entries = await h.journal.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.stage, 'cancelled');
});

test('recovery during a live cancellation waits and never erases or misreports it', async () => {
  const h = raceHarness({ cancelResult: () => false });
  const live = processAwakeResponseFailSafe(h.dependencies, validResponse);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const recovery = recoverSuppressionJournal(
    {
      saveAlarm: h.dependencies.saveAlarm,
      journal: h.journal,
      listScheduledIds: async () => new Set(),
      nowMs: () => 60_000,
    },
    async () => h.getStored(),
  );
  await tick();
  await tick();
  // The live stop is still cancelling: its record must be intact.
  assert.equal((await h.journal.load())[0]?.stage, 'cancelling');
  h.releaseCancel();
  assert.equal((await live).status, 'alarm_remains');
  const outcome = await recovery;
  assert.deepEqual(outcome, { recovered: [], unresolved: [], saveFailed: [] });
  assert.deepEqual(await h.journal.load(), []);
});
