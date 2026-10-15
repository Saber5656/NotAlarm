import type { StoredAlarmDefinition } from '../../alarmStorage';
import { didPlanningZoneChange, currentPlanningZone } from '../../planningZone';
import type { ScheduleReconcileResult } from '../../reconcileGate';
import {
  canAdvancePlanningZone,
  recoverAbortedReconciliation,
  type ReconcileGateway,
  type ReconcileOutcome,
  type reconcileAlarmSchedules,
} from '../../scheduleReconciliation';
import { isStaleStorageResult } from '../../storageResetGate';

type ReconcileInput = Parameters<typeof reconcileAlarmSchedules>[0];

export interface QueueReconcilerDeps {
  /** False on the web build, which has no notification queue to compare. */
  isSupported: boolean;
  nowMs(): number;
  /** The suppression journal lock: the outermost lock of every stop/cancel. */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  hasPendingReset(): Promise<boolean>;
  assertNoPendingReset(): Promise<void>;
  gateway: ReconcileGateway;
  /** Ids held only in memory become durable (or are cancelled) first. */
  flushUnresolved(): Promise<void>;
  /** Settles the main ids this pass registered and never checkpointed. */
  abandonProvisional(mainIds: readonly string[]): void;
  prepareNotificationsIfGranted(): Promise<boolean>;
  loadPlanningZone(): Promise<string | null>;
  savePlanningZone(zone: string): Promise<void>;
  storage: {
    transact(
      transaction: (
        alarms: StoredAlarmDefinition[],
        checkpoint: (next: StoredAlarmDefinition[]) => Promise<void>,
      ) => StoredAlarmDefinition[] | Promise<StoredAlarmDefinition[]>,
    ): Promise<StoredAlarmDefinition[]>;
    load(): Promise<StoredAlarmDefinition[]>;
  };
  loadPendingAlarmCancellations(): Promise<ReadonlyArray<{ alarmId: string }>>;
  loadPendingAlarmEdits(): Promise<ReadonlyArray<{ alarmId: string }>>;
  loadSuppressionIntents(): Promise<ReadonlyArray<{ alarmId: string }>>;
  readQueue: ReconcileInput['readQueue'];
  orphans: ReconcileInput['orphans'];
  reconcileSchedules: typeof reconcileAlarmSchedules;
}

/**
 * Compares the stored future schedule with the OS queue and repairs it.
 * Lock order is fixed: the suppression lock (a stop in progress), then the
 * storage queue (user cancels and refills), and only inside that turn the OS
 * queue is read, so the snapshot cannot go stale against a cancellation.
 * Alarms with an unfinished cancel, stop or edit are excluded and never
 * recreated.
 */
