import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  ALREADY_UP_OWNER,
  AWAKE_CHECKIN_CATEGORY,
  CHECK_IN_KIND,
  CONFIRM_AWAKE_ACTION,
  MAIN_ALARM_KIND,
  parseAlarmNotificationData,
  type AlarmNotificationData,
} from './alarmContracts';
import type { ScheduledNotificationSnapshot } from './alarmNotificationOwnership';
import {
  SNOOZE_NOTIFICATION_BODY,
  SNOOZE_NOTIFICATION_TITLE,
  getMainAlarmNotificationBody,
} from './alarmNotificationContent';
import {
  describeScheduledRequest,
  type QueueInspection,
} from './queueInspection';
import { toUtcCalendarFields } from './notificationTrigger';
import {
  resolveNotificationDelivery,
  type NotificationDeliveryState,
} from './notificationDelivery';

const ALARM_CHANNEL_ID = 'already-up-alarm';
const CHECK_IN_CHANNEL_ID = 'already-up-check-in';

export function installForegroundNotificationHandler(): void {
  if (Platform.OS === 'web') {
    return;
  }

  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const kind = notification.request.content.data?.kind;
      const isMainAlarm = kind === MAIN_ALARM_KIND;

      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: isMainAlarm,
        shouldSetBadge: false,
        priority: isMainAlarm
          ? Notifications.AndroidNotificationPriority.MAX
          : Notifications.AndroidNotificationPriority.DEFAULT,
      };
    },
  });
}

export async function prepareNotifications(): Promise<void> {
  if (Platform.OS === 'web') {
    throw new Error('通知を使うにはiPhoneまたはAndroid実機が必要です。');
  }

  const currentPermission = await Notifications.getPermissionsAsync();
  const permission =
    currentPermission.status === 'granted'
      ? currentPermission
      : await Notifications.requestPermissionsAsync();

  if (permission.status !== 'granted') {
    throw new Error(
      '通知が許可されていません。設定アプリで通知をオンにしてください。',
    );
  }

  await registerAlarmNotificationTypes();
}

/**
 * Like prepareNotifications, but never shows the permission prompt, so it can
 * run whenever the app returns to the foreground. Returns false when
 * notifications are not currently allowed.
 */
export async function prepareNotificationsIfGranted(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    return false;
  }

  await registerAlarmNotificationTypes();
  return true;
}

async function registerAlarmNotificationTypes(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(
    AWAKE_CHECKIN_CATEGORY,
    [
      {
        identifier: CONFIRM_AWAKE_ACTION,
        buttonTitle: '起きています',
        options: {
          isAuthenticationRequired: false,
          opensAppToForeground: false,
        },
      },
    ],
    {
      previewPlaceholder: '起床確認',
    },
  );

  if (Platform.OS === 'android') {
    await Promise.all([
      Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: 'アラーム',
        importance: Notifications.AndroidImportance.MAX,
        audioAttributes: {
          usage: Notifications.AndroidAudioUsage.ALARM,
        },
        enableVibrate: true,
        vibrationPattern: [0, 500, 250, 500],
        sound: 'default',
      }),
      Notifications.setNotificationChannelAsync(CHECK_IN_CHANNEL_ID, {
        name: '起床確認',
        importance: Notifications.AndroidImportance.DEFAULT,
        enableVibrate: false,
        sound: null,
      }),
    ]);
  }
}

/**
 * Reads the current permission (and, on Android, the main alarm channel) without prompting. A failed read is reported as
 * 'unknown' so the UI never assumes the alarm can ring.
 */
export async function readNotificationDelivery(): Promise<NotificationDeliveryState> {
  return resolveNotificationDelivery({
    platform: Platform.OS,
    platformVersion: Platform.Version,
    mainChannelId: ALARM_CHANNEL_ID,
    getPermissions: () => Notifications.getPermissionsAsync(),
    getChannel: (id) => Notifications.getNotificationChannelAsync(id),
  });
}

/**
 * Android keeps an absolute DATE trigger. On iOS a DATE input is turned into a
 * relative time interval that cannot be read back, so an explicit UTC calendar
 * trigger (rounded up to the second) is used and can be verified later.
 */
function dateTrigger(dateMs: number, channelId: string) {
  if (Platform.OS === 'ios') {
    return {
      type: Notifications.SchedulableTriggerInputTypes.CALENDAR as const,
      repeats: false,
      ...toUtcCalendarFields(dateMs),
    };
  }
  return {
    type: Notifications.SchedulableTriggerInputTypes.DATE as const,
    date: dateMs,
    ...(Platform.OS === 'android' ? { channelId } : {}),
  };
}

function checkInContent(
  alarmId: string,
  cycleId: string,
  mainAlarmId: string,
): Notifications.NotificationContentInput {
  return {
    title: 'もう起きていますか？',
    body: '確実に起きている場合だけ「起きています」を押してください。',
    sound: false,
    categoryIdentifier: AWAKE_CHECKIN_CATEGORY,
    data: {
      owner: ALREADY_UP_OWNER,
      kind: CHECK_IN_KIND,
      alarmId,
      cycleId,
      mainAlarmId,
    } satisfies AlarmNotificationData,
  };
}

