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

function colorDistance(left: string, right: string): number {
  const channels = (color: string) => [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
  return channels(left).reduce(
    (distance, channel, index) =>
      distance + Math.abs(channel - channels(right)[index]),
    0,
  );
}

test('uses the device-local clock to select familiar day phases', () => {
  assert.equal(getCircadianTheme(localTime(2)).phase, 'night');
  assert.equal(getCircadianTheme(localTime(6)).phase, 'dawn');
  assert.equal(getCircadianTheme(localTime(8)).phase, 'morning');
  assert.equal(getCircadianTheme(localTime(13)).phase, 'day');
  assert.equal(getCircadianTheme(localTime(17)).phase, 'golden-hour');
  assert.equal(getCircadianTheme(localTime(19)).phase, 'dusk');
});

test('moves the sun continuously from sunrise to sunset', () => {
  const sunrise = getCircadianTheme(
    localTime(Math.floor(LOCAL_SUNRISE_MINUTE / 60)),
  ).sun;
  const noon = getCircadianTheme(localTime(12)).sun;
  const sunset = getCircadianTheme(
    localTime(Math.floor(LOCAL_SUNSET_MINUTE / 60)),
  ).sun;

  assert.equal(sunrise.opacity, 1);
  assert.equal(noon.opacity, 1);
  assert.equal(sunset.opacity, 1);
  assert.ok(sunrise.x < noon.x && noon.x < sunset.x);
  assert.ok(noon.y < sunrise.y && noon.y < sunset.y);
});

test('cross-fades the moon and sun during civil-style twilight', () => {
  const beforeSunrise = getCircadianTheme(localTime(5, 45));
  const afterSunset = getCircadianTheme(localTime(18, 15));

  assert.equal(beforeSunrise.sun.opacity, 0.5);
  assert.equal(beforeSunrise.moon.opacity, 0.5);
  assert.equal(afterSunset.sun.opacity, 0.5);
  assert.equal(afterSunset.moon.opacity, 0.5);
});

test('keeps sky colors continuous across midnight', () => {
  const beforeMidnight = getCircadianTheme(localTime(23, 59, 59));
  const midnight = getCircadianTheme(localTime(0));

  beforeMidnight.skyColors.forEach((color, index) => {
    assert.ok(colorDistance(color, midnight.skyColors[index]) <= 2);
  });
  assert.ok(beforeMidnight.moon.x < midnight.moon.x);
});

test('shows stars at night and removes them from the daytime sky', () => {
  assert.ok(getCircadianTheme(localTime(2)).starsOpacity > 0.7);
  assert.equal(getCircadianTheme(localTime(12)).starsOpacity, 0);
});

test('rejects invalid dates rather than silently choosing a theme', () => {
  assert.throws(() => getCircadianTheme(new Date(Number.NaN)), TypeError);
});
