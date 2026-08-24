import * as Notifications from 'expo-notifications';
import { Pedometer } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';

import { getCircadianTheme } from './src/circadianTheme';
import { AlarmComposerModal } from './src/ui/AlarmComposerModal';
import { CircadianBackground } from './src/ui/CircadianBackground';
import { GlassSurface } from './src/ui/GlassSurface';
import {
  NoticeBanner,
  type AppNotice,
} from './src/ui/NoticeBanner';
import { UI_COLORS } from './src/ui/tokens';

import {
  cancelAlarmDefinitionWithCheckpoints,
} from './src/alarmCancellation';
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
  type AlarmCancellationCompletion,
  type StoredAlarm,
  type StoredAlarmDefinition,
  loadAlarmDefinitions,
  loadPendingAlarmCancellations,
  loadStoredAlarmByCycleId,
  markDueCyclesRinging,
  mutateAlarmDefinitions,
  removePendingAlarmCancellation,
  saveMonitoringCycleStepCount,
  saveStoredAlarm,
  transactAlarmDefinitions,
  upsertPendingAlarmCancellation,
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

type Notice = AppNotice;

const schedulingGateway = {
  scheduleMain: scheduleMainAlarmNotification,
  scheduleCheckIn: scheduleCheckInNotification,
};

const cancellationGateway = {
  cancelScheduled: cancelNotificationIfPresent,
  dismissDelivered: dismissDeliveredNotification,
};

