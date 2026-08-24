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

const MINUTES_PER_DAY = 24 * 60;

const PHOTO_KEYFRAMES: readonly PhotoKeyframe[] = [
  {
    minute: 0,
    weights: { dawn: 0, day: 0, dusk: 0, night: 1 },
  },
  {
    minute: LOCAL_SUNRISE_MINUTE - 90,
    weights: { dawn: 0, day: 0, dusk: 0, night: 1 },
  },
  {
    minute: LOCAL_SUNRISE_MINUTE + 30,
    weights: { dawn: 1, day: 0, dusk: 0, night: 0 },
  },
  {
    minute: 8 * 60,
    weights: { dawn: 1, day: 0, dusk: 0, night: 0 },
  },
  {
    minute: 10 * 60,
    weights: { dawn: 0, day: 1, dusk: 0, night: 0 },
  },
  {
    minute: 16 * 60,
    weights: { dawn: 0, day: 1, dusk: 0, night: 0 },
  },
  {
    minute: LOCAL_SUNSET_MINUTE + 30,
    weights: { dawn: 0, day: 0, dusk: 1, night: 0 },
  },
  {
    minute: 20 * 60,
    weights: { dawn: 0, day: 0, dusk: 1, night: 0 },
  },
  {
    minute: 21 * 60 + 30,
    weights: { dawn: 0, day: 0, dusk: 0, night: 1 },
  },
  {
    minute: MINUTES_PER_DAY,
    weights: { dawn: 0, day: 0, dusk: 0, night: 1 },
  },
];

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

function phaseForMinute(minute: number): Pick<
  CircadianTheme,
  'phase' | 'phaseLabel'
> {
  if (minute < 5 * 60 || minute >= 21 * 60) {
    return { phase: 'night', phaseLabel: '夜' };
  }
  if (minute < 7 * 60) {
    return { phase: 'dawn', phaseLabel: '夜明け' };
  }
  if (minute < 11 * 60) {
    return { phase: 'morning', phaseLabel: '朝' };
  }
  if (minute < 16 * 60) {
    return { phase: 'day', phaseLabel: '昼' };
  }
  if (minute < LOCAL_SUNSET_MINUTE) {
    return { phase: 'golden-hour', phaseLabel: '夕方' };
  }
  return { phase: 'dusk', phaseLabel: '日暮れ' };
}

function photoWeightsForMinute(minute: number): CircadianPhotoWeights {
  const nextIndex = PHOTO_KEYFRAMES.findIndex(
    (keyframe) => keyframe.minute >= minute,
  );
  const rightIndex =
    nextIndex === -1 ? PHOTO_KEYFRAMES.length - 1 : nextIndex;
  const leftIndex = Math.max(0, rightIndex - 1);
  const left = PHOTO_KEYFRAMES[leftIndex];
  const right = PHOTO_KEYFRAMES[rightIndex];
  const duration = Math.max(1, right.minute - left.minute);
  const progress = clamp((minute - left.minute) / duration);

  return {
    dawn: interpolate(left.weights.dawn, right.weights.dawn, progress),
    day: interpolate(left.weights.day, right.weights.day, progress),
    dusk: interpolate(left.weights.dusk, right.weights.dusk, progress),
    night: interpolate(left.weights.night, right.weights.night, progress),
  };
}

export function getCircadianTheme(date: Date): CircadianTheme {
  const minute = normalizeMinute(date);
  return {
    ...phaseForMinute(minute),
    photoWeights: photoWeightsForMinute(minute),
  };
}
