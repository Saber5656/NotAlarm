/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ALREADY_UP_OWNER,
  parseAlarmNotificationData,
} from '../src/alarmContracts';
import { cancelAlarmDefinitionWithCheckpoints } from '../src/alarmCancellation';
import { isOwnedAlarmNotification } from '../src/alarmNotificationOwnership';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import { fillAlarmDefinitionSchedule } from '../src/alarmScheduling';
import {
  ALARM_DEFINITIONS_STORAGE_KEY,
  type StoredAlarm,
  type StoredAlarmDefinition,
} from '../src/alarmStorage';
import { shouldKeepScreenAwake } from '../src/bedsideMode';
import {
  RECOVERY_WINDOW_MS,
  classifyDueCycle,
  getMissedCycles,
} from '../src/missedAlarms';
import { getSnoozeCopy } from '../src/snoozeCopy';
import { createStorageResetService } from '../src/storageReset';

const MINUTE = 60_000;
const DUE = new Date(2026, 9, 15, 7, 0, 0).getTime();

function snoozed(
  snoozeDueAtMs: number,
  overrides: Partial<StoredAlarm> = {},
): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: DUE - 10 * MINUTE,
    dueAtMs: DUE,
    phase: 'snoozed',
    stepCount: 0,
    stepCandidateRecorded: false,
    snooze: { count: 1, notificationId: 'snooze-1', dueAtMs: snoozeDueAtMs },
    ...overrides,
  };
}

function definition(
  cycles: StoredAlarm[],
  kind: 'daily' | 'today' = 'daily',
): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat(kind, DUE),
    enabled: true,
    createdAtMs: DUE - 86_400_000,
    cycles,
  };
}

describe('recovery classification of snoozed occurrences', () => {
  const snoozeDue = DUE + 5 * MINUTE;

  test('stays snoozed before its own time', () => {
    for (const source of ['launch', 'resume'] as const) {
      assert.equal(classifyDueCycle(snoozed(snoozeDue), snoozeDue - 1, source).phase, 'snoozed');
    }
  });

  test('rings when its own time arrives, even long after the original time', () => {
    const late = snoozed(DUE + 40 * MINUTE);
    assert.equal(classifyDueCycle(late, DUE + 40 * MINUTE, 'resume').phase, 'ringing');
  });

  test('becomes a silent missed alarm when discovered after the recovery window', () => {
    for (const source of ['launch', 'resume'] as const) {
      const now = snoozeDue + RECOVERY_WINDOW_MS + 1;
      assert.equal(classifyDueCycle(snoozed(snoozeDue), now, source).phase, 'missed');
    }
    const edge = snoozeDue + RECOVERY_WINDOW_MS;
    assert.equal(classifyDueCycle(snoozed(snoozeDue), edge, 'launch').phase, 'ringing');
  });

  test('a snoozed ringing occurrence is judged from the snooze time on launch', () => {
    const rung = snoozed(snoozeDue, { phase: 'ringing' });
    const now = DUE + RECOVERY_WINDOW_MS + 5 * MINUTE;
    assert.equal(classifyDueCycle(rung, now, 'launch').phase, 'ringing');
    assert.equal(
      classifyDueCycle(rung, snoozeDue + RECOVERY_WINDOW_MS + 1, 'launch').phase,
      'missed',
    );
  });

  test('missed list includes an expired snooze', () => {
    const missed = classifyDueCycle(snoozed(snoozeDue), snoozeDue + RECOVERY_WINDOW_MS + 1, 'launch');
    assert.equal(getMissedCycles([definition([missed])]).length, 1);
  });
});

