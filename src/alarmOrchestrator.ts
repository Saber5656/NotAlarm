import {
  CHECK_IN_KIND,
  CONFIRM_AWAKE_ACTION,
} from './alarmContracts';
import { canSuppressAlarm, finalizeSuppression } from './alarmPolicy';
import type { StoredAlarm } from './alarmStorage';

export interface AlarmSchedulingGateway {
  scheduleMain(input: { cycleId: string; dueAtMs: number }): Promise<string>;
  scheduleCheckIn(input: {
    cycleId: string;
    mainAlarmId: string;
    checkInAtMs: number;
  }): Promise<string>;
}

export interface ScheduledAlarmNotifications {
  mainAlarmId: string;
  checkInNotificationId?: string;
  checkInAtMs: number;
  checkInWarning?: string;
}

export async function scheduleAlarmNotificationsFailSafe(
  gateway: AlarmSchedulingGateway,
  input: { cycleId: string; dueAtMs: number; checkInAtMs: number },
): Promise<ScheduledAlarmNotifications> {
  const mainAlarmId = await gateway.scheduleMain({
    cycleId: input.cycleId,
    dueAtMs: input.dueAtMs,
  });

  try {
    const checkInNotificationId = await gateway.scheduleCheckIn({
      cycleId: input.cycleId,
      mainAlarmId,
      checkInAtMs: input.checkInAtMs,
    });

    return {
      mainAlarmId,
      checkInNotificationId,
      checkInAtMs: input.checkInAtMs,
    };
  } catch (error) {
    return {
      mainAlarmId,
      checkInAtMs: input.checkInAtMs,
      checkInWarning:
        error instanceof Error
          ? error.message
          : '起床確認通知を予約できませんでした。',
    };
  }
}

export interface AwakeResponseInput {
  actionIdentifier: string;
  kind: string | undefined;
  cycleId: string | undefined;
  mainAlarmId: string | undefined;
  checkInNotificationId: string;
  confirmedAtMs: number;
}

export interface AwakeResponseDependencies {
  loadAlarm(): Promise<StoredAlarm | null>;
  saveAlarm(alarm: StoredAlarm): Promise<void>;
  cancelScheduled(notificationId: string): Promise<boolean>;
}

export type AwakeResponseResult =
  | { status: 'ignored'; reason: 'NOT_CONFIRM_ACTION' }
  | { status: 'alarm_remains'; reason: string }
  | { status: 'suppressed'; alarm: StoredAlarm };

export async function processAwakeResponseFailSafe(
  dependencies: AwakeResponseDependencies,
  input: AwakeResponseInput,
): Promise<AwakeResponseResult> {
  if (input.actionIdentifier !== CONFIRM_AWAKE_ACTION) {
    return { status: 'ignored', reason: 'NOT_CONFIRM_ACTION' };
  }

  if (
    input.kind !== CHECK_IN_KIND ||
    typeof input.cycleId !== 'string' ||
    typeof input.mainAlarmId !== 'string'
  ) {
    return { status: 'alarm_remains', reason: 'INVALID_RESPONSE' };
  }

  const activeAlarm = await dependencies.loadAlarm();
  if (
    !activeAlarm ||
    (activeAlarm.phase !== 'armed' &&
      activeAlarm.phase !== 'step_candidate') ||
    typeof activeAlarm.checkInNotificationId !== 'string'
  ) {
    return { status: 'alarm_remains', reason: 'NO_ACTIVE_ALARM' };
  }

  const decision = canSuppressAlarm(
    {
      cycleId: activeAlarm.cycleId,
      mainAlarmId: activeAlarm.mainAlarmId,
      checkInNotificationId: activeAlarm.checkInNotificationId,
      armedAtMs: activeAlarm.armedAtMs,
      dueAtMs: activeAlarm.dueAtMs,
    },
    {
      kind: 'EXPLICIT_AWAKE_CONFIRMATION',
      cycleId: input.cycleId,
      mainAlarmId: input.mainAlarmId,
      checkInNotificationId: input.checkInNotificationId,
      confirmedAtMs: input.confirmedAtMs,
    },
    input.confirmedAtMs,
  );

  if (!decision.canSuppress) {
    return { status: 'alarm_remains', reason: decision.reason };
  }

  const cancellationSucceeded = await dependencies.cancelScheduled(
    activeAlarm.mainAlarmId,
  );
  if (
    finalizeSuppression(decision, cancellationSucceeded) !== 'SUPPRESSED'
  ) {
    return { status: 'alarm_remains', reason: 'CANCEL_NOT_VERIFIED' };
  }

  const suppressed: StoredAlarm = {
    ...activeAlarm,
    phase: 'suppressed',
    confirmedAtMs: input.confirmedAtMs,
  };
  await dependencies.saveAlarm(suppressed);
  return { status: 'suppressed', alarm: suppressed };
}
