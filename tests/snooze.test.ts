/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { processAwakeResponseFailSafe } from '../src/alarmOrchestrator';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';
import {
  NOTIFICATION_CAPACITY,
  SNOOZE_INTERVAL_MS,
  SNOOZE_MAX_COUNT,
  createSnoozeService,
  getSnoozeAvailability,
  getSnoozeIds,
  isSnoozeRecord,
  shouldRingFromDelivery,
  type SnoozeGateway,
  type SnoozeStore,
} from '../src/snooze';

const MINUTE = 60_000;
const DUE = 1_000_000_000;
const NOW = DUE + 20_000;

function ringing(overrides: Partial<StoredAlarm> = {}): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: DUE - 10 * MINUTE,
    dueAtMs: DUE,
    phase: 'ringing',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...overrides,
  };
}

interface Harness {
  service: ReturnType<typeof createSnoozeService>;
  store: SnoozeStore;
  log: string[];
  saved: StoredAlarm[];
  scheduled: Set<string>;
  scheduleCalls: Array<Parameters<SnoozeGateway['schedule']>[0]>;
  cancelled: string[];
  current(): StoredAlarm;
  clock: { now: number };
  fail: {
    schedule?: boolean;
    cancel?: boolean;
    list?: boolean;
    saveWhen?: (cycle: StoredAlarm, call: number) => boolean;
    scheduleRegistersAnyway?: boolean;
    scheduleDropsNotification?: boolean;
    scheduleReturns?: string;
    load?: boolean;
    cancelIds?: string[];
  };
  foreignCount: number;
}

function harness(
  initial: StoredAlarm,
  options: { foreign?: number; scheduledIds?: string[] } = {},
): Harness {
  let stored = initial;
  const log: string[] = [];
  const saved: StoredAlarm[] = [];
  const scheduled = new Set<string>(options.scheduledIds ?? []);
  const cancelled: string[] = [];
  const scheduleCalls: Harness['scheduleCalls'] = [];
  const fail: Harness['fail'] = {};
  const clock = { now: NOW };
  let saveCalls = 0;
  let idCounter = 0;

  const foreignIds = Array.from(
    { length: options.foreign ?? 0 },
    (_, index) => `foreign-${index}`,
  );

  const gateway: SnoozeGateway = {
    async listScheduledIds() {
      if (fail.list) {
        throw new Error('list failed');
      }
      return new Set([...scheduled, ...foreignIds]);
    },
    async schedule(input) {
      log.push(`schedule:${input.identifier}`);
      scheduleCalls.push(input);
      if (fail.scheduleRegistersAnyway) {
        scheduled.add(input.identifier);
      }
      if (fail.schedule) {
        throw new Error('schedule failed');
      }
      if (!fail.scheduleDropsNotification) {
        scheduled.add(input.identifier);
      }
      if (fail.scheduleReturns && fail.scheduleReturns !== input.identifier) {
        scheduled.add(fail.scheduleReturns);
      }
      return fail.scheduleReturns ?? input.identifier;
    },
    async cancelScheduled(id) {
      log.push(`cancel:${id}`);
      cancelled.push(id);
      if (fail.cancel || fail.cancelIds?.includes(id)) {
        throw new Error('cancel failed');
      }
      scheduled.delete(id);
    },
    async dismissDelivered(id) {
      log.push(`dismiss:${id}`);
    },
  };

  const store: SnoozeStore = {
    async load(cycleId) {
      if (fail.load) {
        throw new Error('load failed');
      }
      return stored.cycleId === cycleId ? stored : null;
    },
    async save(cycle) {
      saveCalls += 1;
      if (fail.saveWhen?.(cycle, saveCalls)) {
        throw new Error('save failed');
      }
      log.push(`save:${cycle.phase}${cycle.snooze?.pending ? '+pending' : ''}`);
      stored = cycle;
      saved.push(cycle);
    },
  };

  const service = createSnoozeService({
    gateway,
    store,
    nowMs: () => clock.now,
    makeId: () => `snooze-id-${(idCounter += 1)}`,
  });

  return {
    service,
    store,
    log,
    saved,
    scheduled,
    scheduleCalls,
    cancelled,
    current: () => stored,
    clock,
    fail,
    foreignCount: foreignIds.length,
  };
}

