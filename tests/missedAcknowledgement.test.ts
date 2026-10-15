/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeMissedAlarms,
  getMissedAcknowledgementNotice,
  type MissedAcknowledgementGateway,
} from '../src/missedAcknowledgement';
import type { StoredAlarm } from '../src/alarmStorage';
import type { AlarmScheduleIssue } from '../src/alarmScheduling';
import { en, ja } from './support/text';

function cycle(cycleId: string, alarmId = 'alarm-1'): StoredAlarm {
  return {
    alarmId,
    cycleId,
    mainAlarmId: `main-${cycleId}`,
    armedAtMs: 0,
    dueAtMs: 1,
    phase: 'missed',
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function makeGateway(
  overrides: Partial<MissedAcknowledgementGateway> = {},
): MissedAcknowledgementGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    persist: async (ids) => {
      calls.push(`persist:${ids.join(',')}`);
      return ids.map((id) => cycle(id));
    },
    dismissDelivered: async (id) => {
      calls.push(`dismiss:${id}`);
    },
    refill: async (c) => {
      calls.push(`refill:${c.alarmId}`);
      return 'none';
    },
    ...overrides,
  };
}

test('persists before dismissing delivered notifications, then refills', async () => {
  const gateway = makeGateway();
  const result = await acknowledgeMissedAlarms([cycle('a'), cycle('b')], gateway);
  assert.equal(result.status, 'acknowledged');
  assert.deepEqual(gateway.calls, [
    'persist:a,b',
    'dismiss:main-a',
    'dismiss:main-b',
    'refill:alarm-1',
  ]);
});

