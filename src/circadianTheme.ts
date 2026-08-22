export const LOCAL_SUNRISE_MINUTE = 6 * 60;
export const LOCAL_SUNSET_MINUTE = 18 * 60;

export type CircadianPhase =
  | 'night'
  | 'dawn'
  | 'morning'
  | 'day'
  | 'golden-hour'
  | 'dusk';

export interface CelestialState {
  opacity: number;
  progress: number;
  x: number;
  y: number;
}

export interface CircadianTheme {
  horizonColor: string;
  moon: CelestialState;
  phase: CircadianPhase;
  phaseLabel: string;
  skyColors: readonly [string, string, string, string];
  starsOpacity: number;
  sun: CelestialState;
}

interface SkyKeyframe {
  colors: readonly [string, string, string, string];
  horizonColor: string;
  minute: number;
}

const MINUTES_PER_DAY = 24 * 60;
const TWILIGHT_MINUTES = 30;

const NIGHT_COLORS = [
  '#020A1B',
  '#082451',
  '#234E7C',
  '#172640',
] as const;

const SKY_KEYFRAMES: readonly SkyKeyframe[] = [
  {
    minute: 0,
    colors: NIGHT_COLORS,
    horizonColor: '#385A78',
  },
  {
    minute: 5 * 60,
    colors: ['#061127', '#153661', '#7C6479', '#E2A478'],
    horizonColor: '#F0BD8A',
  },
  {
    minute: 6 * 60 + 30,
    colors: ['#092753', '#35618D', '#D28A68', '#F5C891'],
    horizonColor: '#FFD49E',
  },
  {
    minute: 10 * 60,
    colors: ['#0B3F72', '#397EAD', '#92BED6', '#DCE8EB'],
    horizonColor: '#F4DBB0',
  },
  {
    minute: 13 * 60,
    colors: ['#0A426F', '#438AB6', '#A4CBDD', '#E6F0F1'],
    horizonColor: '#F5E5C6',
  },
  {
    minute: 17 * 60,
    colors: ['#0A3563', '#406D91', '#D78F6C', '#F5C88F'],
    horizonColor: '#FFD09A',
  },
  {
    minute: 19 * 60,
    colors: ['#071936', '#273B68', '#825F75', '#CF886F'],
    horizonColor: '#E8A078',
  },
  {
    minute: 21 * 60,
    colors: NIGHT_COLORS,
    horizonColor: '#385A78',
  },
  {
    minute: MINUTES_PER_DAY,
    colors: NIGHT_COLORS,
    horizonColor: '#385A78',
  },
];

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function parseHexColor(color: string): [number, number, number] {
  const normalized = color.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function interpolateColor(
  start: string,
  end: string,
  progress: number,
): string {
  const startChannels = parseHexColor(start);
  const endChannels = parseHexColor(end);
  const channels = startChannels.map((channel, index) =>
    Math.round(interpolate(channel, endChannels[index], progress)),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
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

function skyForMinute(minute: number): Pick<
  CircadianTheme,
  'horizonColor' | 'skyColors'
> {
  const nextIndex = SKY_KEYFRAMES.findIndex(
    (keyframe) => keyframe.minute >= minute,
  );
  const rightIndex = nextIndex === -1 ? SKY_KEYFRAMES.length - 1 : nextIndex;
  const leftIndex = Math.max(0, rightIndex - 1);
  const left = SKY_KEYFRAMES[leftIndex];
  const right = SKY_KEYFRAMES[rightIndex];
  const duration = Math.max(1, right.minute - left.minute);
  const progress = clamp((minute - left.minute) / duration);

  return {
    horizonColor: interpolateColor(
      left.horizonColor,
      right.horizonColor,
      progress,
    ),
    skyColors: [
      interpolateColor(left.colors[0], right.colors[0], progress),
      interpolateColor(left.colors[1], right.colors[1], progress),
      interpolateColor(left.colors[2], right.colors[2], progress),
      interpolateColor(left.colors[3], right.colors[3], progress),
    ],
  };
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
  if (minute < 18 * 60) {
    return { phase: 'golden-hour', phaseLabel: '夕方' };
  }
  return { phase: 'dusk', phaseLabel: '日暮れ' };
}

function celestialPosition(progress: number): Omit<CelestialState, 'opacity'> {
  const normalized = clamp(progress);
  return {
    progress: normalized,
    x: interpolate(0.1, 0.9, normalized),
    y: 0.64 - 0.45 * Math.sin(Math.PI * normalized),
  };
}

function sunForMinute(minute: number): CelestialState {
  const start = LOCAL_SUNRISE_MINUTE - TWILIGHT_MINUTES;
  const end = LOCAL_SUNSET_MINUTE + TWILIGHT_MINUTES;
  const position = celestialPosition((minute - start) / (end - start));
  let opacity = 0;

  if (minute >= start && minute < LOCAL_SUNRISE_MINUTE) {
    opacity = (minute - start) / TWILIGHT_MINUTES;
  } else if (minute >= LOCAL_SUNRISE_MINUTE && minute <= LOCAL_SUNSET_MINUTE) {
    opacity = 1;
  } else if (minute > LOCAL_SUNSET_MINUTE && minute <= end) {
    opacity = 1 - (minute - LOCAL_SUNSET_MINUTE) / TWILIGHT_MINUTES;
  }

  return { ...position, opacity: clamp(opacity) };
}

function moonForMinute(minute: number): CelestialState {
  const nightMinute =
    minute >= LOCAL_SUNSET_MINUTE
      ? minute - LOCAL_SUNSET_MINUTE
      : minute + (MINUTES_PER_DAY - LOCAL_SUNSET_MINUTE);
  const position = celestialPosition(
    nightMinute / (MINUTES_PER_DAY - LOCAL_SUNSET_MINUTE + LOCAL_SUNRISE_MINUTE),
  );
  const dawnStart = LOCAL_SUNRISE_MINUTE - TWILIGHT_MINUTES;
  const duskEnd = LOCAL_SUNSET_MINUTE + TWILIGHT_MINUTES;
  let opacity = 0;

  if (minute >= LOCAL_SUNSET_MINUTE && minute < duskEnd) {
    opacity = (minute - LOCAL_SUNSET_MINUTE) / TWILIGHT_MINUTES;
  } else if (minute >= duskEnd || minute < dawnStart) {
    opacity = 1;
  } else if (minute >= dawnStart && minute < LOCAL_SUNRISE_MINUTE) {
    opacity = 1 - (minute - dawnStart) / TWILIGHT_MINUTES;
  }

  return { ...position, opacity: clamp(opacity) };
}

function starsForMinute(minute: number): number {
  const dawnFadeStart = 4 * 60 + 30;
  const dawnFadeEnd = 6 * 60 + 30;
  const duskFadeStart = 17 * 60 + 30;
  const duskFadeEnd = 21 * 60;

  if (minute < dawnFadeStart || minute >= duskFadeEnd) {
    return 0.78;
  }
  if (minute < dawnFadeEnd) {
    return interpolate(
      0.78,
      0,
      (minute - dawnFadeStart) / (dawnFadeEnd - dawnFadeStart),
    );
  }
  if (minute < duskFadeStart) {
    return 0;
  }
  return interpolate(
    0,
    0.78,
    (minute - duskFadeStart) / (duskFadeEnd - duskFadeStart),
  );
}

export function getCircadianTheme(date: Date): CircadianTheme {
  const minute = normalizeMinute(date);
  return {
    ...skyForMinute(minute),
    ...phaseForMinute(minute),
    moon: moonForMinute(minute),
    starsOpacity: starsForMinute(minute),
    sun: sunForMinute(minute),
  };
}
