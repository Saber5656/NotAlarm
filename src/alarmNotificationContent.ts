import type { Messages } from './i18n/messages';

// Later occurrences are only reserved while the app runs, so users who stop a
// repeating alarm from the notification are told to open the app.
export function getMainAlarmNotificationBody(
  input: { repeats: boolean },
  messages: Messages,
): string {
  const { mainBody, keepReservingHint } = messages.notifications;
  return input.repeats
    ? `${mainBody}${messages.common.sentenceGap}${keepReservingHint}`
    : mainBody;
}
