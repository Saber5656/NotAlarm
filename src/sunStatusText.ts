export type SunStatusKey =
  | 'invalid-saved'
  | 'permission-revoked'
  | 'timezone-changed'
  | 'polar'
  | 'denied'
  | 'timeout'
  | 'error'
  | 'unsupported-timezone'
  | 'reset-pending';

const TEXT: Record<SunStatusKey, string> = {
  'invalid-saved': '保存した設定を読めなかったため、固定の時刻にしました。',
  'permission-revoked': '位置情報の許可がないため、固定の時刻に戻しました。',
  'timezone-changed': '端末のタイムゾーンが変わったため、固定の時刻に戻しました。',
  polar: '今日は日の出・日の入りがない地域のため、固定の時刻を使っています。',
  denied: '位置情報が許可されなかったため、固定の時刻のままです。',
  timeout: '現在地を取得できなかったため、固定の時刻のままです。',
  error: '現在地を取得できなかったため、固定の時刻のままです。',
  'unsupported-timezone':
    'タイムゾーンを確認できないため、固定の時刻のままです。',
  'reset-pending':
    'データの削除が終わるまで、この設定は変更できません。「データを削除」をもう一度実行してください。',
};

/** Failed lookups leave the saved choice alone, so the text must say which applies. */
const KEPT_SCHEDULE_TEXT: Partial<Record<SunStatusKey, string>> = {
  denied: '位置情報が許可されなかったため、これまでの設定のままです。',
  timeout: '現在地を取得できなかったため、これまでの設定のままです。',
  error: '現在地を取得できなかったため、これまでの設定のままです。',
  'unsupported-timezone':
    'タイムゾーンを確認できないため、これまでの設定のままです。',
};

/**
 * Brief status line; the background never affects whether an alarm rings.
 * `scheduleActive` is true while a region or device schedule is still applied.
 */
export function sunStatusText(
  key: SunStatusKey,
  { scheduleActive = false }: { scheduleActive?: boolean } = {},
): string {
  return (scheduleActive && KEPT_SCHEDULE_TEXT[key]) || TEXT[key];
}
