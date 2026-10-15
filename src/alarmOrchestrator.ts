import {
  CHECK_IN_KIND,
  CONFIRM_AWAKE_ACTION,
} from './alarmContracts';
import {
  canSuppressAlarm,
  finalizeSuppression,
  type SuppressionDecision,
} from './alarmPolicy';
import type { ErrorCode } from './errorCatalog';
import type { StoredAlarm } from './alarmStorage';
import { mergeWindowStepCount } from './stepWindow';

export interface AlarmSchedulingGateway {
  scheduleMain(input: {
    alarmId: string;
    cycleId: string;
    dueAtMs: number;
    /** False for a today-only alarm, which has no later occurrence. */
    repeats: boolean;
    /** Caller-chosen OS identifier (expo-notifications `identifier`). */
    identifier?: string;
  }): Promise<string>;
  scheduleCheckIn(input: {
    alarmId: string;
    cycleId: string;
    mainAlarmId: string;
    checkInAtMs: number;
    /** Caller-chosen OS identifier (expo-notifications `identifier`). */
    identifier?: string;
  }): Promise<string>;
}

export interface ScheduledAlarmNotifications {
  mainAlarmId: string;
  checkInNotificationId?: string;
  checkInAtMs: number;
  /** Set when the check-in could not be reserved; the main alarm is kept. */
  checkInErrorCode?: ErrorCode;
}

export async function scheduleAlarmNotificationsFailSafe(
  gateway: AlarmSchedulingGateway,
  input: {
    alarmId: string;
    cycleId: string;
    dueAtMs: number;
    checkInAtMs: number;
    repeats: boolean;
  },
): Promise<ScheduledAlarmNotifications> {
  const mainAlarmId = await gateway.scheduleMain({
    alarmId: input.alarmId,
    cycleId: input.cycleId,
    dueAtMs: input.dueAtMs,
    repeats: input.repeats,
  });

  try {
    const checkInNotificationId = await gateway.scheduleCheckIn({
      alarmId: input.alarmId,
      cycleId: input.cycleId,
      mainAlarmId,
      checkInAtMs: input.checkInAtMs,
    });

    return {
      mainAlarmId,
      checkInNotificationId,
      checkInAtMs: input.checkInAtMs,
    };
  } catch {
    // The cause is dropped on purpose: only the code reaches the UI.
    return {
      mainAlarmId,
      checkInAtMs: input.checkInAtMs,
      checkInErrorCode: 'CHECKIN_REGISTER_FAILED',
    };
  }
}

export interface AwakeResponseInput {
  actionIdentifier: string;
  kind: string | undefined;
  cycleId: string | undefined;
  mainAlarmId: string | undefined;
  checkInNotificationId: string;
  confirmedAtMs: number;
}

export interface AwakeResponseDependencies {
  loadAlarm(): Promise<StoredAlarm | null>;
  saveAlarm(alarm: StoredAlarm): Promise<void>;
  cancelScheduled(notificationId: string): Promise<boolean>;
  /** Fresh clock read, taken right before cancelling (after async loads). */
  nowMs?(): number;
  /** Durable intent record so a cancel-then-save failure can be recovered. */
  journal?: SuppressionJournal;
}

export interface SuppressionIntent {
  cycleId: string;
  alarmId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
  /** 'cancelled' only after the OS cancellation was positively confirmed. */
  stage: 'cancelling' | 'cancelled';
  /** The state to persist once suppression is confirmed. */
  suppressed: StoredAlarm;
}

export interface SuppressionJournal {
  record(intent: SuppressionIntent): Promise<void>;
  load(): Promise<SuppressionIntent[]>;
  clear(cycleId: string): Promise<void>;
  /**
   * Runs one stop or recovery to completion before the next begins. The lock
   * is in-process only; the persisted entries are what survives a restart.
   */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
}

