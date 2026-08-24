import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  type MonitoringStepUpdateStatus,
  updateMonitoringCycleStepCount,
} from './alarmDefinitionMutations';
import {
  MAX_ALARM_COUNT,
  isAlarmRepeat,
  localDateKey,
  type AlarmRepeat,
} from './alarmSchedule';

export const ACTIVE_ALARM_STORAGE_KEY = 'already-up/active-alarm/v1';
export const ALARM_DEFINITIONS_STORAGE_KEY = 'already-up/alarm-definitions/v2';
export const ALARM_CANCELLATION_JOURNAL_KEY =
  'already-up/alarm-cancellation-journal/v1';

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
  stepCandidateAtMs?: number;
  confirmedAtMs?: number;
  stepCandidateRecorded: boolean;
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

export async function loadAlarmDefinitions(): Promise<StoredAlarmDefinition[]> {
  const raw = await AsyncStorage.getItem(ALARM_DEFINITIONS_STORAGE_KEY);
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!isAlarmStoreV2(parsed)) {
      throw new Error('保存済みのアラーム設定を読み取れません。');
    }
    return parsed.alarms;
  }

  const migrated = await migrateLegacyAlarm();
  return migrated ? [migrated] : [];
}

export async function saveAlarmDefinitions(
  alarms: StoredAlarmDefinition[],
): Promise<void> {
  const store: AlarmStoreV2 = { version: 2, alarms };
  if (!isAlarmStoreV2(store)) {
    throw new Error('アラーム設定を保存できません。');
  }
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

export function mutateAlarmDefinitions(
  mutator: AlarmDefinitionsMutator,
): Promise<StoredAlarmDefinition[]> {
  const operation = mutationQueue.then(async () => {
    const current = await loadAlarmDefinitions();
    const next = await mutator(current);
    await saveAlarmDefinitions(next);
    return next;
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
    return next;
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
  return mutateAlarmDefinitions((alarms) => {
    let found = false;
    const next = alarms.map((alarm) => {
      if (alarm.id !== cycle.alarmId) {
        return alarm;
      }

      const cycles = alarm.cycles.map((candidate) => {
        if (candidate.cycleId !== cycle.cycleId) {
          return candidate;
        }
        found = true;
        return cycle;
      });
      return { ...alarm, cycles };
    });

    if (!found) {
      throw new Error('対象のアラーム周期が見つかりません。');
    }
    return next;
  });
}

export async function saveMonitoringCycleStepCount(
  alarmId: string,
  cycleId: string,
  stepCount: number,
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
    );
    status = result.status;
    return result.alarms;
  });
  return { alarms, status };
}

export function markDueCyclesRinging(
  nowMs: number,
): Promise<StoredAlarmDefinition[]> {
  return mutateAlarmDefinitions((alarms) =>
    alarms.map((alarm) => ({
      ...alarm,
      cycles: alarm.cycles.map((cycle) =>
        (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
        cycle.dueAtMs <= nowMs
          ? { ...cycle, phase: 'ringing' as const }
          : cycle,
      ),
    })),
  );
}

export async function clearAlarmStorage(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(ALARM_DEFINITIONS_STORAGE_KEY),
    AsyncStorage.removeItem(ACTIVE_ALARM_STORAGE_KEY),
    AsyncStorage.removeItem(ALARM_CANCELLATION_JOURNAL_KEY),
  ]);
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
    ['armed', 'step_candidate', 'suppressed', 'ringing', 'dismissed'].includes(
      alarm.phase,
    ) &&
    typeof alarm.stepCount === 'number' &&
    Number.isFinite(alarm.stepCount) &&
    typeof alarm.stepCandidateRecorded === 'boolean'
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
    ['armed', 'step_candidate', 'suppressed', 'ringing', 'dismissed'].includes(
      alarm.phase,
    ) &&
    typeof alarm.stepCount === 'number' &&
    typeof alarm.stepCandidateRecorded === 'boolean'
  );
}
