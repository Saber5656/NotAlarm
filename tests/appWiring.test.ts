/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { en, ja } from '../src/i18n';
import {
  OWNER,
  blockIn,
  countIn,
  read,
  sourcesUnder,
} from './support/source';

// The app cannot be rendered under tsx, so these checks read the source of the
// module that owns each responsibility (see OWNER) to guard wiring that
// pure-function tests cannot see. Every anchor is resolved inside one named
// module: an anchor that moves fails here instead of matching elsewhere. The
// reconcile and refill coordinators also have execution tests
// (queueReconciler / refillCoordinator / suppressionReconciler). This is a
// tripwire, not a substitute for the device checks in docs/DEVICE_TEST.md.
const appSources = [
  OWNER.root,
  ...sourcesUnder('src/app'),
  ...sourcesUnder('src/ui/screens'),
];

const STARTUP = [
  OWNER.lifecycle,
  'await recoverPendingAlarmCancellations()',
  'await refillEnabledSchedules',
] as const;
const FOREGROUND = [
  OWNER.lifecycle,
  "return subscribeAppState((state) => {\n      if (state !== 'active')",
  '  }, [\n    isLoaded,',
] as const;

test('toggle and delete re-check the latest alarms and clock when they run', () => {
  const toggle = blockIn(OWNER.mutations, 'const toggleAlarm = useCallback', 'const deleteAlarm');
  const remove = blockIn(
    OWNER.mutations,
    'const deleteAlarm = useCallback',
    'const confirmDeleteAlarm',
  );
  for (const body of [toggle, remove]) {
    assert.match(body, /runUnlessAlarmListLocked/);
    assert.match(body, /getAlarms: \(\) => alarmsRef\.current/);
    assert.match(body, /nowMs: Date\.now/);
  }
  // The delete dialog confirms through the guarded action, not the raw one.
  const confirm = blockIn(OWNER.mutations, 'const confirmDeleteAlarm', 'return {\n    addAlarm');
  assert.match(confirm, /void deleteAlarm\(definition\)/);
  assert.doesNotMatch(confirm, /performDeleteAlarm/);
});

test('both suppression paths write to the persistent journal', () => {
  // Awake response + in-app skip (useSuppressionResponses), step threshold
  // (useStepCandidate) and the module-level recovery (coordinators).
  assert.equal(countIn(OWNER.suppression, /journal: suppressionJournal,/g), 2);
  assert.equal(countIn(OWNER.stepCandidate, /journal: suppressionJournal,/g), 1);
  assert.equal(countIn(OWNER.coordinators, /journal: suppressionJournal,/g), 1);
  const awake = blockIn(OWNER.suppression, 'processAwakeResponseFailSafe(', 'confirmedAtMs: Date.now()');
  assert.match(awake, /journal: suppressionJournal/);
  const steps = blockIn(OWNER.stepCandidate, 'processStepThresholdFailSafe(', 'countedFromMs,\n          },');
  assert.match(steps, /journal: suppressionJournal/);
});

test('startup settles suppressions before marking cycles due or refilling', () => {
  const startup = blockIn(...STARTUP);
  const reconcile = startup.indexOf('reconcileSuppressions()');
  const markDue = startup.indexOf('markDueCyclesRinging(');
  assert.notEqual(reconcile, -1);
  assert.ok(reconcile < markDue, 'recovery must precede markDueCyclesRinging');
});

test('foreground return reconciles before refilling', () => {
  const foreground = blockIn(...FOREGROUND);
  assert.ok(
    foreground.indexOf('reconcileSuppressions()') <
      foreground.indexOf("'foreground'"),
  );
});

test('refill skips alarms with unsettled suppressions and fails closed if unreadable', () => {
  const refill = blockIn(OWNER.refill, 'async function refillEnabledSchedulesOnce', 'catch (error)');
  assert.match(refill, /await deps\.loadSuppressionIntents\(\)/);
  assert.match(refill, /pendingAlarmIds\.add\(pending\.alarmId\)/);
  // The injected port is the persistent journal itself.
  assert.match(read(OWNER.coordinators), /loadSuppressionIntents: \(\) => suppressionJournal\.load\(\)/);
});

test('suppression failures are shown through the dedicated warning, not "alarm on"', () => {
  assert.equal(countIn(OWNER.suppression, /classifySuppressionFailure\(error, messagesNow\(\)\)/g), 2);
  assert.equal(countIn(OWNER.stepCandidate, /classifySuppressionFailure\(error, messagesNow\(\)\)/g), 1);
  assert.match(read(OWNER.home), /testID="suppression-warning"/);
});

