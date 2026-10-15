/**
 * Catalog of the failures the app can tell apart. Every failure has one
 * stable machine code, a factual Japanese message (what is known about the
 * alarm) and a recovery line (what the user can do, and whether the app will
 * try again by itself). The copy states only what was verified: "unknown" is
 * never worded as "done" or "not done".
 *
 * Nothing here reads `error.message` of a thrown value: platform and storage
 * errors can carry file paths or tokens, so only the code is taken from an
 * error and the text always comes from this table.
 *
 * Each entry exposes `messageKey` / `recoveryKey` so localization (Issue22)
 * can replace the Japanese strings without touching any call site.
 */

import type { NoticeTone } from './noticeTone';

/**
 * How a failed operation continues:
 *  - 'none': the app does not try again; there is nothing to repeat.
 *  - 'manual': the user repeats the operation. Never repeated automatically.
 *  - 'next_launch': a durable, idempotent record is resumed on the next launch.
 */
export type ErrorRetry = 'none' | 'manual' | 'next_launch';

interface CatalogEntry {
  tone: NoticeTone;
  message: string;
  recovery: string;
  retry: ErrorRetry;
}

const MANUAL_BACKUP = '別の目覚ましを併用してください。';
// iOS gives an app no way to list its own pending notifications, so no copy may
// ask the user to look there. These are the paths that do exist.
const REOPEN_APP = 'アプリを開き直すと、記録した通知を確認して解除し直します。';
const RESET_DATA =
  '解消しない場合は、設定の「データを削除」で、このアプリのアラームと予約済みの通知をすべて消せます（アラームの設定も消えます）。';
const STEPS_UNUSABLE = '歩数による停止を確認できません。予定を確認してください';

