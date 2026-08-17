import AsyncStorage from '@react-native-async-storage/async-storage';

export const ACTIVE_ALARM_STORAGE_KEY = 'already-up/active-alarm/v1';

export type AlarmPhase =
  | 'armed'
  | 'step_candidate'
  | 'suppressed'
  | 'ringing'
  | 'dismissed';

export interface StoredAlarm {
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
  phase: AlarmPhase;
  stepCount: number;
  stepCandidateAtMs?: number;
  confirmedAtMs?: number;
  stepCandidateRecorded: boolean;
}

function isStoredAlarm(value: unknown): value is StoredAlarm {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const alarm = value as Partial<StoredAlarm>;
  return (
    typeof alarm.cycleId === 'string' &&
    typeof alarm.mainAlarmId === 'string' &&
    typeof alarm.armedAtMs === 'number' &&
    Number.isFinite(alarm.armedAtMs) &&
    typeof alarm.dueAtMs === 'number' &&
    Number.isFinite(alarm.dueAtMs) &&
    typeof alarm.phase === 'string' &&
    ['armed', 'step_candidate', 'suppressed', 'ringing', 'dismissed'].includes(
      alarm.phase,
    ) &&
    typeof alarm.stepCount === 'number' &&
    typeof alarm.stepCandidateRecorded === 'boolean'
  );
}

export async function loadStoredAlarm(): Promise<StoredAlarm | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_ALARM_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredAlarm(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveStoredAlarm(alarm: StoredAlarm): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_ALARM_STORAGE_KEY, JSON.stringify(alarm));
}

export async function clearStoredAlarm(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE_ALARM_STORAGE_KEY);
}
