import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { Pedometer } from 'expo-sensors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  MIN_ARM_LEAD_MS,
  STEP_THRESHOLD,
  classifyStepEvidence,
  getCheckInAtMs,
} from './src/alarmPolicy';
import {
  CONFIRM_AWAKE_ACTION,
  MAIN_ALARM_KIND,
} from './src/alarmContracts';
import {
  processAwakeResponseFailSafe,
  scheduleAlarmNotificationsFailSafe,
} from './src/alarmOrchestrator';
import {
  type StoredAlarm,
  loadStoredAlarm,
  saveStoredAlarm,
} from './src/alarmStorage';
import {
  cancelScheduledNotification,
  dismissDeliveredNotification,
  installForegroundNotificationHandler,
  prepareNotifications,
  readAlarmNotificationData,
  scheduleCheckInNotification,
  scheduleMainAlarmNotification,
} from './src/notificationService';

installForegroundNotificationHandler();

const DELAY_OPTIONS_MINUTES = [2, 5, 10];

type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger';

interface Notice {
  tone: NoticeTone;
  text: string;
}

function makeCycleId(): string {
  return `cycle-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function formatCountdown(milliseconds: number): string {
  if (milliseconds <= 0) {
    return '時刻になりました';
  }

  const totalSeconds = Math.ceil(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒後`;
}

function isMonitoring(alarm: StoredAlarm | null): boolean {
  return alarm?.phase === 'armed' || alarm?.phase === 'step_candidate';
}

