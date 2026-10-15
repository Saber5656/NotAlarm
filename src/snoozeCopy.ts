import { SNOOZE_INTERVAL_MS, SNOOZE_MAX_COUNT, type SnoozeRejection } from './snooze';

export interface SnoozeCopy {
  title: string;
  detail: string;
  actionLabel: string;
  actionHint: string;
  actionDisabled: boolean;
}

const SNOOZE_MINUTES = SNOOZE_INTERVAL_MS / 60_000;

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Wording for the ringing card (secondary to stopping) and for the card shown
 * while a snooze waits. `nextAtMs` is when the next ring would be.
 */
export function getSnoozeCopy(input: {
  phase: 'ringing' | 'snoozed';
  used: number;
  nextAtMs: number;
}): SnoozeCopy {
  const remaining = Math.max(0, SNOOZE_MAX_COUNT - input.used);
  if (input.phase === 'snoozed') {
    return {
      title: 'スヌーズ中',
      detail: `${clock(input.nextAtMs)}にもう一度鳴ります（${input.used}回目・${SNOOZE_MAX_COUNT}回まで）。起きたことにはなりません。`,
      actionLabel: 'アラームを止める',
      actionHint: 'もう一度鳴らす予定も取り消して、この回のアラームを終えます。',
      actionDisabled: false,
    };
  }
  if (remaining === 0) {
    return {
      title: 'スヌーズ',
      detail: `スヌーズは${SNOOZE_MAX_COUNT}回までです。止めるまで鳴り続けます。`,
      actionLabel: `${SNOOZE_MINUTES}分後にもう一度鳴らす`,
      actionHint: '回数の上限に達したため使えません。',
      actionDisabled: true,
    };
  }
  return {
    title: 'スヌーズ',
    detail: `${clock(input.nextAtMs)}にもう一度鳴らします（あと${remaining}回できます）。起きたことにはなりません。`,
    actionLabel: `${SNOOZE_MINUTES}分後にもう一度鳴らす`,
    actionHint: `いまの音を止めて、${SNOOZE_MINUTES}分後にもう一度鳴らします。`,
    actionDisabled: false,
  };
}

const FAILURE_COPY: Record<SnoozeRejection, string> = {
  NOT_FOUND: 'このアラームは見つかりませんでした。',
  NOT_RINGING: 'このアラームはすでに鳴っていません。',
  LIMIT_REACHED: 'スヌーズは3回までです。止めるまで鳴り続けます。',
  TOO_LATE: '次のアラームの時刻に近いため、スヌーズできません。アラームは鳴ったままです。',
  CAPACITY_FULL:
    '端末の通知がいっぱいで、スヌーズを設定できませんでした。アラームは鳴ったままです。',
  LIST_FAILED:
    'スヌーズを設定できませんでした。アラームは鳴ったままです。止めるか、もう一度お試しください。',
  INTENT_NOT_SAVED:
    'スヌーズを設定できませんでした。アラームは鳴ったままです。止めるか、もう一度お試しください。',
  SCHEDULE_FAILED:
    'スヌーズを設定できませんでした。アラームは鳴ったままです。止めるか、もう一度お試しください。',
  VERIFY_FAILED:
    'スヌーズの設定を確認できませんでした。アラームは鳴ったままです。止めるか、もう一度お試しください。',
  PERSIST_FAILED:
    'スヌーズの内容を保存できませんでした。アラームは鳴ったままです。止めるか、もう一度お試しください。',
};

getSnoozeCopy.failure = (reason: SnoozeRejection): string =>
  FAILURE_COPY[reason];
