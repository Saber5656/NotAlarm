/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_DELAY_MS,
  getDemoAlarmAtMs,
  getNextAlarmAtMs,
} from '../src/alarmTime';

test('demo alarm is exactly 30 seconds later', () => {
  assert.equal(DEMO_DELAY_MS, 30_000);
  assert.equal(getDemoAlarmAtMs(1_000), 31_000);
});

test('future clock time resolves to today', () => {
  const now = new Date(2026, 7, 8, 6, 30, 45).getTime();
  const due = new Date(getNextAlarmAtMs(now, 7, 0));

  assert.equal(due.getFullYear(), 2026);
  assert.equal(due.getMonth(), 7);
  assert.equal(due.getDate(), 8);
  assert.equal(due.getHours(), 7);
  assert.equal(due.getMinutes(), 0);
  assert.equal(due.getSeconds(), 0);
});

test('past clock time resolves to tomorrow', () => {
  const now = new Date(2026, 7, 8, 8, 0, 0).getTime();
  const due = new Date(getNextAlarmAtMs(now, 7, 0));

  assert.equal(due.getDate(), 9);
  assert.equal(due.getHours(), 7);
  assert.equal(due.getMinutes(), 0);
});

test('invalid clock input is rejected', () => {
  assert.throws(() => getNextAlarmAtMs(Date.now(), 24, 0));
  assert.throws(() => getNextAlarmAtMs(Date.now(), 7, 60));
});
