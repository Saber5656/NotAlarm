/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { en, ja } from '../src/i18n';
import { JA_TEXT, withFormatter } from './support/text';

import {
  processUserSkipFailSafe,
  type AwakeResponseDependencies,
} from '../src/alarmOrchestrator';
import { STEP_WINDOW_LEAD_MS } from '../src/alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';
import { describeSuppressedOccurrence } from '../src/homeStatus';
import {
  createSuppressionSaver,
  finishSuppression,
} from '../src/suppressionFollowUp';
import { createSuppressionJournal } from '../src/suppressionJournal';
import {
  buildUserSkipTarget,
  captureUserSkipTarget,
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

function definition(
  c: StoredAlarm,
  kind: 'today' | 'daily' = 'daily',
): StoredAlarmDefinition {
  return {
    id: c.alarmId,
    hour: 7,
    minute: 0,
    repeat: { kind, weekdays: [], dateKey: undefined } as never,
    enabled: true,
    createdAtMs: 0,
    cycles: [c],
  } as StoredAlarmDefinition;
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  };
}

// Small harness mirroring App.tsx: storage + rendered list + OS state.
function harness(nowMs = START + 1) {
  let stored: StoredAlarm = cycle;
  let rendered: StoredAlarmDefinition[] = [definition(cycle)];
  const log: string[] = [];
  const save = async (next: StoredAlarm) => {
    stored = next;
    log.push('save');
    return [definition(next)];
  };
  const deps: AwakeResponseDependencies = {
    loadAlarm: async () => stored,
    saveAlarm: createSuppressionSaver(save, (next) => {
      log.push('apply');
      rendered = next;
    }),
    cancelScheduled: async () => true,
    nowMs: () => nowMs,
    journal: createSuppressionJournal(memoryStore()),
  };
  return {
    deps,
    log,
    get stored() {
      return stored;
    },
    get rendered() {
      return rendered;
    },
  };
}

test('saved definitions are applied right after persist, before cleanup', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  assert.equal(result.status, 'suppressed');
  assert.deepEqual(h.log, ['save', 'apply']);
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
});

test('a failed persist applies nothing', async () => {
  const applied: unknown[] = [];
  const saver = createSuppressionSaver(
    async () => {
      throw new Error('disk');
    },
    (next) => applied.push(next),
  );
  await assert.rejects(saver(cycle));
  assert.deepEqual(applied, []);
});

test('refill failure after persist keeps the stopped state (not reverted)', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  assert.equal(result.status, 'suppressed');
  await assert.rejects(
    finishSuppression((result as { alarm: StoredAlarm }).alarm, {
      cancelCheckIn: async () => undefined,
      dismissDelivered: async () => undefined,
      refill: async () => {
        throw new Error('refill');
      },
    }),
    /refill/,
  );
  assert.equal(h.stored.phase, 'suppressed');
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
  assert.equal(h.rendered[0].cycles[0].suppressedBy, 'user_skip');
});

test('check-in cleanup failure keeps the stopped state and still dismisses the delivered check-in', async () => {
  const h = harness();
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  const calls: string[] = [];
  await assert.rejects(
    finishSuppression((result as { alarm: StoredAlarm }).alarm, {
      cancelCheckIn: async (id) => {
        calls.push(`cancel:${id}`);
        throw new Error('cancel');
      },
      dismissDelivered: async (id) => void calls.push(`dismiss:${id}`),
      refill: async () => void calls.push('refill'),
    }),
    /cancel/,
  );
  assert.deepEqual(calls, ['cancel:checkin-1', 'dismiss:checkin-1']);
  assert.equal(h.rendered[0].cycles[0].phase, 'suppressed');
});

