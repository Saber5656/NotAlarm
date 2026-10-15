import { useEffect } from 'react';
import { Platform } from 'react-native';

import { readMainDeliveryIdentity } from '../alarmContracts';
import { saveCycleRinging } from '../alarmStorage';
import { localizedNotice } from '../i18n/localizedNotice';
import {
  clearLastNotificationResponse,
  readLastNotificationResponse,
  subscribeNotificationEvents,
  type NotificationResponse,
} from './platform/notificationEdge';
import type {
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
  TextRef,
} from './types';

/**
 * Notification responses and deliveries, listened to only once the stored
 * alarms are loaded. A delivered main notification rings through the one
 * atomic transition; a launch response is handled and then cleared.
 */
export function useNotificationEvents(input: {
  isLoaded: boolean;
  handleAwakeResponse(response: NotificationResponse): Promise<void>;
  reportResetPending(error: unknown): boolean;
  messagesNow: MessagesNow;
  textRef: TextRef;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
}): void {
  const {
    isLoaded,
    handleAwakeResponse,
    reportResetPending,
    messagesNow,
    textRef,
    setNotice,
    setCurrentAlarms,
  } = input;

  useEffect(() => {
    if (Platform.OS === 'web' || !isLoaded) {
      return;
    }

    const unsubscribe = subscribeNotificationEvents({
      onResponse: (response) => {
        void handleAwakeResponse(response);
      },
      onReceived: (notification) => {
        // The payload's exact scheduled due time is checked by the transition;
        // a malformed one is ignored, a missing one is the legacy fallback.
        const identity = readMainDeliveryIdentity(
          notification.request.content.data,
          notification.request.identifier,
        );
        if (!identity) {
          return;
        }

        // Read, check and write happen inside one queued mutation, so a stop
        // that commits first is never overwritten by this delivery.
        void saveCycleRinging(
          identity,
          Date.now,
        )
          .then(({ alarms, status }) => {
            if (status === 'ringing' || status === 'missed') {
              setCurrentAlarms(alarms);
            }
          })
          .catch((error: unknown) => {
            // A pending deletion is reported as such, not as a save failure.
            if (reportResetPending(error)) {
              return;
            }
            setNotice(
              localizedNotice(
                (t) => ({ tone: 'danger', text: t.messages.ringing.persistFailed }),
                textRef.current,
              ),
            );
          });
      },
    });

    const lastResponse = readLastNotificationResponse();
    if (lastResponse) {
      void handleAwakeResponse(lastResponse).finally(() => {
        clearLastNotificationResponse();
      });
    }

    return unsubscribe;
  }, [handleAwakeResponse, isLoaded, reportResetPending, setCurrentAlarms]);
}