export default function App() {
  const [alarm, setAlarm] = useState<StoredAlarm | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [nowMs, setNowMs] = useState(Date.now());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pedometerStatus, setPedometerStatus] = useState(
    Platform.OS === 'web' ? '実機のみ対応' : '待機中',
  );

  const alarmRef = useRef<StoredAlarm | null>(null);
  const responseInFlightRef = useRef<string | null>(null);
  const stepOffsetRef = useRef(0);

  const setCurrentAlarm = useCallback((next: StoredAlarm | null) => {
    alarmRef.current = next;
    setAlarm(next);
  }, []);

  const persistCurrentAlarm = useCallback(
    async (next: StoredAlarm): Promise<void> => {
      setCurrentAlarm(next);
      await saveStoredAlarm(next);
    },
    [setCurrentAlarm],
  );

  useEffect(() => {
    let mounted = true;

    void loadStoredAlarm()
      .then(async (stored) => {
        if (!mounted || !stored) {
          return;
        }

        if (isMonitoring(stored) && Date.now() >= stored.dueAtMs) {
          const ringing = { ...stored, phase: 'ringing' as const };
          setCurrentAlarm(ringing);
          await saveStoredAlarm(ringing);
          return;
        }

        setCurrentAlarm(stored);
      })
      .catch(() => {
        if (mounted) {
          setNotice({
            tone: 'warning',
            text: '保存状態を読めませんでした。既に予約済みの通知は解除していません。',
          });
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoaded(true);
        }
      });

    return () => {
      mounted = false;
    };
  }, [setCurrentAlarm]);

  const handleAwakeResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== CONFIRM_AWAKE_ACTION) {
        return;
      }

      const data = readAlarmNotificationData(response);
      const responseKey = `${data?.cycleId ?? 'invalid'}:${
        data?.mainAlarmId ?? 'invalid'
      }:${response.notification.request.identifier}`;
      if (responseInFlightRef.current === responseKey) {
        return;
      }
      responseInFlightRef.current = responseKey;

      try {
        const confirmedAtMs = Date.now();
        const result = await processAwakeResponseFailSafe(
          {
            loadAlarm: loadStoredAlarm,
            saveAlarm: saveStoredAlarm,
            cancelScheduled: cancelScheduledNotification,
          },
          {
            actionIdentifier: response.actionIdentifier,
            kind: data?.kind,
            cycleId: data?.cycleId,
            mainAlarmId: data?.mainAlarmId,
            checkInNotificationId:
              response.notification.request.identifier,
            confirmedAtMs,
          },
        );

        if (result.status === 'ignored') {
          return;
        }

        if (result.status === 'alarm_remains') {
          setNotice({
            tone:
              result.reason === 'CANCEL_NOT_VERIFIED' ? 'danger' : 'warning',
            text:
              result.reason === 'CANCEL_NOT_VERIFIED'
                ? 'メインアラームの停止を確認できませんでした。鳴る前提で扱ってください。'
                : `安全条件を満たさない確認（${result.reason}）のため、アラームは鳴ります。`,
          });
          return;
        }

        setCurrentAlarm(result.alarm);
        void cancelScheduledNotification(result.alarm.checkInNotificationId);
        setNotice({
          tone: 'success',
          text: '「起きています」を確認しました。今回のアラームだけ停止しました。',
        });
      } catch {
        setNotice({
          tone: 'danger',
          text: '起床確認の処理に失敗しました。安全のためアラームは鳴る前提です。',
        });
      } finally {
        responseInFlightRef.current = null;
      }
    },
    [setCurrentAlarm],
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
        const current = alarmRef.current;

        if (
          data?.kind !== MAIN_ALARM_KIND ||
          typeof data.cycleId !== 'string' ||
          !current ||
          current.cycleId !== data.cycleId ||
          !isMonitoring(current)
        ) {
          return;
        }

        const ringing = { ...current, phase: 'ringing' as const };
        setCurrentAlarm(ringing);
        void saveStoredAlarm(ringing);
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
  }, [handleAwakeResponse, isLoaded, setCurrentAlarm]);

  useEffect(() => {
    const interval = setInterval(() => {
      const tick = Date.now();
      setNowMs(tick);

      const current = alarmRef.current;
      if (current && isMonitoring(current) && tick >= current.dueAtMs) {
        const ringing = { ...current, phase: 'ringing' as const };
        setCurrentAlarm(ringing);
        void saveStoredAlarm(ringing);
      }
    }, 1_000);

    return () => clearInterval(interval);
  }, [setCurrentAlarm]);

  useEffect(() => {
    if (
      Platform.OS === 'web' ||
      !isMonitoring(alarm) ||
      !alarm?.cycleId
    ) {
      return;
    }

    let disposed = false;
    let subscription: ReturnType<typeof Pedometer.watchStepCount> | undefined;
    stepOffsetRef.current = alarm.stepCount;

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

        setPedometerStatus('計測中（アプリ表示中のみ）');
        subscription = Pedometer.watchStepCount(({ steps }) => {
          const current = alarmRef.current;
          if (!current || !isMonitoring(current) || Date.now() >= current.dueAtMs) {
            return;
          }

          const totalSteps = stepOffsetRef.current + steps;
          const evidence = classifyStepEvidence(totalSteps, Date.now());
          if (evidence.kind === 'ERROR') {
            setPedometerStatus('歩数データ異常（アラームは維持）');
            return;
          }

          const becameCandidate =
            evidence.kind === 'STEP_CANDIDATE' &&
            !current.stepCandidateRecorded;
          const updated: StoredAlarm = {
            ...current,
            phase: becameCandidate ? 'step_candidate' : current.phase,
            stepCount: evidence.steps,
            stepCandidateAtMs: becameCandidate
              ? evidence.observedAtMs
              : current.stepCandidateAtMs,
            stepCandidateRecorded:
              current.stepCandidateRecorded || becameCandidate,
          };

          setCurrentAlarm(updated);
          void saveStoredAlarm(updated);

          if (becameCandidate) {
            setNotice({
              tone: 'neutral',
              text: '20歩を検知しました。ただし再入眠に備え、アラームはまだ解除しません。',
            });
          }
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
  }, [alarm?.cycleId, alarm ? isMonitoring(alarm) : false, setCurrentAlarm]);

  const armAlarm = useCallback(async () => {
    if (isBusy || isMonitoring(alarmRef.current)) {
      return;
    }

    setIsBusy(true);
    setNotice(null);

    try {
      const armedAtMs = Date.now();
      const dueAtMs = armedAtMs + delayMinutes * 60_000;
      if (dueAtMs - armedAtMs < MIN_ARM_LEAD_MS) {
        throw new Error('アラームは90秒以上先に設定してください。');
      }

      await prepareNotifications();
      const cycleId = makeCycleId();
      const scheduled = await scheduleAlarmNotificationsFailSafe(
        {
          scheduleMain: scheduleMainAlarmNotification,
          scheduleCheckIn: scheduleCheckInNotification,
        },
        {
          cycleId,
          dueAtMs,
          checkInAtMs: getCheckInAtMs(dueAtMs),
        },
      );

      const next: StoredAlarm = {
        cycleId,
        mainAlarmId: scheduled.mainAlarmId,
        checkInNotificationId: scheduled.checkInNotificationId,
        armedAtMs,
        dueAtMs,
        phase: 'armed',
        stepCount: 0,
        stepCandidateRecorded: false,
      };

      setCurrentAlarm(next);
      try {
        await saveStoredAlarm(next);
      } catch {
        setNotice({
          tone: 'warning',
          text: 'アラームは予約済みですが、状態保存に失敗しました。通知は解除していません。',
        });
        return;
      }

      setPedometerStatus('歩数権限を確認中…');
      setNotice(
        scheduled.checkInWarning
          ? {
              tone: 'warning',
              text: 'メインアラームは予約済みです。起床確認通知だけ予約できませんでした。',
            }
          : {
              tone: 'success',
              text: 'メインアラームを先に予約しました。1分前に起床確認を送ります。',
            },
      );
    } catch (error) {
      setNotice({
        tone: 'danger',
        text:
          error instanceof Error
            ? error.message
            : 'アラームを予約できませんでした。',
      });
    } finally {
      setIsBusy(false);
    }
  }, [delayMinutes, isBusy, setCurrentAlarm]);

  const stopRinging = useCallback(async () => {
    const current = alarmRef.current;
    if (!current || current.phase !== 'ringing' || isBusy) {
      return;
    }

    setIsBusy(true);
    try {
      await dismissDeliveredNotification(current.mainAlarmId);
      const dismissed = { ...current, phase: 'dismissed' as const };
      await persistCurrentAlarm(dismissed);
      setNotice({ tone: 'neutral', text: 'アラームを停止しました。' });
    } catch {
      setNotice({
        tone: 'danger',
        text: '停止処理に失敗しました。端末の通知から停止してください。',
      });
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, persistCurrentAlarm]);

  const phasePresentation = useMemo(() => {
    if (!alarm || alarm.phase === 'dismissed') {
      return {
        eyebrow: 'READY',
        title: '寝ていたら、鳴らす。',
        description: '確実な起床確認がない限り、アラームを残します。',
        tone: 'neutral' as NoticeTone,
      };
    }

    if (alarm.phase === 'ringing') {
      return {
        eyebrow: 'ALARM',
        title: '起きる時間です',
        description: '起床を確認できなかったため、アラームを鳴らしています。',
        tone: 'danger' as NoticeTone,
      };
    }

    if (alarm.phase === 'suppressed') {
      return {
        eyebrow: 'CONFIRMED',
        title: '起床を確認しました',
        description: '明示確認が期限内に届いたため、今回だけ停止しました。',
        tone: 'success' as NoticeTone,
      };
    }

    if (alarm.phase === 'step_candidate') {
      return {
        eyebrow: 'WAKE CANDIDATE',
        title: '20歩を検知しました',
        description: '再入眠の可能性があるため、アラームはまだ有効です。',
        tone: 'warning' as NoticeTone,
      };
    }

    return {
      eyebrow: 'ARMED',
      title: `${formatClock(alarm.dueAtMs)} にセット`,
      description: '1分前の確認に応答がなければ、そのまま鳴ります。',
      tone: 'neutral' as NoticeTone,
    };
  }, [alarm]);

  const active = isMonitoring(alarm);
  const canArm = Platform.OS !== 'web' && !active && !isBusy;
  const countdown = alarm ? formatCountdown(alarm.dueAtMs - nowMs) : null;

  if (!isLoaded) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color="#FF6B55" size="large" />
        <Text style={styles.loadingText}>状態を安全に確認しています…</Text>
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
          <View>
            <Text style={styles.brandName}>AlreadyUp</Text>
            <Text style={styles.prototypeLabel}>FAIL-SAFE MVP</Text>
          </View>
        </View>

        <View
          style={[
            styles.heroCard,
            phasePresentation.tone === 'danger' && styles.heroDanger,
            phasePresentation.tone === 'success' && styles.heroSuccess,
            phasePresentation.tone === 'warning' && styles.heroWarning,
          ]}
        >
          <Text style={styles.heroEyebrow}>{phasePresentation.eyebrow}</Text>
          <Text style={styles.heroTitle}>{phasePresentation.title}</Text>
          <Text style={styles.heroDescription}>
            {phasePresentation.description}
          </Text>
          {active && countdown ? (
            <View style={styles.countdownPill}>
              <View style={styles.liveDot} />
              <Text style={styles.countdownText}>{countdown}</Text>
            </View>
          ) : null}
        </View>

        {notice ? (
          <View style={[styles.notice, styles[`notice_${notice.tone}`]]}>
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}

        {!active && alarm?.phase !== 'ringing' ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>何分後に鳴らしますか？</Text>
            <View style={styles.delayRow}>
              {DELAY_OPTIONS_MINUTES.map((minutes) => {
                const selected = delayMinutes === minutes;
                return (
                  <Pressable
                    key={minutes}
                    accessibilityRole="button"
                    onPress={() => setDelayMinutes(minutes)}
                    style={[
                      styles.delayButton,
                      selected && styles.delayButtonSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.delayButtonText,
                        selected && styles.delayButtonTextSelected,
                      ]}
                    >
                      {minutes}分
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={!canArm}
              onPress={() => void armAlarm()}
              style={({ pressed }) => [
                styles.primaryButton,
                (!canArm || pressed) && styles.buttonDimmed,
              ]}
            >
              {isBusy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  アラームをセット
                </Text>
              )}
            </Pressable>
            {Platform.OS === 'web' ? (
              <Text style={styles.webHint}>
                Webでは通知・歩数を使えません。iPhone実機で試してください。
              </Text>
            ) : null}
          </View>
        ) : null}

        {active ? (
          <View style={styles.section}>
            <View style={styles.metricRow}>
              <View style={styles.metricCard}>
                <Text style={styles.metricValue}>{alarm?.stepCount ?? 0}</Text>
                <Text style={styles.metricLabel}>検知した歩数 / {STEP_THRESHOLD}</Text>
              </View>
              <View style={styles.metricCard}>
                <Text style={styles.metricValue}>1</Text>
                <Text style={styles.metricLabel}>分前に最終確認</Text>
              </View>
            </View>
            <Text style={styles.sensorStatus}>{pedometerStatus}</Text>

            <View style={styles.ruleCard}>
              <View style={styles.ruleRow}>
                <Text style={styles.ruleIcon}>✓</Text>
                <Text style={styles.ruleText}>
                  Watch / iPhoneで「起きています」 → 今回だけ停止
                </Text>
              </View>
              <View style={styles.ruleDivider} />
              <View style={styles.ruleRow}>
                <Text style={styles.ruleIconMuted}>20</Text>
                <Text style={styles.ruleText}>
                  20歩 → 起床候補。再入眠に備えて停止しない
                </Text>
              </View>
              <View style={styles.ruleDivider} />
              <View style={styles.ruleRow}>
                <Text style={styles.ruleIconAlert}>?</Text>
                <Text style={styles.ruleText}>
                  未確認・エラー・期限切れ → アラームを維持
                </Text>
              </View>
            </View>

          </View>
        ) : null}

        {alarm?.phase === 'ringing' ? (
          <View style={styles.section}>
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
        ) : null}

        <View style={styles.safetyCard}>
          <Text style={styles.safetyTitle}>MVPの安全原則</Text>
          <Text style={styles.safetyText}>
            「起きている」と確定できない場合は、必ず鳴らす側に倒します。通常の通知はFocus・消音・音量設定の影響を受けるため、本番用の“絶対に鳴る”保証はまだありません。
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: '#F4F6F8',
  },
  loadingText: {
    color: '#526078',
    fontSize: 14,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 48,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FF6B55',
    shadowColor: '#FF6B55',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  logoGlyph: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
  },
  brandName: {
    color: '#10213B',
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  prototypeLabel: {
    marginTop: 2,
    color: '#7A879C',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  heroCard: {
    minHeight: 230,
    padding: 24,
    justifyContent: 'flex-end',
    borderRadius: 30,
    backgroundColor: '#10213B',
    shadowColor: '#10213B',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 5,
  },
  heroDanger: {
    backgroundColor: '#B83237',
  },
  heroSuccess: {
    backgroundColor: '#087A62',
  },
  heroWarning: {
    backgroundColor: '#A86518',
  },
  heroEyebrow: {
    marginBottom: 12,
    color: '#FFB6AA',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.7,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 38,
    letterSpacing: -0.9,
  },
  heroDescription: {
    maxWidth: 430,
    marginTop: 12,
    color: '#D7DEE9',
    fontSize: 15,
    lineHeight: 23,
  },
  countdownPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#69E5B9',
  },
  countdownText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  notice: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  notice_neutral: {
    borderColor: '#C9D3E1',
    backgroundColor: '#EEF2F7',
  },
  notice_success: {
    borderColor: '#9AD7C6',
    backgroundColor: '#E7F7F1',
  },
  notice_warning: {
    borderColor: '#E8C68F',
    backgroundColor: '#FFF5E6',
  },
  notice_danger: {
    borderColor: '#F2ADA9',
    backgroundColor: '#FFF0EF',
  },
  noticeText: {
    color: '#273850',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '600',
  },
  section: {
    marginTop: 26,
  },
  sectionLabel: {
    marginBottom: 12,
    color: '#526078',
    fontSize: 13,
    fontWeight: '700',
  },
  delayRow: {
    flexDirection: 'row',
    gap: 10,
  },
  delayButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#D6DDE7',
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  delayButtonSelected: {
    borderColor: '#10213B',
    backgroundColor: '#10213B',
  },
  delayButtonText: {
    color: '#526078',
    fontSize: 15,
    fontWeight: '800',
  },
  delayButtonTextSelected: {
    color: '#FFFFFF',
  },
  primaryButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    borderRadius: 18,
    backgroundColor: '#FF6B55',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },
  buttonDimmed: {
    opacity: 0.55,
  },
  webHint: {
    marginTop: 10,
    color: '#7A879C',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCard: {
    flex: 1,
    padding: 18,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E7EE',
  },
  metricValue: {
    color: '#10213B',
    fontSize: 26,
    fontWeight: '900',
  },
  metricLabel: {
    marginTop: 5,
    color: '#7A879C',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
  },
  sensorStatus: {
    marginTop: 9,
    color: '#7A879C',
    fontSize: 11,
    textAlign: 'right',
  },
  ruleCard: {
    marginTop: 18,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E7EE',
  },
  ruleRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  ruleIcon: {
    width: 28,
    color: '#087A62',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  ruleIconMuted: {
    width: 28,
    color: '#A86518',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  ruleIconAlert: {
    width: 28,
    color: '#B83237',
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
  },
  ruleText: {
    flex: 1,
    color: '#273850',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '600',
  },
  ruleDivider: {
    height: 1,
    backgroundColor: '#EDF0F4',
  },
  stopButton: {
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: '#10213B',
  },
  stopButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
  },
  safetyCard: {
    marginTop: 30,
    padding: 18,
    borderRadius: 20,
    backgroundColor: '#E9EDF2',
  },
  safetyTitle: {
    color: '#273850',
    fontSize: 12,
    fontWeight: '900',
  },
  safetyText: {
    marginTop: 8,
    color: '#647187',
    fontSize: 12,
    lineHeight: 19,
  },
});
