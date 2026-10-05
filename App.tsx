import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from 'expo-keep-awake';
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
  AppState,
  Linking,
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
import { BEDSIDE_FOOTER_COLORS, UI_COLORS } from './src/ui/tokens';

import {
  cancelAlarmDefinitionWithCheckpoints,
} from './src/alarmCancellation';
import {
  type AlarmScheduleIssue,
  getNextMonitoringCycle,
  getRingingCycle,
  fillAlarmDefinitionSchedule,
  getAlarmScheduleIssueKey,
  getAlarmScheduleIssueSeverity,
  reconcileReportedScheduleProblems,
} from './src/alarmScheduling';
import {
  ScheduledNotificationRollbackError,
  withScheduledNotificationRollback,
} from './src/alarmScheduleRollback';
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
  BEDSIDE_GUIDANCE,
  BEDSIDE_KEEP_AWAKE_TAG,
  isForegroundAppState,
  shouldKeepScreenAwake,
} from './src/bedsideMode';
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
  getStepCountingFloorMs,
  getStepWindow,
  getStepWindowPhase,
  getWindowStepCount,
} from './src/stepWindow';
import {
  cancelNotificationIfPresent,
  cancelScheduledNotification,
  dismissDeliveredNotification,
  installForegroundNotificationHandler,
  prepareNotifications,
  prepareNotificationsIfGranted,
  readAlarmNotificationData,
  readNotificationDelivery,
  scheduleCheckInNotification,
  scheduleMainAlarmNotification,
} from './src/notificationService';
import {
  type NotificationDeliveryState,
  getNotificationDeliveryWarningCopy,
  shouldWarnNotificationDelivery,
} from './src/notificationDelivery';
import {
  CONFIRM_AWAKE_ACTION,
  MAIN_ALARM_KIND,
} from './src/alarmContracts';
import {
  describeScheduleCoverage,
  getScheduleCoverageLine,
} from './src/scheduleCoverage';

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
// The bedside guidance follows Dynamic Type up to 2x; larger sizes already
// switch the whole screen to scrolling.
const FOOTER_MAX_FONT_SCALE = 2;

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
  excludedAlarmIds: ReadonlySet<string> = new Set(),
): Promise<{
  alarms: StoredAlarmDefinition[];
  issues: AlarmScheduleIssue[];
  scheduledCycles: StoredAlarm[];
}> {
  const next: StoredAlarmDefinition[] = [];
  const issues: AlarmScheduleIssue[] = [];
  const scheduledCycles: StoredAlarm[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled || excludedAlarmIds.has(alarm.id)) {
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
      issues.push(...filled.issues);
      scheduledCycles.push(...filled.scheduledCycles);
    } catch (error) {
      next.push(alarm);
      issues.push({
        kind: 'main_schedule_failed',
        alarmId: alarm.id,
        cycleId: 'schedule-recovery',
        dueAtMs: nowMs,
        message:
          error instanceof Error
            ? `${formatAlarmTime(alarm.hour, alarm.minute)}: ${error.message}`
            : `${formatAlarmTime(alarm.hour, alarm.minute)}の通知を予約できませんでした。`,
      });
    }
  }

  return { alarms: next, issues, scheduledCycles };
}

type ScheduleRefillTrigger = 'startup' | 'foreground';

interface ScheduleRefillResult {
  /** The saved alarms, or null when nothing was saved. */
  alarms: StoredAlarmDefinition[] | null;
  /** Identifies the problems found so the same notice is not repeated. */
  problemKeys: string[];
  notice: Notice | null;
}

/**
 * Tops every enabled alarm back up to its upcoming occurrences. Returns null
 * when a foreground refill is skipped because notifications are not allowed;
 * only startup may show the permission prompt.
 */
