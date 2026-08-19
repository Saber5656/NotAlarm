import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  AWAKE_CHECKIN_CATEGORY,
  CHECK_IN_KIND,
  CONFIRM_AWAKE_ACTION,
  MAIN_ALARM_KIND,
  type AlarmNotificationData,
} from './alarmContracts';

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
      '通知が許可されていません。設定アプリでAlreadyUpの通知を許可してください。',
    );
  }

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

function dateTrigger(dateMs: number, channelId: string) {
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
}): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '⏰ 起きる時間です',
      body: '起床が確認できなかったため、アラームを鳴らしています。',
      sound: 'default',
      interruptionLevel: 'timeSensitive',
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: {
        kind: MAIN_ALARM_KIND,
        alarmId: input.alarmId,
        cycleId: input.cycleId,
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
}): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: checkInContent(input.alarmId, input.cycleId, input.mainAlarmId),
    trigger: dateTrigger(input.checkInAtMs, CHECK_IN_CHANNEL_ID),
  });
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
  const data = response.notification.request.content.data;
  const kind = data?.kind;
  const alarmId = data?.alarmId;
  const cycleId = data?.cycleId;
  const mainAlarmId = data?.mainAlarmId;

  if (
    (kind !== MAIN_ALARM_KIND && kind !== CHECK_IN_KIND) ||
    (alarmId !== undefined && typeof alarmId !== 'string') ||
    typeof cycleId !== 'string' ||
    (mainAlarmId !== undefined && typeof mainAlarmId !== 'string')
  ) {
    return null;
  }

  return { kind, alarmId, cycleId, mainAlarmId };
}
