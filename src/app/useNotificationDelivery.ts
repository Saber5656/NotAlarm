import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  type NotificationDeliveryState,
} from '../notificationDelivery';
import { noticeFromCodeIn } from '../i18n';
import { readNotificationDelivery } from '../notificationService';
import { openAppSettings } from './platform/linkingEdge';
import type { MessagesNow, SetNotice } from './types';

/** What the OS currently lets this app deliver, and the way to Settings. */
export function useNotificationDelivery(
  messagesNow: MessagesNow,
  setNotice: SetNotice,
) {
  // null until the first check, so nothing is claimed before it completes.
  const [notificationDelivery, setNotificationDelivery] =
    useState<NotificationDeliveryState | null>(null);
  const deliveryCheckRef = useRef(0);

  const refreshNotificationDelivery = useCallback(async () => {
    if (Platform.OS === 'web') {
      return;
    }

    // Only the latest check may update the state when checks overlap.
    const check = ++deliveryCheckRef.current;
    const next = await readNotificationDelivery();
    if (check === deliveryCheckRef.current) {
      setNotificationDelivery(next);
    }
  }, []);

  const openNotificationSettings = useCallback(() => {
    void openAppSettings().catch(() => {
      setNotice(noticeFromCodeIn(messagesNow(), 'SETTINGS_OPEN_FAILED'));
    });
  }, []);

  return {
    notificationDelivery,
    refreshNotificationDelivery,
    openNotificationSettings,
  };
}
