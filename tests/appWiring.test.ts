/// <reference types="node" />

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// App.tsx cannot be rendered under tsx, so these checks read its source to
// guard the wiring that pure-function tests cannot see. They are a tripwire,
// not a substitute for the device checks in docs/DEVICE_TEST.md.
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

function block(start: string, end: string): string {
  const from = app.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return app.slice(from, to);
}

test('toggle and delete re-check the latest alarms and clock when they run', () => {
  const toggle = block('const toggleAlarm = useCallback', 'const deleteAlarm');
  const remove = block(
    'const deleteAlarm = useCallback',
    'const confirmDeleteAlarm',
  );
  for (const body of [toggle, remove]) {
    assert.match(body, /runUnlessAlarmListLocked/);
    assert.match(body, /getAlarms: \(\) => alarmsRef\.current/);
    assert.match(body, /nowMs: Date\.now/);
  }
  // The delete dialog confirms through the guarded action, not the raw one.
  const confirm = block('const confirmDeleteAlarm', 'const stopRinging');
  assert.match(confirm, /void deleteAlarm\(definition\)/);
  assert.doesNotMatch(confirm, /performDeleteAlarm/);
});

test('both suppression paths write to the persistent journal', () => {
  assert.equal(app.match(/journal: suppressionJournal,/g)?.length, 3);
  const awake = block('processAwakeResponseFailSafe(', 'confirmedAtMs: Date.now()');
  assert.match(awake, /journal: suppressionJournal/);
  const steps = block('processStepThresholdFailSafe(', 'countedFromMs,\n          },');
  assert.match(steps, /journal: suppressionJournal/);
});

test('startup settles suppressions before marking cycles due or refilling', () => {
  const startup = block(
    'await recoverPendingAlarmCancellations()',
    'await refillEnabledSchedules',
  );
  const reconcile = startup.indexOf('reconcileSuppressions()');
  const markDue = startup.indexOf('markDueCyclesRinging(');
  assert.notEqual(reconcile, -1);
  assert.ok(reconcile < markDue, 'recovery must precede markDueCyclesRinging');
});

test('foreground return reconciles before refilling', () => {
  const foreground = block(
    "const subscription = AppState.addEventListener('change', (state) => {\n      if (state !== 'active')",
    'return () => subscription.remove();',
  );
  assert.ok(
    foreground.indexOf('reconcileSuppressions()') <
      foreground.indexOf("refillEnabledSchedules(\n            'foreground'"),
  );
});

test('refill skips alarms with unsettled suppressions and fails closed if unreadable', () => {
  const refill = block('async function refillEnabledSchedulesOnce', 'catch (error)');
  assert.match(refill, /await suppressionJournal\.load\(\)/);
  assert.match(refill, /pendingAlarmIds\.add\(pending\.alarmId\)/);
});

test('suppression failures are shown through the dedicated warning, not "alarm on"', () => {
  assert.equal(app.match(/classifySuppressionFailure\(error\)/g)?.length, 2);
  assert.match(app, /testID="suppression-warning"/);
});

test('storage reset is reachable only from two confirmations in the load-failed card', () => {
  const sources = ['App.tsx', ...readdirSync(new URL('../src', import.meta.url))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => `src/${name}`)];
  for (const name of sources) {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      text,
      /cancelAllScheduledNotificationsAsync/,
      `${name} must never cancel the shared queue`,
    );
    if (name !== 'App.tsx') {
      assert.doesNotMatch(text, /storageReset\.reset\(/);
    }
  }

  assert.equal(app.match(/storageReset\.reset\(/g)?.length, 1);
  const perform = block('const performStorageReset = useCallback', 'const confirmStorageReset');
  assert.match(perform, /storageReset\.reset\(/);
  assert.match(perform, /!loadFailed/);

  const confirm = block('const confirmStorageReset = useCallback', 'const stopRinging');
  assert.equal(confirm.match(/Alert\.alert\(/g)?.length, 2);
  assert.match(confirm, /!loadFailed/);
  // The reset runs only from the second dialog's destructive button.
  const second = confirm.slice(confirm.lastIndexOf('Alert.alert('));
  assert.match(second, /performStorageReset\(\)/);
  assert.equal(confirm.match(/performStorageReset\(\)/g)?.length, 1);

  const card = block('testID="storage-load-failed"', ') : deliveryWarningCopy');
  assert.match(card, /confirmStorageReset/);
  assert.equal(app.match(/onPress=\{confirmStorageReset\}/g)?.length, 1);
});

test('startup keeps the failure card while an earlier reset is unfinished', () => {
  const startup = block('let cancellationRecoveryFailed = false;', 'await recoverPendingAlarmCancellations');
  assert.match(startup, /storageReset\.hasPendingReset\(\)/);
  assert.match(startup, /throw /);
});
