/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeAlarmAdded,
  describeScheduleIssues,
  describeScheduleIssuesLocalized,
  type AlarmScheduleIssue,
} from '../src/alarmScheduling';
import { getMainAlarmNotificationBody } from '../src/alarmNotificationContent';
import { noticeFromCodeIn, noticeFromCodesIn } from '../src/i18n/errorText';
import { localizedNotice, relocalizeNotice } from '../src/i18n/localizedNotice';
import { EN_TEXT, JA_TEXT, en, ja } from './support/text';
import { OWNER, blockIn, read } from './support/source';

test('a catalog notice is rendered again in the new language with the same code and tone', () => {
  const before = noticeFromCodeIn(en, 'STOP_RINGING_FAILED');

  const after = relocalizeNotice(before, JA_TEXT);

  assert.deepEqual(after, noticeFromCodeIn(ja, 'STOP_RINGING_FAILED'));
  assert.equal(after?.code, before.code);
  assert.equal(after?.tone, before.tone);
  assert.notEqual(after?.text, before.text);
});

test('a notice that joins several failures keeps every message after a locale change', () => {
  const codes = ['STOP_RINGING_FAILED', 'STOP_FOLLOWUP_FAILED'] as const;
  const before = noticeFromCodesIn(en, codes);

  const after = relocalizeNotice(before, JA_TEXT);

  assert.deepEqual(after, noticeFromCodesIn(ja, codes));
  assert.equal(after?.tone, before.tone);
  for (const code of codes) {
    assert.ok(after?.text.includes(ja.errors[code].message), code);
  }
});

test('a scheduling warning keeps its lead, code and tone in the new language', () => {
  const issues: AlarmScheduleIssue[] = [
    {
      kind: 'check_in_schedule_failed',
      alarmId: 'a',
      cycleId: 'c',
      dueAtMs: 1,
      mainAlarmId: 'm',
      code: 'CHECKIN_PARTIAL',
    },
  ];
  const before = describeScheduleIssuesLocalized(
    issues,
    (t) => t.messages.scheduleIssue.changedLead('7:00'),
    EN_TEXT,
  );

  const after = relocalizeNotice(before, JA_TEXT);

  assert.deepEqual(
    after,
    describeScheduleIssues(issues, ja.scheduleIssue.changedLead('7:00'), ja),
  );
  assert.equal(after?.tone, before?.tone);
});

test('a hand-built safety notice is rendered again, not dropped', () => {
  const build = (t: typeof EN_TEXT) => ({
    tone: 'danger' as const,
    text: t.messages.settings.ambiguousWarning,
  });

  const after = relocalizeNotice(localizedNotice(build, EN_TEXT), JA_TEXT);

  assert.deepEqual(after, build(JA_TEXT));
});

test('transient success and neutral notices are cleared on a locale change', () => {
  assert.equal(relocalizeNotice({ tone: 'success', text: 'Added.' }, JA_TEXT), null);
  assert.equal(relocalizeNotice({ tone: 'neutral', text: 'Deleted.' }, JA_TEXT), null);
  assert.equal(relocalizeNotice(null, JA_TEXT), null);
});

test('a warning that cannot be rendered again is kept, never silently lost', () => {
  const warning = { tone: 'warning' as const, text: 'Check the alarm.' };
  const danger = { tone: 'danger' as const, text: 'Not scheduled.' };

  assert.equal(relocalizeNotice(warning, JA_TEXT), warning);
  assert.equal(relocalizeNotice(danger, JA_TEXT), danger);
});

test('the added-alarm notice uses the text it is given at completion', () => {
  const input = { issues: [], hour: 7, minute: 30, nextAtMs: Date.UTC(2030, 0, 2, 7, 30) };

  const english = describeAlarmAdded(input, EN_TEXT);
  const japanese = describeAlarmAdded(input, JA_TEXT);

  assert.equal(english.tone, 'success');
  assert.notEqual(english.text, japanese.text);
  assert.match(japanese.text, /[぀-ヿ一-龯]/);
  assert.doesNotMatch(english.text, /[぀-ヿ一-龯]/);
});

