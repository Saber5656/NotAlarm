/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  type AlarmSchedulingGateway,
  processAwakeResponseFailSafe,
  scheduleAlarmNotificationsFailSafe,
  type SuppressionIntent,
  type SuppressionJournal,
} from '../src/alarmOrchestrator';
import { makeAlarmRepeat, getNextAlarmTime } from '../src/alarmSchedule';
import {
  describeScheduleIssues,
  fillAlarmDefinitionSchedule,
  getAlarmScheduleIssueSeverity,
} from '../src/alarmScheduling';
import * as storage from '../src/alarmStorage';
import { CONFIRM_AWAKE_ACTION, CHECK_IN_KIND } from '../src/alarmContracts';
import { errorCodeOf, describeErrorCode } from '../src/errorCatalog';
import {
  classifySuppressionFailure,
  describeAlarmRemains,
  getAlarmRemainsCode,
  getStepGuidance,
} from '../src/homeStatus';
import { withMainVerification } from '../src/mainAlarmVerification';
import { ensureNotificationPermission } from '../src/notificationPermission';
import { resolvePedometerAccess } from '../src/pedometerAccess';
import { prepareAlarmEnable } from '../src/alarmDefinitionMutations';
import { ja } from '../src/i18n';

const SECRET = 'EACCES /var/mobile/Containers/abc token=sk-live-123';

// Same in-memory localStorage the storage guard tests use.
const data = new Map<string, string>();
const faults = { getItem: false, setItem: false };
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (key: string) => {
        if (faults.getItem) {
          throw new Error(SECRET);
        }
        return data.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (faults.setItem) {
          throw new Error(SECRET);
        }
        data.set(key, value);
      },
      removeItem: (key: string) => void data.delete(key),
    },
  },
});

function resetStorage(): void {
  data.clear();
  faults.getItem = false;
  faults.setItem = false;
}

const NOW = new Date(2026, 7, 20, 6, 0, 0).getTime();
const definition = {
  id: 'alarm-1',
  hour: 7,
  minute: 0,
  repeat: makeAlarmRepeat('daily', NOW),
  enabled: true,
  createdAtMs: NOW,
  cycles: [],
};

// --- Notification permission -------------------------------------------

test('a denied prompt and an unreadable permission are different codes', async () => {
  await assert.rejects(
    ensureNotificationPermission({
      getPermission: async () => ({ status: 'denied' }),
      requestPermission: async () => ({ status: 'denied' }),
    }),
    (error) => errorCodeOf(error) === 'NTF_PERMISSION_DENIED',
  );
  await assert.rejects(
    ensureNotificationPermission({
      getPermission: async () => {
        throw new Error(SECRET);
      },
      requestPermission: async () => ({ status: 'granted' }),
    }),
    (error) =>
      errorCodeOf(error) === 'NTF_PERMISSION_CHECK_FAILED' &&
      !(error as Error).message.includes('token='),
  );
});

test('permission is only asked once and a grant needs no prompt', async () => {
  let prompts = 0;
  await ensureNotificationPermission({
    getPermission: async () => ({ status: 'granted' }),
    requestPermission: async () => {
      prompts += 1;
      return { status: 'granted' };
    },
  });
  assert.equal(prompts, 0);

  await ensureNotificationPermission({
    getPermission: async () => ({ status: 'undetermined' }),
    requestPermission: async () => {
      prompts += 1;
      return { status: 'granted' };
    },
  });
  assert.equal(prompts, 1);
});

// --- Main registration / verification ----------------------------------

function gatewayWith(overrides: Partial<AlarmSchedulingGateway>) {
  return {
    scheduleMain: async ({ cycleId }: { cycleId: string }) => `main-${cycleId}`,
    scheduleCheckIn: async ({ cycleId }: { cycleId: string }) => `check-${cycleId}`,
    ...overrides,
  } as AlarmSchedulingGateway;
}

