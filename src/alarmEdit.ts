import type { AlarmSchedulingGateway } from './alarmOrchestrator';
import { MIN_ARM_LEAD_MS, getCheckInAtMs } from './alarmPolicy';
import {
  getUpcomingAlarmTimes,
  isAlarmRepeat,
  type AlarmRepeat,
} from './alarmSchedule';
import type { AlarmScheduleIssue } from './alarmScheduling';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import { findAlarmListLock } from './homeStatus';
import { readOccurrenceIdentity, stampOccurrence } from './occurrenceIdentity';
import { currentPlanningZone } from './planningZone';

export const MAX_PENDING_NOTIFICATIONS = 64;

export type PendingAlarmEditStage = 'scheduling' | 'replacing';

export interface PendingAlarmEdit {
  alarmId: string;
  stage: PendingAlarmEditStage;
  requestedAtMs: number;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
  oldNotificationIds: string[];
  newNotificationIds: string[];
  newCycles: StoredAlarm[];
}

export interface AlarmEditJournal {
  load(): Promise<PendingAlarmEdit[]>;
  save(entry: PendingAlarmEdit): Promise<void>;
  remove(alarmId: string): Promise<void>;
}

export interface AlarmEditGateway extends AlarmSchedulingGateway {
  cancelScheduled(notificationId: string): Promise<void>;
  listScheduledIds(): Promise<ReadonlySet<string>>;
}

export type AlarmEditErrorCode =
  | 'not_found'
  | 'locked'
  | 'deadline'
  | 'unsettled'
  | 'invalid_time'
  | 'capacity'
  | 'journal_failed'
  | 'schedule_failed'
  | 'cancel_failed'
  | 'save_failed'
  | 'rollback_incomplete';

export class AlarmEditError extends Error {
  constructor(
    readonly code: AlarmEditErrorCode,
    message: string,
    readonly rolledBack: boolean,
  ) {
    super(message);
    this.name = 'AlarmEditError';
  }
}

export interface AlarmEditInput {
  alarms: StoredAlarmDefinition[];
  alarmId: string;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
  /**
   * Fresh clock. Read after the caller holds its locks, and again before every
   * step that cannot be undone, so a long wait never leaves a stale deadline.
   */
  now(): number;
  gateway: AlarmEditGateway;
  journal: AlarmEditJournal;
  checkpoint(alarms: StoredAlarmDefinition[]): Promise<void>;
  hasUnsettledWork(alarmId: string, cycleIds: string[]): Promise<boolean>;
  makeCycleId?: () => string;
  /** Zone the replacement occurrences are planned in; defaults to this device's. */
  planningZone?: string;
}

export interface AlarmEditResult {
  alarms: StoredAlarmDefinition[];
  issues: AlarmScheduleIssue[];
  cleanupPending: boolean;
}

export { resolveEditedRepeat } from './alarmSchedule';

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && id.length > 0)
  );
}

export function isPendingAlarmEdit(value: unknown): value is PendingAlarmEdit {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<PendingAlarmEdit>;
  return (
    typeof entry.alarmId === 'string' &&
    entry.alarmId.length > 0 &&
    (entry.stage === 'scheduling' || entry.stage === 'replacing') &&
    typeof entry.requestedAtMs === 'number' &&
    Number.isFinite(entry.requestedAtMs) &&
    Number.isInteger(entry.hour) &&
    entry.hour! >= 0 &&
    entry.hour! <= 23 &&
    Number.isInteger(entry.minute) &&
    entry.minute! >= 0 &&
    entry.minute! <= 59 &&
    isAlarmRepeat(entry.repeat) &&
    isIdList(entry.oldNotificationIds) &&
    isIdList(entry.newNotificationIds) &&
    Array.isArray(entry.newCycles) &&
    entry.newCycles.every(
      (cycle) =>
        !!cycle &&
        typeof cycle === 'object' &&
        cycle.alarmId === entry.alarmId &&
        typeof cycle.cycleId === 'string' &&
        typeof cycle.mainAlarmId === 'string' &&
        typeof cycle.dueAtMs === 'number' &&
        Number.isFinite(cycle.dueAtMs),
    )
  );
}

interface OwnedNotification {
  id: string;
  kind: 'main' | 'checkin';
  cycle: StoredAlarm;
}

/**
 * The old schedule's notifications. Mains come first: the replacement mains are
 * already scheduled, so a failed main cancellation can still be undone cleanly,
 * while check-ins are only given up once every old main is gone.
 */
