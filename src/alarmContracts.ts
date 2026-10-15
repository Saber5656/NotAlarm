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
  /**
   * Exact scheduled delivery time of this notification (a snooze's own due
   * time for a snooze). Absent only on notifications queued before it existed.
   */
  dueAtMs?: number;
}

export function buildMainNotificationData(input: {
  alarmId: string;
  cycleId: string;
  dueAtMs: number;
}): AlarmNotificationData {
  return {
    owner: ALREADY_UP_OWNER,
    kind: MAIN_ALARM_KIND,
    alarmId: input.alarmId,
    cycleId: input.cycleId,
    dueAtMs: input.dueAtMs,
  };
}

export function buildSnoozeNotificationData(input: {
  alarmId: string;
  cycleId: string;
  dueAtMs: number;
  snoozeNumber: number;
}): AlarmNotificationData {
  return {
    ...buildMainNotificationData(input),
    snooze: input.snoozeNumber,
  };
}

/**
 * Reads what a delivered main notification claims to be. A missing `dueAtMs`
 * is the explicit legacy case (already queued); a provided one must be a
 * finite number, otherwise the payload is rejected rather than treated as
 * legacy.
 */
export function readMainDeliveryIdentity(
  data: unknown,
  deliveredId: string,
): {
  alarmId?: string;
  cycleId: string;
  mainAlarmId: string;
  dueAtMs?: number;
} | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { kind, alarmId, cycleId, dueAtMs } = data as Record<string, unknown>;
  if (kind !== MAIN_ALARM_KIND || typeof cycleId !== 'string') {
    return null;
  }
  if (
    dueAtMs !== undefined &&
    (typeof dueAtMs !== 'number' || !Number.isFinite(dueAtMs))
  ) {
    return null;
  }
  return {
    alarmId: typeof alarmId === 'string' ? alarmId : undefined,
    cycleId,
    mainAlarmId: deliveredId,
    dueAtMs: dueAtMs as number | undefined,
  };
}

/** Strict shape check shared by notification responses and ownership tests. */
export function parseAlarmNotificationData(
  data: unknown,
): AlarmNotificationData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { owner, kind, alarmId, cycleId, mainAlarmId, snooze, dueAtMs } = data as Record<
    string,
    unknown
  >;
  if (
    (kind !== MAIN_ALARM_KIND && kind !== CHECK_IN_KIND) ||
    (alarmId !== undefined && typeof alarmId !== 'string') ||
    typeof cycleId !== 'string' ||
    (mainAlarmId !== undefined && typeof mainAlarmId !== 'string') ||
    (owner !== undefined && typeof owner !== 'string') ||
    (snooze !== undefined && !Number.isInteger(snooze)) ||
    (dueAtMs !== undefined &&
      (typeof dueAtMs !== 'number' || !Number.isFinite(dueAtMs)))
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
    dueAtMs: dueAtMs as number | undefined,
  };
}