test('a main alarm the OS does not list is MAIN_UNVERIFIED and is not recorded', async () => {
  const gateway = withMainVerification(gatewayWith({}), async () => new Set());
  const result = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');

  assert.equal(result.scheduledCycles.length, 0);
  assert.equal(result.definition.cycles.length, 0);
  assert.deepEqual(
    result.issues.map((issue) => [issue.kind, issue.code]),
    [['main_schedule_failed', 'MAIN_UNVERIFIED_MEMORY_ONLY']],
  );
  assert.equal(getAlarmScheduleIssueSeverity(result.issues), 'danger');
});

test('an unreadable schedule list is also MAIN_UNVERIFIED, never a success', async () => {
  const gateway = withMainVerification(gatewayWith({}), async () => {
    throw new Error(SECRET);
  });
  const result = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');

  assert.equal(result.scheduledCycles.length, 0);
  // No journal and no cancel were provided: the id is held in memory only.
  assert.equal(result.issues[0]?.code, 'MAIN_UNVERIFIED_MEMORY_ONLY');
  const notice = describeScheduleIssues(result.issues, 'アラームは追加しました。', ja);
  assert.equal(notice?.tone, 'danger');
  assert.equal(notice?.code, 'MAIN_UNVERIFIED_MEMORY_ONLY');
  assert.match(notice?.text ?? '', /確認できず/);
  assert.ok(!(notice?.text ?? '').includes('token='));
});

test('a main registration failure is MAIN_REGISTER_FAILED and its message is dropped', async () => {
  const gateway = withMainVerification(
    gatewayWith({
      scheduleMain: async () => {
        throw new Error(SECRET);
      },
    }),
    async () => new Set(),
  );
  const result = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');

  assert.equal(result.issues[0]?.code, 'MAIN_REGISTER_FAILED');
  assert.ok(!JSON.stringify(result).includes('token='));
});

test('a verified main alarm is recorded with no issue', async () => {
  const listed = new Set<string>();
  const gateway = withMainVerification(
    gatewayWith({
      scheduleMain: async ({ cycleId }) => {
        listed.add(`main-${cycleId}`);
        return `main-${cycleId}`;
      },
    }),
    async () => listed,
  );
  let n = 0;
  const result = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => `c${++n}`);

  assert.equal(result.issues.length, 0);
  assert.ok(result.scheduledCycles.length > 0);
  assert.equal(describeScheduleIssues(result.issues, '', ja), null);
});

// --- Check-in only failure ---------------------------------------------

test('a check-in-only failure keeps the main alarm and warns with its own code', async () => {
  const gateway = withMainVerification(
    gatewayWith({
      scheduleCheckIn: async () => {
        throw new Error(SECRET);
      },
    }),
    async () => new Set(['main-c1']),
  );
  const result = await fillAlarmDefinitionSchedule(definition, NOW, gateway, () => 'c1');

  assert.equal(result.definition.cycles[0]?.mainAlarmId, 'main-c1');
  assert.equal(result.definition.cycles[0]?.checkInNotificationId, undefined);
  assert.equal(result.issues[0]?.kind, 'check_in_schedule_failed');
  assert.equal(result.issues[0]?.code, 'CHECKIN_REGISTER_FAILED');
  assert.ok(!JSON.stringify(result.issues).includes('token='));

  const notice = describeScheduleIssues(result.issues, 'アラームは追加しました。', ja);
  assert.equal(notice?.tone, 'warning');
  assert.match(notice?.text ?? '', /メインのアラームは予約済み/);
});

test('when main and check-in both have issues the main failure leads', () => {
  const notice = describeScheduleIssues(
    [
      {
        kind: 'check_in_schedule_failed',
        alarmId: 'a',
        cycleId: 'c1',
        dueAtMs: 1,
        mainAlarmId: 'm',
        code: 'CHECKIN_REGISTER_FAILED',
      },
      {
        kind: 'main_schedule_failed',
        alarmId: 'a',
        cycleId: 'c2',
        dueAtMs: 2,
        code: 'MAIN_UNVERIFIED',
      },
    ],
    '',
    ja,
  );
  assert.equal(notice?.code, 'MAIN_UNVERIFIED');
  assert.match(notice?.text ?? '', /予約が完了していない回があります/);
});

