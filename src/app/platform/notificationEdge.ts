import * as Notifications from 'expo-notifications';

export type NotificationResponse = Notifications.NotificationResponse;
export type ReceivedNotification = Notifications.Notification;

/**
 * Registers the response and delivery listeners together; the returned
 * function removes both.
 */
export function subscribeNotificationEvents(handlers: {
  onResponse(response: NotificationResponse): void;
  onReceived(notification: ReceivedNotification): void;
}): () => void {
  const responseSubscription =
    Notifications.addNotificationResponseReceivedListener(handlers.onResponse);
  const receivedSubscription = Notifications.addNotificationReceivedListener(
    handlers.onReceived,
  );
  return () => {
    responseSubscription.remove();
    receivedSubscription.remove();
  };
}

/** The response that launched the app, if any, until it is cleared. */
export function readLastNotificationResponse(): NotificationResponse | null {
  return Notifications.getLastNotificationResponse();
}

export function clearLastNotificationResponse(): void {
  Notifications.clearLastNotificationResponse();
}
