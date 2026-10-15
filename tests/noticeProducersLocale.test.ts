import assert from 'node:assert/strict';
import test from 'node:test';

import type { StoredAlarm } from '../src/alarmStorage';
import { describeScheduleIssuesLocalized } from '../src/alarmScheduling';
import { getMissedAcknowledgementNotice } from '../src/missedAcknowledgement';
import { summarizeReconciliation } from '../src/scheduleReconciliation';
import { presentStopped, presentSnoozed } from '../src/snoozeOutcome';
import { stampStorageResult } from '../src/storageResetGate';
import { relocalizeNotice } from '../src/i18n/localizedNotice';
import { EN_TEXT, JA_TEXT, en, ja } from './support/text';

test('missed acknowledgement refill failure follows repeated locale changes', () => {
  const result = { status: 'refill_failed' } as const;
  const before = getMissedAcknowledgementNotice(result, [], en);
  const after = relocalizeNotice(before, JA_TEXT);
  assert.deepEqual(after, getMissedAcknowledgementNotice(result, [], ja));
  assert.notEqual(after?.text, before?.text);
  assert.deepEqual(relocalizeNotice(after, EN_TEXT), before);
});

test('the actual queue reconciliation summary keeps its danger after relocalizing', () => {
  const input = {
    statuses: { a: 'missing' as const, b: 'check_in_missing' as const },
    repaired: 0, replanned: 0, zoneChanged: false,
  };
  const before = summarizeReconciliation(input, en);
  const expected = summarizeReconciliation(input, ja);
  const after = relocalizeNotice(before.notice, JA_TEXT);
  assert.equal(before.notice?.tone, 'danger');
  assert.deepEqual(after, expected.notice);
  assert.notEqual(after?.text, before.notice?.text);
  assert.deepEqual(before.problemKeys, expected.problemKeys);
});

test('a main reservation failure retains the incomplete prefix and diagnostic code', () => {
  const input = [{ kind: 'main_schedule_failed' as const, alarmId: 'a', cycleId: 'c', dueAtMs: 1, code: 'MAIN_UNVERIFIED' as const }];
  const before = describeScheduleIssuesLocalized(input, t => t.messages.scheduleIssue.addedLead, EN_TEXT);
  const after = relocalizeNotice(before, JA_TEXT);
  assert.equal(after?.tone, 'danger');
  assert.equal(after?.code, 'MAIN_UNVERIFIED');
  assert.ok(after?.text.startsWith(ja.scheduleIssue.addedLead + ja.scheduleIssue.incomplete));
  assert.ok(after?.text.includes(ja.errors.MAIN_UNVERIFIED.message));
});

const cycle: StoredAlarm = {
  alarmId: 'a', cycleId: 'c', mainAlarmId: 'main-c', armedAtMs: 0,
  dueAtMs: 1, phase: 'ringing', stepCount: 0, stepCandidateRecorded: false,
};
const effects = {
  stopSound: () => undefined,
  apply: () => undefined,
  reload: async () => stampStorageResult([]),
  refill: async () => { throw new Error('refill failed'); },
  isResetPending: () => false,
};

test('a stopped outcome keeps both cleanup and refill warnings in the new language', async () => {
  const outcome = await presentStopped({ cycle, alarms: stampStorageResult([]), cleanup: 'unconfirmed', tracking: 'memory_only' }, effects, EN_TEXT);
  const after = relocalizeNotice(outcome.notice, JA_TEXT);
  assert.equal(after?.code, outcome.notice.code);
  assert.equal(after?.tone, outcome.notice.tone);
  assert.ok(after?.text.includes(ja.errors.STOP_FOLLOWUP_FAILED.message));
  assert.ok(after?.text.includes(ja.errors.STOP_CLEANUP_MEMORY_ONLY.message));
  assert.notEqual(after?.text, outcome.notice.text);
});

test('an accepted snooze keeps its memory-only cleanup warning after relocalizing', async () => {
  const outcome = await presentSnoozed({ status: 'snoozed', cycle, dueAtMs: 300001, alarms: stampStorageResult([]), cleanup: 'unconfirmed', tracking: 'memory_only' }, effects, EN_TEXT);
  const after = relocalizeNotice(outcome, JA_TEXT);
  assert.equal(after?.code, 'SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY');
  assert.equal(after?.tone, outcome.tone);
  assert.ok(after?.text.includes(ja.errors.SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY.message));
  assert.notEqual(after?.text, outcome.text);
});