const CATALOG = {
  // --- Notification permission / setup (nothing is reserved yet) ---
  NTF_UNSUPPORTED_PLATFORM: {
    tone: 'danger',
    message: 'この環境では通知を予約できません。',
    recovery: 'iPhoneまたはAndroid実機でアプリを開いてください。',
    retry: 'none',
  },
  NTF_PERMISSION_DENIED: {
    tone: 'danger',
    message: '通知が許可されていないため、アラームを予約していません。',
    recovery: '設定アプリで通知をオンにしてから、もう一度操作してください。',
    retry: 'manual',
  },
  NTF_PERMISSION_CHECK_FAILED: {
    tone: 'danger',
    message: '通知の許可状態を確認できなかったため、アラームを予約していません。',
    recovery: '少し待ってから、もう一度操作してください。',
    retry: 'manual',
  },
  NTF_SETUP_FAILED: {
    tone: 'danger',
    message: '通知の準備に失敗したため、アラームを予約していません。',
    recovery: 'アプリを開き直してから、もう一度操作してください。',
    retry: 'manual',
  },
  // --- Main alarm notification ---
  MAIN_REGISTER_FAILED: {
    tone: 'danger',
    message: 'メインのアラーム通知を予約できませんでした。',
    recovery: `${MANUAL_BACKUP}自動では再試行しません。もう一度操作してください。`,
    retry: 'manual',
  },
  MAIN_REGISTER_UNCONFIRMED: {
    tone: 'danger',
    message: 'メインのアラーム通知を予約できたかどうか確認できませんでした。予約されている可能性があります。',
    recovery: `${MANUAL_BACKUP}予約した可能性のある通知の識別子は、予約の前に端末へ記録しています。${REOPEN_APP}それまで新しい予約はしません。`,
    retry: 'next_launch',
  },
  MAIN_UNVERIFIED: {
    tone: 'danger',
    message: 'メインのアラーム通知の予約を確認できませんでした。鳴るかどうか分かりません。',
    recovery: `${MANUAL_BACKUP}予約した可能性のある通知の識別子は端末に記録しています。${REOPEN_APP}それまで新しい予約はしません。`,
    retry: 'manual',
  },
  MAIN_RECONCILE_PENDING: {
    tone: 'danger',
    message: '前回予約した通知の確認が終わっていないため、新しいアラームを予約していません。',
    recovery: `${MANUAL_BACKUP}アプリを開き直すと確認して整理します。終わるまで同じ操作を重ねても予約されません。`,
    retry: 'manual',
  },
  MAIN_UNVERIFIED_CANCELLED: {
    tone: 'danger',
    message: 'メインのアラーム通知の予約を確認できませんでした。この通知は取り消しました。',
    recovery: `アラームは予約されていません。${MANUAL_BACKUP}もう一度操作してください。`,
    retry: 'manual',
  },
  MAIN_UNVERIFIED_MEMORY_ONLY: {
    tone: 'danger',
    message: 'メインのアラーム通知の予約を確認できず、取り消しも記録もできませんでした。鳴るかどうか分かりません。',
    recovery: `${MANUAL_BACKUP}このアプリを終了すると、その通知は追跡できなくなります。終了せずに開いたままにするか、設定の「データを削除」で消してください（アラームの設定も消えます）。それまで新しい予約はしません。`,
    retry: 'none',
  },
  MAIN_PARTIAL: {
    tone: 'danger',
    message: 'メイン通知の一部を予約できていません。',
    recovery: `各アラームの状態を確認し、${MANUAL_BACKUP}`,
    retry: 'manual',
  },
  // --- Check-in notification (the main alarm is kept) ---
  CHECKIN_REGISTER_FAILED: {
    tone: 'warning',
    message: '起床確認通知を予約できませんでした。メインのアラームは予約済みです。',
    recovery: 'この回は起床確認による停止を使えません。',
    retry: 'none',
  },
  CHECKIN_PARTIAL: {
    tone: 'warning',
    message: '一部の起床確認通知を予約できませんでした。',
    recovery: '該当の回は起床確認による停止を使えません。メインのアラームは変更していません。',
    retry: 'none',
  },
  // --- Step sensor ---
  SENSOR_UNAVAILABLE: {
    tone: 'warning',
    message: 'この端末では歩数を使えません。',
    recovery: STEPS_UNUSABLE,
    retry: 'none',
  },
  SENSOR_AVAILABILITY_UNKNOWN: {
    tone: 'warning',
    message: '歩数計が使えるか確認できませんでした。',
    recovery: STEPS_UNUSABLE,
    retry: 'manual',
  },
  SENSOR_PERMISSION_DENIED: {
    tone: 'warning',
    message: '歩数の利用が許可されていません。',
    recovery: STEPS_UNUSABLE,
    retry: 'manual',
  },
  SENSOR_PERMISSION_UNKNOWN: {
    tone: 'warning',
    message: '歩数の許可状態を確認できませんでした。',
    recovery: STEPS_UNUSABLE,
    retry: 'manual',
  },
  SENSOR_READ_FAILED: {
    tone: 'warning',
    message: '歩数を計測できません。',
    recovery: STEPS_UNUSABLE,
    retry: 'manual',
  },
  // --- Storage ---
  STORAGE_READ_FAILED: {
    tone: 'danger',
    message: '保存されたアラーム情報を読み出せませんでした。',
    recovery: '予約済みの通知は解除していません。アプリを開き直してください。',
    retry: 'manual',
  },
  STORAGE_CORRUPT: {
    tone: 'danger',
    message: '保存されたアラーム情報が読み取れない形式でした。',
    recovery: '予約済みの通知は解除していません。確認が取れるまで別の目覚ましを併用してください。',
    retry: 'manual',
  },
  STORAGE_SAVE_FAILED: {
    tone: 'danger',
    message: 'アラーム情報を保存できませんでした。',
    recovery: '今回の操作は反映していません。もう一度操作してください。',
    retry: 'manual',
  },
  STORAGE_JOURNAL_CORRUPT: {
    tone: 'danger',
    message: '未完了の処理の記録が読み取れない形式でした。',
    recovery: `通知の状態が未確認です。${MANUAL_BACKUP}${RESET_DATA}`,
    retry: 'manual',
  },
  STORAGE_JOURNAL_SAVE_FAILED: {
    tone: 'danger',
    message: '処理の記録を保存できませんでした。',
    recovery: '記録を残せないため、この操作は実行していません。もう一度操作してください。',
    retry: 'manual',
  },
  STORAGE_RESET_PENDING: {
    tone: 'danger',
    message: 'データの削除が途中で止まっています。',
    recovery: '設定の「データを削除」をもう一度実行すると、続きから完了します。',
    retry: 'manual',
  },
  STORAGE_RESET_INCOMPLETE: {
    tone: 'danger',
    message: '削除を最後まで完了できませんでした。一部の通知やデータはすでに消えている場合があります。',
    recovery: 'もう一度実行すると続きから再開します。',
    retry: 'manual',
  },
  // --- Invalid action / deadline ---
  ACTION_INVALID: {
    tone: 'warning',
    message: '起床確認の内容が正しくないため、アラームを維持します。',
    recovery: '操作は不要です。',
    retry: 'none',
  },
  ACTION_STALE: {
    tone: 'warning',
    message: 'この確認は現在のアラーム周期と一致しないため、アラームを維持します。',
    recovery: '操作は不要です。',
    retry: 'none',
  },
  DEADLINE_PASSED: {
    tone: 'warning',
    message: 'アラーム時刻になったため停止しませんでした。',
    recovery: 'アラームは鳴ります。',
    retry: 'none',
  },
  SKIP_BEFORE_WINDOW: {
    tone: 'warning',
    message: 'まだ止められる時間（アラームの60分前から）ではないため、アラームを維持します。',
    recovery: '操作は不要です。',
    retry: 'none',
  },
  WRONG_OCCURRENCE: {
    tone: 'warning',
    message: '確認した回とは別の回になっているため止めませんでした。',
    recovery: 'アラームは維持します。',
    retry: 'none',
  },
  TIME_PAST_TODAY: {
    tone: 'danger',
    message: '「今日だけ」は現在より後の時刻を選択してください。',
    recovery: '時刻を選び直してください。',
    retry: 'manual',
  },
  TIME_UNCOMPUTABLE: {
    tone: 'danger',
    message: '次回のアラーム時刻を計算できません。',
    recovery: '時刻や繰り返しの設定を選び直してください。',
    retry: 'manual',
  },
  TIME_INVALID: {
    tone: 'danger',
    message: 'アラームの時刻や日付が正しくありません。',
    recovery: '時刻を選び直してください。',
    retry: 'manual',
  },
  REPEAT_INVALID: {
    tone: 'danger',
    message: '繰り返しの設定が正しくありません。',
    recovery: '繰り返す曜日を1つ以上選んでください。',
    retry: 'manual',
  },
  ALARM_TODAY_ENDED: {
    tone: 'danger',
    message: 'この「今日だけ」アラームは終了しています。',
    recovery: '削除して新しいアラームを追加してください。',
    retry: 'none',
  },
  ARM_LEAD_TOO_SHORT: {
    tone: 'danger',
    message: 'アラーム時刻まで10秒未満のため、オンにできません。',
    recovery: '時刻を過ぎてからもう一度お試しください。',
    retry: 'manual',
  },
  ALARM_LIMIT_REACHED: {
    tone: 'danger',
    message: '登録できるアラームの上限に達しています。',
    recovery: '不要なアラームを削除してから追加してください。',
    retry: 'manual',
  },
  ALARM_NOT_FOUND: {
    tone: 'danger',
    message: '対象のアラームが見つかりません。',
    recovery: '一覧の表示を確認してください。',
    retry: 'none',
  },
  STEP_COUNT_INVALID: {
    tone: 'warning',
    message: '歩数の値が正しくないため、記録しませんでした。',
    recovery: 'アラームは維持します。',
    retry: 'none',
  },
  // --- Cancellation / suppression ---
  CANCEL_UNKNOWN: {
    tone: 'danger',
    message: '通知の取り消し結果を確認できませんでした。この回が鳴るかは未確認です。',
    recovery: `自動では取り消し直しません。${MANUAL_BACKUP}アプリを開き直すと、予約状態の確認だけを行います。`,
    retry: 'none',
  },
  CANCEL_NOT_VERIFIED: {
    tone: 'danger',
    message: 'アラーム停止を確認できませんでした。',
    recovery: '鳴る前提で扱ってください。',
    retry: 'none',
  },
  SUPPRESSION_JOURNAL_NOT_WRITTEN: {
    tone: 'warning',
    message: '停止の記録を保存できなかったため、通知は取り消していません。',
    recovery: 'アラームは予定どおり鳴ります。',
    retry: 'none',
  },
  SUPPRESSION_SAVE_FAILED: {
    tone: 'danger',
    message: '起床を確認し通知を取り消しましたが、状態を保存できませんでした。',
    recovery: 'アプリを開き直すと、停止の記録から状態を復旧します。',
    retry: 'next_launch',
  },
  CANCEL_RECOVERY_INCOMPLETE: {
    tone: 'danger',
    message: '前回のアラーム停止処理を完了できませんでした。',
    recovery: `止めたはずの回が鳴る可能性があります。${MANUAL_BACKUP}アプリを開き直すと続きから再試行します。${RESET_DATA}`,
    retry: 'next_launch',
  },
  DISABLE_CANCEL_INCOMPLETE: {
    tone: 'danger',
    message: '通知の解除を完了できませんでした。',
    recovery: 'アプリを開き直すと、停止処理を続きから実行します。',
    retry: 'next_launch',
  },
  DELETE_CANCEL_INCOMPLETE: {
    tone: 'danger',
    message: 'アラームの削除を完了できませんでした。',
    recovery: 'アプリを開き直すと、停止処理を続きから実行します。',
    retry: 'next_launch',
  },
  ROLLBACK_INCOMPLETE: {
    tone: 'danger',
    message: 'アラーム設定を保存できず、予約済み通知の一部も解除できませんでした。',
    recovery: `解除できなかった通知は記録できておらず、鳴る可能性があります。${MANUAL_BACKUP}${RESET_DATA}`,
    retry: 'none',
  },
  ROLLBACK_INCOMPLETE_RECORDED: {
    tone: 'danger',
    message: 'アラーム設定を保存できず、予約済み通知の一部も解除できませんでした。',
    recovery: `解除できなかった通知の識別子は端末に記録しています。${REOPEN_APP}それまで鳴る可能性があります。${MANUAL_BACKUP}`,
    retry: 'next_launch',
  },
  NOTIFICATION_CANCEL_UNVERIFIED: {
    tone: 'danger',
    message: 'アラーム通知の解除を確認できませんでした。',
    recovery: `その通知は鳴る可能性があります。${MANUAL_BACKUP}${RESET_DATA}`,
    retry: 'none',
  },
  // --- Editing an alarm ---
  EDIT_LOCKED: {
    tone: 'warning',
    message: 'アラームが鳴っている間は編集できません。',
    recovery: '先にアラームを止めてから、もう一度編集してください。',
    retry: 'manual',
  },
  EDIT_LOCKED_SNOOZED: {
    tone: 'warning',
    message: 'スヌーズ中は編集できません。',
    recovery: '先にアラームを止めてから、もう一度編集してください。',
    retry: 'manual',
  },
  EDIT_UNSETTLED: {
    tone: 'warning',
    message: 'このアラームの前回の処理が完了していません。',
    recovery: 'アプリを開き直して処理が終わってから、もう一度操作してください。このアラームは変更していません。',
    retry: 'manual',
  },
  EDIT_SNOOZE_UNSETTLED: {
    tone: 'warning',
    message: 'このアラームのスヌーズの処理が完了していません。',
    recovery: 'アプリを開き直して処理が終わってから、もう一度編集してください。このアラームは変更していません。',
    retry: 'manual',
  },
  EDIT_CAPACITY: {
    tone: 'danger',
    message: '予約できる通知の数（64件）に空きがないため編集できません。',
    recovery: 'このアラームは変更していません。他のアラームを減らしてからやり直してください。',
    retry: 'manual',
  },
  EDIT_DEADLINE_PASSED: {
    tone: 'warning',
    message: '編集中にアラームの時刻になったため、編集を中止しました。',
    recovery: 'このアラームは変更していません。',
    retry: 'manual',
  },
  EDIT_TIME_TOO_CLOSE: {
    tone: 'warning',
    message: '編集中に次回のアラーム時刻が近づきすぎたため、編集を中止しました。',
    recovery: 'このアラームは変更していません。時刻を選び直してください。',
    retry: 'manual',
  },
  EDIT_SCHEDULE_FAILED: {
    tone: 'danger',
    message: '新しい時刻の通知を予約できなかったため、編集を中止しました。',
    recovery: 'このアラームは変更しておらず、途中まで予約した通知は取り消しました。もう一度操作してください。',
    retry: 'manual',
  },
  EDIT_SCHEDULE_UNVERIFIED: {
    tone: 'danger',
    message: '新しい時刻の通知の予約を確認できなかったため、編集を中止しました。',
    recovery: 'このアラームは変更しておらず、新しい時刻の通知は取り消しました。確認が終わるまで新しい予約はできません。アプリを開き直してからもう一度操作してください。',
    retry: 'manual',
  },
  EDIT_RECONCILE_PENDING: {
    tone: 'danger',
    message: '前回予約した通知の確認が終わっていないため、編集していません。',
    recovery: 'このアラームは変更していません。アプリを開き直すと確認して整理します。',
    retry: 'manual',
  },
  EDIT_CANCEL_UNVERIFIED: {
    tone: 'danger',
    message: '古い通知の解除を確認できなかったため、編集を中止しました。',
    recovery: 'このアラームは変更しておらず、新しい時刻の通知は取り消しました。もう一度操作してください。',
    retry: 'manual',
  },
  EDIT_SAVE_FAILED: {
    tone: 'danger',
    message: '新しい通知は予約しましたが、アラーム設定を保存できませんでした。',
    recovery: '編集の記録は端末に残しています。アプリを開き直すと編集を完了します。それまで古い時刻でも鳴る可能性があります。',
    retry: 'next_launch',
  },
  EDIT_ROLLBACK_INCOMPLETE: {
    tone: 'danger',
    message: '編集を中止しましたが、新しい時刻の通知の一部を解除できませんでした。',
    recovery: `解除できなかった通知の識別子は端末に記録しています。${REOPEN_APP}それまで新しい時刻でも鳴る可能性があります。${RESET_DATA}`,
    retry: 'next_launch',
  },
  EDIT_CLEANUP_INCOMPLETE: {
    tone: 'danger',
    message: '前回の編集で、古い時刻の通知の一部を解除できませんでした。',
    recovery: `解除できなかった通知の識別子は端末に記録しています。${REOPEN_APP}それまで古い時刻でも鳴る可能性があります。`,
    retry: 'next_launch',
  },
  EDIT_CLEANUP_PENDING: {
    tone: 'warning',
    message: '時刻は変更しましたが、古い時刻の通知の一部を解除できていません。',
    recovery: `古い時刻でも鳴る可能性があります。解除できなかった通知の識別子は端末に記録しています。${REOPEN_APP}`,
    retry: 'next_launch',
  },
  // --- Operations around the main flows ---
  // --- Snooze / stop of a ringing alarm ---
  SNOOZE_NOT_FOUND: {
    tone: 'warning',
    message: 'このアラームの記録を読み込めなかったため、スヌーズを設定していません。',
    recovery: 'アラームの状態を確認してください。',
    retry: 'manual',
  },
  SNOOZE_NOT_RINGING: {
    tone: 'warning',
    message: 'このアラームはすでに鳴っていません。',
    recovery: 'スヌーズは設定していません。',
    retry: 'none',
  },
  SNOOZE_LIMIT_REACHED: {
    tone: 'warning',
    message: 'スヌーズは3回までです。',
    recovery: '止めるまで鳴り続けます。',
    retry: 'none',
  },
  SNOOZE_TOO_LATE: {
    tone: 'warning',
    message: '次のアラームの時刻に近いため、スヌーズできません。',
    recovery: 'アラームは鳴ったままです。',
    retry: 'none',
  },
  SNOOZE_CAPACITY_FULL: {
    tone: 'warning',
    message: 'このアプリが予約できる通知の上限に達しているため、スヌーズを設定できませんでした。',
    recovery: 'アラームは鳴ったままです。止めてください。',
    retry: 'none',
  },
  SNOOZE_LIST_FAILED: {
    tone: 'danger',
    message: '予約済みの通知を確認できなかったため、スヌーズを設定していません。',
    recovery: 'アラームは鳴ったままです。止めるか、もう一度お試しください。',
    retry: 'manual',
  },
  SNOOZE_INTENT_NOT_SAVED: {
    tone: 'danger',
    message: 'スヌーズの記録を保存できなかったため、設定していません。',
    recovery: 'アラームは鳴ったままです。止めるか、もう一度お試しください。',
    retry: 'manual',
  },
  SNOOZE_SCHEDULE_FAILED: {
    tone: 'danger',
    message: 'スヌーズを設定できませんでした。',
    recovery: 'アラームは鳴ったままです。止めるか、もう一度お試しください。',
    retry: 'manual',
  },
  SNOOZE_VERIFY_FAILED: {
    tone: 'danger',
    message: 'スヌーズの設定を確認できませんでした。',
    recovery: 'アラームは鳴ったままです。止めるか、もう一度お試しください。',
    retry: 'manual',
  },
  SNOOZE_PERSIST_FAILED: {
    tone: 'danger',
    message: 'スヌーズの内容を保存できませんでした。',
    recovery: 'アラームは鳴ったままです。止めるか、もう一度お試しください。',
    retry: 'manual',
  },
  SNOOZE_CLEANUP_UNCONFIRMED: {
    tone: 'danger',
    message: 'スヌーズを設定できず、試みた予約の取り消しも確認できませんでした。',
    recovery: `アラームは鳴ったままです。追加で一度鳴る可能性があります。予約した可能性のある通知の識別子は端末に記録しています。${REOPEN_APP}`,
    retry: 'next_launch',
  },
  SNOOZE_CLEANUP_MEMORY_ONLY: {
    tone: 'danger',
    message: 'スヌーズを設定できず、試みた予約の取り消しも確認できませんでした。その通知は端末に記録できていません。',
    recovery: `アラームは鳴ったままです。追加で一度鳴る可能性があります。アプリを終了すると、その通知は追跡できなくなります。終了せずに開いたままにするか、設定の「データを削除」で消してください（アラームの設定も消えます）。${MANUAL_BACKUP}`,
    retry: 'none',
  },
  SNOOZE_ACCEPTED_CLEANUP_UNCONFIRMED: {
    tone: 'warning',
    message: 'スヌーズを設定しました。ただし、元のアラームなど予約済みの通知の取り消しを確認できていません。',
    recovery: `設定した時刻に鳴ります。追加で鳴る可能性があります。取り消しを確認できていない通知の識別子は端末に記録しています。${REOPEN_APP}`,
    retry: 'next_launch',
  },
  SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY: {
    tone: 'warning',
    message: 'スヌーズを設定しました。ただし、元のアラームなど予約済みの通知の取り消しを確認できず、その通知を端末に記録できていません。',
    recovery: `設定した時刻に鳴ります。追加で鳴る可能性があります。アプリを終了すると、その通知は追跡できなくなります。終了せずに開いたままにするか、設定の「データを削除」で消してください（アラームの設定も消えます）。${MANUAL_BACKUP}`,
    retry: 'none',
  },
  SNOOZE_RESET_PENDING: {
    tone: 'danger',
    message: 'データの削除が途中のため、スヌーズはできません。',
    recovery: 'アラームは鳴ったままです。設定の「データを削除」をもう一度実行すると、続きから完了します。',
    retry: 'manual',
  },
  SNOOZE_UNEXPECTED_FAILURE: {
    tone: 'danger',
    message: 'スヌーズの結果を確認できませんでした。',
    recovery: 'アラームが鳴っていれば止めてください。スヌーズの通知が追加で鳴る可能性があります。',
    retry: 'manual',
  },
  SNOOZE_REARM_FAILED: {
    tone: 'warning',
    message: 'スヌーズの再設定を確認できませんでした。',
    recovery: 'アプリを開いている間は時刻に鳴りますが、閉じると鳴らない場合があります。',
    retry: 'next_launch',
  },
  SNOOZE_RECOVERY_UNRESOLVED: {
    tone: 'warning',
    message: '中断されたスヌーズの通知を解除できたか確認できませんでした。',
    recovery: `追加で鳴る可能性があります。${REOPEN_APP}`,
    retry: 'next_launch',
  },
  SNOOZE_RECOVERY_MEMORY_ONLY: {
    tone: 'warning',
    message: '中断されたスヌーズの通知を解除できたか確認できず、その通知を端末に記録できていません。',
    recovery: `追加で鳴る可能性があります。アプリを終了すると、その通知は追跡できなくなります。終了せずに開いたままにするか、設定の「データを削除」で消してください（アラームの設定も消えます）。${MANUAL_BACKUP}`,
    retry: 'none',
  },
  SNOOZE_RECOVERY_FAILED: {
    tone: 'warning',
    message: 'スヌーズの状態を確認できませんでした。',
    recovery: 'アプリを開いている間は、時刻を過ぎたスヌーズを鳴動または見逃しとして扱います。',
    retry: 'next_launch',
  },
  STOP_SAVE_FAILED: {
    tone: 'danger',
    message: '停止の記録を保存できなかったため、停止できませんでした。予約済みの通知は取り消していません。',
    recovery: 'アラームは鳴動中のまま残っています。もう一度止めてください。',
    retry: 'manual',
  },
  STOP_CLEANUP_UNCONFIRMED: {
    tone: 'warning',
    message: 'アラームを停止しました。ただし、予約済みの通知の取り消しを確認できていません。',
    recovery: `この回のアラームは再び鳴りませんが、通知が一度届く可能性があります。取り消しを確認できていない通知の識別子は端末に記録しています。${REOPEN_APP}`,
    retry: 'next_launch',
  },
  STOP_CLEANUP_MEMORY_ONLY: {
    tone: 'warning',
    message: 'アラームを停止しました。ただし、予約済みの通知の取り消しを確認できず、その通知を端末に記録できていません。',
    recovery: `通知が一度届く可能性があります。アプリを終了すると、その通知は追跡できなくなります。終了せずに開いたままにするか、設定の「データを削除」で消してください（アラームの設定も消えます）。${MANUAL_BACKUP}`,
    retry: 'none',
  },
  STOP_ALREADY_ENDED: {
    tone: 'neutral',
    message: 'このアラームはすでに終わっています。',
    recovery: '操作は必要ありません。',
    retry: 'none',
  },
  STOP_RESET_PENDING: {
    tone: 'danger',
    message: '音と通知は止めましたが、データの削除が途中のため停止の記録は保存していません。',
    recovery: '設定の「データを削除」をもう一度実行すると、続きから完了します。',
    retry: 'manual',
  },
  STOP_FOLLOWUP_FAILED: {
    tone: 'warning',
    message: 'アラームを停止しました。次回分の予約更新に失敗しました。',
    recovery: 'アラームの状態を確認してください。アプリを開き直すと再度確認します。',
    retry: 'next_launch',
  },
  STOP_FOLLOWUP_RESET_PENDING: {
    tone: 'danger',
    message: 'アラームを停止しました。データの削除が途中のため、次回分の予約は更新していません。',
    recovery: '設定の「データを削除」をもう一度実行すると、続きから完了します。',
    retry: 'manual',
  },
  // --- Misc ---
  CHECKIN_PROCESS_FAILED: {
    tone: 'danger',
    message: '起床確認の処理に失敗しました。',
    recovery: '安全のためアラームは維持します。',
    retry: 'none',
  },
  STEP_PROCESS_FAILED: {
    tone: 'danger',
    message: '100歩の確認処理に失敗しました。',
    recovery: 'アラームの状態を確認してください。',
    retry: 'none',
  },
  SUPPRESSION_FOLLOWUP_FAILED: {
    tone: 'warning',
    message: '起床を確認し、この回のアラームは停止しました。次回分の予約更新に失敗しました。',
    recovery: 'アラームの状態を確認してください。',
    retry: 'manual',
  },
  REFILL_FAILED: {
    tone: 'warning',
    message: '通知状態を更新できませんでした。',
    recovery: 'アプリを開き直すと再度確認します。各アラームの状態を確認してください。',
    retry: 'next_launch',
  },
  DUE_TRANSITION_FAILED: {
    tone: 'danger',
    message: 'アラーム時刻になりましたが、状態更新に失敗しました。',
    recovery: '画面の表示と、届いている通知を確認してください。',
    retry: 'none',
  },
  STOP_RINGING_FAILED: {
    tone: 'danger',
    message: '停止処理を完了できませんでした。',
    recovery: 'アラームは維持しています。もう一度止めてください。',
    retry: 'manual',
  },
  MISSED_ACK_FAILED: {
    tone: 'danger',
    message: '確認済みにできませんでした。',
    recovery: 'もう一度お試しください。',
    retry: 'manual',
  },
  SOUND_START_FAILED: {
    tone: 'danger',
    message: '端末内のアラーム音を開始できませんでした。',
    recovery: '通知音と画面で確認してください。',
    retry: 'none',
  },
  SETTINGS_OPEN_FAILED: {
    tone: 'warning',
    message: '設定アプリを開けませんでした。',
    recovery: '端末の設定アプリから通知を確認してください。',
    retry: 'manual',
  },
  UNEXPECTED_FAILURE: {
    tone: 'danger',
    message: '予期しないエラーが発生しました。',
    recovery: 'アラームの状態を確認し、必要なら別の目覚ましを併用してください。',
    retry: 'manual',
  },
} as const satisfies Record<string, CatalogEntry>;

