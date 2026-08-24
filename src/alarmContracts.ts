export const AWAKE_CHECKIN_CATEGORY = 'awake_checkin';
export const CONFIRM_AWAKE_ACTION = 'confirm_awake';
export const MAIN_ALARM_KIND = 'main_alarm';
export const CHECK_IN_KIND = 'awake_checkin';

export interface AlarmNotificationData {
  kind: typeof MAIN_ALARM_KIND | typeof CHECK_IN_KIND;
  alarmId?: string;
  cycleId: string;
  mainAlarmId?: string;
}
