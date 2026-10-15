/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAlarmRepeat } from '../src/alarmSchedule';
import type { StoredAlarmDefinition } from '../src/alarmStorage';
import {
  createRefillCoordinator,
  type RefillCoordinatorDeps,
  type ScheduleRefillResult,
} from '../src/app/core/refillCoordinator';
import { en, ja } from '../src/i18n';
import { relocalizeNotice } from '../src/i18n/localizedNotice';
import type { AppNotice } from '../src/ui/NoticeBanner';
import { EN_TEXT, JA_TEXT } from './support/text';
import {
  advanceStorageEpoch,
  stampStorageResult,
} from '../src/storageResetGate';

const NOW = new Date(2026, 7, 20, 6, 0, 0).getTime();

function alarm(id: string, enabled = true): StoredAlarmDefinition {
  return {
    id,
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled,
    createdAtMs: NOW,
    cycles: [],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Options {
  isSupported?: boolean;
  stored?: StoredAlarmDefinition[];
  granted?: boolean;
  pendingCancellations?: string[];
  pendingEdits?: string[];
  suppressionIntents?: string[] | Error;
  resetPending?: boolean;
  failMain?: boolean;
  prepare?: () => Promise<unknown>;
  mutate?: RefillCoordinatorDeps['storage']['mutate'];
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  let stored = options.stored ?? [alarm('a'), alarm('b')];
  let sequence = 0;
  const deps: RefillCoordinatorDeps = {
    isSupported: options.isSupported ?? true,
    nowMs: () => NOW,
    scheduling: {
      scheduleMain: async ({ alarmId, cycleId }) => {
        calls.push(`main:${alarmId}`);
        if (options.failMain) {
          throw new Error('os refused');
        }
        return `main-${cycleId}-${(sequence += 1)}`;
      },
      scheduleCheckIn: async ({ cycleId }) => `check-${cycleId}`,
      releaseProvisional: async () => undefined,
      abandonProvisional: () => undefined,
    },
    cancellation: {
      cancelScheduled: async (id) => void calls.push(`cancel:${id}`),
    },
    orphans: { add: async () => undefined },
    storage: {
      mutate:
        options.mutate ??
        (async (mutator) => {
          calls.push('mutate');
          stored = stampStorageResult(await mutator(stored));
          return stored;
        }),
    },
    prepareNotifications: async () => {
      calls.push('prepare');
      await options.prepare?.();
    },
    prepareNotificationsIfGranted: async () => {
      calls.push('prepareIfGranted');
      return options.granted ?? true;
    },
    loadPendingAlarmCancellations: async () =>
      (options.pendingCancellations ?? []).map((alarmId) => ({ alarmId })),
    loadPendingAlarmEdits: async () =>
      (options.pendingEdits ?? []).map((alarmId) => ({ alarmId })),
    loadSuppressionIntents: async () => {
      if (options.suppressionIntents instanceof Error) {
        throw options.suppressionIntents;
      }
      return (options.suppressionIntents ?? []).map((alarmId) => ({ alarmId }));
    },
    hasPendingReset: async () => options.resetPending ?? false,
    loadPlanningZone: async () => null,
  };
  const coordinator = createRefillCoordinator(deps);
  const applied: ScheduleRefillResult[] = [];
  const run = (trigger: 'startup' | 'foreground' = 'startup') =>
    coordinator.refill(trigger, stored, en, (result) => {
      applied.push(result);
    });
  return { calls, applied, run, stored: () => stored, coordinator };
}

test('startup may prompt for permission; foreground only refills when it is already granted', async () => {
  const startup = harness();
  await startup.run('startup');
  assert.ok(startup.calls.includes('prepare'));
  assert.ok(!startup.calls.includes('prepareIfGranted'));

  const denied = harness({ granted: false });
  assert.equal(await denied.run('foreground'), null);
  assert.deepEqual(denied.calls, ['prepareIfGranted']);
  assert.deepEqual(denied.applied, []);
});

test('the web build never refills and touches nothing', async () => {
  const web = harness({ isSupported: false });
  assert.equal(await web.run(), null);
  assert.deepEqual(web.calls, []);
});

test('concurrent refills coalesce: the second is dropped while the first is in flight', async () => {
  const gate = deferred();
  const h = harness({ prepare: () => gate.promise });

  const first = h.run();
  const second = await h.run();
  assert.equal(second, null);
  assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);

  gate.resolve();
  const alarms = await first;
  assert.equal(alarms?.length, 2);
  assert.equal(h.applied.length, 1);
});

test('the flight stays held while the caller applies the result, then it is released for a retry', async () => {
  const h = harness();
  let reentered: unknown = 'not called';
  const first = await h.coordinator.refill('startup', h.stored(), en, () => {
    // Runs inside the flight: a second refill must still be refused here.
    void h.coordinator
      .refill('startup', h.stored(), en, () => undefined)
      .then((value) => {
        reentered = value;
      });
  });
  assert.ok(first);
  await Promise.resolve();
  assert.equal(reentered, null);

  const retry = await h.run();
  assert.ok(retry, 'a settled refill does not block the next one');
});

test('a failure reports REFILL_FAILED with the known alarms skipped, releases the flight, and a retry works', async () => {
  let fail = true;
  const h = harness({
    prepare: async () => {
      if (fail) throw new Error('prompt crashed');
    },
  });

  const known = h.stored();
  const failed = await h.coordinator.refill('startup', known, en, (result) => {
    h.applied.push(result);
  });
  assert.equal(failed, null, 'nothing was saved');
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].alarms, null);
  assert.deepEqual(h.applied[0].problemKeys, ['refill_failed:REFILL_FAILED']);
  assert.ok(h.applied[0].notice);
  assert.deepEqual(h.applied[0].attempt.skippedAlarmIds, ['a', 'b']);
  assert.ok(!h.calls.includes('mutate'));

  fail = false;
  const retried = await h.run();
  assert.equal(retried?.length, 2);
  assert.deepEqual(h.applied[1].problemKeys, []);
});