export class SuppressionSaveError extends Error {
  readonly code = 'SUPPRESSION_SAVE_FAILED' as const;
  readonly cycleId: string;
  constructor(cycleId: string, readonly originalError: unknown) {
    super(
      '起床を確認し通知を取り消しましたが、状態を保存できませんでした。次回起動時に復旧します。',
    );
    this.name = 'SuppressionSaveError';
    this.cycleId = cycleId;
  }
}

/**
 * The cancellation call threw after the intent was recorded: the main
 * notification may or may not still be scheduled. The intent stays in the
 * journal as 'cancelling' and the app must not claim either outcome.
 */
export class SuppressionCancelUnknownError extends Error {
  readonly code = 'CANCEL_UNKNOWN' as const;
  readonly cycleId: string;
  constructor(cycleId: string, readonly originalError: unknown) {
    super(
      'アラームの取り消し結果を確認できませんでした。予約状態は未確認です。',
    );
    this.name = 'SuppressionCancelUnknownError';
    this.cycleId = cycleId;
  }
}

export type AwakeResponseResult =
  | { status: 'ignored'; reason: 'NOT_CONFIRM_ACTION' }
  | { status: 'alarm_remains'; reason: string }
  | { status: 'suppressed'; alarm: StoredAlarm };

export interface StepThresholdInput {
  steps: number;
  observedAtMs: number;
  /** Start of the step window the total was counted from. */
  countedFromMs: number;
}

async function cancelAndPersistSuppression(
  dependencies: AwakeResponseDependencies,
  activeAlarm: StoredAlarm,
  decision: SuppressionDecision,
  suppressed: StoredAlarm,
): Promise<AwakeResponseResult> {
  // The async load above may have been slow; never rely on the evidence time.
  const nowMs = (dependencies.nowMs ?? Date.now)();
  if (!Number.isFinite(nowMs) || nowMs >= activeAlarm.dueAtMs) {
    return { status: 'alarm_remains', reason: 'ALARM_DUE_OR_PAST' };
  }

  const journal = dependencies.journal;
  const intent: SuppressionIntent = {
    cycleId: activeAlarm.cycleId,
    alarmId: activeAlarm.alarmId,
    mainAlarmId: activeAlarm.mainAlarmId,
    checkInNotificationId: activeAlarm.checkInNotificationId,
    armedAtMs: activeAlarm.armedAtMs,
    dueAtMs: activeAlarm.dueAtMs,
    stage: 'cancelling',
    suppressed,
  };
  if (journal) {
    try {
      // An earlier attempt for this cycle may be half done. Recording again
      // would overwrite its stage and lose the evidence recovery relies on.
      const existing = await journal.load();
      if (existing.some((entry) => entry.cycleId === intent.cycleId)) {
        return { status: 'alarm_remains', reason: 'SUPPRESSION_PENDING' };
      }
      await journal.record(intent);
    } catch {
      return { status: 'alarm_remains', reason: 'JOURNAL_NOT_WRITTEN' };
    }

    // The journal write awaited storage; look at the clock again so a slow
    // write can never cancel an alarm that has come due in the meantime.
    const freshNowMs = (dependencies.nowMs ?? Date.now)();
    if (!Number.isFinite(freshNowMs) || freshNowMs >= activeAlarm.dueAtMs) {
      await journal.clear(activeAlarm.cycleId).catch(() => undefined);
      return { status: 'alarm_remains', reason: 'ALARM_DUE_OR_PAST' };
    }
  }

  let cancellationSucceeded: boolean;
  try {
    cancellationSucceeded = await dependencies.cancelScheduled(
      activeAlarm.mainAlarmId,
    );
  } catch (error) {
    // The intent stays recorded as 'cancelling': the outcome is unknown.
    throw journal
      ? new SuppressionCancelUnknownError(activeAlarm.cycleId, error)
      : error;
  }
  if (
    finalizeSuppression(decision, cancellationSucceeded) !== 'SUPPRESSED'
  ) {
    await journal?.clear(activeAlarm.cycleId).catch(() => undefined);
    return { status: 'alarm_remains', reason: 'CANCEL_NOT_VERIFIED' };
  }

  await journal
    ?.record({ ...intent, stage: 'cancelled' })
    .catch(() => undefined);

  let saveError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await dependencies.saveAlarm(suppressed);
      await journal?.clear(activeAlarm.cycleId).catch(() => undefined);
      return { status: 'suppressed', alarm: suppressed };
    } catch (error) {
      saveError = error;
    }
  }
  throw new SuppressionSaveError(activeAlarm.cycleId, saveError);
}