describe('snooze acceptance', () => {
  test('defaults to five minutes and three snoozes', () => {
    assert.equal(SNOOZE_INTERVAL_MS, 5 * MINUTE);
    assert.equal(SNOOZE_MAX_COUNT, 3);
    assert.equal(NOTIFICATION_CAPACITY, 64);
  });

  test('keeps the occurrence identity and original due time, with a new exact delivery id', async () => {
    const h = harness(ringing());
    const result = await h.service.snooze('cycle-1');

    assert.equal(result.status, 'snoozed');
    const after = h.current();
    assert.equal(after.phase, 'snoozed');
    assert.equal(after.cycleId, 'cycle-1');
    assert.equal(after.alarmId, 'alarm-1');
    assert.equal(after.mainAlarmId, 'main-1');
    assert.equal(after.dueAtMs, DUE, 'snooze never moves the original due time');
    assert.equal(after.snooze?.count, 1);
    assert.equal(after.snooze?.dueAtMs, NOW + 5 * MINUTE);
    assert.equal(after.snooze?.notificationId, 'snooze-id-1');
    assert.notEqual(after.snooze?.notificationId, after.mainAlarmId);
    assert.equal(after.snooze?.pending, undefined);
    assert.equal(h.scheduleCalls.length, 1);
    assert.equal(h.scheduleCalls[0].identifier, 'snooze-id-1');
    assert.equal(h.scheduleCalls[0].cycleId, 'cycle-1');
    assert.equal(h.scheduleCalls[0].dueAtMs, NOW + 5 * MINUTE);
    assert.equal(h.scheduleCalls[0].snoozeNumber, 1);
  });

  test('records the requested id durably before the notification is scheduled', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    assert.deepEqual(h.log.slice(0, 4), [
      'save:ringing+pending',
      'schedule:snooze-id-1',
      'save:snoozed',
      'dismiss:main-1',
    ]);
    assert.equal(h.saved[0].snooze?.pending?.requestedId, 'snooze-id-1');
  });

  test('each accepted snooze gets a different delivery id', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    // The snooze fires and the occurrence rings again.
    h.clock.now += 5 * MINUTE;
    await h.store.save({ ...h.current(), phase: 'ringing' });
    await h.service.snooze('cycle-1');

    assert.equal(h.current().snooze?.count, 2);
    assert.equal(h.current().snooze?.notificationId, 'snooze-id-2');
    assert.equal(h.current().dueAtMs, DUE);
  });

  test('rapid duplicate presses schedule once and count once', async () => {
    const h = harness(ringing());
    const [first, second] = await Promise.all([
      h.service.snooze('cycle-1'),
      h.service.snooze('cycle-1'),
    ]);

    assert.equal(first.status, 'snoozed');
    assert.equal(second.status, 'snoozed');
    assert.equal(h.scheduleCalls.length, 1);
    assert.equal(h.current().snooze?.count, 1);
  });

  test('a press after the snooze was accepted is rejected without scheduling', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    const again = await h.service.snooze('cycle-1');
    assert.deepEqual(again, { status: 'rejected', reason: 'NOT_RINGING' });
    assert.equal(h.scheduleCalls.length, 1);
    assert.equal(h.current().snooze?.count, 1);
  });

  test('refuses a fourth snooze and keeps ringing', async () => {
    const h = harness(
      ringing({
        snooze: { count: 3, notificationId: 'old', dueAtMs: NOW - MINUTE },
      }),
    );
    const result = await h.service.snooze('cycle-1');
    assert.deepEqual(result, { status: 'rejected', reason: 'LIMIT_REACHED' });
    assert.equal(h.scheduleCalls.length, 0);
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.current().snooze?.count, 3);
  });

  test('accepts the third snooze', async () => {
    const h = harness(
      ringing({
        snooze: { count: 2, notificationId: 'old', dueAtMs: NOW - MINUTE },
      }),
    );
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
    assert.equal(h.current().snooze?.count, 3);
  });

  test('only a ringing occurrence can be snoozed', async () => {
    for (const phase of ['armed', 'step_candidate', 'suppressed', 'missed', 'dismissed'] as const) {
      const h = harness(ringing({ phase }));
      const result = await h.service.snooze('cycle-1');
      assert.deepEqual(result, { status: 'rejected', reason: 'NOT_RINGING' }, phase);
      assert.equal(h.scheduleCalls.length, 0);
    }
    const h = harness(ringing());
    assert.deepEqual(await h.service.snooze('missing'), {
      status: 'rejected',
      reason: 'NOT_FOUND',
    });
  });
});

