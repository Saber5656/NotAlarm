import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppError,
  ERROR_CODES,
  isErrorCode,
  describeError,
  describeErrorCode,
  errorCodeOf,
  noticeFromCode,
} from '../src/errorCatalog';

const SECRET = 'EACCES /var/mobile/Containers/Data/abc token=sk-live-123';

test('every code is unique, stable-shaped and has factual copy', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  const keys = new Set<string>();
  for (const code of ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/);
    const descriptor = describeErrorCode(code);
    assert.equal(descriptor.code, code);
    assert.ok(descriptor.message.length > 0, code);
    assert.ok(descriptor.recovery.length > 0, code);
    // Structured keys let Issue22 translate without touching call sites.
    assert.equal(descriptor.messageKey, `errors.${code}.message`);
    assert.equal(descriptor.recoveryKey, `errors.${code}.recovery`);
    assert.ok(!keys.has(descriptor.messageKey));
    keys.add(descriptor.messageKey);
    assert.doesNotMatch(
      descriptor.message + descriptor.recovery,
      /Error|undefined|\[object|\/var\//,
      code,
    );
  }
});

test('the separately required failure classes each have their own code', () => {
  const required = [
    'NTF_PERMISSION_DENIED',
    'NTF_PERMISSION_CHECK_FAILED',
    'MAIN_REGISTER_FAILED',
    'MAIN_UNVERIFIED',
    'CHECKIN_REGISTER_FAILED',
    'SENSOR_PERMISSION_DENIED',
    'SENSOR_UNAVAILABLE',
    'SENSOR_READ_FAILED',
    'STORAGE_CORRUPT',
    'STORAGE_SAVE_FAILED',
    'ACTION_INVALID',
    'DEADLINE_PASSED',
    'CANCEL_UNKNOWN',
  ] as const;
  for (const code of required) {
    assert.ok(ERROR_CODES.includes(code), code);
  }
});

test('severity matches what is actually known about the alarm', () => {
  assert.equal(describeErrorCode('CHECKIN_REGISTER_FAILED').tone, 'warning');
  assert.equal(describeErrorCode('MAIN_REGISTER_FAILED').tone, 'danger');
  assert.equal(describeErrorCode('MAIN_UNVERIFIED').tone, 'danger');
  assert.equal(describeErrorCode('CANCEL_UNKNOWN').tone, 'danger');
});

test('copy never claims an unknown main alarm is reserved or stopped', () => {
  for (const code of ['MAIN_UNVERIFIED', 'CANCEL_UNKNOWN'] as const) {
    const { message, recovery } = describeErrorCode(code);
    assert.doesNotMatch(message + recovery, /予約しました|追加しました|停止しました/);
    assert.match(message, /確認できません/);
  }
});

test('destructive failures are never retried automatically', () => {
  for (const code of [
    'CANCEL_UNKNOWN',
    'CANCEL_NOT_VERIFIED',
    'MAIN_REGISTER_FAILED',
    'MAIN_UNVERIFIED',
  ] as const) {
    assert.notEqual(describeErrorCode(code).retry, 'next_launch', code);
  }
  // Only the recorded, idempotent journals resume on their own.
  assert.equal(describeErrorCode('DISABLE_CANCEL_INCOMPLETE').retry, 'next_launch');
});

test('AppError exposes its code and a catalog message, not the cause', () => {
  const cause = new Error(SECRET);
  const error = new AppError('STORAGE_SAVE_FAILED', cause);
  assert.equal(error.code, 'STORAGE_SAVE_FAILED');
  assert.equal(error.cause, cause);
  assert.ok(!error.message.includes('token='));
  assert.equal(errorCodeOf(error), 'STORAGE_SAVE_FAILED');
});

