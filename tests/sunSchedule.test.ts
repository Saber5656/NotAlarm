/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { SUN_REGIONS, findSunRegion } from "../src/sunRegions";
import {
  computeSunSchedule,
  createSunScheduleCache,
  resolveSunBackground,
} from "../src/sunSchedule";

// suncalc is an approximation; USNO values are whole minutes.
const TOLERANCE_MINUTES = 3;

function hm(hours: number, minutes: number): number {
  return hours * 60 + minutes;
}

function assertNear(actual: number, expected: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE_MINUTES,
    `${label}: expected about ${expected}, got ${actual}`,
  );
}

function compute(regionId: string, iso: string) {
  const region = findSunRegion(regionId);
  assert.ok(region, regionId);
  return computeSunSchedule({
    latitude: region.latitude,
    longitude: region.longitude,
    timeZone: region.timeZone,
    nowMs: Date.parse(iso),
  });
}

// Independent reference: U.S. Naval Observatory "Rise, Set, and Transit" API
// (https://aa.usno.navy.mil/data/api), fetched 2026-10-15 for the exact
// coordinates, dates and UTC offsets below. Times are civil local HH:MM as
// returned; the tests never call the network. suncalc is not the source.
interface UsnoCase {
  url: string;
  region: string;
  latitude: number;
  longitude: number;
  /** Instant inside the civil day being checked. */
  at: string;
  dateKey: string;
  sunrise: [number, number];
  sunset: [number, number];
}

const USNO_CASES: UsnoCase[] = [
  {
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-06-21&coords=35.7%2C139.7&tz=9",
    region: "tokyo",
    latitude: 35.7,
    longitude: 139.7,
    at: "2026-06-21T03:00:00Z",
    dateKey: "2026-06-21",
    sunrise: [4, 26],
    sunset: [19, 0],
  },
  {
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-12-21&coords=35.7%2C139.7&tz=9",
    region: "tokyo",
    latitude: 35.7,
    longitude: 139.7,
    at: "2026-12-21T03:00:00Z",
    dateKey: "2026-12-21",
    sunrise: [6, 47],
    sunset: [16, 31],
  },
  {
    // BST: UTC+1 in the API request.
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-06-21&coords=51.5%2C-0.1&tz=1",
    region: "london",
    latitude: 51.5,
    longitude: -0.1,
    at: "2026-06-21T12:00:00Z",
    dateKey: "2026-06-21",
    sunrise: [4, 43],
    sunset: [21, 21],
  },
  {
    // 2026-12-20T20:00Z is already 09:00 on 21 December in Auckland (NZDT).
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-12-21&coords=-36.8%2C174.8&tz=13",
    region: "auckland",
    latitude: -36.8,
    longitude: 174.8,
    at: "2026-12-20T20:00:00Z",
    dateKey: "2026-12-21",
    sunrise: [5, 58],
    sunset: [20, 39],
  },
  {
    // 2026-06-22T05:00Z is still 21 June 19:00 in Honolulu.
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-06-21&coords=21.3%2C-157.9&tz=-10",
    region: "honolulu",
    latitude: 21.3,
    longitude: -157.9,
    at: "2026-06-22T05:00:00Z",
    dateKey: "2026-06-21",
    sunrise: [5, 51],
    sunset: [19, 16],
  },
  {
    // The day US clocks spring forward; the API request uses PDT (UTC-7).
    url: "https://aa.usno.navy.mil/api/rstt/oneday?date=2026-03-08&coords=34.1%2C-118.2&tz=-7",
    region: "los-angeles",
    latitude: 34.1,
    longitude: -118.2,
    at: "2026-03-08T20:00:00Z",
    dateKey: "2026-03-08",
    sunrise: [7, 12],
    sunset: [18, 55],
  },
];