async function cancelAlarmDefinitionPersistently(
  alarmId: string,
  completion: AlarmCancellationCompletion,
): Promise<StoredAlarmDefinition[]> {
  const next = await transactAlarmDefinitions(async (current, checkpoint) => {
    const latest = current.find((alarm) => alarm.id === alarmId);
    if (!latest) {
      throw new Error('対象のアラームが見つかりません。');
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

async function recoverPendingAlarmCancellations(): Promise<void> {
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

const ALARM_SUMMARY_CARD_HEIGHT = 140;

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

interface ScreenFrameProps {
  accessibilityMinHeight: number;
  children: ReactNode;
  useAccessibilityScroll: boolean;
}

function ScreenFrame({
  accessibilityMinHeight,
  children,
  useAccessibilityScroll,
}: ScreenFrameProps) {
  if (useAccessibilityScroll) {
    return (
      <ScrollView
        bounces
        contentContainerStyle={styles.screenScrollerContent}
        showsVerticalScrollIndicator
        style={styles.screenScroller}
      >
        <View
          style={[styles.screen, { minHeight: accessibilityMinHeight }]}
        >
          {children}
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screenViewport}>
      <View style={styles.screen}>{children}</View>
    </View>
  );
}

function AlarmApp() {
  const { fontScale, height: viewportHeight } = useWindowDimensions();
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
  const localMinuteKey = Math.floor(nowMs / 60_000);
  const circadianTheme = useMemo(
    () => getCircadianTheme(new Date(nowMs)),
    [localMinuteKey],
  );

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
        let cancellationRecoveryFailed = false;
        try {
          await recoverPendingAlarmCancellations();
        } catch {
          cancellationRecoveryFailed = true;
          if (mounted) {
            setNotice({
              tone: 'danger',
              text: '前回のアラーム停止処理を完了できませんでした。端末の通知一覧を確認してください。',
            });
          }
        }
        let restored = await markDueCyclesRinging(Date.now());

        if (
          !cancellationRecoveryFailed &&
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
          setIsComposerOpen(false);
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
    if (ringingCycle) {
      setIsComposerOpen(false);
    }
  }, [ringingCycle?.cycleId]);

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

                const progress = await saveMonitoringCycleStepCount(
                  current.alarmId,
                  current.cycleId,
                  evidence.steps,
                );
                setCurrentAlarms(progress.alarms);
                if (progress.status !== 'updated') {
                  return;
                }
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

          void saveMonitoringCycleStepCount(
            current.alarmId,
            current.cycleId,
            evidence.steps,
          )
            .then(({ alarms: next }) => setCurrentAlarms(next))
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
          const next = await cancelAlarmDefinitionPersistently(
            definition.id,
            'disable',
          );
          setCurrentAlarms(next);
          return;
        }

        await prepareNotifications();
        const fillWarnings: string[] = [];
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
          fillWarnings.push(...filled.warnings);
          return current.map((alarm) =>
            alarm.id === definition.id ? filled.definition : alarm,
          );
        });
        setCurrentAlarms(next);
        if (fillWarnings.length > 0) {
          setNotice({
            tone: 'warning',
            text: 'アラームはオンにしましたが、一部の起床確認通知を予約できませんでした。',
          });
        }
      } catch (error) {
        try {
          setCurrentAlarms(await loadAlarmDefinitions());
        } catch {
          // Keep the last in-memory snapshot if storage cannot be read either.
        }
        setNotice({
          tone: 'danger',
          text:
            error instanceof Error
              ? !enabled
                ? '通知の解除を完了できませんでした。次回起動時に停止処理を再試行します。'
                : error.message
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
        const next = await cancelAlarmDefinitionPersistently(
          definition.id,
          'delete',
        );
        setCurrentAlarms(next);
        setNotice({ tone: 'neutral', text: 'アラームを削除しました。' });
      } catch {
        try {
          setCurrentAlarms(await loadAlarmDefinitions());
        } catch {
          // Keep the last in-memory snapshot if storage cannot be read either.
        }
        setNotice({
          tone: 'danger',
          text: 'アラームの削除を完了できませんでした。次回起動時に停止処理を再試行します。',
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
  const canOpenComposer =
    !ringingCycle && alarms.length < MAX_ALARM_COUNT && !isBusy;
  const canSubmitAlarm =
    Platform.OS !== 'web' &&
    canOpenComposer &&
    (repeatKind !== 'custom' || customWeekdays.length > 0);
  const composerNotice =
    isComposerOpen &&
    notice &&
    (notice.tone === 'danger' || notice.tone === 'warning')
      ? { text: notice.text, tone: notice.tone }
      : undefined;
  const useAccessibilityScreenScroll = fontScale > 1.3;
  const useCompactHeightLayout = viewportHeight < 860;
  const accessibilityScreenMinHeight = Math.max(
    viewportHeight,
    Math.round(720 * Math.min(fontScale, 2)),
  );

  const toggleCustomWeekday = (weekday: Weekday) => {
    setCustomWeekdays((current) =>
      current.includes(weekday)
        ? current.filter((day) => day !== weekday)
        : ([...current, weekday].sort(
            (left, right) => left - right,
          ) as Weekday[]),
    );
  };

  if (!isLoaded) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <StatusBar style="light" />
        <CircadianBackground theme={circadianTheme} />
        <ActivityIndicator color="#FFFFFF" size="large" />
        <Text style={styles.loadingText}>アラームを確認しています…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <CircadianBackground theme={circadianTheme} />

      <ScreenFrame
        accessibilityMinHeight={accessibilityScreenMinHeight}
        useAccessibilityScroll={useAccessibilityScreenScroll}
      >
        <View style={styles.brandRow}>
          <View style={styles.logoMark}>
            <Text style={styles.logoGlyph}>↑</Text>
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
          <GlassSurface
            fallbackColor="rgba(72, 112, 214, 0.42)"
            glassEffectStyle="clear"
            intensity={76}
            isInteractive
            reducedTransparencyColor="#3E6ED4"
            style={styles.addButtonShell}
            tintColor="#7198EAA8"
          >
            <Pressable
              accessibilityLabel="アラームを追加"
              accessibilityRole="button"
              disabled={!canOpenComposer}
              onPress={() => {
                setNotice(null);
                setIsComposerOpen(true);
              }}
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text
                style={[
                  styles.addButtonText,
                  !canOpenComposer && styles.addButtonTextDisabled,
                ]}
              >
                ＋
              </Text>
            </Pressable>
          </GlassSurface>
        </View>

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
              hitSlop={4}
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
          <GlassSurface
            fallbackColor="rgba(8, 30, 65, 0.36)"
            glassEffectStyle="regular"
            intensity={76}
            reducedTransparencyColor="#173A68"
            style={[
              styles.nextAlarmCard,
              useAccessibilityScreenScroll &&
                styles.alarmSummaryCardAccessible,
            ]}
            testID="next-alarm-summary"
            tintColor="#244F8666"
          >
            <View style={styles.nextAlarmGlow} />
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
            <View
              accessible
              accessibilityLabel="起床確認の歩数"
              accessibilityRole="progressbar"
              accessibilityValue={{
                max: STEP_THRESHOLD,
                min: 0,
                now: Math.min(monitoringCycle.stepCount, STEP_THRESHOLD),
                text: `${monitoringCycle.stepCount} / ${STEP_THRESHOLD}歩`,
              }}
              style={styles.progressTrack}
            >
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
          </GlassSurface>
        ) : (
          <GlassSurface
            fallbackColor="rgba(8, 30, 65, 0.36)"
            glassEffectStyle="regular"
            intensity={76}
            reducedTransparencyColor="#173A68"
            style={[
              styles.idleCard,
              useAccessibilityScreenScroll &&
                styles.alarmSummaryCardAccessible,
            ]}
            testID="next-alarm-summary"
            tintColor="#244F8666"
          >
            <View style={styles.idleIcon}>
              <Text style={styles.idleIconText}>☾</Text>
            </View>
            <View style={styles.idleCopy}>
              <Text style={styles.idleTitle}>次のアラームはありません</Text>
              <Text style={styles.idleText}>
                右上の＋から、最初の起床時刻を追加できます。
              </Text>
            </View>
          </GlassSurface>
        )}

        <View style={styles.listPanel}>
          <View style={styles.listHeader}>
            <View>
              <Text style={styles.sectionTitle}>アラーム一覧</Text>
              <Text style={styles.sectionHint}>次に鳴る順に表示</Text>
            </View>
            <View style={styles.alarmCountBadge}>
              <Text style={styles.alarmCount}>
                {alarms.length} / {MAX_ALARM_COUNT}
              </Text>
            </View>
          </View>

          <ScrollView
            bounces={orderedAlarms.length > 1}
            contentContainerStyle={styles.alarmScrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={orderedAlarms.length > 1}
            style={styles.alarmScroll}
            testID="alarm-list-scroll"
          >

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
                      trackColor={{ false: '#D5D9E2', true: '#A8BDF5' }}
                      thumbColor={definition.enabled ? '#2F5EDB' : '#F7F8FA'}
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
                      accessibilityLabel={`${formatAlarmTime(
                        definition.hour,
                        definition.minute,
                      )}のアラームを削除`}
                      accessibilityRole="button"
                      disabled={isBusy}
                      hitSlop={10}
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
          </ScrollView>
        </View>

        {!useCompactHeightLayout ? (
          <View style={styles.footerNote}>
            <View style={styles.footerDot} />
            <Text style={styles.footerText}>
              歩数判定はアプリ表示中のみ・通知音は端末設定に従います
            </Text>
          </View>
        ) : null}
      </ScreenFrame>

      <NoticeBanner
        notice={isComposerOpen ? null : notice}
        onDismiss={() => setNotice(null)}
      />

      <AlarmComposerModal
        canSubmit={canSubmitAlarm}
        customWeekdays={customWeekdays}
        formNotice={composerNotice}
        isBusy={isBusy}
        onClose={() => {
          setIsComposerOpen(false);
          if (notice?.tone === 'danger' || notice?.tone === 'warning') {
            setNotice(null);
          }
        }}
        onRepeatKindChange={setRepeatKind}
        onSubmit={() => void addAlarm()}
        onTimeChange={setSelectedTime}
        onToggleWeekday={toggleCustomWeekday}
        repeatKind={repeatKind}
        selectedTime={selectedTime}
        visible={isComposerOpen && !ringingCycle}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AlarmApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#07162D',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#07162D',
  },
  loadingText: {
    color: 'rgba(255, 255, 255, 0.82)',
    fontSize: 14,
  },
  screen: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 5,
  },
  screenViewport: {
    flex: 1,
    minHeight: 0,
    width: '100%',
  },
  screenScroller: {
    flex: 1,
  },
  screenScrollerContent: {
    flexGrow: 1,
    width: '100%',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  logoMark: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.34)',
    borderRadius: 12,
    backgroundColor: 'rgba(8, 31, 68, 0.42)',
  },
  logoGlyph: {
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '900',
    lineHeight: 23,
  },
  brandName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: -0.35,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  titleCopy: {
    flex: 1,
  },
  screenTitle: {
    color: '#FFFFFF',
    fontSize: 31,
    fontWeight: '900',
    letterSpacing: -1.05,
  },
  screenSubtitle: {
    marginTop: 3,
    color: 'rgba(255, 255, 255, 0.76)',
    fontSize: 12,
    lineHeight: 17,
  },
  addButtonShell: {
    width: 52,
    height: 52,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.72)',
    borderRadius: 18,
    backgroundColor: 'rgba(75, 116, 218, 0.28)',
    ...Platform.select({
      web: { boxShadow: '0 10px 22px rgba(3, 18, 47, 0.24)' },
      default: {
        shadowColor: '#03122F',
        shadowOpacity: 0.24,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 10 },
        elevation: 5,
      },
    }),
  },
  addButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 29,
    fontWeight: '500',
    lineHeight: 31,
  },
  addButtonTextDisabled: {
    color: 'rgba(255, 255, 255, 0.52)',
  },
  buttonDimmed: {
    opacity: 0.5,
  },
  buttonPressed: {
    transform: [{ scale: 0.96 }],
  },
  nextAlarmCard: {
    height: ALARM_SUMMARY_CARD_HEIGHT,
    overflow: 'hidden',
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 25,
    backgroundColor: 'rgba(8, 30, 65, 0.1)',
    ...Platform.select({
      web: { boxShadow: '0 14px 30px rgba(0, 10, 31, 0.2)' },
      default: {
        shadowColor: '#000A1F',
        shadowOpacity: 0.2,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 14 },
        elevation: 5,
      },
    }),
  },
  nextAlarmGlow: {
    position: 'absolute',
    top: -64,
    right: -30,
    width: 170,
    height: 170,
    borderRadius: 85,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    backgroundColor: 'rgba(152, 186, 246, 0.12)',
    pointerEvents: 'none',
  },
  nextAlarmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  nextAlarmLabel: {
    color: 'rgba(255, 255, 255, 0.74)',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  nextAlarmTime: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 41,
    fontWeight: '900',
    letterSpacing: -1.6,
  },
  nextAlarmMeta: {
    alignItems: 'flex-end',
  },
  nextAlarmDate: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  nextAlarmCountdown: {
    marginTop: 4,
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
  },
  progressTrack: {
    height: 6,
    marginTop: 13,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#73CFC0',
  },
  progressCopy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 7,
  },
  progressText: {
    color: '#92E1D5',
    fontSize: 10,
    fontWeight: '900',
  },
  progressStatus: {
    flex: 1,
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: 9,
    textAlign: 'right',
  },
  ringingCard: {
    minHeight: 150,
    overflow: 'hidden',
    marginTop: 12,
    padding: 19,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 25,
    backgroundColor: 'rgba(128, 28, 42, 0.92)',
  },
  ringingLabel: {
    color: '#FECDCA',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  ringingTime: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 41,
    fontWeight: '900',
    letterSpacing: -1.5,
  },
  ringingTitle: {
    position: 'absolute',
    top: 25,
    right: 19,
    color: '#FECDCA',
    fontSize: 13,
    fontWeight: '700',
  },
  stopButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  stopButtonText: {
    color: '#B42318',
    fontSize: 14,
    fontWeight: '900',
  },
  idleCard: {
    height: ALARM_SUMMARY_CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 24,
    backgroundColor: 'rgba(8, 30, 65, 0.1)',
  },
  alarmSummaryCardAccessible: {
    height: 'auto',
    minHeight: ALARM_SUMMARY_CARD_HEIGHT,
  },
  idleIcon: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  idleIconText: {
    color: '#DCE9FF',
    fontSize: 25,
  },
  idleCopy: {
    flex: 1,
  },
  idleTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  idleText: {
    marginTop: 4,
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
    lineHeight: 16,
  },
  listPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    marginTop: 10,
    marginBottom: 1,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.82)',
    borderRadius: 25,
    backgroundColor: 'rgba(247, 249, 252, 0.95)',
    ...Platform.select({
      web: { boxShadow: '0 14px 28px rgba(0, 13, 35, 0.17)' },
      default: {
        shadowColor: '#000D23',
        shadowOpacity: 0.17,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 14 },
        elevation: 5,
      },
    }),
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 13,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(67, 82, 112, 0.12)',
  },
  sectionTitle: {
    color: '#10203B',
    fontSize: 13,
    fontWeight: '900',
  },
  sectionHint: {
    marginTop: 2,
    color: UI_COLORS.textMuted,
    fontSize: 9,
  },
  alarmCountBadge: {
    minWidth: 48,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(44, 63, 96, 0.12)',
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  alarmCount: {
    color: UI_COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '900',
  },
  alarmScroll: {
    flex: 1,
    minHeight: 0,
  },
  alarmScrollContent: {
    flexGrow: 1,
    padding: 11,
    paddingBottom: 13,
  },
  alarmList: {
    gap: 9,
  },
  alarmCard: {
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(31, 49, 79, 0.06)',
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    ...Platform.select({
      web: { boxShadow: '0 8px 18px rgba(21, 42, 77, 0.08)' },
      default: {
        shadowColor: '#152A4D',
        shadowOpacity: 0.08,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 7 },
        elevation: 2,
      },
    }),
  },
  alarmCardDisabled: {
    borderColor: 'rgba(139, 149, 168, 0.12)',
    backgroundColor: '#ECEFF4',
  },
  alarmCardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  alarmCardCopy: {
    flex: 1,
  },
  alarmTime: {
    color: '#0B1A33',
    fontSize: 29,
    fontWeight: '900',
    letterSpacing: -1,
  },
  textDisabled: {
    color: '#9AA3BA',
  },
  repeatText: {
    marginTop: 3,
    color: UI_COLORS.textMuted,
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
  },
  alarmCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 9,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(49, 65, 94, 0.1)',
  },
  scheduleSummary: {
    color: UI_COLORS.textMuted,
    fontSize: 9,
  },
  deleteText: {
    color: '#AD4B55',
    fontSize: 10,
    fontWeight: '900',
  },
  emptyCard: {
    flex: 1,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    borderWidth: 1,
    borderColor: 'rgba(53, 71, 102, 0.1)',
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
  },
  emptyTitle: {
    color: '#172641',
    fontSize: 14,
    fontWeight: '900',
  },
  emptyText: {
    maxWidth: 300,
    marginTop: 6,
    color: UI_COLORS.textMuted,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
  },
  deviceNotice: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(210, 153, 58, 0.24)',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 247, 222, 0.68)',
  },
  deviceNoticeText: {
    color: '#86611E',
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
  },
  footerNote: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 7,
  },
  footerDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#91D8CC',
  },
  footerText: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 9,
    fontWeight: '600',
  },
});
