import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  type MainDeliveryIdentity,
  type MonitoringStepUpdateStatus,
  type RingingTransitionStatus,
  markCycleRinging,
  replaceStoredCycle,
  updateMonitoringCycleStepCount,
} from './alarmDefinitionMutations';
import { isPendingAlarmEdit, type PendingAlarmEdit } from './alarmEdit';
import {
  MAX_ALARM_COUNT,
  isAlarmRepeat,
  localDateKey,
  type AlarmRepeat,
} from './alarmSchedule';
import { readOccurrenceIdentity } from './occurrenceIdentity';
import { type ClassificationSource, classifyOverdueCycles } from './missedAlarms';
import { assertNoPendingReset, stampStorageResult } from './storageResetGate';
import { hasValidSnoozeState, type SnoozeRecord } from './snooze';

export const ACTIVE_ALARM_STORAGE_KEY = 'already-up/active-alarm/v1';
export const ALARM_DEFINITIONS_STORAGE_KEY = 'already-up/alarm-definitions/v2';
export const ALARM_CANCELLATION_JOURNAL_KEY =
  'already-up/alarm-cancellation-journal/v1';

export const ALARM_EDIT_JOURNAL_KEY = 'already-up/alarm-edit-journal/v1';

export type AlarmCancellationCompletion = 'disable' | 'delete';

export interface PendingAlarmCancellation {
  alarmId: string;
  completion: AlarmCancellationCompletion;
  cycleIds: string[];
  requestedAtMs: number;
}

export type AlarmPhase =
  | 'armed'
  | 'step_candidate'
  | 'suppressed'
  | 'ringing'
  /** Overdue past the recovery window; silent until acknowledged. */
  | 'missed'
  /** Waiting for a scheduled snooze delivery; never wake evidence. */
  | 'snoozed'
  | 'dismissed';

export interface StoredAlarm {
  alarmId: string;
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
  phase: AlarmPhase;
  stepCount: number;
  /** Start of the step window `stepCount` was counted from. */
  stepCountFromMs?: number;
  stepCandidateAtMs?: number;
  confirmedAtMs?: number;
  /** Set when the user explicitly skipped this occurrence in the app. */
  suppressedBy?: 'user_skip';
  skippedAtMs?: number;
  stepCandidateRecorded: boolean;
  snooze?: SnoozeRecord;
  /**
   * Logical calendar date (`YYYY-MM-DD` in `planningZone`) this occurrence was
   * planned for. Stamped when the cycle is created; absent on cycles written by
   * older builds, which are legacy evidence only (never given an invented zone).
   */
  logicalDateKey?: string;
  planningZone?: string;
}

export interface StoredAlarmDefinition {
  id: string;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
  enabled: boolean;
  createdAtMs: number;
  cycles: StoredAlarm[];
}

interface AlarmStoreV2 {
  version: 2;
  alarms: StoredAlarmDefinition[];
}

interface AlarmCancellationJournalV1 {
  version: 1;
  entries: PendingAlarmCancellation[];
}

interface AlarmEditJournalV1 {
  version: 1;
  entries: PendingAlarmEdit[];
}

type AlarmDefinitionsMutator = (
  alarms: StoredAlarmDefinition[],
) => StoredAlarmDefinition[] | Promise<StoredAlarmDefinition[]>;

type AlarmDefinitionsCheckpoint = (
  alarms: StoredAlarmDefinition[],
) => Promise<void>;

type AlarmDefinitionsTransaction = (
  alarms: StoredAlarmDefinition[],
  checkpoint: AlarmDefinitionsCheckpoint,
) => StoredAlarmDefinition[] | Promise<StoredAlarmDefinition[]>;

let mutationQueue: Promise<void> = Promise.resolve();
let cancellationJournalQueue: Promise<void> = Promise.resolve();
let editJournalQueue: Promise<void> = Promise.resolve();

export async function loadAlarmDefinitions(): Promise<StoredAlarmDefinition[]> {
  const raw = await AsyncStorage.getItem(ALARM_DEFINITIONS_STORAGE_KEY);
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!isAlarmStoreV2(parsed)) {
      throw new Error('保存済みのアラーム設定を読み取れません。');
    }
    return stampStorageResult(dropUntrustedOccurrenceMetadata(parsed.alarms));
  }

  const migrated = await migrateLegacyAlarm();
  return stampStorageResult(migrated ? [migrated] : []);
}