describe('snooze is not wake evidence', () => {
  test('a confirmation after the original due time cannot suppress a snoozed occurrence', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    const snoozed = h.current();
    assert.equal(snoozed.dueAtMs, DUE);

    let cancelled = false;
    const result = await processAwakeResponseFailSafe(
      {
        loadAlarm: async () => snoozed,
        saveAlarm: async () => undefined,
        cancelScheduled: async () => {
          cancelled = true;
          return true;
        },
        nowMs: () => NOW + MINUTE,
      },
      {
        actionIdentifier: 'confirm_awake',
        kind: 'awake_checkin',
        cycleId: 'cycle-1',
        mainAlarmId: 'main-1',
        checkInNotificationId: 'check-1',
        confirmedAtMs: NOW + MINUTE,
      },
    );
    assert.equal(result.status, 'alarm_remains');
    assert.equal(cancelled, false);
  });
});

describe('snooze failures keep the alarm ringing', () => {
  test('a failed registration is never reported as success and removes any partial request', async () => {
    const h = harness(ringing());
    h.fail.schedule = true;
    h.fail.scheduleRegistersAnyway = true;
    const result = await h.service.snooze('cycle-1');

    assert.equal(result.status, 'rejected');
    assert.equal((result as { reason: string }).reason, 'SCHEDULE_FAILED');
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.current().snooze?.pending, undefined);
    assert.equal(h.current().snooze?.count ?? 0, 0);
    assert.deepEqual(h.cancelled, ['snooze-id-1']);
    assert.equal(h.scheduled.has('snooze-id-1'), false);
    assert.ok(!h.log.includes('dismiss:main-1'), 'ringing is not dismissed');
  });

  test('a registration that cannot be verified is cancelled and not reported as success', async () => {
    const h = harness(ringing());
    h.fail.scheduleDropsNotification = true;
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { reason: string }).reason, 'VERIFY_FAILED');
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.current().snooze?.pending, undefined);
  });

  test('an unexpected id from the system is not trusted', async () => {
    const h = harness(ringing());
    h.fail.scheduleReturns = 'something-else';
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal(h.current().phase, 'ringing');
    assert.ok(h.cancelled.includes('snooze-id-1'));
  });

  test('when the intent cannot be saved nothing is scheduled', async () => {
    const h = harness(ringing());
    h.fail.saveWhen = () => true;
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { reason: string }).reason, 'INTENT_NOT_SAVED');
    assert.equal(h.scheduleCalls.length, 0);
    assert.equal(h.current().phase, 'ringing');
  });

  test('a failed final save is retried once before it is given up', async () => {
    const h = harness(ringing());
    h.fail.saveWhen = (cycle, call) => cycle.phase === 'snoozed' && call === 2;
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
    assert.equal(h.current().phase, 'snoozed');
    assert.equal(h.cancelled.length, 0);
  });

  test('when the final save keeps failing the snooze is cancelled and the alarm stays ringing', async () => {
    const h = harness(ringing());
    h.fail.saveWhen = (cycle) => cycle.phase === 'snoozed';
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { reason: string }).reason, 'PERSIST_FAILED');
    assert.deepEqual(h.cancelled, ['snooze-id-1']);
    assert.equal(h.scheduled.has('snooze-id-1'), false);
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.current().snooze?.pending, undefined);
    assert.ok(!h.log.includes('dismiss:main-1'));
  });

  test('when the cleanup cannot be confirmed the requested id stays recorded', async () => {
    const h = harness(ringing());
    h.fail.schedule = true;
    h.fail.cancel = true;
    const result = await h.service.snooze('cycle-1');
    assert.deepEqual(result, {
      status: 'rejected',
      reason: 'SCHEDULE_FAILED',
      cleanup: 'unconfirmed',
    });
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.current().snooze?.pending?.requestedId, 'snooze-id-1');
  });

  test('a notification list that cannot be read stops before any change', async () => {
    const h = harness(ringing());
    h.fail.list = true;
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal(h.saved.length, 0);
    assert.equal(h.scheduleCalls.length, 0);
  });

  test('a later press can succeed after a failure and counts once', async () => {
    const h = harness(ringing());
    h.fail.schedule = true;
    await h.service.snooze('cycle-1');
    h.fail.schedule = false;
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
    assert.equal(h.current().snooze?.count, 1);
  });
});

