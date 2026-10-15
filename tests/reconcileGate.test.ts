/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { makeAlarmRepeat } from '../src/alarmSchedule';
import { ScheduledNotificationRollbackError } from '../src/alarmScheduleRollback';
import type { StoredAlarmDefinition } from '../src/alarmStorage';
import {
  assessReconciledState,
  isObsoleteReconcileResult,
  type ScheduleReconcileResult,
} from '../src/reconcileGate';
import {
  advanceStorageEpoch,
  assertNoPendingReset,
  installStorageResetGate,
  StorageResetPendingError,
  stampStorageResult,
} from '../src/storageResetGate';
import { recoverAbortedReconciliation } from '../src/scheduleReconciliation';

const def = (id: string): StoredAlarmDefinition => ({
  id,
  hour: 7,
  minute: 0,
  repeat: makeAlarmRepeat('daily', 0),
  enabled: true,
  createdAtMs: 0,
  cycles: [],
});
const known = [def('known')];
const reloaded = [def('reloaded')];

const result = (overrides: Partial<ScheduleReconcileResult> = {}): ScheduleReconcileResult => ({
  alarms: reloaded,
  statuses: { reloaded: 'verified' },
  repaired: 0,
  replanned: 0,
  zoneChanged: false,
  unrecoveredNotificationIds: [],
  aborted: false,
  queueVerified: true,
  orphansUnreadable: false,
  ...overrides,
});

describe('assessReconciledState: refill only from a fresh, verified state', () => {
  test('an orphan whose cancellation is unconfirmed blocks the refill', () => {
    const gate = assessReconciledState(result({ pendingOrphanIds: ['orphan-1'] }), known);
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'orphans_pending');
    assert.equal(gate.freshness, 'fresh');
  });

  test('an unreadable orphan journal blocks the refill', () => {
    const gate = assessReconciledState(result({ orphansUnreadable: true }), known);
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'orphans_unreadable');
    assert.equal(gate.freshness, 'fresh');
  });

  test('a completed reconciliation with a read queue is safe and supplies the saved alarms', () => {
    const gate = assessReconciledState(result(), known);
    assert.equal(gate.freshness, 'fresh');
    assert.equal(gate.safeToRefill, true);
    assert.equal(gate.alarms, reloaded);
  });

  test('not run (web) is skipped: nothing is claimed and no refill is licensed', () => {
    const gate = assessReconciledState(null, known);
    assert.equal(gate.freshness, 'skipped');
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.alarms, known);
  });

  test('an aborted run whose durable state could not be reloaded is stale and never refills', async () => {
    const aborted = await recoverAbortedReconciliation(
      new Error('boom'),
      async () => { throw new Error('storage'); },
      known,
    );
    const gate = assessReconciledState(
      result({ alarms: aborted.alarms, statuses: aborted.statuses, aborted: true, queueVerified: false }),
      known,
    );
    assert.equal(gate.freshness, 'stale');
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'reload_failed');
    assert.equal(gate.alarms, known, 'the stale in-memory list is kept for display only');
  });

  test('an aborted run is not trusted even when the checkpoint could be reloaded', () => {
    const gate = assessReconciledState(result({ aborted: true, queueVerified: false }), known);
    assert.equal(gate.freshness, 'fresh');
    assert.equal(gate.alarms, reloaded);
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'aborted');
  });

  test('ids a failed rollback left in the OS queue block the refill until recovered', async () => {
    const error = new ScheduledNotificationRollbackError(new Error('save'), [
      { notificationId: 'n-1', message: 'x' },
    ]);
    const aborted = await recoverAbortedReconciliation(error, async () => reloaded, known);
    const gate = assessReconciledState(
      result({
        alarms: aborted.alarms,
        unrecoveredNotificationIds: aborted.unrecoveredNotificationIds,
        aborted: true,
      }),
      known,
    );
    assert.equal(gate.safeToRefill, false);
    // Even a run that finished must not refill while orphans are unresolved.
    const finished = assessReconciledState(
      result({ unrecoveredNotificationIds: ['n-1'] }),
      known,
    );
    assert.equal(finished.safeToRefill, false);
    assert.equal(finished.reason, 'unrecovered_notifications');
  });

  test('an unreadable OS queue means the refill would be blind: not safe', () => {
    const gate = assessReconciledState(result({ queueVerified: false }), known);
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'queue_unverified');
  });

  test('an unfinished stop or cancellation blocks the refill regardless of the result', () => {
    const gate = assessReconciledState(result(), known, { cancellationPending: true });
    assert.equal(gate.safeToRefill, false);
    assert.equal(gate.reason, 'cancellation_pending');
  });
});

describe('reconciliation results obsolete after a finished deletion', () => {
  test('a result read before the reset is dropped and blocks any refill', () => {
    const stale = stampStorageResult([def('deleted')]);
    const obsolete = result({ alarms: stale, statuses: { deleted: 'verified' } });
    advanceStorageEpoch();
    assert.equal(isObsoleteReconcileResult(obsolete), true);
    const state = assessReconciledState(obsolete, known);
    assert.equal(state.freshness, 'stale');
    assert.equal(state.safeToRefill, false);
    assert.equal(state.reason, 'storage_reset');
    assert.deepEqual(state.alarms, known);
  });

  test('a result produced after the reset is still usable', () => {
    advanceStorageEpoch();
    const fresh = result({ alarms: stampStorageResult([def('new')]) });
    assert.equal(isObsoleteReconcileResult(fresh), false);
    assert.equal(assessReconciledState(fresh, known).safeToRefill, true);
  });

  test('a pending reset refuses the retry instead of reloading old data', async () => {
    installStorageResetGate(async () => true);
    try {
      await assert.rejects(assertNoPendingReset(), StorageResetPendingError);
    } finally {
      installStorageResetGate(async () => false);
    }
  });
});
