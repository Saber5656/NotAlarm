import type { Messages } from './i18n/messages';

/**
 * Whether a scheduled local notification can wake the user while the app is
 * not in the foreground. Only 'ok' means the OS will play the alarm sound;
 * every other state (including one that could not be read) must be shown.
 */
export type NotificationDeliveryState = 'ok' | 'off' | 'silent' | 'unknown';

/**
 * The fields read from expo-notifications `NotificationPermissionsStatus`.
 * Kept structural so this module stays free of native imports.
 */
export interface NotificationPermissionSnapshot {
  granted: boolean;
  ios?: {
    status: number;
    allowsSound?: boolean | null;
    allowsAlert?: boolean | null;
  } | null;
}

export interface NotificationDeliveryWarningCopy {
  title: string;
  body: string;
  scheduleLine: string;
}

// UNAuthorizationStatus raw values (expo-notifications IosAuthorizationStatus).
const IOS_NOT_DETERMINED = 0;
const IOS_DENIED = 1;
const IOS_AUTHORIZED = 2;
const IOS_PROVISIONAL = 3;
const IOS_EPHEMERAL = 4;

export function assessNotificationDelivery(
  snapshot: NotificationPermissionSnapshot | null | undefined,
): NotificationDeliveryState {
  if (!snapshot) {
    return 'unknown';
  }

  const ios = snapshot.ios;
  if (!ios) {
    return snapshot.granted ? 'ok' : 'off';
  }

  switch (ios.status) {
    case IOS_NOT_DETERMINED:
    case IOS_DENIED:
      return 'off';
    case IOS_PROVISIONAL:
      // Provisional notifications are delivered quietly to Notification Center.
      return 'silent';
    case IOS_AUTHORIZED:
    case IOS_EPHEMERAL:
      return ios.allowsSound === false ? 'silent' : 'ok';
    default:
      return 'unknown';
  }
}

/** The fields read from expo-notifications `NotificationChannel`. */
export interface AndroidChannelSnapshot {
  importance?: unknown;
  sound?: unknown;
}

// AndroidImportance raw values (expo-notifications).
const ANDROID_CHANNEL_MIN_API = 26;
const ANDROID_IMPORTANCE_NONE = 2;
const ANDROID_IMPORTANCE_MIN = 3;
const ANDROID_IMPORTANCE_LOW = 4;
const ANDROID_IMPORTANCE_DEFAULT = 5;
const ANDROID_IMPORTANCE_HIGH = 6;
const ANDROID_IMPORTANCE_MAX = 7;

/**
 * Delivery state of the main alarm channel alone. DEFAULT is the lowest
 * importance that still plays a sound; a missing or unreadable channel is
 * never reported as ok.
 */
export function assessAndroidAlarmChannel(
  channel: AndroidChannelSnapshot | null | undefined,
): NotificationDeliveryState {
  if (!channel) {
    return 'unknown';
  }
  const { importance, sound } = channel;
  if (importance === ANDROID_IMPORTANCE_NONE) {
    return 'off';
  }
  if (importance === ANDROID_IMPORTANCE_MIN || importance === ANDROID_IMPORTANCE_LOW) {
    return 'silent';
  }
  if (
    importance !== ANDROID_IMPORTANCE_DEFAULT &&
    importance !== ANDROID_IMPORTANCE_HIGH &&
    importance !== ANDROID_IMPORTANCE_MAX
  ) {
    return 'unknown';
  }
  if (sound === null) {
    return 'silent';
  }
  return sound === 'default' || sound === 'custom' ? 'ok' : 'unknown';
}

export interface NotificationDeliveryReaders {
  platform: string;
  /** Platform.Version; only meaningful (a number) on Android. */
  platformVersion?: unknown;
  mainChannelId: string;
  getPermissions: () => Promise<NotificationPermissionSnapshot | null | undefined>;
  getChannel: (channelId: string) => Promise<AndroidChannelSnapshot | null | undefined>;
}

/**
 * Global permission first; on Android a granted permission is then checked
 * against the main alarm channel only (the silent check-in channel is never
 * read). Read-only: never prompts. Any read failure is 'unknown'.
 */
export async function resolveNotificationDelivery(
  readers: NotificationDeliveryReaders,
): Promise<NotificationDeliveryState> {
  try {
    const permission = assessNotificationDelivery(await readers.getPermissions());
    if (permission !== 'ok' || readers.platform !== 'android') {
      return permission;
    }
    const api = readers.platformVersion;
    if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) {
      return 'unknown';
    }
    // Notification channels exist from API 26; below that permission is all there is.
    if (api < ANDROID_CHANNEL_MIN_API) {
      return permission;
    }
    return assessAndroidAlarmChannel(await readers.getChannel(readers.mainChannelId));
  } catch {
    return 'unknown';
  }
}

/**
 * The warning applies only after the state was checked (`null` means not yet)
 * and only while some alarm is expected to ring.
 */
export function shouldWarnNotificationDelivery(
  state: NotificationDeliveryState | null,
  alarms: ReadonlyArray<{ enabled: boolean }>,
): boolean {
  return (
    state !== null &&
    state !== 'ok' &&
    alarms.some((alarm) => alarm.enabled)
  );
}

type WarningState = Exclude<NotificationDeliveryState, 'ok'>;

// Without notifications only the in-app loop sound can ring, and it can only
// start while the app is on screen: at the due time a closed app, a locked
// screen or another app in front means it never starts (once started it is
// configured to keep playing in the background; unverified on a device in
// Expo Go). Off / silent therefore name staying on screen,
// not only closing.
export function getNotificationDeliveryWarningCopy(
  state: WarningState,
  nextAlarmLabel: string | null,
  messages: Messages,
): NotificationDeliveryWarningCopy {
  const d = messages.delivery;
  const text = {
    off: {
      title: d.titleOff,
      reason: d.reasonOff,
      withNext: d.withNextOff,
      withoutNext: d.withoutNextOff,
      scheduleLine: d.scheduleLineOff,
    },
    silent: {
      title: d.titleSilent,
      reason: d.reasonSilent,
      withNext: d.withNextSilent,
      withoutNext: d.withoutNextSilent,
      scheduleLine: d.scheduleLineSilent,
    },
    unknown: {
      title: d.titleUnknown,
      reason: d.reasonUnknown,
      withNext: d.withNextUnknown,
      withoutNext: d.withoutNextUnknown,
      scheduleLine: d.scheduleLineUnknown,
    },
  }[state];
  return {
    title: text.title,
    body: nextAlarmLabel
      ? d.bodyWithNext(text.reason, nextAlarmLabel, text.withNext)
      : d.bodyWithoutNext(text.reason, text.withoutNext),
    scheduleLine: text.scheduleLine,
  };
}