describe('editing, toggling and deleting do not leak the snooze notification', () => {
  test('cancels the exact snooze id before the occurrence is removed', async () => {
    const cancelled: string[] = [];
    const result = await cancelAlarmDefinitionWithCheckpoints({
      alarms: [definition([snoozed(DUE + 5 * MINUTE)])],
      alarmId: 'alarm-1',
      completion: 'delete',
      gateway: {
        async cancelScheduled(id) {
          if (id) cancelled.push(id);
        },
        async dismissDelivered() {},
      },
      async checkpoint() {},
    });
    assert.deepEqual(result, []);
    assert.ok(cancelled.includes('snooze-1'));
    assert.ok(cancelled.includes('main-1'));
  });

  test('also cancels a requested snooze id that was never confirmed', async () => {
    const cancelled: string[] = [];
    await cancelAlarmDefinitionWithCheckpoints({
      alarms: [
        definition([
          snoozed(DUE, {
            phase: 'ringing',
            snooze: { count: 0, pending: { requestedId: 'maybe', dueAtMs: DUE } },
          }),
        ]),
      ],
      alarmId: 'alarm-1',
      completion: 'disable',
      gateway: {
        async cancelScheduled(id) {
          if (id) cancelled.push(id);
        },
        async dismissDelivered() {},
      },
      async checkpoint() {},
    });
    assert.ok(cancelled.includes('maybe'));
  });

  test('a snooze that cannot be cancelled keeps the occurrence recorded and is not resurrected after a partial cancel', async () => {
    const checkpoints: StoredAlarmDefinition[][] = [];
    await assert.rejects(
      cancelAlarmDefinitionWithCheckpoints({
        alarms: [definition([snoozed(DUE + 5 * MINUTE)])],
        alarmId: 'alarm-1',
        completion: 'delete',
        gateway: {
          async cancelScheduled(id) {
            if (id === 'main-1') throw new Error('main cancel failed');
          },
          async dismissDelivered() {},
        },
        async checkpoint(alarms) {
          checkpoints.push(structuredClone(alarms));
        },
      }),
      /main cancel failed/,
    );
    const last = checkpoints.at(-1)?.[0].cycles[0];
    assert.ok(last, 'occurrence still recorded so the retry finds it');
    assert.notEqual(last.phase, 'snoozed', 'its snooze is already cancelled');
    assert.equal(last.snooze, undefined);
  });

  test('a snooze that fails to cancel leaves everything in place', async () => {
    const checkpoints: StoredAlarmDefinition[][] = [];
    await assert.rejects(
      cancelAlarmDefinitionWithCheckpoints({
        alarms: [definition([snoozed(DUE + 5 * MINUTE)])],
        alarmId: 'alarm-1',
        completion: 'delete',
        gateway: {
          async cancelScheduled(id) {
            if (id === 'snooze-1') throw new Error('snooze cancel failed');
          },
          async dismissDelivered() {},
        },
        async checkpoint(alarms) {
          checkpoints.push(structuredClone(alarms));
        },
      }),
      /snooze cancel failed/,
    );
    const last = checkpoints.at(-1)?.[0].cycles[0];
    assert.equal(last === undefined || last.phase === 'snoozed', true);
  });
});

describe('storage reset tracks snooze notifications', () => {
  test('cancels snooze ids read from stored occurrences even when the payload is unrecognisable', async () => {
    const data = new Map<string, string>([
      [
        ALARM_DEFINITIONS_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          alarms: [
            definition([
              snoozed(DUE + 5 * MINUTE, {
                snooze: {
                  count: 1,
                  notificationId: 'snooze-1',
                  dueAtMs: DUE + 5 * MINUTE,
                  pending: { requestedId: 'pending-1', dueAtMs: DUE + 10 * MINUTE },
                },
              }),
            ]),
          ],
        }),
      ],
    ]);
    const store = {
      async getItem(key: string) {
        return data.get(key) ?? null;
      },
      async setItem(key: string, value: string) {
        data.set(key, value);
      },
      async removeItem(key: string) {
        data.delete(key);
      },
    };
    const scheduled = ['snooze-1', 'pending-1', 'host-1'].map((identifier) => ({
      identifier,
      content: { title: 'x', categoryIdentifier: null, data: { kind: 'x' } },
    }));
    const cancelled: string[] = [];
    const reset = createStorageResetService({
      store,
      gateway: {
        async listPresented() {
          return [];
        },
        async dismissPresented() {},
        async listScheduled() {
          return [...scheduled];
        },
        async cancelScheduled(id) {
          cancelled.push(id);
          const index = scheduled.findIndex((item) => item.identifier === id);
          if (index >= 0) scheduled.splice(index, 1);
        },
      },
      exclusive: (run) => run(),
      nowMs: () => 1,
    });
    await reset.reset();
    assert.deepEqual(cancelled.sort(), ['pending-1', 'snooze-1']);
    assert.deepEqual(scheduled.map((item) => item.identifier), ['host-1']);
  });
});

