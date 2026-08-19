import DateTimePicker from '@react-native-community/datetimepicker';
import * as Notifications from 'expo-notifications';
import { Pedometer } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import {
  getNextMonitoringCycle,
  getRingingCycle,
  fillAlarmDefinitionSchedule,
} from './src/alarmScheduling';
import {
  MAX_ALARM_COUNT,
  formatRepeatLabel,
  getNextAlarmTime,
  makeAlarmRepeat,
  type RepeatKind,
  type Weekday,
} from './src/alarmSchedule';
import {
  processAwakeResponseFailSafe,
  processStepThresholdFailSafe,
} from './src/alarmOrchestrator';
import {
  MIN_ARM_LEAD_MS,
  STEP_THRESHOLD,
  classifyStepEvidence,
} from './src/alarmPolicy';
import {
  startForegroundAlarmSound,
  stopForegroundAlarmSound,
} from './src/alarmSound';
import {
  type StoredAlarm,
  type StoredAlarmDefinition,
  loadStoredAlarmByCycleId,
  markDueCyclesRinging,
  mutateAlarmDefinitions,
  saveStoredAlarm,
} from './src/alarmStorage';
import {
  cancelNotificationIfPresent,
  cancelScheduledNotification,
  dismissDeliveredNotification,
  installForegroundNotificationHandler,
  prepareNotifications,
  readAlarmNotificationData,
  scheduleCheckInNotification,
  scheduleMainAlarmNotification,
} from './src/notificationService';
import {
  CONFIRM_AWAKE_ACTION,
  MAIN_ALARM_KIND,
} from './src/alarmContracts';

installForegroundNotificationHandler();

type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger';

interface Notice {
  tone: NoticeTone;
  text: string;
}

const REPEAT_OPTIONS: Array<{ kind: RepeatKind; label: string }> = [
  { kind: 'today', label: '今日だけ' },
  { kind: 'daily', label: '毎日' },
  { kind: 'weekdays', label: '平日' },
  { kind: 'custom', label: '曜日指定' },
];

const WEEKDAY_OPTIONS: Array<{ value: Weekday; label: string }> = [
  { value: 1, label: '月' },
  { value: 2, label: '火' },
  { value: 3, label: '水' },
  { value: 4, label: '木' },
  { value: 5, label: '金' },
  { value: 6, label: '土' },
  { value: 0, label: '日' },
];

const schedulingGateway = {
  scheduleMain: scheduleMainAlarmNotification,
  scheduleCheckIn: scheduleCheckInNotification,
};

function makeAlarmId(): string {
  return `alarm-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function defaultWakeTime(): Date {
  const wakeTime = new Date();
  wakeTime.setHours(7, 0, 0, 0);
  return wakeTime;
}

function formatAlarmTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, '0')}:${minute
    .toString()
    .padStart(2, '0')}`;
}

function formatNextDate(timestampMs: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(timestampMs));
}

