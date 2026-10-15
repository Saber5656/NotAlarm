/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { StoredAlarmDefinition } from '../src/alarmStorage';
import {
  adoptStoredAlarms,
  presentCommittedOutcome,
} from '../src/snoozeOutcome';
import {
  isStaleStorageResult,
  stampStorageResult,
  advanceStorageEpoch,
} from '../src/storageResetGate';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

function block(start: string, end: string): string {
  const from = app.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return app.slice(from, to);
}

function snapshot(): StoredAlarmDefinition[] {
  return stampStorageResult([] as StoredAlarmDefinition[]);
}

test('a committed outcome stops the sound, then hands the exact snapshot to the screen', () => {
  const calls: string[] = [];
  const committed = snapshot();
  const applied: StoredAlarmDefinition[][] = [];
  const done = presentCommittedOutcome(
    { alarms: committed },
    {
      stopSound: () => calls.push('sound'),
      apply: (next) => {
        calls.push('apply');
        applied.push(next);
      },
    },
  );
  assert.equal(done, true);
  assert.deepEqual(calls, ['sound', 'apply']);
  assert.equal(applied[0], committed, 'the very same snapshot, not a copy');
});

test('the sound still stops when the outcome carries no snapshot', () => {
  const calls: string[] = [];
  const done = presentCommittedOutcome(
    {},
    { stopSound: () => calls.push('sound'), apply: () => calls.push('apply') },
  );
  assert.equal(done, false);
  assert.deepEqual(calls, ['sound']);
});

test('a throwing sound stop cannot keep the snapshot from the screen', () => {
  const applied: unknown[] = [];
  presentCommittedOutcome(
    { alarms: snapshot() },
    {
      stopSound: () => {
        throw new Error('audio');
      },
      apply: (next) => applied.push(next),
    },
  );
  assert.equal(applied.length, 1);
});

test('a snapshot from before a finished deletion is stale, so an epoch-safe setter drops it', () => {
  const committed = snapshot();
  advanceStorageEpoch();
  assert.equal(isStaleStorageResult(committed), true);
  // The App setter is epoch-safe; this mirrors its guard on the real gate.
  const shown: unknown[] = [];
  presentCommittedOutcome(
    { alarms: committed },
    {
      stopSound: () => undefined,
      apply: (next) => {
        if (!isStaleStorageResult(next)) {
          shown.push(next);
        }
      },
    },
  );
  assert.deepEqual(shown, []);
});

test('a readback that fails never throws and never replaces a committed snapshot', async () => {
  const applied: unknown[] = [];
  let reads = 0;
  await adoptStoredAlarms(
    { alarms: snapshot() },
    {
      apply: (next) => applied.push(next),
      reload: async () => {
        reads += 1;
        throw new Error('read failed');
      },
    },
  );
  assert.equal(applied.length, 0, 'already applied by presentCommittedOutcome');
  assert.equal(reads, 0, 'a committed snapshot needs no readback');
});

test('without a snapshot the readback is best-effort: applied when it works, silent when it fails', async () => {
  const fresh = snapshot();
  const applied: unknown[] = [];
  await adoptStoredAlarms(
    {},
    { apply: (next) => applied.push(next), reload: async () => fresh },
  );
  assert.deepEqual(applied, [fresh]);
  await adoptStoredAlarms(
    {},
    {
      apply: (next) => applied.push(next),
      reload: async () => {
        throw new Error('read failed');
      },
    },
  );
  assert.equal(applied.length, 1);
});

test('App hands stop and snooze to the shared presenters, never reloading before the sound stops', () => {
  const snooze = block('const snoozeRinging = useCallback', 'const orderedAlarms');
  assert.match(snooze, /presentSnoozed\(result, outcomeEffects\(\)\)/);
  assert.doesNotMatch(snooze, /setCurrentAlarms\(await loadAlarmDefinitions\(\)\)/);

  const stop = block('const stopOccurrence = useCallback', 'const stopRinging');
  assert.match(stop, /presentStopped\(result,/);
  assert.doesNotMatch(stop, /setCurrentAlarms\(await loadAlarmDefinitions\(\)\)/);
  // The presenters own the order: sound, snapshot, refill (tests/outcomeCodes.test.ts).
  const effects = block('const outcomeEffects = useCallback', 'const stopOccurrence');
  assert.match(effects, /stopSound: stopForegroundAlarmSound/);
  assert.match(effects, /apply: setCurrentAlarms/);
});

test('a failing refill after a persisted stop is not reported as a failed stop', () => {
  const stop = block('const stopOccurrence = useCallback', 'const stopRinging');
  // Only the service-level failure uses the stop-failure code.
  assert.match(stop, /getSnoozeCopy\.stopFailureCode\(result\.reason\)/);
  assert.doesNotMatch(stop, /停止処理に失敗しました/);
});

test('reset and recovery wiring covers the snooze service memory', () => {
  const reset = block('const storageReset = createStorageResetService', 'installStorageResetGate');
  assert.match(reset, /snoozeService\.unsettledIds\(\)/);
  assert.match(reset, /snoozeService\.forgetUnsettled\(\)/);
});
