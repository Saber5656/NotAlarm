import {
  type AlarmRepeat,
  type RepeatKind,
  type Weekday,
  formatRepeatLabel,
  getNextAlarmTime,
  localDateKey,
  makeAlarmRepeat,
  resolveEditedRepeat,
} from './alarmSchedule';
import {
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from './alarmOrchestrator';
import { MIN_ARM_LEAD_MS } from './alarmPolicy';
import {
  type ErrorCode,
  type ErrorNotice,
  describeErrorCode,
  noticeFromCode,
} from './errorCatalog';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/**
 * While an alarm rings the list must not be operable: switching a repeating
 * alarm off from there cancels every future occurrence, not just this one.
 */
export function isAlarmListLocked(ringingCycle: StoredAlarm | null): boolean {
  return ringingCycle !== null;
}

export type AlarmListLockReason = 'ringing' | 'snoozed' | 'due';

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
  let snoozed = false;
  for (const alarm of alarms) {
    for (const cycle of alarm.cycles) {
      if (cycle.phase === 'ringing') {
        return 'ringing';
      }
      // A waiting snooze still owns a scheduled notification and rings again;
      // editing, switching off or deleting around it is not supported.
      if (cycle.phase === 'snoozed') {
        snoozed = true;
      }
      if (
        (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
        cycle.dueAtMs <= nowMs
      ) {
        due = true;
      }
    }
  }
  return snoozed ? 'snoozed' : due ? 'due' : null;
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
  if (cycle.suppressedBy === 'user_skip') {
    return {
      alarmId: earliest.alarmId,
      cycleId: cycle.cycleId,
      dueAtMs: cycle.dueAtMs,
      text: `${formatDate(cycle.dueAtMs)} ${formatClock(
        cycle.dueAtMs,
      )} は今回分だけ止めたため鳴りません`,
    };
  }
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
  | 'availability_unknown'
  | 'denied'
  | 'permission_unknown'
  | 'error';

export interface StepGuidance {
  /** The progress bar and "n / 100" only make sense while steps can count. */
  showProgress: boolean;
  /** Status line shown with the bar, or in its place when it is hidden. */
  message: string;
  canOpenSettings: boolean;
  /** Catalog code of the failure, shown as secondary detail; none while fine. */
  code?: ErrorCode;
}

const STEP_FAILURE_CODES = {
  unavailable: 'SENSOR_UNAVAILABLE',
  availability_unknown: 'SENSOR_AVAILABILITY_UNKNOWN',
  denied: 'SENSOR_PERMISSION_DENIED',
  permission_unknown: 'SENSOR_PERMISSION_UNKNOWN',
  error: 'SENSOR_READ_FAILED',
} as const satisfies Record<
  Exclude<PedometerState, 'preparing' | 'counting'>,
  ErrorCode
>;

// Deliberately does not promise the alarm will ring: notification delivery or
// a failed cancel save can be unknown at the same time.
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
    default: {
      const code = STEP_FAILURE_CODES[state];
      const { message, recovery } = describeErrorCode(code);
      return {
        showProgress: false,
        message: message + recovery,
        canOpenSettings: state === 'denied',
        code,
      };
    }
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
    '確認が取れるまで、別の目覚ましも併用してください。',
  ],
} as const;

/** Shown only on the load-failed card; every step needs a user tap. */
export const STORAGE_RESET_COPY = {
  lastResort:
    '再起動しても直らない場合の最後の手段として、このアプリの予約通知を解除し、保存データをリセットできます。他のアプリの通知は解除しません。',
  action: '通知を解除してリセット',
  hint: 'このアプリのものと確認できる予約済み通知を解除し、保存データを消します。確認が2回あります。',
  firstConfirmTitle: '通知を解除してリセットしますか？',
  firstConfirmBody:
    'このアプリのものと確認できる予約済み通知を解除し、保存されたアラーム情報を消します。リセット後は、アラームを作り直す必要があります。',
  finalConfirmTitle: '本当にリセットしますか？',
  finalConfirmBody:
    '解除した通知と消した情報は元に戻せません。リセットが終わるまで、別の目覚ましを併用してください。',
  done: 'リセットしました。アラームを追加できます。',
  ambiguousWarning:
    'リセットしました。ただし、このアプリのものか判別できない古い形式の通知が残っています。他のアプリの通知の可能性があるため解除していません。判別できない通知は鳴る場合があるので、端末の通知設定やスケジュールを確認してください。',
  failed:
    '削除を最後まで完了できませんでした。一部の通知やデータはすでに消えている場合があります。もう一度実行すると続きから再開します。',
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
): { warning: SuppressionWarningKind; notice: ErrorNotice } | null {
  if (error instanceof SuppressionSaveError) {
    return {
      warning: 'save_failed',
      notice: noticeFromCode('SUPPRESSION_SAVE_FAILED'),
    };
  }
  if (error instanceof SuppressionCancelUnknownError) {
    return {
      warning: 'status_unknown',
      notice: noticeFromCode('CANCEL_UNKNOWN'),
    };
  }
  return null;
}

