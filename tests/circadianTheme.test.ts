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

function weightsAt(
  schedule: { sunriseMinute: number; sunsetMinute: number; timeZone: string },
  minute: number,
) {
  const date = new Date(Date.UTC(2026, 0, 15, 0, 0) + minute * 60_000);
  return getCircadianTheme(date, schedule).photoWeights;
}

function assertContinuous(
  schedule: { sunriseMinute: number; sunsetMinute: number; timeZone: string },
  maxStep: number,
) {
  let previous = weightsAt(schedule, 0);
  for (let minute = 1; minute < 24 * 60; minute += 1) {
    const current = weightsAt(schedule, minute);
    const total =
      current.dawn + current.day + current.dusk + current.night;
    assert.ok(Math.abs(total - 1) < 1e-9, `minute ${minute} total ${total}`);
    for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
      assert.ok(
        Math.abs(current[key] - previous[key]) <= maxStep,
        `${key} jumps ${previous[key]} -> ${current[key]} at minute ${minute}`,
      );
    }
    previous = current;
  }
}

test('a short winter day cross-fades with no jump between day and dusk', () => {
  // Daylight of 2.5 h (sunrise + 240 would land after sunset + 30).
  assertContinuous(
    { sunriseMinute: 10 * 60 + 30, sunsetMinute: 13 * 60, timeZone: 'UTC' },
    0.1,
  );
  // Even shorter days stay continuous.
  assertContinuous(
    { sunriseMinute: 11 * 60, sunsetMinute: 11 * 60 + 40, timeZone: 'UTC' },
    0.2,
  );
});

test('a short day still reaches the daytime photo and then dusk in order', () => {
  const schedule = {
    sunriseMinute: 10 * 60 + 30,
    sunsetMinute: 13 * 60,
    timeZone: 'UTC',
  };
  const midday = weightsAt(schedule, 12 * 60 + 45);
  assert.ok(midday.day > 0.5, `day ${midday.day}`);
  const afterSunset = getCircadianTheme(
    new Date(Date.UTC(2026, 0, 15, 13, 40)),
    schedule,
  );
  assert.equal(afterSunset.phase, 'dusk');
});

test('a daylight interval running past local midnight keeps valid continuous weights', () => {
  assertContinuous(
    { sunriseMinute: 80, sunsetMinute: 24 * 60 + 20, timeZone: 'UTC' },
    0.1,
  );
  // 23:50 is still daylight for a sunset at 00:20 the next day.
  const lateEvening = weightsAt(
    { sunriseMinute: 80, sunsetMinute: 24 * 60 + 20, timeZone: 'UTC' },
    23 * 60 + 50,
  );
  assert.ok(lateEvening.night < 0.5, `night ${lateEvening.night}`);
});

// Sunrise 01:30 and sunset 00:30 the next civil day: the same interval, seen
// from the day after, is the "previous" schedule that is still in daylight.
test('a sunset after midnight keeps daylight continuous across 23:59 to 00:00', () => {
  const wrapped = { sunriseMinute: 90, sunsetMinute: 1470, timeZone: 'UTC' };
  const schedule = { ...wrapped, previous: { ...wrapped } };
  const at = (day: number, hour: number, minute: number) =>
    new Date(Date.UTC(2026, 5, day, hour, minute, 0));
  const before = getCircadianTheme(at(14, 23, 59), schedule);
  const after = getCircadianTheme(at(15, 0, 0), schedule);
  const later = getCircadianTheme(at(15, 0, 10), schedule);

  assert.equal(before.phase, 'golden-hour');
  assert.equal(after.phase, 'golden-hour');
  assert.equal(later.phase, 'golden-hour');
  assert.ok(after.photoWeights.night < 0.05);
  for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
    assert.ok(
      Math.abs(before.photoWeights[key] - after.photoWeights[key]) < 0.05,
      `${key} is continuous over midnight`,
    );
  }
  assert.equal(getCircadianTheme(at(15, 0, 29), schedule).phase, 'golden-hour');
  // Past the real sunset the blend keeps fading rather than jumping to night.
  assert.ok(getCircadianTheme(at(15, 0, 40), schedule).photoWeights.night < 0.5);
});

test('a previous schedule that ends before midnight changes nothing', () => {
  const plain = { sunriseMinute: 360, sunsetMinute: 1080, timeZone: 'UTC' };
  const withPrevious = { ...plain, previous: { ...plain } };
  for (let minute = 0; minute < 1440; minute += 7) {
    const date = new Date(Date.UTC(2026, 5, 15, 0, minute, 0));
    assert.deepEqual(
      getCircadianTheme(date, withPrevious),
      getCircadianTheme(date, plain),
    );
  }
});