describe('snooze capacity and deadlines', () => {
  test('refuses when the system queue, including other apps, is full', async () => {
    const h = harness(ringing(), { foreign: NOTIFICATION_CAPACITY });
    const result = await h.service.snooze('cycle-1');
    assert.deepEqual(result, { status: 'rejected', reason: 'CAPACITY_FULL' });
    assert.equal(h.scheduleCalls.length, 0);
    assert.equal(h.current().phase, 'ringing');
    assert.equal(h.saved.length, 0);
  });

  test('uses the last free slot', async () => {
    const h = harness(ringing(), { foreign: NOTIFICATION_CAPACITY - 1 });
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
  });

  test('refuses a snooze that would be due at or after the next occurrence', async () => {
    const h = harness(ringing());
    const notAfterMs = NOW + 5 * MINUTE;
    const result = await h.service.snooze('cycle-1', { notAfterMs });
    assert.deepEqual(result, { status: 'rejected', reason: 'TOO_LATE' });
    assert.equal(h.scheduleCalls.length, 0);
    const ok = await h.service.snooze('cycle-1', { notAfterMs: notAfterMs + 1 });
    assert.equal(ok.status, 'snoozed');
  });

  test('a leftover requested id from an interrupted attempt is cancelled first and does not use a slot', async () => {
    const h = harness(
      ringing({
        snooze: {
          count: 0,
          pending: { requestedId: 'stale', dueAtMs: NOW },
        },
      }),
      { scheduledIds: ['stale'], foreign: NOTIFICATION_CAPACITY - 1 },
    );
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
    assert.ok(h.cancelled.includes('stale'));
    assert.equal(h.current().snooze?.count, 1);
  });
});

describe('stopping cancels the snooze notification', () => {
  test('stopping a snoozed occurrence cancels its exact snooze id and the check-in', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    const result = await h.service.stop('cycle-1');
    assert.equal(result.status, 'stopped');
    assert.ok(h.cancelled.includes('snooze-id-1'));
    assert.equal(h.scheduled.has('snooze-id-1'), false);
    assert.equal(h.current().phase, 'dismissed');
    assert.equal(h.current().snooze, undefined);
  });

  test('stopping while ringing also cancels a requested id that was never confirmed', async () => {
    const h = harness(
      ringing({
        snooze: { count: 0, pending: { requestedId: 'maybe', dueAtMs: NOW } },
      }),
      { scheduledIds: ['maybe'] },
    );
    const result = await h.service.stop('cycle-1');
    assert.equal(result.status, 'stopped');
    assert.deepEqual(
      h.cancelled.filter((id) => id === 'maybe'),
      ['maybe'],
    );
    assert.equal(h.current().phase, 'dismissed');
  });

  test('a stop whose cancellation cannot be confirmed leaves the state ringing', async () => {
    const h = harness(ringing());
    await h.service.snooze('cycle-1');
    h.fail.cancel = true;
    const result = await h.service.stop('cycle-1');
    assert.equal(result.status, 'failed');
    assert.equal(h.current().phase, 'snoozed');
    assert.equal(h.current().snooze?.notificationId, 'snooze-id-1');
  });

  test('a stop queued behind a snooze in progress ends with everything cancelled', async () => {
    const h = harness(ringing());
    const [snoozeResult, stopResult] = await Promise.all([
      h.service.snooze('cycle-1'),
      h.service.stop('cycle-1'),
    ]);
    assert.equal(snoozeResult.status, 'snoozed');
    assert.equal(stopResult.status, 'stopped');
    assert.equal(h.current().phase, 'dismissed');
    assert.equal(h.scheduled.has('snooze-id-1'), false);
  });

  test('a snooze queued behind a stop is rejected', async () => {
    const h = harness(ringing());
    const [stopResult, snoozeResult] = await Promise.all([
      h.service.stop('cycle-1'),
      h.service.snooze('cycle-1'),
    ]);
    assert.equal(stopResult.status, 'stopped');
    assert.deepEqual(snoozeResult, { status: 'rejected', reason: 'NOT_RINGING' });
    assert.equal(h.scheduleCalls.length, 0);
  });

  test('stop ignores occurrences that are not ringing or snoozed', async () => {
    const h = harness(ringing({ phase: 'armed' }));
    assert.deepEqual(await h.service.stop('cycle-1'), { status: 'ignored' });
  });
});

