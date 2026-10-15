import type { StorageResetService } from './storageReset';

export type LocalDataDeletionOutcome =
  | { kind: 'deleted'; ambiguousCount: number }
  | { kind: 'failed' };

/**
 * User-initiated deletion of this app's local data and its own notifications.
 * It is the same service as the corruption recovery reset. Stored data is only
 * removed after cancellation is verified, but a failure can still come midway
 * (some notifications cancelled, or some keys removed). The durable intent then
 * stays, alarm writes are refused, and running the deletion again resumes it.
 */
export async function deleteAllLocalData(
  service: Pick<StorageResetService, 'reset'>,
): Promise<LocalDataDeletionOutcome> {
  try {
    const { ambiguousCount } = await service.reset();
    return { kind: 'deleted', ambiguousCount };
  } catch {
    return { kind: 'failed' };
  }
}

export type LocalDataDeletionAvailability =
  | { allowed: true }
  | { allowed: false; reason: string };

export function getLocalDataDeletionAvailability({
  isRinging,
  isBusy,
  isLoaded,
}: {
  isRinging: boolean;
  isBusy: boolean;
  isLoaded: boolean;
}): LocalDataDeletionAvailability {
  if (isRinging) {
    return {
      allowed: false,
      reason: 'アラームが鳴っている間は削除できません。先に止めてください。',
    };
  }
  if (isBusy) {
    return { allowed: false, reason: '別の処理が終わるまでお待ちください。' };
  }
  if (!isLoaded) {
    return { allowed: false, reason: '読み込みが終わるまでお待ちください。' };
  }
  return { allowed: true };
}

/** Plain-language summary; the precise list lives in docs/PRIVACY.md. */
export const LOCAL_DATA_COPY = {
  settingsLabel: '設定とプライバシー',
  settingsHint: '保存しているデータの説明と、データの削除を開きます',
  title: '設定とプライバシー',
  subtitle: '保存するデータと削除',
  summaryHeading: '保存しているデータ',
  summary: [
    'アラームの時刻・繰り返し・オン/オフ、予約した通知の識別子、100歩の歩数と起床確認の時刻・状態を、この端末の中だけに保存します。',
    '歩数はアプリを開いている間の件数だけを使います。加速度などの生の動きのデータや、ヘルスケアのデータは保存しません。',
    '保存したアラームを、このアプリが外部へ送ることはありません。ただし開発中の Expo 開発サーバーからは、アプリの読み込みなどで通信が発生します。',
  ],
  deleteHeading: 'データの削除',
  deleteBody:
    'このアプリが予約した通知を解除し、端末内のアラーム情報と復旧用の記録を消します。他のアプリの通知やデータには触れません。',
  deleteAction: 'データを削除',
  deleteHint:
    '確認が2回あります。途中で止まった場合は、もう一度実行すると続きから再開します',
  firstConfirmTitle: 'データを削除しますか？',
  firstConfirmBody:
    'このアプリが予約した通知を解除し、保存されたアラーム情報を消します。他のアプリの通知は解除しません。削除後はアラームを作り直す必要があります。',
  finalConfirmTitle: '本当に削除しますか？',
  finalConfirmBody:
    '解除した通知と消した情報は元に戻せません。削除が終わるまで、別の目覚ましを併用してください。',
  confirmAction: '削除する',
  done: 'このアプリのデータと予約通知を削除しました。',
  doneAmbiguous:
    '削除しました。ただし、このアプリのものか判別できない古い形式の通知が残っています。他のアプリの通知の可能性があるため解除していません。判別できない通知は鳴る場合があるので、端末の通知設定を確認してください。',
  failed:
    '削除を最後まで完了できませんでした。一部の通知やデータはすでに消えている場合があります。削除が終わるまで、アラームの追加・変更はできません。もう一度「データを削除」を実行すると続きから再開します。',
  close: '閉じる',
} as const;
