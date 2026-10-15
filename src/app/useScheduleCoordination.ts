import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  type AlarmScheduleIssue,
  type RefillAttempt,
  describeScheduleIssuesLocalized,
  fillAlarmDefinitionSchedule,
  getAlarmScheduleIssueSeverity,
  reconcileReportedScheduleProblems,
  recordRefillAttempt,
} from '../alarmScheduling';
import { withScheduledNotificationRollback } from '../alarmScheduleRollback';
import {
  type StoredAlarm,
  type StoredAlarmDefinition,
  mutateAlarmDefinitions,
} from '../alarmStorage';
import { withoutQueueStatus } from '../homeStatus';
import { noticeFromCodeIn } from '../i18n';
import { relocalizeNotice } from '../i18n/localizedNotice';
import { loadPlanningZone } from '../planningZone';
import {
  assessReconciledState,
  isObsoleteReconcileResult,
  type ReconciledState,
} from '../reconcileGate';
import {
  summarizeReconciliation,
  type AlarmQueueStatus,
} from '../scheduleReconciliation';
import { getSnoozeCopy } from '../snoozeCopy';
import {
  cancellationGateway,
  orphanStore,
  schedulingGateway,
  snoozeService,
} from './platform/gateways';
import {
  createAlarmRefillCoordinator,
  reconcileScheduleWithQueue,
} from './platform/coordinators';
import type { ScheduleRefillTrigger } from './core/refillCoordinator';
import type {
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
  TextRef,
} from './types';

/**
 * Refill, queue reconciliation and snooze recovery, with the per-alarm
 * bookkeeping they feed (which rows were left short, what the OS queue
 * showed). The single flights live in the coordinators; this hook only turns
 * their results into state and notices.
 */
