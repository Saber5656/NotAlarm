/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

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
  const start = app.indexOf('const addAlarm = useCallback');
  const end = app.indexOf('const performToggleAlarm = useCallback');
  assert.ok(start >= 0 && end > start);
  const body = app.slice(start, end);

  assert.doesNotMatch(body, /(?<![\w.])messages\./);
  assert.doesNotMatch(body, /(?<![\w.])formatter\./);
  assert.match(body, /textRef\.current/);
});

test('the foreground locale refresh re-renders stateful notices and the settings notice', () => {
  assert.match(app, /setNotice\(\(previous\) => relocalizeNotice\(previous, nextText\)\)/);
  assert.match(app, /useState<SettingsNotice \| null>\(null\)/);
  assert.doesNotMatch(app, /useState<string \| null>\(null\);\s*const \[pedometerState/);
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
  const start = app.indexOf('const refillEnabledSchedules = useCallback');
  const end = app.indexOf('const openNotificationSettings');
  assert.ok(start >= 0 && end > start);
  const body = app.slice(start, end);

  assert.match(body, /relocalizeNotice\(result\.notice, textRef\.current\)/);
  assert.doesNotMatch(body, /setNotice\(result\.notice\)/);
});
