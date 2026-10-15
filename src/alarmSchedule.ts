import { AppError } from './errorCatalog';

export const MAX_ALARM_COUNT = 10;
export const SCHEDULED_OCCURRENCES_PER_ALARM = 3;

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type RepeatKind = 'today' | 'daily' | 'weekdays' | 'custom';

export interface AlarmRepeat {
  kind: RepeatKind;
  weekdays: Weekday[];
  dateKey?: string;
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: '日',
  1: '月',
  2: '火',
  3: '水',
  4: '木',
  5: '金',
  6: '土',
};

const EVERY_DAY = [...WEEKDAYS];
const WEEKDAYS_ONLY: Weekday[] = [1, 2, 3, 4, 5];

export function localDateKey(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    throw new AppError('TIME_INVALID');
  }

  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function makeAlarmRepeat(
  kind: RepeatKind,
  nowMs: number,
  customWeekdays: readonly number[] = [],
): AlarmRepeat {
  switch (kind) {
    case 'today':
      return { kind, weekdays: [], dateKey: localDateKey(nowMs) };
    case 'daily':
      return { kind, weekdays: [...EVERY_DAY] };
    case 'weekdays':
      return { kind, weekdays: [...WEEKDAYS_ONLY] };
    case 'custom': {
      const weekdays = normalizeWeekdays(customWeekdays);
      if (weekdays.length === 0) {
        throw new AppError('REPEAT_INVALID');
      }
      return { kind, weekdays };
    }
  }
}

/**
 * The repeat a saved edit should use. A today-only alarm that stays today-only
 * keeps its original date; it is never silently moved to another day.
 */
export function resolveEditedRepeat(
  original: AlarmRepeat,
  kind: RepeatKind,
  customWeekdays: readonly Weekday[],
  nowMs: number,
): AlarmRepeat {
  if (kind === 'today' && original.kind === 'today') {
    return original;
  }
  return makeAlarmRepeat(kind, nowMs, customWeekdays);
}

export function normalizeWeekdays(values: readonly number[]): Weekday[] {
  return [...new Set(values)]
    .filter((value): value is Weekday =>
      WEEKDAYS.includes(value as Weekday),
    )
    .sort((left, right) => left - right);
}

export function isAlarmRepeat(value: unknown): value is AlarmRepeat {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const repeat = value as Partial<AlarmRepeat>;
  if (
    repeat.kind !== 'today' &&
    repeat.kind !== 'daily' &&
    repeat.kind !== 'weekdays' &&
    repeat.kind !== 'custom'
  ) {
    return false;
  }

  if (!Array.isArray(repeat.weekdays)) {
    return false;
  }

  const normalized = normalizeWeekdays(repeat.weekdays);
  if (normalized.length !== repeat.weekdays.length) {
    return false;
  }

  if (repeat.kind === 'today') {
    return (
      repeat.weekdays.length === 0 &&
      typeof repeat.dateKey === 'string' &&
      isValidDateKey(repeat.dateKey)
    );
  }

  if (repeat.kind === 'daily') {
    return normalized.length === 7;
  }

  if (repeat.kind === 'weekdays') {
    return (
      normalized.length === WEEKDAYS_ONLY.length &&
      WEEKDAYS_ONLY.every((weekday) => normalized.includes(weekday))
    );
  }

  return normalized.length > 0;
}

export function isValidDateKey(dateKey: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function formatRepeatLabel(repeat: AlarmRepeat): string {
  switch (repeat.kind) {
    case 'today':
      return '今日だけ';
    case 'daily':
      return '毎日';
    case 'weekdays':
      return '平日';
    case 'custom':
      return repeat.weekdays.map((weekday) => WEEKDAY_LABELS[weekday]).join('・');
  }
}

export function getUpcomingAlarmTimes(
  nowMs: number,
  hour: number,
  minute: number,
  repeat: AlarmRepeat,
  count: number = SCHEDULED_OCCURRENCES_PER_ALARM,
): number[] {
  validateClock(nowMs, hour, minute);
  if (!isAlarmRepeat(repeat) || !Number.isInteger(count) || count < 1) {
    throw new AppError('REPEAT_INVALID');
  }

  if (repeat.kind === 'today') {
    const candidate = dateFromKey(repeat.dateKey!, hour, minute);
    return candidate > nowMs ? [candidate] : [];
  }

  const results: number[] = [];
  const cursor = new Date(nowMs);
  cursor.setHours(hour, minute, 0, 0);

  for (let dayOffset = 0; dayOffset < 370 && results.length < count; dayOffset += 1) {
    const candidate = new Date(cursor);
    candidate.setDate(cursor.getDate() + dayOffset);
    const candidateMs = candidate.getTime();
    const weekday = candidate.getDay() as Weekday;

    if (candidateMs > nowMs && repeat.weekdays.includes(weekday)) {
      results.push(candidateMs);
    }
  }

  return results;
}

export function getNextAlarmTime(
  nowMs: number,
  hour: number,
  minute: number,
  repeat: AlarmRepeat,
): number | null {
  return getUpcomingAlarmTimes(nowMs, hour, minute, repeat, 1)[0] ?? null;
}

function validateClock(nowMs: number, hour: number, minute: number): void {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new AppError('TIME_INVALID');
  }
}

function dateFromKey(dateKey: string, hour: number, minute: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (localDateKey(candidate.getTime()) !== dateKey) {
    throw new AppError('TIME_INVALID');
  }
  return candidate.getTime();
}

/**
 * Whether a stored due time still matches the alarm's local wall-clock time.
 * Repeating HH:mm and the today-only date key are both local to the current
 * time zone, so after a zone change an occurrence planned earlier no longer
 * lines up. The check uses the same constructor as the planner, so a time that
 * does not exist on a DST day is judged by where the planner places it.
 */
export function isDueTimeWallClockAligned(
  dueAtMs: number,
  hour: number,
  minute: number,
  repeat: AlarmRepeat,
): boolean {
  if (!Number.isFinite(dueAtMs)) {
    return false;
  }
  const due = new Date(dueAtMs);
  if (repeat.kind === 'today') {
    try {
      return dateFromKey(repeat.dateKey!, hour, minute) === dueAtMs;
    } catch {
      return false;
    }
  }
  const expected = new Date(
    due.getFullYear(),
    due.getMonth(),
    due.getDate(),
    hour,
    minute,
    0,
    0,
  ).getTime();
  return (
    expected === dueAtMs && repeat.weekdays.includes(due.getDay() as Weekday)
  );
}