async function refillEnabledSchedulesOnce(
  trigger: ScheduleRefillTrigger,
): Promise<ScheduleRefillResult | null> {
  try {
    if (trigger === 'startup') {
      await prepareNotifications();
    } else if (!(await prepareNotificationsIfGranted())) {
      return null;
    }

    // A stop or disable that has not finished must not get new reservations.
    // Startup retries it before refilling.
    const pendingAlarmIds = new Set(
      (await loadPendingAlarmCancellations()).map((pending) => pending.alarmId),
    );
    const fillIssues: AlarmScheduleIssue[] = [];
    const alarms = await withScheduledNotificationRollback(
      (track) =>
        mutateAlarmDefinitions(async (current) => {
          const filled = await fillEnabledSchedules(
            current,
            Date.now(),
            pendingAlarmIds,
          );
          track(filled.scheduledCycles);
          fillIssues.push(...filled.issues);
          return filled.alarms;
        }),
      cancellationGateway,
    );
    const severity = getAlarmScheduleIssueSeverity(fillIssues);
    return {
      alarms,
      problemKeys: fillIssues.map(getAlarmScheduleIssueKey),
      notice:
        severity === 'none'
          ? null
          : {
              tone: severity,
              text:
                severity === 'danger'
                  ? '一部のメイン通知を再予約できませんでした。各アラームの状態を確認してください。'
                  : '一部の起床確認通知を再予約できませんでした。',
            },
    };
  } catch (error) {
    const text =
      error instanceof Error ? error.message : '通知状態を更新できませんでした。';
    return {
      alarms: null,
      problemKeys: [`refill_failed:${text}`],
      notice: {
        tone:
          error instanceof ScheduledNotificationRollbackError
            ? 'danger'
            : 'warning',
        text,
      },
    };
  }
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
  // null until the first check, so nothing is claimed before it completes.
  const [notificationDelivery, setNotificationDelivery] =
    useState<NotificationDeliveryState | null>(null);
  const [pedometerStatus, setPedometerStatus] = useState(
    Platform.OS === 'web' ? '実機のみ対応' : '次のアラームを待機中',
  );
  const [isAppForeground, setIsAppForeground] = useState(() =>
    isForegroundAppState(AppState.currentState),
  );

  const alarmsRef = useRef<StoredAlarmDefinition[]>([]);
  const responseInFlightRef = useRef<string | null>(null);
  const stepSuppressionInFlightRef = useRef(false);
  const dueTransitionInFlightRef = useRef(false);
  const deliveryCheckRef = useRef(0);
  const refillInFlightRef = useRef(false);
  const reportedScheduleProblemsRef = useRef<ReadonlySet<string>>(new Set());
  const localMinuteKey = Math.floor(nowMs / 60_000);
  const circadianTheme = useMemo(
    () => getCircadianTheme(new Date(nowMs)),
    [localMinuteKey],
  );

  const setCurrentAlarms = useCallback((next: StoredAlarmDefinition[]) => {
    alarmsRef.current = next;
    setAlarms(next);
  }, []);

  const refreshNotificationDelivery = useCallback(async () => {
    if (Platform.OS === 'web') {
      return;
    }

    // Only the latest check may update the state when checks overlap.
    const check = ++deliveryCheckRef.current;
    const next = await readNotificationDelivery();
    if (check === deliveryCheckRef.current) {
      setNotificationDelivery(next);
    }
  }, []);

  const refillEnabledSchedules = useCallback(
    async (
      trigger: ScheduleRefillTrigger,
    ): Promise<StoredAlarmDefinition[] | null> => {
      if (Platform.OS === 'web' || refillInFlightRef.current) {
        return null;
      }

      refillInFlightRef.current = true;
      try {
        const result = await refillEnabledSchedulesOnce(trigger);
        if (!result) {
          return null;
        }
        // Each row keeps showing how far its alarm is reserved, so a problem
        // is announced once instead of on every return to the app.
        const reconciled = reconcileReportedScheduleProblems(
          reportedScheduleProblemsRef.current,
          result.problemKeys,
        );
        reportedScheduleProblemsRef.current = reconciled.reported;
        if (reconciled.hasNew && result.notice) {
          setNotice(result.notice);
        }
        return result.alarms;
      } finally {
        refillInFlightRef.current = false;
      }
    },
    [],
  );

  const openNotificationSettings = useCallback(() => {
    void Linking.openSettings().catch(() => {
      setNotice({
        tone: 'danger',
        text: '設定を開けませんでした。設定アプリで通知をオンにしてください。',
      });
    });
  }, []);

  const refreshAfterCycleCompletion = useCallback(
    async (completedCycle: StoredAlarm): Promise<void> => {
      const now = Date.now();
      const issues: AlarmScheduleIssue[] = [];
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
              );
              track(filled.scheduledCycles);
              updated.push(filled.definition);
              issues.push(...filled.issues);
            }

            return updated;
          }),
        cancellationGateway,
      );
      setCurrentAlarms(next);
      const severity = getAlarmScheduleIssueSeverity(issues);
      if (severity !== 'none') {
        setNotice({
          tone: severity,
          text:
            severity === 'danger'
              ? '次回分のメイン通知を一部予約できませんでした。アラーム状態を確認してください。'
              : '次回分の起床確認通知を一部予約できませんでした。',
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
          restored = (await refillEnabledSchedules('startup')) ?? restored;
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
  }, [refillEnabledSchedules, setCurrentAlarms]);

  useEffect(() => {
    if (Platform.OS === 'web' || !isLoaded) {
      return;
    }

    void refreshNotificationDelivery();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }
      // Notifications can be turned off in Settings while the app is away.
      void refreshNotificationDelivery();
      // Occurrences stopped from a notification are only replaced while the
      // app runs, so returning to it tops the schedule back up.
      if (alarmsRef.current.some((alarm) => alarm.enabled)) {
        void refillEnabledSchedules('foreground').then((next) => {
          if (next) {
            setCurrentAlarms(next);
          }
        });
      }
    });
    return () => subscription.remove();
  }, [
    isLoaded,
    refillEnabledSchedules,
    refreshNotificationDelivery,
    setCurrentAlarms,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppForeground(isForegroundAppState(state));
    });
    return () => subscription.remove();
  }, []);

  // Bedside mode: the loop sound and step check only run while the app is on
  // screen, so the screen stays on while an alarm is ringing or due soon.
  const keepScreenAwake =
    Platform.OS !== 'web' &&
    isAppForeground &&
    shouldKeepScreenAwake(alarms, nowMs);

  useEffect(() => {
    if (!keepScreenAwake) {
      return;
    }

    void Promise.resolve()
      .then(() => activateKeepAwakeAsync(BEDSIDE_KEEP_AWAKE_TAG))
      .catch(() => {
        setNotice({
          tone: 'warning',
          text: '画面を点けたままにできませんでした。画面が消えるとアラームは通知音1回だけになるため、端末の自動ロックをオフにしてください。',
        });
      });
    return () => {
      void Promise.resolve()
        .then(() => deactivateKeepAwake(BEDSIDE_KEEP_AWAKE_TAG))
        .catch(() => undefined);
    };
  }, [keepScreenAwake]);

  const ringingCycle = useMemo(() => getRingingCycle(alarms), [alarms]);
  const monitoringCycle = useMemo(
    () => (ringingCycle ? null : getNextMonitoringCycle(alarms, nowMs)),
    [alarms, nowMs, ringingCycle],
  );
  const stepWindow = useMemo(
    () =>
      monitoringCycle
        ? getStepWindow(
            monitoringCycle,
            getStepCountingFloorMs(alarms, monitoringCycle),
          )
        : null,
    [alarms, monitoringCycle],
  );
  const stepWindowPhase = stepWindow
    ? getStepWindowPhase(stepWindow, nowMs)
    : null;
  const isStepWindowActive = stepWindowPhase === 'active';

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
    // Steps only count inside the hour before the alarm, so nothing is
    // subscribed or counted before the window opens.
    if (
      Platform.OS === 'web' ||
      !monitoringCycle ||
      !stepWindow ||
      !isStepWindowActive
    ) {
      return;
    }

    let disposed = false;
    let subscription: ReturnType<typeof Pedometer.watchStepCount> | undefined;
    const countedFromMs = stepWindow.startMs;

    const evaluateSteps = (steps: number) => {
      if (disposed) {
        return;
      }
      const observedAtMs = Date.now();
      const current = getNextMonitoringCycle(alarmsRef.current, observedAtMs);
      if (!current || current.cycleId !== monitoringCycle.cycleId) {
        return;
      }

      const evidence = classifyStepEvidence(
        steps,
        observedAtMs,
        countedFromMs,
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
            countedFromMs,
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
              countedFromMs,
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
        countedFromMs,
      )
        .then(({ alarms: next }) => setCurrentAlarms(next))
        .catch(() => {
          setPedometerStatus('歩数の保存に失敗（アラームは維持）');
        });
    };

    // Clears any status left over from a previous cycle.
    setPedometerStatus('歩数計を準備中');
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

        let baseSteps = getWindowStepCount(monitoringCycle, stepWindow);
        if (Platform.OS === 'ios') {
          try {
            // iOS keeps step history, so steps walked inside the window
            // before the app came on screen are included.
            const history = await Pedometer.getStepCountAsync(
              new Date(countedFromMs),
              new Date(),
            );
            if (Number.isFinite(history.steps)) {
              baseSteps = Math.max(baseSteps, history.steps);
            }
          } catch {
            // Fall back to the persisted count for this window.
          }
        }
        if (disposed) {
          return;
        }

        setPedometerStatus('100歩まで計測中（アプリ表示中のみ）');
        evaluateSteps(baseSteps);
        subscription = Pedometer.watchStepCount(({ steps }) => {
          evaluateSteps(baseSteps + steps);
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
  }, [
    monitoringCycle?.cycleId,
    stepWindow?.startMs,
    isStepWindowActive,
    refreshAfterCycleCompletion,
    setCurrentAlarms,
  ]);

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
      const fillIssues: AlarmScheduleIssue[] = [];
      const next = await withScheduledNotificationRollback(
        (track) =>
          mutateAlarmDefinitions(async (current) => {
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
            track(filled.scheduledCycles);
            fillIssues.push(...filled.issues);
            if (
              getAlarmScheduleIssueSeverity(filled.issues) === 'danger' &&
              filled.scheduledCycles.length === 0
            ) {
              throw new Error(
                filled.issues.find(
                  (issue) => issue.kind === 'main_schedule_failed',
                )?.message ?? 'メインのアラーム通知を予約できませんでした。',
              );
            }
            return [...current, filled.definition];
          }),
        cancellationGateway,
      );
      setCurrentAlarms(next);
      setIsComposerOpen(false);
      const severity = getAlarmScheduleIssueSeverity(fillIssues);
      setNotice({
        tone: severity === 'none' ? 'success' : severity,
        text:
          severity === 'danger'
            ? 'アラームは追加しましたが、メイン通知の一部を予約できていません。状態を確認してください。'
            : severity === 'warning'
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
      // The permission prompt or a failure may have changed what can ring.
      void refreshNotificationDelivery();
    }
  }, [
    customWeekdays,
    isBusy,
    refreshNotificationDelivery,
    repeatKind,
    selectedTime,
    setCurrentAlarms,
  ]);

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
        const fillIssues: AlarmScheduleIssue[] = [];
        const next = await withScheduledNotificationRollback(
          (track) =>
            mutateAlarmDefinitions(async (current) => {
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
              track(filled.scheduledCycles);
              fillIssues.push(...filled.issues);
              if (
                getAlarmScheduleIssueSeverity(filled.issues) === 'danger' &&
                filled.scheduledCycles.length === 0
              ) {
                throw new Error(
                  filled.issues.find(
                    (issue) => issue.kind === 'main_schedule_failed',
                  )?.message ?? 'メインのアラーム通知を予約できませんでした。',
                );
              }
              return current.map((alarm) =>
                alarm.id === definition.id ? filled.definition : alarm,
              );
            }),
          cancellationGateway,
        );
        setCurrentAlarms(next);
        const severity = getAlarmScheduleIssueSeverity(fillIssues);
        if (severity !== 'none') {
          setNotice({
            tone: severity,
            text:
              severity === 'danger'
                ? 'アラームはオンにしましたが、メイン通知の一部を予約できていません。状態を確認してください。'
                : 'アラームはオンにしましたが、一部の起床確認通知を予約できませんでした。',
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
        // The permission prompt or a failure may have changed what can ring.
        void refreshNotificationDelivery();
      }
    },
    [isBusy, refreshNotificationDelivery, setCurrentAlarms],
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
  const windowStepCount =
    monitoringCycle && stepWindow
      ? getWindowStepCount(monitoringCycle, stepWindow)
      : 0;
  const stepWindowStartLabel = stepWindow
    ? formatAlarmTime(
        new Date(stepWindow.startMs).getHours(),
        new Date(stepWindow.startMs).getMinutes(),
      )
    : '';
  const deliveryWarning =
    notificationDelivery &&
    notificationDelivery !== 'ok' &&
    shouldWarnNotificationDelivery(notificationDelivery, alarms)
      ? notificationDelivery
      : null;
  const deliveryWarningCopy = deliveryWarning
    ? getNotificationDeliveryWarningCopy(
        deliveryWarning,
        monitoringCycle
          ? `${formatNextDate(monitoringCycle.dueAtMs)} ${formatAlarmTime(
              new Date(monitoringCycle.dueAtMs).getHours(),
              new Date(monitoringCycle.dueAtMs).getMinutes(),
            )}`
          : null,
      )
    : null;
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
          <Text style={styles.brandName}>AlreadyUp</Text>
        </View>

        <View style={styles.titleRow}>
          <View style={styles.titleCopy}>
            <Text style={styles.screenTitle}>アラーム</Text>
            <Text style={styles.screenSubtitle}>
              目覚めた朝に、静けさを。
            </Text>
          </View>
          <GlassSurface
            blurTint="systemUltraThinMaterialDark"
            fallbackColor="rgba(20, 30, 45, 0.32)"
            glassEffectStyle="regular"
            intensity={76}
            isInteractive
            reducedTransparencyColor="#263544"
            style={styles.addButtonShell}
            tintColor="#FFFFFF18"
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
        ) : deliveryWarningCopy ? (
          <View
            style={styles.deliveryWarningCard}
            testID="notification-delivery-warning"
          >
            <View style={styles.deliveryWarningHeader}>
              <Text
                accessibilityRole="header"
                style={styles.deliveryWarningTitle}
              >
                {deliveryWarningCopy.title}
              </Text>
              <Pressable
                accessibilityHint="端末の設定で通知をオンにできます"
                accessibilityRole="button"
                hitSlop={4}
                onPress={openNotificationSettings}
                style={({ pressed }) => [
                  styles.settingsButton,
                  pressed && styles.buttonDimmed,
                ]}
              >
                <Text style={styles.settingsButtonText}>設定を開く</Text>
              </Pressable>
            </View>
            <Text style={styles.deliveryWarningBody}>
              {deliveryWarningCopy.body}
            </Text>
          </View>
        ) : monitoringCycle && monitoringDefinition ? (
          <GlassSurface
            blurTint="systemUltraThinMaterialDark"
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
            {stepWindowPhase === 'before' ? (
              <View
                accessible
                accessibilityLabel={`起床確認は${stepWindowStartLabel}から。アプリを表示している間に${STEP_THRESHOLD}歩で確認します`}
                style={[styles.progressCopy, styles.progressCopyPending]}
              >
                <Text style={styles.progressText}>
                  起床確認は {stepWindowStartLabel} から
                </Text>
                <Text style={styles.progressStatus}>
                  アプリ表示中に{STEP_THRESHOLD}歩
                </Text>
              </View>
            ) : (
              <>
                <View
                  accessible
                  accessibilityLabel="起床確認の歩数"
                  accessibilityRole="progressbar"
                  accessibilityValue={{
                    max: STEP_THRESHOLD,
                    min: 0,
                    now: Math.min(windowStepCount, STEP_THRESHOLD),
                    text: `${windowStepCount} / ${STEP_THRESHOLD}歩`,
                  }}
                  style={styles.progressTrack}
                >
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.min(
                          100,
                          (windowStepCount / STEP_THRESHOLD) * 100,
                        )}%`,
                      },
                    ]}
                  />
                </View>
                <View style={styles.progressCopy}>
                  <Text style={styles.progressText}>
                    起床確認 {windowStepCount} / {STEP_THRESHOLD}歩
                  </Text>
                  <Text style={styles.progressStatus}>{pedometerStatus}</Text>
                </View>
              </>
            )}
          </GlassSurface>
        ) : (
          <GlassSurface
            blurTint="systemUltraThinMaterialDark"
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
                {alarms.length === 0
                  ? '右上の＋から、起床時刻を追加できます。'
                  : alarms.every((alarm) => !alarm.enabled)
                    ? '一覧のスイッチをオンにすると、次のアラームを設定できます。'
                    : '次回の予約はありません。設定した時刻と繰り返しを確認してください。'}
              </Text>
            </View>
          </GlassSurface>
        )}

        <View style={styles.listPanel}>
          <View style={styles.listHeader}>
            <View>
              <Text style={styles.sectionTitle}>設定したアラーム</Text>
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
              const coverageLine = getScheduleCoverageLine(
                describeScheduleCoverage(definition, nowMs),
                formatNextDate,
              );
              const scheduleLineWarns =
                definition.enabled &&
                (deliveryWarningCopy !== null || coverageLine.isWarning);
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
                      trackColor={{ false: '#59616B', true: '#34C759' }}
                      thumbColor="#FFFFFF"
                      value={definition.enabled}
                    />
                  </View>
                  <View style={styles.alarmCardFooter}>
                    <Text
                      style={[
                        styles.scheduleSummary,
                        scheduleLineWarns && styles.scheduleSummaryWarning,
                      ]}
                    >
                      {definition.enabled && deliveryWarningCopy
                        ? deliveryWarningCopy.scheduleLine
                        : coverageLine.text}
                    </Text>
                    <Pressable
                      accessibilityLabel={`${formatAlarmTime(
                        definition.hour,
                        definition.minute,
                      )}のアラームを削除`}
                      accessibilityRole="button"
                      disabled={isBusy}
                      onPress={() => confirmDeleteAlarm(definition)}
                      style={styles.deleteButton}
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

        <View
          accessible
          accessibilityLabel={`${BEDSIDE_GUIDANCE.title}。${BEDSIDE_GUIDANCE.detail}`}
          style={styles.footerNote}
          testID="bedside-guidance"
        >
          <View style={styles.footerDot} />
          <View style={styles.footerCopy}>
            <Text
              allowFontScaling
              maxFontSizeMultiplier={FOOTER_MAX_FONT_SCALE}
              style={styles.footerTitle}
            >
              {BEDSIDE_GUIDANCE.title}
            </Text>
            <Text
              allowFontScaling
              maxFontSizeMultiplier={FOOTER_MAX_FONT_SCALE}
              style={styles.footerText}
            >
              {BEDSIDE_GUIDANCE.detail}
            </Text>
          </View>
        </View>
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
    fontSize: 13,
    fontWeight: '500',
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
    fontWeight: '600',
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
    borderWidth: 0,
    borderRadius: 26,
    backgroundColor: 'transparent',
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
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  nextAlarmTime: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 48,
    lineHeight: 50,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
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
    marginTop: 8,
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
  progressCopyPending: {
    // Keeps the copy where it sits when the progress track is shown.
    marginTop: 21,
  },
  progressText: {
    color: '#92E1D5',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
  },
  progressStatus: {
    flex: 1,
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: 9,
    lineHeight: 12,
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
  deliveryWarningCard: {
    // Grows with Dynamic Type so the warning is never clipped.
    minHeight: ALARM_SUMMARY_CARD_HEIGHT,
    overflow: 'hidden',
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 25,
    backgroundColor: 'rgba(128, 28, 42, 0.92)',
  },
  deliveryWarningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  deliveryWarningTitle: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '900',
  },
  deliveryWarningBody: {
    marginTop: 10,
    color: '#FECDCA',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  settingsButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  settingsButtonText: {
    color: '#B42318',
    fontSize: 13,
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
    borderWidth: 0,
    backgroundColor: 'rgba(6, 21, 45, 0.86)',
    borderRadius: 16,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 13,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.18)',
  },
  sectionTitle: {
    color: '#E9EDF2',
    fontSize: 13,
    fontWeight: '500',
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
    borderWidth: 0,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  alarmCount: {
    color: '#B7C1CF',
    fontSize: 10,
    fontWeight: '900',
  },
  alarmScroll: {
    flex: 1,
    minHeight: 0,
  },
  alarmScrollContent: {
    flexGrow: 1,
    padding: 0,
    paddingBottom: 13,
  },
  alarmList: {
    gap: 0,
  },
  alarmCard: {
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: 'transparent',
  },
  alarmCardDisabled: {
    backgroundColor: 'transparent',
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
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  textDisabled: {
    color: '#9AA3BA',
  },
  repeatText: {
    marginTop: 3,
    color: '#C5CDD8',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '400',
  },
  alarmCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 0,
  },
  scheduleSummary: {
    color: '#B7C1CF',
    fontSize: 11,
    flex: 1,
    paddingRight: 8,
  },
  scheduleSummaryWarning: {
    color: '#FFB4AC',
    fontWeight: '700',
  },
  deleteButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: {
    color: '#FFB4AC',
    fontSize: 12,
    fontWeight: '500',
  },
  emptyCard: {
    flex: 1,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    backgroundColor: 'transparent',
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  emptyText: {
    maxWidth: 300,
    marginTop: 6,
    color: '#C5CDD8',
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: BEDSIDE_FOOTER_COLORS.backdrop,
  },
  footerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#91D8CC',
  },
  footerCopy: {
    flexShrink: 1,
  },
  footerTitle: {
    color: BEDSIDE_FOOTER_COLORS.title,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  footerText: {
    color: BEDSIDE_FOOTER_COLORS.detail,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
});
