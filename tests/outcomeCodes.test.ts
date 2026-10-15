import assert from 'node:assert/strict';
import test from 'node:test';

import type { StoredAlarm } from '../src/alarmStorage';
import { describeErrorCode, isErrorCode, noticeFromCodes } from '../src/errorCatalog';
import { getSnoozeCopy } from '../src/snoozeCopy';
import { presentSnoozeRejected, presentSnoozed, presentStopped } from '../src/snoozeOutcome';
import { stampStorageResult } from '../src/storageResetGate';
import { EN_TEXT, JA_TEXT } from './support/text';

const CYCLE = { cycleId: 'c1' } as unknown as StoredAlarm;
const OK = {};
const UNCONFIRMED = { cleanup: 'unconfirmed' as const };
const MEMORY = { cleanup: 'unconfirmed' as const, tracking: 'memory_only' as const };

test('cleanup, tracking and the operation outcome map to separate codes', () => {
  const codes = [
    getSnoozeCopy.acceptedCleanupCode(UNCONFIRMED),
    getSnoozeCopy.acceptedCleanupCode(MEMORY),
    getSnoozeCopy.stopCleanupCode(UNCONFIRMED),
    getSnoozeCopy.stopCleanupCode(MEMORY),
    getSnoozeCopy.failureCode('SCHEDULE_FAILED', UNCONFIRMED),
    getSnoozeCopy.failureCode('SCHEDULE_FAILED', MEMORY),
  ];
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.ok(code && isErrorCode(code), String(code));
  }
  assert.equal(getSnoozeCopy.acceptedCleanupCode(OK), null);
  assert.equal(getSnoozeCopy.stopCleanupCode(OK), null);
  // A rejection without cleanup keeps its own reason code.
  assert.equal(getSnoozeCopy.failureCode('TOO_LATE', OK), 'SNOOZE_TOO_LATE');
});

test('an accepted snooze or stop with unconfirmed cleanup is a warning, not a failure', () => {
  for (const code of [
    getSnoozeCopy.acceptedCleanupCode(UNCONFIRMED)!,
    getSnoozeCopy.stopCleanupCode(UNCONFIRMED)!,
  ]) {
    const { tone, message } = describeErrorCode(code);
    assert.equal(tone, 'warning', code);
    assert.match(message, /(スヌーズ|停止)(を設定|しました)/, code);
    assert.match(message, /確認できていません/, code);
  }
  // A rejected snooze did not happen; it stays a danger.
  assert.equal(describeErrorCode('SNOOZE_CLEANUP_UNCONFIRMED').tone, 'danger');
});

test('copy about durable tracking is used only where tracking is durable', () => {
  const durable = [
    getSnoozeCopy.acceptedCleanupCode(UNCONFIRMED)!,
    getSnoozeCopy.stopCleanupCode(UNCONFIRMED)!,
    getSnoozeCopy.failureCode('SCHEDULE_FAILED', UNCONFIRMED),
  ];
  const memory = [
    getSnoozeCopy.acceptedCleanupCode(MEMORY)!,
    getSnoozeCopy.stopCleanupCode(MEMORY)!,
    getSnoozeCopy.failureCode('SCHEDULE_FAILED', MEMORY),
  ];
  for (const code of durable) {
    assert.match(noticeFromCodes([code]).text, /端末に記録しています/, code);
  }
  for (const code of memory) {
    const text = noticeFromCodes([code]).text;
    assert.doesNotMatch(text, /記録しています|次回の起動時/, code);
    assert.match(text, /アプリを(終了|閉じ)/, code);
  }
});

test('a failed stop save says nothing was cancelled and the alarm still rings', () => {
  assert.equal(getSnoozeCopy.stopFailureCode('SAVE_FAILED'), 'STOP_SAVE_FAILED');
  assert.equal(getSnoozeCopy.stopFailureCode('CANCEL_FAILED'), 'STOP_SAVE_FAILED');
  const text = noticeFromCodes(['STOP_SAVE_FAILED']).text;
  assert.doesNotMatch(text, /取り消しました/);
  assert.match(text, /取り消していません/);
  assert.match(text, /鳴動中のまま/);
});

test('recovery separates a memory-only record from an unconfirmed durable one', () => {
  const base = { cleaned: [], rearmed: [], rearmFailed: [], unresolved: [] };
  assert.equal(getSnoozeCopy.recoveryCode(base), null);
  assert.equal(getSnoozeCopy.recoveryCode({ ...base, unresolved: ['a'] }), 'SNOOZE_RECOVERY_UNRESOLVED');
  assert.equal(getSnoozeCopy.recoveryCode({ ...base, rearmFailed: ['a'] }), 'SNOOZE_REARM_FAILED');
  assert.equal(
    getSnoozeCopy.recoveryCode({ ...base, unresolved: ['a'], memoryOnly: ['a'] }),
    'SNOOZE_RECOVERY_MEMORY_ONLY',
  );
  assert.doesNotMatch(noticeFromCodes(['SNOOZE_RECOVERY_MEMORY_ONLY']).text, /記録しています/);
});

