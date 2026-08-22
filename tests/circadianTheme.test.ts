import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_SUNRISE_MINUTE,
  LOCAL_SUNSET_MINUTE,
  getCircadianTheme,
} from '../src/circadianTheme';

function localTime(hour: number, minute = 0, second = 0): Date {
  return new Date(2026, 0, 15, hour, minute, second, 0);
}

function timeFromMinute(minute: number): Date {
  return localTime(Math.floor(minute / 60), minute % 60);
}

test('uses the device-local clock to select familiar day phases', () => {
  assert.equal(getCircadianTheme(localTime(2)).phase, 'night');
  assert.equal(getCircadianTheme(localTime(6)).phase, 'dawn');
  assert.equal(getCircadianTheme(localTime(8)).phase, 'morning');
  assert.equal(getCircadianTheme(localTime(13)).phase, 'day');
  assert.equal(getCircadianTheme(localTime(17)).phase, 'golden-hour');
  assert.equal(getCircadianTheme(localTime(19)).phase, 'dusk');
});

test('selects photorealistic background assets for familiar times', () => {
  assert.equal(getCircadianTheme(localTime(2)).photoWeights.night, 1);
  assert.equal(getCircadianTheme(localTime(7)).photoWeights.dawn, 1);
  assert.equal(getCircadianTheme(localTime(12)).photoWeights.day, 1);
  assert.equal(getCircadianTheme(localTime(19)).photoWeights.dusk, 1);
});

test('uses sunrise and sunset baselines to favor the matching photographs', () => {
  const sunrise = getCircadianTheme(
    timeFromMinute(LOCAL_SUNRISE_MINUTE),
  ).photoWeights;
  const sunset = getCircadianTheme(
    timeFromMinute(LOCAL_SUNSET_MINUTE),
  ).photoWeights;

  assert.ok(sunrise.dawn > sunrise.night);
  assert.ok(sunset.dusk > sunset.day);
});

test('cross-fades adjacent photo backgrounds without changing total opacity', () => {
  [localTime(5, 30), localTime(9), localTime(17), localTime(20, 45)].forEach(
    (date) => {
      const weights = Object.values(getCircadianTheme(date).photoWeights);
      assert.ok(weights.filter((weight) => weight > 0).length <= 2);
      assert.ok(
        Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9,
      );
    },
  );
});

test('keeps the night photograph continuous across midnight', () => {
  assert.deepEqual(
    getCircadianTheme(localTime(23, 59, 59)).photoWeights,
    getCircadianTheme(localTime(0)).photoWeights,
  );
});

test('rejects invalid dates rather than silently choosing a theme', () => {
  assert.throws(() => getCircadianTheme(new Date(Number.NaN)), TypeError);
});
