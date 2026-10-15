/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ScheduledNotificationRollbackError,
  withScheduledNotificationRollback,
} from '../src/alarmScheduleRollback';
import type { StoredAlarm } from '../src/alarmStorage';

function cycle(): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: 'cycle-1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: 1_000,
    dueAtMs: 10_000,
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

test('a persistence failure rolls back every notification ID created by the operation', async () => {
  const original = new Error('storage unavailable');
  const cancelled: string[] = [];

  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        track([cycle()]);
        throw original;
      },
      {
        async cancelScheduled(notificationId) {
          if (notificationId) {
            cancelled.push(notificationId);
          }
        },
      },
    ),
    (error) => error === original,
  );

  assert.deepEqual(cancelled, ['check-1', 'main-1']);
});

test('rollback attempts all IDs and exposes any notification that may remain', async () => {
  const attempted: string[] = [];

  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        track([cycle()]);
        throw new Error('storage unavailable');
      },
      {
        async cancelScheduled(notificationId) {
          if (!notificationId) {
            return;
          }
          attempted.push(notificationId);
          if (notificationId === 'check-1') {
            throw new Error('still scheduled');
          }
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof ScheduledNotificationRollbackError);
      assert.deepEqual(error.failures, [
        { notificationId: 'check-1', code: 'NOTIFICATION_CANCEL_UNVERIFIED' },
      ]);
      return true;
    },
  );

  assert.deepEqual(attempted, ['check-1', 'main-1']);
});

test('a successful persistence operation never cancels its notifications', async () => {
  const cancelled: string[] = [];
  const result = await withScheduledNotificationRollback(
    async (track) => {
      track([cycle()]);
      return 'saved';
    },
    {
      async cancelScheduled(notificationId) {
        if (notificationId) {
          cancelled.push(notificationId);
        }
      },
    },
  );

  assert.equal(result, 'saved');
  assert.deepEqual(cancelled, []);
});

test('failed rollback ids are recorded durably and only then reported as recorded', async () => {
  const recorded: string[][] = [];
  const failing = {
    async cancelScheduled(notificationId: string | undefined) {
      if (notificationId === 'check-1') throw new Error('still scheduled');
    },
  };
  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        track([cycle()]);
        throw new Error('storage unavailable');
      },
      failing,
      { add: async (ids) => void recorded.push(ids) },
    ),
    (error) => {
      assert.ok(error instanceof ScheduledNotificationRollbackError);
      assert.equal(error.recorded, true);
      assert.equal(error.code, 'ROLLBACK_INCOMPLETE_RECORDED');
      return true;
    },
  );
  assert.deepEqual(recorded, [['check-1']]);

  await assert.rejects(
    withScheduledNotificationRollback(
      async (track) => {
        track([cycle()]);
        throw new Error('storage unavailable');
      },
      failing,
      {
        add: async () => {
          throw new Error('journal unavailable');
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof ScheduledNotificationRollbackError);
      assert.equal(error.recorded, false, 'a failed record is never claimed');
      assert.equal(error.code, 'ROLLBACK_INCOMPLETE');
      return true;
    },
  );
});