test('addAlarm reads the latest text at completion instead of a stale closure', () => {
  const body = blockIn(OWNER.mutations, 'const addAlarm = useCallback', 'const performToggleAlarm = useCallback');

  assert.doesNotMatch(body, /(?<![\w.])messages\./);
  assert.doesNotMatch(body, /(?<![\w.])formatter\./);
  assert.match(body, /describeAlarmAdded\(/);
  assert.match(body, /textRef\.current/);
});

test('the device text owner re-renders stateful notices when the locale changes', () => {
  const deviceText = read(OWNER.deviceText);
  assert.match(deviceText, /setNotice\(\(previous\) => relocalizeNotice\(previous, nextText\)\)/);
  assert.match(read(OWNER.controller), /useDeviceText\(setNotice\)/);
});

test('the settings notice is a descriptor written in the current language when drawn', () => {
  const deletion = read(OWNER.deletion);
  assert.match(deletion, /useState<SettingsNotice \| null>\(null\)/);
  assert.match(deletion, /setSettingsNotice\(blockedDeletionNotice\(deletionState\)\)/);
  assert.doesNotMatch(deletion, /useState<string \| null>/);
  assert.match(read(OWNER.settingsSheet), /settingsNotice\.text\(messages\)/);
});

test('manual warnings are written through localizedNotice from the latest text', () => {
  const owners: Array<[string, RegExp[]]> = [
    [OWNER.lifecycle, [/settings\.ambiguousWarning/]],
    [OWNER.notificationEvents, [/ringing\.persistFailed/]],
    [OWNER.stepCandidate, [/CANCEL_NOT_VERIFIED/, /stepsCancelUnconfirmed/]],
    [OWNER.suppression, [/skip\.stoppedRefillFailed/, /skip\.failed/]],
    [OWNER.bedside, [/keepAwakeFailure/]],
    [OWNER.mutations, [/snoozedLockedNotice/]],
    [OWNER.deletion, [/settings\.failedHome/, /settings\.ambiguousWarning/, /resetAmbiguous/]],
  ];
  for (const [owner, patterns] of owners) {
    const source = read(owner);
    assert.match(source, /localizedNotice\(/, owner);
    for (const pattern of patterns) {
      assert.match(source, pattern, `${owner} ${pattern}`);
    }
    assert.doesNotMatch(source, /setNotice\(\{\s*tone: '(?:warning|danger)'/, owner);
  }
  const bedside = read(OWNER.bedside);
  assert.match(bedside, /keepAwakeDeliveryRef/);
  assert.doesNotMatch(bedside, /keepAwakeFailureTextRef/);
});

test('schedule issue notices are localized in the schedule, mutation and refill owners', () => {
  assert.match(read(OWNER.schedule), /describeScheduleIssuesLocalized\(/);
  const mutations = read(OWNER.mutations);
  assert.equal(mutations.match(/describeScheduleIssuesLocalized\(/g)?.length, 2);
  assert.match(read(OWNER.refill), /rememberRebuild\(/);
});

test('an English repeating-alarm notification separates its two sentences', () => {
  const body = getMainAlarmNotificationBody({ repeats: true }, en);

  assert.equal(
    body,
    'Your wake-up was not confirmed, so the alarm is ringing. ' + en.notifications.keepReservingHint,
  );
  assert.doesNotMatch(body, /\.[A-Z]/);
});

test('the Japanese repeating-alarm notification keeps no extra space', () => {
  assert.equal(
    getMainAlarmNotificationBody({ repeats: true }, ja),
    ja.notifications.mainBody + ja.notifications.keepReservingHint,
  );
});

test('a refill notice that arrives after a locale change is rebuilt against the latest text', () => {
  const body = blockIn(OWNER.schedule, 'const refillEnabledSchedules = useCallback', 'const reconcileWithQueue = useCallback');

  assert.match(body, /relocalizeNotice\(result\.notice, textRef\.current\)/);
  assert.doesNotMatch(body, /setNotice\(result\.notice\)/);
});
