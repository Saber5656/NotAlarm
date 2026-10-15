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
  assert.equal(app.match(/journal: suppressionJournal,/g)?.length, 4);
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
      foreground.indexOf("'foreground'"),
  );
});

test('refill skips alarms with unsettled suppressions and fails closed if unreadable', () => {
  const refill = block('async function refillEnabledSchedulesOnce', 'catch (error)');
  assert.match(refill, /await suppressionJournal\.load\(\)/);
  assert.match(refill, /pendingAlarmIds\.add\(pending\.alarmId\)/);
});

test('suppression failures are shown through the dedicated warning, not "alarm on"', () => {
  assert.equal(app.match(/classifySuppressionFailure\(error\)/g)?.length, 3);
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

test('settings deletion confirms twice, reuses the reset service and never runs while ringing', () => {
  const confirm = block(
    'const confirmLocalDataDeletion = useCallback',
    'const confirmStorageReset',
  );
  assert.equal(confirm.match(/Alert\.alert\(/g)?.length, 2);
  assert.match(confirm, /getLocalDataDeletionAvailability/);
  assert.match(confirm, /void performLocalDataDeletion\(\)/);

  const perform = block(
    'const performLocalDataDeletion = useCallback',
    'const confirmLocalDataDeletion',
  );
  // Availability is re-read from the latest alarms when the dialog confirms.
  assert.match(perform, /getRingingCycle\(alarmsRef\.current\)/);
  assert.match(perform, /deleteAllLocalData\(storageReset\)/);
  // A failure must not touch the in-memory alarm list.
  const failure = block("outcome.kind === 'failed'", 'applyLocalDataDeleted();');
  assert.doesNotMatch(failure, /setCurrentAlarms/);

  assert.match(app, /visible=\{isSettingsOpen && !ringingCycle\}/);
  assert.match(app, /accessibilityLabel=\{LOCAL_DATA_COPY\.settingsLabel\}/);
});

test('an unfinished deletion blocks refill reservations and new alarms', () => {
  const refill = block(
    'mutateAlarmDefinitions(async (current) => {\n          // An unfinished deletion',
    'fillEnabledSchedules(',
  );
  assert.match(refill, /storageReset\.hasPendingReset\(\)/);
  assert.match(refill, /return current;/);
  assert.match(app, /!deletionPending &&\n\s+alarms\.length < MAX_ALARM_COUNT/);
});

test('startup treats an unfinished reset as a recovery state before any refill', () => {
  const startup = block(
    'await storageReset.hasPendingReset()',
    'await recoverPendingAlarmCancellations()',
  );
  assert.match(startup, /throw new Error/);
});

test('the reset gate is installed at the storage layer and completion advances the epoch', () => {
  assert.match(app, /installStorageResetGate\(\(\) => storageReset\.hasPendingReset\(\)\)/);
  assert.match(app, /onCompleted: advanceStorageEpoch/);
});

test('results read before a finished deletion never reach the screen', () => {
  const setter = block('const setCurrentAlarms', 'alarmsRef.current = next;');
  assert.match(setter, /isStaleStorageResult\(next\)/);
  const refill = block('await refillEnabledSchedulesOnce(trigger', 'recordRefill(result.attempt)');
  assert.match(refill, /isStaleStorageResult\(result\.alarms\)/);
});

test('a finished deletion clears warning memory owned by the deleted alarms', () => {
  const applied = block('const applyLocalDataDeleted', 'setCurrentAlarms([])');
  assert.match(applied, /reportedScheduleProblemsRef\.current = new Set\(\)/);
});

test('a refused stop stops sound first and never rewrites the alarm list', () => {
  const stop = block('const stopRinging', 'const orderedAlarms');
  assert.ok(stop.indexOf('stopForegroundAlarmSound()') < stop.indexOf('saveStoredAlarm(dismissed)'));
  const refused = block('if (isStorageResetPendingError(error)) {\n        // Fail-safe', '} else {');
  assert.doesNotMatch(refused, /setCurrentAlarms/);
  assert.match(refused, /音と通知は止めました/);
});

test('queue reconciliation serialises against stops and user cancellations', () => {
  const fn = block(
    'async function reconcileScheduleWithQueueOnce',
    'let scheduleReconcileInFlight',
  );
  // Order: suppression lock, then the storage queue, then the OS queue read.
  const exclusive = fn.indexOf('suppressionJournal.exclusive(');
  const transact = fn.indexOf('transactAlarmDefinitions(');
  const inspect = fn.indexOf('readScheduledNotificationQueue');
  assert.ok(exclusive !== -1 && exclusive < transact);
  assert.ok(transact < inspect, 'the OS queue is read inside the storage turn');
  // Unfinished cancels and half-done stops exclude their alarm.
  assert.match(fn, /loadPendingAlarmCancellations\(\)/);
  assert.match(fn, /suppressionJournal\.load\(\)/);
  assert.match(fn, /excludedAlarmIds/);
  // The queue is read through the content-aware reader, again after each step.
  assert.match(fn, /readQueue: readScheduledNotificationQueue/);
  assert.doesNotMatch(fn, /listScheduledNotificationIds/);
  assert.match(fn, /orphans: orphanStore/);
});

test('an aborted reconciliation re-reads the durable checkpoint before any refill', () => {
  const fn = block(
    'async function reconcileScheduleWithQueueOnce',
    'let scheduleReconcileInFlight',
  );
  const catchBlock = fn.slice(fn.lastIndexOf('} catch (error)'));
  assert.match(catchBlock, /recoverAbortedReconciliation\(/);
  assert.match(catchBlock, /loadAlarmDefinitions/);
  assert.match(catchBlock, /unrecoveredNotificationIds/);
  // The recovered state flows into App state; the stale input is not reused.
  const reconcile = block('const reconcileWithQueue = useCallback', 'const clearQueueStatus');
  assert.match(reconcile, /unrecoveredNotificationIds/);
  // The refill decision comes from the tested gate, never from `?? restored`.
  const startup = block('await recoverPendingAlarmCancellations()', 'await refillEnabledSchedules');
  assert.doesNotMatch(startup, /\?\? restored/);
  assert.match(startup, /safeToRefill = state\.safeToRefill/);
  assert.match(reconcile, /assessReconciledState\(/);
  assert.match(fn, /aborted: true/);
});

test('queue reconciliation is not re-entered and shares the in-flight run', () => {
  const shared = block('let scheduleReconcileInFlight', 'const ALARM_SUMMARY_CARD_HEIGHT');
  assert.match(shared, /if \(scheduleReconcileInFlight\)/);
  assert.match(shared, /return scheduleReconcileInFlight/);
  assert.match(shared, /scheduleReconcileInFlight = null/);
});

test('startup and foreground reconcile with the OS queue before refilling', () => {
  const startup = block(
    'await recoverPendingAlarmCancellations()',
    'await refillEnabledSchedules',
  );
  assert.ok(
    startup.indexOf('markDueCyclesRinging(') <
      startup.indexOf('reconcileWithQueue('),
  );
  const foreground = block(
    "const subscription = AppState.addEventListener('change', (state) => {\n      if (state !== 'active')",
    'return () => subscription.remove();',
  );
  assert.ok(
    foreground.indexOf('reconcileWithQueue(') <
      foreground.indexOf("'foreground'"),
  );
});

test('rows show the OS-queue verification instead of claiming a reservation', () => {
  assert.match(app, /queueStatus: queueStatuses\[definition\.id\]/);
  assert.match(app, /testID="queue-verification-warning"|queueStatuses/);
});

test('a pending storage reset is checked before any reconcile, recovery or refill', () => {
  const reconcile = block('async function reconcileScheduleWithQueueOnce', 'let scheduleReconcileInFlight');
  assert.ok(
    reconcile.indexOf('storageReset.hasPendingReset()') <
      reconcile.indexOf('prepareNotificationsIfGranted()'),
  );
  assert.ok(
    reconcile.lastIndexOf('storageReset.hasPendingReset()') <
      reconcile.indexOf('reconcileAlarmSchedules('),
  );
  const refill = block('async function refillEnabledSchedulesOnce', 'fillEnabledSchedules(');
  assert.match(refill, /storageReset\.hasPendingReset\(\)/);
  const foreground = block(
    "const subscription = AppState.addEventListener('change', (state) => {\n      if (state !== 'active')",
    'return () => subscription.remove();',
  );
  assert.ok(
    foreground.indexOf('storageReset.hasPendingReset()') <
      foreground.indexOf('reconcileSuppressions()'),
  );
});

test('an obsolete reconciliation never restores queue status or warnings after a deletion', () => {
  const reconcile = block('const reconcileWithQueue = useCallback', 'const clearQueueStatus');
  assert.ok(
    reconcile.indexOf('isObsoleteReconcileResult(result)') <
      reconcile.indexOf('setQueueStatuses(result.statuses)'),
  );
  const applied = block('const applyLocalDataDeleted', 'setCurrentAlarms([])');
  assert.match(applied, /reportedQueueProblemsRef\.current = new Set\(\)/);
  assert.match(applied, /setQueueStatuses\(\{\}\)/);
  const fn = block('async function reconcileScheduleWithQueueOnce', 'let scheduleReconcileInFlight');
  const zoneSave = fn.slice(fn.indexOf('if (settled'), fn.indexOf('if (settled') + 120);
  assert.match(zoneSave, /isStaleStorageResult\(alarms\)/);
  assert.match(fn, /await assertNoPendingReset\(\)/);
});

test('sun background hook is called unconditionally and feeds the theme', () => {
  const hook = app.indexOf('useSunBackground(nowMs, sunStorageCoordination)');
  assert.notEqual(hook, -1);
  const theme = block('const circadianTheme = useMemo', 'const setCurrentAlarms');
  assert.match(theme, /getCircadianTheme\(new Date\(nowMs\), sun\.schedule\)/);
  assert.match(theme, /\[localMinuteKey, sun\.schedule\]/);
  // Not inside any condition, loop or callback: the line is a top-level const.
  assert.match(app, /\n  const sun = useSunBackground\(/);
  // The shared storage lock/gate is one module-level object (stable identity).
  assert.match(
    app,
    /\nconst sunStorageCoordination = \{[^}]*assertWritable: assertNoPendingReset/s,
  );
});

test('sunrise settings live inside the shared settings modal', () => {
  const modal = block('<SettingsModal', '</SettingsModal>');
  assert.match(modal, /<SunriseSettings/);
  assert.equal(app.match(/<SettingsModal/g)?.length, 1);
});

test('confirmed deletion invalidates the sun lookup before awaiting and settles it after', () => {
  for (const [start, end, call] of [
    ['const performStorageReset = useCallback', 'const performLocalDataDeletion', 'await storageReset.reset()'],
    ['const performLocalDataDeletion = useCallback', 'const confirmLocalDataDeletion', 'await deleteAllLocalData(storageReset)'],
  ] as const) {
    const body = block(start, end);
    const begin = body.indexOf('sun.beginDeletion()');
    assert.notEqual(begin, -1, start);
    assert.ok(begin < body.indexOf(call), `${start}: invalidate before reset`);
    assert.match(body, /sun\.completeDeletion\(\)/);
    assert.match(body, /sun\.failDeletion\(\)/);
  }
});

test('sun callbacks are stable so effects and permission never loop', () => {
  const hook = readFileSync(
    new URL('../src/useSunBackground.ts', import.meta.url),
    'utf8',
  );
  for (const name of [
    'chooseFixed',
    'chooseRegion',
    'useDeviceLocation',
    'beginDeletion',
    'completeDeletion',
    'failDeletion',
  ]) {
    assert.match(hook, new RegExp(`const ${name} = useCallback`), name);
  }
  // Loading never requests a permission or position.
  assert.doesNotMatch(
    hook.slice(hook.indexOf('const reload'), hook.indexOf('useEffect')),
    /useDeviceLocation|requestPermission/,
  );
});