export interface SuppressionRecoveryDependencies {
  saveAlarm(alarm: StoredAlarm): Promise<void>;
  journal: SuppressionJournal;
  /** Identifiers of notifications currently scheduled with the OS. */
  listScheduledIds(): Promise<ReadonlySet<string>>;
  nowMs?(): number;
}

export interface SuppressionRecoveryOutcome {
  /** Cycles restored to 'suppressed' from a confirmed cancellation. */
  recovered: SuppressionIntent[];
  /**
   * Cancellations whose result is unknown: the main notification is no longer
   * scheduled but was never confirmed cancelled. Kept in the journal; the app
   * must not claim the alarm is armed or stopped.
   */
  unresolved: SuppressionIntent[];
  /** Confirmed cancellations that could not be saved yet. Kept for retry. */
  saveFailed: SuppressionIntent[];
}

function matchesIntent(
  current: StoredAlarm | null,
  intent: SuppressionIntent,
): current is StoredAlarm {
  return (
    !!current &&
    (current.phase === 'armed' || current.phase === 'step_candidate') &&
    current.alarmId === intent.alarmId &&
    current.mainAlarmId === intent.mainAlarmId &&
    current.checkInNotificationId === intent.checkInNotificationId &&
    current.dueAtMs === intent.dueAtMs &&
    current.armedAtMs === intent.armedAtMs
  );
}

/**
 * Settles suppressions left over from a crash or a failed save. Only exact
 * id/due matches are touched and nothing is ever cancelled here.
 *  - 'cancelled' (cancellation confirmed): the suppressed state is saved.
 *  - 'cancelling' (result unknown): the record is kept. If the OS still has
 *    the main notification the cancel never happened and the alarm is simply
 *    armed; if it is gone we cannot tell cancelled from fired, so the intent
 *    is reported as unresolved. Absence from the OS never implies suppressed.
 */
export function recoverSuppressionJournal(
  dependencies: SuppressionRecoveryDependencies,
  loadByCycleId: (cycleId: string) => Promise<StoredAlarm | null>,
): Promise<SuppressionRecoveryOutcome> {
  // Waits for any live stop so it cannot clear or misjudge its record.
  return dependencies.journal.exclusive(() =>
    recoverUnderLock(dependencies, loadByCycleId),
  );
}

async function recoverUnderLock(
  dependencies: SuppressionRecoveryDependencies,
  loadByCycleId: (cycleId: string) => Promise<StoredAlarm | null>,
): Promise<SuppressionRecoveryOutcome> {
  const outcome: SuppressionRecoveryOutcome = {
    recovered: [],
    unresolved: [],
    saveFailed: [],
  };
  const { journal } = dependencies;

  for (const intent of await journal.load()) {
    try {
      const current = await loadByCycleId(intent.cycleId);
      if (!matchesIntent(current, intent)) {
        // The cycle has moved on (suppressed, dismissed, replaced, gone).
        await journal.clear(intent.cycleId);
        continue;
      }

      if (intent.stage === 'cancelled') {
        try {
          await dependencies.saveAlarm(intent.suppressed);
        } catch {
          outcome.saveFailed.push(intent);
          continue;
        }
        await journal.clear(intent.cycleId);
        outcome.recovered.push(intent);
        continue;
      }

      const nowMs = (dependencies.nowMs ?? Date.now)();
      if (!Number.isFinite(nowMs) || nowMs >= intent.dueAtMs) {
        // Due time passed: the ring path (or the OS) now decides.
        await journal.clear(intent.cycleId);
        continue;
      }

      const scheduled = await dependencies.listScheduledIds();
      if (scheduled.has(intent.mainAlarmId)) {
        // Still scheduled: the cancel never took effect.
        await journal.clear(intent.cycleId);
        continue;
      }
      outcome.unresolved.push(intent);
    } catch {
      // Could not inspect it: keep the record and say so.
      outcome.unresolved.push(intent);
    }
  }
  return outcome;
}