test('alarms with an unfinished cancel, stop or edit are not refilled and are reported skipped', async () => {
  const h = harness({
    stored: [alarm('a'), alarm('b'), alarm('c'), alarm('d')],
    pendingCancellations: ['a'],
    suppressionIntents: ['b'],
    pendingEdits: ['c'],
  });
  await h.run();

  const reserved = h.calls
    .filter((call) => call.startsWith('main:'))
    .map((call) => call.slice('main:'.length));
  assert.ok(reserved.length > 0);
  assert.ok(reserved.every((id) => id === 'd'), `only d may be refilled: ${reserved}`);
  assert.deepEqual([...(h.applied[0].attempt.skippedAlarmIds ?? [])].sort(), ['a', 'b', 'c']);
});

test('an unreadable suppression journal fails closed: no reservation is made', async () => {
  const h = harness({ suppressionIntents: new Error('journal unreadable') });
  assert.equal(await h.run(), null);
  assert.ok(!h.calls.some((call) => call.startsWith('main:')));
  assert.ok(!h.calls.includes('mutate'));
  assert.deepEqual(h.applied[0].problemKeys, ['refill_failed:REFILL_FAILED']);
});

test('an unfinished deletion keeps the stored list and reserves nothing', async () => {
  const h = harness({ resetPending: true });
  const alarms = await h.run();
  assert.equal(alarms?.length, 2);
  assert.ok(!h.calls.some((call) => call.startsWith('main:')));
  assert.deepEqual(h.applied[0].attempt.attemptedAlarmIds, []);
});

test('a result read before a finished deletion is dropped, never applied', async () => {
  const h = harness({
    mutate: async (mutator) => {
      const next = stampStorageResult(await mutator([alarm('a')]));
      advanceStorageEpoch();
      return next;
    },
  });
  assert.equal(await h.run(), null);
  assert.deepEqual(h.applied, []);
  // The flight was released even though the result was discarded.
  const again = await h.run();
  assert.equal(again, null);
});

test('a refill notice for failed reservations is rewritten in a new language with its code and tone', async () => {
  const h = harness({ failMain: true });
  await h.run();

  const before = h.applied[0].notice;
  assert.ok(before, 'the failed reservation is reported');
  const after = relocalizeNotice(before, JA_TEXT);

  assert.equal(after?.tone, before.tone);
  assert.equal(after?.code, before.code);
  assert.notEqual(after?.text, before.text);
  assert.ok(after?.text.includes(ja.scheduleIssue.incomplete));
});

test('a REFILL_FAILED notice also follows the language', async () => {
  const h = harness({
    prepare: async () => {
      throw new Error('prompt crashed');
    },
  });
  await h.run();

  const before = h.applied[0].notice;
  const after = relocalizeNotice(before, JA_TEXT);
  assert.equal(after?.code, 'REFILL_FAILED');
  assert.ok(after?.text.includes(ja.errors.REFILL_FAILED.message));
  assert.notEqual(after?.text, before?.text);
});

test('a refill started in English applies a notice rebuilt in the language current at completion', async () => {
  const gate = deferred();
  const h = harness({ prepare: () => gate.promise, failMain: true });
  let currentText = EN_TEXT;
  let shown: AppNotice | undefined;
  let built: AppNotice | null = null;

  const pending = h.coordinator.refill('startup', h.stored(), en, (result) => {
    built = result.notice;
    shown = relocalizeNotice(result.notice, currentText) ?? result.notice ?? undefined;
  });
  currentText = JA_TEXT;
  gate.resolve();
  await pending;

  const english = built as AppNotice | null;
  assert.ok(english && shown);
  assert.doesNotMatch(english.text, /[぀-ヿ一-龯]/);
  assert.match(shown.text, /[぀-ヿ一-龯]/);
  assert.equal(shown.code, english.code);
  assert.equal(shown.tone, english.tone);
});
