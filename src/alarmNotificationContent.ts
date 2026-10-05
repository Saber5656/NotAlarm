const MAIN_ALARM_BODY =
  '起床が確認できなかったため、アラームを鳴らしています。';
// Later occurrences are only reserved while the app runs, so users who stop a
// repeating alarm from the notification are told to open the app.
const KEEP_RESERVING_HINT = 'アプリを開くと次回以降の予約を続けます。';

export function getMainAlarmNotificationBody(input: {
  repeats: boolean;
}): string {
  return input.repeats
    ? `${MAIN_ALARM_BODY}${KEEP_RESERVING_HINT}`
    : MAIN_ALARM_BODY;
}
