/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { en, ja } from '../src/i18n';
import { JA_TEXT, withFormatter } from './support/text';

import {
  type AwakeResponseDependencies,
  processUserSkipFailSafe,
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from '../src/alarmOrchestrator';
import { canSuppressAlarm, STEP_WINDOW_LEAD_MS } from '../src/alarmPolicy';
import type { StoredAlarm } from '../src/alarmStorage';
import { describeSuppressedOccurrence } from '../src/homeStatus';
import { createSuppressionJournal } from '../src/suppressionJournal';
import {
  buildUserSkipTarget,
  describeUserSkipConfirmation,
  getUserSkipOffer,
} from '../src/userSkip';

const DUE = 10_000_000;
const START = DUE - STEP_WINDOW_LEAD_MS;

const cycle: StoredAlarm = {
  alarmId: 'alarm-1',
  cycleId: 'cycle-1',
  mainAlarmId: 'main-1',
  checkInNotificationId: 'checkin-1',
  armedAtMs: 0,
  dueAtMs: DUE,
  phase: 'armed',
  stepCount: 12,
  stepCandidateRecorded: false,
};

function target(overrides = {}) {
  return { ...buildUserSkipTarget(cycle), ...overrides };
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  };
}

function setup(options: {
  nowMs?: () => number;
  cancel?: (id: string) => Promise<boolean>;
  failSave?: boolean;
  stored?: StoredAlarm | null;
} = {}) {
  let stored: StoredAlarm | null =
    options.stored === undefined ? cycle : options.stored;
  const calls: string[] = [];
  const deps: AwakeResponseDependencies = {
    loadAlarm: async () => stored,
    saveAlarm: async (next) => {
      if (options.failSave) throw new Error('disk');
      calls.push('save');
      stored = next;
    },
    cancelScheduled:
      options.cancel ??
      (async (id) => {
        calls.push(`cancel:${id}`);
        return true;
      }),
    nowMs: options.nowMs ?? (() => START + 1),
    journal: createSuppressionJournal(memoryStore()),
  };
  return { deps, calls, get stored() { return stored; } };
}

test('offer: before window, at start, just before due, at due', () => {
  assert.equal(getUserSkipOffer(cycle, START - 1), null);
  assert.ok(getUserSkipOffer(cycle, START));
  assert.ok(getUserSkipOffer(cycle, DUE - 1));
  assert.equal(getUserSkipOffer(cycle, DUE), null);
});

test('offer: only armed/step_candidate cycles', () => {
  for (const phase of ['suppressed', 'ringing', 'missed', 'dismissed'] as const) {
    assert.equal(getUserSkipOffer({ ...cycle, phase }, START + 1), null);
  }
  assert.ok(getUserSkipOffer({ ...cycle, phase: 'step_candidate' }, START + 1));
});

test('policy: user skip window boundaries', () => {
  const evidence = (t: number) =>
    ({ kind: 'USER_SKIP_THIS_OCCURRENCE', ...target(), requestedAtMs: t }) as const;
  assert.equal(canSuppressAlarm(cycle, evidence(START - 1), START - 1).canSuppress, false);
  assert.equal(canSuppressAlarm(cycle, evidence(START), START).canSuppress, true);
  assert.equal(canSuppressAlarm(cycle, evidence(DUE - 1), DUE - 1).canSuppress, true);
  assert.deepEqual(canSuppressAlarm(cycle, evidence(DUE), DUE), {
    canSuppress: false,
    reason: 'ALARM_DUE_OR_PAST',
  });
});

test('skip at start suppresses only this cycle, no forged evidence', async () => {
  const s = setup({ nowMs: () => START });
  const result = await processUserSkipFailSafe(s.deps, target());
  assert.equal(result.status, 'suppressed');
  assert.deepEqual(s.calls, ['cancel:main-1', 'save']);
  const saved = s.stored!;
  assert.equal(saved.phase, 'suppressed');
  assert.equal(saved.suppressedBy, 'user_skip');
  assert.equal(saved.stepCount, 12);
  assert.equal(saved.stepCandidateRecorded, false);
  assert.equal(saved.confirmedAtMs, undefined);
  assert.equal(saved.checkInNotificationId, 'checkin-1');
});

test('before window, at due and past due leave alarm armed without cancel', async () => {
  for (const [now, reason] of [
    [START - 1, 'SKIP_BEFORE_WINDOW'],
    [DUE, 'ALARM_DUE_OR_PAST'],
    [DUE + 5, 'ALARM_DUE_OR_PAST'],
  ] as const) {
    const s = setup({ nowMs: () => now });
    const result = await processUserSkipFailSafe(s.deps, target());
    assert.deepEqual(result, { status: 'alarm_remains', reason });
    assert.deepEqual(s.calls, []);
  }
});

test('mismatched ids or due reject before any destructive call', async () => {
  for (const [override, reason] of [
    [{ cycleId: 'other' }, 'NO_ACTIVE_ALARM'],
    [{ mainAlarmId: 'main-x' }, 'WRONG_MAIN_ALARM'],
    [{ dueAtMs: DUE - 86_400_000 }, 'WRONG_OCCURRENCE'],
  ] as const) {
    const s = setup();
    const result = await processUserSkipFailSafe(s.deps, target(override));
    assert.equal(result.status, 'alarm_remains');
    assert.equal((result as { reason: string }).reason, reason === 'NO_ACTIVE_ALARM' ? 'WRONG_CYCLE' : reason);
    assert.deepEqual(s.calls, []);
  }
});

