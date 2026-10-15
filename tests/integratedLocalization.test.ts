import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import type { AlarmScheduleIssue } from '../src/alarmScheduling';
import { describeScheduleIssues } from '../src/alarmScheduling';
import type { StoredAlarm } from '../src/alarmStorage';
import { ERROR_CODES, describeErrorCode } from '../src/errorCatalog';
import {
  classifySuppressionFailure,
  describeAlarmRemains,
  getAlarmRemainsCode,
  getStepGuidance,
} from '../src/homeStatus';
import { createTextContext, type LocaleSettings } from '../src/i18n';
import {
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from '../src/alarmOrchestrator';
import { summarizeReconciliation } from '../src/scheduleReconciliation';
import { getSnoozeCopy } from '../src/snoozeCopy';
import {
  presentSnoozeRejected,
  presentSnoozed,
  presentStopped,
} from '../src/snoozeOutcome';
import { stampStorageResult } from '../src/storageResetGate';
import { EN_TEXT, JA_TEXT, en, ja } from './support/text';

const CJK = /[぀-ヿ㐀-鿿]/;

const settings = (
  locale: 'ja' | 'en',
  hour12: boolean | null,
  timeZone: string,
): LocaleSettings => ({
  locale,
  intlTag: locale === 'ja' ? 'ja-JP' : 'en-US',
  hour12,
  timeZone,
});

// 2026-10-14 22:05 UTC: 07:05 on 10/15 in Tokyo, 15:05 on 10/14 in Los Angeles.
const INSTANT = Date.UTC(2026, 9, 14, 22, 5);
// 2026-10-14 15:05 UTC: just after midnight in Tokyo.
const JUST_AFTER_MIDNIGHT_TOKYO = Date.UTC(2026, 9, 14, 15, 5);

describe('snooze text follows the device language, clock setting and time zone', () => {
  test('12-hour English, 24-hour Japanese and another zone show the same instant correctly', () => {
    const input = { phase: 'ringing' as const, used: 0, nextAtMs: INSTANT };
    const tokyo12 = createTextContext(settings('en', true, 'Asia/Tokyo'));
    const tokyo24 = createTextContext(settings('ja', false, 'Asia/Tokyo'));
    const la12 = createTextContext(settings('en', true, 'America/Los_Angeles'));
    assert.match(getSnoozeCopy(input, tokyo12).detail, /7:05\s?AM/);
    assert.match(getSnoozeCopy(input, tokyo24).detail, /07:05/);
    assert.match(getSnoozeCopy(input, la12).detail, /3:05\s?PM/);
  });

  test('midnight reads 00:05 in a 24-hour display, never 24:05', () => {
    const ctx = createTextContext(settings('ja', false, 'Asia/Tokyo'));
    const detail = getSnoozeCopy(
      { phase: 'snoozed', used: 1, nextAtMs: JUST_AFTER_MIDNIGHT_TOKYO },
      ctx,
    ).detail;
    assert.match(detail, /00:05/);
    assert.doesNotMatch(detail, /24:05/);
  });

  test('English cards and actions contain no Japanese and keep the policy numbers', () => {
    for (const [phase, used] of [
      ['ringing', 0],
      ['ringing', 3],
      ['snoozed', 2],
    ] as const) {
      const copy = getSnoozeCopy({ phase, used, nextAtMs: INSTANT }, EN_TEXT);
      for (const value of [copy.title, copy.detail, copy.actionLabel, copy.actionHint]) {
        assert.doesNotMatch(value, CJK);
      }
    }
    const available = getSnoozeCopy({ phase: 'ringing', used: 0, nextAtMs: INSTANT }, EN_TEXT);
    assert.equal(available.actionLabel, 'Ring again in 5 minutes');
    assert.match(available.detail, /3 more snoozes/);
    const last = getSnoozeCopy({ phase: 'ringing', used: 2, nextAtMs: INSTANT }, EN_TEXT);
    assert.match(last.detail, /1 more snooze\b/);
    const spent = getSnoozeCopy({ phase: 'ringing', used: 3, nextAtMs: INSTANT }, EN_TEXT);
    assert.equal(spent.actionDisabled, true);
    assert.match(spent.detail, /up to 3 times/);
  });

  test('the notice after an accepted snooze names the time in the device clock and zone', async () => {
    const effects = {
      stopSound: () => undefined,
      apply: () => undefined,
      reload: async () => stampStorageResult([]),
    };
    const result = {
      status: 'snoozed' as const,
      cycle: { cycleId: 'c1' } as unknown as StoredAlarm,
      dueAtMs: INSTANT,
      alarms: stampStorageResult([]),
    };
    const outcomeEffects = { ...effects, refill: async () => undefined, isResetPending: () => false };
    const en12 = await presentSnoozed(
      result,
      outcomeEffects,
      createTextContext(settings('en', true, 'Asia/Tokyo')),
    );
    assert.match(en12.text, /^Snoozed\. It rings again at 7:05\s?AM\.$/);
    const ja24 = await presentSnoozed(
      result,
      outcomeEffects,
      createTextContext(settings('ja', false, 'Asia/Tokyo')),
    );
    assert.equal(ja24.text, 'スヌーズしました。07:05にもう一度鳴ります。');
    assert.equal(en12.code, undefined);
    assert.equal(en12.tone, ja24.tone);
  });
});

describe('stop and snooze outcomes keep their code and tone in every language', () => {
  const CYCLE = { cycleId: 'c1' } as unknown as StoredAlarm;
  const cases = [
    { name: 'clean', report: {}, refill: undefined },
    { name: 'cleanup unconfirmed', report: { cleanup: 'unconfirmed' as const }, refill: undefined },
    {
      name: 'memory only + refill failed',
      report: { cleanup: 'unconfirmed' as const, tracking: 'memory_only' as const },
      refill: new Error('boom'),
    },
    { name: 'refill blocked by a pending deletion', report: {}, refill: 'reset' },
  ];

  for (const c of cases) {
    test(`stop: ${c.name}`, async () => {
      const run = (text: typeof JA_TEXT) =>
        presentStopped(
          { cycle: CYCLE, alarms: stampStorageResult([]), ...c.report },
          {
            stopSound: () => undefined,
            apply: () => undefined,
            reload: async () => stampStorageResult([]),
            refill: async () => {
              if (c.refill !== undefined) throw c.refill;
            },
            isResetPending: (error: unknown) => error === 'reset',
          },
          text,
        );
      const inJa = await run(JA_TEXT);
      const inEn = await run(EN_TEXT);
      assert.equal(inEn.notice.code, inJa.notice.code);
      assert.equal(inEn.notice.tone, inJa.notice.tone);
      assert.equal(inEn.deletionPending, inJa.deletionPending);
      assert.doesNotMatch(inEn.notice.text, CJK);
      assert.notEqual(inEn.notice.text, inJa.notice.text);
      assert.match(inEn.notice.text, /^[A-Z]/);
    });
  }

  test('a warning is never replaced by the plain success sentence', async () => {
    const out = await presentStopped(
      {
        cycle: CYCLE,
        alarms: stampStorageResult([]),
        cleanup: 'unconfirmed',
        tracking: 'memory_only',
      },
      {
        stopSound: () => undefined,
        apply: () => undefined,
        reload: async () => stampStorageResult([]),
        refill: async () => undefined,
        isResetPending: () => false,
      },
      EN_TEXT,
    );
    assert.equal(out.notice.code, 'STOP_CLEANUP_MEMORY_ONLY');
    assert.notEqual(out.notice.text, en.ringing.stopped);
    assert.ok(out.notice.text.startsWith(en.errors.STOP_CLEANUP_MEMORY_ONLY.message));
  });

  test('a rejected snooze is worded from its own code, in the device language', async () => {
    const effects = {
      apply: () => undefined,
      reload: async () => stampStorageResult([]),
    };
    for (const text of [JA_TEXT, EN_TEXT]) {
      const notice = await presentSnoozeRejected(
        { status: 'rejected', reason: 'CAPACITY_FULL' },
        effects,
        text,
      );
      assert.equal(notice.code, 'SNOOZE_CAPACITY_FULL');
      assert.equal(notice.text.includes(text.messages.errors.SNOOZE_CAPACITY_FULL.message), true);
    }
  });
});

describe('notifications scheduled by the snooze use the device language', () => {
  test('the snooze notification text is in the catalog, not a fixed Japanese constant', () => {
    assert.match(ja.notifications.snoozeTitle, CJK);
    assert.doesNotMatch(en.notifications.snoozeTitle, CJK);
    assert.doesNotMatch(en.notifications.snoozeBody, CJK);
    const service = readFileSync(new URL('../src/notificationService.ts', import.meta.url), 'utf8');
    assert.match(service, /notificationMessages\.notifications\.snoozeTitle/);
    assert.match(service, /notificationMessages\.notifications\.snoozeBody/);
    const content = readFileSync(
      new URL('../src/alarmNotificationContent.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(content, /SNOOZE_NOTIFICATION_(TITLE|BODY)/);
  });
});

describe('diagnostic notices raised by the screens', () => {
  const main: AlarmScheduleIssue = {
    kind: 'main_schedule_failed',
    alarmId: 'a',
    cycleId: 'c',
    dueAtMs: 1,
    code: 'MAIN_UNVERIFIED',
  };
  const checkIn: AlarmScheduleIssue = {
    kind: 'check_in_schedule_failed',
    alarmId: 'a',
    cycleId: 'c',
    dueAtMs: 1,
    mainAlarmId: 'm',
    code: 'CHECKIN_REGISTER_FAILED',
  };

  test('a main failure wins over a check-in failure and never says the alarm is reserved', () => {
    const lead = en.scheduleIssue.addedLead;
    const notice = describeScheduleIssues([checkIn, main], lead, en);
    assert.equal(notice?.code, 'MAIN_UNVERIFIED');
    assert.equal(notice?.tone, 'danger');
    assert.ok(notice?.text.startsWith(lead + en.scheduleIssue.incomplete));
    assert.ok(notice?.text.includes(en.errors.MAIN_UNVERIFIED.message));
    assert.doesNotMatch(notice?.text ?? '', CJK);
    assert.equal(describeScheduleIssues([], lead, en), null);
  });

  test('a check-in-only failure keeps the main alarm and says so without the "incomplete" lead', () => {
    for (const messages of [ja, en]) {
      const notice = describeScheduleIssues([checkIn], '', messages);
      assert.equal(notice?.code, 'CHECKIN_REGISTER_FAILED');
      assert.equal(notice?.tone, 'warning');
      assert.equal(notice?.text.includes(messages.scheduleIssue.incomplete), false);
    }
  });

  test('step guidance keeps its code and settings link; only the sentence changes', () => {
    const states = [
      'unavailable',
      'availability_unknown',
      'denied',
      'permission_unknown',
      'error',
    ] as const;
    for (const state of states) {
      const inJa = getStepGuidance(state, ja);
      const inEn = getStepGuidance(state, en);
      assert.equal(inEn.code, inJa.code, state);
      assert.equal(inEn.canOpenSettings, inJa.canOpenSettings, state);
      assert.equal(inEn.showProgress, false);
      assert.doesNotMatch(inEn.message, CJK, state);
    }
    assert.equal(getStepGuidance('denied', en).canOpenSettings, true);
    assert.equal(getStepGuidance('counting', en).code, undefined);
  });

  test('a stop that left the alarm in place maps to one code and says so in English', () => {
    for (const reason of [
      'CANCEL_NOT_VERIFIED',
      'JOURNAL_NOT_WRITTEN',
      'SKIP_BEFORE_WINDOW',
      'WRONG_CYCLE',
      'ALARM_DUE_OR_PAST',
      'INVALID_STEP_SAMPLE',
      'NOT_EXPLICIT_CONFIRMATION',
      'SOMETHING_NEW',
    ]) {
      const inEn = describeAlarmRemains(reason, en);
      assert.equal(inEn.code, getAlarmRemainsCode(reason), reason);
      assert.equal(inEn.code, describeAlarmRemains(reason, ja).code, reason);
      assert.doesNotMatch(inEn.text, CJK, reason);
      // Like the Japanese rule (no "停止しました"): it must not claim a stop happened.
      assert.doesNotMatch(inEn.text, /^(The alarm (was|has been) stopped|Alarm stopped)/i, reason);
    }
  });

  test('a suppression save failure and an unknown cancel stay distinct warnings in English', () => {
    const saved = classifySuppressionFailure(new SuppressionSaveError('c', new Error('x')), en);
    const unknown = classifySuppressionFailure(
      new SuppressionCancelUnknownError('c', new Error('x')),
      en,
    );
    assert.equal(saved?.warning, 'save_failed');
    assert.equal(unknown?.warning, 'status_unknown');
    assert.equal(saved?.notice.code, 'SUPPRESSION_SAVE_FAILED');
    assert.equal(unknown?.notice.code, 'CANCEL_UNKNOWN');
    assert.notEqual(saved?.notice.text, unknown?.notice.text);
    assert.equal(classifySuppressionFailure(new Error('x'), en), null);
  });

  test('reconciliation notices keep their problem keys and tone while the text follows the language', () => {
    const base = { statuses: {}, repaired: 0, replanned: 0, zoneChanged: false };
    const inputs = [
      { ...base, unrecoveredNotificationIds: ['n1'] },
      { ...base, orphansUnreadable: true },
      { ...base, pendingOrphanIds: ['n1'] },
      { ...base, statuses: { a: 'capacity_full' as const } },
      { ...base, statuses: { a: 'missing' as const } },
      { ...base, statuses: { a: 'duplicated' as const } },
      { ...base, queueVerified: false },
    ];
    for (const input of inputs) {
      const inJa = summarizeReconciliation(input, ja);
      const inEn = summarizeReconciliation(input, en);
      assert.deepEqual(inEn.problemKeys, inJa.problemKeys);
      assert.equal(inEn.notice?.tone, inJa.notice?.tone);
      assert.ok(inEn.notice, JSON.stringify(input));
      assert.doesNotMatch(inEn.notice.text, CJK);
    }
    const capacity = summarizeReconciliation(inputs[3], en);
    assert.match(capacity.notice?.text ?? '', /\(64\)/);
  });
});

describe('the whole catalog stays complete as codes are added', () => {
  test('no code is left with the same text in both languages or an empty sentence', () => {
    for (const code of ERROR_CODES) {
      assert.ok(en.errors[code].message.length > 10, code);
      assert.notEqual(en.errors[code].message, describeErrorCode(code).message, code);
    }
  });
});