test('storage reset is reachable only from two confirmations in the load-failed card', () => {
  for (const name of appSources) {
    const text = read(name);
    assert.doesNotMatch(
      text,
      /cancelAllScheduledNotificationsAsync/,
      `${name} must never cancel the shared queue`,
    );
    if (name !== OWNER.deletion) {
      assert.doesNotMatch(text, /storageReset\.reset\(/, name);
    }
  }
  for (const name of sourcesUnder('src')) {
    if (!name.startsWith('src/app/') && !name.startsWith('src/ui/screens/')) {
      assert.doesNotMatch(read(name), /cancelAllScheduledNotificationsAsync/, name);
      assert.doesNotMatch(read(name), /storageReset\.reset\(/, name);
    }
  }

  const total = appSources.reduce(
    (sum, name) => sum + countIn(name, /storageReset\.reset\(/g),
    0,
  );
  assert.equal(total, 1);
  const perform = blockIn(OWNER.deletion, 'const performStorageReset = useCallback', 'const confirmStorageReset');
  assert.match(perform, /storageReset\.reset\(/);
  assert.match(perform, /!loadFailed/);

  const confirm = blockIn(OWNER.deletion, 'const confirmStorageReset = useCallback', 'useEffect(() => {');
  assert.equal(confirm.match(/Alert\.alert\(/g)?.length, 2);
  assert.match(confirm, /!loadFailed/);
  // The reset runs only from the second dialog's destructive button.
  const second = confirm.slice(confirm.lastIndexOf('Alert.alert('));
  assert.match(second, /performStorageReset\(\)/);
  assert.equal(confirm.match(/performStorageReset\(\)/g)?.length, 1);

  // The only control that starts it is in the load-failed card, and the home
  // screen renders that card only for a failed load.
  const card = read(OWNER.loadFailedCard);
  assert.match(card, /testID="storage-load-failed"/);
  assert.match(card, /confirmStorageReset/);
  assert.equal(card.match(/onPress=\{confirmStorageReset\}/g)?.length, 1);
  for (const name of appSources) {
    if (name !== OWNER.loadFailedCard) {
      assert.doesNotMatch(read(name), /onPress=\{confirmStorageReset\}/, name);
    }
  }
  assert.match(read(OWNER.home), /loadFailed \? \(\s*<LoadFailedCard/);
});

test('startup keeps the failure card while an earlier reset is unfinished', () => {
  const startup = blockIn(OWNER.lifecycle, 'let cancellationRecoveryFailed = false;', 'await recoverPendingAlarmCancellations');
  assert.match(startup, /storageReset\.hasPendingReset\(\)/);
  assert.match(startup, /throw /);
});

test('settings deletion confirms twice, reuses the reset service and never runs while ringing', () => {
  const confirm = blockIn(
    OWNER.deletion,
    'const confirmLocalDataDeletion = useCallback',
    'const confirmStorageReset',
  );
  assert.equal(confirm.match(/Alert\.alert\(/g)?.length, 2);
  assert.match(confirm, /getLocalDataDeletionAvailability/);
  assert.match(confirm, /void performLocalDataDeletion\(\)/);

  const perform = blockIn(
    OWNER.deletion,
    'const performLocalDataDeletion = useCallback',
    'const confirmLocalDataDeletion',
  );
  // Availability is re-read from the latest alarms when the dialog confirms.
  assert.match(perform, /getRingingCycle\(alarmsRef\.current\)/);
  assert.match(perform, /deleteAllLocalData\(storageReset\)/);
  // A failure must not touch the in-memory alarm list.
  const failure = blockIn(OWNER.deletion, "outcome.kind === 'failed'", 'applyLocalDataDeleted();');
  assert.doesNotMatch(failure, /setCurrentAlarms/);

  assert.match(read(OWNER.app), /visible=\{settings\.isOpen && !ringingCycle\}/);
  assert.match(read(OWNER.header), /accessibilityLabel=\{messages\.settings\.openLabel\}/);
});

test('an unfinished deletion blocks refill reservations and new alarms', () => {
  const refill = blockIn(
    OWNER.refill,
    'deps.storage.mutate(async (current) => {\n          // An unfinished deletion',
    'fillEnabledSchedules(',
  );
  assert.match(refill, /deps\.hasPendingReset\(\)/);
  assert.match(refill, /return current;/);
  assert.match(read(OWNER.coordinators), /hasPendingReset: \(\) => storageReset\.hasPendingReset\(\)/);
  assert.match(read(OWNER.homeView), /!deletionPending &&\n\s+alarms\.length < MAX_ALARM_COUNT/);
});

test('startup treats an unfinished reset as a recovery state before any refill', () => {
  const startup = blockIn(
    OWNER.lifecycle,
    'await storageReset.hasPendingReset()',
    'await recoverPendingAlarmCancellations()',
  );
  assert.match(startup, /throw new AppError\('STORAGE_RESET_PENDING'\)/);
});

test('the reset gate is installed at the storage layer and completion advances the epoch', () => {
  const gateways = read(OWNER.gateways);
  assert.match(gateways, /installStorageResetGate\(\(\) => storageReset\.hasPendingReset\(\)\)/);
  const reset = blockIn(OWNER.gateways, 'export const storageReset = createStorageResetService', 'installStorageResetGate');
  assert.match(
    reset,
    /onCompleted: \(\) => \{\s*advanceStorageEpoch\(\);\s*snoozeService\.forgetUnsettled\(\);\s*\/\/[^\n]*\s*schedulingGateway\.clearUnresolved\(\);/,
  );
  // Armed once: nothing outside the gateway module installs a gate or handler.
  for (const name of appSources) {
    if (name !== OWNER.gateways) {
      assert.doesNotMatch(read(name), /installStorageResetGate\(|installForegroundNotificationHandler\(/, name);
    }
  }
  assert.equal(countIn(OWNER.gateways, /installStorageResetGate\(/g), 1);
  assert.equal(countIn(OWNER.gateways, /installForegroundNotificationHandler\(\)/g), 1);
});

test('results read before a finished deletion never reach the screen', () => {
  const setter = blockIn(OWNER.controller, 'const setCurrentAlarms', 'alarmsRef.current = next;');
  assert.match(setter, /isStaleStorageResult\(next\)/);
  const refill = blockIn(OWNER.refill, 'await refillEnabledSchedulesOnce(', 'apply(result)');
  assert.match(refill, /isStaleStorageResult\(result\.alarms\)/);
});

test('a finished deletion clears warning memory owned by the deleted alarms', () => {
  const forget = blockIn(OWNER.schedule, 'const forgetDeletedAlarms', 'setRefillFailedAlarmIds(new Set())');
  assert.match(forget, /reportedScheduleProblemsRef\.current = new Set\(\)/);
  const applied = blockIn(OWNER.deletion, 'const applyLocalDataDeleted', 'setCurrentAlarms([])');
  assert.match(applied, /forgetDeletedAlarms\(\)/);
});

test('a refused stop stops sound and the banner itself and never rewrites the alarm list', () => {
  const stop = blockIn(OWNER.ringingActions, 'const stopOccurrence = useCallback', 'const stopRinging');
  const refused = blockIn(
    OWNER.ringingActions,
    'if (isStorageResetPendingError(error) && !stoppedCycle) {',
    '} else if (stoppedCycle) {',
  );
  assert.ok(
    refused.indexOf('stopForegroundAlarmSound()') <
      refused.indexOf('setDeletionPending(true)'),
  );
  assert.match(refused, /dismissDeliveredNotification\(cycle\.mainAlarmId\)/);
  assert.doesNotMatch(refused, /setCurrentAlarms/);
  assert.match(refused, /noticeFromCodeIn\(messagesNow\(\), 'STOP_RESET_PENDING'\)/);
  // The stop record itself is only written by the locked snooze service.
  assert.doesNotMatch(stop, /saveStoredAlarm\(/);
});

const RECONCILE_ONCE = [
  OWNER.queueReconciler,
  'async function reconcileScheduleWithQueueOnce',
  '/** Concurrent callers',
] as const;

test('queue reconciliation serialises against stops and user cancellations', () => {
  const fn = blockIn(...RECONCILE_ONCE);
  // Order: suppression lock, then the storage queue, then the OS queue read.
  const exclusive = fn.indexOf('deps.exclusive(');
  const transact = fn.indexOf('deps.storage.transact(');
  const inspect = fn.indexOf('readQueue: deps.readQueue');
  assert.ok(exclusive !== -1 && exclusive < transact);
  assert.ok(transact < inspect, 'the OS queue is read inside the storage turn');
  // Unfinished cancels and half-done stops exclude their alarm.
  assert.match(fn, /deps\.loadPendingAlarmCancellations\(\)/);
  assert.match(fn, /deps\.loadSuppressionIntents\(\)/);
  assert.match(fn, /excludedAlarmIds/);
  assert.doesNotMatch(fn, /listScheduledNotificationIds/);
  // The injected edges are the real suppression lock, storage turn and the
  // content-aware queue reader.
  const wiring = blockIn(OWNER.coordinators, 'export const reconcileScheduleWithQueue', '/** One refill coordinator');
  assert.match(wiring, /exclusive: \(run\) => suppressionJournal\.exclusive\(run\)/);
  assert.match(wiring, /transact: transactAlarmDefinitions/);
  assert.match(wiring, /readQueue: readScheduledNotificationQueue/);
  assert.doesNotMatch(wiring, /listScheduledNotificationIds/);
  assert.match(wiring, /orphans: orphanStore/);
});

test('an aborted reconciliation re-reads the durable checkpoint before any refill', () => {
  const fn = blockIn(...RECONCILE_ONCE);
  const catchBlock = fn.slice(fn.lastIndexOf('} catch (error)'));
  assert.match(catchBlock, /recoverAbortedReconciliation\(/);
  assert.match(catchBlock, /deps\.storage\.load/);
  assert.match(catchBlock, /unrecoveredNotificationIds/);
  assert.match(read(OWNER.coordinators), /load: loadAlarmDefinitions/);
  // The recovered state flows into the alarm state; the stale input is not reused.
  const reconcile = blockIn(OWNER.schedule, 'const reconcileWithQueue = useCallback', 'const clearQueueStatus');
  assert.match(reconcile, /unrecoveredNotificationIds/);
  // The refill decision comes from the tested gate, never from `?? restored`.
  const startup = blockIn(...STARTUP);
  assert.doesNotMatch(startup, /\?\? restored/);
  assert.match(startup, /safeToRefill = state\.safeToRefill/);
  assert.match(reconcile, /assessReconciledState\(/);
  assert.match(fn, /aborted: true/);
});

test('queue reconciliation is not re-entered and shares the in-flight run', () => {
  const shared = blockIn(OWNER.queueReconciler, 'export function createQueueReconciler', '\n  };\n}');
  assert.match(shared, /if \(inFlight\)/);
  assert.match(shared, /return inFlight/);
  assert.match(shared, /inFlight = null/);
  // One shared run for the whole app: the reconciler is created once at module level.
  assert.equal(countIn(OWNER.coordinators, /createQueueReconciler\(/g), 1);
  assert.match(read(OWNER.coordinators), /export const reconcileScheduleWithQueue = createQueueReconciler/);
});

test('startup and foreground reconcile with the OS queue before refilling', () => {
  const startup = blockIn(...STARTUP);
  assert.ok(
    startup.indexOf('markDueCyclesRinging(') <
      startup.indexOf('reconcileWithQueue('),
  );
  const foreground = blockIn(...FOREGROUND);
  assert.ok(
    foreground.indexOf('reconcileWithQueue(') <
      foreground.indexOf("'foreground'"),
  );
});

test('rows show the OS-queue verification instead of claiming a reservation', () => {
  assert.match(read(OWNER.list), /queueStatus: queueStatuses\[definition\.id\]/);
  assert.match(read(OWNER.home), /queueStatuses=\{queueStatuses\}/);
});

test('a pending storage reset is checked before any reconcile, recovery or refill', () => {
  const reconcile = blockIn(...RECONCILE_ONCE);
  assert.ok(
    reconcile.indexOf('deps.hasPendingReset()') <
      reconcile.indexOf('deps.prepareNotificationsIfGranted()'),
  );
  assert.ok(
    reconcile.lastIndexOf('deps.hasPendingReset()') <
      reconcile.indexOf('deps.reconcileSchedules('),
  );
  const refill = blockIn(OWNER.refill, 'async function refillEnabledSchedulesOnce', 'fillEnabledSchedules(');
  assert.match(refill, /deps\.hasPendingReset\(\)/);
  const foreground = blockIn(...FOREGROUND);
  assert.ok(
    foreground.indexOf('storageReset.hasPendingReset()') <
      foreground.indexOf('reconcileSuppressions()'),
  );
});

test('an obsolete reconciliation never restores queue status or warnings after a deletion', () => {
  const reconcile = blockIn(OWNER.schedule, 'const reconcileWithQueue = useCallback', 'const clearQueueStatus');
  assert.ok(
    reconcile.indexOf('isObsoleteReconcileResult(result)') <
      reconcile.indexOf('setQueueStatuses(result.statuses)'),
  );
  const forget = blockIn(OWNER.schedule, 'const forgetDeletedAlarms', 'return {');
  assert.match(forget, /reportedQueueProblemsRef\.current = new Set\(\)/);
  assert.match(forget, /setQueueStatuses\(\{\}\)/);
  const fn = blockIn(...RECONCILE_ONCE);
  const zoneSave = fn.slice(fn.indexOf('if (settled'), fn.indexOf('if (settled') + 120);
  assert.match(zoneSave, /isStaleStorageResult\(alarms\)/);
  assert.match(fn, /await deps\.assertNoPendingReset\(\)/);
});

test('sun background hook is called unconditionally and feeds the theme', () => {
  const controller = read(OWNER.controller);
  const hook = controller.indexOf('useSunBackground(nowMs, sunStorageCoordination)');
  assert.notEqual(hook, -1);
  const theme = blockIn(OWNER.controller, 'const circadianTheme = useMemo', 'useDeviceText');
  assert.match(theme, /getCircadianTheme\(new Date\(nowMs\), sun\.schedule\)/);
  assert.match(theme, /\[localMinuteKey, sun\.schedule\]/);
  // Not inside any condition, loop or callback: the line is a top-level const.
  assert.match(controller, /\n  const sun = useSunBackground\(/);
  assert.equal(countIn(OWNER.controller, /useSunBackground\(/g), 1);
  // The shared storage lock/gate is one module-level object (stable identity).
  assert.match(
    read(OWNER.gateways),
    /\nexport const sunStorageCoordination = \{[^}]*assertWritable: assertNoPendingReset/s,
  );
});

test('sunrise settings live inside the shared settings modal', () => {
  const modal = blockIn(OWNER.settingsSheet, '<SettingsModal', '</SettingsModal>');
  assert.match(modal, /<SunriseSettings/);
  const total = appSources.reduce(
    (sum, name) => sum + countIn(name, /<SettingsModal/g),
    0,
  );
  assert.equal(total, 1);
});

test('confirmed deletion invalidates the sun lookup before awaiting and settles it after', () => {
  for (const [start, end, call] of [
    ['const performStorageReset = useCallback', 'const performLocalDataDeletion', 'await storageReset.reset()'],
    ['const performLocalDataDeletion = useCallback', 'const confirmLocalDataDeletion', 'await deleteAllLocalData(storageReset)'],
  ] as const) {
    const body = blockIn(OWNER.deletion, start, end);
    const begin = body.indexOf('sun.beginDeletion()');
    assert.notEqual(begin, -1, start);
    assert.ok(begin < body.indexOf(call), `${start}: invalidate before reset`);
    assert.match(body, /sun\.completeDeletion\(\)/);
    assert.match(body, /sun\.failDeletion\(\)/);
  }
});

test('sun callbacks are stable so effects and permission never loop', () => {
  const hook = read('src/useSunBackground.ts');
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

test('edit re-checks the lock at run time and runs under the suppression lock', () => {
  const edit = blockIn(OWNER.mutations, 'const editAlarm = useCallback', 'const confirmDeleteAlarm');
  assert.match(edit, /runUnlessAlarmListLocked/);
  assert.match(edit, /getAlarms: \(\) => alarmsRef\.current/);
  assert.match(edit, /nowMs: Date\.now/);
  const persist = blockIn(
    OWNER.alarmServices,
    'export async function editAlarmPersistently',
    'export async function recoverPendingAlarmEdits',
  );
  assert.match(persist, /suppressionJournal\.exclusive/);
  assert.match(persist, /transactAlarmDefinitions/);
  assert.match(persist, /editAlarmDefinition\(/);
  // Only the edited alarm's own recorded ids are cancelled, never "all".
  for (const name of appSources) {
    assert.doesNotMatch(read(name), /cancelAllScheduledNotificationsAsync/, name);
  }
});

test('startup settles unfinished edits before suppressions, and refill skips them', () => {
  const startup = blockIn(...STARTUP);
  const editRecovery = startup.indexOf('recoverPendingAlarmEdits()');
  assert.notEqual(editRecovery, -1);
  assert.ok(editRecovery < startup.indexOf('reconcileSuppressions()'));
  assert.ok(editRecovery < startup.indexOf('markDueCyclesRinging('));
  const refill = blockIn(OWNER.refill, 'async function refillEnabledSchedulesOnce', 'catch (error)');
  assert.match(refill, /deps\.loadPendingAlarmEdits\(\)/);
});

test('the composer is opened for an edit only through the guarded handler', () => {
  const list = read(OWNER.list);
  assert.match(list, /messages\.edit\.editSpoken\(/);
  assert.match(ja.edit.editSpoken('7:00', '毎日'), /のアラームを編集/);
  assert.match(en.edit.editSpoken('7:00', 'Daily'), /Edit the 7:00 alarm/);
  assert.match(list, /onPress=\{\(\) => void openEditComposer\(definition\)\}/);
  const open = blockIn(OWNER.mutations, 'const openEditComposer = useCallback', 'const editAlarm = useCallback');
  assert.match(open, /runUnlessAlarmListLocked/);
  // The screen is handed the guarded handler, never the form setters.
  assert.match(read(OWNER.controller), /openEditComposer: mutations\.openEditComposer/);
});

test('the edit reads a fresh clock after its locks and after the permission prompt', () => {
  const persist = blockIn(
    OWNER.alarmServices,
    'export async function editAlarmPersistently',
    'export async function recoverPendingAlarmEdits',
  );
  assert.match(persist, /now: Date\.now/);
  assert.doesNotMatch(persist, /nowMs/);
  const perform = blockIn(
    OWNER.mutations,
    'const performEditAlarm = useCallback',
    'const openEditComposer',
  );
  assert.ok(
    perform.indexOf('await prepareNotifications()') <
      perform.indexOf('const editedAtMs = Date.now()'),
    'the clock must be read after the permission prompt',
  );
  assert.doesNotMatch(perform, /nowMs: editedAtMs/);
});

test('requested notification ids reach expo-notifications as `identifier`', () => {
  const service = read('src/notificationService.ts');
  // Main, check-in and snooze requests all pass their stored id through.
  assert.equal(service.match(/identifier: input\.identifier/g)?.length, 3);
});

test('a pending reset blocks edit recovery and new edits', () => {
  const startup = blockIn(OWNER.lifecycle, 'let cancellationRecoveryFailed = false;', 'await refillEnabledSchedules');
  assert.ok(
    startup.indexOf('storageReset.hasPendingReset()') <
      startup.indexOf('recoverPendingAlarmEdits()'),
  );
  const persist = blockIn(
    OWNER.alarmServices,
    'export async function editAlarmPersistently',
    'export async function recoverPendingAlarmEdits',
  );
  assert.match(persist, /await assertNoPendingReset\(\)/);
  assert.ok(
    persist.indexOf('assertNoPendingReset()') <
      persist.indexOf('transactAlarmDefinitions'),
  );
  // The reset lock must not be taken again from inside the edit.
  assert.doesNotMatch(persist, /storageReset\.reset\(/);
});

test('edit recovery takes the suppression lock before the storage queue', () => {
  const recover = blockIn(
    OWNER.alarmServices,
    'export async function recoverPendingAlarmEdits',
    'export async function recoverPendingAlarmCancellations',
  );
  assert.ok(
    recover.indexOf('suppressionJournal.exclusive') <
      recover.indexOf('transactAlarmDefinitions'),
  );
});

test('queue reconciliation leaves alarms with an unsettled edit alone', () => {
  const fn = blockIn(...RECONCILE_ONCE);
  assert.match(fn, /deps\.loadPendingAlarmEdits\(\)/);
});

test('an edit refused by a pending reset surfaces the deletion state', () => {
  const perform = blockIn(OWNER.mutations, 'const performEditAlarm = useCallback', 'const openEditComposer');
  assert.match(perform, /reportResetPending\(error\)/);
});

test('edit success and add open are wired to the composer/queue state helpers', () => {
  const perform = blockIn(OWNER.mutations, 'const performEditAlarm', 'const openEditComposer');
  assert.match(perform, /clearQueueStatus\(alarmId\)/);
  assert.match(read(OWNER.composerForm), /resolveComposerValues\(\{\s*mode: 'add'/);
  assert.match(read(OWNER.homeView), /canSubmitComposer\(\{/);
  assert.match(read(OWNER.list), /disabled=\{!editAvailable\}/);
});

test('startup re-arms snoozes before overdue cycles are classified, on launch and resume', () => {
  const startup = blockIn(...STARTUP);
  assert.ok(
    startup.indexOf('recoverPendingAlarmEdits()') <
      startup.indexOf('recoverSnoozes()'),
  );
  assert.ok(
    startup.indexOf('recoverSnoozes()') < startup.indexOf('markDueCyclesRinging('),
  );
  assert.ok(
    startup.indexOf('recoverSnoozes()') < startup.indexOf('reconcileWithQueue('),
  );
  const resume = blockIn(
    OWNER.lifecycle,
    "const reconciled = await reconcileSuppressions();\n        setSuppressionWarning(",
    "if (alarmsRef.current.some((alarm) => alarm.enabled))",
  );
  assert.ok(
    resume.indexOf('recoverSnoozes()') < resume.indexOf('markDueCyclesRinging('),
  );
});

test('stop and snooze go through the shared snooze service, never raw cancellation', () => {
  const stop = blockIn(OWNER.ringingActions, 'const stopOccurrence = useCallback', 'const stopRinging');
  assert.match(stop, /snoozeService\.stop\(cycle\.cycleId\)/);
  const snooze = blockIn(OWNER.ringingActions, 'const snoozeRinging = useCallback', 'return { acknowledgeMissed');
  assert.match(snooze, /snoozeService\.snooze\(ringingCycle\.cycleId/);
  // Success is announced only on the snoozed result.
  assert.ok(
    snooze.indexOf("result.status === 'snoozed'") <
      snooze.indexOf('presentSnoozed('),
  );
  // A refused snooze keeps the alarm ringing and surfaces the deletion state.
  assert.match(snooze, /isStorageResetPendingError\(error\)/);
});

test('snooze, stop and recovery run in one suppression-then-storage transaction', () => {
  const service = blockIn(OWNER.gateways, 'export const snoozeService = createSnoozeService', '// Order matches the stop path');
  assert.match(service, /transact: createSnoozeTransaction\(\{/);
  assert.match(service, /exclusive: \(run\) => suppressionJournal\.exclusive\(run\)/);
  assert.match(service, /transact: transactAlarmDefinitions/);
  // The storage queue is never re-entered from the service.
  assert.doesNotMatch(service, /runExclusiveAlarmStorage/);
  assert.match(read(OWNER.schedule), /snoozeService\.recover\(\)/);
});

test('a delivered alarm notification is applied to the latest stored state', () => {
  const received = blockIn(OWNER.notificationEvents, 'onReceived: (notification) => {', 'const lastResponse');
  assert.match(received, /saveCycleRinging\(/);
  assert.match(received, /notification\.request\.identifier/);
  // One transition only: no second ringing path and no earlier copy written back.
  assert.doesNotMatch(received, /markDeliveredCycleRinging|transactAlarmDefinitions/);
  assert.doesNotMatch(received, /saveStoredAlarm|loadStoredAlarmByCycleId/);
});

test('the list lock covers a waiting snooze and says so', () => {
  assert.match(read(OWNER.homeView), /isAlarmListLocked\(ringingCycle \?\? snoozedCycle\)/);
  const notify = blockIn(OWNER.mutations, 'const notifyListLocked', 'Both read the latest alarms');
  assert.match(notify, /reason === 'snoozed'/);
});

test('the ringing card keeps stop first and snooze second, both pressable', () => {
  const card = read(OWNER.ringingCard);
  assert.ok(card.indexOf('stopRinging()') < card.indexOf('snoozeRinging()'));
  assert.match(card, /minHeight|styles\.snoozeButton/);
});

test('Android channel delivery wiring', () => {
  const service = read('src/notificationService.ts');
  const read_ = service.slice(
    service.indexOf('export async function readNotificationDelivery'),
    service.indexOf('Android keeps an absolute'),
  );

  assert.match(read_, /mainChannelId: ALARM_CHANNEL_ID/);
  assert.doesNotMatch(read_, /CHECK_IN_CHANNEL_ID|requestPermissionsAsync|setNotificationChannelAsync/);
  assert.match(read_, /getNotificationChannelAsync/);
});

test('a delivered main notification rings through the atomic transition only', () => {
  const listener = blockIn(OWNER.notificationEvents, 'onReceived: (notification) => {', 'const lastResponse');
  assert.match(listener, /saveCycleRinging\(/);
  assert.match(listener, /saveCycleRinging\(\s*identity,\s*Date\.now,\s*\)/);
  assert.doesNotMatch(listener, /Date\.now\(\)/);
  assert.match(listener, /notification\.request\.identifier/);
  assert.doesNotMatch(listener, /loadStoredAlarmByCycleId|saveStoredAlarm/);
});

test('a failed delivery save reports a pending deletion instead of a generic failure', () => {
  const listener = blockIn(OWNER.notificationEvents, 'onReceived: (notification) => {', 'const lastResponse');
  const caught = listener.slice(listener.indexOf('.catch('));
  assert.match(caught, /reportResetPending\(error\)/);
  assert.ok(
    caught.indexOf('reportResetPending(error)') <
      caught.indexOf('ringing.persistFailed'),
  );
  assert.match(read(OWNER.notificationEvents), /\[handleAwakeResponse, isLoaded, reportResetPending, setCurrentAlarms\]/);
});

test('the stored origin zone advances only through the shared gate, in the zone the run planned for', () => {
  const reconcile = blockIn(...RECONCILE_ONCE);
  assert.match(reconcile, /currentZone: zone,/);
  assert.match(reconcile, /originZone: storedZone,/);
  assert.match(reconcile, /canAdvancePlanningZone\(\{/);
  assert.match(reconcile, /currentPlanningZone\(\) === zone/);
  // Not the old "every status settled" test, which an empty result satisfies.
  assert.doesNotMatch(reconcile, /Object\.values\(statuses\)\.every/);
});

test('every refill path hands the stored origin zone to the fill', () => {
  const owners = [OWNER.refill, OWNER.schedule, OWNER.mutations];
  const calls = owners.reduce((sum, name) => sum + countIn(name, /fillAlarmDefinitionSchedule\(/g), 0);
  const withOrigin =
    countIn(OWNER.coordinators, /loadPlanningZone\(AsyncStorage\)/g) +
    countIn(OWNER.schedule, /await loadPlanningZone\(AsyncStorage\)/g) +
    countIn(OWNER.mutations, /await loadPlanningZone\(AsyncStorage\)/g);
  // refill (via fillEnabledSchedules), completion refill, enable, and the new
  // alarm, which has no history and so no origin zone.
  assert.equal(calls, 4);
  assert.equal(countIn(OWNER.refill, /fillAlarmDefinitionSchedule\(/g), 1);
  assert.equal(countIn(OWNER.schedule, /fillAlarmDefinitionSchedule\(/g), 1);
  assert.equal(countIn(OWNER.mutations, /fillAlarmDefinitionSchedule\(/g), 2);
  // Reconcile and refill read it through the coordinators; completion refill
  // and enable read it themselves.
  assert.ok(withOrigin >= 4, `origin zone read ${withOrigin} times`);
  assert.match(read(OWNER.refill), /await deps\.loadPlanningZone\(\)/);
  const refill = blockIn(OWNER.refill, 'async function fillEnabledSchedules', 'async function refillEnabledSchedulesOnce');
  assert.match(refill, /unverifiedAlarmIds/);
});

test('unverified main ids are journaled, block retries, and reconcile/reset resolve them', () => {
  assert.match(read(OWNER.gateways), /withMainVerification\([\s\S]*?orphans: orphanStore/);
  assert.match(read(OWNER.gateways), /scheduleMain: schedulingGateway\.scheduleMainForReconcile/);
  assert.match(read(OWNER.queueReconciler), /await deps\.flushUnresolved\(\)/);
  assert.match(read(OWNER.coordinators), /flushUnresolved: \(\) => schedulingGateway\.flushUnresolved\(\)/);
});

test('edit failures and rollbacks go through the catalog and the durable record', () => {
  const perform = blockIn(OWNER.mutations, 'const performEditAlarm = useCallback', 'const openEditComposer');
  assert.doesNotMatch(perform, /error\.message|error instanceof Error/);
  assert.match(perform, /describeErrorIn\(messagesNow\(\), error\)/);
  assert.match(perform, /noticeFromCodeIn\(messagesNow\(\), 'EDIT_CLEANUP_PENDING'\)/);
  // Every add/enable/refill rollback records ids it could not cancel.
  const owners = [OWNER.refill, OWNER.schedule, OWNER.mutations];
  const callers = owners.reduce(
    (sum, name) => sum + countIn(name, /withScheduledNotificationRollback\(/g),
    0,
  );
  const recording = owners.reduce(
    (sum, name) =>
      sum +
      countIn(
        name,
        /(?:cancellationGateway,\s+orphanStore,\s+schedulingGateway,|deps\.cancellation,\s+deps\.orphans,\s+deps\.scheduling,)\s+\)/g,
      ),
    0,
  );
  assert.equal(callers, 4);
  assert.equal(recording, callers);
});

test('cancellation failure copy is shown only when the resume record exists', () => {
  assert.match(read(OWNER.alarmServices), /export async function cancellationFailureNotice/);
  for (const name of appSources) {
    const text = read(name);
    assert.doesNotMatch(text, /setNotice\(noticeFromCodeIn\([^)]*'DELETE_CANCEL_INCOMPLETE'\)\)/, name);
    assert.doesNotMatch(text, /:\s*noticeFromCodeIn\([^)]*'DISABLE_CANCEL_INCOMPLETE'\)/, name);
  }
});

test('a saved stop is shown before the refill, and a refill failure is not a failed stop', () => {
  const stop = blockIn(OWNER.ringingActions, 'const stopOccurrence = useCallback', 'const stopRinging');
  assert.match(stop, /presentStopped\(\s*result,/);
  assert.match(stop, /getSnoozeCopy\.stopFailureCode\(result\.reason\)/);
  assert.match(stop, /noticeFromCodeIn\(messagesNow\(\), 'STOP_FOLLOWUP_FAILED'\)/);
  assert.doesNotMatch(stop, /STOP_CANCEL_FAILED|error\.message|refillError/);
});

test('snooze outcomes use catalog codes and a saved snooze survives a failed read-back', () => {
  const snooze = blockIn(OWNER.ringingActions, 'const snoozeRinging = useCallback', 'return { acknowledgeMissed');
  assert.match(snooze, /presentSnoozed\(result, outcomeEffects\(\), textRef\.current\)/);
  assert.match(
    snooze,
    /presentSnoozeRejected\(result, outcomeEffects\(\), textRef\.current\)/,
  );
  assert.match(snooze, /noticeFromCodeIn\(messagesNow\(\), 'SNOOZE_RESET_PENDING'\)/);
  assert.doesNotMatch(snooze, /error\.message|端末の通知を確認|loadAlarmDefinitions/);
});

test('reset also cancels every id only memory knows, and recovery maps its outcome by code', () => {
  const reset = blockIn(OWNER.gateways, 'export const storageReset = createStorageResetService', 'installStorageResetGate');
  assert.match(reset, /snoozeService\.unsettledIds\(\)/);
  assert.match(reset, /schedulingGateway\.unresolvedMainIds\(\)/);
  assert.match(read(OWNER.schedule), /getSnoozeCopy\.recoveryCode\(outcome\)/);
});

test('the reconcile pass releases its main ids at the checkpoint and abandons the rest when it ends', () => {
  assert.match(read(OWNER.gateways), /releaseMain: \(ids\) => schedulingGateway\.releaseProvisional\(ids\)/);
  const pass = blockIn(...RECONCILE_ONCE);
  assert.match(pass, /gateway: passGateway/);
  assert.match(pass, /finally \{\s*deps\.abandonProvisional\(registered\);/);
  assert.match(read(OWNER.coordinators), /abandonProvisional: \(ids\) => schedulingGateway\.abandonProvisional\(\[\.\.\.ids\]\)/);
});

test('missed acknowledgement shows the aggregate notice, not the last refill side effect', () => {
  const ack = blockIn(OWNER.ringingActions, 'const acknowledgeMissed = useCallback', 'const outcomeEffects');
  assert.match(ack, /getMissedAcknowledgementNotice\(/);
  assert.match(ack, /getMissedAcknowledgementNotice\([^)]*messagesNow\(\)/);
  assert.match(ack, /collectedIssues|refillIssues/);
  assert.doesNotMatch(ack, /result\.refillSeverity === 'none'/);
});

test('the ringing display and focused label use the occurrence date and current ring time', () => {
  const card = read(OWNER.ringingCard);
  assert.match(card, /getRingingDisplay\(ringingCycle\)/);
  assert.match(card, /getRingingStopA11yLabel\([\s\S]*formatter\.day\(/);
  assert.doesNotMatch(card, /formatNextDate/);
});

test('missed cycles are announced by tracked ids without moving focus', () => {
  const presentation = read(OWNER.ringingPresentation);
  assert.match(presentation, /planMissedAnnouncement\(/);
  assert.match(presentation, /announcePolitely\(messagesNow\(\)\.missed\.cardAnnouncement\)/);
  for (const name of appSources) {
    assert.doesNotMatch(read(name), /MISSED_CARD_ANNOUNCEMENT/, name);
  }
  const effect = blockIn(OWNER.ringingPresentation, 'planMissedAnnouncement({', 'missed.cardAnnouncement');
  assert.doesNotMatch(effect, /setAccessibilityFocus/);
  assert.match(presentation, /\[missedCycleIdsKey, ringingCycle !== null, isAppActive\]/);
  // The announcement edge never moves focus either.
  const edge = blockIn(OWNER.accessibilityEdge, 'export function announcePolitely', '\n}\n');
  assert.doesNotMatch(edge, /setAccessibilityFocus/);
});

test('missed announcements queue on iOS and wait for the app to be active', () => {
  const edge = blockIn(OWNER.accessibilityEdge, 'export function announcePolitely', '\n}\n');
  // iOS queues behind current speech; Android keeps the existing API.
  assert.match(edge, /Platform\.OS === 'ios'/);
  assert.match(edge, /announceForAccessibilityWithOptions\(text, \{ queue: true \}\)/);
  assert.match(edge, /announceForAccessibility\(text\)/);
  assert.match(edge, /Platform\.OS === 'web'/);
  // Only a real `active` state announces; inactive/background stay pending.
  const bedside = read(OWNER.bedside);
  assert.match(bedside, /setIsAppActive\(state === 'active'\)/);
  assert.match(bedside, /useState\(\s*\(\) => currentAppState\(\) === 'active',?\s*\)/);
  const gate = blockIn(OWNER.ringingPresentation, 'const missedAnnouncedRef', 'planMissedAnnouncement({');
  assert.match(gate, /if \(!isAppActive\)\s*\{\s*return;/);
  assert.match(read(OWNER.ringingPresentation), /\[missedCycleIdsKey, ringingCycle !== null, isAppActive\]/);
  // Keep-awake policy is unchanged and the AppState subscription is shared.
  assert.match(bedside, /setIsAppForeground\(isForegroundAppState\(state\)\)/);
  assert.equal(bedside.match(/setIsAppActive\b/g)?.length, 2);
});

test('settings close is guarded by the deletion ref and a failed deletion also reaches home in the chosen language', () => {
  const deletion = read(OWNER.deletion);
  assert.match(deletion, /canCloseSettings\(\{ deletionInFlight: deletionInFlightRef\.current \}\)/);
  assert.match(read(OWNER.settingsSheet), /onClose=\{closeSettings\}/);
  assert.match(read(OWNER.app), /closeSettings=\{settings\.close\}/);
  assert.match(deletion, /setSettingsNotice\(\{ text: \(m\) => m\.settings\.failed \}\)/);
  assert.match(deletion, /text: t\.messages\.settings\.failedHome/);
  for (const name of appSources) {
    assert.doesNotMatch(read(name), /LOCAL_DATA_COPY/, name);
  }
});

test('the screen scroll policy still drives the failure-card scroll', () => {
  assert.match(read(OWNER.app), /getScreenScrollPolicy\(/);
});

test('no conflict markers remain in the app entry or its modules', () => {
  for (const name of appSources) {
    assert.doesNotMatch(read(name), /^(<<<<<<<|=======|>>>>>>>)/m, name);
  }
});
