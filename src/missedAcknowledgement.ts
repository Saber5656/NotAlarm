import type { StoredAlarm } from './alarmStorage';
import { describeScheduleIssues, type AlarmScheduleIssue } from './alarmScheduling';
import type { ErrorNotice } from './errorCatalog';
import type { Messages } from './i18n/messages';
import { noticeFromCodeIn } from './i18n/errorText';

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
    if (cycle.checkInNotificationId) {
      deliveredIds.add(cycle.checkInNotificationId);
    }
    if (cycle.snooze?.notificationId) {
      deliveredIds.add(cycle.snooze.notificationId);
    }
  }
  // Each request can sit in Notification Center; every dismissal is best
  // effort and independent, so one failing never skips another.
  for (const id of deliveredIds) {
    try {
      await gateway.dismissDelivered(id);
    } catch {
      // The cycle is already acknowledged; a stale delivered row is harmless.
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

/**
 * The one notice shown after an acknowledgement. Success text is chosen from
 * the issues of every refill together, so an earlier main-alarm failure is
 * never replaced by a later check-in warning.
 */
export function getMissedAcknowledgementNotice(
  result: MissedAcknowledgementResult,
  refillIssues: readonly AlarmScheduleIssue[],
  messages: Messages,
): ErrorNotice | { tone: 'neutral'; text: string } | null {
  switch (result.status) {
    case 'nothing':
      return null;
    case 'persist_failed':
      return noticeFromCodeIn(messages, 'MISSED_ACK_FAILED');
    case 'refill_failed':
      return {
        tone: 'danger',
        code: 'REFILL_FAILED',
        text: messages.missed.acknowledgeRefillFailed,
      };
    case 'acknowledged':
      return (
        describeScheduleIssues(refillIssues, messages.scheduleIssue.nextLead, messages) ?? {
          tone: 'neutral',
          text: messages.missed.acknowledged,
        }
      );
  }
}
