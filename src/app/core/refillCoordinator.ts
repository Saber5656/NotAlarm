import type { AlarmSchedulingGateway } from '../../alarmOrchestrator';
import {
  type AlarmScheduleIssue,
  type RefillAttempt,
  describeScheduleIssues,
  fillAlarmDefinitionSchedule,
  getAlarmScheduleIssueKey,
  getSkippedRefillAttempt,
} from '../../alarmScheduling';
import {
  type ProvisionalSettlement,
  type RollbackFailureRecorder,
  type ScheduledNotificationRollbackGateway,
  withScheduledNotificationRollback,
} from '../../alarmScheduleRollback';
import type { StoredAlarm, StoredAlarmDefinition } from '../../alarmStorage';
import { errorCodeOf } from '../../errorCatalog';
import { noticeFromCodeIn, type Messages } from '../../i18n';
import { rememberRebuild } from '../../i18n/localizedNotice';
import { isStaleStorageResult } from '../../storageResetGate';
import type { AppNotice } from '../../ui/NoticeBanner';

export type ScheduleRefillTrigger = 'startup' | 'foreground';

export interface ScheduleRefillResult {
  /** The saved alarms, or null when nothing was saved. */
  alarms: StoredAlarmDefinition[] | null;
  /** Identifies the problems found so the same notice is not repeated. */
  problemKeys: string[];
  notice: AppNotice | null;
  /** Which alarms this refill covered and which it left short. */
  attempt: RefillAttempt;
}

export interface RefillCoordinatorDeps {
  /** False on the web build, which has no notifications to reserve. */
  isSupported: boolean;
  nowMs(): number;
  scheduling: AlarmSchedulingGateway & ProvisionalSettlement;
  cancellation: ScheduledNotificationRollbackGateway;
  orphans: RollbackFailureRecorder;
  storage: {
    mutate(
      mutator: (
        alarms: StoredAlarmDefinition[],
      ) => StoredAlarmDefinition[] | Promise<StoredAlarmDefinition[]>,
    ): Promise<StoredAlarmDefinition[]>;
  };
  prepareNotifications(): Promise<unknown>;
  prepareNotificationsIfGranted(): Promise<boolean>;
  loadPendingAlarmCancellations(): Promise<ReadonlyArray<{ alarmId: string }>>;
  loadPendingAlarmEdits(): Promise<ReadonlyArray<{ alarmId: string }>>;
  /** Throws when the journal is unreadable, which skips the whole refill. */
  loadSuppressionIntents(): Promise<ReadonlyArray<{ alarmId: string }>>;
  hasPendingReset(): Promise<boolean>;
  loadPlanningZone(): Promise<string | null>;
}

export interface RefillCoordinator {
  /**
   * Tops every enabled alarm back up to its upcoming occurrences. Returns null
   * when the refill is skipped (web, a refill already running, notifications
   * not allowed on a foreground refill, or a result a finished deletion made
   * obsolete). `apply` runs while the single flight is still held, so the
   * caller's bookkeeping cannot interleave with the next refill.
   */
  refill(
    trigger: ScheduleRefillTrigger,
    knownAlarms: readonly StoredAlarmDefinition[],
    messages: Messages,
    apply: (result: ScheduleRefillResult) => void,
  ): Promise<StoredAlarmDefinition[] | null>;
}

async function fillEnabledSchedules(
  deps: RefillCoordinatorDeps,
  alarms: StoredAlarmDefinition[],
  nowMs: number,
  excludedAlarmIds: ReadonlySet<string>,
  originZone: string | null,
): Promise<{
  alarms: StoredAlarmDefinition[];
  issues: AlarmScheduleIssue[];
  scheduledCycles: StoredAlarm[];
  /** Alarms left short because a stopped day's origin zone is unknown. */
  unverifiedAlarmIds: string[];
}> {
  const next: StoredAlarmDefinition[] = [];
  const issues: AlarmScheduleIssue[] = [];
  const scheduledCycles: StoredAlarm[] = [];
  const unverifiedAlarmIds: string[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled || excludedAlarmIds.has(alarm.id)) {
      next.push(alarm);
      continue;
    }

    try {
      const filled = await fillAlarmDefinitionSchedule(
        alarm,
        nowMs,
        deps.scheduling,
        undefined,
        undefined,
        originZone,
      );
      next.push(filled.definition);
      issues.push(...filled.issues);
      scheduledCycles.push(...filled.scheduledCycles);
      if (filled.originUnverified) {
        unverifiedAlarmIds.push(alarm.id);
      }
    } catch (error) {
      next.push(alarm);
      issues.push({
        kind: 'main_schedule_failed',
        alarmId: alarm.id,
        cycleId: 'schedule-recovery',
        dueAtMs: nowMs,
        code: errorCodeOf(error, 'MAIN_REGISTER_FAILED'),
      });
    }
  }

  return { alarms: next, issues, scheduledCycles, unverifiedAlarmIds };
}