describe('restart recovery', () => {
  function definition(cycle: StoredAlarm): StoredAlarmDefinition {
    return {
      id: 'alarm-1',
      hour: 7,
      minute: 0,
      repeat: { kind: 'daily', weekdays: [] },
      enabled: true,
      createdAtMs: 1,
      cycles: [cycle],
    };
  }

  test('re-arms the same snooze id when its notification is missing and still in the future', async () => {
    const snoozed = ringing({
      phase: 'snoozed',
      snooze: { count: 1, notificationId: 'snooze-keep', dueAtMs: NOW + 2 * MINUTE },
    });
    const h = harness(snoozed);
    const outcome = await h.service.recover([definition(snoozed)]);
    assert.deepEqual(outcome.rearmed, ['cycle-1']);
    assert.equal(h.scheduleCalls[0].identifier, 'snooze-keep');
    assert.equal(h.scheduleCalls[0].dueAtMs, NOW + 2 * MINUTE);
    assert.equal(h.current().snooze?.count, 1, 'a restart never adds a snooze');
  });

  test('leaves a snooze alone when the system still has it', async () => {
    const snoozed = ringing({
      phase: 'snoozed',
      snooze: { count: 1, notificationId: 'snooze-keep', dueAtMs: NOW + 2 * MINUTE },
    });
    const h = harness(snoozed, { scheduledIds: ['snooze-keep'] });
    const outcome = await h.service.recover([definition(snoozed)]);
    assert.deepEqual(outcome.rearmed, []);
    assert.equal(h.scheduleCalls.length, 0);
  });

  test('reports a snooze that cannot be re-armed and keeps its state', async () => {
    const snoozed = ringing({
      phase: 'snoozed',
      snooze: { count: 1, notificationId: 'snooze-keep', dueAtMs: NOW + 2 * MINUTE },
    });
    const h = harness(snoozed);
    h.fail.schedule = true;
    const outcome = await h.service.recover([definition(snoozed)]);
    assert.deepEqual(outcome.rearmFailed, ['cycle-1']);
    assert.equal(h.current().phase, 'snoozed');
  });

  test('does not re-arm a snooze whose time has passed; the due-time rule decides', async () => {
    const snoozed = ringing({
      phase: 'snoozed',
      snooze: { count: 1, notificationId: 'snooze-keep', dueAtMs: NOW - MINUTE },
    });
    const h = harness(snoozed);
    const outcome = await h.service.recover([definition(snoozed)]);
    assert.deepEqual(outcome.rearmed, []);
    assert.equal(h.scheduleCalls.length, 0);
  });

  test('cancels a requested id left by an interrupted attempt and clears it', async () => {
    const interrupted = ringing({
      snooze: { count: 0, pending: { requestedId: 'half', dueAtMs: NOW } },
    });
    const h = harness(interrupted, { scheduledIds: ['half'] });
    const outcome = await h.service.recover([definition(interrupted)]);
    assert.deepEqual(outcome.cleaned, ['cycle-1']);
    assert.deepEqual(h.cancelled, ['half']);
    assert.equal(h.current().snooze?.pending, undefined);
    assert.equal(h.current().phase, 'ringing');
  });
});