test('a store failure reports failure and dismisses nothing', async () => {
  const gateway = makeGateway({
    persist: async () => {
      throw new Error('store');
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a')], gateway);
  assert.equal(result.status, 'persist_failed');
  assert.deepEqual(gateway.calls, []);
});

test('a failing delivered dismissal does not block acknowledgement or refill', async () => {
  const gateway = makeGateway({
    dismissDelivered: async (id) => {
      gateway.calls.push(`dismiss:${id}`);
      throw new Error('dismiss');
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a'), cycle('b')], gateway);
  assert.equal(result.status, 'acknowledged');
  assert.deepEqual(gateway.calls, [
    'persist:a,b',
    'dismiss:main-a',
    'dismiss:main-b',
    'refill:alarm-1',
  ]);
});

test('a refill failure keeps the acknowledgement and reports the reservation problem', async () => {
  const gateway = makeGateway({
    refill: async () => {
      throw new Error('refill');
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a')], gateway);
  assert.equal(result.status, 'refill_failed');
});

test('refill warnings are surfaced so success is not announced over them', async () => {
  const gateway = makeGateway({ refill: async () => 'warning' });
  const result = await acknowledgeMissedAlarms([cycle('a')], gateway);
  assert.equal(result.status, 'acknowledged');
  assert.equal(result.status === 'acknowledged' && result.refillSeverity, 'warning');
});

test('every affected alarm is refilled even if an earlier refill fails', async () => {
  const gateway = makeGateway({
    persist: async (ids) => ids.map((id) => cycle(id, `alarm-${id}`)),
    refill: async (c) => {
      gateway.calls.push(`refill:${c.alarmId}`);
      if (c.alarmId === 'alarm-a') {
        throw new Error('refill');
      }
      return 'none';
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a'), cycle('b')], gateway);
  assert.equal(result.status, 'refill_failed');
  assert.deepEqual(gateway.calls.filter((c) => c.startsWith('refill')), [
    'refill:alarm-a',
    'refill:alarm-b',
  ]);
});

test('stale selection: cycles no longer missed are neither dismissed nor refilled', async () => {
  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return [cycle('b')];
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a'), cycle('b')], gateway);
  assert.equal(result.status, 'acknowledged');
  assert.deepEqual(gateway.calls, ['persist:a,b', 'dismiss:main-b', 'refill:alarm-1']);
});

test('repeated press: nothing newly acknowledged means no side effects', async () => {
  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return [];
    },
  });
  const result = await acknowledgeMissedAlarms([cycle('a')], gateway);
  assert.equal(result.status, 'nothing');
  assert.deepEqual(gateway.calls, ['persist:a']);
});

test('an empty selection does nothing', async () => {
  const gateway = makeGateway();
  const result = await acknowledgeMissedAlarms([], gateway);
  assert.equal(result.status, 'nothing');
  assert.deepEqual(gateway.calls, []);
});

test('a late missed snooze is acknowledged and both of its delivered ids are dismissed after persisting', async () => {
  const { markCycleRinging } = await import('../src/alarmDefinitionMutations');
  const { acknowledgeMissedCycles, getMissedCycles } = await import('../src/missedAlarms');
  const { RECOVERY_WINDOW_MS } = await import('../src/missedAlarms');
  const snoozed: StoredAlarm = {
    ...cycle('late'),
    phase: 'snoozed',
    dueAtMs: 1_000,
    snooze: { count: 1, notificationId: 'snooze-late', dueAtMs: 2_000 },
  };
  const definition = {
    id: 'alarm-1',
    cycles: [snoozed],
  } as unknown as Parameters<typeof markCycleRinging>[0][number];
  const lateMs = 2_000 + RECOVERY_WINDOW_MS + 1;
  const transition = markCycleRinging(
    [definition],
    { alarmId: 'alarm-1', cycleId: 'late', mainAlarmId: 'snooze-late', dueAtMs: 2_000 },
    lateMs,
  );
  assert.equal(transition.status, 'missed');
  const missed = getMissedCycles(transition.alarms);
  assert.equal(missed.length, 1);

  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return getMissedCycles(acknowledgeMissedCycles(transition.alarms, ids)).length === 0
        ? missed
        : [];
    },
  });
  const result = await acknowledgeMissedAlarms(missed, gateway);
  assert.equal(result.status, 'acknowledged');
  assert.deepEqual(gateway.calls, [
    'persist:late',
    'dismiss:main-late',
    'dismiss:snooze-late',
    'refill:alarm-1',
  ]);
});

test('main, check-in and snooze ids are all dismissed, in that order, after persisting', async () => {
  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return ids.map((id) => ({
        ...cycle(id),
        checkInNotificationId: `checkin-${id}`,
        snooze: { count: 1, notificationId: `snooze-${id}` },
      }));
    },
  });
  await acknowledgeMissedAlarms([cycle('a')], gateway);
  assert.deepEqual(gateway.calls, [
    'persist:a',
    'dismiss:main-a',
    'dismiss:checkin-a',
    'dismiss:snooze-a',
    'refill:alarm-1',
  ]);
});

test('delivered ids are de-duplicated and a failed dismissal does not stop the others', async () => {
  const a: StoredAlarm = {
    ...cycle('a'),
    checkInNotificationId: 'main-a',
    snooze: { count: 1, notificationId: 'main-a' },
  };
  const b: StoredAlarm = {
    ...cycle('b'),
    checkInNotificationId: 'checkin-b',
    snooze: { count: 1, notificationId: 'snooze-b' },
  };
  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return [a, b];
    },
    dismissDelivered: async (id) => {
      gateway.calls.push(`dismiss:${id}`);
      if (id === 'main-a' || id === 'main-b') {
        throw new Error('dismiss');
      }
    },
  });
  const result = await acknowledgeMissedAlarms([a, b], gateway);
  assert.equal(result.status, 'acknowledged');
  assert.deepEqual(gateway.calls, [
    'persist:a,b',
    'dismiss:main-a',
    'dismiss:main-b',
    'dismiss:checkin-b',
    'dismiss:snooze-b',
    'refill:alarm-1',
  ]);
});

