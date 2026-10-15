import {
  scheduleAlarmNotificationsFailSafe,
  type AlarmSchedulingGateway,
} from './alarmOrchestrator';
import { CHECK_IN_KIND, MAIN_ALARM_KIND } from './alarmContracts';
import { getCheckInAtMs } from './alarmPolicy';
import {
  getUpcomingAlarmTimes,
  isDueTimeWallClockAligned,
  SCHEDULED_OCCURRENCES_PER_ALARM,
} from './alarmSchedule';
import {
  ScheduledNotificationRollbackError,
  type ScheduledNotificationRollbackFailure,
} from './alarmScheduleRollback';
import type { AlarmScheduleIssue } from './alarmScheduling';
import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';
import {
  isMarkedOwned,
  isOwnPayload,
  QueueIndex,
  type QueueExpectation,
  type QueueInspection,
} from './queueInspection';

/**
 * Compares the stored future schedule with what the OS queue really holds and
 * repairs only what this app owns.
 *
 * Deterministic order (recorded in DESIGN 6.1):
 *  1. alarms in stored order; disabled alarms and alarms with an unfinished
 *     cancel / suppression are never touched;
 *  2. unknown queue or no permission: nothing is scheduled or cancelled, the
 *     alarm is reported instead;
 *  3. cycles planned for another time zone are replaced one occurrence at a
 *     time: room check (64 shared with foreign entries) -> new pair ->
 *     checkpoint -> read the queue back and confirm the new ids -> cancel the
 *     paired old ids -> drop the old cycle. Any unconfirmed step keeps the old
 *     cycle, so nothing is ever left unreserved;
 *  4. a missing main is rescheduled for the same cycle (adopting an untracked
 *     notification of that cycle first); a missing check-in alone is
 *     rescheduled against the verified main. Both need room in the queue.
 * What counts as "present" is decided from the notification content (kind,
 * alarmId, cycleId, mainAlarmId) and, where the SDK exposes it, the trigger
 * time; an id carrying other content is foreign and is never cancelled.
 * If a checkpoint cannot be saved, what was just scheduled is cancelled and
 * any id that cannot be cancelled is handed to the orphan store.
 * suppressed / dismissed / ringing occurrences are never rescheduled, and no
 * old occurrence is cancelled once its due time has been reached.
 */

export type { QueueInspection } from './queueInspection';

export type AlarmQueueStatus =
  | 'verified'
  | 'repaired'
  | 'unverified'
  | 'missing'
  | 'check_in_missing'
  /** Old and new reservations are both pending: it may ring twice. */
  | 'duplicated'
  /** The shared 64-notification queue has no room for the repair. */
  | 'capacity_full';

export interface ReconcileGateway extends AlarmSchedulingGateway {
  cancelScheduled(notificationId: string): Promise<void>;
}