/**
 * The occurrence metadata is optional and advisory: a half-written or
 * malformed pair is dropped (the cycle becomes legacy) instead of making the
 * whole alarm store unreadable, and nothing is filled in to replace it.
 */
export function dropUntrustedOccurrenceMetadata(
  alarms: StoredAlarmDefinition[],
): StoredAlarmDefinition[] {
  return alarms.map((definition) => ({
    ...definition,
    cycles: definition.cycles.map((cycle) => {
      if (
        cycle.logicalDateKey === undefined &&
        cycle.planningZone === undefined
      ) {
        return cycle;
      }
      if (readOccurrenceIdentity(cycle)) {
        return cycle;
      }
      const { logicalDateKey: _date, planningZone: _zone, ...rest } = cycle;
      return rest;
    }),
  }));
}

export async function saveAlarmDefinitions(
  alarms: StoredAlarmDefinition[],
): Promise<void> {
  const store: AlarmStoreV2 = { version: 2, alarms };
  if (!isAlarmStoreV2(store)) {
    throw new Error('アラーム設定を保存できません。');
  }
  // Fresh check at the write itself, including the legacy migration path.
  await assertNoPendingReset();
  await AsyncStorage.setItem(ALARM_DEFINITIONS_STORAGE_KEY, JSON.stringify(store));
}

export async function loadPendingAlarmCancellations(): Promise<
  PendingAlarmCancellation[]
> {
  const raw = await AsyncStorage.getItem(ALARM_CANCELLATION_JOURNAL_KEY);
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isAlarmCancellationJournalV1(parsed)) {
    throw new Error('未完了のアラーム停止処理を読み取れません。');
  }
  return parsed.entries;
}

function mutatePendingAlarmCancellations(
  mutator: (
    current: PendingAlarmCancellation[],
  ) => PendingAlarmCancellation[],
): Promise<PendingAlarmCancellation[]> {
  const operation = cancellationJournalQueue.then(async () => {
    await assertNoPendingReset();
    const current = await loadPendingAlarmCancellations();
    const entries = mutator(current);
    const journal: AlarmCancellationJournalV1 = { version: 1, entries };
    if (!isAlarmCancellationJournalV1(journal)) {
      throw new Error('アラーム停止処理を保存できません。');
    }
    if (entries.length === 0) {
      await AsyncStorage.removeItem(ALARM_CANCELLATION_JOURNAL_KEY);
    } else {
      await AsyncStorage.setItem(
        ALARM_CANCELLATION_JOURNAL_KEY,
        JSON.stringify(journal),
      );
    }
    return entries;
  });

  cancellationJournalQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function upsertPendingAlarmCancellation(
  pending: PendingAlarmCancellation,
): Promise<PendingAlarmCancellation[]> {
  return mutatePendingAlarmCancellations((current) => [
    ...current.filter((entry) => entry.alarmId !== pending.alarmId),
    pending,
  ]);
}

export function removePendingAlarmCancellation(
  alarmId: string,
): Promise<PendingAlarmCancellation[]> {
  return mutatePendingAlarmCancellations((current) =>
    current.filter((entry) => entry.alarmId !== alarmId),
  );
}

export async function loadPendingAlarmEdits(): Promise<PendingAlarmEdit[]> {
  const raw = await AsyncStorage.getItem(ALARM_EDIT_JOURNAL_KEY);
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isAlarmEditJournalV1(parsed)) {
    throw new Error('未完了のアラーム編集を読み取れません。');
  }
  return stampStorageResult(parsed.entries);
}

