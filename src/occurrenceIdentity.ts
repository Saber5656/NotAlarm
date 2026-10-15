import { isDueTimeWallClockAligned, type AlarmRepeat } from './alarmSchedule';
import type { StoredAlarm } from './alarmStorage';

/**
 * Logical identity of one occurrence: the calendar date it was planned for and
 * the zone that date belongs to. Stamped when a cycle is created, so a later
 * zone change never has to be inferred from a global setting.
 */
export interface OccurrenceIdentity {
  /** `YYYY-MM-DD` in `planningZone`. */
  logicalDateKey: string;
  planningZone: string;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealDateKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = DATE_KEY.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Both fields, a zone this runtime knows, and a date that really is the
 * occurrence's due date in that zone. Anything else (one field, wrong type,
 * impossible date, unknown zone, a date that does not belong to the due time)
 * is not trusted and not repaired: the cycle is legacy.
 */
export function readOccurrenceIdentity(value: {
  dueAtMs: number;
  logicalDateKey?: unknown;
  planningZone?: unknown;
}): OccurrenceIdentity | null {
  if (
    isRealDateKey(value.logicalDateKey) &&
    typeof value.planningZone === 'string' &&
    dateKeyInZone(value.dueAtMs, value.planningZone) === value.logicalDateKey
  ) {
    return {
      logicalDateKey: value.logicalDateKey,
      planningZone: value.planningZone,
    };
  }
  return null;
}

/**
 * One cycle with only trusted occurrence metadata. A half-written or malformed
 * pair is dropped (the cycle becomes legacy), never repaired; ids, phase and
 * everything else are kept.
 */
export function withTrustedOccurrenceMetadata<
  T extends { dueAtMs: number; logicalDateKey?: string; planningZone?: string },
>(cycle: T): T {
  if (cycle.logicalDateKey === undefined && cycle.planningZone === undefined) {
    return cycle;
  }
  if (readOccurrenceIdentity(cycle)) {
    return cycle;
  }
  const { logicalDateKey: _date, planningZone: _zone, ...rest } = cycle;
  return rest as T;
}

/**
 * Stamp for a cycle planned in `planningZone`. The date is read in that
 * explicit zone, never the process zone, so a zone change while registration
 * awaits cannot pair the date with the wrong zone. An unknown zone stamps
 * nothing: the cycle stays legacy rather than getting an invented zone.
 */
export function stampOccurrence(
  dueAtMs: number,
  planningZone: string,
): OccurrenceIdentity | Record<string, never> {
  const logicalDateKey = dateKeyInZone(dueAtMs, planningZone);
  return logicalDateKey === null ? {} : { logicalDateKey, planningZone };
}

/** `Date#getTimezoneOffset` minutes west of UTC: UTC+14 .. UTC-12. */
const MIN_OFFSET_MINUTES = -14 * 60;
const MAX_OFFSET_MINUTES = 12 * 60;
const MAX_DATE_MS = 8.64e15;

/**
 * The calendar date an instant has in a zone, or null when the instant is not
 * representable or the zone is unknown (including a `utc-offset:` outside the
 * range real zones use). Never throws.
 */