describe('recovery never decides from stale or unverified state', () => {
  function def(...cycles: StoredAlarm[]): StoredAlarmDefinition {
    return {
      id: 'alarm-1',
      hour: 7,
      minute: 0,
      repeat: { kind: 'daily', weekdays: [] },
      enabled: true,
      createdAtMs: 1,
      cycles,
    };
  }
  const waiting = (cycleId = 'cycle-1', id = 'snooze-keep') =>
    ringing({
      cycleId,
      phase: 'snoozed',
      snooze: { count: 1, notificationId: id, dueAtMs: NOW + 2 * MINUTE },
    });

  test('a cycle deleted since the listing is skipped, not rescheduled from the listing', async () => {
    const h = harness(ringing({ cycleId: 'other' }));
    const outcome = await h.service.recover([def(waiting())]);
    assert.equal(h.scheduleCalls.length, 0);
    assert.deepEqual(h.cancelled, []);
    assert.deepEqual(outcome.rearmed, []);
    assert.deepEqual(outcome.rearmFailed, []);
  });

  test('a failed read is unresolved and neither schedules nor cancels', async () => {
    const pending = ringing({
      cycleId: 'cycle-2',
      snooze: { count: 0, pending: { requestedId: 'half', dueAtMs: NOW } },
    });
    for (const listed of [waiting(), pending]) {
      const h = harness(listed, { scheduledIds: ['half'] });
      h.fail.load = true;
      const outcome = await h.service.recover([def(listed)]);
      assert.deepEqual(outcome.unresolved, [listed.cycleId]);
      assert.equal(h.scheduleCalls.length, 0);
      assert.deepEqual(h.cancelled, []);
      assert.equal(h.saved.length, 0);
    }
  });

  test('a cycle stopped since the listing is not re-armed', async () => {
    const h = harness(ringing({ phase: 'dismissed' }));
    const outcome = await h.service.recover([def(waiting())]);
    assert.equal(h.scheduleCalls.length, 0);
    assert.deepEqual(outcome.rearmed, []);
  });

  test('does not re-arm when the queue is full', async () => {
    const h = harness(waiting(), { foreign: NOTIFICATION_CAPACITY });
    const outcome = await h.service.recover([def(waiting())]);
    assert.equal(h.scheduleCalls.length, 0);
    assert.deepEqual(outcome.rearmFailed, ['cycle-1']);
    assert.deepEqual(outcome.rearmed, []);
    assert.equal(h.current().snooze?.notificationId, 'snooze-keep');
  });

  test('counts each recovered slot across cycles', async () => {
    const a = waiting('cycle-1', 'snooze-a');
    const b = waiting('cycle-2', 'snooze-b');
    const h = harness(a, { foreign: NOTIFICATION_CAPACITY - 1 });
    const outcome = await h.service.recover([def(a, b)]);
    assert.deepEqual(outcome.rearmed, ['cycle-1']);
    assert.equal(h.scheduleCalls.length, 1, 'second cycle has no slot left');
  });

  test('does not report rearmed when readback cannot confirm the exact id', async () => {
    const h = harness(waiting());
    h.fail.scheduleDropsNotification = true;
    const outcome = await h.service.recover([def(waiting())]);
    assert.deepEqual(outcome.rearmed, []);
    assert.deepEqual(outcome.rearmFailed, ['cycle-1']);
    assert.equal(h.current().phase, 'snoozed');
    assert.equal(h.current().snooze?.notificationId, 'snooze-keep');
  });

  test('does not report rearmed when readback fails', async () => {
    // list fails only after the schedule call
    const wrapped = harnessListFailsAfterSchedule();
    const outcome = await wrapped.service.recover([def(waiting())]);
    assert.deepEqual(outcome.rearmed, []);
    assert.deepEqual(outcome.rearmFailed, ['cycle-1']);
  });

  test('an unknown returned id that cannot be cancelled stays tracked', async () => {
    const h = harness(waiting());
    h.fail.scheduleReturns = 'stray';
    h.fail.cancelIds = ['stray'];
    const outcome = await h.service.recover([def(waiting())]);
    assert.deepEqual(outcome.rearmed, []);
    assert.ok(getSnoozeIds(h.current()).includes('stray'));
    assert.ok(getSnoozeIds(h.current()).includes('snooze-keep'));
  });

  test('snooze: an unknown returned id that cannot be cancelled is recorded durably', async () => {
    const h = harness(ringing());
    h.fail.scheduleReturns = 'stray';
    h.fail.cancelIds = ['stray'];
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { cleanup?: string }).cleanup, 'unconfirmed');
    assert.ok(getSnoozeIds(h.current()).includes('stray'));
    assert.equal(h.current().phase, 'ringing');
  });

  test('recovery cancels a recorded stray id and clears it', async () => {
    const cycle = ringing({
      snooze: {
        count: 0,
        pending: { requestedId: 'half', dueAtMs: NOW, strayIds: ['stray'] },
      },
    });
    const h = harness(cycle, { scheduledIds: ['half', 'stray'] });
    const outcome = await h.service.recover([def(cycle)]);
    assert.deepEqual(outcome.cleaned, ['cycle-1']);
    assert.deepEqual([...h.cancelled].sort(), ['half', 'stray']);
    assert.equal(h.current().snooze?.pending, undefined);
  });
});