test('check-in failure does not hide the main id from the caller', async () => {
  const result = await scheduleAlarmNotificationsFailSafe(
    gatewayWith({
      scheduleCheckIn: async () => {
        throw new Error(SECRET);
      },
    }),
    { alarmId: 'a', cycleId: 'c', dueAtMs: 100_000, checkInAtMs: 40_000, repeats: true },
  );
  assert.equal(result.mainAlarmId, 'main-c');
  assert.equal(result.checkInErrorCode, 'CHECKIN_REGISTER_FAILED');
});

// --- Sensor -------------------------------------------------------------

test('each sensor failure maps to a distinct state and code', async () => {
  const ok = async () => ({ status: 'granted' });
  assert.equal(
    await resolvePedometerAccess({ isAvailable: async () => true, requestPermission: ok }),
    'ready',
  );
  assert.equal(
    await resolvePedometerAccess({ isAvailable: async () => false, requestPermission: ok }),
    'unavailable',
  );
  assert.equal(
    await resolvePedometerAccess({
      isAvailable: async () => {
        throw new Error(SECRET);
      },
      requestPermission: ok,
    }),
    'availability_unknown',
  );
  assert.equal(
    await resolvePedometerAccess({
      isAvailable: async () => true,
      requestPermission: async () => ({ status: 'denied' }),
    }),
    'denied',
  );
  assert.equal(
    await resolvePedometerAccess({
      isAvailable: async () => true,
      requestPermission: async () => {
        throw new Error(SECRET);
      },
    }),
    'permission_unknown',
  );

  const codes = (
    ['unavailable', 'availability_unknown', 'denied', 'permission_unknown', 'error'] as const
  ).map((state) => getStepGuidance(state, ja).code);
  assert.deepEqual(codes, [
    'SENSOR_UNAVAILABLE',
    'SENSOR_AVAILABILITY_UNKNOWN',
    'SENSOR_PERMISSION_DENIED',
    'SENSOR_PERMISSION_UNKNOWN',
    'SENSOR_READ_FAILED',
  ]);
  assert.equal(new Set(codes).size, 5);
  assert.equal(getStepGuidance('counting', ja).code, undefined);
  assert.equal(getStepGuidance('denied', ja).canOpenSettings, true);
  assert.equal(getStepGuidance('permission_unknown', ja).canOpenSettings, false);
});

// --- Storage ------------------------------------------------------------

test('storage reads separate corruption from an unreadable store', async () => {
  resetStorage();
  data.set(storage.ALARM_DEFINITIONS_STORAGE_KEY, '{not json');
  await assert.rejects(
    storage.loadAlarmDefinitions(),
    (error) => errorCodeOf(error) === 'STORAGE_CORRUPT',
  );

  data.set(storage.ALARM_DEFINITIONS_STORAGE_KEY, JSON.stringify({ version: 2, alarms: 'x' }));
  await assert.rejects(
    storage.loadAlarmDefinitions(),
    (error) => errorCodeOf(error) === 'STORAGE_CORRUPT',
  );

  faults.getItem = true;
  await assert.rejects(
    storage.loadAlarmDefinitions(),
    (error) =>
      errorCodeOf(error) === 'STORAGE_READ_FAILED' &&
      !(error as Error).message.includes('token='),
  );
  resetStorage();
});

test('a failed write is STORAGE_SAVE_FAILED and the old data is untouched', async () => {
  resetStorage();
  await storage.saveAlarmDefinitions([definition]);
  const before = data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY);

  faults.setItem = true;
  await assert.rejects(
    storage.saveAlarmDefinitions([{ ...definition, hour: 9 }]),
    (error) =>
      errorCodeOf(error) === 'STORAGE_SAVE_FAILED' &&
      !(error as Error).message.includes('/var/'),
  );
  faults.setItem = false;
  assert.equal(data.get(storage.ALARM_DEFINITIONS_STORAGE_KEY), before);
  assert.equal(AsyncStorage !== undefined, true);
  resetStorage();
});

