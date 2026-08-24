import type {
  AlarmCancellationCompletion,
  StoredAlarmDefinition,
} from './alarmStorage';

export interface AlarmCancellationGateway {
  cancelScheduled(notificationId: string | undefined): Promise<void>;
  dismissDelivered(notificationId: string | undefined): Promise<void>;
}

export type AlarmCancellationCheckpoint = (
  alarms: StoredAlarmDefinition[],
) => Promise<void>;

interface CancelAlarmDefinitionInput {
  alarms: StoredAlarmDefinition[];
  alarmId: string;
  completion: AlarmCancellationCompletion;
  targetCycleIds?: readonly string[];
  gateway: AlarmCancellationGateway;
  checkpoint: AlarmCancellationCheckpoint;
}

function updateTarget(
  alarms: StoredAlarmDefinition[],
  alarmId: string,
  update: (alarm: StoredAlarmDefinition) => StoredAlarmDefinition | null,
): StoredAlarmDefinition[] {
  return alarms.flatMap((alarm) => {
    if (alarm.id !== alarmId) {
      return [alarm];
    }
    const updated = update(alarm);
    return updated ? [updated] : [];
  });
}

async function dismissBestEffort(
  gateway: AlarmCancellationGateway,
  notificationId: string | undefined,
): Promise<void> {
  try {
    await gateway.dismissDelivered(notificationId);
  } catch {
    // Scheduled-notification truth is authoritative. A stale delivered banner
    // must not make a successfully cancelled alarm eligible for rescheduling.
  }
}

export async function cancelAlarmDefinitionWithCheckpoints({
  alarms,
  alarmId,
  completion,
  targetCycleIds,
  gateway,
  checkpoint,
}: CancelAlarmDefinitionInput): Promise<StoredAlarmDefinition[]> {
  const target = alarms.find((alarm) => alarm.id === alarmId);
  if (!target) {
    throw new Error('対象のアラームが見つかりません。');
  }

  let next = alarms;
  const cycleIds = targetCycleIds
    ? [...new Set(targetCycleIds)]
    : target.cycles.map((cycle) => cycle.cycleId);

  if (cycleIds.length === 0) {
    if (target.cycles.length > 0) {
      return next;
    }
    next = updateTarget(next, alarmId, (alarm) =>
      completion === 'delete'
        ? null
        : { ...alarm, enabled: false, cycles: [] },
    );
    await checkpoint(next);
    return next;
  }

  const hasMatchingCycle = target.cycles.some((cycle) =>
    cycleIds.includes(cycle.cycleId),
  );
  if (!hasMatchingCycle) {
    return next;
  }

  for (const cycleId of cycleIds) {
    const currentTarget = next.find((alarm) => alarm.id === alarmId);
    const cycle = currentTarget?.cycles.find(
      (candidate) => candidate.cycleId === cycleId,
    );
    if (!cycle) {
      continue;
    }

    if (cycle.checkInNotificationId) {
      await gateway.cancelScheduled(cycle.checkInNotificationId);
      next = updateTarget(next, alarmId, (alarm) => ({
        ...alarm,
        cycles: alarm.cycles.map((candidate) =>
          candidate.cycleId === cycleId
            ? { ...candidate, checkInNotificationId: undefined }
            : candidate,
        ),
      }));
      await checkpoint(next);
      await dismissBestEffort(gateway, cycle.checkInNotificationId);
    }

    await gateway.cancelScheduled(cycle.mainAlarmId);
    next = updateTarget(next, alarmId, (alarm) => {
      const remainingCycles = alarm.cycles.filter(
        (candidate) => candidate.cycleId !== cycleId,
      );
      if (remainingCycles.length > 0) {
        return { ...alarm, cycles: remainingCycles };
      }
      if (completion === 'delete') {
        return null;
      }
      return { ...alarm, enabled: false, cycles: [] };
    });
    await checkpoint(next);
    await dismissBestEffort(gateway, cycle.mainAlarmId);
  }

  return next;
}