for (const reference of USNO_CASES) {
  test(`matches USNO for ${reference.region} on ${reference.dateKey}`, () => {
    const region = findSunRegion(reference.region);
    assert.ok(region);
    // The built-in place is exactly the one the reference was fetched for.
    assert.equal(region.latitude, reference.latitude);
    assert.equal(region.longitude, reference.longitude);
    const result = compute(reference.region, reference.at);
    assert.equal(result.kind, "ok", reference.url);
    if (result.kind === "ok") {
      assert.equal(result.dateKey, reference.dateKey);
      assertNear(result.sunriseMinute, hm(...reference.sunrise), `sunrise ${reference.url}`);
      assertNear(result.sunsetMinute, hm(...reference.sunset), `sunset ${reference.url}`);
    }
  });
}

// USNO: "Object continuously above the Horizon" / "below the Horizon"
// https://aa.usno.navy.mil/api/rstt/oneday?date=2026-06-21&coords=69.6%2C18.9&tz=2
// https://aa.usno.navy.mil/api/rstt/oneday?date=2026-12-21&coords=69.6%2C18.9&tz=1
test("Tromso reports polar day and polar night as USNO does", () => {
  assert.equal(compute("tromso", "2026-06-21T12:00:00Z").kind, "polar-day");
  assert.equal(compute("tromso", "2026-12-21T12:00:00Z").kind, "polar-night");
});

test("an unknown time zone or non-finite input is invalid, not guessed", () => {
  const base = { latitude: 35, longitude: 139, nowMs: Date.UTC(2026, 5, 1) };
  assert.equal(
    computeSunSchedule({ ...base, timeZone: "Mars/Olympus" }).kind,
    "invalid",
  );
  assert.equal(
    computeSunSchedule({ ...base, timeZone: "" }).kind,
    "invalid",
  );
  assert.equal(
    computeSunSchedule({ ...base, latitude: NaN, timeZone: "Asia/Tokyo" }).kind,
    "invalid",
  );
  assert.equal(
    computeSunSchedule({ ...base, latitude: 91, timeZone: "Asia/Tokyo" }).kind,
    "invalid",
  );
});

test("built-in regions are small, unique and have valid zones", () => {
  assert.ok(SUN_REGIONS.length >= 8 && SUN_REGIONS.length <= 20);
  assert.equal(new Set(SUN_REGIONS.map((r) => r.id)).size, SUN_REGIONS.length);
  for (const region of SUN_REGIONS) {
    assert.ok(region.label.length > 0);
    assert.ok(Math.abs(region.latitude) <= 90);
    assert.ok(Math.abs(region.longitude) <= 180);
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat("en", { timeZone: region.timeZone }),
    );
  }
});

test("fixed preference needs no schedule and keeps 06:00/18:00 defaults", () => {
  const resolved = resolveSunBackground({
    preference: { version: 1, mode: "fixed" },
    nowMs: Date.UTC(2026, 5, 1),
    deviceTimeZone: "Asia/Tokyo",
  });
  assert.equal(resolved.schedule, null);
  assert.equal(resolved.source, "fixed");
  assert.equal(resolved.fallback, undefined);
});

test("a region resolves independently of the device time zone", () => {
  const resolved = resolveSunBackground({
    preference: { version: 1, mode: "region", regionId: "london" },
    nowMs: Date.parse("2026-06-21T12:00:00Z"),
    deviceTimeZone: "Asia/Tokyo",
  });
  assert.equal(resolved.source, "region");
  assert.equal(resolved.schedule?.timeZone, "Europe/London");
});

test("unknown region falls back to fixed with a reason", () => {
  const resolved = resolveSunBackground({
    preference: { version: 1, mode: "region", regionId: "atlantis" },
    nowMs: Date.UTC(2026, 5, 1),
    deviceTimeZone: "Asia/Tokyo",
  });
  assert.equal(resolved.schedule, null);
  assert.equal(resolved.source, "fixed");
  assert.equal(resolved.fallback, "invalid-saved");
});

test("polar day and night fall back to fixed with a reason", () => {
  const resolved = resolveSunBackground({
    preference: { version: 1, mode: "region", regionId: "tromso" },
    nowMs: Date.parse("2026-06-21T12:00:00Z"),
    deviceTimeZone: "Europe/Oslo",
  });
  assert.equal(resolved.schedule, null);
  assert.equal(resolved.fallback, "polar");
});

