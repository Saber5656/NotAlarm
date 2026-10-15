/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  describeScheduledRequest,
  matchQueueEntry,
  QueueIndex,
  NOTIFICATION_QUEUE_CAPACITY,
} from '../src/queueInspection';

const mainData = { kind: 'main_alarm', alarmId: 'a', cycleId: 'c' };

describe('describeScheduledRequest (expo-notifications 57 shapes)', () => {
  test('Android date trigger exposes the epoch milliseconds in value', () => {
    const entry = describeScheduledRequest({
      identifier: 'x',
      content: { data: mainData },
      trigger: { type: 'date', value: 1_800_000_000_000, repeats: false, channelId: 'ch' },
    });
    assert.deepEqual(entry.trigger, { kind: 'date', atMs: 1_800_000_000_000 });
    assert.deepEqual(entry.owned, { ...mainData, owner: undefined, mainAlarmId: undefined });
  });

  test('iOS reads a DATE input back as a relative timeInterval: no absolute time', () => {
    const entry = describeScheduledRequest({
      identifier: 'x',
      content: { data: mainData },
      trigger: { type: 'timeInterval', seconds: 3600, repeats: false },
    });
    assert.deepEqual(entry.trigger, { kind: 'relative' });
  });

  test('iOS calendar trigger with full UTC components exposes the absolute second', () => {
    const entry = describeScheduledRequest({
      identifier: 'x',
      content: { data: mainData },
      trigger: {
        type: 'calendar',
        repeats: false,
        dateComponents: {
          timeZone: 'UTC', calendar: 'iso8601', isLeapMonth: false,
          year: 2026, month: 10, day: 16, hour: 7, minute: 0, second: 0,
        },
      },
    });
    assert.deepEqual(entry.trigger, {
      kind: 'date',
      atMs: Date.UTC(2026, 9, 16, 7, 0, 0),
      resolutionMs: 1000,
    });
  });

  test('repeating, push, partial or foreign-zone calendar and garbage triggers are unknown', () => {
    const components = { timeZone: 'UTC', year: 2026, month: 10, day: 16, hour: 7, minute: 0, second: 0 };
    for (const trigger of [
      { type: 'timeInterval', seconds: 60, repeats: true },
      { type: 'calendar', repeats: false, dateComponents: {} },
      { type: 'calendar', repeats: true, dateComponents: components },
      { type: 'calendar', repeats: false, dateComponents: { ...components, second: undefined } },
      { type: 'calendar', repeats: false, dateComponents: { ...components, timeZone: 'Asia/Tokyo' } },
      { type: 'calendar', repeats: false, dateComponents: { ...components, month: 13 } },
      { type: 'push' },
      null,
      'text',
    ]) {
      assert.deepEqual(
        describeScheduledRequest({ identifier: 'x', content: { data: mainData }, trigger }).trigger,
        { kind: 'unknown' },
      );
    }
  });

  test('foreign or malformed content is never parsed as owned, and never throws', () => {
    for (const request of [
      null,
      undefined,
      42,
      {},
      { identifier: 'x', content: null },
      { identifier: 'x', content: { data: 'text' } },
      { identifier: 'x', content: { data: { kind: 'other', cycleId: 'c' } } },
      { identifier: 'x', content: { data: { kind: 'main_alarm' } } },
      { identifier: 'x', content: { data: { kind: 'main_alarm', cycleId: 7 } } },
      { identifier: 'x', content: { data: { kind: 'awake_checkin', cycleId: 'c', alarmId: 9 } } },
    ]) {
      assert.equal(describeScheduledRequest(request).owned, null);
    }
  });

  test('an entry without a string identifier still counts but cannot be matched', () => {
    const index = new QueueIndex([describeScheduledRequest({ content: { data: mainData } })]);
    assert.equal(index.size, 1);
    assert.equal(index.get(''), undefined);
  });
});

