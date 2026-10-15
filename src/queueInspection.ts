import { ceilToSecondMs, parseCalendarDateComponents } from './notificationTrigger';
import {
  ALREADY_UP_OWNER,
  CHECK_IN_KIND,
  MAIN_ALARM_KIND,
  type AlarmNotificationData,
} from './alarmContracts';

/**
 * iOS keeps at most 64 pending local notifications for the whole app (Expo Go
 * shares that budget with every project it hosts). Which ones the OS drops
 * beyond that is not specified, so the app never schedules into a full queue.
 */
export const NOTIFICATION_QUEUE_CAPACITY = 64;

/**
 * What expo-notifications 57.0.23 exposes about a pending trigger (read from
 * its native serializers):
 *  - Android: { type: 'date', value: <epoch ms>, repeats: false }
 *  - iOS, scheduled by this app: a CALENDAR trigger with explicit UTC date
 *    components, read back as { type: 'calendar', dateComponents } with
 *    second resolution (resolutionMs: 1000);
 *  - iOS, scheduled by earlier builds: a DATE input was stored as
 *    UNTimeIntervalNotificationTrigger and reads back as { type:
 *    'timeInterval', seconds } relative to scheduling time, so its absolute
 *    fire time cannot be verified ('relative').
 */
export type QueueTrigger =
  | { kind: 'date'; atMs: number; resolutionMs?: number }
  | { kind: 'relative' }
  | { kind: 'unknown' };

export interface QueueEntry {
  id: string;
  /** Parsed only when the content data is exactly this app's payload shape. */
  owned: AlarmNotificationData | null;
  trigger: QueueTrigger;
}

export type QueueInspection =
  | { kind: 'known'; entries: readonly QueueEntry[] }
  | { kind: 'unknown' };

export function parseOwnedNotificationData(
  data: unknown,
): AlarmNotificationData | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const { owner, kind, alarmId, cycleId, mainAlarmId } = data as Record<
    string,
    unknown
  >;
  if (
    (owner !== undefined && typeof owner !== 'string') ||
    (kind !== MAIN_ALARM_KIND && kind !== CHECK_IN_KIND) ||
    typeof cycleId !== 'string' ||
    cycleId.length === 0 ||
    (alarmId !== undefined && typeof alarmId !== 'string') ||
    (mainAlarmId !== undefined && typeof mainAlarmId !== 'string')
  ) {
    return null;
  }
  return { owner, kind, alarmId, cycleId, mainAlarmId };
}

function parseTrigger(trigger: unknown): QueueTrigger {
  if (typeof trigger !== 'object' || trigger === null) {
    return { kind: 'unknown' };
  }
  const { type, value, repeats, dateComponents } = trigger as Record<
    string,
    unknown
  >;
  if (
    type === 'date' &&
    repeats !== true &&
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return { kind: 'date', atMs: value };
  }
  if (type === 'calendar' && repeats === false) {
    const atMs = parseCalendarDateComponents(dateComponents);
    return atMs === null
      ? { kind: 'unknown' }
      : { kind: 'date', atMs, resolutionMs: 1000 };
  }
  if (type === 'timeInterval' && repeats !== true) {
    return { kind: 'relative' };
  }
  return { kind: 'unknown' };
}

/** Never throws: anything unreadable is a foreign entry that still counts. */
export function describeScheduledRequest(request: unknown): QueueEntry {
  if (typeof request !== 'object' || request === null) {
    return { id: '', owned: null, trigger: { kind: 'unknown' } };
  }
  const { identifier, content, trigger } = request as {
    identifier?: unknown;
    content?: { data?: unknown } | null;
    trigger?: unknown;
  };
  return {
    id: typeof identifier === 'string' ? identifier : '',
    owned: parseOwnedNotificationData(content?.data),
    trigger: parseTrigger(trigger),
  };
}

export interface QueueExpectation {
  id: string;
  kind: AlarmNotificationData['kind'];
  alarmId: string;
  cycleId: string;
  /** Required for a check-in: the main it confirms. */
  mainAlarmId?: string;
  atMs: number;
}