function exclusively<T>(
  dependencies: AwakeResponseDependencies,
  run: () => Promise<T>,
): Promise<T> {
  // Load, journal and cancel form one critical section per process.
  return dependencies.journal ? dependencies.journal.exclusive(run) : run();
}

export function processAwakeResponseFailSafe(
  dependencies: AwakeResponseDependencies,
  input: AwakeResponseInput,
): Promise<AwakeResponseResult> {
  return exclusively(dependencies, () => awakeResponse(dependencies, input));
}

async function awakeResponse(
  dependencies: AwakeResponseDependencies,
  input: AwakeResponseInput,
): Promise<AwakeResponseResult> {
  if (input.actionIdentifier !== CONFIRM_AWAKE_ACTION) {
    return { status: 'ignored', reason: 'NOT_CONFIRM_ACTION' };
  }

  if (
    input.kind !== CHECK_IN_KIND ||
    typeof input.cycleId !== 'string' ||
    typeof input.mainAlarmId !== 'string'
  ) {
    return { status: 'alarm_remains', reason: 'INVALID_RESPONSE' };
  }

  const activeAlarm = await dependencies.loadAlarm();
  if (
    !activeAlarm ||
    (activeAlarm.phase !== 'armed' &&
      activeAlarm.phase !== 'step_candidate') ||
    typeof activeAlarm.checkInNotificationId !== 'string'
  ) {
    return { status: 'alarm_remains', reason: 'NO_ACTIVE_ALARM' };
  }

  const decision = canSuppressAlarm(
    {
      cycleId: activeAlarm.cycleId,
      mainAlarmId: activeAlarm.mainAlarmId,
      checkInNotificationId: activeAlarm.checkInNotificationId,
      armedAtMs: activeAlarm.armedAtMs,
      dueAtMs: activeAlarm.dueAtMs,
    },
    {
      kind: 'EXPLICIT_AWAKE_CONFIRMATION',
      cycleId: input.cycleId,
      mainAlarmId: input.mainAlarmId,
      checkInNotificationId: input.checkInNotificationId,
      confirmedAtMs: input.confirmedAtMs,
    },
    input.confirmedAtMs,
  );

  if (!decision.canSuppress) {
    return { status: 'alarm_remains', reason: decision.reason };
  }

  const suppressed: StoredAlarm = {
    ...activeAlarm,
    phase: 'suppressed',
    confirmedAtMs: input.confirmedAtMs,
  };
  return cancelAndPersistSuppression(
    dependencies,
    activeAlarm,
    decision,
    suppressed,
  );
}

export interface UserSkipInput {
  cycleId: string;
  mainAlarmId: string;
  /** The due time of the occurrence the user was shown. */
  dueAtMs: number;
}

export function processUserSkipFailSafe(
  dependencies: AwakeResponseDependencies,
  input: UserSkipInput,
): Promise<AwakeResponseResult> {
  return exclusively(dependencies, () => userSkip(dependencies, input));
}

