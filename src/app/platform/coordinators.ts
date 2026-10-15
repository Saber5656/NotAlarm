import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import {
  loadAlarmDefinitions,
  loadPendingAlarmCancellations,
  loadPendingAlarmEdits,
  loadStoredAlarmByCycleId,
  mutateAlarmDefinitions,
  saveStoredAlarm,
  transactAlarmDefinitions,
} from '../../alarmStorage';
import {
  cancelNotificationIfPresent,
  listScheduledNotificationIds,
  prepareNotifications,
  prepareNotificationsIfGranted,
  readScheduledNotificationQueue,
} from '../../notificationService';
import { loadPlanningZone, savePlanningZone } from '../../planningZone';
import { reconcileAlarmSchedules } from '../../scheduleReconciliation';
import {
  assertNoPendingReset,
} from '../../storageResetGate';
import { suppressionJournal } from '../../suppressionJournalStorage';
import {
  createQueueReconciler,
} from '../core/queueReconciler';
import {
  createRefillCoordinator,
  type RefillCoordinator,
} from '../core/refillCoordinator';
import { createSuppressionReconciler } from '../core/suppressionReconciler';
import {
  cancellationGateway,
  orphanStore,
  reconcileGateway,
  schedulingGateway,
  storageReset,
} from './gateways';

/** Settles half-finished stops. One shared run across every caller. */
export const reconcileSuppressions = createSuppressionReconciler({
  journal: suppressionJournal,
  loadAlarm: loadStoredAlarmByCycleId,
  saveAlarm: async (cycle) => {
    await saveStoredAlarm(cycle);
  },
  listScheduledIds: listScheduledNotificationIds,
  cancelCheckIn: cancelNotificationIfPresent,
});

/** Compares the stored schedule with the OS queue. One shared run. */
export const reconcileScheduleWithQueue = createQueueReconciler({
  isSupported: Platform.OS !== 'web',
  nowMs: Date.now,
  exclusive: (run) => suppressionJournal.exclusive(run),
  hasPendingReset: () => storageReset.hasPendingReset(),
  assertNoPendingReset,
  gateway: reconcileGateway,
  flushUnresolved: () => schedulingGateway.flushUnresolved(),
  abandonProvisional: (ids) => schedulingGateway.abandonProvisional([...ids]),
  prepareNotificationsIfGranted,
  loadPlanningZone: () => loadPlanningZone(AsyncStorage),
  savePlanningZone: (zone) => savePlanningZone(AsyncStorage, zone),
  storage: {
    transact: transactAlarmDefinitions,
    load: loadAlarmDefinitions,
  },
  loadPendingAlarmCancellations,
  loadPendingAlarmEdits,
  loadSuppressionIntents: () => suppressionJournal.load(),
  readQueue: readScheduledNotificationQueue,
  orphans: orphanStore,
  reconcileSchedules: reconcileAlarmSchedules,
});

/** One refill coordinator per mounted app: it owns the refill single flight. */
export function createAlarmRefillCoordinator(): RefillCoordinator {
  return createRefillCoordinator({
    isSupported: Platform.OS !== 'web',
    nowMs: Date.now,
    scheduling: schedulingGateway,
    cancellation: cancellationGateway,
    orphans: orphanStore,
    storage: { mutate: mutateAlarmDefinitions },
    prepareNotifications,
    prepareNotificationsIfGranted,
    loadPendingAlarmCancellations,
    loadPendingAlarmEdits,
    loadSuppressionIntents: () => suppressionJournal.load(),
    hasPendingReset: () => storageReset.hasPendingReset(),
    loadPlanningZone: () => loadPlanningZone(AsyncStorage),
  });
}