export function dateKeyInZone(
  atMs: number,
  zone: string | null | undefined,
): string | null {
  if (!zone || !Number.isFinite(atMs) || Math.abs(atMs) > MAX_DATE_MS) {
    return null;
  }
  const offset = /^utc-offset:(-?\d{1,4})$/.exec(zone);
  if (offset) {
    const minutesWest = Number(offset[1]);
    if (minutesWest < MIN_OFFSET_MINUTES || minutesWest > MAX_OFFSET_MINUTES) {
      return null;
    }
    const shifted = new Date(atMs - minutesWest * 60_000);
    return Number.isNaN(shifted.getTime())
      ? null
      : shifted.toISOString().slice(0, 10);
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(atMs);
    const part = (type: string) =>
      parts.find((candidate) => candidate.type === type)?.value;
    const [year, month, day] = [part('year'), part('month'), part('day')];
    const key = year && month && day ? `${year.padStart(4, '0')}-${month}-${day}` : null;
    return key !== null && isRealDateKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Zones differ by at most 26 hours, so an occurrence whose instant is older
 * than this cannot share a calendar date with any slot still ahead.
 */
export const LOGICAL_DATE_REACH_MS = 48 * 60 * 60 * 1000;

function isMonitoringPhase(cycle: { phase: string }): boolean {
  return cycle.phase === 'armed' || cycle.phase === 'step_candidate';
}

/**
 * A cycle that is not being monitored (suppressed, dismissed, ringing,
 * snoozed, missed) and whose calendar date can still be the date of a slot
 * ahead. Older ones can no longer recur, so they are not evidence any more.
 */
export function isLogicalDateEvidence(
  cycle: Pick<StoredAlarm, 'phase' | 'dueAtMs'>,
  nowMs: number,
): boolean {
  return !isMonitoringPhase(cycle) && cycle.dueAtMs > nowMs - LOGICAL_DATE_REACH_MS;
}

/**
 * True when an evidence cycle has no identity of its own, so its date can only
 * be recovered from the stored origin zone (which must not move on first).
 */
export function legacyEvidenceNeedsOrigin(
  cycles: readonly StoredAlarm[],
  nowMs: number,
): boolean {
  return cycles.some(
    (cycle) =>
      isLogicalDateEvidence(cycle, nowMs) && readOccurrenceIdentity(cycle) === null,
  );
}

export interface LogicalDateEvidence {
  /** `YYYY-MM-DD` dates a new occurrence must not be planned for. */
  blockedDates: Set<string>;
  /** Identity to persist on legacy cycles whose date was just established. */
  stamps: Map<string, OccurrenceIdentity>;
  /** A legacy cycle's date cannot be established: plan nothing new. */
  originUnknown: boolean;
}

/**
 * The one interpretation of "which logical days are already taken", shared by
 * the time-zone replan and the refill. A stamped cycle speaks for itself. A
 * legacy cycle that still lines up with the alarm's wall clock in the planning
 * zone is dated there; otherwise only the stored origin zone can date it, and
 * without a valid origin nothing is guessed.
 */
export function collectLogicalDateEvidence(input: {
  cycles: readonly StoredAlarm[];
  nowMs: number;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
  planningZone: string;
  originZone: string | null | undefined;
}): LogicalDateEvidence {
  const evidence: LogicalDateEvidence = {
    blockedDates: new Set(),
    stamps: new Map(),
    originUnknown: false,
  };
  for (const cycle of input.cycles) {
    if (!isLogicalDateEvidence(cycle, input.nowMs)) {
      continue;
    }
    const identity = readOccurrenceIdentity(cycle);
    if (identity) {
      evidence.blockedDates.add(identity.logicalDateKey);
      continue;
    }
    const aligned = isDueTimeWallClockAligned(
      cycle.dueAtMs,
      input.hour,
      input.minute,
      input.repeat,
    );
    const zone = aligned ? input.planningZone : input.originZone;
    const dateKey = dateKeyInZone(cycle.dueAtMs, zone);
    if (dateKey === null || !zone) {
      evidence.originUnknown = true;
      continue;
    }
    evidence.blockedDates.add(dateKey);
    evidence.stamps.set(cycle.cycleId, { logicalDateKey: dateKey, planningZone: zone });
  }
  return evidence;
}

/** The cycles with the established identities written onto legacy cycles. */
export function applyEvidenceStamps(
  cycles: readonly StoredAlarm[],
  stamps: ReadonlyMap<string, OccurrenceIdentity>,
): StoredAlarm[] {
  return cycles.map((cycle) => {
    const stamp = stamps.get(cycle.cycleId);
    return stamp ? { ...cycle, ...stamp } : cycle;
  });
}