test('errorCodeOf reads a known code from tagged errors only', () => {
  const tagged = Object.assign(new Error('x'), { code: 'CANCEL_UNKNOWN' });
  assert.equal(errorCodeOf(tagged), 'CANCEL_UNKNOWN');
  const foreign = Object.assign(new Error('x'), { code: 'ENOENT' });
  assert.equal(errorCodeOf(foreign, 'STORAGE_READ_FAILED'), 'STORAGE_READ_FAILED');
  assert.equal(errorCodeOf('string'), 'UNEXPECTED_FAILURE');
  assert.equal(errorCodeOf(null), 'UNEXPECTED_FAILURE');
});

test('describeError never leaks an arbitrary error message', () => {
  for (const thrown of [
    new Error(SECRET),
    SECRET,
    { message: SECRET },
    new AppError('STORAGE_SAVE_FAILED', new Error(SECRET)),
  ]) {
    const notice = describeError(thrown, 'STORAGE_SAVE_FAILED');
    assert.ok(!notice.text.includes('token='), notice.text);
    assert.ok(!notice.text.includes('/var/'), notice.text);
    assert.equal(notice.code, 'STORAGE_SAVE_FAILED');
  }
});

test('noticeFromCode joins message and recovery and keeps the code secondary', () => {
  const notice = noticeFromCode('NTF_PERMISSION_DENIED');
  const descriptor = describeErrorCode('NTF_PERMISSION_DENIED');
  assert.equal(notice.text, descriptor.message + descriptor.recovery);
  assert.equal(notice.code, 'NTF_PERMISSION_DENIED');
  assert.equal(notice.tone, descriptor.tone);
  // The code is a separate field, not mixed into the sentence.
  assert.ok(!notice.text.includes('NTF_PERMISSION_DENIED'));
});

test('no copy sends the user to a device notification list that iOS does not expose', () => {
  for (const code of ERROR_CODES) {
    const { message, recovery } = describeErrorCode(code);
    assert.doesNotMatch(message + recovery, /通知一覧|通知の一覧/, code);
  }
});

test('copy about durable records is only used by codes whose callers guarantee it', () => {
  for (const code of ['MAIN_UNVERIFIED_MEMORY_ONLY', 'MAIN_UNVERIFIED_CANCELLED', 'ROLLBACK_INCOMPLETE'] as const) {
    assert.doesNotMatch(noticeFromCode(code).text, /記録(して|済)/, code);
  }
});

test('every snooze rejection and stop/recovery failure has a typed catalog code', async () => {
  const { getSnoozeCopy } = await import('../src/snoozeCopy');
  const reasons = [
    'NOT_FOUND', 'NOT_RINGING', 'LIMIT_REACHED', 'TOO_LATE', 'CAPACITY_FULL',
    'LIST_FAILED', 'INTENT_NOT_SAVED', 'SCHEDULE_FAILED', 'VERIFY_FAILED', 'PERSIST_FAILED',
  ] as const;
  const codes = reasons.map((reason) => getSnoozeCopy.failureCode(reason));
  assert.equal(new Set(codes).size, reasons.length);
  for (const code of codes) {
    assert.ok(isErrorCode(code), code);
  }
  assert.equal(
    getSnoozeCopy.failureCode('SCHEDULE_FAILED', { cleanup: 'unconfirmed' }),
    'SNOOZE_CLEANUP_UNCONFIRMED',
  );
  for (const code of [
    'STOP_SAVE_FAILED', 'STOP_FOLLOWUP_FAILED', 'STOP_RESET_PENDING',
    'SNOOZE_REARM_FAILED', 'SNOOZE_RECOVERY_UNRESOLVED', 'SNOOZE_RECOVERY_FAILED',
    'SNOOZE_RESET_PENDING', 'EDIT_LOCKED_SNOOZED', 'EDIT_SNOOZE_UNSETTLED',
  ]) {
    assert.ok(isErrorCode(code), code);
  }
  // iOS cannot list an app's pending notifications: no copy may point there.
  for (const code of ERROR_CODES) {
    const { message, recovery } = describeErrorCode(code);
    assert.doesNotMatch(message + recovery, /端末の通知を確認|通知一覧|通知から停止/, code);
  }
});