/** The catalog code for why a stop attempt left the alarm in place. */
export function getAlarmRemainsCode(reason: string): ErrorCode {
  switch (reason) {
    case 'CANCEL_NOT_VERIFIED':
      return 'CANCEL_NOT_VERIFIED';
    case 'JOURNAL_NOT_WRITTEN':
      return 'SUPPRESSION_JOURNAL_NOT_WRITTEN';
    case 'SKIP_BEFORE_WINDOW':
      return 'SKIP_BEFORE_WINDOW';
    case 'WRONG_OCCURRENCE':
    case 'WRONG_CYCLE':
    case 'WRONG_MAIN_ALARM':
      return 'WRONG_OCCURRENCE';
    case 'ALARM_DUE_OR_PAST':
    case 'STEP_AT_OR_AFTER_DUE':
    case 'CONFIRMATION_AT_OR_AFTER_DUE':
      return 'DEADLINE_PASSED';
    case 'INVALID_STEP_SAMPLE':
      return 'STEP_COUNT_INVALID';
    case 'INVALID_RESPONSE':
    case 'INVALID_ALARM_RECORD':
    case 'INVALID_PROCESSING_TIME':
    case 'INVALID_STEP_TIME':
    case 'INVALID_CONFIRMATION_TIME':
    case 'NOT_EXPLICIT_CONFIRMATION':
      return 'ACTION_INVALID';
    default:
      return 'ACTION_STALE';
  }
}

