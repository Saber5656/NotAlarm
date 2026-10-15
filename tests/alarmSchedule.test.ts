/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatRepeatLabel,
  getUpcomingAlarmTimes,
  isAlarmRepeat,
  makeAlarmRepeat,
} from '../src/alarmSchedule';

test('today only never rolls a past time into tomorrow', () => {
  const now = new Date(2026, 7, 20, 8, 0, 0).getTime();
  const repeat = makeAlarmRepeat('today', now);

  assert.deepEqual(getUpcomingAlarmTimes(now, 7, 0, repeat), []);
  assert.deepEqual(
    getUpcomingAlarmTimes(now, 9, 0, repeat),
    [new Date(2026, 7, 20, 9, 0, 0).getTime()],
  );
});

test('daily repeat returns the next three local occurrences', () => {
  const now = new Date(2026, 7, 20, 8, 0, 0).getTime();
  const repeat = makeAlarmRepeat('daily', now);

  assert.deepEqual(getUpcomingAlarmTimes(now, 7, 0, repeat), [
    new Date(2026, 7, 21, 7, 0, 0).getTime(),
    new Date(2026, 7, 22, 7, 0, 0).getTime(),
    new Date(2026, 7, 23, 7, 0, 0).getTime(),
  ]);
});

test('weekdays skip Saturday and Sunday', () => {
  const friday = new Date(2026, 7, 21, 8, 0, 0).getTime();
  const repeat = makeAlarmRepeat('weekdays', friday);

  assert.deepEqual(getUpcomingAlarmTimes(friday, 7, 0, repeat), [
    new Date(2026, 7, 24, 7, 0, 0).getTime(),
    new Date(2026, 7, 25, 7, 0, 0).getTime(),
    new Date(2026, 7, 26, 7, 0, 0).getTime(),
  ]);
});

test('custom repeat normalizes weekdays and formats a release-facing label', () => {
  const now = new Date(2026, 7, 20, 8, 0, 0).getTime();
  const repeat = makeAlarmRepeat('custom', now, [5, 1, 3, 1]);

  assert.deepEqual(repeat.weekdays, [1, 3, 5]);
  assert.equal(formatRepeatLabel(repeat), '月・水・金');
});

test('custom repeat rejects an empty weekday selection', () => {
  assert.throws(
    () => makeAlarmRepeat('custom', Date.now(), []),
    (error: unknown) => (error as { code?: string }).code === 'REPEAT_INVALID',
  );
});

test('today repeat accepts only real calendar dates', () => {
  const today = (dateKey: string) => ({ kind: 'today', weekdays: [], dateKey });
  for (const bad of ['2026-13-01', '2026-00-10', '2026-02-29', '2026-04-31', '2026-01-00', '2026-01-32']) {
    assert.equal(isAlarmRepeat(today(bad)), false, bad);
  }
  for (const good of ['2028-02-29', '2026-12-31', '2026-02-28']) {
    assert.equal(isAlarmRepeat(today(good)), true, good);
  }
});
