/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALREADY_UP_OWNER,
  MAIN_ALARM_KIND,
  buildMainNotificationData,
  buildSnoozeNotificationData,
  readMainDeliveryIdentity,
} from '../src/alarmContracts';
import { markCycleRinging } from '../src/alarmDefinitionMutations';
import type { StoredAlarmDefinition } from '../src/alarmStorage';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/notificationService.ts', import.meta.url), 'utf8');

const DUE = 50_000;
const SNOOZE_DUE = 80_000;

function definition(): StoredAlarmDefinition {
  return {
    id: 'a1',
    cycles: [
      {
        alarmId: 'a1',
        cycleId: 'c1',
        mainAlarmId: 'main-1',
        armedAtMs: 0,
        dueAtMs: DUE,
        phase: 'armed',
        stepCount: 0,
        stepCandidateRecorded: false,
      },
      {
        alarmId: 'a1',
        cycleId: 'c2',
        mainAlarmId: 'main-2',
        armedAtMs: 0,
        dueAtMs: DUE,
        phase: 'snoozed',
        stepCount: 0,
        stepCandidateRecorded: false,
        snooze: { count: 1, notificationId: 'snooze-2', dueAtMs: SNOOZE_DUE },
      },
    ],
  } as unknown as StoredAlarmDefinition;
}

test('main and snooze payloads carry the exact scheduled due time', () => {
  const main = buildMainNotificationData({ alarmId: 'a1', cycleId: 'c1', dueAtMs: DUE });
  assert.equal(main.owner, ALREADY_UP_OWNER);
  assert.equal(main.kind, MAIN_ALARM_KIND);
  assert.equal(main.dueAtMs, DUE);
  const snooze = buildSnoozeNotificationData({
    alarmId: 'a1',
    cycleId: 'c2',
    dueAtMs: SNOOZE_DUE,
    snoozeNumber: 1,
  });
  assert.equal(snooze.dueAtMs, SNOOZE_DUE);
  assert.equal(snooze.snooze, 1);
});

test('the scheduling functions use the payload builders', () => {
  assert.match(service, /buildMainNotificationData\(/);
  assert.match(service, /buildSnoozeNotificationData\(/);
});

test('the listener passes the payload due time to the atomic transition', () => {
  const listener = app.slice(
    app.indexOf('addNotificationReceivedListener'),
    app.indexOf('getLastNotificationResponse'),
  );
  assert.match(listener, /readMainDeliveryIdentity\(/);
  assert.match(listener, /saveCycleRinging\(/);
  assert.doesNotMatch(listener, /mainAlarmId: notification\.request\.identifier/);
});

test('a delivered main payload rings only at its own due time', () => {
  const data = buildMainNotificationData({ alarmId: 'a1', cycleId: 'c1', dueAtMs: DUE });
  const identity = readMainDeliveryIdentity(data, 'main-1');
  assert.ok(identity);
  assert.equal(markCycleRinging([definition()], identity, DUE).status, 'ringing');

  const wrong = readMainDeliveryIdentity({ ...data, dueAtMs: DUE + 60_000 }, 'main-1');
  assert.ok(wrong);
  assert.equal(markCycleRinging([definition()], wrong, DUE + 60_000).status, 'mismatch');
});

test('a delivered snooze payload is judged at the snooze due, not the original cycle due', () => {
  const data = buildSnoozeNotificationData({
    alarmId: 'a1',
    cycleId: 'c2',
    dueAtMs: SNOOZE_DUE,
    snoozeNumber: 1,
  });
  const identity = readMainDeliveryIdentity(data, 'snooze-2');
  assert.ok(identity);
  assert.equal(identity.dueAtMs, SNOOZE_DUE);
  assert.equal(markCycleRinging([definition()], identity, SNOOZE_DUE).status, 'ringing');
  // The original cycle due is not accepted for a snooze delivery.
  const original = readMainDeliveryIdentity({ ...data, dueAtMs: DUE }, 'snooze-2');
  assert.ok(original);
  assert.equal(markCycleRinging([definition()], original, SNOOZE_DUE).status, 'mismatch');
});

test('malformed or non-finite provided due values are rejected, never treated as legacy', () => {
  const base = { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'a1', cycleId: 'c1' };
  for (const bad of ['50000', NaN, Infinity, -Infinity, null, {}, [], true]) {
    assert.equal(readMainDeliveryIdentity({ ...base, dueAtMs: bad }, 'main-1'), null, String(bad));
  }
});

test('an already queued payload without a due time keeps the explicit legacy fallback', () => {
  const identity = readMainDeliveryIdentity(
    { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'a1', cycleId: 'c1' },
    'main-1',
  );
  assert.ok(identity);
  assert.equal(identity.dueAtMs, undefined);
  assert.equal(markCycleRinging([definition()], identity, DUE).status, 'ringing');
  // The stable accepted snooze id is still required on the legacy path.
  const stale = readMainDeliveryIdentity(
    { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'a1', cycleId: 'c2' },
    'main-2',
  );
  assert.ok(stale);
  assert.equal(markCycleRinging([definition()], stale, SNOOZE_DUE).status, 'mismatch');
});

test('a payload that is not a main alarm of this app is not a delivery identity', () => {
  assert.equal(readMainDeliveryIdentity(undefined, 'x'), null);
  assert.equal(readMainDeliveryIdentity({ kind: 'other', cycleId: 'c' }, 'x'), null);
  assert.equal(readMainDeliveryIdentity({ kind: MAIN_ALARM_KIND }, 'x'), null);
});
