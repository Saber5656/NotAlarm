export function getNextAlarmAtMs(
  nowMs: number,
  hour: number,
  minute: number,
): number {
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

  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

function normalizeClockDigits(value: string): string {
  return value
    .trim()
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    );
}

export function parseAlarmTimeInput(
  hourText: string,
  minuteText: string,
): { hour: number; minute: number } {
  const normalizedHour = normalizeClockDigits(hourText);
  const normalizedMinute = normalizeClockDigits(minuteText);
  const error = new Error('時は0〜23、分は0〜59で入力してください。');

  if (
    !/^\d{1,2}$/.test(normalizedHour) ||
    !/^\d{1,2}$/.test(normalizedMinute)
  ) {
    throw error;
  }

  const hour = Number(normalizedHour);
  const minute = Number(normalizedMinute);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw error;
  }

  return { hour, minute };
}