export function useScheduleCoordination(input: {
  messagesNow: MessagesNow;
  textRef: TextRef;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
}) {
  const { messagesNow, textRef, setNotice, setCurrentAlarms } = input;
  // Alarms whose latest refill reported an issue or skipped them.
  const [refillFailedAlarmIds, setRefillFailedAlarmIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // What the latest comparison with the OS queue found, per alarm.
  const [queueStatuses, setQueueStatuses] = useState<
    Record<string, AlarmQueueStatus>
  >({});
  const reportedQueueProblemsRef = useRef<ReadonlySet<string>>(new Set());
  const reportedScheduleProblemsRef = useRef<ReadonlySet<string>>(new Set());
  // One coordinator per mounted app: it owns the refill single flight.
  const [refillCoordinator] = useState(createAlarmRefillCoordinator);

  const recordRefill = useCallback((attempt: RefillAttempt) => {
    setRefillFailedAlarmIds((previous) =>
      recordRefillAttempt(previous, attempt),
    );
  }, []);

  const refillEnabledSchedules = useCallback(
    (
      trigger: ScheduleRefillTrigger,
      knownAlarms: readonly StoredAlarmDefinition[],
    ): Promise<StoredAlarmDefinition[] | null> =>
      refillCoordinator.refill(
        trigger,
        knownAlarms,
        messagesNow(),
        (result) => {
          recordRefill(result.attempt);
          // Each row keeps showing how far its alarm is reserved, so a problem
          // is announced once instead of on every return to the app.
          const reconciled = reconcileReportedScheduleProblems(
            reportedScheduleProblemsRef.current,
            result.problemKeys,
          );
          reportedScheduleProblemsRef.current = reconciled.reported;
          if (reconciled.hasNew && result.notice) {
            // The refill may finish after a locale change; rebuild against
            // the text current now.
            setNotice(
              relocalizeNotice(result.notice, textRef.current) ?? result.notice,
            );
          }
        },
      ),
    [recordRefill],
  );

  const reconcileWithQueue = useCallback(
    async (
      knownAlarms: StoredAlarmDefinition[],
      options: { cancellationPending?: boolean } = {},
    ): Promise<ReconciledState> => {
      const result = await reconcileScheduleWithQueue(knownAlarms);
      const state = assessReconciledState(result, knownAlarms, options);
      if (!result || isObsoleteReconcileResult(result)) {
        return state;
      }
      setQueueStatuses(result.statuses);
      const summary = summarizeReconciliation(
        {
          ...result,
          unrecoveredNotificationIds: result.unrecoveredNotificationIds,
        },
        messagesNow(),
      );
      const reconciled = reconcileReportedScheduleProblems(
        reportedQueueProblemsRef.current,
        summary.problemKeys,
      );
      reportedQueueProblemsRef.current = reconciled.reported;
      const isRepairNotice = summary.problemKeys.length === 0;
      if (summary.notice && (isRepairNotice || reconciled.hasNew)) {
        setNotice(summary.notice);
      }
      return state;
    },
    [],
  );

  const clearQueueStatus = useCallback((alarmId: string) => {
    setQueueStatuses((previous) => withoutQueueStatus(previous, alarmId));
  }, []);

  const refreshAfterCycleCompletion = useCallback(
    async (
      completedCycle: StoredAlarm,
      collectedIssues?: AlarmScheduleIssue[],
    ): Promise<'none' | 'warning' | 'danger'> => {
      const now = Date.now();
      const issues: AlarmScheduleIssue[] = [];
      const attemptedAlarmIds = [completedCycle.alarmId];
      const next = await withScheduledNotificationRollback(
        (track) =>
          mutateAlarmDefinitions(async (current) => {
            const updated: StoredAlarmDefinition[] = [];

            for (const definition of current) {
              if (definition.id !== completedCycle.alarmId) {
                updated.push(definition);
                continue;
              }

              const base =
                definition.repeat.kind === 'today'
                  ? { ...definition, enabled: false }
                  : definition;
              if (!base.enabled) {
                updated.push(base);
                continue;
              }

              const filled = await fillAlarmDefinitionSchedule(
                base,
                now,
                schedulingGateway,
                undefined,
                undefined,
                await loadPlanningZone(AsyncStorage),
              );
              track(filled.scheduledCycles);
              updated.push(filled.definition);
              issues.push(...filled.issues);
            }

            return updated;
          }),
        cancellationGateway,

        orphanStore,
        schedulingGateway,
      ).catch((error: unknown) => {
        // Nothing new was reserved, so the row must not promise a refill.
        recordRefill({
          attemptedAlarmIds,
          issues: [],
          skippedAlarmIds: attemptedAlarmIds,
        });
        throw error;
      });
      recordRefill({ attemptedAlarmIds, issues });
      setCurrentAlarms(next);
      const severity = getAlarmScheduleIssueSeverity(issues);
      if (collectedIssues) {
        // The caller shows one notice for all refills together.
        collectedIssues.push(...issues);
      } else {
        const issueNotice = describeScheduleIssuesLocalized(
          issues,
          (t) => t.messages.scheduleIssue.nextLead,
          textRef.current,
        );
        if (issueNotice) {
          setNotice(issueNotice);
        }
      }
      return severity === 'none' ? 'none' : severity === 'danger' ? 'danger' : 'warning';
    },
    [recordRefill, setCurrentAlarms],
  );

  // Re-arms snoozes the system lost and clears attempts a restart interrupted.
  // Runs before overdue cycles are classified so a due snooze is judged on its
  // own time. It never adds a snooze or touches the original due time.
  const recoverSnoozes = useCallback(async () => {
    if (Platform.OS === 'web') {
      return;
    }
    try {
      const outcome = await snoozeService.recover();
      const recoveryCode = getSnoozeCopy.recoveryCode(outcome);
      if (recoveryCode) {
        setNotice(noticeFromCodeIn(messagesNow(), recoveryCode));
      }
    } catch {
      // Overdue handling below still rings or marks the snooze as missed.
      setNotice(noticeFromCodeIn(messagesNow(), 'SNOOZE_RECOVERY_FAILED'));
    }
  }, []);

  /** Warnings remembered for deleted alarms must not mute new ones. */
  const forgetDeletedAlarms = useCallback(() => {
    reportedScheduleProblemsRef.current = new Set();
    reportedQueueProblemsRef.current = new Set();
    setQueueStatuses({});
    setRefillFailedAlarmIds(new Set());
  }, []);

  return {
    refillFailedAlarmIds,
    queueStatuses,
    recordRefill,
    refillEnabledSchedules,
    reconcileWithQueue,
    clearQueueStatus,
    refreshAfterCycleCompletion,
    recoverSnoozes,
    forgetDeletedAlarms,
  };
}