async function refillEnabledSchedulesOnce(
  deps: RefillCoordinatorDeps,
  trigger: ScheduleRefillTrigger,
  knownAlarms: readonly StoredAlarmDefinition[],
  messages: Messages,
): Promise<ScheduleRefillResult | null> {
  try {
    if (trigger === 'startup') {
      await deps.prepareNotifications();
    } else if (!(await deps.prepareNotificationsIfGranted())) {
      return null;
    }

    // A stop or disable that has not finished must not get new reservations.
    // Startup retries it before refilling.
    const pendingAlarmIds = new Set(
      (await deps.loadPendingAlarmCancellations()).map(
        (pending) => pending.alarmId,
      ),
    );
    // A half-finished suppression means that cycle's state is not settled, so
    // its alarm must not be refilled until recovery resolves it. An
    // unreadable journal throws here and skips the whole refill.
    for (const pending of await deps.loadSuppressionIntents()) {
      pendingAlarmIds.add(pending.alarmId);
    }
    // An unfinished edit owns its alarm's schedule until startup settles it.
    for (const pending of await deps.loadPendingAlarmEdits()) {
      pendingAlarmIds.add(pending.alarmId);
    }
    const fillIssues: AlarmScheduleIssue[] = [];
    let attemptedAlarmIds: string[] = [];
    const unverifiedAlarmIds: string[] = [];
    const alarms = await withScheduledNotificationRollback(
      (track) =>
        deps.storage.mutate(async (current) => {
          // An unfinished deletion must not get fresh reservations.
          if (await deps.hasPendingReset()) {
            return current;
          }
          attemptedAlarmIds = current.map((alarm) => alarm.id);
          const filled = await fillEnabledSchedules(
            deps,
            current,
            deps.nowMs(),
            pendingAlarmIds,
            // Stopped days that predate their own identity are dated by the
            // zone the schedule was last reconciled in.
            await deps.loadPlanningZone(),
          );
          track(filled.scheduledCycles);
          fillIssues.push(...filled.issues);
          unverifiedAlarmIds.push(...filled.unverifiedAlarmIds);
          return filled.alarms;
        }),
      deps.cancellation,
      deps.orphans,
      deps.scheduling,
    );
    return {
      alarms,
      attempt: {
        attemptedAlarmIds,
        issues: fillIssues,
        skippedAlarmIds: [...pendingAlarmIds, ...unverifiedAlarmIds],
      },
      problemKeys: fillIssues.map(getAlarmScheduleIssueKey),
      notice: (() => {
        const issueNotice = describeScheduleIssues(fillIssues, '', messages);
        return issueNotice
          ? rememberRebuild(
              issueNotice,
              (text) => describeScheduleIssues(fillIssues, '', text.messages)!,
            )
          : null;
      })(),
    };
  } catch (error) {
    const code = errorCodeOf(error, 'REFILL_FAILED');
    return {
      alarms: null,
      attempt: getSkippedRefillAttempt(knownAlarms),
      problemKeys: [`refill_failed:${code}`],
      notice: noticeFromCodeIn(messages, code),
    };
  }
}

export function createRefillCoordinator(
  deps: RefillCoordinatorDeps,
): RefillCoordinator {
  let inFlight = false;

  return {
    async refill(trigger, knownAlarms, messages, apply) {
      if (!deps.isSupported || inFlight) {
        return null;
      }

      inFlight = true;
      try {
        const result = await refillEnabledSchedulesOnce(
          deps,
          trigger,
          knownAlarms,
          messages,
        );
        if (!result || (result.alarms && isStaleStorageResult(result.alarms))) {
          return null;
        }
        apply(result);
        return result.alarms;
      } finally {
        inFlight = false;
      }
    },
  };
}
