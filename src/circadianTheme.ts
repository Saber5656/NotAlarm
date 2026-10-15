export const LOCAL_SUNRISE_MINUTE = 6 * 60;
export const LOCAL_SUNSET_MINUTE = 18 * 60;

export type CircadianPhase =
  | 'night'
  | 'dawn'
  | 'morning'
  | 'day'
  | 'golden-hour'
  | 'dusk';

export interface CircadianPhotoWeights {
  dawn: number;
  day: number;
  dusk: number;
  night: number;
}

export interface CircadianTheme {
  phase: CircadianPhase;
  phaseLabel: string;
  photoWeights: CircadianPhotoWeights;
}

interface PhotoKeyframe {
  minute: number;
  weights: CircadianPhotoWeights;
}

/** Sun times for the selected place; absent means the fixed 06:00/18:00. */
export interface CircadianSchedule {
  sunriseMinute: number;
  sunsetMinute: number;
  /** IANA zone whose clock the minutes refer to. */
  timeZone: string;
  /**
   * The previous civil day's own times (minutes after that day's midnight).
   * Only consulted when its sunset passed midnight, so the early hours of
   * today stay in that daylight instead of restarting as night.
   */
  previous?: { sunriseMinute: number; sunsetMinute: number };
}

const MINUTES_PER_DAY = 24 * 60;

const NIGHT: CircadianPhotoWeights = { dawn: 0, day: 0, dusk: 0, night: 1 };
const DAWN: CircadianPhotoWeights = { dawn: 1, day: 0, dusk: 0, night: 0 };
const DAY: CircadianPhotoWeights = { dawn: 0, day: 1, dusk: 0, night: 0 };
const DUSK: CircadianPhotoWeights = { dawn: 0, day: 0, dusk: 1, night: 0 };

/**
 * Offsets from sunrise/sunset reproduce the original fixed keyframes exactly
 * when sunrise is 06:00 and sunset is 18:00.
 *
 * A day shorter than six hours cannot hold the full morning and evening
 * ramps, so it gets one shared DAY peak at two thirds of the way from sunrise
 * to sunset (always inside daylight, and equal to the full-day plateau start
 * at exactly six hours). Precedence when ramps overlap: the DAY peak is
 * pinned first; the sunrise keyframes (night -> dawn -> dawn hold) are then
 * squeezed, in their original proportions, into the span before that peak;
 * the sunset keyframes already lie after it and never move. Nothing is
 * dropped for being out of order, so every transition keeps a nonzero length.
 * The only remaining filter removes keyframes at or before midnight.
 */
function rawKeyframes(sunrise: number, sunset: number): PhotoKeyframe[] {
  const dayStart = sunrise + 240;
  const dayEnd = sunset - 120;
  const fullDay = dayStart <= dayEnd;
  const peak = sunrise + ((sunset - sunrise) * 2) / 3;
  // Full-day proportions measured from sunrise - 90: dawn at 120/330, the end
  // of the dawn hold at 210/330, and the day plateau at 330/330.
  const lead = sunrise - 90;
  const squeeze = (peak - lead) / 330;
  const dawnStart = fullDay ? sunrise + 30 : lead + 120 * squeeze;
  const dawnEnd = fullDay ? sunrise + 120 : lead + 210 * squeeze;
  const middle: PhotoKeyframe[] = fullDay
    ? [
        { minute: dayStart, weights: DAY },
        { minute: dayEnd, weights: DAY },
      ]
    : [{ minute: peak, weights: DAY }];
  return [
    { minute: 0, weights: NIGHT },
    { minute: lead, weights: NIGHT },
    { minute: dawnStart, weights: DAWN },
    { minute: dawnEnd, weights: DAWN },
    ...middle,
    { minute: sunset + 30, weights: DUSK },
    { minute: sunset + 120, weights: DUSK },
    { minute: sunset + 210, weights: NIGHT },
    { minute: Math.max(MINUTES_PER_DAY, sunset + 210), weights: NIGHT },
  ];
}

/** Keyframes that start at or before midnight are clamped, then thinned. */
function photoKeyframes(
  sunrise: number,
  sunset: number,
): readonly PhotoKeyframe[] {
  const result: PhotoKeyframe[] = [];
  for (const keyframe of rawKeyframes(sunrise, sunset)) {
    const minute = Math.max(0, keyframe.minute);
    const last = result[result.length - 1];
    if (last && minute <= last.minute) {
      continue;
    }
    result.push({ minute, weights: keyframe.weights });
  }
  return result;
}

const FIXED_KEYFRAMES = photoKeyframes(
  LOCAL_SUNRISE_MINUTE,
  LOCAL_SUNSET_MINUTE,
);

function tailReachesToday(previous?: {
  sunriseMinute: number;
  sunsetMinute: number;
}): previous is { sunriseMinute: number; sunsetMinute: number } {
  return (
    previous !== undefined &&
    Number.isFinite(previous.sunriseMinute) &&
    Number.isFinite(previous.sunsetMinute) &&
    previous.sunriseMinute < previous.sunsetMinute &&
    previous.sunsetMinute + 210 > MINUTES_PER_DAY
  );
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function normalizeMinute(date: Date): number {
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) {
    throw new TypeError('A valid local date is required.');
  }

  return (
    date.getHours() * 60 +
    date.getMinutes() +
    date.getSeconds() / 60 +
    date.getMilliseconds() / 60_000
  );
}