async function userSkip(
  dependencies: AwakeResponseDependencies,
  input: UserSkipInput,
): Promise<AwakeResponseResult> {
  const activeAlarm = await dependencies.loadAlarm();
  if (!activeAlarm) {
    return { status: 'alarm_remains', reason: 'NO_ACTIVE_ALARM' };
  }
  if (
    activeAlarm.phase === 'suppressed' &&
    activeAlarm.suppressedBy === 'user_skip' &&
    activeAlarm.cycleId === input.cycleId &&
    activeAlarm.mainAlarmId === input.mainAlarmId &&
    activeAlarm.dueAtMs === input.dueAtMs
  ) {
    // A duplicate request for the same skipped occurrence changes nothing.
    return { status: 'suppressed', alarm: activeAlarm };
  }
  if (activeAlarm.phase !== 'armed' && activeAlarm.phase !== 'step_candidate') {
    return { status: 'alarm_remains', reason: 'NO_ACTIVE_ALARM' };
  }

  // Fresh clock read: the load above may have been slow.
  const nowMs = (dependencies.nowMs ?? Date.now)();
  const decision = canSuppressAlarm(
    {
      cycleId: activeAlarm.cycleId,
      mainAlarmId: activeAlarm.mainAlarmId,
      checkInNotificationId: activeAlarm.checkInNotificationId,
      armedAtMs: activeAlarm.armedAtMs,
      dueAtMs: activeAlarm.dueAtMs,
    },
    {
      kind: 'USER_SKIP_THIS_OCCURRENCE',
      cycleId: input.cycleId,
      mainAlarmId: input.mainAlarmId,
      dueAtMs: input.dueAtMs,
      requestedAtMs: nowMs,
    },
    nowMs,
  );
  if (!decision.canSuppress) {
    return { status: 'alarm_remains', reason: decision.reason };
  }

  // Steps, check-in identity and confirmedAtMs are deliberately untouched.
  const suppressed: StoredAlarm = {
    ...activeAlarm,
    phase: 'suppressed',
    suppressedBy: 'user_skip',
    skippedAtMs: nowMs,
  };
  return cancelAndPersistSuppression(
    dependencies,
    activeAlarm,
    decision,
    suppressed,
  );
}

export function processStepThresholdFailSafe(
  dependencies: AwakeResponseDependencies,
  input: StepThresholdInput,
): Promise<AwakeResponseResult> {
  return exclusively(dependencies, () => stepThreshold(dependencies, input));
}

async function stepThreshold(
  dependencies: AwakeResponseDependencies,
  input: StepThresholdInput,
): Promise<AwakeResponseResult> {
  const activeAlarm = await dependencies.loadAlarm();
  if (
    !activeAlarm ||
    (activeAlarm.phase !== 'armed' && activeAlarm.phase !== 'step_candidate')
  ) {
    return { status: 'alarm_remains', reason: 'NO_ACTIVE_ALARM' };
  }

  const decision = canSuppressAlarm(
    {
      cycleId: activeAlarm.cycleId,
      mainAlarmId: activeAlarm.mainAlarmId,
      checkInNotificationId: activeAlarm.checkInNotificationId,
      armedAtMs: activeAlarm.armedAtMs,
      dueAtMs: activeAlarm.dueAtMs,
      // Rejects steps another suppression already used, even after that
      // suppressed cycle has been pruned from storage.
      stepCountFromMs: activeAlarm.stepCountFromMs,
    },
    {
      kind: 'STEP_THRESHOLD_REACHED',
      steps: input.steps,
      observedAtMs: input.observedAtMs,
      countedFromMs: input.countedFromMs,
    },
    input.observedAtMs,
  );

  if (!decision.canSuppress) {
    return { status: 'alarm_remains', reason: decision.reason };
  }

  const suppressed: StoredAlarm = {
    ...activeAlarm,
    phase: 'suppressed',
    ...mergeWindowStepCount(activeAlarm, input.steps, input.countedFromMs),
    stepCandidateRecorded: true,
    stepCandidateAtMs: input.observedAtMs,
    confirmedAtMs: input.observedAtMs,
  };
  return cancelAndPersistSuppression(
    dependencies,
    activeAlarm,
    decision,
    suppressed,
  );
}
