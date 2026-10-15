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

test('an explicit sun schedule shifts the phases and uses its own zone', () => {
  const tokyoSummer = {
    sunriseMinute: 4 * 60 + 25,
    sunsetMinute: 19 * 60,
    timeZone: 'Asia/Tokyo',
  };
  // 04:40 in Tokyo is shortly after sunrise: bright dawn, not night.
  const earlyTokyo = new Date('2026-06-20T19:40:00Z');
  assert.equal(getCircadianTheme(earlyTokyo, tokyoSummer).phase, 'dawn');
  assert.ok(getCircadianTheme(earlyTokyo, tokyoSummer).photoWeights.dawn > 0.5);
  // The fixed default would still call 04:40 night.
  const fixed = getCircadianTheme(new Date(2026, 5, 21, 4, 40));
  assert.equal(fixed.phase, 'night');
  // 19:30 Tokyo is dusk-ish after the 19:00 sunset, evaluated in Tokyo time.
  const eveningTokyo = new Date('2026-06-21T10:30:00Z');
  assert.equal(getCircadianTheme(eveningTokyo, tokyoSummer).phase, 'dusk');
});

test('a late sunset keeps weights valid and in range', () => {
  const schedule = {
    sunriseMinute: 3 * 60,
    sunsetMinute: 23 * 60 + 30,
    timeZone: 'Atlantic/Reykjavik',
  };
  for (let minute = 0; minute < 24 * 60; minute += 7) {
    const date = new Date(Date.UTC(2026, 5, 21, 0, 0) + minute * 60_000);
    const { photoWeights } = getCircadianTheme(date, schedule);
    for (const weight of Object.values(photoWeights)) {
      assert.ok(weight >= 0 && weight <= 1 && Number.isFinite(weight));
    }
  }
});

test('a schedule with a bad zone falls back to the fixed clock', () => {
  const date = new Date(2026, 0, 15, 2);
  assert.deepEqual(
    getCircadianTheme(date, {
      sunriseMinute: 300,
      sunsetMinute: 1000,
      timeZone: 'Nowhere/Land',
    }),
    getCircadianTheme(date),
  );
});

test('a resolved region schedule drives the theme in that region\'s own zone and date', async () => {
  const { resolveSunBackground } = await import('../src/sunSchedule');
  const resolve = (regionId: string, nowMs: number) =>
    resolveSunBackground({
      preference: { version: 1, mode: 'region', regionId },
      nowMs,
      deviceTimeZone: 'Asia/Tokyo',
    }).schedule ?? undefined;

  // London midsummer, USNO sunrise 04:43 BST: 04:00 BST (03:00Z) is before
  // dawn, while the fixed 06:00 clock reads the device's own 12:00 as day.
  const londonDawn = Date.parse('2026-06-21T03:50:00Z'); // 04:50 BST
  const london = resolve('london', londonDawn);
  assert.ok(london);
  assert.equal(getCircadianTheme(new Date(londonDawn), london).phase, 'dawn');
  assert.equal(
    getCircadianTheme(new Date(londonDawn), undefined).phase,
    getCircadianTheme(new Date(londonDawn)).phase,
  );

  // Same instant, Auckland (NZ civil date is already 21 Dec, 15:50 NZST+1):
  // the schedule is Auckland's own day, not the device's or UTC's.
  const auckland = resolve('auckland', londonDawn);
  assert.ok(auckland);
  assert.equal(auckland.timeZone, 'Pacific/Auckland');
  assert.notDeepEqual(auckland, london);

  // Fixed preference leaves the default theme byte-for-byte unchanged.
  const fixed = resolveSunBackground({
    preference: { version: 1, mode: 'fixed' },
    nowMs: londonDawn,
    deviceTimeZone: 'Asia/Tokyo',
  }).schedule;
  assert.equal(fixed, null);
  assert.deepEqual(
    getCircadianTheme(new Date(londonDawn), fixed ?? undefined),
    getCircadianTheme(new Date(londonDawn)),
  );
});
