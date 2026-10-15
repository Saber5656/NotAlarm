import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AlarmEditJournal } from '../../alarmEdit';
import {
  loadPendingAlarmEdits,
  loadStoredAlarmByCycleId,
  removePendingAlarmEdit,
  runExclusiveAlarmStorage,
  savePendingAlarmEdit,
  saveStoredAlarm,
  transactAlarmDefinitions,
} from '../../alarmStorage';
import { withMainVerification } from '../../mainAlarmVerification';
import {
  cancelNotificationIfPresent,
  cancelScheduledNotificationById,
  dismissDeliveredNotification,
  installForegroundNotificationHandler,
  listPresentedNotificationSnapshots,
  listScheduledNotificationIds,
  listScheduledNotificationSnapshots,
  scheduleCheckInNotification,
  scheduleMainAlarmNotification,
  scheduleSnoozeNotification,
} from '../../notificationService';
import { createOrphanStore } from '../../orphanedNotifications';
import type { ReconcileGateway } from '../../scheduleReconciliation';
import { createSnoozeService } from '../../snooze';
import { createSnoozeTransaction } from '../../snoozeTransaction';
import { createStorageResetService } from '../../storageReset';
import {
  advanceStorageEpoch,
  assertNoPendingReset,
  installStorageResetGate,
} from '../../storageResetGate';
import { suppressionJournal } from '../../suppressionJournalStorage';

// Module initialisation is the one place the native edges are armed: the
// foreground notification handler and the storage reset gate are installed
// exactly once, when the first importer evaluates this module.
installForegroundNotificationHandler();

export const orphanStore = createOrphanStore(AsyncStorage);

// A main alarm only counts as reserved once the OS lists it. An id that could
// not be verified is journaled (cancelled by reconciliation or reset), and new
// reservations wait until it is resolved.
export const schedulingGateway = withMainVerification(
  {
    scheduleMain: scheduleMainAlarmNotification,
    scheduleCheckIn: scheduleCheckInNotification,
  },
  listScheduledNotificationIds,
  { orphans: orphanStore, cancelScheduled: cancelNotificationIfPresent },
);

// Snooze and stop of a ringing occurrence share one queue, so a double press
// or a stop racing a snooze cannot schedule or count twice.
export const snoozeService = createSnoozeService({
  gateway: {
    listScheduledIds: listScheduledNotificationIds,
    schedule: scheduleSnoozeNotification,
    cancelScheduled: cancelNotificationIfPresent,
    dismissDelivered: dismissDeliveredNotification,
  },
  // Not used directly: every operation runs inside `transact`, which gives it
  // a store local to one transaction, so nothing waits on its own queue.
  store: {
    load: loadStoredAlarmByCycleId,
    save: async (cycle) => {
      await saveStoredAlarm(cycle);
    },
  },
  // Same order as stop, edit and deletion: suppression lock, then storage turn.
  transact: createSnoozeTransaction({
    exclusive: (run) => suppressionJournal.exclusive(run),
    transact: transactAlarmDefinitions,
  }),
  nowMs: Date.now,
  makeId: () =>
    `snooze-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
});

// Order matches the stop path: the suppression journal lock, then the
// definition/cancellation queues. Only the recovery card and the settings sheet call reset(), each after an
// explicit two-step confirmation.
export const storageReset = createStorageResetService({
  store: AsyncStorage,
  gateway: {
    listScheduled: listScheduledNotificationSnapshots,
    cancelScheduled: cancelScheduledNotificationById,
    listPresented: listPresentedNotificationSnapshots,
    dismissPresented: (id) => dismissDeliveredNotification(id),
  },
  exclusive: (run) =>
    suppressionJournal.exclusive(() => runExclusiveAlarmStorage(run)),
  nowMs: Date.now,
  // Ids only memory remembers (the snooze service's unsettled ids, main ids the
  // OS returned but could not be verified or journaled) are cancelled with the
  // stored ones, and forgotten only once the deletion confirmed everything gone.
  extraKnownIds: () => [
    ...new Set([
      ...snoozeService.unsettledIds(),
      ...schedulingGateway.unresolvedMainIds(),
    ]),
  ],
  onCompleted: () => {
    advanceStorageEpoch();
    snoozeService.forgetUnsettled();
    // The reset confirmed every owned notification cancelled, held ids included.
    schedulingGateway.clearUnresolved();
  },
});
// Every alarm write and reservation re-checks this inside the storage locks.
installStorageResetGate(() => storageReset.hasPendingReset());

// The sun preference shares the alarm storage lock and the reset gate, so a
// late save cannot interleave with a deletion or refill deleted data.
export const sunStorageCoordination = {
  exclusive: <T,>(run: () => Promise<T>) =>
    suppressionJournal.exclusive(() => runExclusiveAlarmStorage(run)),
  assertWritable: assertNoPendingReset,
};

export const cancellationGateway = {
  cancelScheduled: cancelNotificationIfPresent,
  dismissDelivered: dismissDeliveredNotification,
};

export const alarmEditJournal: AlarmEditJournal = {
  load: loadPendingAlarmEdits,
  save: savePendingAlarmEdit,
  remove: removePendingAlarmEdit,
};

export const alarmEditGateway = {
  ...schedulingGateway,
  cancelScheduled: cancelNotificationIfPresent,
  listScheduledIds: listScheduledNotificationIds,
};

export const reconcileGateway: ReconcileGateway = {
  scheduleMain: schedulingGateway.scheduleMainForReconcile,
  scheduleCheckIn: schedulingGateway.scheduleCheckIn,
  cancelScheduled: cancelNotificationIfPresent,
  releaseMain: (ids) => schedulingGateway.releaseProvisional(ids),
};