function formatCountdown(milliseconds: number): string {
  if (milliseconds <= 0) {
    return 'まもなく鳴ります';
  }

  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}日${hours}時間後`;
  }
  if (hours > 0) {
    return `${hours}時間${minutes > 0 ? `${minutes}分` : ''}後`;
  }
  return `${minutes}分後`;
}

function isMonitoring(cycle: StoredAlarm): boolean {
  return cycle.phase === 'armed' || cycle.phase === 'step_candidate';
}

function nextCycleForDefinition(
  definition: StoredAlarmDefinition,
  nowMs: number,
): StoredAlarm | null {
  return (
    definition.cycles
      .filter((cycle) => isMonitoring(cycle) && cycle.dueAtMs > nowMs)
      .sort((left, right) => left.dueAtMs - right.dueAtMs)[0] ?? null
  );
}

async function fillEnabledSchedules(
  alarms: StoredAlarmDefinition[],
  nowMs: number,
): Promise<{ alarms: StoredAlarmDefinition[]; warnings: string[] }> {
  const next: StoredAlarmDefinition[] = [];
  const warnings: string[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled) {
      next.push(alarm);
      continue;
    }

    try {
      const filled = await fillAlarmDefinitionSchedule(
        alarm,
        nowMs,
        schedulingGateway,
      );
      next.push(filled.definition);
      warnings.push(...filled.warnings);
    } catch (error) {
      next.push(alarm);
      warnings.push(
        error instanceof Error
          ? `${formatAlarmTime(alarm.hour, alarm.minute)}: ${error.message}`
          : `${formatAlarmTime(alarm.hour, alarm.minute)}の通知を予約できませんでした。`,
      );
    }
  }

  return { alarms: next, warnings };
}

async function cancelDefinitionNotifications(
  definition: StoredAlarmDefinition,
): Promise<void> {
  for (const cycle of definition.cycles) {
    await cancelNotificationIfPresent(cycle.checkInNotificationId);
    await cancelNotificationIfPresent(cycle.mainAlarmId);
    await dismissDeliveredNotification(cycle.checkInNotificationId);
    await dismissDeliveredNotification(cycle.mainAlarmId);
  }
}

export default function App() {
  const [alarms, setAlarms] = useState<StoredAlarmDefinition[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [selectedTime, setSelectedTime] = useState(defaultWakeTime);
  const [repeatKind, setRepeatKind] = useState<RepeatKind>('weekdays');
  const [customWeekdays, setCustomWeekdays] = useState<Weekday[]>([1, 2, 3, 4, 5]);
  const [nowMs, setNowMs] = useState(Date.now());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pedometerStatus, setPedometerStatus] = useState(
    Platform.OS === 'web' ? '実機のみ対応' : '次のアラームを待機中',
  );

  const alarmsRef = useRef<StoredAlarmDefinition[]>([]);
  const responseInFlightRef = useRef<string | null>(null);
  const stepSuppressionInFlightRef = useRef(false);
  const dueTransitionInFlightRef = useRef(false);
  const stepOffsetRef = useRef(0);

  const setCurrentAlarms = useCallback((next: StoredAlarmDefinition[]) => {
    alarmsRef.current = next;
    setAlarms(next);
  }, []);

  const refreshAfterCycleCompletion = useCallback(
    async (completedCycle: StoredAlarm): Promise<void> => {
      const now = Date.now();
      const warnings: string[] = [];
      const next = await mutateAlarmDefinitions(async (current) => {
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
          );
          updated.push(filled.definition);
          warnings.push(...filled.warnings);
        }

        return updated;
      });
      setCurrentAlarms(next);
      if (warnings.length > 0) {
        setNotice({
          tone: 'warning',
          text: '次回分の一部を予約できませんでした。アプリを開いて状態を確認してください。',
        });
      }
    },
    [setCurrentAlarms],
  );

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        let restored = await markDueCyclesRinging(Date.now());

        if (
          Platform.OS !== 'web' &&
          restored.some((definition) => definition.enabled)
        ) {
          try {
            await prepareNotifications();
            const fillWarnings: string[] = [];
            restored = await mutateAlarmDefinitions(async (current) => {
              const filled = await fillEnabledSchedules(current, Date.now());
              fillWarnings.push(...filled.warnings);
              return filled.alarms;
            });
            if (fillWarnings.length > 0 && mounted) {
              setNotice({
                tone: 'warning',
                text: '一部の通知を再予約できませんでした。各アラームの状態を確認してください。',
              });
            }
          } catch (error) {
            if (mounted) {
              setNotice({
                tone: 'warning',
                text:
                  error instanceof Error
                    ? error.message
                    : '通知状態を更新できませんでした。',
              });
            }
          }
        }

        if (mounted) {
          setCurrentAlarms(restored);
          setIsComposerOpen(restored.length === 0);
        }
      } catch {
        if (mounted) {
          setNotice({
            tone: 'danger',
            text: '保存済みのアラームを読み取れませんでした。予約済み通知は解除していません。',
          });
        }
      } finally {
        if (mounted) {
          setIsLoaded(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [setCurrentAlarms]);

  const ringingCycle = useMemo(() => getRingingCycle(alarms), [alarms]);
  const monitoringCycle = useMemo(
    () => (ringingCycle ? null : getNextMonitoringCycle(alarms, nowMs)),
    [alarms, nowMs, ringingCycle],
  );

  useEffect(() => {
    if (!ringingCycle) {
      stopForegroundAlarmSound();
      return;
    }

    void startForegroundAlarmSound().catch(() => {
      setNotice({
        tone: 'danger',
        text: '端末内のアラーム音を開始できませんでした。通知音と画面で確認してください。',
      });
    });
    return stopForegroundAlarmSound;
  }, [ringingCycle?.cycleId]);

  const handleAwakeResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== CONFIRM_AWAKE_ACTION) {
        return;
      }

      const data = readAlarmNotificationData(response);
      const responseKey = `${data?.cycleId ?? 'invalid'}:${
        response.notification.request.identifier
      }`;
      if (responseInFlightRef.current === responseKey) {
        return;
      }
      responseInFlightRef.current = responseKey;

      try {
        const cycleId = data?.cycleId;
        const result = await processAwakeResponseFailSafe(
          {
            loadAlarm: () =>
              typeof cycleId === 'string'
                ? loadStoredAlarmByCycleId(cycleId)
                : Promise.resolve(null),
            saveAlarm: async (cycle) => {
              await saveStoredAlarm(cycle);
            },
            cancelScheduled: cancelScheduledNotification,
          },
          {
            actionIdentifier: response.actionIdentifier,
            kind: data?.kind,
            cycleId: data?.cycleId,
            mainAlarmId: data?.mainAlarmId,
            checkInNotificationId:
              response.notification.request.identifier,
            confirmedAtMs: Date.now(),
          },
        );

        if (result.status === 'ignored') {
          return;
        }
        if (result.status === 'alarm_remains') {
          setNotice({
            tone: result.reason === 'CANCEL_NOT_VERIFIED' ? 'danger' : 'warning',
            text:
              result.reason === 'CANCEL_NOT_VERIFIED'
                ? 'アラーム停止を確認できませんでした。鳴る前提で扱ってください。'
                : 'この確認は現在のアラーム周期と一致しないため、アラームを維持します。',
          });
          return;
        }

        await cancelNotificationIfPresent(result.alarm.checkInNotificationId);
        await refreshAfterCycleCompletion(result.alarm);
        setNotice({
          tone: 'success',
          text: '起床を確認しました。この時刻のアラームだけ停止しました。',
        });
      } catch {
        setNotice({
          tone: 'danger',
          text: '起床確認の処理に失敗しました。安全のためアラームは維持します。',
        });
      } finally {
        responseInFlightRef.current = null;
      }
    },
    [refreshAfterCycleCompletion],
  );

  useEffect(() => {
    if (Platform.OS === 'web' || !isLoaded) {
      return;
    }

    const responseSubscription =
      Notifications.addNotificationResponseReceivedListener((response) => {
        void handleAwakeResponse(response);
      });
    const receivedSubscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        const data = notification.request.content.data;
        if (
          data?.kind !== MAIN_ALARM_KIND ||
          typeof data.cycleId !== 'string'
        ) {
          return;
        }

        void loadStoredAlarmByCycleId(data.cycleId)
          .then(async (cycle) => {
            if (!cycle || !isMonitoring(cycle)) {
              return;
            }
            const updated = { ...cycle, phase: 'ringing' as const };
            const next = await saveStoredAlarm(updated);
            setCurrentAlarms(next);
          })
          .catch(() => {
            setNotice({
              tone: 'danger',
              text: '鳴動中のアラーム状態を保存できませんでした。',
            });
          });
      },
    );

    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      void handleAwakeResponse(lastResponse).finally(() => {
        Notifications.clearLastNotificationResponse();
      });
    }

    return () => {
      responseSubscription.remove();
      receivedSubscription.remove();
    };
  }, [handleAwakeResponse, isLoaded, setCurrentAlarms]);

  useEffect(() => {
    const interval = setInterval(() => {
      const tick = Date.now();
      setNowMs(tick);

      const hasDueCycle = alarmsRef.current.some((definition) =>
        definition.cycles.some(
          (cycle) => isMonitoring(cycle) && cycle.dueAtMs <= tick,
        ),
      );
      if (!hasDueCycle || dueTransitionInFlightRef.current) {
        return;
      }

      dueTransitionInFlightRef.current = true;
      void markDueCyclesRinging(tick)
        .then(setCurrentAlarms)
        .catch(() => {
          setNotice({
            tone: 'danger',
            text: 'アラーム時刻になりましたが、状態更新に失敗しました。',
          });
        })
        .finally(() => {
          dueTransitionInFlightRef.current = false;
        });
    }, 1_000);

    return () => clearInterval(interval);
  }, [setCurrentAlarms]);

  useEffect(() => {
    if (Platform.OS === 'web' || !monitoringCycle) {
      return;
    }

    let disposed = false;
    let subscription: ReturnType<typeof Pedometer.watchStepCount> | undefined;
    stepOffsetRef.current = monitoringCycle.stepCount;

    void (async () => {
      try {
        const available = await Pedometer.isAvailableAsync();
        if (!available || disposed) {
          setPedometerStatus('この端末では歩数を取得できません');
          return;
        }

        const permission = await Pedometer.requestPermissionsAsync();
        if (permission.status !== 'granted' || disposed) {
          setPedometerStatus('歩数権限なし（アラームは維持）');
          return;
        }

        setPedometerStatus('100歩まで計測中（アプリ表示中のみ）');
        subscription = Pedometer.watchStepCount(({ steps }) => {
          const current = getNextMonitoringCycle(
            alarmsRef.current,
            Date.now(),
          );
          if (!current || current.cycleId !== monitoringCycle.cycleId) {
            return;
          }

          const evidence = classifyStepEvidence(
            stepOffsetRef.current + steps,
            Date.now(),
          );
          if (evidence.kind === 'ERROR') {
            setPedometerStatus('歩数データ異常（アラームは維持）');
            return;
          }

          if (evidence.kind === 'STEP_THRESHOLD_REACHED') {
            if (stepSuppressionInFlightRef.current) {
              return;
            }
            stepSuppressionInFlightRef.current = true;

            void processStepThresholdFailSafe(
              {
                loadAlarm: () => loadStoredAlarmByCycleId(current.cycleId),
                saveAlarm: async (cycle) => {
                  await saveStoredAlarm(cycle);
                },
                cancelScheduled: cancelScheduledNotification,
              },
              {
                steps: evidence.steps,
                observedAtMs: evidence.observedAtMs,
              },
            )
              .then(async (result) => {
                if (result.status === 'suppressed') {
                  await cancelNotificationIfPresent(
                    result.alarm.checkInNotificationId,
                  );
                  await refreshAfterCycleCompletion(result.alarm);
                  setPedometerStatus('100歩を検知・アラーム停止済み');
                  setNotice({
                    tone: 'success',
                    text: '100歩を検知しました。この時刻のアラームだけ停止しました。',
                  });
                  return;
                }

                const failedUpdate = { ...current, stepCount: evidence.steps };
                const next = await saveStoredAlarm(failedUpdate);
                setCurrentAlarms(next);
                setNotice({
                  tone: 'danger',
                  text: '100歩を検知しましたが、通知の停止を確認できませんでした。アラームは有効です。',
                });
              })
              .catch(() => {
                setNotice({
                  tone: 'danger',
                  text: '100歩の確認処理に失敗しました。安全のためアラームは有効です。',
                });
              })
              .finally(() => {
                stepSuppressionInFlightRef.current = false;
              });
            return;
          }

          const updated = { ...current, stepCount: evidence.steps };
          void saveStoredAlarm(updated)
            .then(setCurrentAlarms)
            .catch(() => {
              setPedometerStatus('歩数の保存に失敗（アラームは維持）');
            });
        });
      } catch {
        if (!disposed) {
          setPedometerStatus('歩数計測エラー（アラームは維持）');
        }
      }
    })();

    return () => {
      disposed = true;
      subscription?.remove();
    };
  }, [monitoringCycle?.cycleId, refreshAfterCycleCompletion, setCurrentAlarms]);

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
        throw new Error(
          repeatKind === 'today'
            ? '「今日だけ」は現在より後の時刻を選択してください。'
            : '次回のアラーム時刻を計算できません。',
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
      const fillWarnings: string[] = [];
      const next = await mutateAlarmDefinitions(async (current) => {
        if (current.length >= MAX_ALARM_COUNT) {
          throw new Error(
            `登録できるアラームは最大${MAX_ALARM_COUNT}件です。`,
          );
        }

        const filled = await fillAlarmDefinitionSchedule(
          definition,
          createdAtMs,
          schedulingGateway,
        );
        fillWarnings.push(...filled.warnings);
        return [...current, filled.definition];
      });
      setCurrentAlarms(next);
      setIsComposerOpen(false);
      setNotice({
        tone: fillWarnings.length > 0 ? 'warning' : 'success',
        text:
          fillWarnings.length > 0
            ? 'アラームは登録しましたが、一部の起床確認通知を予約できませんでした。'
            : `${formatAlarmTime(definition.hour, definition.minute)}のアラームを追加しました。`,
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        text:
          error instanceof Error
            ? error.message
            : 'アラームを追加できませんでした。',
      });
    } finally {
      setIsBusy(false);
    }
  }, [customWeekdays, isBusy, repeatKind, selectedTime, setCurrentAlarms]);

  const toggleAlarm = useCallback(
    async (definition: StoredAlarmDefinition, enabled: boolean) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      setNotice(null);
      try {
        if (!enabled) {
          const next = await mutateAlarmDefinitions(async (current) => {
            const latest = current.find(
              (alarm) => alarm.id === definition.id,
            );
            if (!latest) {
              throw new Error('対象のアラームが見つかりません。');
            }
            await cancelDefinitionNotifications(latest);
            return current.map((alarm) =>
              alarm.id === definition.id
                ? { ...alarm, enabled: false, cycles: [] }
                : alarm,
            );
          });
          setCurrentAlarms(next);
          setNotice({ tone: 'neutral', text: 'アラームをオフにしました。' });
          return;
        }

        await prepareNotifications();
        const next = await mutateAlarmDefinitions(async (current) => {
          const latest = current.find(
            (alarm) => alarm.id === definition.id,
          );
          if (!latest) {
            throw new Error('対象のアラームが見つかりません。');
          }

          const now = Date.now();
          const repeat =
            latest.repeat.kind === 'today'
              ? makeAlarmRepeat('today', now)
              : latest.repeat;
          const nextAtMs = getNextAlarmTime(
            now,
            latest.hour,
            latest.minute,
            repeat,
          );
          if (!nextAtMs || nextAtMs - now < MIN_ARM_LEAD_MS) {
            throw new Error(
              'この「今日だけ」アラームは時刻を過ぎています。削除して新しい時刻を追加してください。',
            );
          }
          const enabledDefinition = {
            ...latest,
            repeat,
            enabled: true,
            cycles: [],
          };
          const filled = await fillAlarmDefinitionSchedule(
            enabledDefinition,
            now,
            schedulingGateway,
          );
          return current.map((alarm) =>
            alarm.id === definition.id ? filled.definition : alarm,
          );
        });
        setCurrentAlarms(next);
        setNotice({ tone: 'success', text: 'アラームをオンにしました。' });
      } catch (error) {
        setNotice({
          tone: 'danger',
          text:
            error instanceof Error
              ? error.message
              : 'アラームの状態を変更できませんでした。',
        });
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, setCurrentAlarms],
  );

  const deleteAlarm = useCallback(
    async (definition: StoredAlarmDefinition) => {
      if (isBusy) {
        return;
      }

      setIsBusy(true);
      try {
        const next = await mutateAlarmDefinitions(async (current) => {
          const latest = current.find((alarm) => alarm.id === definition.id);
          if (!latest) {
            throw new Error('対象のアラームが見つかりません。');
          }
          await cancelDefinitionNotifications(latest);
          return current.filter((alarm) => alarm.id !== definition.id);
        });
        setCurrentAlarms(next);
        setNotice({ tone: 'neutral', text: 'アラームを削除しました。' });
      } catch {
        setNotice({
          tone: 'danger',
          text: '通知の解除を確認できなかったため、アラームを削除していません。',
        });
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, setCurrentAlarms],
  );

  const confirmDeleteAlarm = useCallback(
    (definition: StoredAlarmDefinition) => {
      Alert.alert(
        'アラームを削除しますか？',
        `${formatAlarmTime(definition.hour, definition.minute)}（${formatRepeatLabel(
          definition.repeat,
        )}）を削除します。`,
        [
          { text: 'キャンセル', style: 'cancel' },
          {
            text: '削除',
            style: 'destructive',
            onPress: () => void deleteAlarm(definition),
          },
        ],
      );
    },
    [deleteAlarm],
  );

  const stopRinging = useCallback(async () => {
    if (!ringingCycle || isBusy) {
      return;
    }

    setIsBusy(true);
    try {
      stopForegroundAlarmSound();
      await dismissDeliveredNotification(ringingCycle.mainAlarmId);
      await cancelNotificationIfPresent(ringingCycle.checkInNotificationId);
      const dismissed = { ...ringingCycle, phase: 'dismissed' as const };
      await saveStoredAlarm(dismissed);
      await refreshAfterCycleCompletion(dismissed);
      setNotice({ tone: 'neutral', text: 'アラームを停止しました。' });
    } catch {
      setNotice({
        tone: 'danger',
        text: '停止処理に失敗しました。端末の通知から停止してください。',
      });
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, refreshAfterCycleCompletion, ringingCycle]);

  const orderedAlarms = useMemo(
    () =>
      [...alarms].sort((left, right) => {
        const leftNext = nextCycleForDefinition(left, nowMs)?.dueAtMs;
        const rightNext = nextCycleForDefinition(right, nowMs)?.dueAtMs;
        if (leftNext !== undefined && rightNext !== undefined) {
          return leftNext - rightNext;
        }
        if (leftNext !== undefined) {
          return -1;
        }
        if (rightNext !== undefined) {
          return 1;
        }
        return left.hour * 60 + left.minute - (right.hour * 60 + right.minute);
      }),
    [alarms, nowMs],
  );

  const monitoringDefinition = monitoringCycle
    ? alarms.find((alarm) => alarm.id === monitoringCycle.alarmId)
    : undefined;
  const canAdd =
    Platform.OS !== 'web' && alarms.length < MAX_ALARM_COUNT && !isBusy;

  if (!isLoaded) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color="#4F67E8" size="large" />
        <Text style={styles.loadingText}>アラームを確認しています…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandRow}>
          <View style={styles.logoMark}>
            <Text style={styles.logoGlyph}>A</Text>
          </View>
          <Text style={styles.brandName}>AlreadyUp</Text>
        </View>

        <View style={styles.titleRow}>
          <View style={styles.titleCopy}>
            <Text style={styles.screenTitle}>アラーム</Text>
            <Text style={styles.screenSubtitle}>
              起きて100歩歩いた朝は、もう一度鳴らしません。
            </Text>
          </View>
          <Pressable
            accessibilityLabel="アラームを追加"
            accessibilityRole="button"
            disabled={!canAdd}
            onPress={() => setIsComposerOpen(true)}
            style={({ pressed }) => [
              styles.addButton,
              (!canAdd || pressed) && styles.buttonDimmed,
            ]}
          >
            <Text style={styles.addButtonText}>＋</Text>
          </Pressable>
        </View>

        {notice ? (
          <View style={[styles.notice, styles[`notice_${notice.tone}`]]}>
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}

        {ringingCycle ? (
          <View style={styles.ringingCard}>
            <Text style={styles.ringingLabel}>ALARM</Text>
            <Text style={styles.ringingTime}>
              {formatAlarmTime(
                new Date(ringingCycle.dueAtMs).getHours(),
                new Date(ringingCycle.dueAtMs).getMinutes(),
              )}
            </Text>
            <Text style={styles.ringingTitle}>起きる時間です</Text>
            <Pressable
              accessibilityRole="button"
              disabled={isBusy}
              onPress={() => void stopRinging()}
              style={({ pressed }) => [
                styles.stopButton,
                (isBusy || pressed) && styles.buttonDimmed,
              ]}
            >
              <Text style={styles.stopButtonText}>起きました・停止</Text>
            </Pressable>
          </View>
        ) : monitoringCycle && monitoringDefinition ? (
          <View style={styles.nextAlarmCard}>
            <View style={styles.nextAlarmHeader}>
              <View>
                <Text style={styles.nextAlarmLabel}>次のアラーム</Text>
                <Text style={styles.nextAlarmTime}>
                  {formatAlarmTime(
                    monitoringDefinition.hour,
                    monitoringDefinition.minute,
                  )}
                </Text>
              </View>
              <View style={styles.nextAlarmMeta}>
                <Text style={styles.nextAlarmDate}>
                  {formatNextDate(monitoringCycle.dueAtMs)}
                </Text>
                <Text style={styles.nextAlarmCountdown}>
                  {formatCountdown(monitoringCycle.dueAtMs - nowMs)}
                </Text>
              </View>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.min(
                      100,
                      (monitoringCycle.stepCount / STEP_THRESHOLD) * 100,
                    )}%`,
                  },
                ]}
              />
            </View>
            <View style={styles.progressCopy}>
              <Text style={styles.progressText}>
                {monitoringCycle.stepCount} / {STEP_THRESHOLD}歩
              </Text>
              <Text style={styles.progressStatus}>{pedometerStatus}</Text>
            </View>
          </View>
        ) : null}

        {isComposerOpen ? (
          <View style={styles.composerCard}>
            <View style={styles.composerHeader}>
              <Text style={styles.composerTitle}>アラームを追加</Text>
              {alarms.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setIsComposerOpen(false)}
                >
                  <Text style={styles.cancelText}>キャンセル</Text>
                </Pressable>
              ) : null}
            </View>

            <View style={styles.timePickerRow}>
              <View>
                <Text style={styles.fieldLabel}>時刻</Text>
                <Text style={styles.pickerTimePreview}>
                  {formatAlarmTime(
                    selectedTime.getHours(),
                    selectedTime.getMinutes(),
                  )}
                </Text>
              </View>
              <DateTimePicker
                accessibilityLabel="アラーム時刻を選択"
                display={Platform.OS === 'ios' ? 'compact' : 'default'}
                mode="time"
                onChange={(_, date) => date && setSelectedTime(date)}
                value={selectedTime}
              />
            </View>

            <Text style={styles.fieldLabel}>繰り返し</Text>
            <View style={styles.optionGrid}>
              {REPEAT_OPTIONS.map((option) => {
                const selected = repeatKind === option.kind;
                return (
                  <Pressable
                    accessibilityRole="button"
                    key={option.kind}
                    onPress={() => setRepeatKind(option.kind)}
                    style={[
                      styles.optionButton,
                      selected && styles.optionButtonSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionButtonText,
                        selected && styles.optionButtonTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {repeatKind === 'custom' ? (
              <View style={styles.weekdayRow}>
                {WEEKDAY_OPTIONS.map((option) => {
                  const selected = customWeekdays.includes(option.value);
                  return (
                    <Pressable
                      accessibilityLabel={`${option.label}曜日`}
                      accessibilityRole="button"
                      key={option.value}
                      onPress={() =>
                        setCustomWeekdays((current) =>
                          selected
                            ? current.filter((day) => day !== option.value)
                            : ([...current, option.value].sort(
                                (left, right) => left - right,
                              ) as Weekday[]),
                        )
                      }
                      style={[
                        styles.weekdayButton,
                        selected && styles.weekdayButtonSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.weekdayButtonText,
                          selected && styles.weekdayButtonTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            <View style={styles.behaviorNote}>
              <Text style={styles.behaviorNoteTitle}>起床確認</Text>
              <Text style={styles.behaviorNoteText}>
                アラーム前に100歩を検知するか、「起きています」を押した場合、その時刻だけ停止します。
              </Text>
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={!canAdd}
              onPress={() => void addAlarm()}
              style={({ pressed }) => [
                styles.primaryButton,
                (!canAdd || pressed) && styles.buttonDimmed,
              ]}
            >
              {isBusy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>追加する</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        <View style={styles.listHeader}>
          <Text style={styles.sectionTitle}>設定済み</Text>
          <Text style={styles.alarmCount}>
            {alarms.length} / {MAX_ALARM_COUNT}
          </Text>
        </View>

        {orderedAlarms.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>アラームはまだありません</Text>
            <Text style={styles.emptyText}>
              時刻と繰り返しを選んで、最初のアラームを追加してください。
            </Text>
          </View>
        ) : (
          <View style={styles.alarmList}>
            {orderedAlarms.map((definition) => {
              const nextCycle = nextCycleForDefinition(definition, nowMs);
              return (
                <View
                  key={definition.id}
                  style={[
                    styles.alarmCard,
                    !definition.enabled && styles.alarmCardDisabled,
                  ]}
                >
                  <View style={styles.alarmCardMain}>
                    <View style={styles.alarmCardCopy}>
                      <Text
                        style={[
                          styles.alarmTime,
                          !definition.enabled && styles.textDisabled,
                        ]}
                      >
                        {formatAlarmTime(definition.hour, definition.minute)}
                      </Text>
                      <Text style={styles.repeatText}>
                        {formatRepeatLabel(definition.repeat)}
                        {nextCycle
                          ? ` ・ 次回 ${formatNextDate(nextCycle.dueAtMs)}`
                          : definition.enabled
                            ? ' ・ 次回予約なし'
                            : ' ・ オフ'}
                      </Text>
                    </View>
                    <Switch
                      accessibilityLabel={`${formatAlarmTime(
                        definition.hour,
                        definition.minute,
                      )}のアラーム`}
                      disabled={isBusy || Platform.OS === 'web'}
                      onValueChange={(enabled) =>
                        void toggleAlarm(definition, enabled)
                      }
                      trackColor={{ false: '#CDD3DC', true: '#AEB9FA' }}
                      thumbColor={definition.enabled ? '#4F67E8' : '#F5F6F8'}
                      value={definition.enabled}
                    />
                  </View>
                  <View style={styles.alarmCardFooter}>
                    <Text style={styles.scheduleSummary}>
                      {definition.enabled
                        ? `${definition.cycles.filter((cycle) => isMonitoring(cycle)).length}回分を予約済み`
                        : '通知は予約されていません'}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isBusy}
                      onPress={() => confirmDeleteAlarm(definition)}
                    >
                      <Text style={styles.deleteText}>削除</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {Platform.OS === 'web' ? (
          <View style={styles.deviceNotice}>
            <Text style={styles.deviceNoticeText}>
              通知と歩数計測はiPhoneまたはAndroid実機で利用できます。
            </Text>
          </View>
        ) : null}

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>動作について</Text>
          <Text style={styles.infoText}>
            歩数のリアルタイム計測はアプリ表示中のみです。バックグラウンドでは予約した通知音を使います。消音・Focus・通知設定など、OSの状態によって音が制限される場合があります。
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F6F7FB',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#F6F7FB',
  },
  loadingText: {
    color: '#667085',
    fontSize: 14,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 52,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 24,
  },
  logoMark: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4F67E8',
  },
  logoGlyph: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
  },
  brandName: {
    color: '#182230',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  titleCopy: {
    flex: 1,
  },
  screenTitle: {
    color: '#182230',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.1,
  },
  screenSubtitle: {
    marginTop: 7,
    color: '#667085',
    fontSize: 14,
    lineHeight: 21,
  },
  addButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: '#4F67E8',
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 27,
    fontWeight: '500',
    lineHeight: 29,
  },
  buttonDimmed: {
    opacity: 0.5,
  },
  notice: {
    marginTop: 18,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderWidth: 1,
    borderRadius: 14,
  },
  notice_neutral: {
    borderColor: '#D0D5DD',
    backgroundColor: '#F2F4F7',
  },
  notice_success: {
    borderColor: '#9BD5C1',
    backgroundColor: '#ECFDF3',
  },
  notice_warning: {
    borderColor: '#F2C97D',
    backgroundColor: '#FFFAEB',
  },
  notice_danger: {
    borderColor: '#F4AAA6',
    backgroundColor: '#FEF3F2',
  },
  noticeText: {
    color: '#344054',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '600',
  },
  nextAlarmCard: {
    marginTop: 22,
    padding: 22,
    borderRadius: 24,
    backgroundColor: '#182230',
    shadowColor: '#182230',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  nextAlarmHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 18,
  },
  nextAlarmLabel: {
    color: '#AEB9FA',
    fontSize: 12,
    fontWeight: '800',
  },
  nextAlarmTime: {
    marginTop: 5,
    color: '#FFFFFF',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: -1.7,
  },
  nextAlarmMeta: {
    alignItems: 'flex-end',
    paddingBottom: 5,
  },
  nextAlarmDate: {
    color: '#E4E7EC',
    fontSize: 13,
    fontWeight: '700',
  },
  nextAlarmCountdown: {
    marginTop: 5,
    color: '#98A2B3',
    fontSize: 12,
  },
  progressTrack: {
    height: 7,
    marginTop: 20,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#344054',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#7F93FF',
  },
  progressCopy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  progressText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  progressStatus: {
    flex: 1,
    color: '#98A2B3',
    fontSize: 11,
    textAlign: 'right',
  },
  ringingCard: {
    marginTop: 22,
    padding: 24,
    borderRadius: 24,
    backgroundColor: '#B42318',
  },
  ringingLabel: {
    color: '#FECDCA',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  ringingTime: {
    marginTop: 8,
    color: '#FFFFFF',
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: -1.5,
  },
  ringingTitle: {
    marginTop: 2,
    color: '#FECDCA',
    fontSize: 16,
    fontWeight: '700',
  },
  stopButton: {
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
  },
  stopButtonText: {
    color: '#B42318',
    fontSize: 17,
    fontWeight: '900',
  },
  composerCard: {
    marginTop: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
  },
  composerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  composerTitle: {
    color: '#182230',
    fontSize: 19,
    fontWeight: '900',
  },
  cancelText: {
    color: '#667085',
    fontSize: 13,
    fontWeight: '700',
  },
  timePickerRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingBottom: 18,
    marginBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#EAECF0',
  },
  fieldLabel: {
    marginBottom: 10,
    color: '#667085',
    fontSize: 12,
    fontWeight: '800',
  },
  pickerTimePreview: {
    color: '#182230',
    fontSize: 26,
    fontWeight: '900',
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    minWidth: 82,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
  },
  optionButtonSelected: {
    borderColor: '#4F67E8',
    backgroundColor: '#EEF0FF',
  },
  optionButtonText: {
    color: '#475467',
    fontSize: 13,
    fontWeight: '700',
  },
  optionButtonTextSelected: {
    color: '#3F51C7',
  },
  weekdayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 5,
    marginTop: 14,
  },
  weekdayButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 19,
    backgroundColor: '#FFFFFF',
  },
  weekdayButtonSelected: {
    borderColor: '#4F67E8',
    backgroundColor: '#4F67E8',
  },
  weekdayButtonText: {
    color: '#475467',
    fontSize: 12,
    fontWeight: '800',
  },
  weekdayButtonTextSelected: {
    color: '#FFFFFF',
  },
  behaviorNote: {
    marginTop: 18,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#F2F4F7',
  },
  behaviorNoteTitle: {
    color: '#344054',
    fontSize: 12,
    fontWeight: '900',
  },
  behaviorNoteText: {
    marginTop: 5,
    color: '#667085',
    fontSize: 12,
    lineHeight: 18,
  },
  primaryButton: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    borderRadius: 16,
    backgroundColor: '#4F67E8',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 30,
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#344054',
    fontSize: 14,
    fontWeight: '900',
  },
  alarmCount: {
    color: '#98A2B3',
    fontSize: 12,
    fontWeight: '700',
  },
  alarmList: {
    gap: 10,
  },
  alarmCard: {
    padding: 18,
    borderWidth: 1,
    borderColor: '#EAECF0',
    borderRadius: 19,
    backgroundColor: '#FFFFFF',
  },
  alarmCardDisabled: {
    backgroundColor: '#F9FAFB',
  },
  alarmCardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  alarmCardCopy: {
    flex: 1,
  },
  alarmTime: {
    color: '#182230',
    fontSize: 31,
    fontWeight: '900',
    letterSpacing: -0.9,
  },
  textDisabled: {
    color: '#98A2B3',
  },
  repeatText: {
    marginTop: 5,
    color: '#667085',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  alarmCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F2F4F7',
  },
  scheduleSummary: {
    color: '#98A2B3',
    fontSize: 11,
  },
  deleteText: {
    color: '#B42318',
    fontSize: 12,
    fontWeight: '800',
  },
  emptyCard: {
    alignItems: 'center',
    paddingHorizontal: 26,
    paddingVertical: 32,
    borderWidth: 1,
    borderColor: '#EAECF0',
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },
  emptyTitle: {
    color: '#344054',
    fontSize: 15,
    fontWeight: '900',
  },
  emptyText: {
    maxWidth: 340,
    marginTop: 7,
    color: '#98A2B3',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  deviceNotice: {
    marginTop: 16,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#FFFAEB',
  },
  deviceNoticeText: {
    color: '#8A5A00',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  infoCard: {
    marginTop: 24,
    padding: 17,
    borderRadius: 18,
    backgroundColor: '#EAECF0',
  },
  infoTitle: {
    color: '#344054',
    fontSize: 12,
    fontWeight: '900',
  },
  infoText: {
    marginTop: 7,
    color: '#667085',
    fontSize: 12,
    lineHeight: 19,
  },
});