const devicePreference = {
  version: 1,
  mode: "device",
  latitude: 35.7,
  longitude: 139.7,
  timeZone: "Asia/Tokyo",
  savedAtMs: 1,
} as const;

test("device position is used only while the device zone is unchanged", () => {
  const now = Date.parse("2026-06-21T03:00:00Z");
  const same = resolveSunBackground({
    preference: devicePreference,
    nowMs: now,
    deviceTimeZone: "Asia/Tokyo",
  });
  assert.equal(same.source, "device");
  assert.ok(same.schedule);

  const moved = resolveSunBackground({
    preference: devicePreference,
    nowMs: now,
    deviceTimeZone: "America/New_York",
  });
  assert.equal(moved.schedule, null);
  assert.equal(moved.fallback, "timezone-changed");

  const unknown = resolveSunBackground({
    preference: devicePreference,
    nowMs: now,
    deviceTimeZone: undefined,
  });
  assert.equal(unknown.schedule, null);
  assert.equal(unknown.fallback, "timezone-changed");
});

test("cache reuses a result within the same civil day and stays bounded", () => {
  let computations = 0;
  const cache = createSunScheduleCache({
    maxEntries: 3,
    compute: (input) => {
      computations += 1;
      return computeSunSchedule(input);
    },
  });
  const input = {
    latitude: 35.7,
    longitude: 139.7,
    timeZone: "Asia/Tokyo",
  };
  const morning = Date.parse("2026-06-21T00:00:00Z");
  cache.get({ ...input, nowMs: morning });
  cache.get({ ...input, nowMs: morning + 3_600_000 });
  assert.equal(computations, 1);
  cache.get({ ...input, nowMs: morning + 86_400_000 });
  assert.equal(computations, 2, "next local day recomputes");
  for (let day = 2; day < 10; day += 1) {
    cache.get({ ...input, nowMs: morning + day * 86_400_000 });
  }
  assert.ok(cache.size() <= 3);
});

// The wrapped interval has no USNO fixture, so the reference is the official
// SunCalc API itself (the local `suncalc` package), compared by instants.
test("a sunset after local midnight is kept as a longer same-day interval", async () => {
  const { getTimes } = await import("suncalc");
  const tromso = findSunRegion("tromso");
  assert.ok(tromso);
  // Tromsø around the start and end of the midnight-sun season.
  for (const iso of ["2026-05-17T10:00:00Z", "2026-07-26T10:00:00Z"]) {
    const nowMs = Date.parse(iso);
    const result = computeSunSchedule({
      latitude: tromso.latitude,
      longitude: tromso.longitude,
      timeZone: tromso.timeZone,
      nowMs,
    });
    assert.equal(result.kind, "ok", iso);
    if (result.kind !== "ok") {
      return;
    }
    // Same noon-anchored call computeSunSchedule documents: offset 0 here only
    // changes the anchor, and the sunrise/sunset instants are what is compared.
    const noonUtc = Date.parse(iso.slice(0, 10) + "T10:00:00Z");
    const times = getTimes(new Date(noonUtc), tromso.latitude, tromso.longitude, 0, 0);
    assert.ok(times.sunrise && times.sunset, iso);
    const lengthMinutes = (times.sunset.getTime() - times.sunrise.getTime()) / 60_000;
    assert.ok(lengthMinutes > 0 && lengthMinutes < 24 * 60 + 60, iso);
    assertNear(result.sunsetMinute - result.sunriseMinute, lengthMinutes, iso);
    assert.ok(result.sunsetMinute > 24 * 60, `${iso} sunset wraps past midnight`);
  }
});

test("a wrapped Tromsø day resolves to a schedule, not a corrupt-setting fallback", () => {
  const resolved = resolveSunBackground({
    preference: { version: 1, mode: "region", regionId: "tromso" },
    nowMs: Date.parse("2026-05-17T10:00:00Z"),
    deviceTimeZone: "Asia/Tokyo",
    cache: createSunScheduleCache(),
  });
  assert.equal(resolved.fallback, undefined);
  assert.ok(resolved.schedule);
  assert.ok(resolved.schedule.sunsetMinute > resolved.schedule.sunriseMinute);
});
