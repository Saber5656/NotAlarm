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

/** Brief status line; the background never affects whether an alarm rings. */
export function sunStatusText(key: SunStatusKey): string {
  return TEXT[key];
}