describe('retry gaps around stray ids', () => {
  function def(...cycles: StoredAlarm[]): StoredAlarmDefinition {
    return {
      id: 'alarm-1',
      hour: 7,
      minute: 0,
      repeat: { kind: 'daily', weekdays: [] },
      enabled: true,
      createdAtMs: 1,
      cycles,
    };
  }
  const waiting = (cycleId: string, id: string) =>
    ringing({
      cycleId,
      phase: 'snoozed',
      snooze: { count: 1, notificationId: id, dueAtMs: NOW + 2 * MINUTE },
    });
  const withStray = () =>
    ringing({
      snooze: {
        count: 0,
        pending: { requestedId: 'half', dueAtMs: NOW, strayIds: ['stray'] },
      },
    });

  test('snooze retry cancels a recorded stray id before replacing pending', async () => {
    const h = harness(withStray(), { scheduledIds: ['stray'] });
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'snoozed');
    assert.ok(h.cancelled.includes('stray'));
    assert.equal(h.scheduled.has('stray'), false);
    assert.ok(h.log.indexOf('cancel:stray') < h.log.indexOf('schedule:snooze-id-1'));
  });

  test('snooze retry refuses while a recorded stray id cannot be cancelled', async () => {
    const h = harness(withStray(), { scheduledIds: ['stray'] });
    h.fail.cancelIds = ['stray'];
    const result = await h.service.snooze('cycle-1');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { cleanup?: string }).cleanup, 'unconfirmed');
    assert.equal(h.scheduleCalls.length, 0);
    assert.ok(getSnoozeIds(h.current()).includes('stray'));
    assert.equal(h.current().phase, 'ringing');
  });

  test('recovery does not spend a slot from a stale queue after a throwing schedule', async () => {
    const a = waiting('cycle-1', 'snooze-a');
    const b = waiting('cycle-2', 'snooze-b');
    const h = harness(a, { foreign: NOTIFICATION_CAPACITY - 1 });
    h.fail.schedule = true;
    h.fail.scheduleRegistersAnyway = true;
    const loadFirst = h.store.load.bind(h.store);
    h.store.load = async (id) => (id === b.cycleId ? b : loadFirst(id));
    const outcome = await h.service.recover([def(a, b)]);
    assert.equal(h.scheduleCalls.length, 1, 'no 65th notification');
    assert.deepEqual(outcome.rearmed, []);
    assert.deepEqual(outcome.rearmFailed.sort(), ['cycle-1', 'cycle-2']);
  });

  test('recovery does not spend a slot while a wrong id remains', async () => {
    const a = waiting('cycle-1', 'snooze-a');
    const b = waiting('cycle-2', 'snooze-b');
    const h = harness(a, { foreign: NOTIFICATION_CAPACITY - 1 });
    h.fail.scheduleReturns = 'stray';
    h.fail.cancelIds = ['stray'];
    await h.service.recover([def(a, b)]);
    assert.equal(h.scheduleCalls.length, 1);
    assert.ok(getSnoozeIds(h.current()).includes('stray'));
  });

  test('a wrong id whose tracking cannot be saved is reported unresolved', async () => {
    const a = waiting('cycle-1', 'snooze-a');
    const h = harness(a);
    h.fail.scheduleReturns = 'stray';
    h.fail.cancelIds = ['stray'];
    h.fail.saveWhen = () => true;
    const outcome = await h.service.recover([def(a)]);
    assert.deepEqual(outcome.rearmed, []);
    assert.deepEqual(outcome.unresolved, ['cycle-1']);
  });
});