test('noticeFromCodes keeps every message and the most severe tone', () => {
  const notice = noticeFromCodes(['STOP_FOLLOWUP_FAILED', 'STOP_CLEANUP_UNCONFIRMED']);
  assert.equal(notice.tone, 'warning');
  assert.equal(notice.code, 'STOP_FOLLOWUP_FAILED');
  assert.ok(notice.text.includes(describeErrorCode('STOP_FOLLOWUP_FAILED').message));
  assert.ok(notice.text.includes(describeErrorCode('STOP_CLEANUP_UNCONFIRMED').message));
  assert.equal(noticeFromCodes(['STOP_SAVE_FAILED', 'STOP_FOLLOWUP_FAILED']).tone, 'danger');
});

function harness(options: { refillThrows?: unknown; reloadThrows?: boolean } = {}) {
  const calls: string[] = [];
  const reloaded = stampStorageResult([]);
  return {
    calls,
    effects: {
      stopSound: () => calls.push('sound'),
      apply: () => calls.push('apply'),
      refill: async () => {
        calls.push('refill');
        if (options.refillThrows) throw options.refillThrows;
      },
      reload: async () => {
        calls.push('reload');
        if (options.reloadThrows) throw new Error('/private/var/x token=abc');
        return reloaded;
      },
      isResetPending: (error: unknown) => error === 'reset',
    },
  };
}

test('a stop shows sound and the committed snapshot before a refill that then fails', async () => {
  const h = harness({ refillThrows: new Error('boom') });
  const out = await presentStopped(
    { cycle: CYCLE, alarms: stampStorageResult([]) },
    h.effects,
    JA_TEXT,
  );
  assert.deepEqual(h.calls, ['sound', 'apply', 'refill']);
  assert.equal(out.notice.code, 'STOP_FOLLOWUP_FAILED');
  assert.equal(out.deletionPending, false);
});

test('a stop with unconfirmed cleanup and a failed refill reports both', async () => {
  const h = harness({ refillThrows: new Error('boom') });
  const out = await presentStopped(
    { cycle: CYCLE, alarms: stampStorageResult([]), ...MEMORY },
    h.effects,
    JA_TEXT,
  );
  assert.ok(out.notice.text.includes(describeErrorCode('STOP_FOLLOWUP_FAILED').message));
  assert.ok(out.notice.text.includes(describeErrorCode('STOP_CLEANUP_MEMORY_ONLY').message));
});

test('a successful refill does not hide unconfirmed cleanup', async () => {
  const h = harness();
  const out = await presentStopped(
    { cycle: CYCLE, alarms: stampStorageResult([]), ...UNCONFIRMED },
    h.effects,
    JA_TEXT,
  );
  assert.equal(out.notice.code, 'STOP_CLEANUP_UNCONFIRMED');
  assert.equal(out.notice.tone, 'warning');
});

test('a clean stop is plain success and a refill blocked by a reset is flagged', async () => {
  const clean = await presentStopped(
    { cycle: CYCLE, alarms: stampStorageResult([]) },
    harness().effects,
    JA_TEXT,
  );
  assert.equal(clean.notice.code, undefined);
  assert.equal(clean.notice.tone, 'neutral');
  const blocked = await presentStopped(
    { cycle: CYCLE, alarms: stampStorageResult([]) },
    harness({ refillThrows: 'reset' }).effects,
    JA_TEXT,
  );
  assert.equal(blocked.deletionPending, true);
  assert.equal(blocked.notice.code, 'STOP_FOLLOWUP_RESET_PENDING');
  assert.doesNotMatch(blocked.notice.text, /\/|token|Error/);
});

test('without a committed snapshot the stop reads best effort and a read failure is swallowed', async () => {
  const h = harness({ reloadThrows: true });
  const out = await presentStopped({ cycle: CYCLE }, h.effects, JA_TEXT);
  assert.deepEqual(h.calls, ['sound', 'refill', 'reload']);
  assert.equal(out.notice.code, undefined);
  assert.doesNotMatch(out.notice.text, /token|private/);
});

test('an accepted snooze applies its snapshot first and never reloads over it', async () => {
  const h = harness();
  const notice = await presentSnoozed(
    { status: 'snoozed', cycle: CYCLE, dueAtMs: Date.UTC(2026, 0, 1, 6, 30), alarms: stampStorageResult([]), ...UNCONFIRMED },
    h.effects,
    JA_TEXT,
  );
  assert.deepEqual(h.calls, ['sound', 'apply']);
  assert.equal(notice.code, 'SNOOZE_ACCEPTED_CLEANUP_UNCONFIRMED');
  assert.equal(notice.tone, 'warning');
});

test('a clean accepted snooze announces the time with no error code', async () => {
  const notice = await presentSnoozed(
    { status: 'snoozed', cycle: CYCLE, dueAtMs: new Date(2026, 0, 1, 6, 30).getTime(), alarms: stampStorageResult([]) },
    harness().effects,
    JA_TEXT,
  );
  assert.equal(notice.code, undefined);
  assert.match(notice.text, /06:30|6:30/);
});

test('a rejected snooze reads stored state without the sound stopping, then reports its own code', async () => {
  const h = harness({ reloadThrows: true });
  const notice = await presentSnoozeRejected(
    { status: 'rejected', reason: 'SCHEDULE_FAILED', ...MEMORY },
    h.effects,
    JA_TEXT,
  );
  assert.deepEqual(h.calls, ['reload']);
  assert.equal(notice.code, 'SNOOZE_CLEANUP_MEMORY_ONLY');
  assert.equal(notice.tone, 'danger');
});
