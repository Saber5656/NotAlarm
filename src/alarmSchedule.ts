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
    throw new Error('日付を取得できません。');
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
        throw new Error('繰り返す曜日を1つ以上選択してください。');
      }
      return { kind, weekdays };
    }
  }
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
      /^\d{4}-\d{2}-\d{2}$/.test(repeat.dateKey)
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
    throw new Error('繰り返し設定が正しくありません。');
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
    throw new Error('有効なアラーム時刻を選択してください。');
  }
}

function dateFromKey(dateKey: string, hour: number, minute: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (localDateKey(candidate.getTime()) !== dateKey) {
    throw new Error('アラームの日付が正しくありません。');
  }
  return candidate.getTime();
}