test('only persisted cycles are dismissed: a cycle that was not changed keeps its notifications', async () => {
  const kept: StoredAlarm = { ...cycle('kept'), snooze: { count: 1, notificationId: 'snooze-kept' } };
  const gateway = makeGateway({
    persist: async (ids) => {
      gateway.calls.push(`persist:${ids.join(',')}`);
      return [cycle('a')];
    },
  });
  await acknowledgeMissedAlarms([cycle('a'), kept], gateway);
  assert.deepEqual(gateway.calls, ['persist:a,kept', 'dismiss:main-a', 'refill:alarm-1']);
});

function codeOf(notice: object | null): unknown {
  return notice && 'code' in notice ? notice.code : undefined;
}

function issue(kind: AlarmScheduleIssue['kind']): AlarmScheduleIssue {
  return kind === 'main_schedule_failed'
    ? { kind, alarmId: 'x', cycleId: 'c', dueAtMs: 1, code: 'MAIN_REGISTER_FAILED' }
    : { kind, alarmId: 'y', cycleId: 'd', dueAtMs: 1, mainAlarmId: 'm', code: 'CHECKIN_REGISTER_FAILED' };
}

test('the final notice reflects the aggregate: an earlier danger survives a later warning', () => {
  const notice = getMissedAcknowledgementNotice(
    { status: 'acknowledged', refillSeverity: 'danger' },
    [issue('main_schedule_failed'), issue('check_in_schedule_failed')],
    ja,
  );
  assert.equal(notice?.tone, 'danger');
  assert.equal(codeOf(notice), 'MAIN_REGISTER_FAILED');
});

test('a later main failure also wins over an earlier check-in warning', () => {
  const notice = getMissedAcknowledgementNotice(
    { status: 'acknowledged', refillSeverity: 'danger' },
    [issue('check_in_schedule_failed'), issue('main_schedule_failed')],
    ja,
  );
  assert.equal(codeOf(notice), 'MAIN_REGISTER_FAILED');
});

test('clean acknowledgement is neutral; failures map to catalog codes', () => {
  assert.equal(
    getMissedAcknowledgementNotice({ status: 'acknowledged', refillSeverity: 'none' }, [], ja)?.tone,
    'neutral',
  );
  assert.equal(codeOf(getMissedAcknowledgementNotice({ status: 'persist_failed' }, [], ja)), 'MISSED_ACK_FAILED');
  assert.equal(codeOf(getMissedAcknowledgementNotice({ status: 'refill_failed' }, [], ja)), 'REFILL_FAILED');
  assert.equal(getMissedAcknowledgementNotice({ status: 'nothing' }, [], ja), null);
});

test('the acknowledgement notice keeps its code and tone in both languages', () => {
  const cases: Array<[Parameters<typeof getMissedAcknowledgementNotice>[0], AlarmScheduleIssue[]]> = [
    [{ status: 'persist_failed' }, []],
    [{ status: 'refill_failed' }, []],
    [{ status: 'acknowledged', refillSeverity: 'none' }, []],
    [{ status: 'acknowledged', refillSeverity: 'danger' }, [issue('check_in_schedule_failed'), issue('main_schedule_failed')]],
    [{ status: 'acknowledged', refillSeverity: 'warning' }, [issue('check_in_schedule_failed')]],
  ];
  for (const [result, issues] of cases) {
    const inJa = getMissedAcknowledgementNotice(result, issues, ja);
    const inEn = getMissedAcknowledgementNotice(result, issues, en);
    assert.equal(inJa?.tone, inEn?.tone);
    assert.equal(codeOf(inJa), codeOf(inEn));
    assert.ok(inJa && inEn);
    assert.doesNotMatch(inEn.text, /[぀-ヿ㐀-鿿]/);
    assert.match(inJa.text, /[぀-ヿ㐀-鿿]/);
  }
  assert.equal(getMissedAcknowledgementNotice({ status: 'nothing' }, [], en), null);
  assert.equal(
    getMissedAcknowledgementNotice({ status: 'refill_failed' }, [], en)?.text,
    en.missed.acknowledgeRefillFailed,
  );
  assert.equal(
    getMissedAcknowledgementNotice({ status: 'acknowledged', refillSeverity: 'none' }, [], en)?.text,
    en.missed.acknowledged,
  );
});
