import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { AlarmEditError, resolveEditedRepeat } from '../alarmEdit';
import { prepareAlarmEnable } from '../alarmDefinitionMutations';
import {
  type AlarmScheduleIssue,
  describeAlarmAdded,
  describeScheduleIssuesLocalized,
  fillAlarmDefinitionSchedule,
  getAlarmScheduleIssueSeverity,
} from '../alarmScheduling';
import { withScheduledNotificationRollback } from '../alarmScheduleRollback';
import {
  MAX_ALARM_COUNT,
  formatRepeatLabel,
  getNextAlarmTime,
  makeAlarmRepeat,
} from '../alarmSchedule';
import {
  type StoredAlarmDefinition,
  loadAlarmDefinitions,
  mutateAlarmDefinitions,
} from '../alarmStorage';
import { MIN_ARM_LEAD_MS } from '../alarmPolicy';
import { AppError } from '../errorCatalog';
import {
  type AlarmListLockReason,
  runUnlessAlarmListLocked,
} from '../homeStatus';
import {
  describeErrorIn,
  noticeFromCodeIn,
  type TextContext,
} from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import { prepareNotifications } from '../notificationService';
import { loadPlanningZone } from '../planningZone';
import {
  cancelAlarmDefinitionPersistently,
  cancellationFailureNotice,
  editAlarmPersistently,
  hasPendingAlarmEdit,
} from './platform/alarmServices';
import {
  cancellationGateway,
  orphanStore,
  schedulingGateway,
} from './platform/gateways';
import { makeAlarmId, nextCycleForDefinition } from './core/formatters';
import type { RefillAttempt } from '../alarmScheduling';
import type { ComposerForm } from './useComposerForm';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
} from './types';

export interface AlarmMutationsInput {
  alarmsRef: AlarmsRef;
  text: TextContext;
  textRef: { current: TextContext };
  messagesNow: MessagesNow;
  isBusy: boolean;
  setIsBusy(busy: boolean): void;
  deletionPending: boolean;
  composer: ComposerForm;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  reportResetPending(error: unknown): boolean;
  recordRefill(attempt: RefillAttempt): void;
  clearQueueStatus(alarmId: string): void;
  refreshNotificationDelivery(): Promise<void>;
}

/**
 * The user's own alarm changes: add, turn on/off, edit and delete. Every
 * action is guarded by `isBusy`, re-reads the latest list inside the storage
 * locks, and the list-lock wrappers re-check the lock when they run, not when
 * the control was rendered.
 */