test('a corrupt cancellation journal is its own code', async () => {
  resetStorage();
  data.set(storage.ALARM_CANCELLATION_JOURNAL_KEY, 'garbage');
  await assert.rejects(
    storage.loadPendingAlarmCancellations(),
    (error) => errorCodeOf(error) === 'STORAGE_JOURNAL_CORRUPT',
  );
  resetStorage();
});

// --- Invalid action / deadline -----------------------------------------

test('invalid clock, repeat and enable inputs have typed codes', () => {
  assert.throws(
    () => getNextAlarmTime(NOW, 25, 0, makeAlarmRepeat('daily', NOW)),
    (error) => errorCodeOf(error) === 'TIME_INVALID',
  );
  assert.throws(
    () => makeAlarmRepeat('custom', NOW, []),
    (error) => errorCodeOf(error) === 'REPEAT_INVALID',
  );
  const expired = prepareAlarmEnable(
    {
      ...definition,
      enabled: false,
      repeat: makeAlarmRepeat('today', NOW - 86_400_000),
    },
    NOW,
  );
  assert.equal(expired.ok, false);
  assert.equal(!expired.ok && expired.code, 'ALARM_TODAY_ENDED');
});

test('stop-attempt reasons map to action, deadline and cancel codes', () => {
  assert.equal(getAlarmRemainsCode('INVALID_RESPONSE'), 'ACTION_INVALID');
  assert.equal(getAlarmRemainsCode('NOT_EXPLICIT_CONFIRMATION'), 'ACTION_INVALID');
  assert.equal(getAlarmRemainsCode('WRONG_CYCLE'), 'WRONG_OCCURRENCE');
  assert.equal(getAlarmRemainsCode('SKIP_BEFORE_WINDOW'), 'SKIP_BEFORE_WINDOW');
  assert.equal(getAlarmRemainsCode('NO_ACTIVE_ALARM'), 'ACTION_STALE');
  assert.equal(getAlarmRemainsCode('ALARM_DUE_OR_PAST'), 'DEADLINE_PASSED');
  assert.equal(getAlarmRemainsCode('CONFIRMATION_AT_OR_AFTER_DUE'), 'DEADLINE_PASSED');
  assert.equal(getAlarmRemainsCode('CANCEL_NOT_VERIFIED'), 'CANCEL_NOT_VERIFIED');
  assert.equal(getAlarmRemainsCode('JOURNAL_NOT_WRITTEN'), 'SUPPRESSION_JOURNAL_NOT_WRITTEN');
  // Every alarm-remains outcome says the alarm is kept, never that it stopped.
  for (const reason of ['INVALID_RESPONSE', 'WRONG_CYCLE', 'ALARM_DUE_OR_PAST']) {
    assert.doesNotMatch(describeAlarmRemains(reason, ja).text, /停止しました/);
  }
});

// --- Cancellation unknown / save failure through the real orchestrator --

function memoryJournal(): SuppressionJournal & { entries: SuppressionIntent[] } {
  const entries: SuppressionIntent[] = [];
  return {
    entries,
    async record(intent) {
      const at = entries.findIndex((entry) => entry.cycleId === intent.cycleId);
      if (at >= 0) {
        entries[at] = intent;
      } else {
        entries.push(intent);
      }
    },
    async load() {
      return [...entries];
    },
    async clear(cycleId) {
      const at = entries.findIndex((entry) => entry.cycleId === cycleId);
      if (at >= 0) {
        entries.splice(at, 1);
      }
    },
    exclusive: (run) => run(),
  };
}