test('stale dialog for a cycle that was replaced rejects, never retargets', async () => {
  const next: StoredAlarm = {
    ...cycle,
    cycleId: 'cycle-2',
    mainAlarmId: 'main-2',
    dueAtMs: DUE + 86_400_000,
  };
  // Storage now holds the next day's occurrence under the old cycle id lookup.
  const s = setup({ stored: next });
  const result = await processUserSkipFailSafe(s.deps, target());
  assert.equal(result.status, 'alarm_remains');
  assert.deepEqual(s.calls, []);
  assert.equal(s.stored, next);
});

test('rapid duplicate taps cancel once and stay idempotent', async () => {
  const s = setup();
  const [a, b] = await Promise.all([
    processUserSkipFailSafe(s.deps, target()),
    processUserSkipFailSafe(s.deps, target()),
  ]);
  assert.equal(a.status, 'suppressed');
  assert.equal(b.status, 'suppressed');
  assert.equal(s.calls.filter((c) => c.startsWith('cancel')).length, 1);
});

test('cancellation failure leaves alarm armed with unknown-status error', async () => {
  const s = setup({ cancel: async () => { throw new Error('os'); } });
  await assert.rejects(
    processUserSkipFailSafe(s.deps, target()),
    SuppressionCancelUnknownError,
  );
  assert.equal(s.stored!.phase, 'armed');
});

test('unverified cancellation leaves alarm armed', async () => {
  const s = setup({ cancel: async () => false });
  const result = await processUserSkipFailSafe(s.deps, target());
  assert.deepEqual(result, { status: 'alarm_remains', reason: 'CANCEL_NOT_VERIFIED' });
  assert.equal(s.stored!.phase, 'armed');
});

test('persist failure surfaces the save error after cancellation', async () => {
  const s = setup({ failSave: true });
  await assert.rejects(processUserSkipFailSafe(s.deps, target()), SuppressionSaveError);
});

test('repeat definition and next days are untouched', async () => {
  const nextDay: StoredAlarm = {
    ...cycle,
    cycleId: 'cycle-2',
    mainAlarmId: 'main-2',
    dueAtMs: DUE + 86_400_000,
  };
  const s = setup();
  const cancelled: string[] = [];
  s.deps.cancelScheduled = async (id) => (cancelled.push(id), true);
  await processUserSkipFailSafe(s.deps, target());
  assert.deepEqual(cancelled, ['main-1']);
  assert.equal(nextDay.phase, 'armed');
});

test('confirmation copy names exact date/time and unchanged repeats', () => {
  const copy = describeUserSkipConfirmation(
    cycle,
    withFormatter(JA_TEXT, { day: () => '10/16(金)', clockAt: () => '07:00' }),
  );
  assert.match(copy.title, /今回分だけ止めますか/);
  assert.match(copy.body, /10\/16\(金\) 07:00/);
  assert.match(copy.body, /繰り返し/);
  assert.equal(copy.confirmLabel, '今回分だけ止める');
});

test('skipped occurrence is described as manual stop', () => {
  const text = describeSuppressedOccurrence(
    [
      {
        id: 'alarm-1',
        hour: 7,
        minute: 0,
        repeat: { kind: 'daily', weekdays: [], dateKey: undefined } as never,
        enabled: true,
        createdAtMs: 0,
        cycles: [{ ...cycle, phase: 'suppressed', suppressedBy: 'user_skip' }],
      },
    ],
    START,
    withFormatter(JA_TEXT, { day: () => '10/16', clockAt: () => '07:00' }),
  );
  assert.match(text!.text, /今回分だけ止めた/);
});

test('App wires the button, confirmation and whole-series distinction', () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  // The use case lives with the suppression responses, the derived offer in
  // the alarm view, the button in its own screen component.
  assert.match(read('src/app/useSuppressionResponses.ts'), /processUserSkipFailSafe/);
  assert.match(read('src/app/useAlarmView.ts'), /getUserSkipOffer/);
  assert.match(read('src/ui/screens/SkipButton.tsx'), /testID="skip-this-occurrence"/);
  assert.match(read('src/ui/screens/AlarmListPanel.tsx'), /messages\.alarmList\.rowSpoken\(/);
  assert.match(ja.alarmList.rowSpoken('7:00', '毎日'), /すべての回/);
  assert.match(en.alarmList.rowSpoken('7:00', 'Daily'), /all occurrences/);
  for (const catalog of [ja, en]) {
    assert.ok(catalog.alarmList.toggleHintOn.length > 0);
  }
  assert.equal(
    read('src/app/useSuppressionResponses.ts').match(/journal: suppressionJournal,/g)?.length,
    2,
  );
  assert.equal(
    read('src/app/useStepCandidate.ts').match(/journal: suppressionJournal,/g)?.length,
    1,
  );
  assert.equal(
    read('src/app/platform/coordinators.ts').match(/journal: suppressionJournal,/g)?.length,
    1,
  );
});