function ownedNotifications(
  cycles: readonly StoredAlarm[],
  nowMs: number,
): OwnedNotification[] {
  const mains: OwnedNotification[] = [];
  const checkIns: OwnedNotification[] = [];
  for (const cycle of [...cycles].sort((a, b) => a.dueAtMs - b.dueAtMs)) {
    if (cycle.dueAtMs <= nowMs) {
      continue;
    }
    mains.push({ id: cycle.mainAlarmId, kind: 'main', cycle });
    if (cycle.checkInNotificationId) {
      checkIns.push({ id: cycle.checkInNotificationId, kind: 'checkin', cycle });
    }
  }
  const seen = new Set<string>();
  return [...mains, ...checkIns].filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

/** A cycle whose deadline has been reached and that still has live data. */
function isDueLive(cycle: StoredAlarm, nowMs: number): boolean {
  return (
    (cycle.phase === 'armed' ||
      cycle.phase === 'step_candidate' ||
      cycle.phase === 'ringing' ||
      // Its snooze notification is still pending: the data must stay.
      cycle.phase === 'snoozed') &&
    cycle.dueAtMs <= nowMs
  );
}

function withoutCheckIn(cycle: StoredAlarm): StoredAlarm {
  const { checkInNotificationId: _removed, ...rest } = cycle;
  return rest;
}

/**
 * A journaled cycle's occurrence metadata is advisory: a half-written or
 * malformed pair is dropped (the cycle becomes legacy), never repaired.
 */
function withTrustedOccurrenceMetadata(cycle: StoredAlarm): StoredAlarm {
  if (cycle.logicalDateKey === undefined && cycle.planningZone === undefined) {
    return cycle;
  }
  if (readOccurrenceIdentity(cycle)) {
    return cycle;
  }
  const { logicalDateKey: _date, planningZone: _zone, ...rest } = cycle;
  return rest;
}

function replaceDefinition(
  alarms: StoredAlarmDefinition[],
  next: StoredAlarmDefinition,
): StoredAlarmDefinition[] {
  return alarms.map((alarm) => (alarm.id === next.id ? next : alarm));
}

/** Best-effort write: a stale journal entry is only ever cancelled again. */
async function tryJournal(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // Cancelling an already-cancelled id is a no-op, so a stale record is safe.
  }
}

