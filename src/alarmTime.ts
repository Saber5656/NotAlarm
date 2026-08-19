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