const ACTIVE = {
  alarmId: 'alarm-1',
  cycleId: 'cycle-1',
  mainAlarmId: 'main-1',
  checkInNotificationId: 'check-1',
  armedAtMs: 1_000,
  dueAtMs: 10_000_000,
  phase: 'armed' as const,
  stepCount: 0,
  stepCandidateRecorded: false,
};
const RESPONSE = {
  actionIdentifier: CONFIRM_AWAKE_ACTION,
  kind: CHECK_IN_KIND,
  cycleId: 'cycle-1',
  mainAlarmId: 'main-1',
  checkInNotificationId: 'check-1',
  confirmedAtMs: 9_950_000,
};

test('a cancel call that throws is CANCEL_UNKNOWN, keeps the journal and is not retried', async () => {
  const journal = memoryJournal();
  let cancelCalls = 0;
  const outcome = await processAwakeResponseFailSafe(
    {
      loadAlarm: async () => ACTIVE,
      saveAlarm: async () => assert.fail('must not save a stop that is unknown'),
      cancelScheduled: async () => {
        cancelCalls += 1;
        throw new Error(SECRET);
      },
      nowMs: () => 9_950_000,
      journal,
    },
    RESPONSE,
  ).catch((error: unknown) => error);

  const failure = classifySuppressionFailure(outcome, ja);
  assert.equal(failure?.warning, 'status_unknown');
  assert.equal(failure?.notice.code, 'CANCEL_UNKNOWN');
  assert.equal(failure?.notice.tone, 'danger');
  assert.ok(!failure?.notice.text.includes('token='));
  assert.equal(cancelCalls, 1);
  assert.equal(journal.entries[0]?.stage, 'cancelling');
});

test('a save that keeps failing after a confirmed cancel is SUPPRESSION_SAVE_FAILED', async () => {
  const journal = memoryJournal();
  let saves = 0;
  const outcome = await processAwakeResponseFailSafe(
    {
      loadAlarm: async () => ACTIVE,
      saveAlarm: async () => {
        saves += 1;
        throw new Error(SECRET);
      },
      cancelScheduled: async () => true,
      nowMs: () => 9_950_000,
      journal,
    },
    RESPONSE,
  ).catch((error: unknown) => error);

  const failure = classifySuppressionFailure(outcome, ja);
  assert.equal(failure?.warning, 'save_failed');
  assert.equal(failure?.notice.code, 'SUPPRESSION_SAVE_FAILED');
  // The existing bounded retry (2 tries) is all there is; the record remains.
  assert.equal(saves, 2);
  assert.equal(journal.entries[0]?.stage, 'cancelled');
  assert.equal(describeErrorCode('SUPPRESSION_SAVE_FAILED').retry, 'next_launch');
});

test('an unwritable journal keeps the alarm and reports JOURNAL_NOT_WRITTEN', async () => {
  const journal = memoryJournal();
  journal.record = async () => {
    throw new Error(SECRET);
  };
  let cancelled = false;
  const result = await processAwakeResponseFailSafe(
    {
      loadAlarm: async () => ACTIVE,
      saveAlarm: async () => undefined,
      cancelScheduled: async () => {
        cancelled = true;
        return true;
      },
      nowMs: () => 9_950_000,
      journal,
    },
    RESPONSE,
  );

  assert.equal(cancelled, false);
  assert.equal(result.status, 'alarm_remains');
  const notice = describeAlarmRemains(result.status === 'alarm_remains' ? result.reason : '', ja);
  assert.equal(notice.code, 'SUPPRESSION_JOURNAL_NOT_WRITTEN');
});

test('a confirmation after the deadline keeps the alarm with DEADLINE_PASSED', async () => {
  const result = await processAwakeResponseFailSafe(
    {
      loadAlarm: async () => ACTIVE,
      saveAlarm: async () => undefined,
      cancelScheduled: async () => assert.fail('must not cancel after the deadline'),
      nowMs: () => ACTIVE.dueAtMs + 1,
    },
    { ...RESPONSE, confirmedAtMs: 9_950_000 },
  );
  assert.equal(result.status, 'alarm_remains');
  assert.equal(
    describeAlarmRemains(result.status === 'alarm_remains' ? result.reason : '', ja).code,
    'DEADLINE_PASSED',
  );
});