export type ErrorCode = keyof typeof CATALOG;

export const ERROR_CODES = Object.keys(CATALOG) as ErrorCode[];

export interface ErrorDescriptor extends CatalogEntry {
  code: ErrorCode;
  /** Translation keys for the message and recovery sentences. */
  messageKey: string;
  recoveryKey: string;
}

export interface ErrorNotice {
  tone: NoticeTone;
  /** Message followed by recovery; contains no machine code. */
  text: string;
  /** Secondary detail for reports; shown small, never part of the sentence. */
  code: ErrorCode;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CATALOG, value)
  );
}

export function describeErrorCode(code: ErrorCode): ErrorDescriptor {
  const entry: CatalogEntry = CATALOG[code];
  return {
    ...entry,
    code,
    messageKey: `errors.${code}.message`,
    recoveryKey: `errors.${code}.recovery`,
  };
}

const TONE_RANK: Record<NoticeTone, number> = {
  neutral: 0,
  success: 0,
  warning: 1,
  danger: 2,
};

/**
 * One notice for an operation that has several independent outcomes (for
 * example a stop that succeeded, whose refill failed, and whose cleanup is
 * unconfirmed). Every message is kept; the tone is the most severe and the
 * code is the first, which names the primary outcome.
 */
export function noticeFromCodes(codes: readonly [ErrorCode, ...ErrorCode[]]): ErrorNotice {
  const notices = codes.map(noticeFromCode);
  const tone = notices.reduce(
    (worst, notice) => (TONE_RANK[notice.tone] > TONE_RANK[worst] ? notice.tone : worst),
    notices[0].tone,
  );
  return { tone, text: notices.map((notice) => notice.text).join(''), code: codes[0] };
}

