import type { StoredAlarm } from './alarmStorage';

export interface ScheduledNotificationRollbackGateway {
  cancelScheduled(notificationId: string | undefined): Promise<void>;
}

export type TrackScheduledCycles = (cycles: readonly StoredAlarm[]) => void;

export interface ScheduledNotificationRollbackFailure {
  notificationId: string;
  message: string;
}

export class ScheduledNotificationRollbackError extends Error {
  readonly failures: ScheduledNotificationRollbackFailure[];
  readonly originalError: unknown;

  constructor(
    originalError: unknown,
    failures: ScheduledNotificationRollbackFailure[],
  ) {
    super(
      'アラーム設定を保存できず、予約済み通知の一部も解除できませんでした。端末の通知一覧を確認してください。',
    );
    this.name = 'ScheduledNotificationRollbackError';
    this.failures = failures;
    this.originalError = originalError;
  }
}

export async function rollbackScheduledCycles(
  cycles: readonly StoredAlarm[],
  gateway: ScheduledNotificationRollbackGateway,
): Promise<ScheduledNotificationRollbackFailure[]> {
  const ids = [
    ...new Set(
      cycles.flatMap((cycle) =>
        [cycle.checkInNotificationId, cycle.mainAlarmId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ),
  ];
  const failures: ScheduledNotificationRollbackFailure[] = [];

  for (const notificationId of ids) {
    try {
      await gateway.cancelScheduled(notificationId);
    } catch (error) {
      failures.push({
        notificationId,
        message:
          error instanceof Error
            ? error.message
            : '予約済み通知を解除できませんでした。',
      });
    }
  }

  return failures;
}

export async function withScheduledNotificationRollback<T>(
  operation: (track: TrackScheduledCycles) => Promise<T>,
  gateway: ScheduledNotificationRollbackGateway,
): Promise<T> {
  const scheduledCycles: StoredAlarm[] = [];
  const track: TrackScheduledCycles = (cycles) => {
    scheduledCycles.push(...cycles);
  };

  try {
    return await operation(track);
  } catch (error) {
    const failures = await rollbackScheduledCycles(scheduledCycles, gateway);
    if (failures.length > 0) {
      throw new ScheduledNotificationRollbackError(error, failures);
    }
    throw error;
  }
}
