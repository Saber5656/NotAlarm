/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ceilToSecondMs,
  parseCalendarDateComponents,
  toUtcCalendarFields,
} from '../src/notificationTrigger';

const full = (overrides: Record<string, unknown> = {}) => ({
  calendar: 'iso8601',
  timeZone: 'UTC',
  isLeapMonth: false,
  year: 2026,
  month: 10,
  day: 16,
  hour: 7,
  minute: 0,
  second: 0,
  ...overrides,
});

describe('toUtcCalendarFields', () => {
  test('is an explicit UTC wall time, non-repeating by construction', () => {
    const ms = Date.UTC(2026, 9, 16, 7, 30, 15);
    assert.deepEqual(toUtcCalendarFields(ms), {
      timezone: 'UTC',
      year: 2026,
      month: 10,
      day: 16,
      hour: 7,
      minute: 30,
      second: 15,
    });
  });

  test('never fires earlier than due: sub-second time rounds up', () => {
    const due = Date.UTC(2026, 9, 16, 7, 30, 15) + 1;
    const fields = toUtcCalendarFields(due);
    assert.equal(fields.second, 16);
    const back = parseCalendarDateComponents({ ...full(), ...fields, timeZone: fields.timezone });
    assert.ok(back !== null && back >= due && back - due < 1000);
    assert.equal(ceilToSecondMs(5_000), 5_000);
    assert.equal(ceilToSecondMs(5_001), 6_000);
  });

  test('rolls over the minute, day and year boundary', () => {
    const due = Date.UTC(2026, 11, 31, 23, 59, 59) + 500;
    assert.deepEqual(toUtcCalendarFields(due), {
      timezone: 'UTC',
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });
});

describe('parseCalendarDateComponents', () => {
  test('reads a complete UTC shape back to the absolute time', () => {
    assert.equal(parseCalendarDateComponents(full()), Date.UTC(2026, 9, 16, 7, 0, 0));
    assert.equal(
      parseCalendarDateComponents(full({ timeZone: 'GMT' })),
      Date.UTC(2026, 9, 16, 7, 0, 0),
    );
  });

  test('any other zone, missing zone or missing field is unverifiable', () => {
    assert.equal(parseCalendarDateComponents(full({ timeZone: 'Asia/Tokyo' })), null);
    assert.equal(parseCalendarDateComponents(full({ timeZone: null })), null);
    assert.equal(parseCalendarDateComponents(full({ timeZone: undefined })), null);
    for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
      assert.equal(parseCalendarDateComponents(full({ [key]: undefined })), null, key);
    }
    assert.equal(parseCalendarDateComponents(null), null);
    assert.equal(parseCalendarDateComponents('x'), null);
  });

  test('out-of-range, fractional, non-numeric and impossible dates are rejected', () => {
    const bad: Array<Record<string, unknown>> = [
      { month: 0 }, { month: 13 }, { day: 0 }, { day: 32 }, { hour: 24 },
      { hour: -1 }, { minute: 60 }, { second: 60 }, { year: 0 }, { year: 10000 },
      { month: 2, day: 30 }, { month: 4, day: 31 }, { year: 2027, month: 2, day: 29 },
      { hour: 7.5 }, { minute: '0' }, { second: NaN }, { year: Infinity },
      { isLeapMonth: true },
    ];
    for (const override of bad) {
      assert.equal(parseCalendarDateComponents(full(override)), null, JSON.stringify(override));
    }
    assert.equal(
      parseCalendarDateComponents(full({ year: 2028, month: 2, day: 29 })),
      Date.UTC(2028, 1, 29, 7, 0, 0),
    );
  });
});