export function useAlarmMutations({
  alarmsRef,
  text,
  textRef,
  messagesNow,
  isBusy,
  setIsBusy,
  deletionPending,
  composer,
  setNotice,
  setCurrentAlarms,
  reportResetPending,
  recordRefill,
  clearQueueStatus,
  refreshNotificationDelivery,
}: AlarmMutationsInput) {
  const { messages, formatter } = text;
  const {
    customWeekdays,
    repeatKind,
    selectedTime,
    setCustomWeekdays,
    setEditingAlarmId,
    setIsComposerOpen,
    setRepeatKind,
    setSelectedTime,
  } = composer;

  const addAlarm = useCallback(async () => {
    if (isBusy) {
      return;
    }

    setIsBusy(true);
    setNotice(null);
    try {
      const createdAtMs = Date.now();
      const repeat = makeAlarmRepeat(repeatKind, createdAtMs, customWeekdays);
      const nextAtMs = getNextAlarmTime(
        createdAtMs,
        selectedTime.getHours(),
        selectedTime.getMinutes(),
        repeat,
      );
      if (!nextAtMs || nextAtMs - createdAtMs < MIN_ARM_LEAD_MS) {
        throw new AppError(
          repeatKind === 'today' ? 'TIME_PAST_TODAY' : 'TIME_UNCOMPUTABLE',
        );
      }

      await prepareNotifications();
      const definition: StoredAlarmDefinition = {
        id: makeAlarmId(),
        hour: selectedTime.getHours(),
        minute: selectedTime.getMinutes(),
        repeat,
        enabled: true,
        createdAtMs,
        cycles: [],
      };
      const fillIssues: AlarmScheduleIssue[] = [];
      const next = await withScheduledNotificationRollback(
        (track) =>
          mutateAlarmDefinitions(async (current) => {
            if (current.length >= MAX_ALARM_COUNT) {
              throw new AppError('ALARM_LIMIT_REACHED');
            }

            const filled = await fillAlarmDefinitionSchedule(
              definition,
              createdAtMs,
              schedulingGateway,
            );
            track(filled.scheduledCycles);
            fillIssues.push(...filled.issues);
            if (
              getAlarmScheduleIssueSeverity(filled.issues) === 'danger' &&
              filled.scheduledCycles.length === 0
            ) {
              throw new AppError(
                filled.issues.find(
                  (issue) => issue.kind === 'main_schedule_failed',
                )?.code ?? 'MAIN_REGISTER_FAILED',
              );
            }
            return [...current, filled.definition];
          }),
        cancellationGateway,

        orphanStore,
        schedulingGateway,
      );
      recordRefill({ attemptedAlarmIds: [definition.id], issues: fillIssues });
      clearQueueStatus(definition.id);
      setCurrentAlarms(next);
      setIsComposerOpen(false);
      // The language may have changed while the composer was open or the
      // schedule was being written; the notice uses the one current now.
      setNotice(
        describeAlarmAdded(
          {
            issues: fillIssues,
            hour: definition.hour,
            minute: definition.minute,
            nextAtMs,
          },
          textRef.current,
        ),
      );
    } catch (error) {
      if (reportResetPending(error)) {
        return;
      }
      setNotice(describeErrorIn(messagesNow(), error));
    } finally {
      setIsBusy(false);
      // The permission prompt or a failure may have changed what can ring.
      void refreshNotificationDelivery();
    }
  }, [
    clearQueueStatus,
    customWeekdays,
    isBusy,
    recordRefill,
    refreshNotificationDelivery,
    reportResetPending,
    repeatKind,
    selectedTime,
    setCurrentAlarms,
  ]);

  const performToggleAlarm = useCallback(
    async (definition: StoredAlarmDefinition, enabled: boolean) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      setNotice(null);
      try {
        if (await hasPendingAlarmEdit(definition.id)) {
          setNotice(noticeFromCodeIn(messagesNow(), 'EDIT_UNSETTLED'));
          return;
        }
        if (!enabled) {
          const next = await cancelAlarmDefinitionPersistently(
            definition.id,
            'disable',
          );
          setCurrentAlarms(next);
          return;
        }

        await prepareNotifications();
        const fillIssues: AlarmScheduleIssue[] = [];
        const next = await withScheduledNotificationRollback(
          (track) =>
            mutateAlarmDefinitions(async (current) => {
              const latest = current.find(
                (alarm) => alarm.id === definition.id,
              );
              if (!latest) {
                throw new AppError('ALARM_NOT_FOUND');
              }

              const now = Date.now();
              const prepared = prepareAlarmEnable(latest, now);
              if (!prepared.ok) {
                throw new AppError(prepared.code);
              }
              const enabledDefinition = prepared.definition;
              const filled = await fillAlarmDefinitionSchedule(
                enabledDefinition,
                now,
                schedulingGateway,
                undefined,
                undefined,
                await loadPlanningZone(AsyncStorage),
              );
              track(filled.scheduledCycles);
              fillIssues.push(...filled.issues);
              if (
                getAlarmScheduleIssueSeverity(filled.issues) === 'danger' &&
                filled.scheduledCycles.length === 0
              ) {
                throw new AppError(
                  filled.issues.find(
                    (issue) => issue.kind === 'main_schedule_failed',
                  )?.code ?? 'MAIN_REGISTER_FAILED',
                );
              }
              return current.map((alarm) =>
                alarm.id === definition.id ? filled.definition : alarm,
              );
            }),
          cancellationGateway,

          orphanStore,
        schedulingGateway,
        );
        recordRefill({
          attemptedAlarmIds: [definition.id],
          issues: fillIssues,
        });
        clearQueueStatus(definition.id);
        setCurrentAlarms(next);
        const issueNotice = describeScheduleIssuesLocalized(
          fillIssues,
          (t) => t.messages.scheduleIssue.enabledLead,
          textRef.current,
        );
        if (issueNotice) {
          setNotice(issueNotice);
        }
      } catch (error) {
        if (reportResetPending(error)) {
          return;
        }
        try {
          setCurrentAlarms(await loadAlarmDefinitions());
        } catch {
          // Keep the last in-memory snapshot if storage cannot be read either.
        }
        setNotice(
          enabled
            ? describeErrorIn(messagesNow(), error)
            : await cancellationFailureNotice(
                messagesNow(),
                definition.id,
                error,
                'DISABLE_CANCEL_INCOMPLETE',
              ),
        );
      } finally {
        setIsBusy(false);
        // The permission prompt or a failure may have changed what can ring.
        void refreshNotificationDelivery();
      }
    },
    [
      clearQueueStatus,
      isBusy,
      recordRefill,
      refreshNotificationDelivery,
      reportResetPending,
      setCurrentAlarms,
    ],
  );

  const performDeleteAlarm = useCallback(
    async (definition: StoredAlarmDefinition) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      try {
        if (await hasPendingAlarmEdit(definition.id)) {
          setNotice(noticeFromCodeIn(messagesNow(), 'EDIT_UNSETTLED'));
          return;
        }
        const next = await cancelAlarmDefinitionPersistently(
          definition.id,
          'delete',
        );
        setCurrentAlarms(next);
        setNotice({ tone: 'neutral', text: messagesNow().alarmList.deleted });
      } catch (error) {
        if (reportResetPending(error)) {
          return;
        }
        try {
          setCurrentAlarms(await loadAlarmDefinitions());
        } catch {
          // Keep the last in-memory snapshot if storage cannot be read either.
        }
        setNotice(
          await cancellationFailureNotice(
                messagesNow(),
            definition.id,
            error,
            'DELETE_CANCEL_INCOMPLETE',
          ),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, reportResetPending, setCurrentAlarms],
  );

  const performEditAlarm = useCallback(
    async (alarmId: string) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      setNotice(null);
      try {
        const target = alarmsRef.current.find((alarm) => alarm.id === alarmId);
        if (!target) {
          throw new AppError('ALARM_NOT_FOUND');
        }
        const hour = selectedTime.getHours();
        const minute = selectedTime.getMinutes();
        if (target.enabled) {
          // The permission prompt can take any amount of time: read the clock
          // only after it, and let the edit read its own fresh clock later.
          await prepareNotifications();
        }
        const editedAtMs = Date.now();
        const repeat = resolveEditedRepeat(
          target.repeat,
          repeatKind,
          customWeekdays,
          editedAtMs,
        );
        const result = await editAlarmPersistently({
          alarmId,
          hour,
          minute,
          repeat,
        });
        recordRefill({ attemptedAlarmIds: [alarmId], issues: result.issues });
        setCurrentAlarms(result.alarms);
        // Every notification id was replaced: the old verification is void.
        clearQueueStatus(alarmId);
        setIsComposerOpen(false);
        setEditingAlarmId(null);

        const edited = result.alarms.find((alarm) => alarm.id === alarmId);
        const nextDueAtMs = edited
          ? nextCycleForDefinition(edited, editedAtMs)?.dueAtMs
          : undefined;
        const { messages: m, formatter: f } = textRef.current;
        const clockLabel = f.clock(hour, minute);
        const severity = getAlarmScheduleIssueSeverity(result.issues);
        if (result.cleanupPending) {
          setNotice(noticeFromCodeIn(messagesNow(), 'EDIT_CLEANUP_PENDING'));
        } else if (severity !== 'none') {
          setNotice(
            describeScheduleIssuesLocalized(
              result.issues,
              (t) => t.messages.scheduleIssue.changedLead(t.formatter.clock(hour, minute)),
              textRef.current,
            ) ?? noticeFromCodeIn(m, 'CHECKIN_PARTIAL'),
          );
        } else {
          setNotice({
            tone: 'success',
            text: !target.enabled
              ? m.edit.savedOff(clockLabel)
              : nextDueAtMs !== undefined
                ? m.edit.savedNext(clockLabel, f.day(nextDueAtMs))
                : m.edit.saved(clockLabel),
          });
        }
      } catch (error) {
        if (reportResetPending(error)) {
          return;
        }
        try {
          setCurrentAlarms(await loadAlarmDefinitions());
        } catch {
          // Keep the last in-memory snapshot if storage cannot be read either.
        }
        if (error instanceof AlarmEditError && !error.rolledBack) {
          // The edit is half done and journaled; the form has nothing to fix.
          clearQueueStatus(alarmId);
          setIsComposerOpen(false);
          setEditingAlarmId(null);
        }
        setNotice(describeErrorIn(messagesNow(), error));
      } finally {
        setIsBusy(false);
        void refreshNotificationDelivery();
      }
    },
    [
      customWeekdays,
      isBusy,
      recordRefill,
      refreshNotificationDelivery,
      reportResetPending,
      repeatKind,
      selectedTime,
      setCurrentAlarms,
    ],
  );

  const notifyListLocked = useCallback((reason?: AlarmListLockReason) => {
    setNotice(
      localizedNotice(
        ({ messages: { ringing } }) => ({
          tone: 'warning',
          text:
            reason === 'snoozed'
              ? ringing.snoozedLockedNotice(ringing.stopLabel)
              : ringing.lockedNotice(ringing.stopLabel),
        }),
        textRef.current,
      ),
    );
  }, []);

  // Both read the latest alarms and clock when they run: a confirm dialog or
  // switch can outlive the render that enabled it.
  const toggleAlarm = useCallback(
    (definition: StoredAlarmDefinition, enabled: boolean) =>
      runUnlessAlarmListLocked({
        getAlarms: () => alarmsRef.current,
        nowMs: Date.now,
        onBlocked: notifyListLocked,
        run: () => performToggleAlarm(definition, enabled),
      }),
    [notifyListLocked, performToggleAlarm],
  );

  const deleteAlarm = useCallback(
    (definition: StoredAlarmDefinition) =>
      runUnlessAlarmListLocked({
        getAlarms: () => alarmsRef.current,
        nowMs: Date.now,
        onBlocked: notifyListLocked,
        run: () => performDeleteAlarm(definition),
      }),
    [notifyListLocked, performDeleteAlarm],
  );

  const openEditComposer = useCallback(
    (definition: StoredAlarmDefinition) =>
      runUnlessAlarmListLocked({
        getAlarms: () => alarmsRef.current,
        nowMs: Date.now,
        onBlocked: notifyListLocked,
        run: async () => {
          if (deletionPending) {
            return;
          }
          const time = new Date();
          time.setHours(definition.hour, definition.minute, 0, 0);
          setSelectedTime(time);
          setRepeatKind(definition.repeat.kind);
          if (definition.repeat.kind === 'custom') {
            setCustomWeekdays([...definition.repeat.weekdays]);
          }
          setEditingAlarmId(definition.id);
          setNotice(null);
          setIsComposerOpen(true);
        },
      }),
    [notifyListLocked],
  );

  const editAlarm = useCallback(
    (alarmId: string) =>
      runUnlessAlarmListLocked({
        getAlarms: () => alarmsRef.current,
        nowMs: Date.now,
        onBlocked: notifyListLocked,
        run: () => performEditAlarm(alarmId),
      }),
    [notifyListLocked, performEditAlarm],
  );

  const confirmDeleteAlarm = useCallback(
    (definition: StoredAlarmDefinition) => {
      Alert.alert(
        messages.alarmList.deleteTitle,
        messages.alarmList.deleteBody(
          formatter.clock(definition.hour, definition.minute),
          formatRepeatLabel(definition.repeat, messages, formatter),
        ),
        [
          { text: messages.common.cancel, style: 'cancel' },
          {
            text: messages.common.delete,
            style: 'destructive',
            onPress: () => void deleteAlarm(definition),
          },
        ],
      );
    },
    [deleteAlarm, formatter, messages],
  );

  return {
    addAlarm,
    toggleAlarm,
    openEditComposer,
    editAlarm,
    confirmDeleteAlarm,
  };
}