function harnessListFailsAfterSchedule() {
  const cycle: StoredAlarm = ringing({
    phase: 'snoozed',
    snooze: { count: 1, notificationId: 'snooze-keep', dueAtMs: NOW + 2 * MINUTE },
  });
  let scheduledOnce = false;
  const service = createSnoozeService({
    gateway: {
      async listScheduledIds() {
        if (scheduledOnce) {
          throw new Error('list failed');
        }
        return new Set<string>();
      },
      async schedule(input) {
        scheduledOnce = true;
        return input.identifier;
      },
      async cancelScheduled() {},
      async dismissDelivered() {},
    },
    store: { load: async () => cycle, save: async () => {} },
    nowMs: () => NOW,
    makeId: () => 'x',
  });
  return { service };
}

describe('snooze helpers', () => {
  test('availability reports the next time and remaining count', () => {
    assert.deepEqual(getSnoozeAvailability(ringing(), NOW), {
      canSnooze: true,
      used: 0,
      remaining: 3,
      nextAtMs: NOW + 5 * MINUTE,
    });
    const limit = getSnoozeAvailability(
      ringing({ snooze: { count: 3, notificationId: 'x', dueAtMs: NOW } }),
      NOW,
    );
    assert.equal(limit.canSnooze, false);
    assert.equal(limit.remaining, 0);
  });

  test('lists every snooze notification id to cancel or remember', () => {
    assert.deepEqual(getSnoozeIds(ringing()), []);
    assert.deepEqual(
      getSnoozeIds(
        ringing({
          snooze: {
            count: 1,
            notificationId: 'a',
            dueAtMs: 1,
            pending: { requestedId: 'b', dueAtMs: 2 },
          },
        }),
      ),
      ['a', 'b'],
    );
  });

  test('only the matching delivery turns a snoozed occurrence into ringing', () => {
    const snoozed = ringing({
      phase: 'snoozed',
      snooze: { count: 1, notificationId: 'a', dueAtMs: 1 },
    });
    assert.equal(shouldRingFromDelivery(snoozed, 'a'), true);
    assert.equal(shouldRingFromDelivery(snoozed, 'other'), false);
    assert.equal(shouldRingFromDelivery(ringing({ phase: 'armed' }), 'main-1'), true);
    assert.equal(shouldRingFromDelivery(ringing({ phase: 'dismissed' }), 'main-1'), false);
  });

  test('validates stored snooze records strictly', () => {
    assert.equal(isSnoozeRecord({ count: 0 }), true);
    assert.equal(isSnoozeRecord({ count: 3, notificationId: 'a', dueAtMs: 1 }), true);
    assert.equal(isSnoozeRecord({ count: 4 }), false);
    assert.equal(isSnoozeRecord({ count: -1 }), false);
    assert.equal(isSnoozeRecord({ count: 1.5 }), false);
    assert.equal(isSnoozeRecord({ count: 1, notificationId: '' }), false);
    assert.equal(isSnoozeRecord({ count: 1, pending: { requestedId: 'a' } }), false);
    assert.equal(isSnoozeRecord(null), false);
  });
});