function phaseForMinute(
  minute: number,
  sunrise = LOCAL_SUNRISE_MINUTE,
  sunset = LOCAL_SUNSET_MINUTE,
): Pick<
  CircadianTheme,
  'phase' | 'phaseLabel'
> {
  if (minute < sunrise - 60 || minute >= sunset + 180) {
    return { phase: 'night', phaseLabel: '夜' };
  }
  if (minute < sunrise + 60) {
    return { phase: 'dawn', phaseLabel: '夜明け' };
  }
  if (minute < Math.min(sunrise + 300, sunset - 120)) {
    return { phase: 'morning', phaseLabel: '朝' };
  }
  if (minute < sunset - 120) {
    return { phase: 'day', phaseLabel: '昼' };
  }
  if (minute < sunset) {
    return { phase: 'golden-hour', phaseLabel: '夕方' };
  }
  return { phase: 'dusk', phaseLabel: '日暮れ' };
}

function photoWeightsForMinute(
  minute: number,
  keyframes: readonly PhotoKeyframe[],
): CircadianPhotoWeights {
  const nextIndex = keyframes.findIndex(
    (keyframe) => keyframe.minute >= minute,
  );
  const rightIndex =
    nextIndex === -1 ? keyframes.length - 1 : nextIndex;
  const leftIndex = Math.max(0, rightIndex - 1);
  const left = keyframes[leftIndex];
  const right = keyframes[rightIndex];
  const duration = Math.max(1, right.minute - left.minute);
  const progress = clamp((minute - left.minute) / duration);

  return {
    dawn: interpolate(left.weights.dawn, right.weights.dawn, progress),
    day: interpolate(left.weights.day, right.weights.day, progress),
    dusk: interpolate(left.weights.dusk, right.weights.dusk, progress),
    night: interpolate(left.weights.night, right.weights.night, progress),
  };
}

/**
 * Today's weights, with yesterday's post-sunset tail carried into the early
 * hours. Today's timeline always wins: where its night -> dawn ramp starts
 * (the earliest the sun can matter today) the tail is handed over, so the
 * light still left in yesterday's dusk fades out exactly as dawn fades in.
 * With w the progress of that ramp, weights = today + (1 - w) * (tail - NIGHT):
 * it equals the tail at the ramp start, today at its end, always sums to 1,
 * and is identical to today alone whenever the tail is already night. No
 * keyframe of either day is discarded.
 */
function scheduledWeights(
  minute: number,
  sunrise: number,
  sunset: number,
  previous?: { sunriseMinute: number; sunsetMinute: number },
): CircadianPhotoWeights {
  const today = photoKeyframes(sunrise, sunset);
  const weights = photoWeightsForMinute(minute, today);
  if (!tailReachesToday(previous)) {
    return weights;
  }
  const litIndex = today.findIndex((keyframe) => keyframe.weights !== NIGHT);
  const handoffStart = today[Math.max(0, litIndex - 1)].minute;
  const handoffEnd = today[Math.max(0, litIndex)].minute;
  if (minute >= handoffEnd) {
    return weights;
  }
  const tail = photoWeightsForMinute(
    minute,
    photoKeyframes(previous.sunriseMinute, previous.sunsetMinute).map(
      (keyframe) => ({
        ...keyframe,
        minute: keyframe.minute - MINUTES_PER_DAY,
      }),
    ),
  );
  const carried = clamp(
    (handoffEnd - minute) / Math.max(1, handoffEnd - handoffStart),
  );
  const mix = (today: number, tailWeight: number, night: number) =>
    clamp(today + carried * (tailWeight - night));
  return {
    dawn: mix(weights.dawn, tail.dawn, 0),
    day: mix(weights.day, tail.day, 0),
    dusk: mix(weights.dusk, tail.dusk, 0),
    night: mix(weights.night, tail.night, 1),
  };
}

function minuteInZone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(date);
    const read = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const minute = read('hour') * 60 + read('minute') + read('second') / 60;
    return Number.isFinite(minute) ? minute : null;
  } catch {
    return null;
  }
}

export function getCircadianTheme(
  date: Date,
  schedule?: CircadianSchedule,
): CircadianTheme {
  const fixedMinute = normalizeMinute(date);
  if (schedule) {
    const minute = minuteInZone(date, schedule.timeZone);
    if (
      minute !== null &&
      Number.isFinite(schedule.sunriseMinute) &&
      Number.isFinite(schedule.sunsetMinute) &&
      schedule.sunriseMinute < schedule.sunsetMinute
    ) {
      const previous = schedule.previous;
      const inPreviousTail =
        previous !== undefined &&
        previous.sunriseMinute < previous.sunsetMinute &&
        previous.sunsetMinute + 180 > MINUTES_PER_DAY &&
        minute < schedule.sunriseMinute - 60 &&
        minute + MINUTES_PER_DAY < previous.sunsetMinute + 180;
      return {
        ...(inPreviousTail
          ? phaseForMinute(
              minute + MINUTES_PER_DAY,
              previous.sunriseMinute,
              previous.sunsetMinute,
            )
          : phaseForMinute(
              minute,
              schedule.sunriseMinute,
              schedule.sunsetMinute,
            )),
        photoWeights: scheduledWeights(
          minute,
          schedule.sunriseMinute,
          schedule.sunsetMinute,
          previous,
        ),
      };
    }
  }
  return {
    ...phaseForMinute(fixedMinute),
    photoWeights: photoWeightsForMinute(fixedMinute, FIXED_KEYFRAMES),
  };
}
