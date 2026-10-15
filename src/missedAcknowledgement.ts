import type { StoredAlarm } from './alarmStorage';

export type RefillSeverity = 'none' | 'warning' | 'danger';

export interface MissedAcknowledgementGateway {
  /** Marks the still-missed cycles among `cycleIds` handled; returns those changed. */
  persist(cycleIds: readonly string[]): Promise<StoredAlarm[]>;
  dismissDelivered(notificationId: string): Promise<void>;
  /** Reserves the next cycles; rejects when nothing could be reserved. */
  refill(completed: StoredAlarm): Promise<RefillSeverity>;
}

export type MissedAcknowledgementResult =
  | { status: 'nothing' }
  | { status: 'persist_failed' }
  | { status: 'acknowledged'; refillSeverity: RefillSeverity }
  | { status: 'refill_failed' };

/**
 * Persists first so a failing notification dismissal can never leave a missed
 * card stuck. Dismissal is best effort; refill failure keeps the acknowledgement.
 * Future main notifications are never cancelled here.
 */
export async function acknowledgeMissedAlarms(
  selected: readonly StoredAlarm[],
  gateway: MissedAcknowledgementGateway,
): Promise<MissedAcknowledgementResult> {
  if (selected.length === 0) {
    return { status: 'nothing' };
  }

  let acknowledged: StoredAlarm[];
  try {
    acknowledged = await gateway.persist(selected.map((cycle) => cycle.cycleId));
  } catch {
    return { status: 'persist_failed' };
  }
  if (acknowledged.length === 0) {
    return { status: 'nothing' };
  }

  // Only the persisted cycles' own delivered ids: the main notification and
  // the accepted current snooze (a late snooze keeps its id on the missed
  // cycle). Future or stray notifications are never touched.
  const deliveredIds = new Set<string>();
  for (const cycle of acknowledged) {
    deliveredIds.add(cycle.mainAlarmId);
    if (cycle.snooze?.notificationId) {
      deliveredIds.add(cycle.snooze.notificationId);
    }
  }
  for (const id of deliveredIds) {
    try {
      await gateway.dismissDelivered(id);
    } catch {
      // The cycle is already acknowledged; a stale delivered row is harmless
      // and must not stop the other dismissals.
    }
  }

  let refillFailed = false;
  let refillSeverity: RefillSeverity = 'none';
  const lastByAlarm = new Map<string, StoredAlarm>();
  for (const cycle of acknowledged) {
    lastByAlarm.set(cycle.alarmId, cycle);
  }
  for (const cycle of lastByAlarm.values()) {
    try {
      const severity = await gateway.refill({ ...cycle, phase: 'dismissed' });
      if (severity === 'danger' || (severity === 'warning' && refillSeverity === 'none')) {
        refillSeverity = severity;
      }
    } catch {
      refillFailed = true;
    }
  }
  return refillFailed
    ? { status: 'refill_failed' }
    : { status: 'acknowledged', refillSeverity };
}