test('delivered check-in is dismissed on success and a dismiss failure is non-fatal', async () => {
  const calls: string[] = [];
  await finishSuppression(
    { ...cycle, phase: 'suppressed' },
    {
      cancelCheckIn: async (id) => void calls.push(`cancel:${id}`),
      dismissDelivered: async (id) => {
        calls.push(`dismiss:${id}`);
        throw new Error('not delivered');
      },
      refill: async () => void calls.push('refill'),
    },
  );
  assert.deepEqual(calls, ['cancel:checkin-1', 'dismiss:checkin-1', 'refill']);
});

test('target capture pins the exact occurrence and window boundaries', () => {
  const cycles = [cycle];
  assert.equal(captureUserSkipTarget(cycles, 'cycle-1', START - 1), null);
  assert.deepEqual(captureUserSkipTarget(cycles, 'cycle-1', START), {
    cycleId: 'cycle-1',
    mainAlarmId: 'main-1',
    dueAtMs: DUE,
  });
  assert.ok(captureUserSkipTarget(cycles, 'cycle-1', DUE - 1));
  assert.equal(captureUserSkipTarget(cycles, 'cycle-1', DUE), null);
  assert.equal(captureUserSkipTarget(cycles, 'other', START), null);
  assert.equal(captureUserSkipTarget(cycles, undefined, START), null);
});

test('skip just before due forges no wakeup or step evidence', async () => {
  const h = harness(DUE - 1);
  const result = await processUserSkipFailSafe(h.deps, buildUserSkipTarget(cycle));
  assert.equal(result.status, 'suppressed');
  const saved = h.stored;
  assert.equal(saved.stepCount, 12);
  assert.equal(saved.stepCandidateRecorded, false);
  assert.equal(saved.confirmedAtMs, undefined);
});

test('skip copy makes no promise about later days (today-only safe)', () => {
  for (const text of [ja.skip.done, ja.skip.hint, en.skip.done, en.skip.hint]) {
    assert.doesNotMatch(text, /次の日|翌日|以降は鳴/);
  }
  const status = describeSuppressedOccurrence(
    [
      definition(
        { ...cycle, phase: 'suppressed', suppressedBy: 'user_skip' },
        'today',
      ),
    ],
    START,
    withFormatter(JA_TEXT, { day: () => '10/16', clockAt: () => '07:00' }),
  );
  assert.match(status!.text, /今回分だけ止めた/);
  assert.doesNotMatch(status!.text, /次の日|翌日|以降は鳴/);
});

test('App wires the shared helpers and keeps the skip action under warnings', () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const count = (path: string, pattern: RegExp) =>
    read(path).match(pattern)?.length ?? 0;
  const responses = 'src/app/useSuppressionResponses.ts';
  const steps = 'src/app/useStepCandidate.ts';
  // All three suppression paths persist through the epoch-safe setter.
  const saver = /createSuppressionSaver\(saveStoredAlarm, setCurrentAlarms\)/g;
  assert.equal(count(responses, saver), 2);
  assert.equal(count(steps, saver), 1);
  // Only the module-level journal recovery keeps a plain save (no screen state).
  assert.equal(count('src/app/platform/coordinators.ts', /saveAlarm: async \(cycle\) => \{/g), 1);
  for (const file of [responses, steps, 'src/app/useAlarmController.ts']) {
    assert.equal(count(file, /saveAlarm: async \(cycle\) => \{/g), 0, file);
  }
  assert.equal(count(responses, /finishSuppression\(/g), 2);
  assert.equal(count(steps, /finishSuppression\(/g), 1);
  // One button definition, rendered in the monitoring card and under warnings.
  assert.equal(count('src/ui/screens/SkipButton.tsx', /testID="skip-this-occurrence"/g), 1);
  assert.equal(count('src/ui/screens/NextAlarmCard.tsx', /\{skipAction\}/g), 1);
  assert.equal(count('src/ui/screens/DeliveryWarningCard.tsx', /\{skipAction\}/g), 1);
  assert.equal(count('src/ui/screens/HomeScreen.tsx', /<SkipButton/g), 1);
});
