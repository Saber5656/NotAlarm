import {
  type AlarmCancellationCompletion,
  type StoredAlarmDefinition,
  loadPendingAlarmCancellations,
  loadPendingAlarmEdits,
  removePendingAlarmCancellation,
  transactAlarmDefinitions,
  upsertPendingAlarmCancellation,
} from '../../alarmStorage';
import { cancelAlarmDefinitionWithCheckpoints } from '../../alarmCancellation';
import {
  editAlarmDefinition,
  recoverPendingAlarmEdit,
} from '../../alarmEdit';
import type { AlarmRepeat } from '../../alarmSchedule';
import { AppError } from '../../errorCatalog';
import { describeErrorIn, noticeFromCodeIn, type Messages } from '../../i18n';
import { assertNoPendingReset } from '../../storageResetGate';
import { suppressionJournal } from '../../suppressionJournalStorage';
import {
  alarmEditGateway,
  alarmEditJournal,
  cancellationGateway,
} from './gateways';

export async function cancelAlarmDefinitionPersistently(
  alarmId: string,
  completion: AlarmCancellationCompletion,
): Promise<StoredAlarmDefinition[]> {
  const next = await transactAlarmDefinitions(async (current, checkpoint) => {
    const latest = current.find((alarm) => alarm.id === alarmId);
    if (!latest) {
      throw new AppError('ALARM_NOT_FOUND');
    }
    const targetCycleIds = latest.cycles.map((cycle) => cycle.cycleId);
    await upsertPendingAlarmCancellation({
      alarmId,
      completion,
      cycleIds: targetCycleIds,
      requestedAtMs: Date.now(),
    });
    return cancelAlarmDefinitionWithCheckpoints({
      alarms: current,
      alarmId,
      completion,
      targetCycleIds,
      gateway: cancellationGateway,
      checkpoint,
    });
  });
  await removePendingAlarmCancellation(alarmId);
  return next;
}

export async function hasPendingAlarmEdit(alarmId: string): Promise<boolean> {
  return (await loadPendingAlarmEdits()).some(
    (entry) => entry.alarmId === alarmId,
  );
}

/**
 * The cancellation failure copy promises a resume on the next launch, so it is
 * only used when that resume record is really stored (and readable).
 */
export async function cancellationFailureNotice(
  messages: Messages,
  alarmId: string,
  error: unknown,
  incomplete: 'DISABLE_CANCEL_INCOMPLETE' | 'DELETE_CANCEL_INCOMPLETE',
) {
  try {
    if (
      (await loadPendingAlarmCancellations()).some(
        (pending) => pending.alarmId === alarmId,
      )
    ) {
      return noticeFromCodeIn(messages, incomplete);
    }
  } catch {
    // Unreadable record: nothing can be promised.
  }
  return describeErrorIn(messages, error);
}

/**
 * Replaces one alarm's schedule. Runs under the same lock as stop
 * confirmations so an old cycle cannot be suppressed while it is being
 * replaced. Only the ids journaled for this alarm are ever cancelled.
 */
export async function editAlarmPersistently(input: {
  alarmId: string;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
}) {
  return suppressionJournal.exclusive(async () => {
    // An unfinished reset owns the notification queue; nothing is scheduled.
    await assertNoPendingReset();
    let result: Awaited<ReturnType<typeof editAlarmDefinition>> | null = null;
    await transactAlarmDefinitions(async (current, checkpoint) => {
      result = await editAlarmDefinition({
        ...input,
        // Read after the locks are held and before each destructive step.
        now: Date.now,
        alarms: current,
        gateway: alarmEditGateway,
        journal: alarmEditJournal,
        checkpoint,
        hasUnsettledWork: async (alarmId, cycleIds) => {
          if (
            (await loadPendingAlarmCancellations()).some(
              (pending) => pending.alarmId === alarmId,
            )
          ) {
            return true;
          }
          return (await suppressionJournal.load()).some((intent) =>
            cycleIds.includes(intent.cycleId),
          );
        },
      });
      return result.alarms;
    });
    if (!result) {
      throw new AppError('UNEXPECTED_FAILURE');
    }
    return result as Awaited<ReturnType<typeof editAlarmDefinition>>;
  });
}

export async function recoverPendingAlarmEdits(): Promise<void> {
  // Same order as an edit: suppression lock first, then the storage queue.
  await suppressionJournal.exclusive(async () => {
    for (const entry of await loadPendingAlarmEdits()) {
      await transactAlarmDefinitions((current, checkpoint) =>
        recoverPendingAlarmEdit({
          alarms: current,
          entry,
          gateway: alarmEditGateway,
          journal: alarmEditJournal,
          checkpoint,
        }),
      );
    }
  });
}

export async function recoverPendingAlarmCancellations(): Promise<void> {
  const pendingEntries = await loadPendingAlarmCancellations();
  for (const pending of pendingEntries) {
    await transactAlarmDefinitions((current, checkpoint) => {
      if (!current.some((alarm) => alarm.id === pending.alarmId)) {
        return current;
      }
      return cancelAlarmDefinitionWithCheckpoints({
        alarms: current,
        alarmId: pending.alarmId,
        completion: pending.completion,
        targetCycleIds: pending.cycleIds,
        gateway: cancellationGateway,
        checkpoint,
      });
    });
    await removePendingAlarmCancellation(pending.alarmId);
  }
}