/**
 * - present: this app's notification, pending at the stored time
 * - absent: nothing in the queue under that id
 * - off_schedule: this app's payload, but pending for a different time
 * - legacy: this app's payload with an iOS relative trigger from an earlier
 *   build: its absolute time cannot be verified, it is migrated
 * - unverifiable: this app's payload, but the trigger shape is unreadable
 * - foreign: the id exists with other or unreadable content; not ours
 */
export type QueueMatch =
  | 'present'
  | 'absent'
  | 'off_schedule'
  | 'legacy'
  | 'unverifiable'
  | 'foreign';

/** Is the trigger provably pending at (not before) this due time? */
export function triggerMatchesTime(trigger: QueueTrigger, atMs: number): boolean {
  if (trigger.kind !== 'date') {
    return false;
  }
  const expected =
    trigger.resolutionMs === 1000 ? ceilToSecondMs(atMs) : atMs;
  return trigger.atMs === expected;
}

/**
 * Marker plus every identity its kind requires. Discovery (adopting or
 * cancelling an id nobody stored) needs this; a stored id may be legacy.
 */
export function isMarkedOwned(owned: AlarmNotificationData | null): boolean {
  if (
    !owned ||
    owned.owner !== ALREADY_UP_OWNER ||
    !owned.alarmId ||
    !owned.cycleId
  ) {
    return false;
  }
  return owned.kind === CHECK_IN_KIND
    ? !!owned.mainAlarmId
    : owned.mainAlarmId === undefined;
}

/**
 * Exact stored-id lookup. Content from before the owner marker still counts;
 * a different marker never does.
 */
export function isOwnPayload(
  entry: QueueEntry,
  expected: Omit<QueueExpectation, 'atMs' | 'id'>,
): boolean {
  const owned = entry.owned;
  if (!owned || owned.kind !== expected.kind) {
    return false;
  }
  if (owned.owner !== undefined && owned.owner !== ALREADY_UP_OWNER) {
    return false;
  }
  // alarmId is optional in the contract; only an explicit mismatch disqualifies.
  if (owned.alarmId !== undefined && owned.alarmId !== expected.alarmId) {
    return false;
  }
  if (owned.cycleId !== expected.cycleId) {
    return false;
  }
  if (expected.kind === CHECK_IN_KIND) {
    return owned.mainAlarmId === expected.mainAlarmId;
  }
  return true;
}

export function matchQueueEntry(
  entry: QueueEntry | undefined,
  expected: QueueExpectation,
): QueueMatch {
  if (!entry) {
    return 'absent';
  }
  if (!isOwnPayload(entry, expected)) {
    return 'foreign';
  }
  if (entry.trigger.kind === 'relative') {
    return 'legacy';
  }
  if (entry.trigger.kind === 'unknown') {
    return 'unverifiable';
  }
  return triggerMatchesTime(entry.trigger, expected.atMs)
    ? 'present'
    : 'off_schedule';
}

export class QueueIndex {
  private readonly byId = new Map<string, QueueEntry>();

  constructor(readonly entries: readonly QueueEntry[]) {
    for (const entry of entries) {
      if (entry.id) {
        this.byId.set(entry.id, entry);
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get(id: string): QueueEntry | undefined {
    return this.byId.get(id);
  }

  match(expected: QueueExpectation): QueueMatch {
    return matchQueueEntry(this.byId.get(expected.id), expected);
  }

  hasRoomFor(count: number): boolean {
    return this.size + count <= NOTIFICATION_QUEUE_CAPACITY;
  }

  /**
   * Untracked entries carrying this app's owner marker and full identity for
   * the same occurrence, provably pending at its time (a relative or
   * unreadable trigger is not). Unmarked look-alikes are never returned.
   */
  findOwned(expected: Omit<QueueExpectation, 'id'>): QueueEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.id !== '' &&
        isMarkedOwned(entry.owned) &&
        isOwnPayload(entry, expected) &&
        triggerMatchesTime(entry.trigger, expected.atMs),
    );
  }
}
