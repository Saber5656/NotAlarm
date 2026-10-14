import {
  type RepeatKind,
  type Weekday,
  formatRepeatLabel,
  getNextAlarmTime,
  makeAlarmRepeat,
} from './alarmSchedule';
import {
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from './alarmOrchestrator';
import { MIN_ARM_LEAD_MS } from './alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/**
 * While an alarm rings the list must not be operable: switching a repeating
 * alarm off from there cancels every future occurrence, not just this one.
 */
export function isAlarmListLocked(ringingCycle: StoredAlarm | null): boolean {
  return ringingCycle !== null;
}

export type AlarmListLockReason = 'ringing' | 'due';

/**
 * Reads the latest alarms and clock, not a render-time snapshot, so a dialog
 * that was opened before an alarm started ringing cannot act on stale state.
 * A monitored cycle whose due time has arrived counts even before the ringing
 * state has been saved.
 */
export function findAlarmListLock(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
): AlarmListLockReason | null {
  let due = false;
  for (const alarm of alarms) {
    for (const cycle of alarm.cycles) {
      if (cycle.phase === 'ringing') {
        return 'ringing';
      }
      if (
        (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
        cycle.dueAtMs <= nowMs
      ) {
        due = true;
      }
    }
  }
  return due ? 'due' : null;
}

/** Runs a list mutation only if the list is unlocked at execution time. */
export async function runUnlessAlarmListLocked<T>(input: {
  getAlarms(): readonly StoredAlarmDefinition[];
  nowMs(): number;
  run(): Promise<T>;
  onBlocked(reason: AlarmListLockReason): void;
}): Promise<{ ran: true; value: T } | { ran: false }> {
  const reason = findAlarmListLock(input.getAlarms(), input.nowMs());
  if (reason) {
    input.onBlocked(reason);
    return { ran: false };
  }
  return { ran: true, value: await input.run() };
}

function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

/**
 * The next occurrence that was stopped by wake-up evidence and has not yet
 * come due, with the date and the reason, so a stop is never silent.
 */
export function describeSuppressedOccurrence(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
  formatDate: (timestampMs: number) => string,
): { alarmId: string; cycleId: string; dueAtMs: number; text: string } | null {
  let earliest: { alarmId: string; cycle: StoredAlarm } | null = null;
  for (const alarm of alarms) {
    for (const cycle of alarm.cycles) {
      if (
        cycle.phase === 'suppressed' &&
        cycle.dueAtMs > nowMs &&
        (!earliest || cycle.dueAtMs < earliest.cycle.dueAtMs)
      ) {
        earliest = { alarmId: alarm.id, cycle };
      }
    }
  }
  if (!earliest) {
    return null;
  }

  const { cycle } = earliest;
  const reason = cycle.stepCandidateRecorded ? '100歩' : '通知';
  return {
    alarmId: earliest.alarmId,
    cycleId: cycle.cycleId,
    dueAtMs: cycle.dueAtMs,
    text: `${formatDate(cycle.dueAtMs)} ${formatClock(
      cycle.dueAtMs,
    )} は${reason}で起床確認済みのため鳴りません`,
  };
}

export type PedometerState =
  | 'preparing'
  | 'counting'
  | 'unavailable'
  | 'denied'
  | 'error';

export interface StepGuidance {
  /** The progress bar and "n / 100" only make sense while steps can count. */
  showProgress: boolean;
  /** Status line shown with the bar, or in its place when it is hidden. */
  message: string;
  canOpenSettings: boolean;
}

// Deliberately does not promise the alarm will ring: notification delivery or
// a failed cancel save can be unknown at the same time.
const STEPS_UNUSABLE = '歩数による停止を確認できません。予定を確認してください';

export function getStepGuidance(state: PedometerState): StepGuidance {
  switch (state) {
    case 'preparing':
      return {
        showProgress: true,
        message: '歩数計を準備中',
        canOpenSettings: false,
      };
    case 'counting':
      return {
        showProgress: true,
        message: 'アプリ表示中のみ計測',
        canOpenSettings: false,
      };
    case 'unavailable':
      return {
        showProgress: false,
        message: `この端末では歩数を使えません。${STEPS_UNUSABLE}`,
        canOpenSettings: false,
      };
    case 'denied':
      return {
        showProgress: false,
        message: `歩数の利用が許可されていません。${STEPS_UNUSABLE}`,
        canOpenSettings: true,
      };
    case 'error':
      return {
        showProgress: false,
        message: `歩数を計測できません。${STEPS_UNUSABLE}`,
        canOpenSettings: false,
      };
  }
}

/** Shown instead of the normal empty state when saved alarms cannot be read. */
export const STORAGE_LOAD_FAILED_COPY = {
  title: 'アラーム情報を読み込めません',
  body: '以前に設定したアラームは、このあとも鳴ることがあります。予約済みの通知は解除していません。',
  addDisabledReason:
    'アラーム情報を読み込めないため、新しいアラームは追加できません。',
  /** Non-destructive: nothing is deleted or reset by following these. */
  restartSteps: [
    'アプリを上にスワイプして完全に終了し、開き直してください。',
    '直らない場合は、端末を再起動してからアプリを開いてください。',
    'アラームの情報や通知は消さないでください。確認が取れるまで、別の目覚ましも併用してください。',
  ],
} as const;

export type SuppressionWarningKind = 'save_failed' | 'status_unknown';

/** Persistent warnings for a stop whose outcome is not fully known. */
export const SUPPRESSION_WARNING_COPY: Record<
  SuppressionWarningKind,
  { title: string; body: string }
> = {
  save_failed: {
    title: '停止の記録を保存できません',
    body: '起床を確認して通知を取り消しましたが、その状態を保存できませんでした。アプリを開き直すと復旧を再試行します。それまで、画面上の予定と実際の通知がずれている可能性があります。',
  },
  status_unknown: {
    title: '停止・予約の状態が未確認です',
    body: '通知の取り消し結果を確認できませんでした。この回のアラームは、鳴る場合と鳴らない場合があります。別の目覚ましを併用してください。',
  },
};

/** Turns a thrown suppression error into a persistent warning and a notice. */
export function classifySuppressionFailure(
  error: unknown,
): { warning: SuppressionWarningKind; notice: string } | null {
  if (error instanceof SuppressionSaveError) {
    return {
      warning: 'save_failed',
      notice:
        '起床を確認し通知を取り消しましたが、状態を保存できませんでした。アプリを開き直すと復旧を再試行します。',
    };
  }
  if (error instanceof SuppressionCancelUnknownError) {
    return {
      warning: 'status_unknown',
      notice:
        '通知の取り消し結果を確認できませんでした。この回が鳴るかは未確認です。',
    };
  }
  return null;
}

/** Notice for a stop attempt that left the alarm in place. */
export function describeAlarmRemains(reason: string): {
  tone: 'warning' | 'danger';
  text: string;
} {
  switch (reason) {
    case 'CANCEL_NOT_VERIFIED':
      return {
        tone: 'danger',
        text: 'アラーム停止を確認できませんでした。鳴る前提で扱ってください。',
      };
    case 'ALARM_DUE_OR_PAST':
      return {
        tone: 'warning',
        text: 'アラーム時刻になったため停止しませんでした。アラームは鳴ります。',
      };
    case 'JOURNAL_NOT_WRITTEN':
      return {
        tone: 'warning',
        text: '停止の記録を保存できなかったため、通知は取り消していません。アラームは予定どおり鳴ります。',
      };
    default:
      return {
        tone: 'warning',
        text: 'この確認は現在のアラーム周期と一致しないため、アラームを維持します。',
      };
  }
}

const DISTANT_FIRST_RING_MS = 24 * 60 * 60_000;

function formatLead(milliseconds: number): string {
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

export interface NewAlarmSummary {
  text: string;
  /** True when the first ring is more than 24 hours away. */
  isDistant: boolean;
  /** False when the alarm could not be added as chosen (see `text`). */
  canAdd: boolean;
}

/** One line for the composer: the repeat rule and when it first rings. */
export function summarizeNewAlarm(input: {
  nowMs: number;
  hour: number;
  minute: number;
  repeatKind: RepeatKind;
  customWeekdays: readonly Weekday[];
  formatDate: (timestampMs: number) => string;
}): NewAlarmSummary {
  const { nowMs, hour, minute, repeatKind } = input;
  const clock = `${hour.toString().padStart(2, '0')}:${minute
    .toString()
    .padStart(2, '0')}`;

  if (repeatKind === 'custom' && input.customWeekdays.length === 0) {
    return {
      text: '曜日を選ぶと初回の日時が表示されます',
      isDistant: false,
      canAdd: false,
    };
  }

  const repeat = makeAlarmRepeat(repeatKind, nowMs, input.customWeekdays);
  const nextAtMs = getNextAlarmTime(nowMs, hour, minute, repeat);
  if (!nextAtMs) {
    return {
      text:
        repeatKind === 'today'
          ? `今日の${clock}はすでに過ぎています。時刻を選び直してください`
          : '初回の日時を計算できません',
      isDistant: false,
      canAdd: false,
    };
  }

  const lead = nextAtMs - nowMs;
  if (lead < MIN_ARM_LEAD_MS) {
    return {
      text: `${clock}は直前すぎて予約できません。時刻を選び直してください`,
      isDistant: false,
      canAdd: false,
    };
  }
  return {
    text: `${formatRepeatLabel(repeat)}・初回 ${input.formatDate(
      nextAtMs,
    )} ${clock}（${formatLead(lead)}）`,
    isDistant: lead > DISTANT_FIRST_RING_MS,
    canAdd: true,
  };
}

/** The stop control stops the sound; it is not a wake-up confirmation. */
export const RINGING_STOP_LABEL = 'アラームを止める';

export const RINGING_STOP_HINT =
  '鳴っているアラーム音を止めます。繰り返しの次回以降は残ります';

/**
 * The label VoiceOver reads when focus lands on the stop control. It carries
 * the time and that the alarm is ringing, so it does not depend on a separate
 * announcement that the focus move would cut off.
 */
export function getRingingStopA11yLabel(hour: number, minute: number): string {
  return `${hour}時${minute}分のアラームが鳴っています。${RINGING_STOP_LABEL}`;
}