async function cancelAll(
  ids: readonly string[],
  gateway: Pick<AlarmEditGateway, 'cancelScheduled'>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await gateway.cancelScheduled(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

/**
 * Cancels the replacement notifications after a failed edit. Whatever cannot be
 * confirmed cancelled stays journaled so the next launch retries it.
 */
async function rollbackReplacement(
  entry: PendingAlarmEdit,
  ids: readonly string[],
  journal: AlarmEditJournal,
  gateway: Pick<AlarmEditGateway, 'cancelScheduled'>,
): Promise<void> {
  const failed = await cancelAll(ids, gateway);
  if (failed.length === 0) {
    await tryJournal(() => journal.remove(entry.alarmId));
    return;
  }
  await tryJournal(() =>
    journal.save({
      ...entry,
      stage: 'scheduling',
      newNotificationIds: failed,
      newCycles: [],
    }),
  );
  throw new AlarmEditError(
    'rollback_incomplete',
    '編集を中止しましたが、新しい通知の一部を解除できませんでした。次回起動時に再試行します。端末の通知一覧を確認してください。',
    false,
  );
}

export async function editAlarmDefinition(
  input: AlarmEditInput,
): Promise<AlarmEditResult> {
  const { alarms, alarmId, hour, minute, repeat, gateway, journal, now } = input;
  const startMs = now();
  // Captured before any await: the stamp must describe the zone the plan was
  // computed in, even if the device zone changes while scheduling.
  const planningZone = input.planningZone ?? currentPlanningZone();
  const target = alarms.find((alarm) => alarm.id === alarmId);
  if (!target) {
    throw new AlarmEditError(
      'not_found',
      '対象のアラームが見つかりません。',
      true,
    );
  }
  const lock = findAlarmListLock(alarms, startMs);
  if (lock) {
    throw new AlarmEditError(
      'locked',
      lock === 'snoozed'
        ? 'スヌーズ中は編集できません。先にアラームを止めてください。'
        : 'アラームが鳴っている間は編集できません。',
      true,
    );
  }
  const cycleIds = target.cycles.map((cycle) => cycle.cycleId);
  // A snooze attempt a restart interrupted may still own a notification the
  // edit would not release; recovery settles it first, an edit never guesses.
  if (target.cycles.some((cycle) => cycle.snooze?.pending !== undefined)) {
    throw new AlarmEditError(
      'unsettled',
      'このアラームのスヌーズの処理が完了していません。アプリを開き直してから編集してください。',
      true,
    );
  }
  const hasEarlierEdit = (await journal.load()).some(
    (entry) => entry.alarmId === alarmId,
  );
  if (hasEarlierEdit || (await input.hasUnsettledWork(alarmId, cycleIds))) {
    throw new AlarmEditError(
      'unsettled',
      'このアラームの前回の処理が完了していません。アプリを開き直してから編集してください。',
      true,
    );
  }
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    !isAlarmRepeat(repeat)
  ) {
    throw new AlarmEditError(
      'invalid_time',
      '有効なアラーム時刻を選択してください。',
      true,
    );
  }

  if (!target.enabled) {
    // Nothing is scheduled for an off alarm; only its definition changes.
    const next = replaceDefinition(alarms, {
      ...target,
      hour,
      minute,
      repeat,
      cycles: [],
    });
    await input.checkpoint(next);
    return { alarms: next, issues: [], cleanupPending: false };
  }

  const dueTimes = getUpcomingAlarmTimes(startMs, hour, minute, repeat);
  if (dueTimes.length === 0 || dueTimes[0] - startMs < MIN_ARM_LEAD_MS) {
    throw new AlarmEditError(
      'invalid_time',
      repeat.kind === 'today'
        ? '「今日だけ」は現在より後の時刻を選択してください。'
        : '次回のアラーム時刻を計算できません。',
      true,
    );
  }

  // Only the replacement mains are staged before the old schedule is released;
  // the optional check-ins wait until the old notifications have freed slots.
  // The count includes notifications this app does not own.
  const pendingCount = (await gateway.listScheduledIds()).size;
  if (pendingCount + dueTimes.length > MAX_PENDING_NOTIFICATIONS) {
    throw new AlarmEditError(
      'capacity',
      `予約できる通知の数（${MAX_PENDING_NOTIFICATIONS}件）に空きがないため編集できません。このアラームは変更していません。他のアラームを減らしてからやり直してください。`,
      true,
    );
  }

  // Ids are chosen here so they can be journaled before the OS creates them.
  const plan = dueTimes.map((dueAtMs) => {
    const cycleId = (input.makeCycleId ?? defaultCycleId)();
    return {
      cycleId,
      dueAtMs,
      mainId: `${cycleId}-main`,
      checkInId: `${cycleId}-checkin`,
    };
  });
  const owned = ownedNotifications(target.cycles, startMs);
  let entry: PendingAlarmEdit = {
    alarmId,
    stage: 'scheduling',
    requestedAtMs: startMs,
    hour,
    minute,
    repeat,
    oldNotificationIds: owned.map((item) => item.id),
    newNotificationIds: [],
    newCycles: [],
  };
  try {
    await journal.save(entry);
  } catch {
    throw new AlarmEditError(
      'journal_failed',
      '編集の記録を保存できませんでした。このアラームは変更していません。',
      true,
    );
  }

  const newIds: string[] = [];
  const abort = async (error: AlarmEditError): Promise<never> => {
    await rollbackReplacement(entry, newIds, journal, gateway);
    throw error;
  };
  const journalFailed = () =>
    new AlarmEditError(
      'journal_failed',
      '編集の記録を保存できませんでした。このアラームは変更していません。',
      true,
    );

  const mainIds: string[] = [];
  let mainFailure: string | undefined;
  for (const planned of plan) {
    newIds.push(planned.mainId);
    entry = { ...entry, newNotificationIds: [...newIds] };
    try {
      await journal.save(entry);
    } catch {
      return abort(journalFailed());
    }
    try {
      const id = await gateway.scheduleMain({
        alarmId,
        cycleId: planned.cycleId,
        dueAtMs: planned.dueAtMs,
        repeats: repeat.kind !== 'today',
        identifier: planned.mainId,
      });
      if (id !== planned.mainId) {
        // The OS did not honour the requested id: track the real one too.
        newIds.push(id);
        entry = { ...entry, newNotificationIds: [...newIds] };
        await tryJournal(() => journal.save(entry));
      }
      mainIds.push(id);
    } catch (error) {
      mainFailure =
        error instanceof Error
          ? error.message
          : 'メインのアラーム通知を予約できませんでした。';
      break;
    }
  }
  if (mainFailure !== undefined) {
    return abort(
      new AlarmEditError(
        'schedule_failed',
        `${mainFailure} このアラームは変更していません。`,
        true,
      ),
    );
  }

  // Scheduling took time: re-check both deadlines before anything old is
  // touched. The old schedule is still whole, so aborting is a true rollback.
  const afterScheduling = now();
  if (target.cycles.some((cycle) => isDueLive(cycle, afterScheduling))) {
    return abort(
      new AlarmEditError(
        'deadline',
        '編集中にアラームの時刻になったため、編集を中止しました。このアラームは変更していません。',
        true,
      ),
    );
  }
  if (plan[0].dueAtMs - afterScheduling < MIN_ARM_LEAD_MS) {
    return abort(
      new AlarmEditError(
        'invalid_time',
        '編集中に次回のアラーム時刻が近づきすぎたため、編集を中止しました。このアラームは変更していません。',
        true,
      ),
    );
  }

  const newCycles: StoredAlarm[] = plan.map((planned, index) => ({
    alarmId,
    cycleId: planned.cycleId,
    mainAlarmId: mainIds[index],
    checkInNotificationId: planned.checkInId,
    armedAtMs: startMs,
    dueAtMs: planned.dueAtMs,
    phase: 'armed',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...stampOccurrence(planned.dueAtMs, planningZone),
  }));
  entry = {
    ...entry,
    stage: 'replacing',
    newNotificationIds: [...newIds, ...plan.map((planned) => planned.checkInId)],
    newCycles,
  };
  try {
    await journal.save(entry);
  } catch {
    return abort(journalFailed());
  }

  let cleanupPending = false;
  let released = false;
  const cancelledMains = new Set<string>();
  // Old mains the OS may still hold: their cycles stay tracked until a later
  // recovery confirms the cancellation, even before they are due.
  const uncancelledMains = new Set<string>();
  const cancelledCheckIns = new Set<string>();
  for (const item of owned) {
    const ownerCancelled = cancelledMains.has(item.cycle.cycleId);
    if (!ownerCancelled && isDueLive(item.cycle, now())) {
      if (!released) {
        return abort(
          new AlarmEditError(
            'deadline',
            '編集中にアラームの時刻になったため、編集を中止しました。このアラームは変更していません。',
            true,
          ),
        );
      }
      // Its time has come: leave the notification and the cycle alone. Its ids
      // stay journaled until the definition that tracks it is checkpointed, so
      // a crash before then still lets recovery find and keep the cycle.
      continue;
    }
    try {
      await gateway.cancelScheduled(item.id);
    } catch {
      if (!(await isNoLongerScheduled(gateway, item.id))) {
        if (!released) {
          // Nothing old has been touched yet: undo the replacement.
          return abort(
            new AlarmEditError(
              'cancel_failed',
              '古い通知の解除を確認できなかったため編集を中止しました。このアラームは変更していません。',
              true,
            ),
          );
        }
        // The replacement is fully scheduled: finish forward and keep the
        // leftovers journaled for the next launch.
        cleanupPending = true;
        if (item.kind === 'main') {
          uncancelledMains.add(item.cycle.cycleId);
        }
        continue;
      }
    }
    released = true;
    if (item.kind === 'main') {
      cancelledMains.add(item.cycle.cycleId);
    } else {
      cancelledCheckIns.add(item.id);
    }
    entry = {
      ...entry,
      oldNotificationIds: entry.oldNotificationIds.filter(
        (remaining) => remaining !== item.id,
      ),
    };
    await tryJournal(() => journal.save(entry));
  }

  // Old slots are free again: add the optional check-ins, never at the cost of
  // a main alarm.
  const issues: AlarmScheduleIssue[] = [];
  let pending: number | null = null;
  try {
    pending = (await gateway.listScheduledIds()).size;
  } catch {
    // Queue size unknown: optional check-ins are skipped below.
  }
  const finalCycles: StoredAlarm[] = [];
  for (const [index, planned] of plan.entries()) {
    const base = newCycles[index];
    const fail = async (message: string): Promise<void> => {
      await cancelAll([planned.checkInId], gateway);
      issues.push({
        kind: 'check_in_schedule_failed',
        alarmId,
        cycleId: planned.cycleId,
        dueAtMs: planned.dueAtMs,
        mainAlarmId: base.mainAlarmId,
        message,
      });
      finalCycles.push(withoutCheckIn(base));
    };
    if (pending === null) {
      await fail(
        '通知の空き数を確認できないため、起床確認通知の予約を見送りました。',
      );
      continue;
    }
    if (pending + 1 > MAX_PENDING_NOTIFICATIONS) {
      await fail('通知の空きが足りないため、起床確認通知を予約できませんでした。');
      continue;
    }
    // Earlier steps took time: never schedule a check-in in the past.
    const checkInNow = now();
    // Same arm time as the persisted cycle, so reconciliation expects this id
    // at exactly this trigger time.
    const checkInAtMs = getCheckInAtMs(planned.dueAtMs, base.armedAtMs);
    if (checkInAtMs <= checkInNow) {
      finalCycles.push(withoutCheckIn(base));
      continue;
    }
    try {
      const checkInId = await gateway.scheduleCheckIn({
        alarmId,
        cycleId: planned.cycleId,
        mainAlarmId: base.mainAlarmId,
        checkInAtMs,
        identifier: planned.checkInId,
      });
      pending += 1;
      finalCycles.push({ ...base, checkInNotificationId: checkInId });
    } catch (error) {
      await fail(
        error instanceof Error
          ? error.message
          : '起床確認通知を予約できませんでした。',
      );
    }
  }

  // An old cycle whose time came while the edit ran, or whose main could not
  // be confirmed cancelled, keeps its data and notification: it may still ring
  // and must stay tracked.
  const finalMs = now();
  const kept = target.cycles
    .filter(
      (cycle) =>
        !cancelledMains.has(cycle.cycleId) &&
        (uncancelledMains.has(cycle.cycleId) || isDueLive(cycle, finalMs)),
    )
    .map((cycle) =>
      cycle.checkInNotificationId &&
      cancelledCheckIns.has(cycle.checkInNotificationId)
        ? withoutCheckIn(cycle)
        : cycle,
    );
  const next = replaceDefinition(alarms, {
    ...target,
    hour,
    minute,
    repeat,
    enabled: true,
    cycles: [...kept, ...finalCycles].sort(
      (left, right) => left.dueAtMs - right.dueAtMs,
    ),
  });
  let saveError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await input.checkpoint(next);
      saveError = undefined;
      break;
    } catch (error) {
      saveError = error;
    }
  }
  if (saveError !== undefined) {
    throw new AlarmEditError(
      'save_failed',
      '新しい通知は予約しましたが、アラーム設定を保存できませんでした。次回起動時に編集を完了します。',
      false,
    );
  }
  if (!cleanupPending) {
    await tryJournal(() => journal.remove(alarmId));
  }
  return { alarms: next, issues, cleanupPending };
}