async function reconcileScheduleWithQueueOnce(
  deps: QueueReconcilerDeps,
  knownAlarms: readonly StoredAlarmDefinition[],
): Promise<ScheduleReconcileResult | null> {
  if (!deps.isSupported) {
    return null;
  }
  const zone = currentPlanningZone();
  // Main ids this pass registered. Each stays on the write-ahead record until
  // the pass saves its checkpoint or confirms the cancel; whatever is still
  // unsettled when the pass ends (an early failure) turns into a plain record
  // that blocks new reservations until the next reconciliation resolves it.
  const registered: string[] = [];
  const passGateway: ReconcileGateway = {
    ...deps.gateway,
    scheduleMain: async (input) => {
      const id = await deps.gateway.scheduleMain(input);
      registered.push(id);
      return id;
    },
  };
  try {
    return await deps.exclusive(async () => {
      if (await deps.hasPendingReset()) {
        // An unfinished reset owns the notifications: touch nothing.
        return {
          alarms: null,
          statuses: {},
          repaired: 0,
          replanned: 0,
          zoneChanged: false,
          unrecoveredNotificationIds: [],
          aborted: false,
          queueVerified: false,
          orphansUnreadable: false,
        };
      }
      // Ids held only in memory become durable (or are cancelled) first.
      await deps.flushUnresolved();
      let canSchedule = false;
      try {
        canSchedule = await deps.prepareNotificationsIfGranted();
      } catch {
        canSchedule = false;
      }
      const storedZone = await deps.loadPlanningZone();
      const zoneChanged = didPlanningZoneChange(storedZone, zone);
      let outcome: ReconcileOutcome | null = null;
      let excludedForGate: ReadonlySet<string> = new Set();
      const alarms = await deps.storage.transact(async (current, checkpoint) => {
        await deps.assertNoPendingReset();
        const excludedAlarmIds = new Set(
          (await deps.loadPendingAlarmCancellations()).map(
            (pending) => pending.alarmId,
          ),
        );
        for (const pending of await deps.loadSuppressionIntents()) {
          excludedAlarmIds.add(pending.alarmId);
        }
        // An unsettled edit owns its alarm: the old reservation must not be
        // rebuilt and the new one must not be judged until recovery ends.
        for (const pending of await deps.loadPendingAlarmEdits()) {
          excludedAlarmIds.add(pending.alarmId);
        }
        excludedForGate = excludedAlarmIds;
        outcome = await deps.reconcileSchedules({
          alarms: current,
          excludedAlarmIds,
          readQueue: deps.readQueue,
          orphans: deps.orphans,
          originZone: storedZone,
          // Checked against the real planning clock when the plan is made.
          currentZone: zone,
          canSchedule,
          nowMs: deps.nowMs,
          gateway: passGateway,
          checkpoint,
        });
        return outcome.alarms;
      });
      const done = outcome as ReconcileOutcome | null;
      const statuses = done?.statuses ?? {};
      // The stored zone is the origin of every stopped occurrence that has no
      // identity of its own. It moves only when each alarm was really
      // reconciled (an empty result proves nothing) and no excluded alarm or
      // unstamped evidence still depends on the old one, and only while the
      // device is still in the zone this run planned for.
      const settled =
        canAdvancePlanningZone({
          outcome: done,
          excludedAlarmIds: excludedForGate,
          nowMs: deps.nowMs(),
        }) && currentPlanningZone() === zone;
      if (settled && !isStaleStorageResult(alarms)) {
        // Remembered only once the schedule matches this zone.
        await deps.savePlanningZone(zone).catch(() => undefined);
      }
      return {
        alarms,
        statuses,
        repaired: done?.repaired ?? 0,
        replanned: done?.replanned ?? 0,
        zoneChanged,
        unrecoveredNotificationIds: [],
        aborted: false,
        queueVerified: done?.queueKnown ?? false,
        orphansUnreadable: done?.orphansUnreadable ?? false,
        pendingOrphanIds: done?.pendingOrphanIds ?? [],
      };
    });
  } catch (error) {
    // A journal, storage or save failed part way. Earlier checkpoints are on
    // disk, so the durable state is read back instead of trusting the caller's
    // copy; ids a failed rollback could not cancel are reported and tracked.
    const aborted = await recoverAbortedReconciliation(
      error,
      deps.storage.load,
      knownAlarms,
    );
    return {
      alarms: aborted.alarms,
      statuses: aborted.statuses,
      repaired: 0,
      replanned: 0,
      zoneChanged: false,
      unrecoveredNotificationIds: aborted.unrecoveredNotificationIds,
      aborted: true,
      queueVerified: false,
      orphansUnreadable: false,
    };
  } finally {
    deps.abandonProvisional(registered);
  }
}

/** Concurrent callers (startup, foreground, repeated taps) share one run. */
export function createQueueReconciler(
  deps: QueueReconcilerDeps,
): (
  knownAlarms: readonly StoredAlarmDefinition[],
) => Promise<ScheduleReconcileResult | null> {
  let inFlight: Promise<ScheduleReconcileResult | null> | null = null;

  return function reconcileScheduleWithQueue(knownAlarms) {
    if (inFlight) {
      return inFlight;
    }
    const run = reconcileScheduleWithQueueOnce(deps, knownAlarms).finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