export function noticeFromCode(code: ErrorCode): ErrorNotice {
  const { tone, message, recovery } = describeErrorCode(code);
  return { tone, text: message + recovery, code };
}

/**
 * An Error that carries a catalog code. Its `message` is the catalog text, so
 * even a log or an unmapped handler cannot surface the underlying cause.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly cause: unknown;

  constructor(code: ErrorCode, cause?: unknown) {
    super(CATALOG[code].message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * The catalog code of a thrown value, or `fallback`. Only an own `code` that
 * is a known catalog code counts, so platform codes such as 'ENOENT' are not
 * mistaken for ours.
 */
export function errorCodeOf(
  error: unknown,
  fallback: ErrorCode = 'UNEXPECTED_FAILURE',
): ErrorCode {
  if (error !== null && typeof error === 'object') {
    // `catalogCode` wins: a typed failure may keep a short step code in `code`.
    const { code, catalogCode } = error as { code?: unknown; catalogCode?: unknown };
    if (isErrorCode(catalogCode)) {
      return catalogCode;
    }
    if (isErrorCode(code)) {
      return code;
    }
  }
  return fallback;
}

/** Notice for a thrown value. Never reads the value's message. */
export function describeError(
  error: unknown,
  fallback: ErrorCode = 'UNEXPECTED_FAILURE',
): ErrorNotice {
  return noticeFromCode(errorCodeOf(error, fallback));
}
