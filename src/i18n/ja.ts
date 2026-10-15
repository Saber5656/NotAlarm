/**
 * Japanese catalog: the product default and the fallback language. `Messages`
 * is this object's own type, so `en.ts` cannot compile with a missing or
 * extra key or a different parameter shape. Internal identifiers, policy
 * constants and stored values never appear here.
 */

import { JA_ERROR_TEXTS } from '../errorCatalog';

export const ja = {
  common: {
    /** Between two sentences of one notice (Japanese needs no space). */
    sentenceGap: '',
    errorCode: 'エラーコード',
    close: '閉じる',
    cancel: 'キャンセル',
    delete: '削除',
    next: '次へ',
    openSettings: '設定を開く',
    stepsOf: (count: number, threshold: number) => `${threshold}歩中${count}歩`,
  },

  /** One entry per catalog code; the Japanese text is owned by the catalog. */
  errors: JA_ERROR_TEXTS,

  repeat: {
    today: '今日だけ',
    daily: '毎日',
    weekdays: '平日',
    custom: '曜日指定',
    weekdayJoin: '・',
    /** "Repeat" as a section / group name. */
    sectionLabel: '繰り返し',
    todayOnlyEnded: (date: string) => `今日だけ（${date}） ・ 終了`,
    todayOnlyEndedSpoken: (date: string) => `今日だけ、${date}、終了`,
    todayOnlyEndedExplanation:
      'この日の分は終了しました。もう一度使うには、新しいアラームを追加してください',
  },

  lead: {
    soon: 'まもなく鳴ります',
    daysHours: (days: number, hours: number) => `${days}日${hours}時間後`,
    hoursMinutes: (hours: number, minutes: number) =>
      `${hours}時間${minutes > 0 ? `${minutes}分` : ''}後`,
    minutes: (minutes: number) => `${minutes}分後`,
  },

  notifications: {
    checkInTitle: 'もう起きていますか？',
    checkInBody: '確実に起きている場合だけ「起きています」を押してください。',
    checkInButton: '起きています',
    snoozeTitle: '⏰ スヌーズの時間です',
    snoozeBody:
      'スヌーズした時間になりました。アラームを止めるにはアプリを開いてください。',
    checkInPreview: '起床確認',
    mainTitle: '⏰ 起きる時間です',
    mainBody: '起床が確認できなかったため、アラームを鳴らしています。',
    keepReservingHint: 'アプリを開くと次回以降の予約を続けます。',
    alarmChannel: 'アラーム',
    checkInChannel: '起床確認',
  },

  delivery: {
    titleOff: '通知がオフです',
    titleSilent: '通知の音がオフです',
    titleUnknown: '通知の状態を確認できません',
    reasonOff: '通知がオフのため、',
    reasonSilent: '通知の音がオフのため、',
    reasonUnknown: '',
    withNextOff: 'アプリを画面に表示したままにしていないと鳴りません。',
    withNextSilent: 'アプリを画面に表示したままにしていないと音が出ません。',
    withNextUnknown: '鳴るか確認できません。',
    withoutNextOff: 'アプリを画面に表示したままにしていないとアラームが鳴りません。',
    withoutNextSilent:
      'アプリを画面に表示したままにしていないとアラームの音が出ません。',
    withoutNextUnknown: 'アラームが鳴るか確認できません。',
    scheduleLineOff: '通知オフ・アプリ表示中のみ鳴ります',
    scheduleLineSilent: '通知音オフ・アプリ表示中のみ音が出ます',
    scheduleLineUnknown: '通知の状態を確認できません',
    bodyWithNext: (reason: string, nextAlarm: string, consequence: string) =>
      `${reason}次のアラーム ${nextAlarm} は、${consequence}`,
    bodyWithoutNext: (reason: string, consequence: string) =>
      `${reason}${consequence}`,
    openSettingsHint: '端末の設定で通知をオンにできます',
  },

  bedside: {
    title: '寝るときはアプリを画面に表示したまま充電してください',
    leavesScreen: '画面ロック・アプリを閉じると',
    detailOk: '通知音1回だけ・歩数確認なし',
    detailOff: '鳴りません',
    detailSilent: '音が出ません',
    detailUnknown: '鳴るか確認できません',
    whenScreenOffOk: 'アラームは通知音1回だけ・歩数確認なしになる',
    whenScreenOffOff: 'アラームが鳴らない',
    whenScreenOffSilent: 'アラームの音が出ない',
    whenScreenOffUnknown: 'アラームが鳴るか確認できない',
    keepAwakeFailure: (whenScreenOff: string) =>
      `画面を点けたままにできませんでした。画面が消えると${whenScreenOff}ため、端末の自動ロックをオフにしてください。`,
  },

  coverage: {
    off: '通知は予約されていません',
    none: '予約がありません',
    unverified: '通知の予約状況を確認できません',
    missing: '通知が端末に見つかりません・再予約できませんでした',
    capacityFull: '通知の上限に達しており、再予約できませんでした',
    duplicated: '古い時刻の予約が残っており、2回鳴る可能性があります',
    reservedUntil: (date: string) => `${date}まで予約済み`,
    checkInMissing: (until: string) =>
      `${until}・起床確認通知が予約されていません`,
    refillFailed: (until: string) => `${until}・先の分を予約できませんでした`,
    refillOnOpen: (until: string) =>
      `${until}・アプリを開くと先の分を予約します`,
  },

  reconcile: {
    unrecoveredNotifications:
      '保存できなかった予約のうち、端末から解除できていない通知があります。次回の起動時に解除を再試行します。',
    orphansUnreadable:
      '解除できていない通知の記録を読めないため、新しい予約の追加を止めています。アラームの状態を確認してください。',
    queueUnverified:
      '端末の通知予約を確認できません。アラームが鳴る保証がないため、各アラームの状態を確認してください。',
    pendingOrphans:
      '解除できていない通知が端末に残っています。同じアラームが重複して鳴る可能性があるため、新しい予約の追加を止めています。次回の起動時に解除を再試行します。',
    capacityFull:
      '端末の通知予約が上限(64件)に近く、アラームを再予約できませんでした。不要なアラームを削除または無効にしてから、アプリを開き直してください。',
    missing:
      '端末に通知が見つからないアラームがあり、再予約できませんでした。各アラームの状態を確認してください。',
    duplicated:
      '古い時刻と新しい時刻の予約が両方残っているため、同じアラームが2回鳴る可能性があります。',
    checkInMissing: '一部の起床確認通知を再予約できませんでした。',
    replannedZone:
      'タイムゾーンの変更に合わせて、今後のアラーム予約を組み直しました。',
    replannedTime: '時刻の変更に合わせて、今後のアラーム予約を組み直しました。',
    repaired: '端末から消えていたアラーム通知を再予約しました。',
  },

  steps: {
    preparing: '歩数計を準備中',
    counting: 'アプリ表示中のみ計測',
    windowStarts: (start: string) => `起床確認は ${start} から`,
    windowStartsSpoken: (start: string, threshold: number) =>
      `起床確認は${start}から。アプリを表示している間に${threshold}歩で確認します`,
    whileOpen: (threshold: number) => `アプリ表示中に${threshold}歩`,
    progressLabel: '起床確認の歩数',
    progress: (count: number, threshold: number) =>
      `起床確認 ${count} / ${threshold}歩`,
  },

  storageLoadFailed: {
    title: 'アラーム情報を読み込めません',
    body: '以前に設定したアラームは、このあとも鳴ることがあります。予約済みの通知は解除していません。',
    addDisabledReason:
      'アラーム情報を読み込めないため、新しいアラームは追加できません。',
    restartSteps: [
      'アプリを上にスワイプして完全に終了し、開き直してください。',
      '直らない場合は、端末を再起動してからアプリを開いてください。',
      '確認が取れるまで、別の目覚ましも併用してください。',
    ],
    lastResort:
      '再起動しても直らない場合の最後の手段として、このアプリの予約通知を解除し、保存データをリセットできます。他のアプリの通知は解除しません。',
    resetAction: '通知を解除してリセット',
    resetHint:
      'このアプリのものと確認できる予約済み通知を解除し、保存データを消します。確認が2回あります。',
    resetFirstTitle: '通知を解除してリセットしますか？',
    resetFirstBody:
      'このアプリのものと確認できる予約済み通知を解除し、保存されたアラーム情報を消します。リセット後は、アラームを作り直す必要があります。',
    resetFinalTitle: '本当にリセットしますか？',
    resetFinalBody:
      '解除した通知と消した情報は元に戻せません。リセットが終わるまで、別の目覚ましを併用してください。',
    resetDone: 'リセットしました。アラームを追加できます。',
    resetAmbiguous:
      'リセットしました。ただし、このアプリのものか判別できない古い形式の通知が残っています。他のアプリの通知の可能性があるため解除していません。判別できない通知は鳴る場合があるので、端末の通知設定やスケジュールを確認してください。',
  },

  edit: {
    editLabel: '編集',
    editHint: '時刻と繰り返しを変更します。オンのアラームは通知を予約し直します',
    editSpoken: (time: string, repeat: string) =>
      `${time}、${repeat}のアラームを編集`,
    cleanupPending: (clock: string) =>
      `${clock}に変更しましたが、古い通知の一部を解除できていません。旧い時刻の通知が鳴る可能性があります。アプリを開き直すと再試行します。`,
    savedOff: (clock: string) =>
      `${clock}に変更しました。アラームはオフのままです。`,
    savedNext: (clock: string, date: string) =>
      `${clock}のアラームに変更しました。次回は${date} ${clock}に鳴ります。`,
    saved: (clock: string) => `${clock}のアラームに変更しました。`,
  },

  skip: {
    label: '今回分だけ止める',
    hint: 'この回だけ止めます。繰り返しの設定は変わりません。アラーム全体を止めるには一覧のスイッチを使います',
    spoken: (when: string) => `${when}の回だけ止める`,
    confirmTitle: '今回分だけ止めますか？',
    confirmBody: (when: string) =>
      `${when} の回だけ止めます。ほかの予定の回と繰り返しの設定は変わりません。`,
    done: 'この回だけ止めました。繰り返しの設定は変わりません。',
    stoppedRefillFailed:
      'この回のアラームは停止しました。次回分の予約更新に失敗したため、アラームの状態を確認してください。',
    failed: '今回分の停止に失敗しました。安全のためアラームは維持します。',
  },

  sun: {
    heading: '背景の日の出・日の入り',
    body: '背景の明るさを切り替える時刻だけに使います。アラームの時刻や鳴動には影響しません。',
    fixedLabel: '固定の時刻',
    fixedDetail: '日の出 6:00・日の入り 18:00（初期設定）',
    regionHeading: '地域を選ぶ（位置情報は使いません）',
    deviceHint: '押したときだけ、おおよその現在地を一度使います。',
    deviceUse: '現在地を使う',
    deviceInUse: '現在地を使用中（約10km単位）',
    deviceDetail:
      'ボタンを押したときだけ、おおよその位置を一度確認します。位置は約10km単位に丸めて端末内にだけ保存し、追跡や送信はしません。',
    selectedMarker: '✓ 選択中',
    regions: {
      sapporo: '札幌',
      tokyo: '東京',
      osaka: '大阪',
      naha: '那覇',
      honolulu: 'ホノルル',
      'los-angeles': 'ロサンゼルス',
      'new-york': 'ニューヨーク',
      london: 'ロンドン',
      tromso: 'トロムソ（ノルウェー）',
      sydney: 'シドニー',
      auckland: 'オークランド',
    },
    status: {
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
    },
    keptStatus: {
      denied: '位置情報が許可されなかったため、これまでの設定のままです。',
      timeout: '現在地を取得できなかったため、これまでの設定のままです。',
      error: '現在地を取得できなかったため、これまでの設定のままです。',
      'unsupported-timezone':
        'タイムゾーンを確認できないため、これまでの設定のままです。',
    },
  },

  suppression: {
    saveFailedTitle: '停止の記録を保存できません',
    saveFailedBody:
      '起床を確認して通知を取り消しましたが、その状態を保存できませんでした。アプリを開き直すと復旧を再試行します。それまで、画面上の予定と実際の通知がずれている可能性があります。',
    statusUnknownTitle: '停止・予約の状態が未確認です',
    statusUnknownBody:
      '通知の取り消し結果を確認できませんでした。この回のアラームは、鳴る場合と鳴らない場合があります。別の目覚ましを併用してください。',
    skippedThisTime: (when: string) =>
      `${when} は今回分だけ止めたため鳴りません`,
    suppressedBy: (when: string, byStep: boolean) =>
      `${when} は${byStep ? '100歩' : '通知'}で起床確認済みのため鳴りません`,
  },

  summary: {
    pickWeekdays: '曜日を選ぶと初回の日時が表示されます',
    todayPassed: (clock: string) =>
      `今日の${clock}はすでに過ぎています。時刻を選び直してください`,
    originalDayPassed: (clock: string) =>
      `この日の${clock}はすでに過ぎています。時刻を選び直してください`,
    savedOff: (repeat: string) =>
      `${repeat}・オフのまま保存します（オンにすると通知を予約します）`,
    cannotCompute: '初回の日時を計算できません',
    tooSoon: (clock: string) =>
      `${clock}は直前すぎて予約できません。時刻を選び直してください`,
    firstRing: (repeat: string, date: string, clock: string, lead: string) =>
      `${repeat}・初回 ${date} ${clock}（${lead}）`,
  },

  ringing: {
    stopLabel: 'アラームを止める',
    stopHint: '鳴っているアラーム音を止めます。繰り返しの次回以降は残ります',
    stopSpoken: (clock: string, stopLabel: string, date?: string) =>
      `${date ? `${date} ` : ''}${clock}のアラームが鳴っています。${stopLabel}`,
    badge: '鳴っています',
    title: '起きる時間です',
    lockedNotice: (stopLabel: string) =>
      `アラームが鳴っている間は、オン・オフ、編集、削除はできません。先に「${stopLabel}」を押してください。`,
    snoozedLockedNotice: (stopLabel: string) =>
      `スヌーズ中は、オン・オフ、編集、削除はできません。先に「${stopLabel}」を押してください。`,
    persistFailed: '鳴動中のアラーム状態を保存できませんでした。',
    stopped: 'アラームを停止しました。',
  },

  snooze: {
    waitingTitle: 'スヌーズ中',
    waitingDetail: (clock: string, used: number, max: number) =>
      `${clock}にもう一度鳴ります（${used}回目・${max}回まで）。起きたことにはなりません。`,
    stopLabel: 'アラームを止める',
    stopHint: 'もう一度鳴らす予定も取り消して、この回のアラームを終えます。',
    title: 'スヌーズ',
    exhaustedDetail: (max: number) =>
      `スヌーズは${max}回までです。止めるまで鳴り続けます。`,
    actionLabel: (minutes: number) => `${minutes}分後にもう一度鳴らす`,
    exhaustedHint: '回数の上限に達したため使えません。',
    availableDetail: (clock: string, remaining: number) =>
      `${clock}にもう一度鳴らします（あと${remaining}回できます）。起きたことにはなりません。`,
    actionHint: (minutes: number) =>
      `いまの音を止めて、${minutes}分後にもう一度鳴らします。`,
    snoozed: (clock: string) => `スヌーズしました。${clock}にもう一度鳴ります。`,
  },

  checkIn: {
    confirmed: '起床を確認しました。この時刻のアラームだけ停止しました。',
    failed: '起床確認の処理に失敗しました。安全のためアラームは維持します。',
    stepsDetected: '100歩を検知しました。この時刻のアラームだけ停止しました。',
    stepsCancelUnconfirmed:
      '100歩を検知しましたが、通知の停止を確認できませんでした。アラームは有効です。',
  },

  missed: {
    title: '見逃したアラーム',
    explanation: '音は鳴らしません。起きたかどうかは判断していません。',
    total: (count: number) => `見逃し合計 ${count}件`,
    hidden: (count: number) => `ほか${count}件`,
    acknowledgeAll: 'すべて確認済みにする',
    acknowledgeAllHint:
      '見逃したアラームをすべて確認済みにします。繰り返しの今後の予定は残ります',
    acknowledgeAllSpoken: (count: number) =>
      `見逃した${count}件をすべて確認済みにする`,
    cardAnnouncement:
      '見逃したアラームがあります。音は鳴らしていません。確認済みにできます。',
    acknowledged: '見逃したアラームを確認済みにしました。',
    acknowledgeRefillFailed:
      '確認済みにしましたが、次回分のアラームを予約できませんでした。アラーム状態を確認してください。',
  },

  scheduleIssue: {
    /** Said before a main-notification failure: part of the schedule is missing. */
    incomplete: '予約が完了していない回があります。',
    nextLead: '次回分: ',
    addedLead: 'アラームは追加しました。',
    enabledLead: 'アラームはオンにしました。',
    changedLead: (clock: string) => `${clock}に変更しました。`,
  },

  refill: {
  },

  alarmList: {
    loading: 'アラームを確認しています…',
    title: 'アラーム',
    tagline: '目覚めた朝に、静けさを。',
    add: 'アラームを追加',
    nextAlarm: '次のアラーム',
    noNextTitle: '次のアラームはありません',
    noNextEmpty: '右上の＋から、起床時刻を追加できます。',
    noNextOff: '一覧のスイッチをオンにすると、次のアラームを設定できます。',
    noNextNone:
      '次回の予約はありません。設定した時刻と繰り返しを確認してください。',
    listHeading: '設定したアラーム',
    emptyTitle: 'アラームはまだありません',
    emptyBody: '時刻と繰り返しを選んで、最初のアラームを追加してください。',
    nextOccurrence: (date: string) => ` ・ 次回 ${date}`,
    noNextOccurrence: ' ・ 次回予約なし',
    off: ' ・ オフ',
    toggleHintEnded:
      '終了しているためオンにできません。新しいアラームを追加してください',
    toggleHintOn:
      'アラーム全体のスイッチです。オフにすると、繰り返しを含むすべての回の通知を取り消します。この回だけ止めるには、上の今回分だけ止めるを使います',
    rowSpoken: (time: string, repeat: string) => `${time}、${repeat}のアラーム、すべての回`,
    deleteSpoken: (time: string, repeat: string) =>
      `${time}、${repeat}のアラームを削除`,
    warningLabel: '注意',
    webOnly: '通知と歩数計測はiPhoneまたはAndroid実機で利用できます。',
    added: (clock: string, firstRing: string) =>
      `${clock}のアラームを追加しました。初回は${firstRing}に鳴ります。`,
    deleted: 'アラームを削除しました。',
    deleteTitle: 'アラームを削除しますか？',
    deleteBody: (time: string, repeat: string) =>
      `${time}（${repeat}）を削除します。`,
  },

  settings: {
    openLabel: '設定とプライバシー',
    openHint: '保存しているデータの説明と、データの削除を開きます',
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
    ambiguousWarning:
      '削除しました。ただし、このアプリのものか判別できない古い形式の通知が残っています。他のアプリの通知の可能性があるため解除していません。判別できない通知は鳴る場合があるので、端末の通知設定を確認してください。',
    failed:
      '削除を最後まで完了できませんでした。一部の通知やデータはすでに消えている場合があります。削除が終わるまで、アラームの追加・変更はできません。もう一度「データを削除」を実行すると続きから再開します。',
    failedHome:
      'データの削除を最後まで完了できませんでした。削除が終わるまで、アラームの追加・変更はできません。「設定とプライバシー」を開き、もう一度「データを削除」を実行すると続きから再開します。',
    blockedRinging: 'アラームが鳴っている間は削除できません。先に止めてください。',
    blockedBusy: '別の処理が終わるまでお待ちください。',
    blockedLoading: '読み込みが終わるまでお待ちください。',
  },

  composer: {
    timeInputInvalid: '時は0〜23、分は0〜59で入力してください。',
    title: 'アラームを追加',
    subtitle: '時刻と繰り返しを選んでください',
    editTitle: 'アラームを編集',
    editSubtitle: '保存すると、このアラームの通知だけを予約し直します',
    close: '閉じる',
    tabsLabel: '設定項目',
    tabTime: '時刻',
    tabRepeat: '繰り返し',
    tabLockedHint: '時刻を確定またはキャンセルしてから切り替えられます',
    hour: '時',
    minute: '分',
    timeCancel: 'キャンセル',
    timeConfirm: 'この時刻に決定',
    dialTitle: '時刻ダイヤル',
    dialHint: '上下に回して選択',
    dialSpoken: 'アラーム時刻をダイヤルで選択',
    openDialSpoken: 'ダイヤルで時刻を選択',
    openDialHint: 'Androidの時計ダイヤルを開きます',
    openDialTitle: '時計ダイヤルで選択',
    openDialTap: 'タップして開く',
    openDialSet: 'ダイヤルで設定',
    needsDevice: 'Expo Go実機で使用できます',
    typeTimeHint: '時と分をキーボードから直接入力できます',
    typeTimeSpoken: (clock: string) => `${clock}、キーボードで時刻を入力`,
    selected: '選択中',
    typeDigits: '数字で入力',
    tapTime: '時刻をタップ',
    pickDays: '鳴らす日を選択',
    weekdayHint: '鳴らす曜日',
    weekdayNeeded: '「繰り返し」で曜日を1つ以上選択してください。',
    behaviorTitle: '100歩で起床を確認',
    behaviorBody:
      'アラームの60分前から、アプリを画面に表示している間に数えます。対象のアラームだけを停止し、ほかの時刻には影響しません。',
    summarySpoken: (summary: string) => `追加する内容。${summary}`,
    editSummarySpoken: (summary: string) => `保存する内容。${summary}`,
    deviceHint: '登録はExpo Go実機で行えます',
    bedsideNote: (title: string, detail: string) => `${title}。${detail}。`,
    submit: 'この内容で追加',
    editSubmit: 'この内容で保存',
  },

  notice: {
    dismiss: 'お知らせを閉じる',
    dismissHint: '上にスワイプしても閉じられます',
  },

};

export type Messages = typeof ja;