// PR41 review: short days must still peak, and yesterday's tail must not
// swallow today's dawn.
type TestSchedule = {
  sunriseMinute: number;
  sunsetMinute: number;
  timeZone: string;
  previous?: { sunriseMinute: number; sunsetMinute: number };
};

function peakDay(schedule: TestSchedule) {
  let best = { minute: -1, day: -1 };
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const { day } = weightsAt(schedule, minute);
    if (day > best.day) {
      best = { minute, day };
    }
  }
  return best;
}

for (const [name, sunrise, sunset] of [
  ['40 minutes (11:00-11:40)', 11 * 60, 11 * 60 + 40],
  ['110 minutes (11:00-12:50)', 11 * 60, 12 * 60 + 50],
] as const) {
  test(`a ${name} day still reaches the daytime photo inside daylight`, () => {
    const schedule = {
      sunriseMinute: sunrise,
      sunsetMinute: sunset,
      timeZone: 'UTC',
    };
    const peak = peakDay(schedule);
    assert.ok(peak.day > 0.95, `peak day weight ${peak.day}`);
    assert.ok(
      peak.minute >= sunrise && peak.minute <= sunset,
      `peak at ${peak.minute} outside ${sunrise}-${sunset}`,
    );
    // Still night well before and after, and the blend never jumps.
    assert.ok(weightsAt(schedule, 2 * 60).night > 0.99);
    assert.ok(weightsAt(schedule, 22 * 60).night > 0.99);
    assertContinuous(schedule, 0.1);
  });
}

test('a day just above the full-ramp threshold is unchanged by the short-day rule', () => {
  const schedule = { sunriseMinute: 360, sunsetMinute: 720, timeZone: 'UTC' };
  assert.equal(weightsAt(schedule, 600).day, 1);
  assert.equal(weightsAt(schedule, 360 + 120).dawn, 1);
});

test("yesterday's post-sunset tail blends into today's dawn instead of dropping it", () => {
  // Sunrise 01:30, sunset 00:30 next day; yesterday's tail would reach night
  // at 04:00, after today's dawn keyframes at 02:00 and 03:30.
  const wrapped = { sunriseMinute: 90, sunsetMinute: 1470, timeZone: 'UTC' };
  const schedule = { ...wrapped, previous: { ...wrapped } };
  assert.ok(weightsAt(schedule, 2 * 60).dawn > 0.99, 'dawn at 02:00');
  assert.ok(weightsAt(schedule, 3 * 60 + 30).dawn > 0.99, 'dawn at 03:30');
  assert.ok(weightsAt(schedule, 3 * 60).night < 0.01, 'not night at 03:00');
  assert.ok(weightsAt(schedule, 8 * 60).day > 0.99, 'day by 08:00');
  assertContinuous(schedule, 0.1);
});

test('a 23-hour day is bright at noon, dawn after sunrise and continuous over midnight', () => {
  const wrapped = { sunriseMinute: 30, sunsetMinute: 1410, timeZone: 'UTC' };
  const schedule = { ...wrapped, previous: { ...wrapped } };
  assert.equal(weightsAt(schedule, 12 * 60).day, 1, 'noon');
  assert.ok(weightsAt(schedule, 90).dawn > 0.99, '01:30 dawn');
  assertContinuous(schedule, 0.1);
  const at = (day: number, hour: number, minute: number) =>
    getCircadianTheme(new Date(Date.UTC(2026, 5, day, hour, minute)), schedule)
      .photoWeights;
  const before = at(14, 23, 59);
  const after = at(15, 0, 0);
  for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
    assert.ok(
      Math.abs(before[key] - after[key]) < 0.05,
      `${key} ${before[key]} -> ${after[key]} over midnight`,
    );
  }
});

test('an overlapping tail never drops weights out of range or off total 1', () => {
  for (const sunrise of [30, 90, 150, 200, 300]) {
    const prev = { sunriseMinute: 120, sunsetMinute: 1470 };
    const schedule = {
      sunriseMinute: sunrise,
      sunsetMinute: sunrise + 600,
      timeZone: 'UTC',
      previous: prev,
    };
    assertContinuous(schedule, 0.1);
    for (let minute = 0; minute < 1440; minute += 5) {
      const w = weightsAt(schedule, minute);
      for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
        assert.ok(w[key] >= -1e-9 && w[key] <= 1 + 1e-9);
      }
    }
  }
});