function mutatePendingAlarmEdits(
  mutator: (current: PendingAlarmEdit[]) => PendingAlarmEdit[],
): Promise<PendingAlarmEdit[]> {
  const operation = editJournalQueue.then(async () => {
    // Inside the queue: a stale edit cannot rewrite a journal a reset removed.
    await assertNoPendingReset();
    const current = await loadPendingAlarmEdits();
    const entries = mutator(current);
    const journal: AlarmEditJournalV1 = { version: 1, entries };
    if (!isAlarmEditJournalV1(journal)) {
      throw new Error('アラーム編集を保存できません。');
    }
    if (entries.length === 0) {
      await AsyncStorage.removeItem(ALARM_EDIT_JOURNAL_KEY);
    } else {
      await AsyncStorage.setItem(ALARM_EDIT_JOURNAL_KEY, JSON.stringify(journal));
    }
    return stampStorageResult(entries);
  });

  editJournalQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function savePendingAlarmEdit(
  pending: PendingAlarmEdit,
): Promise<void> {
  await mutatePendingAlarmEdits((current) => [
    ...current.filter((entry) => entry.alarmId !== pending.alarmId),
    pending,
  ]);
}

export async function removePendingAlarmEdit(alarmId: string): Promise<void> {
  await mutatePendingAlarmEdits((current) =>
    current.filter((entry) => entry.alarmId !== alarmId),
  );
}

export function mutateAlarmDefinitions(
  mutator: AlarmDefinitionsMutator,
): Promise<StoredAlarmDefinition[]> {
  const operation = mutationQueue.then(async () => {
    // Before the mutator, which may reserve notifications.
    await assertNoPendingReset();
    const current = await loadAlarmDefinitions();
    const next = await mutator(current);
    await saveAlarmDefinitions(next);
    return stampStorageResult(next);
  });

  mutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function transactAlarmDefinitions(
  transaction: AlarmDefinitionsTransaction,
): Promise<StoredAlarmDefinition[]> {
  const operation = mutationQueue.then(async () => {
    await assertNoPendingReset();
    const current = await loadAlarmDefinitions();
    let lastCheckpoint: StoredAlarmDefinition[] | null = null;
    const checkpoint: AlarmDefinitionsCheckpoint = async (next) => {
      await saveAlarmDefinitions(next);
      lastCheckpoint = next;
    };
    const next = await transaction(current, checkpoint);
    if (next !== lastCheckpoint && next !== current) {
      await saveAlarmDefinitions(next);
    }
    return stampStorageResult(next);
  });

  mutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function loadStoredAlarmByCycleId(
  cycleId: string,
): Promise<StoredAlarm | null> {
  const alarms = await loadAlarmDefinitions();
  for (const alarm of alarms) {
    const cycle = alarm.cycles.find((candidate) => candidate.cycleId === cycleId);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

export async function saveStoredAlarm(
  cycle: StoredAlarm,
): Promise<StoredAlarmDefinition[]> {
  return mutateAlarmDefinitions((alarms) => replaceStoredCycle(alarms, cycle));
}

/**
 * Atomic ringing transition for a delivered main notification: the cycle is
 * read, checked and written inside one queued mutation, so a stop, dismissal
 * or acknowledgement that commits first is never overwritten.
 */
export async function saveCycleRinging(
  expected: MainDeliveryIdentity,
  readNowMs: () => number = Date.now,
): Promise<{
  alarms: StoredAlarmDefinition[];
  status: RingingTransitionStatus;
}> {
  let status: RingingTransitionStatus = 'not_found';
  const alarms = await transactAlarmDefinitions((current) => {
    // The clock is read here, after any earlier queued work has finished, so
    // a long wait or a clock correction cannot leave a stale deadline check.
    const result = markCycleRinging(current, expected, readNowMs());
    status = result.status;
    // Nothing is written unless the cycle actually changed.
    return status === 'ringing' || status === 'missed'
      ? result.alarms
      : current;
  });
  return { alarms, status };
}

export async function saveMonitoringCycleStepCount(
  alarmId: string,
  cycleId: string,
  stepCount: number,
  countedFromMs: number,
): Promise<{
  alarms: StoredAlarmDefinition[];
  status: MonitoringStepUpdateStatus;
}> {
  let status: MonitoringStepUpdateStatus = 'not_found';
  const alarms = await mutateAlarmDefinitions((current) => {
    const result = updateMonitoringCycleStepCount(
      current,
      alarmId,
      cycleId,
      stepCount,
      countedFromMs,
    );
    status = result.status;
    return result.alarms;
  });
  return { alarms, status };
}

export function markDueCyclesRinging(
  nowMs: number,
  source: ClassificationSource = 'resume',
): Promise<StoredAlarmDefinition[]> {
  return mutateAlarmDefinitions((alarms) =>
    classifyOverdueCycles(alarms, nowMs, source),
  );
}

/**
 * Runs `run` after every queued definition and cancellation-journal mutation
 * and blocks the next ones until it finishes, so a storage reset cannot
 * interleave with an add, stop or refill in this process.
 */
export function runExclusiveAlarmStorage<T>(run: () => Promise<T>): Promise<T> {
  const operation = Promise.all([
    mutationQueue,
    cancellationJournalQueue,
    editJournalQueue,
  ]).then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  mutationQueue = settled;
  cancellationJournalQueue = settled;
  editJournalQueue = settled;
  return operation;
}

/** Strictly validated read for recovery code; unreadable data yields null. */
export function readValidAlarmDefinitions(
  raw: string,
): StoredAlarmDefinition[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAlarmStoreV2(parsed) ? parsed.alarms : null;
  } catch {
    return null;
  }
}

/** Strictly validated read of the edit journal; unreadable data yields null. */
export function readValidAlarmEditJournal(
  raw: string,
): PendingAlarmEdit[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAlarmEditJournalV1(parsed) ? parsed.entries : null;
  } catch {
    return null;
  }
}

/** Strictly validated read of the pre-v2 single-alarm record, or null. */
export function readValidLegacyAlarm(
  raw: string,
): Omit<StoredAlarm, 'alarmId'> | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Omit<StoredAlarm, 'alarmId'>>;
    return parsed && typeof parsed === 'object' && isLegacyStoredAlarm(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isAlarmEditJournalV1(value: unknown): value is AlarmEditJournalV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const journal = value as Partial<AlarmEditJournalV1>;
  return (
    journal.version === 1 &&
    Array.isArray(journal.entries) &&
    journal.entries.length <= MAX_ALARM_COUNT &&
    new Set(journal.entries.map((entry) => entry?.alarmId)).size ===
      journal.entries.length &&
    journal.entries.every(isPendingAlarmEdit)
  );
}

function isAlarmCancellationJournalV1(
  value: unknown,
): value is AlarmCancellationJournalV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const journal = value as Partial<AlarmCancellationJournalV1>;
  return (
    journal.version === 1 &&
    Array.isArray(journal.entries) &&
    journal.entries.length <= MAX_ALARM_COUNT &&
    new Set(journal.entries.map((entry) => entry?.alarmId)).size ===
      journal.entries.length &&
    journal.entries.every(isPendingAlarmCancellation)
  );
}

function isPendingAlarmCancellation(
  value: unknown,
): value is PendingAlarmCancellation {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const pending = value as Partial<PendingAlarmCancellation>;
  return (
    typeof pending.alarmId === 'string' &&
    pending.alarmId.length > 0 &&
    (pending.completion === 'disable' || pending.completion === 'delete') &&
    Array.isArray(pending.cycleIds) &&
    pending.cycleIds.every(
      (cycleId) => typeof cycleId === 'string' && cycleId.length > 0,
    ) &&
    new Set(pending.cycleIds).size === pending.cycleIds.length &&
    typeof pending.requestedAtMs === 'number' &&
    Number.isFinite(pending.requestedAtMs)
  );
}

function isAlarmStoreV2(value: unknown): value is AlarmStoreV2 {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const store = value as Partial<AlarmStoreV2>;
  return (
    store.version === 2 &&
    Array.isArray(store.alarms) &&
    store.alarms.length <= MAX_ALARM_COUNT &&
    new Set(store.alarms.map((alarm) => alarm?.id)).size === store.alarms.length &&
    store.alarms.every(isStoredAlarmDefinition)
  );
}

function isStoredAlarmDefinition(value: unknown): value is StoredAlarmDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const alarm = value as Partial<StoredAlarmDefinition>;
  return (
    typeof alarm.id === 'string' &&
    alarm.id.length > 0 &&
    Number.isInteger(alarm.hour) &&
    alarm.hour! >= 0 &&
    alarm.hour! <= 23 &&
    Number.isInteger(alarm.minute) &&
    alarm.minute! >= 0 &&
    alarm.minute! <= 59 &&
    isAlarmRepeat(alarm.repeat) &&
    typeof alarm.enabled === 'boolean' &&
    typeof alarm.createdAtMs === 'number' &&
    Number.isFinite(alarm.createdAtMs) &&
    Array.isArray(alarm.cycles) &&
    new Set(alarm.cycles.map((cycle) => cycle?.cycleId)).size ===
      alarm.cycles.length &&
    alarm.cycles.every((cycle) => isStoredAlarm(cycle, alarm.id!))
  );
}

function isStoredAlarm(value: unknown, expectedAlarmId: string): value is StoredAlarm {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const alarm = value as Partial<StoredAlarm>;
  return (
    alarm.alarmId === expectedAlarmId &&
    typeof alarm.cycleId === 'string' &&
    alarm.cycleId.length > 0 &&
    typeof alarm.mainAlarmId === 'string' &&
    alarm.mainAlarmId.length > 0 &&
    typeof alarm.armedAtMs === 'number' &&
    Number.isFinite(alarm.armedAtMs) &&
    typeof alarm.dueAtMs === 'number' &&
    Number.isFinite(alarm.dueAtMs) &&
    typeof alarm.phase === 'string' &&
    ['armed', 'step_candidate', 'suppressed', 'ringing', 'missed', 'snoozed', 'dismissed'].includes(
      alarm.phase,
    ) &&
    typeof alarm.stepCount === 'number' &&
    Number.isFinite(alarm.stepCount) &&
    (alarm.stepCountFromMs === undefined ||
      (typeof alarm.stepCountFromMs === 'number' &&
        Number.isFinite(alarm.stepCountFromMs))) &&
    typeof alarm.stepCandidateRecorded === 'boolean' &&
    (alarm.suppressedBy === undefined ||
      (alarm.suppressedBy === 'user_skip' &&
        typeof alarm.skippedAtMs === 'number' &&
        Number.isFinite(alarm.skippedAtMs))) &&
    hasValidSnoozeState(alarm as StoredAlarm)
  );
}

async function migrateLegacyAlarm(): Promise<StoredAlarmDefinition | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_ALARM_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const legacy = parsed as Partial<Omit<StoredAlarm, 'alarmId'>>;
  if (!isLegacyStoredAlarm(legacy)) {
    return null;
  }

  const alarmId = `alarm-migrated-${legacy.cycleId}`;
  const due = new Date(legacy.dueAtMs);
  const migrated: StoredAlarmDefinition = {
    id: alarmId,
    hour: due.getHours(),
    minute: due.getMinutes(),
    repeat: {
      kind: 'today',
      weekdays: [],
      dateKey: localDateKey(legacy.dueAtMs),
    },
    enabled:
      legacy.phase === 'armed' ||
      legacy.phase === 'step_candidate' ||
      legacy.phase === 'ringing',
    createdAtMs: legacy.armedAtMs,
    cycles: [{ ...legacy, alarmId } as StoredAlarm],
  };

  await saveAlarmDefinitions([migrated]);
  await AsyncStorage.removeItem(ACTIVE_ALARM_STORAGE_KEY);
  return migrated;
}

function isLegacyStoredAlarm(
  alarm: Partial<Omit<StoredAlarm, 'alarmId'>>,
): alarm is Omit<StoredAlarm, 'alarmId'> {
  return (
    typeof alarm.cycleId === 'string' &&
    typeof alarm.mainAlarmId === 'string' &&
    typeof alarm.armedAtMs === 'number' &&
    Number.isFinite(alarm.armedAtMs) &&
    typeof alarm.dueAtMs === 'number' &&
    Number.isFinite(alarm.dueAtMs) &&
    typeof alarm.phase === 'string' &&
    ['armed', 'step_candidate', 'suppressed', 'ringing', 'missed', 'dismissed'].includes(
      alarm.phase,
    ) &&
    typeof alarm.stepCount === 'number' &&
    typeof alarm.stepCandidateRecorded === 'boolean'
  );
}
