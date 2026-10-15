export const AWAKE_CHECKIN_CATEGORY = 'awake_checkin';
export const CONFIRM_AWAKE_ACTION = 'confirm_awake';
export const MAIN_ALARM_KIND = 'main_alarm';
export const CHECK_IN_KIND = 'awake_checkin';

/** Stable marker on every payload this app schedules (Expo Go shares a queue). */
export const ALREADY_UP_OWNER = 'already-up/v1';

export interface AlarmNotificationData {
  owner?: string;
  kind: typeof MAIN_ALARM_KIND | typeof CHECK_IN_KIND;
  alarmId?: string;
  cycleId: string;
  mainAlarmId?: string;
  /** 1-based snooze number; present only on a snooze delivery. */
  snooze?: number;
}

/** Strict shape check shared by notification responses and ownership tests. */
export function parseAlarmNotificationData(
  data: unknown,
): AlarmNotificationData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { owner, kind, alarmId, cycleId, mainAlarmId, snooze } = data as Record<
    string,
    unknown
  >;
  if (
    (kind !== MAIN_ALARM_KIND && kind !== CHECK_IN_KIND) ||
    (alarmId !== undefined && typeof alarmId !== 'string') ||
    typeof cycleId !== 'string' ||
    (mainAlarmId !== undefined && typeof mainAlarmId !== 'string') ||
    (owner !== undefined && typeof owner !== 'string') ||
    (snooze !== undefined && !Number.isInteger(snooze))
  ) {
    return null;
  }
  return {
    owner,
    kind,
    alarmId,
    cycleId,
    mainAlarmId,
    snooze: snooze as number | undefined,
  };
}