describe('screen and refill behaviour during a scheduled snooze', () => {
  test('keeps the screen awake while a snooze is waiting', () => {
    const now = DUE + MINUTE;
    const alarm = definition([snoozed(DUE + 5 * MINUTE)]);
    assert.equal(shouldKeepScreenAwake([alarm], now), true);
    assert.equal(shouldKeepScreenAwake([{ ...alarm, enabled: false }], now), true);
  });

  test('a today-only alarm waiting on its snooze is not disabled by a refill', async () => {
    const now = DUE + MINUTE;
    const result = await fillAlarmDefinitionSchedule(
      definition([snoozed(DUE + 5 * MINUTE)], 'today'),
      now,
      {
        scheduleMain: async () => {
          throw new Error('must not schedule');
        },
        scheduleCheckIn: async () => {
          throw new Error('must not schedule');
        },
      },
    );
    assert.equal(result.definition.enabled, true);
    assert.equal(result.definition.cycles[0].phase, 'snoozed');
    assert.deepEqual(result.issues, []);
  });
});

describe('snooze notification payload', () => {
  const data = {
    owner: ALREADY_UP_OWNER,
    kind: 'main_alarm',
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    snooze: 2,
  };

  test('is a marked main alarm of the same occurrence and keeps its number', () => {
    assert.equal(parseAlarmNotificationData(data)?.snooze, 2);
    assert.equal(
      isOwnedAlarmNotification({
        identifier: 'snooze-1',
        content: { title: 't', categoryIdentifier: null, data },
      }),
      true,
    );
  });

  test('rejects a malformed snooze number', () => {
    assert.equal(parseAlarmNotificationData({ ...data, snooze: 'two' }), null);
  });
});

describe('snooze wording', () => {
  const at = (hour: number, minute: number) => new Date(2026, 9, 15, hour, minute).getTime();

  test('ringing card names the next time and how many are left', () => {
    const copy = getSnoozeCopy({ phase: 'ringing', used: 0, nextAtMs: at(7, 5) });
    assert.equal(copy.actionLabel, '5分後にもう一度鳴らす');
    assert.match(copy.detail, /7:05/);
    assert.match(copy.detail, /あと3回/);
    assert.equal(copy.actionDisabled, false);
  });

  test('says when the limit is reached and disables the action', () => {
    const copy = getSnoozeCopy({ phase: 'ringing', used: 3, nextAtMs: at(7, 5) });
    assert.equal(copy.actionDisabled, true);
    assert.match(copy.detail, /3回まで/);
  });

  test('waiting card names the time and the round', () => {
    const copy = getSnoozeCopy({ phase: 'snoozed', used: 2, nextAtMs: at(7, 10) });
    assert.match(copy.title, /スヌーズ中/);
    assert.match(copy.detail, /7:10/);
    assert.match(copy.detail, /2回目/);
  });

  test('avoids implementation words', () => {
    for (const phase of ['ringing', 'snoozed'] as const) {
      const copy = getSnoozeCopy({ phase, used: 1, nextAtMs: at(7, 5) });
      const all = Object.values(copy).join(' ');
      assert.doesNotMatch(all, /ID|通知予約|キュー|cycle|phase/i);
    }
    assert.match(getSnoozeCopy.failure('CAPACITY_FULL'), /鳴ったまま|鳴り続け/);
  });
});