/** Durable record of scheduled ids that could not be cancelled or saved. */
export interface OrphanStore {
  load(): Promise<string[]>;
  add(ids: string[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export interface ReconcileInput {
  alarms: StoredAlarmDefinition[];
  excludedAlarmIds: ReadonlySet<string>;
  /** Read again after every change, so each step is confirmed against the OS. */
  readQueue: () => Promise<QueueInspection>;
  canSchedule: boolean;
  nowMs: () => number;
  gateway: ReconcileGateway;
  checkpoint: (alarms: StoredAlarmDefinition[]) => Promise<void>;
  orphans?: OrphanStore;
  makeCycleId?: () => string;
}

export interface ReconcileOutcome {
  alarms: StoredAlarmDefinition[];
  statuses: Record<string, AlarmQueueStatus>;
  issues: AlarmScheduleIssue[];
  repaired: number;
  replanned: number;
  /** The OS queue was readable when the run ended. */
  queueKnown: boolean;
  /** The orphan journal could not be read: nothing was changed. */
  orphansUnreadable: boolean;
}

export async function reconcileAlarmSchedules(
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const run = new Run(input);
  await run.start();
  for (const original of input.alarms) {
    if (!original.enabled || input.excludedAlarmIds.has(original.id)) {
      continue;
    }
    await run.reconcileAlarm(original.id);
  }
  return run.outcome();
}

const STATUS_RANK: Record<AlarmQueueStatus, number> = {
  verified: 0,
  repaired: 1,
  check_in_missing: 2,
  unverified: 3,
  duplicated: 4,
  missing: 5,
  capacity_full: 6,
};

function isMonitoring(cycle: StoredAlarm): boolean {
  return cycle.phase === 'armed' || cycle.phase === 'step_candidate';
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** An old occurrence and the cycle that takes over its slot. */
interface ReplacementPair {
  oldCycleId: string;
  replacementCycleId: string | null;
  /** The due time reserved for the replacement. */
  slot: number | undefined;
}

class Run {
  private alarms: StoredAlarmDefinition[];
  private queue: QueueIndex | null = null;
  private readonly statuses: Record<string, AlarmQueueStatus> = {};
  private readonly issues: AlarmScheduleIssue[] = [];
  private repaired = 0;
  private replanned = 0;
  private readonly fresh = new Set<string>();
  /** Old cycles whose replacement was confirmed: never rebuilt, only retired. */
  private readonly superseded = new Set<string>();
  private readonly pairs = new Map<string, ReplacementPair[]>();

  constructor(private readonly input: ReconcileInput) {
    this.alarms = input.alarms;
  }

  outcome(): ReconcileOutcome {
    return {
      alarms: this.alarms,
      statuses: this.statuses,
      issues: this.issues,
      repaired: this.repaired,
      replanned: this.replanned,
      queueKnown: this.queue !== null,
      orphansUnreadable: this.orphansUnreadable,
    };
  }

  async start(): Promise<void> {
    await this.refreshQueue();
    await this.releaseOrphans();
  }

  /** False when the queue cannot be read: nothing can then be confirmed. */
  private orphansUnreadable = false;

  private async refreshQueue(): Promise<boolean> {
    try {
      const inspection = await this.input.readQueue();
      this.queue =
        inspection.kind === 'known' ? new QueueIndex(inspection.entries) : null;
    } catch {
      this.queue = null;
    }
    return this.queue !== null;
  }

  /** Cancels ids an earlier failed rollback left behind, if they are still ours. */
  private async releaseOrphans(): Promise<void> {
    const { orphans, gateway } = this.input;
    if (!orphans || !this.queue) {
      return;
    }
    let ids: string[];
    try {
      ids = await orphans.load();
    } catch {
      // Unknown ids may still be scheduled: change nothing this pass.
      this.orphansUnreadable = true;
      this.queue = null;
      return;
    }
    // An id a stored cycle points to is live (adopted or recovered): it is
    // never cancelled here, only dropped from tracking.
    const live = this.liveIds();
    const settled: string[] = [];
    let cancelledAny = false;
    for (const id of ids) {
      if (live.has(id)) {
        settled.push(id);
        continue;
      }
      const entry = this.queue.get(id);
      if (!entry || !isMarkedOwned(entry.owned)) {
        // Gone, or not provably ours (foreign or unmarked look-alike).
        settled.push(id);
        continue;
      }
      try {
        await gateway.cancelScheduled(id);
        settled.push(id);
        cancelledAny = true;
      } catch {
        // Keep tracking it; the next pass retries.
      }
    }
    if (settled.length > 0) {
      await orphans.remove(settled).catch(() => undefined);
    }
    if (cancelledAny) {
      await this.refreshQueue();
    }
  }

  /** Every notification id the stored (current) schedule refers to. */
  private liveIds(): Set<string> {
    const live = new Set<string>();
    for (const alarm of this.alarms) {
      for (const stored of alarm.cycles) {
        live.add(stored.mainAlarmId);
        if (stored.checkInNotificationId) {
          live.add(stored.checkInNotificationId);
        }
      }
    }
    return live;
  }

  private async untrack(ids: readonly string[]): Promise<void> {
    if (ids.length > 0) {
      await this.input.orphans?.remove([...ids]).catch(() => undefined);
    }
  }

  private mark(alarmId: string, status: AlarmQueueStatus): void {
    const current = this.statuses[alarmId];
    if (!current || STATUS_RANK[status] > STATUS_RANK[current]) {
      this.statuses[alarmId] = status;
    }
  }

  private definition(alarmId: string): StoredAlarmDefinition {
    return this.alarms.find((alarm) => alarm.id === alarmId)!;
  }

  private cycleById(alarmId: string, cycleId: string): StoredAlarm | undefined {
    return this.definition(alarmId).cycles.find(
      (cycle) => cycle.cycleId === cycleId,
    );
  }

  private monitored(alarmId: string): StoredAlarm[] {
    const nowMs = this.input.nowMs();
    return this.definition(alarmId)
      .cycles.filter((cycle) => isMonitoring(cycle) && cycle.dueAtMs > nowMs)
      .sort((left, right) => left.dueAtMs - right.dueAtMs);
  }

  private mainExpectation(cycle: StoredAlarm, id = cycle.mainAlarmId) {
    return {
      id,
      kind: MAIN_ALARM_KIND,
      alarmId: cycle.alarmId,
      cycleId: cycle.cycleId,
      atMs: cycle.dueAtMs,
    } satisfies QueueExpectation;
  }

  private checkInExpectation(
    cycle: StoredAlarm,
    id: string,
    mainAlarmId = cycle.mainAlarmId,
  ) {
    return {
      id,
      kind: CHECK_IN_KIND,
      alarmId: cycle.alarmId,
      cycleId: cycle.cycleId,
      mainAlarmId,
      atMs: getCheckInAtMs(cycle.dueAtMs, cycle.armedAtMs),
    } satisfies QueueExpectation;
  }

  /**
   * Cancels an id only when the queue shows this app's own content under it.
   * Absent is already done; foreign content is left alone. Throws when the
   * cancellation cannot be confirmed.
   */
  private async cancelOwned(
    id: string,
    expected: QueueExpectation,
  ): Promise<'cancelled' | 'absent' | 'foreign'> {
    const entry = this.queue?.get(id);
    if (!entry) {
      return 'absent';
    }
    if (!isOwnPayload(entry, expected)) {
      return 'foreign';
    }
    await this.input.gateway.cancelScheduled(id);
    return 'cancelled';
  }

  private async save(
    next: StoredAlarmDefinition[],
    scheduledIds: readonly string[],
  ): Promise<void> {
    try {
      await this.input.checkpoint(next);
    } catch (error) {
      const failures: ScheduledNotificationRollbackFailure[] = [];
      for (const notificationId of scheduledIds) {
        try {
          await this.input.gateway.cancelScheduled(notificationId);
        } catch (cancelError) {
          failures.push({
            notificationId,
            message: messageOf(
              cancelError,
              '予約済み通知を解除できませんでした。',
            ),
          });
        }
      }
      if (failures.length > 0) {
        // Not saved and not cancelled: remember the ids so a later pass can.
        await this.input.orphans
          ?.add(failures.map((failure) => failure.notificationId))
          .catch(() => undefined);
        throw new ScheduledNotificationRollbackError(error, failures);
      }
      throw error;
    }
    this.alarms = next;
  }

  private withCycles(
    alarmId: string,
    update: (cycles: StoredAlarm[]) => StoredAlarm[],
  ): StoredAlarmDefinition[] {
    return this.alarms.map((alarm) =>
      alarm.id === alarmId ? { ...alarm, cycles: update(alarm.cycles) } : alarm,
    );
  }

  private replaceCycle(alarmId: string, next: StoredAlarm) {
    return this.withCycles(alarmId, (cycles) =>
      cycles.map((cycle) => (cycle.cycleId === next.cycleId ? next : cycle)),
    );
  }

  async reconcileAlarm(alarmId: string): Promise<void> {
    if (this.monitored(alarmId).length === 0) {
      return;
    }
    if (!this.queue) {
      this.mark(alarmId, 'unverified');
      return;
    }
    const { canSchedule } = this.input;

    const misaligned = this.monitored(alarmId).filter((cycle) => {
      const definition = this.definition(alarmId);
      return !isDueTimeWallClockAligned(
        cycle.dueAtMs,
        definition.hour,
        definition.minute,
        definition.repeat,
      );
    });
    if (misaligned.length > 0) {
      if (canSchedule) {
        await this.replan(alarmId, misaligned);
      } else {
        this.mark(alarmId, 'missing');
      }
    }

    for (const cycle of this.monitored(alarmId)) {
      if (!this.queue) {
        this.mark(alarmId, 'unverified');
        break;
      }
      // Replaced by a confirmed cycle: only retired, never rebuilt.
      if (this.fresh.has(cycle.cycleId) || this.superseded.has(cycle.cycleId)) {
        continue;
      }
      await this.reconcileCycle(alarmId, cycle);
    }
    // A replacement repaired just above may now allow the old one to go.
    if (canSchedule && this.pairs.has(alarmId)) {
      await this.retire(alarmId);
      this.settleReplan(alarmId);
    }
    this.mark(alarmId, 'verified');
  }

  private async reconcileCycle(
    alarmId: string,
    cycle: StoredAlarm,
  ): Promise<void> {
    const queue = this.queue!;
    const { canSchedule } = this.input;
    const main = queue.match(this.mainExpectation(cycle));
    if (
      main === 'foreign' ||
      main === 'off_schedule' ||
      main === 'unverifiable'
    ) {
      // Not provably ours / not at the stored time: report, do not guess.
      this.mark(alarmId, 'unverified');
      return;
    }
    if (main === 'legacy') {
      // An earlier iOS build's relative reservation: its time cannot be
      // verified, so it is replaced by an absolute one (old kept until then).
      if (canSchedule) {
        await this.repairMain(alarmId, cycle, true);
      } else {
        this.mark(alarmId, 'unverified');
      }
      return;
    }
    if (main === 'absent') {
      if (canSchedule) {
        await this.repairMain(alarmId, cycle);
      } else {
        this.mark(alarmId, 'missing');
      }
      return;
    }
    const checkInAtMs = getCheckInAtMs(cycle.dueAtMs, cycle.armedAtMs);
    let checkInMissing = true;
    if (cycle.checkInNotificationId) {
      const checkIn = queue.match(
        this.checkInExpectation(cycle, cycle.checkInNotificationId),
      );
      if (
        checkIn === 'foreign' ||
        checkIn === 'off_schedule' ||
        checkIn === 'unverifiable'
      ) {
        this.mark(alarmId, 'unverified');
        return;
      }
      if (checkIn === 'legacy') {
        if (checkInAtMs > this.input.nowMs()) {
          if (canSchedule) {
            await this.repairCheckIn(
              alarmId,
              cycle,
              cycle.mainAlarmId,
              true,
              cycle.checkInNotificationId,
            );
          } else {
            this.mark(alarmId, 'unverified');
          }
        }
        return;
      }
      checkInMissing = checkIn === 'absent';
    }
    // A check-in whose time has passed already fired or can no longer help.
    if (checkInMissing && checkInAtMs > this.input.nowMs()) {
      if (canSchedule) {
        await this.repairCheckIn(alarmId, cycle, cycle.mainAlarmId);
      } else {
        this.mark(alarmId, 'check_in_missing');
      }
    }
  }

  /**
   * `legacy`: the stored main exists but is an earlier iOS build's relative
   * reservation. Then the old pair stays pending until the new main is
   * confirmed and the relink is saved; failing early favours the old alarm.
   */
  private async repairMain(
    alarmId: string,
    cycle: StoredAlarm,
    legacy = false,
  ): Promise<void> {
    const { gateway } = this.input;
    const failed: AlarmQueueStatus = legacy ? 'unverified' : 'missing';
    // The ring path owns an occurrence that has come due while we worked.
    if (cycle.dueAtMs <= this.input.nowMs()) {
      return;
    }
    const definition = this.definition(alarmId);
    let mainAlarmId: string | undefined;
    let scheduledNow = false;
    let adopted = false;

    // A crash between scheduling and saving leaves an untracked notification
    // for this very occurrence; adopt it instead of stacking another one.
    const adoptable = this.queue!.findOwned({
      kind: MAIN_ALARM_KIND,
      alarmId,
      cycleId: cycle.cycleId,
      atMs: cycle.dueAtMs,
    }).filter((entry) => entry.id !== cycle.mainAlarmId);
    if (adoptable.length > 0) {
      mainAlarmId = adoptable[0].id;
      adopted = true;
      if (adoptable.length > 1) {
        this.mark(alarmId, 'duplicated');
      }
    } else {
      if (!legacy && !this.queue!.hasRoomFor(1)) {
        await this.freeStaleCheckIn(cycle);
      }
      // Old and new coexist during a migration, so it needs its own slot.
      if (!this.queue!.hasRoomFor(1)) {
        this.mark(alarmId, 'capacity_full');
        return;
      }
      try {
        mainAlarmId = await gateway.scheduleMain({
          alarmId,
          cycleId: cycle.cycleId,
          dueAtMs: cycle.dueAtMs,
          repeats: definition.repeat.kind !== 'today',
        });
      } catch (error) {
        this.issues.push({
          kind: 'main_schedule_failed',
          alarmId,
          cycleId: cycle.cycleId,
          dueAtMs: cycle.dueAtMs,
          message: messageOf(error, 'アラーム通知を再予約できませんでした。'),
        });
        this.mark(alarmId, failed);
        return;
      }
      scheduledNow = true;
      // The OS may report success and still not hold it (or evict it at once).
      const known = await this.refreshQueue();
      if (known) {
        const confirmed = this.queue!.match(
          this.mainExpectation(cycle, mainAlarmId),
        );
        if (confirmed !== 'present') {
          if (confirmed === 'off_schedule') {
            await this.cancelOwned(
              mainAlarmId,
              this.mainExpectation(cycle, mainAlarmId),
            ).catch(() => undefined);
          }
          this.issues.push({
            kind: 'main_schedule_failed',
            alarmId,
            cycleId: cycle.cycleId,
            dueAtMs: cycle.dueAtMs,
            message: '再予約した通知を端末で確認できませんでした。',
          });
          this.mark(alarmId, failed);
          return;
        }
      } else {
        this.mark(alarmId, 'unverified');
      }
    }

    if (legacy) {
      await this.finishLegacyMainMigration(
        alarmId,
        cycle,
        mainAlarmId,
        scheduledNow,
      );
      return;
    }

    // The old check-in names the old main, so confirming through it would be
    // rejected. Cancel that exact id (only if it is still ours); a failure is
    // harmless for the same reason.
    if (cycle.checkInNotificationId) {
      await this.cancelOwned(
        cycle.checkInNotificationId,
        this.checkInExpectation(cycle, cycle.checkInNotificationId),
      ).catch(() => undefined);
    }
    const relinked: StoredAlarm = {
      ...cycle,
      mainAlarmId,
      checkInNotificationId: undefined,
    };
    await this.save(
      this.replaceCycle(alarmId, relinked),
      scheduledNow ? [mainAlarmId] : [],
    );
    if (adopted) {
      await this.untrack([mainAlarmId]);
    }
    this.repaired += 1;
    this.mark(alarmId, 'repaired');
    await this.refreshQueue();
    await this.repairCheckIn(alarmId, relinked, mainAlarmId, false);
  }

  /**
   * Order: new main confirmed (done by the caller) -> old ids tracked ->
   * relink saved -> exact old cancels. A run that stops after the save still
   * finds the old ids in the orphan store; one that stops before it leaves the
   * old pair live and untracked.
   */
  private async finishLegacyMainMigration(
    alarmId: string,
    cycle: StoredAlarm,
    mainAlarmId: string,
    scheduledNow: boolean,
  ): Promise<void> {
    const { orphans } = this.input;
    const oldIds = [cycle.mainAlarmId];
    if (cycle.checkInNotificationId) {
      oldIds.unshift(cycle.checkInNotificationId);
    }
    const dropNew = async () => {
      if (!scheduledNow) {
        return;
      }
      try {
        await this.input.gateway.cancelScheduled(mainAlarmId);
      } catch {
        await orphans?.add([mainAlarmId]).catch(() => undefined);
      }
    };
    // The ring path owns an occurrence that came due while we worked.
    if (this.input.nowMs() >= cycle.dueAtMs) {
      await dropNew();
      this.mark(alarmId, 'unverified');
      return;
    }
    try {
      await orphans?.add(oldIds);
    } catch {
      await dropNew();
      this.mark(alarmId, 'unverified');
      return;
    }
    const relinked: StoredAlarm = {
      ...cycle,
      mainAlarmId,
      checkInNotificationId: undefined,
    };
    try {
      await this.save(
        this.replaceCycle(alarmId, relinked),
        scheduledNow ? [mainAlarmId] : [],
      );
    } catch (error) {
      await this.untrack(oldIds); // the old pair is still the live one
      throw error;
    }
    if (!scheduledNow) {
      await this.untrack([mainAlarmId]);
    }
    this.repaired += 1;
    this.mark(alarmId, 'repaired');
    const settled: string[] = [];
    if (this.input.nowMs() < cycle.dueAtMs) {
      const olds: Array<[string, QueueExpectation]> = [];
      if (cycle.checkInNotificationId) {
        olds.push([
          cycle.checkInNotificationId,
          this.checkInExpectation(cycle, cycle.checkInNotificationId),
        ]);
      }
      olds.push([cycle.mainAlarmId, this.mainExpectation(cycle)]);
      for (const [id, expected] of olds) {
        try {
          await this.cancelOwned(id, expected);
          settled.push(id);
        } catch {
          // Stays tracked; the next pass retries.
        }
      }
    }
    await this.untrack(settled);
    await this.refreshQueue();
    await this.repairCheckIn(alarmId, relinked, mainAlarmId, false);
  }

  /** The stale check-in is ours and useless once its main is gone. */
  private async freeStaleCheckIn(cycle: StoredAlarm): Promise<void> {
    if (!cycle.checkInNotificationId) {
      return;
    }
    try {
      const result = await this.cancelOwned(
        cycle.checkInNotificationId,
        this.checkInExpectation(cycle, cycle.checkInNotificationId),
      );
      if (result === 'cancelled') {
        await this.refreshQueue();
      }
    } catch {
      // Still occupying its slot: the room check below decides.
    }
  }

  private async repairCheckIn(
    alarmId: string,
    cycle: StoredAlarm,
    mainAlarmId: string,
    countsAsRepair = true,
    /** A legacy relative check-in this one replaces (cancelled after the save). */
    replacingId?: string,
  ): Promise<void> {
    const checkInAtMs = getCheckInAtMs(cycle.dueAtMs, cycle.armedAtMs);
    if (checkInAtMs <= this.input.nowMs() || cycle.dueAtMs <= this.input.nowMs()) {
      return;
    }
    if (!this.queue) {
      this.mark(alarmId, 'unverified');
      return;
    }
    let checkInNotificationId: string;
    let scheduledNow = false;
    let adopted = false;
    const adoptable = this.queue
      .findOwned({
        kind: CHECK_IN_KIND,
        alarmId,
        cycleId: cycle.cycleId,
        mainAlarmId,
        atMs: checkInAtMs,
      })
      .filter((entry) => entry.id !== cycle.checkInNotificationId);
    if (adoptable.length > 0) {
      checkInNotificationId = adoptable[0].id;
      adopted = true;
    } else {
      if (!this.queue.hasRoomFor(1)) {
        this.mark(alarmId, 'capacity_full');
        return;
      }
      try {
        checkInNotificationId = await this.input.gateway.scheduleCheckIn({
          alarmId,
          cycleId: cycle.cycleId,
          mainAlarmId,
          checkInAtMs,
        });
      } catch (error) {
        this.issues.push({
          kind: 'check_in_schedule_failed',
          alarmId,
          cycleId: cycle.cycleId,
          dueAtMs: cycle.dueAtMs,
          mainAlarmId,
          message: messageOf(error, '起床確認通知を再予約できませんでした。'),
        });
        this.mark(alarmId, replacingId ? 'unverified' : 'check_in_missing');
        return;
      }
      scheduledNow = true;
      if (await this.refreshQueue()) {
        const confirmed = this.queue!.match(
          this.checkInExpectation(cycle, checkInNotificationId, mainAlarmId),
        );
        if (confirmed !== 'present') {
          this.mark(alarmId, replacingId ? 'unverified' : 'check_in_missing');
          return;
        }
      } else {
        this.mark(alarmId, 'unverified');
      }
    }
    if (replacingId) {
      try {
        await this.input.orphans?.add([replacingId]);
      } catch {
        this.mark(alarmId, 'unverified');
        return;
      }
    }
    try {
      await this.save(
        this.replaceCycle(alarmId, { ...cycle, checkInNotificationId }),
        scheduledNow ? [checkInNotificationId] : [],
      );
    } catch (error) {
      if (replacingId) {
        await this.untrack([replacingId]); // still the live check-in
      }
      throw error;
    }
    if (adopted) {
      await this.untrack([checkInNotificationId]);
    }
    if (replacingId) {
      try {
        await this.cancelOwned(
          replacingId,
          this.checkInExpectation(cycle, replacingId, mainAlarmId),
        );
        await this.untrack([replacingId]);
      } catch {
        // Stays tracked; the next pass retries.
      }
      await this.refreshQueue();
    }
    if (countsAsRepair) {
      this.repaired += 1;
    }
    this.mark(alarmId, 'repaired');
  }

  /**
   * Replaces occurrences planned for another time zone, one old occurrence at
   * a time. Slots held by a suppressed / dismissed / ringing occurrence stay
   * empty. The pairing old -> replacement is explicit, so a run that stopped
   * half way is finished by the next one without creating a second copy.
   */
  private async replan(
    alarmId: string,
    misaligned: StoredAlarm[],
  ): Promise<void> {
    const definition = this.definition(alarmId);
    const nowMs = this.input.nowMs();
    const misalignedIds = new Set(misaligned.map((cycle) => cycle.cycleId));
    const kept = definition.cycles.filter(
      (cycle) => !misalignedIds.has(cycle.cycleId),
    );
    const terminalFuture = kept.filter(
      (cycle) => cycle.dueAtMs > nowMs && !isMonitoring(cycle),
    ).length;
    let expected: number[] = [];
    try {
      expected = getUpcomingAlarmTimes(
        nowMs,
        definition.hour,
        definition.minute,
        definition.repeat,
        SCHEDULED_OCCURRENCES_PER_ALARM + terminalFuture,
      );
    } catch {
      return;
    }
    if (expected.length === 0) {
      // Today-only whose anchored wall-clock time has passed: the original
      // reservation is all that is left, so it is kept rather than moved.
      return;
    }
    const blocked = new Set(
      kept.filter((cycle) => !isMonitoring(cycle)).map((cycle) => cycle.dueAtMs),
    );
    const slots = expected
      .filter((dueAtMs) => !blocked.has(dueAtMs))
      .slice(0, misaligned.length);
    const oldest = [...misaligned].sort(
      (left, right) => left.dueAtMs - right.dueAtMs,
    );
    this.pairs.set(
      alarmId,
      oldest.map((old, index) => {
        const slot = slots[index];
        const occupant =
          slot === undefined
            ? undefined
            : kept.find(
                (cycle) => isMonitoring(cycle) && cycle.dueAtMs === slot,
              );
        return {
          oldCycleId: old.cycleId,
          replacementCycleId: occupant?.cycleId ?? null,
          slot,
        };
      }),
    );

    for (const pair of this.pairs.get(alarmId)!) {
      if (!this.queue) {
        break;
      }
      if (pair.replacementCycleId === null) {
        if (pair.slot === undefined) {
          continue; // surplus: retired once every pair has been
        }
        const created = await this.createReplacement(alarmId, pair.slot);
        if (created === 'stop') {
          break;
        }
        pair.replacementCycleId = created;
      }
      await this.retirePair(alarmId, pair);
    }
    await this.retire(alarmId);
    this.settleReplan(alarmId);
  }

  /** Reserves one new pair for a slot. Returns its cycle id, or 'stop'. */
  private async createReplacement(
    alarmId: string,
    dueAtMs: number,
  ): Promise<string | 'stop'> {
    const definition = this.definition(alarmId);
    if (dueAtMs <= this.input.nowMs()) {
      return 'stop';
    }
    // main + check-in must both fit; foreign entries count as well.
    if (!this.queue!.hasRoomFor(2)) {
      this.mark(alarmId, 'capacity_full');
      return 'stop';
    }
    const cycleId = (this.input.makeCycleId ?? defaultCycleId)();
    const armedAtMs = this.input.nowMs();
    let created: StoredAlarm;
    try {
      const scheduled = await scheduleAlarmNotificationsFailSafe(
        this.input.gateway,
        {
          alarmId,
          cycleId,
          dueAtMs,
          checkInAtMs: getCheckInAtMs(dueAtMs, armedAtMs),
          repeats: definition.repeat.kind !== 'today',
        },
      );
      created = {
        alarmId,
        cycleId,
        mainAlarmId: scheduled.mainAlarmId,
        checkInNotificationId: scheduled.checkInNotificationId,
        armedAtMs,
        dueAtMs,
        phase: 'armed',
        stepCount: 0,
        stepCandidateRecorded: false,
      };
      if (scheduled.checkInWarning) {
        this.issues.push({
          kind: 'check_in_schedule_failed',
          alarmId,
          cycleId,
          dueAtMs,
          mainAlarmId: scheduled.mainAlarmId,
          message: scheduled.checkInWarning,
        });
        this.mark(alarmId, 'check_in_missing');
      }
    } catch (error) {
      this.issues.push({
        kind: 'main_schedule_failed',
        alarmId,
        cycleId,
        dueAtMs,
        message: messageOf(error, 'アラーム通知を再予約できませんでした。'),
      });
      // Keep every old occurrence: ringing at the old time beats not ringing.
      // settleReplan reports it as missing or duplicated.
      return 'stop';
    }
    await this.save(
      this.withCycles(alarmId, (cycles) => [...cycles, created]),
      [created.mainAlarmId, created.checkInNotificationId].filter(
        (id): id is string => typeof id === 'string',
      ),
    );
    this.fresh.add(created.cycleId);
    this.replanned += 1;
    // Tracked from here on, so a failed confirmation leaves nothing orphaned.
    if (!(await this.refreshQueue())) {
      this.mark(alarmId, 'unverified');
      return 'stop';
    }
    return created.cycleId;
  }

  /** Is the replacement really held by the OS (main, and check-in if any)? */
  private replacementConfirmed(alarmId: string, cycleId: string): boolean {
    const replacement = this.cycleById(alarmId, cycleId);
    if (!replacement || !this.queue) {
      return false;
    }
    return this.queue.match(this.mainExpectation(replacement)) === 'present';
  }

  private async retirePair(
    alarmId: string,
    pair: ReplacementPair,
  ): Promise<void> {
    const old = this.cycleById(alarmId, pair.oldCycleId);
    if (!old || pair.replacementCycleId === null) {
      return;
    }
    if (!this.replacementConfirmed(alarmId, pair.replacementCycleId)) {
      return; // old stays; settleReplan reports it
    }
    this.superseded.add(old.cycleId);
    await this.cancelAndDrop(alarmId, old);
  }

  /**
   * Cancels the old pair by the exact stored ids, only while its due time is
   * still ahead, and only then drops it. Not verified gone -> still tracked.
   */
  private async cancelAndDrop(
    alarmId: string,
    old: StoredAlarm,
  ): Promise<void> {
    if (this.input.nowMs() >= old.dueAtMs) {
      return; // the ring path owns an occurrence that came due meanwhile
    }
    let foreign = false;
    try {
      if (old.checkInNotificationId) {
        const result = await this.cancelOwned(
          old.checkInNotificationId,
          this.checkInExpectation(old, old.checkInNotificationId),
        );
        foreign = foreign || result === 'foreign';
      }
      if (this.input.nowMs() >= old.dueAtMs) {
        return;
      }
      const result = await this.cancelOwned(
        old.mainAlarmId,
        this.mainExpectation(old),
      );
      foreign = foreign || result === 'foreign';
    } catch {
      return; // not verified gone: keep tracking it; the next pass retries
    }
    if (foreign) {
      this.mark(alarmId, 'unverified');
    }
    await this.save(
      this.withCycles(alarmId, (cycles) =>
        cycles
          .filter((cycle) => cycle.cycleId !== old.cycleId)
          .sort((left, right) => left.dueAtMs - right.dueAtMs),
      ),
      [],
    );
    this.superseded.delete(old.cycleId);
    await this.refreshQueue();
  }

  /** Retires every old cycle whose replacement is confirmed (or surplus). */
  private async retire(alarmId: string): Promise<void> {
    const pairs = this.pairs.get(alarmId) ?? [];
    for (const pair of pairs) {
      if (pair.replacementCycleId !== null) {
        await this.retirePair(alarmId, pair);
      }
    }
    const allPairedDone = pairs
      .filter((pair) => pair.replacementCycleId !== null)
      .every((pair) => !this.cycleById(alarmId, pair.oldCycleId));
    if (!allPairedDone) {
      return;
    }
    for (const pair of pairs) {
      const old = this.cycleById(alarmId, pair.oldCycleId);
      if (old && pair.slot === undefined && pairs.some((p) => p.replacementCycleId !== null)) {
        await this.cancelAndDrop(alarmId, old);
      }
    }
  }

  /** Final status of a replan: finished, or honestly duplicated / missing. */
  private settleReplan(alarmId: string): void {
    const pairs = this.pairs.get(alarmId) ?? [];
    const remaining = pairs.filter((pair) =>
      this.cycleById(alarmId, pair.oldCycleId),
    );
    if (remaining.length === 0) {
      this.pairs.delete(alarmId);
      this.mark(alarmId, 'repaired');
      return;
    }
    const anyReplacement = pairs.some(
      (pair) =>
        pair.replacementCycleId !== null &&
        this.replacementConfirmed(alarmId, pair.replacementCycleId),
    );
    this.mark(alarmId, anyReplacement ? 'duplicated' : 'missing');
  }
}

function defaultCycleId(): string {
  return `cycle-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export interface AbortedReconciliation {
  /** The latest durable state, or null when it could not be read back. */
  alarms: StoredAlarmDefinition[] | null;
  statuses: Record<string, AlarmQueueStatus>;
  /** Scheduled ids that a failed save could neither keep nor cancel. */
  unrecoveredNotificationIds: string[];
}

/**
 * After a reconciliation threw half way, earlier checkpoints are already on
 * disk. The caller's copy is stale, so the durable state is read back before
 * anything (such as a refill) works from it again.
 */
export async function recoverAbortedReconciliation(
  error: unknown,
  loadDurable: () => Promise<StoredAlarmDefinition[]>,
  knownAlarms: readonly StoredAlarmDefinition[],
): Promise<AbortedReconciliation> {
  let alarms: StoredAlarmDefinition[] | null = null;
  try {
    alarms = await loadDurable();
  } catch {
    alarms = null;
  }
  const statuses: Record<string, AlarmQueueStatus> = {};
  for (const alarm of alarms ?? knownAlarms) {
    if (alarm.enabled) {
      statuses[alarm.id] = 'unverified';
    }
  }
  return {
    alarms,
    statuses,
    unrecoveredNotificationIds:
      error instanceof ScheduledNotificationRollbackError
        ? error.failures.map((failure) => failure.notificationId)
        : [],
  };
}

export interface ReconcileSummaryInput {
  statuses: Record<string, AlarmQueueStatus>;
  repaired: number;
  replanned: number;
  zoneChanged: boolean;
  unrecoveredNotificationIds?: readonly string[];
  /** The orphan journal could not be read, so leftover ids are unknown. */
  orphansUnreadable?: boolean;
  /** False when the OS queue was not read; omitted means not reported. */
  queueVerified?: boolean;
}

export interface ReconcileSummary {
  notice: { tone: 'warning' | 'danger'; text: string } | null;
  /** Problems still open, so the same notice is not repeated every return. */
  problemKeys: string[];
}

/** Picks the single most important thing to tell the user after a pass. */
export function summarizeReconciliation(
  input: ReconcileSummaryInput,
): ReconcileSummary {
  const open = Object.entries(input.statuses).filter(
    ([, status]) =>
      status === 'missing' ||
      status === 'capacity_full' ||
      status === 'unverified' ||
      status === 'duplicated' ||
      status === 'check_in_missing',
  );
  const problemKeys = open.map(([alarmId, status]) => `queue_${status}:${alarmId}`);
  if ((input.unrecoveredNotificationIds ?? []).length > 0) {
    problemKeys.push('queue_unrecovered_notifications');
    return {
      problemKeys,
      notice: {
        tone: 'danger',
        text: '保存できなかった予約のうち、端末から解除できていない通知があります。次回の起動時に解除を再試行します。',
      },
    };
  }
  if (input.orphansUnreadable) {
    problemKeys.push('queue_orphans_unreadable');
    return {
      problemKeys,
      notice: {
        tone: 'danger',
        text: '解除できていない通知の記録を読めないため、新しい予約の追加を止めています。アラームの状態を確認してください。',
      },
    };
  }
  if (input.queueVerified === false && !problemKeys.some((key) => key.startsWith('queue_unverified'))) {
    problemKeys.push('queue_unverified');
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: '端末の通知予約を確認できません。アラームが鳴る保証がないため、各アラームの状態を確認してください。',
      },
    };
  }
  const hasStatus = (wanted: AlarmQueueStatus) =>
    open.some(([, status]) => status === wanted);

  if (hasStatus('capacity_full')) {
    return {
      problemKeys,
      notice: {
        tone: 'danger',
        text: '端末の通知予約が上限(64件)に近く、アラームを再予約できませんでした。不要な通知を整理してから開き直してください。',
      },
    };
  }
  if (hasStatus('missing')) {
    return {
      problemKeys,
      notice: {
        tone: 'danger',
        text: '端末に通知が見つからないアラームがあり、再予約できませんでした。各アラームの状態を確認してください。',
      },
    };
  }
  if (hasStatus('unverified')) {
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: '端末の通知予約を確認できません。アラームが鳴る保証がないため、各アラームの状態を確認してください。',
      },
    };
  }
  if (hasStatus('duplicated')) {
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: '古い時刻と新しい時刻の予約が両方残っているため、同じアラームが2回鳴る可能性があります。',
      },
    };
  }
  if (hasStatus('check_in_missing')) {
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: '一部の起床確認通知を再予約できませんでした。',
      },
    };
  }
  if (input.replanned > 0) {
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: input.zoneChanged
          ? 'タイムゾーンの変更に合わせて、今後のアラーム予約を組み直しました。'
          : '時刻の変更に合わせて、今後のアラーム予約を組み直しました。',
      },
    };
  }
  if (input.repaired > 0) {
    return {
      problemKeys,
      notice: {
        tone: 'warning',
        text: '端末から消えていたアラーム通知を再予約しました。',
      },
    };
  }
  return { notice: null, problemKeys };
}