/** Notice for a stop attempt that left the alarm in place. */
export function describeAlarmRemains(reason: string): ErrorNotice {
  return noticeFromCode(getAlarmRemainsCode(reason));
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
  /** Editing: the alarm's current repeat, so a today-only date is kept. */
  existingRepeat?: AlarmRepeat;
  /** Editing: false for an off alarm, which is saved without scheduling. */
  enabled?: boolean;
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

  const repeat = input.existingRepeat
    ? resolveEditedRepeat(
        input.existingRepeat,
        repeatKind,
        input.customWeekdays,
        nowMs,
      )
    : makeAlarmRepeat(repeatKind, nowMs, input.customWeekdays);
  if (input.enabled === false) {
    return {
      text: `${formatRepeatLabel(repeat)}・オフのまま保存します（オンにすると通知を予約します）`,
      isDistant: false,
      canAdd: true,
    };
  }
  const nextAtMs = getNextAlarmTime(nowMs, hour, minute, repeat);
  if (!nextAtMs) {
    const keptOriginalDate =
      repeatKind === 'today' && repeat.dateKey !== localDateKey(nowMs);
    return {
      text:
        repeatKind === 'today'
          ? `${keptOriginalDate ? 'この日' : '今日'}の${clock}はすでに過ぎています。時刻を選び直してください`
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
export function getRingingStopA11yLabel(
  hour: number,
  minute: number,
  dateLabel?: string,
): string {
  const date = dateLabel ? `${dateLabel} ` : '';
  return `${date}${hour}時${minute}分のアラームが鳴っています。${RINGING_STOP_LABEL}`;
}

/**
 * What the ringing card shows. A main ring shows its own due time and date. A
 * snooze ring shows when that delivery actually fired, with that moment's
 * date; the cycle's original `dueAtMs` is untouched.
 */
export function getRingingDisplay(cycle: StoredAlarm): {
  timeMs: number;
  dateMs: number;
} {
  const snoozeDueAtMs = cycle.snooze?.dueAtMs;
  const ms =
    cycle.snooze && cycle.snooze.count > 0 && snoozeDueAtMs !== undefined
      ? snoozeDueAtMs
      : cycle.dueAtMs;
  return { timeMs: ms, dateMs: ms };
}

export const MISSED_CARD_ANNOUNCEMENT =
  '見逃したアラームがあります。音は鳴らしていません。確認済みにできます。';

export interface MissedAnnouncementPlan {
  announce: boolean;
  /** Missed cycle ids already announced; gone or acknowledged ids are pruned. */
  announced: ReadonlySet<string>;
}

/**
 * Tracks which missed cycles were already announced, so only a cycle that has
 * not been announced yet is spoken: never twice, never while ringing (pending
 * ids wait for the ring to end), and never from the per-second clock tick.
 */
export function planMissedAnnouncement(input: {
  announced: ReadonlySet<string>;
  missedCycleIds: readonly string[];
  isRinging: boolean;
}): MissedAnnouncementPlan {
  const current = new Set(input.missedCycleIds);
  const kept = new Set([...input.announced].filter((id) => current.has(id)));
  if (input.isRinging) {
    return { announce: false, announced: kept };
  }
  const announce = [...current].some((id) => !kept.has(id));
  return { announce, announced: current };
}

function isTerminalCycle(cycle: StoredAlarm): boolean {
  return cycle.phase === 'suppressed' || cycle.phase === 'dismissed';
}

export interface TodayOnlyExpiry {
  /** Replaces the repeat label in the row, e.g. "今日だけ（10/15） ・ 終了". */
  rowLabel: string;
  /** Spoken suffix carrying the original date and the Ended state. */
  a11yLabel: string;
  explanation: string;
}

/**
 * An expired today-only definition keeps its original date and is shown as
 * ended; it is never reused for another day. Null when it can still ring.
 */
export function describeTodayOnlyExpiry(
  definition: StoredAlarmDefinition,
  nowMs: number,
  formatDate: (timestampMs: number) => string,
): TodayOnlyExpiry | null {
  const { repeat } = definition;
  if (repeat.kind !== 'today' || !repeat.dateKey) {
    return null;
  }
  // Ended only when nothing can still ring or be cancelled: an enabled
  // record, or any cycle outside the terminal allowlist, is still active.
  if (definition.enabled || !definition.cycles.every(isTerminalCycle)) {
    return null;
  }
  if (getNextAlarmTime(nowMs, definition.hour, definition.minute, repeat)) {
    return null;
  }
  const [year, month, day] = repeat.dateKey.split('-').map(Number);
  const date = formatDate(
    new Date(year, month - 1, day, definition.hour, definition.minute).getTime(),
  );
  return {
    rowLabel: `今日だけ（${date}） ・ 終了`,
    a11yLabel: `今日だけ、${date}、終了`,
    explanation:
      'この日の分は終了しました。もう一度使うには、新しいアラームを追加してください',
  };
}

export interface ComposerValues {
  selectedTime: Date;
  repeatKind: RepeatKind;
  customWeekdays: Weekday[];
}

/**
 * Add always starts from the defaults; edit keeps what was loaded from the
 * alarm. Leaving edit mode must not leak its values into the next new alarm.
 */
export function resolveComposerValues(input: {
  mode: 'add' | 'edit';
  current: ComposerValues;
  defaultWakeTime: Date;
}): ComposerValues {
  if (input.mode === 'edit') {
    return input.current;
  }
  return {
    selectedTime: input.defaultWakeTime,
    repeatKind: 'weekdays',
    customWeekdays: [1, 2, 3, 4, 5],
  };
}

interface ComposerAvailabilityInput {
  ringing: boolean;
  loadFailed: boolean;
  /** Deletion recovery owns storage: every alarm write is rejected. */
  deletionPending: boolean;
  isBusy: boolean;
  isWeb: boolean;
}

export function canEditAlarm(
  input: Omit<ComposerAvailabilityInput, 'ringing' | 'loadFailed'> & {
    listLocked: boolean;
  },
): boolean {
  return !input.isBusy && !input.listLocked && !input.deletionPending && !input.isWeb;
}

export function canSubmitComposer(
  input: ComposerAvailabilityInput & {
    isEditing: boolean;
    listFull: boolean;
    canAdd: boolean;
  },
): boolean {
  return (
    !input.isWeb &&
    !input.ringing &&
    !input.loadFailed &&
    !input.deletionPending &&
    !input.isBusy &&
    // Editing does not add an alarm, so a full list must not block it.
    (input.isEditing || !input.listFull) &&
    input.canAdd
  );
}

/** Drops one alarm's verification once its notifications were replaced. */
export function withoutQueueStatus<T>(
  statuses: Record<string, T>,
  alarmId: string,
): Record<string, T> {
  if (!(alarmId in statuses)) {
    return statuses;
  }
  const { [alarmId]: _cleared, ...rest } = statuses;
  return rest;
}