export async function scheduleMainAlarmNotification(input: {
  alarmId: string;
  cycleId: string;
  dueAtMs: number;
  repeats: boolean;
  identifier?: string;
}): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    ...(input.identifier ? { identifier: input.identifier } : {}),
    content: {
      title: '⏰ 起きる時間です',
      body: getMainAlarmNotificationBody({ repeats: input.repeats }),
      sound: 'default',
      interruptionLevel: 'timeSensitive',
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: {
        owner: ALREADY_UP_OWNER,
        kind: MAIN_ALARM_KIND,
        alarmId: input.alarmId,
        cycleId: input.cycleId,
      } satisfies AlarmNotificationData,
    },
    trigger: dateTrigger(input.dueAtMs, ALARM_CHANNEL_ID),
  });
}

/**
 * Schedules a snooze under the caller's identifier, which was stored before
 * this call, so the notification is never one the app cannot name.
 */
export async function scheduleSnoozeNotification(input: {
  identifier: string;
  alarmId: string;
  cycleId: string;
  dueAtMs: number;
  snoozeNumber: number;
}): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    identifier: input.identifier,
    content: {
      title: SNOOZE_NOTIFICATION_TITLE,
      body: SNOOZE_NOTIFICATION_BODY,
      sound: 'default',
      interruptionLevel: 'timeSensitive',
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: {
        owner: ALREADY_UP_OWNER,
        kind: MAIN_ALARM_KIND,
        alarmId: input.alarmId,
        cycleId: input.cycleId,
        snooze: input.snoozeNumber,
      } satisfies AlarmNotificationData,
    },
    trigger: dateTrigger(input.dueAtMs, ALARM_CHANNEL_ID),
  });
}

export async function scheduleCheckInNotification(input: {
  alarmId: string;
  cycleId: string;
  mainAlarmId: string;
  checkInAtMs: number;
  identifier?: string;
}): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    ...(input.identifier ? { identifier: input.identifier } : {}),
    content: checkInContent(input.alarmId, input.cycleId, input.mainAlarmId),
    trigger: dateTrigger(input.checkInAtMs, CHECK_IN_CHANNEL_ID),
  });
}

/** Read-only: identifiers the OS currently has scheduled. */
export async function listScheduledNotificationIds(): Promise<
  ReadonlySet<string>
> {
  if (Platform.OS === 'web') {
    return new Set();
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return new Set(scheduled.map((request) => request.identifier));
}

/**
 * Read-only: every pending notification of the shared OS queue with its
 * content and trigger, parsed defensively. A failed read is 'unknown', never
 * an empty queue.
 */
export async function readScheduledNotificationQueue(): Promise<QueueInspection> {
  if (Platform.OS === 'web') {
    return { kind: 'known', entries: [] };
  }
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return { kind: 'known', entries: scheduled.map(describeScheduledRequest) };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function cancelScheduledNotification(
  notificationId: string | undefined,
): Promise<boolean> {
  if (!notificationId || Platform.OS === 'web') {
    return false;
  }

  const scheduledBefore = await Notifications.getAllScheduledNotificationsAsync();
  if (!scheduledBefore.some((request) => request.identifier === notificationId)) {
    return false;
  }

  await Notifications.cancelScheduledNotificationAsync(notificationId);
  const scheduledAfter = await Notifications.getAllScheduledNotificationsAsync();
  return !scheduledAfter.some((request) => request.identifier === notificationId);
}

export async function cancelNotificationIfPresent(
  notificationId: string | undefined,
): Promise<void> {
  if (!notificationId || Platform.OS === 'web') {
    return;
  }

  const scheduledBefore = await Notifications.getAllScheduledNotificationsAsync();
  if (!scheduledBefore.some((request) => request.identifier === notificationId)) {
    return;
  }

  await Notifications.cancelScheduledNotificationAsync(notificationId);
  const scheduledAfter = await Notifications.getAllScheduledNotificationsAsync();
  if (scheduledAfter.some((request) => request.identifier === notificationId)) {
    throw new Error('アラーム通知の解除を確認できませんでした。');
  }
}

export async function dismissDeliveredNotification(
  notificationId: string | undefined,
): Promise<void> {
  if (!notificationId || Platform.OS === 'web') {
    return;
  }

  await Notifications.dismissNotificationAsync(notificationId);
}

export function readAlarmNotificationData(
  response: Notifications.NotificationResponse,
): AlarmNotificationData | null {
  return parseAlarmNotificationData(
    response.notification.request.content.data,
  );
}

/** Read-only snapshot of what the OS has scheduled, for ownership checks. */
export async function listScheduledNotificationSnapshots(): Promise<
  ScheduledNotificationSnapshot[]
> {
  if (Platform.OS === 'web') {
    return [];
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled.map((request) => ({
    identifier: request.identifier,
    content: {
      title: request.content.title,
      categoryIdentifier: request.content.categoryIdentifier,
      data: request.content.data,
    },
  }));
}

/** Cancels exactly one identifier; never the whole shared queue. */
export async function cancelScheduledNotificationById(
  notificationId: string,
): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}