describe('matchQueueEntry', () => {
  const expected = { id: 'x', kind: 'main_alarm' as const, alarmId: 'a', cycleId: 'c', atMs: 1000 };
  const entry = (data: unknown, trigger: unknown) =>
    describeScheduledRequest({ identifier: 'x', content: { data }, trigger });

  test('present, absent, foreign and off_schedule', () => {
    const date = { type: 'date', value: 1000, repeats: false };
    assert.equal(matchQueueEntry(entry(mainData, date), expected), 'present');
    assert.equal(matchQueueEntry(undefined, expected), 'absent');
    assert.equal(matchQueueEntry(entry({ ...mainData, cycleId: 'z' }, date), expected), 'foreign');
    assert.equal(matchQueueEntry(entry(mainData, { ...date, value: 2000 }), expected), 'off_schedule');
  });

  test('iOS relative trigger is this app\'s legacy reservation: time unverifiable', () => {
    assert.equal(
      matchQueueEntry(entry(mainData, { type: 'timeInterval', seconds: 5, repeats: false }), expected),
      'legacy',
    );
  });

  test('an unreadable trigger shape is never reported as present', () => {
    assert.equal(matchQueueEntry(entry(mainData, { type: 'push' }), expected), 'unverifiable');
    assert.equal(matchQueueEntry(entry(mainData, null), expected), 'unverifiable');
  });

  test('a calendar trigger matches the due time rounded up to the second', () => {
    const calendar = (ms: number) => {
      const d = new Date(ms);
      return {
        type: 'calendar', repeats: false,
        dateComponents: {
          timeZone: 'UTC', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
        },
      };
    };
    const due = Date.UTC(2026, 9, 16, 7, 0, 0) + 250;
    const e = { ...expected, atMs: due };
    assert.equal(matchQueueEntry(entry(mainData, calendar(due + 750)), e), 'present');
    assert.equal(matchQueueEntry(entry(mainData, calendar(due - 250)), e), 'off_schedule');
    assert.equal(matchQueueEntry(entry(mainData, calendar(due + 1750)), e), 'off_schedule');
  });

  test('a check-in must name the expected main', () => {
    const checkIn = { id: 'x', kind: 'awake_checkin' as const, alarmId: 'a', cycleId: 'c', mainAlarmId: 'm', atMs: 1 };
    const data = { kind: 'awake_checkin', alarmId: 'a', cycleId: 'c', mainAlarmId: 'm' };
    const date = { type: 'date', value: 1, repeats: false };
    assert.equal(matchQueueEntry(entry(data, date), checkIn), 'present');
    assert.equal(matchQueueEntry(entry({ ...data, mainAlarmId: 'other' }, date), checkIn), 'foreign');
  });
});

test('capacity counts every entry, foreign ones included', () => {
  const entries = Array.from({ length: 62 }, (_, i) =>
    describeScheduledRequest({ identifier: `f${i}`, content: { data: {} } }),
  );
  const index = new QueueIndex(entries);
  assert.equal(NOTIFICATION_QUEUE_CAPACITY, 64);
  assert.ok(index.hasRoomFor(2));
  assert.ok(!index.hasRoomFor(3));
});

describe('owner marker', () => {
  const marked = { ...mainData, owner: 'already-up/v1' };
  const entryOf = (id: string, data: unknown) => describeScheduledRequest({
    identifier: id,
    content: { data },
    trigger: { type: 'date', value: 1_000, repeats: false },
  });
  const expected = { kind: 'main_alarm' as const, alarmId: 'a', cycleId: 'c', atMs: 1_000 };

  test('the marker is read from the payload; a non-string marker makes it foreign', () => {
    assert.equal(entryOf('x', marked).owned?.owner, 'already-up/v1');
    assert.equal(entryOf('x', { ...mainData, owner: 7 }).owned, null);
  });

  test('findOwned (discovery) requires the marker and the full identity', () => {
    const index = new QueueIndex([
      entryOf('legacy', mainData),
      entryOf('other-owner', { ...marked, owner: 'someone/v1' }),
      entryOf('no-alarm', { kind: 'main_alarm', cycleId: 'c', owner: 'already-up/v1' }),
      entryOf('mine', marked),
    ]);
    assert.deepEqual(index.findOwned(expected).map((e) => e.id), ['mine']);
  });

  test('match (exact stored id) still accepts legacy content but not another owner', () => {
    const index = new QueueIndex([
      entryOf('legacy', mainData),
      entryOf('other-owner', { ...marked, owner: 'someone/v1' }),
    ]);
    assert.equal(index.match({ ...expected, id: 'legacy' }), 'present');
    assert.equal(index.match({ ...expected, id: 'other-owner' }), 'foreign');
  });
});
