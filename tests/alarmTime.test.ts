/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNextAlarmAtMs,
  parseAlarmTimeInput,
} from '../src/alarmTime';

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

test('keyboard clock input accepts one or two digit values', () => {
  assert.deepEqual(parseAlarmTimeInput('7', '05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseAlarmTimeInput('23', '59'), { hour: 23, minute: 59 });
});

test('keyboard clock input normalizes full-width Japanese digits', () => {
  assert.deepEqual(parseAlarmTimeInput('０７', '３０'), {
    hour: 7,
    minute: 30,
  });
});

test('keyboard clock input rejects missing, malformed, and out-of-range values', () => {
  assert.throws(() => parseAlarmTimeInput('', '30'));
  assert.throws(() => parseAlarmTimeInput('7.5', '30'));
  assert.throws(() => parseAlarmTimeInput('24', '00'));
  assert.throws(() => parseAlarmTimeInput('07', '60'));
});