/** True only when the OS list was readable and no longer holds the id. */
async function isNoLongerScheduled(
  gateway: Pick<AlarmEditGateway, 'listScheduledIds'>,
  id: string,
): Promise<boolean> {
  try {
    return !(await gateway.listScheduledIds()).has(id);
  } catch {
    return false;
  }
}

function defaultCycleId(): string {
  return `cycle-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Settles an edit that a crash or failure left half done. Only the ids the
 * journal recorded for this alarm are ever cancelled.
 *  - scheduling: the old alarm was never touched; drop the partial replacement.
 *  - replacing: the replacement is complete; apply it and release what remains
 *    of the old schedule.
 */
export async function recoverPendingAlarmEdit(input: {
  alarms: StoredAlarmDefinition[];
  entry: PendingAlarmEdit;
  gateway: Pick<AlarmEditGateway, 'cancelScheduled'> &
    Partial<Pick<AlarmEditGateway, 'listScheduledIds'>>;
  journal: AlarmEditJournal;
  checkpoint(alarms: StoredAlarmDefinition[]): Promise<void>;
  now?: () => number;
}): Promise<StoredAlarmDefinition[]> {
  const { entry, gateway, journal } = input;
  const target = input.alarms.find((alarm) => alarm.id === entry.alarmId);

  if (entry.stage === 'scheduling' || !target) {
    const failed = await cancelAll(
      [...entry.newNotificationIds, ...(target ? [] : entry.oldNotificationIds)],
      gateway,
    );
    if (failed.length > 0) {
      await tryJournal(() =>
        journal.save({ ...entry, newNotificationIds: failed }),
      );
      throw new AlarmEditError(
        'rollback_incomplete',
        '前回の編集で予約した通知の一部を解除できませんでした。',
        false,
      );
    }
    await journal.remove(entry.alarmId);
    return input.alarms;
  }

  const nowFn = input.now ?? Date.now;
  const journaledCycles = entry.newCycles.map(withTrustedOccurrenceMetadata);
  const newCycleIds = new Set(journaledCycles.map((cycle) => cycle.cycleId));
  // Old cycles whose main was never cancelled stay tracked; those that come due
  // before their cancellation keep their data and their notifications.
  const pendingOld = target.cycles.filter(
    (cycle) =>
      !newCycleIds.has(cycle.cycleId) &&
      entry.oldNotificationIds.includes(cycle.mainAlarmId),
  );

  let alarms = input.alarms;
  const applied = journaledCycles.every((cycle) =>
    target.cycles.some((existing) => existing.cycleId === cycle.cycleId),
  );
  if (!applied) {
    let newCycles = journaledCycles;
    if (gateway.listScheduledIds) {
      try {
        const scheduled = await gateway.listScheduledIds();
        newCycles = newCycles.map((cycle) =>
          cycle.checkInNotificationId &&
          !scheduled.has(cycle.checkInNotificationId)
            ? withoutCheckIn(cycle)
            : cycle,
        );
      } catch {
        // Keep the journaled ids; cancelling a missing one is a no-op.
      }
    }
    alarms = replaceDefinition(alarms, {
      ...target,
      hour: entry.hour,
      minute: entry.minute,
      repeat: entry.repeat,
      enabled: true,
      // Not-yet-cancelled old mains stay tracked until cancellation is proven.
      cycles: [...pendingOld, ...newCycles].sort(
        (left, right) => left.dueAtMs - right.dueAtMs,
      ),
    });
    await input.checkpoint(alarms);
  }

  const cycleByNotificationId = new Map<string, StoredAlarm>();
  for (const cycle of pendingOld) {
    cycleByNotificationId.set(cycle.mainAlarmId, cycle);
    if (cycle.checkInNotificationId) {
      cycleByNotificationId.set(cycle.checkInNotificationId, cycle);
    }
  }
  // The clock is read again right before each cancellation: a cycle that came
  // due during the earlier awaits must keep its notification and its data.
  const protectedIds = new Set<string>();
  const cancelledOldMains = new Set<string>();
  const failed: string[] = [];
  for (const id of entry.oldNotificationIds) {
    const owner = cycleByNotificationId.get(id);
    if (
      owner &&
      !cancelledOldMains.has(owner.cycleId) &&
      isDueLive(owner, nowFn())
    ) {
      protectedIds.add(id);
      continue;
    }
    try {
      await gateway.cancelScheduled(id);
      if (owner && id === owner.mainAlarmId) {
        cancelledOldMains.add(owner.cycleId);
      }
    } catch {
      failed.push(id);
    }
  }
  // Drop old cycles whose main is now proven cancelled; keep the rest tracked.
  const stale = pendingOld.filter(
    (cycle) =>
      !protectedIds.has(cycle.mainAlarmId) &&
      !failed.includes(cycle.mainAlarmId) &&
      alarms.some(
        (alarm) =>
          alarm.id === target.id &&
          alarm.cycles.some((existing) => existing.cycleId === cycle.cycleId),
      ),
  );
  if (stale.length > 0) {
    const staleIds = new Set(stale.map((cycle) => cycle.cycleId));
    alarms = replaceDefinition(alarms, {
      ...(alarms.find((alarm) => alarm.id === target.id) ?? target),
      cycles: (
        alarms.find((alarm) => alarm.id === target.id) ?? target
      ).cycles.filter((cycle) => !staleIds.has(cycle.cycleId)),
    });
    await input.checkpoint(alarms);
  }
  if (failed.length > 0) {
    await tryJournal(() =>
      journal.save({ ...entry, oldNotificationIds: failed }),
    );
    throw new AlarmEditError(
      'cancel_failed',
      '前回の編集で古い通知の一部を解除できませんでした。',
      false,
    );
  }
  await journal.remove(entry.alarmId);
  return alarms;
}
