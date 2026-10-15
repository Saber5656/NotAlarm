import {
  ALREADY_UP_OWNER,
  AWAKE_CHECKIN_CATEGORY,
  CHECK_IN_KIND,
  parseAlarmNotificationData,
} from './alarmContracts';

/** The parts of a scheduled request needed to prove this app created it. */
export interface ScheduledNotificationSnapshot {
  identifier: string;
  content: {
    title?: string | null;
    categoryIdentifier?: string | null;
    data?: unknown;
  };
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * True only for requests carrying this app's marker plus every identity its
 * kind requires. Expo Go shares one scheduled queue across projects, so a
 * payload that merely has our kind and a cycleId is not proof of ownership.
 */
export function isOwnedAlarmNotification(
  snapshot: ScheduledNotificationSnapshot,
): boolean {
  if (!isNonEmpty(snapshot.identifier)) {
    return false;
  }
  const data = parseAlarmNotificationData(snapshot.content.data);
  if (
    !data ||
    data.owner !== ALREADY_UP_OWNER ||
    !isNonEmpty(data.alarmId) ||
    !isNonEmpty(data.cycleId)
  ) {
    return false;
  }
  if (data.kind === CHECK_IN_KIND) {
    return (
      isNonEmpty(data.mainAlarmId) &&
      snapshot.content.categoryIdentifier === AWAKE_CHECKIN_CATEGORY
    );
  }
  return data.mainAlarmId === undefined;
}

/**
 * Contract-shaped but unmarked: could be an older AlreadyUp notification or
 * another Expo Go project's. Never cancelled unless its id was stored.
 */
export function isAmbiguousAlarmNotification(
  snapshot: ScheduledNotificationSnapshot,
): boolean {
  return (
    !isOwnedAlarmNotification(snapshot) &&
    parseAlarmNotificationData(snapshot.content.data) !== null
  );
}
