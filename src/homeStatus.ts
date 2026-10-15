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
import type { ErrorCode, ErrorNotice } from './errorCatalog';
import { noticeFromCodeIn } from './i18n/errorText';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import type { Messages } from './i18n/messages';
import type { TextContext } from './i18n/context';

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

/**
 * The next occurrence that was stopped by wake-up evidence and has not yet
 * come due, with the date and the reason, so a stop is never silent.
 */
export function describeSuppressedOccurrence(
  alarms: readonly StoredAlarmDefinition[],
  nowMs: number,
  { messages, formatter }: TextContext,
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
      text: messages.suppression.skippedThisTime(
        `${formatter.day(cycle.dueAtMs)} ${formatter.clockAt(cycle.dueAtMs)}`,
      ),
    };
  }
  return {
    alarmId: earliest.alarmId,
    cycleId: cycle.cycleId,
    dueAtMs: cycle.dueAtMs,
    text: messages.suppression.suppressedBy(
      `${formatter.day(cycle.dueAtMs)} ${formatter.clockAt(cycle.dueAtMs)}`,
      cycle.stepCandidateRecorded,
    ),
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
export function getStepGuidance(
  state: PedometerState,
  messages: Messages,
): StepGuidance {
  const { steps } = messages;
  switch (state) {
    case 'preparing':
      return {
        showProgress: true,
        message: steps.preparing,
        canOpenSettings: false,
      };
    case 'counting':
      return {
        showProgress: true,
        message: steps.counting,
        canOpenSettings: false,
      };
    default: {
      const code = STEP_FAILURE_CODES[state];
      const { message, recovery } = messages.errors[code];
      return {
        showProgress: false,
        message: message + messages.common.sentenceGap + recovery,
        canOpenSettings: state === 'denied',
        code,
      };
    }
  }
}

export type SuppressionWarningKind = 'save_failed' | 'status_unknown';

/** Persistent warnings for a stop whose outcome is not fully known. */
export function getSuppressionWarningCopy(
  kind: SuppressionWarningKind,
  messages: Messages,
): { title: string; body: string } {
  const { suppression } = messages;
  return kind === 'save_failed'
    ? { title: suppression.saveFailedTitle, body: suppression.saveFailedBody }
    : {
        title: suppression.statusUnknownTitle,
        body: suppression.statusUnknownBody,
      };
}

/** Turns a thrown suppression error into a persistent warning and a notice. */
export function classifySuppressionFailure(
  error: unknown,
  messages: Messages,
): { warning: SuppressionWarningKind; notice: ErrorNotice } | null {
  if (error instanceof SuppressionSaveError) {
    return {
      warning: 'save_failed',
      notice: noticeFromCodeIn(messages, 'SUPPRESSION_SAVE_FAILED'),
    };
  }
  if (error instanceof SuppressionCancelUnknownError) {
    return {
      warning: 'status_unknown',
      notice: noticeFromCodeIn(messages, 'CANCEL_UNKNOWN'),
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
export function describeAlarmRemains(
  reason: string,
  messages: Messages,
): ErrorNotice {
  return noticeFromCodeIn(messages, getAlarmRemainsCode(reason));
}

const DISTANT_FIRST_RING_MS = 24 * 60 * 60_000;

/** "in 2 hours 5 minutes": the time left until a due time, rounded up. */
export function formatLeadTime(
  milliseconds: number,
  messages: Messages,
): string {
  if (milliseconds <= 0) {
    return messages.lead.soon;
  }
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return messages.lead.daysHours(days, hours);
  }
  if (hours > 0) {
    return messages.lead.hoursMinutes(hours, minutes);
  }
  return messages.lead.minutes(minutes);
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
  text: TextContext;
}): NewAlarmSummary {
  const { nowMs, hour, minute, repeatKind } = input;
  const { messages, formatter } = input.text;
  const clock = formatter.clock(hour, minute);

  if (repeatKind === 'custom' && input.customWeekdays.length === 0) {
    return {
      text: messages.summary.pickWeekdays,
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
      text: messages.summary.savedOff(formatRepeatLabel(repeat, messages, formatter)),
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
          ? keptOriginalDate
            ? messages.summary.originalDayPassed(clock)
            : messages.summary.todayPassed(clock)
          : messages.summary.cannotCompute,
      isDistant: false,
      canAdd: false,
    };
  }

  const lead = nextAtMs - nowMs;
  if (lead < MIN_ARM_LEAD_MS) {
    return {
      text: messages.summary.tooSoon(clock),
      isDistant: false,
      canAdd: false,
    };
  }
  return {
    text: messages.summary.firstRing(
      formatRepeatLabel(repeat, messages, formatter),
      formatter.day(nextAtMs),
      clock,
      formatLeadTime(lead, messages),
    ),
    isDistant: lead > DISTANT_FIRST_RING_MS,
    canAdd: true,
  };
}

/**
 * The label VoiceOver reads when focus lands on the stop control. It carries
 * the time and that the alarm is ringing, so it does not depend on a separate
 * announcement that the focus move would cut off. The stop control stops the
 * sound; it is not a wake-up confirmation.
 */
export function getRingingStopA11yLabel(
  hour: number,
  minute: number,
  { messages, formatter }: TextContext,
  dateLabel?: string,
): string {
  return messages.ringing.stopSpoken(
    formatter.clock(hour, minute),
    messages.ringing.stopLabel,
    dateLabel,
  );
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
  /** Replaces the repeat label in the row, e.g. "Today only (10/15) · Ended". */
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
  { messages, formatter }: TextContext,
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
  const date = formatter.day(
    new Date(year, month - 1, day, definition.hour, definition.minute).getTime(),
  );
  return {
    rowLabel: messages.repeat.todayOnlyEnded(date),
    a11yLabel: messages.repeat.todayOnlyEndedSpoken(date),
    explanation: messages.repeat.todayOnlyEndedExplanation,
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
