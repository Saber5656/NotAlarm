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

const WARNING_TITLES: Record<Exclude<NotificationDeliveryState, 'ok'>, string> = {
  off: '通知がオフです',
  silent: '通知の音がオフです',
  unknown: '通知の状態を確認できません',
};

// The in-app loop sound still plays in the foreground, so off / silent only
// describe what happens when the app is closed.
const WARNING_CONSEQUENCES: Record<
  Exclude<NotificationDeliveryState, 'ok'>,
  { withNext: string; withoutNext: string }
> = {
  off: {
    withNext: 'アプリを閉じていると鳴りません。',
    withoutNext: 'アプリを閉じているとアラームが鳴りません。',
  },
  silent: {
    withNext: 'アプリを閉じていると音が出ません。',
    withoutNext: 'アプリを閉じているとアラームの音が出ません。',
  },
  unknown: {
    withNext: '鳴るか確認できません。',
    withoutNext: 'アラームが鳴るか確認できません。',
  },
};

const WARNING_SCHEDULE_LINES: Record<
  Exclude<NotificationDeliveryState, 'ok'>,
  string
> = {
  off: '通知オフ・アプリを閉じると鳴りません',
  silent: '通知音オフ・アプリを閉じると音が出ません',
  unknown: '通知の状態を確認できません',
};

export function getNotificationDeliveryWarningCopy(
  state: Exclude<NotificationDeliveryState, 'ok'>,
  nextAlarmLabel: string | null,
): NotificationDeliveryWarningCopy {
  const consequence = WARNING_CONSEQUENCES[state];
  return {
    title: WARNING_TITLES[state],
    body: nextAlarmLabel
      ? `次のアラーム ${nextAlarmLabel} は、${consequence.withNext}`
      : consequence.withoutNext,
    scheduleLine: WARNING_SCHEDULE_LINES[state],
  };
}
