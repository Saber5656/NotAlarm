# AlreadyUp 設計

## 1. 目的と安全原則

AlreadyUp は、設定時刻に実際の音を鳴らし、期限前60分以内にアプリを画面に表示したまま歩いた100歩の起床行動、または本人の明示操作を確認できた場合だけ、対応する1周期のアラームを抑止する。

> 起きていると確定できない場合は、アラームを残す。

最重大事故は「本当は寝ているのに、推定や処理失敗によってアラームを止めること」である。誤って鳴ることは許容しても、正の証拠と OS 上の取消確認なしに止めることは許容しない。

## 2. 現行スコープ

### 含む

- 最大10件のアラーム設定
- 今日だけ、毎日、平日、曜日指定
- 設定ごとのオン／オフと削除
- 各設定の先3周期を個別 local notification として予約
- 期限の60分前から、アプリを画面に表示している間だけ数える foreground Pedometer の100歩
- 期限直前の actionable notification
- 対象周期だけを cancel する fail-safe policy
- foreground ループ音
- 就寝時の正式手順（アプリを画面に表示したまま充電）と、鳴動中・24時間以内の監視周期がある間の画面スリープ防止（11.2）
- v1 単一アラーム保存形式から v2 複数形式への移行

### 含まない

- 睡眠そのものの推定
- background での継続的な歩数監視
- AlarmKit / Critical Alerts による鳴動保証
- ロック画面・通知からのスヌーズ操作（ネイティブ統合は別 Issue。8.2 のスヌーズはアプリ画面上の操作のみ）
- アラーム名、音、振動の編集
- 先3周期をバックグラウンドで永続的に補充する native scheduler
- watchOS 専用アプリ

## 3. データモデル

### 3.1 Alarm definition

```ts
interface StoredAlarmDefinition {
  id: string;
  hour: number;
  minute: number;
  repeat: AlarmRepeat;
  enabled: boolean;
  createdAtMs: number;
  cycles: StoredAlarm[];
}

type AlarmRepeat =
  | { kind: 'today'; weekdays: []; dateKey: string }
  | { kind: 'daily'; weekdays: [0, 1, 2, 3, 4, 5, 6] }
  | { kind: 'weekdays'; weekdays: [1, 2, 3, 4, 5] }
  | { kind: 'custom'; weekdays: Weekday[] };
```

曜日はローカル timezone の `0=日` から `6=土` で保存する。`today` は日付を `YYYY-MM-DD` として固定し、過去時刻を翌日へ繰り越さない。

### 3.2 Alarm cycle

```ts
interface StoredAlarm {
  alarmId: string;
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
  phase: 'armed' | 'step_candidate' | 'suppressed' | 'ringing' | 'dismissed';
  stepCount: number;
  stepCountFromMs?: number;
  stepCandidateAtMs?: number;
  confirmedAtMs?: number;
  stepCandidateRecorded: boolean;
}
```

`stepCount` は `stepCountFromMs` から数えた歩数である。`stepCountFromMs` がその周期の現在の歩数 window 開始時刻と一致しない場合（旧データで未設定の場合を含む）、保存済み `stepCount` は0として扱う。同じ開始時刻での更新は大きい方を保持し、より後の開始時刻での更新は新しい値で置き換えて `stepCountFromMs` も更新する。`stepCountFromMs` は後ろへしか動かさず、保存済みより前の開始時刻から数えた更新は無視する（`updateMonitoringCycleStepCount` の `stale_window`）。他の周期が停止した時は、重なる周期の `stepCountFromMs` を停止時刻へ進めて `stepCount` を0にする（7.1）。

`alarmId` はユーザー設定、`cycleId` は特定日の特定時刻を識別する。通知 action の `cycleId`、保存済み `mainAlarmId`、check-in request ID の全てが一致しない限り cancel しない。

## 4. 繰り返し計算

`getUpcomingAlarmTimes` はローカル date を1日ずつ進め、repeat rule に一致する未来時刻を最大3件返す。

| repeat | 次回計算 |
|---|---|
| 今日だけ | 保存した当日かつ現在より後だけ。日付は作成時に固定し、オン操作で付け替えない |
| 毎日 | 次に到来する全曜日 |
| 平日 | 月〜金だけ |
| 曜日指定 | 選択した1曜日以上だけ |

### 4.1 時刻の意味（ALR-008）

- 繰り返し（毎日・平日・曜日指定）の `HH:mm` は**端末のローカル壁時計**で解釈する。保存する `dueAtMs` は計画時点のタイムゾーンで確定した絶対時刻であり、タイムゾーンを変えると壁時計と一致しなくなる。
- 「今日だけ」は保存した `dateKey`（元のローカル日付）に固定する。タイムゾーンが変わっても別の日付へ移さない。
- `isDueTimeWallClockAligned` が、保存した `dueAtMs` を計画と同じ構築子でローカル日付の `HH:mm` へ直した値と比べ、ずれた周期を「別タイムゾーンで計画された」と判定する。DST で存在しない時刻は計画側と同じ位置になるため、ずれとは判定しない。
- 計画時のタイムゾーン（IANA 名）を `already-up/planning-zone/v1` に保存する（`src/planningZone.ts`）。ずれの判定は保存値に依存せず、保存値は「タイムゾーンの変更に合わせて組み直した」旨の notice を選ぶためだけに使う。再照合が全件成功したときだけ更新する。
- 手動の時刻変更: 壁時計とのずれ（タイムゾーン変更）は上記の判定で検出する。同じタイムゾーンでの手動変更は保存済み `dueAtMs` が絶対時刻のままなので判定では検出できない。代わりに iOS の予約を絶対 UTC の CALENDAR トリガーにし、OS キューから読み戻した絶対時刻と保存値を照合する（6.1）。実機で手動時計変更後に正しく鳴るかは**未確認**（DEVICE_TEST 16③）。

全て one-off `DATE` trigger とする。同じ recurring request を使わないのは、1周期だけを安全に cancel し、古い応答が将来周期へ波及することを防ぐためである。

## 5. 通知予算

iOS は保留 local notification を直近64件まで保持する。AlreadyUp は次の上限を固定する。

```text
10 alarm definitions
× 3 upcoming cycles
× 2 notifications (main + check-in)
= 60 pending notifications maximum
```

予約枠は JavaScript が動いている間だけ、次の契機で各設定の先3周期（`today` は1周期）まで補充する。

| 契機 | 条件 |
|---|---|
| 起動時の読み込み | 未完了の停止処理を回復できた場合。`prepareNotifications()` で必要なら権限を求める |
| `AppState` が `active` へ変化（読み込み完了後） | Web でない、別の補充が実行中でない、オンのアラームがある、`getPermissionsAsync()` が `granted`。権限 prompt は出さない（`prepareNotificationsIfGranted()`）。停止・オフの journal が残る definition は補充しない |
| アプリ内の起床確認成功・100歩抑止・鳴動停止 | 対象 definition だけ補充する |

起動時と `active` 復帰時は同じ補充処理を使い、補充途中で保存に失敗した場合は今回予約した通知を取り消す（`withScheduledNotificationRollback`）。予約できなかった問題は `kind` と `alarmId` で識別し、前回の補充で報告していない問題がある場合だけ notice を出す（`reconcileReportedScheduleProblems`）。問題が解消すると記録から外し、再発時は再び通知する。各行の予約範囲表示（11章）が状態を示し続けるため、同じ notice を復帰のたびに繰り返さない。

補充のたび（起動時・`active` 復帰時・追加・オン・アプリ内の周期完了後）に、対象にした definition ごとの直近の結果を記録する（`recordRefillAttempt`）。今回の対象は前回の結果を置き換え、対象外の definition は前回の結果を保つ。次の definition を「直近の補充に失敗」とし、11章の行表示へ渡す。

- 補充が問題（`main_schedule_failed` / `check_in_schedule_failed`）を報告した
- 停止・オフの journal が残るため補充しなかった
- 補充が途中で失敗した（起動時の権限拒否、journal の読み取り・保存・rollback の失敗）、または起動時に停止処理を回復できず補充しなかった（対象にしたオンの definition すべて）

`active` 復帰時に権限がなく補充しなかった場合と、別の補充が実行中で見送った場合は記録を変えない（権限がない間は行に通知の警告（11.1）を優先する）。

通知の「起きています」や通知からの停止だけを使い、アプリを前面に戻さない場合は補充されない。アプリを3周期以上開かない場合の継続補充は未実装であり、本番 release gate とする。暫定対策として、繰り返し設定（`today` 以外）の main 通知の本文に「アプリを開くと次回以降の予約を続けます。」を添え、一覧で予約の終わりと残り1周期を警告する。本文は `getMainAlarmNotificationBody`（`src/alarmNotificationContent.ts`）で選び、`AlarmSchedulingGateway.scheduleMain` の `repeats`（`repeat.kind !== 'today'`）で切り替える。先の周期がない `today` には添えない。

## 6. 予約シーケンス

各周期は次の順序で予約する。

1. 入力時刻と repeat rule を検証する。
2. 一意な `cycleId` を作成する。
3. main alarm を OS に登録し、`mainAlarmId` を得る。
4. 最大60秒前の check-in を登録する。
5. definition と cycle を AsyncStorage v2 に保存する。

main を必ず先に登録する。check-in の登録に失敗しても main を残し、警告を返す。main の登録に失敗した周期は「予約済み」と表示しない。

### 6.1 OS キューとの照合（ALR-003 / ALR-008、`src/scheduleReconciliation.ts`）

保存した未来の周期と OS の保留通知を、起動時（`markDueCyclesRinging` の後、補充の前）と `active` 復帰時（補充の前）に照合する。保存済みであることは OS に予約されていることを意味しない。

**決定した順序（決定的）**

1. `suppressionJournal.exclusive`（進行中の停止・回復）→ `transactAlarmDefinitions`（ユーザーの cancel・補充と同じ保存キュー）の順にロックを取り、OS キューは保存キューの順番を得た後に読む。ユーザーの停止は照合の前か後に直列化され、照合が消された通知を作り直すことはない。
2. 照合の対象外: オフの alarm、未完了の cancel journal または suppression journal が残る alarm、`suppressed` / `dismissed` / `ringing` の周期（再作成しない）、期限を過ぎた周期。
3. OS キューを読めない場合は `unknown` とし、何も予約も取消もしない。権限がない場合も同様で、`prepareNotificationsIfGranted()`（prompt なし）が false のとき修復しない。いずれも行に「予約を確認できません」/「通知が端末に見つかりません」を表示し、「…まで予約済み」と表示しない。
4. 別タイムゾーンで計画された周期は、**古い周期を 1 件ずつ**、容量確認（main + check-in の 2 件が空いているか）→ 新規予約 → checkpoint → OS キューを読み直して新しい ID が内容つきで存在することを確認 → 対応する古い周期の正確な ID を cancel → 古い周期を保存から削除、の順で置き換える。古い周期と新しい周期は明示的に対にし（`ReplacementPair`）、途中で止まった後の再実行は既に作った新しい周期を再利用して、2 つ目のコピーを作らない。確認できない（OS が成功を返しても保持していない、読み直せない）間は古い周期を残す。`suppressed` などが占める時刻は空けたままにする。「今日だけ」の元日付・壁時計が既に過去なら、元の予約を残す。新規予約に失敗した場合は古い周期を残す（鳴らないより別時刻に鳴るほうを選ぶ）。確認済みの置換が既にある古い周期は「置換済み」とし、cancel 後の保存に失敗しても main の再作成対象にしない（古い時刻の再作成を防ぐ）。古い周期の期限（`dueAtMs`）に達したら、非同期の修復中でも cancel も削除もせず鳴動経路に任せる。
5. main が OS に無い周期は、まず同じ周期の内容を持つ未追跡の通知（保存前にクラッシュして残ったもの）を採用し、無ければ空きを確認して同じ `cycleId` で main を再予約 → OS キューで内容を確認 → 旧 check-in（旧 main を指す）を正確な ID で cancel → checkpoint → 新 main を指す check-in を再予約（空きを確認）→ 確認 → checkpoint。空きが無く自分の旧 check-in があるときだけ、それを先に cancel して 1 件空ける。
6. check-in だけ無い周期は、確認済みの main を残して check-in だけ再予約する（空きが無ければ `capacity_full`）。check-in の時刻を過ぎている場合は再作成しない。
7. 各 checkpoint の保存に失敗したら、直前に予約した ID を cancel して元の例外を返す。cancel できなかった ID があれば `OrphanStore`（`src/orphanedNotifications.ts`）に永続し、`ScheduledNotificationRollbackError` を返す。次の照合の最初に、その ID が OS キューに自分の内容で残っていれば cancel し、消えている・別内容なら追跡を外す。
8. 照合が途中で例外になった場合、App は caller の古い配列を使わず、`recoverAbortedReconciliation` で保存済みの最新 checkpoint を読み直して App state へ反映する。読み直せなければ `alarms: null` を返し、何も保存済みと主張しない。解除できなかった ID は notice（danger）で知らせる。
9. **補充の可否は `assessReconciledState`（`src/reconcileGate.ts`）が決める**。補充は OS キューも orphan 一覧も読まないため、`freshness: 'fresh'`（保存済み状態を読めた）、OS キューを読めた（`queueVerified`）、中断していない、解除できていない ID が無い、未完了の停止が無い、のすべてを満たす `safeToRefill` のときだけ起動時・前面復帰の補充を行う。満たさないときは補充せず `getSkippedRefillAttempt` で「未補充」と記録し、警告 notice のまま次の起動・前面復帰で再試行する。`stale` の alarms は表示用で、補充には使わない。
10. **orphan の解放は生きている ID に触れない**。`OrphanStore` にある ID でも、保存済みのどの周期の `mainAlarmId` / `checkInNotificationId` にも参照されていれば cancel せず追跡だけ外す。採用（未追跡の同一周期の通知を保存した）時と、旧 ID の cancel 完了時にも追跡から外す。

**容量**: iOS のローカル通知は 64 件までで、Expo Go では他プロジェクトの通知も同じ枠を使う。OS が超過分のどれを捨てるかは仕様で定まっていないため、アプリは外部通知を含む保留件数（`QueueIndex.size`）に必要件数を足して 64 以下のときだけ予約する。足りなければ予約も cancel もせず、古い予約を残して `capacity_full`（「通知の上限に達しており、再予約できませんでした」）を表示する。

**予約後の未確認 ID・重複・タイムゾーン置換（PR37 後追い指摘）**: (1) 予約は成功したが読み戻しで `present` にならない新 ID（main / check-in）は、先に orphan journal へ永続してから正確な ID で cancel し、cancel できた分だけ追跡を外す。cancel できなければ journal に残し、結果の `pendingOrphanIds` に載せる。journal にも書けず cancel もできない ID は `ScheduledNotificationRollbackError`（中断扱い）にする。(2) 採用で同じ周期の印付き通知が複数見つかったら、1 件だけ採用し残りは同じ手順で cancel / 追跡する（main・check-in 共通）。(3) 照合の冒頭の orphan 解放は、キューに無い（不在を確認）か自アプリのものと証明できない場合だけ追跡を外す。印付き、または journal に `exact`（kind / alarmId / cycleId / mainAlarmId）が残り内容が一致する旧形式（印なし）の通知は cancel し、読み戻して消えたことを確認できるまで追跡を残す。cancel が確認できない ID は `pendingOrphanIds` として `assessReconciledState`（`orphans_pending`）が補充を止め、`summarizeReconciliation` が `queue_orphans_pending` の danger notice を出す。`exact` は journal version 1 に加えた任意項目で、無い旧 journal・古いビルドの読み取りと互換（ID 一覧は従来どおり、壊れた項目は無視）。旧 ID の移行（旧 main / check-in の追跡）は `exact` も保存する。(4) タイムゾーン置換で新しい周期を作った直後に check-in も読み戻し、OS が落としていればその場で再予約する。確認できなければ `repaired` ではなく `check_in_missing` にする（旧周期は main が確認できた時点で従来どおり退役）。(5) 論理的な発生日（`src/occurrenceIdentity.ts`）: 周期を作る経路（`fillAlarmDefinitionSchedule` と照合の置換 `createReplacement`）は、作成時に `logicalDateKey`（`planningZone` での `YYYY-MM-DD`）と `planningZone` を `StoredAlarm` に任意項目として必ず保存する。新しい周期は常に自分の出自を持つので、planning zone の保存値が古い（A のまま）でも、B で作って抑止された周期は B の暦日でブロックされる。グローバルな `originZone`（保存済み planning zone）は、メタデータの無い旧版の周期の証拠としてだけ使う。メタデータは任意で、読み込み時に検証する（両方そろい、実在する日付・空でないゾーンのときだけ有効。片方だけ・不正な値は `dropUntrustedOccurrenceMetadata` で捨てて旧版扱いにし、ストア全体は壊さず、値の補完もしない）。置換では、停止済み（suppressed / dismissed / ringing 等）の周期を絶対時刻ではなく論理的な暦日で扱い、`dueAtMs > now` で絞らない: 西向きの移動では、旧ゾーンで既に過ぎた時刻が新ゾーンでは同じ暦日の未来の発生に当たりうるため、`dueAtMs` が now の 48 時間前（ゾーン差の最大 26 時間に余裕を足した範囲）より新しい停止済み周期を対象にし、その暦日の新しい発生をブロックする。メタデータの無い旧周期は、壁時計に合っていれば従来どおり絶対時刻で、合っていなければ `originZone` から暦日を求め、`originZone` が不明（旧版で未保存）なら推測せず新規作成を行わず `unverified` にする（fail-safe）。繰り返し規則・元の起床ウィンドウは変えない。**PR45 指摘の反映（論理日付ワークフロー）**: (a) 検証: `readOccurrenceIdentity` は `dueAtMs` も受け取り、ゾーンが実行環境で解決でき（未知のゾーン・範囲外の `utc-offset:` は不可）、かつ `logicalDateKey` がその `dueAtMs` のそのゾーンでの暦日と一致する場合だけ有効とする。`dateKeyInZone` は非有限・範囲外の時刻、不正なオフセット（有効範囲 UTC+14〜UTC-12 の分）、未知のゾーンで例外を出さず null を返す。不正なメタデータはストア読み込み（`loadAlarmDefinitions`）とジャーナル読み込み（`loadPendingAlarmEdits`）の両方で `withTrustedOccurrenceMetadata` により 2 項目だけ捨て、通知 ID・phase は保持する。(b) ゾーンの取得点: 編集 (`editAlarmDefinition`) は、先行する `journal.load()` / `hasUnsettledWork()` の await の後、`getUpcomingAlarmTimes` と同じ同期ステップで planning zone を取り、その計画の間は固定する（後続の登録 await でゾーンが変わっても同じ値）。置換 (`replan`) も、期待時刻の計算と同じ同期ステップで実時計のゾーンを一度だけ取り、その計画の全スロットの stamp と暦日比較に使う（置換ごとに解決し直さない）。呼び出し側が取得した `currentZone` が実時計と違えば（await の間に端末が移動した）、古いゾーンと新しい現地時刻を混ぜないよう何も作らず `unverified` にする。(c) 停止済みの暦日: replan と refill (`fillAlarmDefinitionSchedule`) は同じ純関数 `collectLogicalDateEvidence`（`src/occurrenceIdentity.ts`）で「すでに取られた暦日」を決める。refill は絶対時刻の占有だけでなく、その暦日のスロットを作らず、ブロックされた日を除いても 3 件の補充容量を保つ（先読み数にブロック数を足す）。today-only でブロックされた日しか残らなければ無効化する。メタデータの無い旧周期は、壁時計に合えば planning zone、合わなければ保存済み origin で暦日を確定し、**確定した時点でその周期へ `logicalDateKey` / `planningZone` を書き込む**（replan の checkpoint と refill の結果）。origin が不明・不正なら refill も何も作らず `originUnverified` を返し、App はそのアラームを不足として扱う。(d) 保持期間: 停止済み (suppressed / dismissed) の周期は、`dueAtMs` が過ぎても 48 時間（`LOGICAL_DATE_REACH_MS`、ゾーン差の最大 26 時間に余裕）は `normalizeCycles` で削除せず証拠として残す。それより古いものは、どのゾーンの暦日でも今後のスロットと一致しえないため削除する。以前の「過ぎたら即削除」は変更した（保存される周期は 1 アラームあたり最大で数件増える）。(e) origin の前進: 保存済み planning zone は `canAdvancePlanningZone`（`src/scheduleReconciliation.ts`）が許可したときだけ新しいゾーンへ進める。照合が実行され、キューが読め、除外されていない有効なアラームがすべて verified / repaired で（結果が空でも「全部処理済み」とは扱わない）、どのアラームにも「自分の識別を持たない停止済み証拠（48 時間内）」が残っておらず、除外アラーム（保留中の編集・抑止・取消）は識別の無い周期を一切持たない、という条件。実行中に端末のゾーンが変わっていた場合も進めない。進めないときは古い origin のまま次の照合で旧周期の暦日を確定する（周期ごとの origin は、確定時点の stamp として保存される）。制限: 識別の無い証拠が 48 時間以内に残る間は origin が進まず、`zoneChanged` の通知が続きうる。

**所有の判定と保存済み旧 ID・読めない journal（リセット時）**: 通知の所有は、まず名前空間の印（`owner` など）で厳密に判定する。印のない旧 main は名前空間では見つけられないため、(1) 検証できる保存データ、(2) version 1 として厳密に検証できた orphan journal（`parseOrphanJournal`）に残る正確な ID だけを、リセットの durable intent（`ownedIds`）に先に書いてから解除する。カレンダー移行で保存済み周期が新 ID に変わった後の旧 main も、journal が有効ならここで解除できる。journal が壊れている・別版・不正な ID を含む場合は信頼せず ID を一切使わない: 名前空間の印のある通知だけ解除し、印のない旧通知は残して「判別できない通知」の警告に数える。planning zone（`PLANNING_ZONE_KEY`）も全消去の対象で、無くても問題ない。通常の照合で orphan journal が読めない間（`orphansUnreadable`）は補充を止め（`orphans_unreadable`）、`summarizeReconciliation` が alarm 数に関係なく danger の notice（`queue_orphans_unreadable`）を毎回の未解決問題として出す。OS キューを確認できない（`queueVerified: false`）ときも、「予約済み」とは表示せず警告する（`queue_unverified`）。

**iOS の予約と旧予約の移行**: SDK 57 の iOS は DATE 入力を相対秒の `UNTimeIntervalNotificationTrigger` に変換し、絶対時刻を読み戻せない。そこで iOS だけ文書化された CALENDAR 入力（`timezone: 'UTC'`、year〜second を全て明示、`repeats: false`）で予約する（`src/notificationTrigger.ts`、Android は DATE のまま）。時刻は秒単位で、早く鳴らさないため**秒へ切り上げ**て予約・照合する。読み戻した `dateComponents` / `timeZone`（`UTC` または `GMT`）は全項目の範囲と実在日を検査して絶対 ms にし、欠落・範囲外・別ゾーンの形は `unverifiable`（verified にしない）。旧ビルドが残した相対トリガーの自アプリ通知は `legacy` とし、権限があれば移行する: 空き確認（旧と新が共存するため +1 件、無ければ `capacity_full` で旧を残す）→ 同じ `cycleId` で新 main を予約し読み戻して確認 → 旧 ID を orphan に永続 → 関連付けを checkpoint（`cycleId` / `armedAtMs` / 歩数 / phase を保持）→ 旧 check-in・旧 main を正確な ID で cancel（自分の内容と確認できた場合のみ）→ 新 check-in を再予約。期限に達した・保存失敗・確認失敗のいずれでも旧予約を残す。

**キューの照合は通知の内容で行う**（`src/queueInspection.ts`）: `kind` / `alarmId` / `cycleId` / check-in の `mainAlarmId` が保存値と一致する通知だけを「自分のもの」とする（`alarmId` は契約上 optional なので、明示的な不一致のみ除外）。同じ ID で内容が違う・読めない通知は foreign として触らず、その alarm を `unverified` にする。cancel も、キュー上の内容が自分のものと確認できた ID だけに行う（不在は完了扱い）。トリガー時刻は SDK 57（`expo-notifications` 57.0.23 のネイティブ serializer と型を確認）で、Android は `{ type: 'date', value: <epoch ms> }` として読めるため一致を確認し、不一致なら `unverified`。iOS は DATE 入力が `UNTimeIntervalNotificationTrigger`（予約時点の相対秒）に変換され `{ type: 'timeInterval', seconds }` としてしか読めず、絶対時刻を取得できないため、iOS では時刻は検証せず内容のみで verified とする。

**Rollback / 再入防止**: 実行中の照合は module で 1 つに共有し（`scheduleReconcileInFlight`）、同時の呼び出しは同じ結果を受け取る。再実行は冪等で、2 回目は何も予約しない。cancel は保存した ID のみを対象にし、OS キューにある無関係な ID は触らない。期限に達した周期は修復中も `nowMs()` で再確認し、鳴動経路に任せる。

**結果の表示**: 行ごとに `verified` / `repaired` / `check_in_missing` / `unverified` / `duplicated`（古い予約と新しい予約が両方残り、2 回鳴る可能性）/ `missing` / `capacity_full` を `getScheduleCoverageLine` の `queueStatus` として既存の警告行（11章）に渡す。notice は `summarizeReconciliation` が 1 つ選び、未解決の問題は `alarmId` 単位で 1 回だけ出す。追加・オンにした alarm の状態は予約直後なので消す。

**ゲートウェイ境界**: 照合は `ReconcileGateway`（`scheduleMain` / `scheduleCheckIn` / `cancelScheduled`）と `readQueue`（`QueueInspection`）だけに依存し、`expo-notifications` を直接参照しない。将来の native AlarmKit は別 issue でこの境界の背後に追加できる。

**制限**: アプリが動いていない間（再起動後、通知削除後、時刻変更後）は検知できず、次の起動・前面復帰で照合する。iOS の CALENDAR 予約は絶対時刻を読み戻せる設計だが、Expo Go での読み戻し（`timeZone` の表記を含む）と、手動で時計を変えた後に実際に正時に鳴るかは**実機で未検証**。旧ビルドの相対予約は時刻を検証できないため移行する。64 件超過時の OS の破棄順は実機で未検証で、アプリは超過を避けることだけで対処する。cancel 後に古い周期の削除保存が失敗した場合の「置換済み」は同一プロセス内でのみ記憶し、再起動後は置換先が OS で確認できたときに限り古い周期を削除する（確認できなければ古い周期は壁時計とずれたまま `missing` / `duplicated` と表示される）。

## 7. 起床証拠と抑止

### 7.1 100歩

- foreground で最も近い未来周期だけを監視する。
- 歩数 window（2026-10-05決定）は `startMs` から `dueAtMs` 未満までとする。`startMs = max(dueAtMs - 60分, armedAtMs, floorMs, 保存済み stepCountFromMs)` で、App は `getStepCountingStartMs(alarms, cycle)`（`src/stepWindow.ts`）で求めた時刻から数える。`floorMs` は他の周期（全設定）のうち、まだ保存されている `suppressed` かつ `confirmedAtMs < dueAtMs` の最新 `confirmedAtMs` である。別周期の停止に使った歩数や確認済みの時間帯を再利用しない（例: 06:30 と 07:00 の設定）。
- 床の永続化: 停止済み周期は期限を過ぎると起動時・前面復帰時の補充で整理され、`floorMs` から消える。そのため周期を `suppressed` で保存する同じ mutation（`saveStoredAlarm` → `replaceStoredCycle` → `applySuppressionStepFloor`）で、他の `armed` / `step_candidate` 周期（全設定）のうち `dueAtMs - 60分 < confirmedAtMs < dueAtMs` のものへ `stepCountFromMs = confirmedAtMs`、`stepCount = 0` を書き込む。既に `confirmedAtMs` 以降の `stepCountFromMs` を持つ周期は変更しない。停止後に予約された周期は `armedAtMs` が停止時刻より後になる。例: 06:30・06:40・07:00 の毎日設定で、06:00〜06:10 の100歩が 06:30 を 06:10 に停止した場合、06:30 が整理された後も 07:00 は 06:10 から数える。
- 数えるのは、アプリを画面に表示している間に `watchStepCount` で観測した歩数と、同じ window で保存済みの歩数だけとする（2026-10-05決定）。window 開始前と、アプリが背面にある間（`AppState` が `background`）は Pedometer を購読せず、数えない（`shouldWatchSteps`）。window 中は保存済みの window 歩数を起点に即時に1回評価してから `watchStepCount` の増分を加える。
- iOS の歩数履歴（`getStepCountAsync`）は合算しない。アプリを閉じたまま、または画面をロックしたまま歩いてから再び寝た場合（例: トイレ）に意図せず止めないためで、`NSMotionUsageDescription`（アプリを開いている間の歩数）とも一致する。expo-sensors の iOS 実装は前面復帰時に購読開始時刻から更新を再開し、背面中の歩数も含めるため、背面へ移った時点で購読を外し、前面へ戻ったら保存済み歩数から新しく購読する。
- 99歩以下は main を変更しない。
- 100歩以上でも `armedAtMs <= observedAtMs < dueAtMs` を満たさない場合は拒否する。
- 歩数証拠は数え始めた時刻 `countedFromMs` を持つ。`countedFromMs` が欠落・非有限、`dueAtMs - 60分` より前、`armedAtMs` より前、保存済み `stepCountFromMs` より前（保存値が非有限の場合を含む）、または `observedAtMs` より後の場合は、取消の前に `STEP_COUNT_OUTSIDE_WINDOW` で拒否する（`canSuppressAlarm`）。`processStepThresholdFailSafe` は storage から読み直した周期の `stepCountFromMs` を `AlarmRecord.stepCountFromMs` として渡す。
- 各境界を強制する場所は次のとおり。

  | 境界 | 数え始め（App） | 取消前の拒否 |
  |---|---|---|
  | `dueAtMs - 60分` | `getStepCountingStartMs` | `canSuppressAlarm` |
  | `armedAtMs` | `getStepCountingStartMs` | `canSuppressAlarm` |
  | 保存済み `stepCountFromMs`（永続化した床を含む） | `getStepCountingStartMs` | `processStepThresholdFailSafe` → `canSuppressAlarm` |
  | まだ保存されている他周期の停止時刻 `floorMs` | `getStepCountingStartMs` | 直接は検査しない。停止時に `applySuppressionStepFloor` が重なる周期の `stepCountFromMs` へ書き込むため、上の行で拒否される |
- 保存済み `mainAlarmId` を cancel し、OS pending 一覧から消えたことを確認した場合だけ `suppressed` にする。
- 別設定、別日、次の周期の通知と phase は変更しない（歩数の数え始めだけを上記のとおり後ろへずらす）。

### 7.2 明示確認

check-in notification の「起きています」は、次の全条件を満たす場合だけ有効である。

1. action identifier が `confirm_awake`。
2. kind が `awake_checkin`。
3. cycle、main request、check-in request が保存済み周期と一致。
4. 保存 phase が `armed` または `step_candidate`。
5. 確認時刻が check-in window 内かつ期限前。
6. main cancel 後、OS pending 一覧で消失を確認。

古い通知、default tap、重複 action、期限後 action、取消例外では main を残す。

停止の記録（suppression journal）と復旧:

- 100歩・明示確認とも、cancel の前に意図（`cancelling`）を journal へ記録し、cancel 確認後に `cancelled` へ更新してから `suppressed` を保存する。記録できなければ cancel せず main を残す（`JOURNAL_NOT_WRITTEN`）。同じ周期の記録が残っていれば新しい停止を始めない。
- 停止処理（load・journal・cancel）と起動時・前面復帰時の復旧（`recoverSuppressionJournal`）は、同一プロセス内でだけ `journal.exclusive` により直列化する。別プロセスとの排他はしない。復旧は cancel をせず、記録した正確な ID の周期だけを扱い、補充は未解決の記録がある定義を除外する。
- 永続化した記録の意味は不確実さを含む。`cancelling` のまま残り OS 予約も無い場合は、取り消し済みか発火済みか区別できないため「状態が未確認」とし、鳴る・鳴らないを断定しない。`cancelled` への更新に失敗した場合も同じ扱いになる。

## 8. 状態遷移

```mermaid
stateDiagram-v2
    [*] --> Armed: main scheduled and cycle saved
    Armed --> Armed: 0..99 steps / unknown / error
    Armed --> SuppressionPending: 100 steps or valid confirmation
    SuppressionPending --> Suppressed: exact main cancel verified
    SuppressionPending --> Armed: cancel missing, failed, or unverified
    Armed --> Ringing: due reached
    Ringing --> Dismissed: user stops alarm
    Suppressed --> [*]: cycle completed
    Dismissed --> [*]: cycle completed
```

期限と証拠が同時に競合する場合はアラームを優先する。

### 8.1 見逃した周期（Issue #17）

- 復旧猶予は期限から 30 分（`RECOVERY_WINDOW_MS`、境界ちょうどは鳴動）。起動・前面復帰・1 秒 tick で未処理の期限超過周期を検出したとき、猶予内なら `ringing`、超過なら無音の `missed` にする（`src/missedAlarms.ts`）。遅れから起床を推定しない。
- すでに鳴動中（`ringing`）の周期は、経過時間だけでは止めない。停止操作でのみ `dismissed` になる（スヌーズは 8.2）。
- 起動時のみ、保存済み `ringing` で期限から 30 分超のものを `missed` に移す（前プロセスの音は残っていないため）。30 分以内なら鳴動を継続する。
- `missed` は日付・時刻付きのカードに表示し、「すべて確認済みにする」で該当周期だけを `dismissed` にする。有効な繰り返し定義は有効のまま、既存の補充処理が次回分を維持する。
- 物理端末（実機の通知・音・VoiceOver・最大文字サイズ）での確認は未実施。

### 8.2 スヌーズ（Issue #16）

- 初期値は固定 5 分・1 回の発生につき最大 3 回（`SNOOZE_INTERVAL_MS` / `SNOOZE_MAX_COUNT`、ユーザー設定なし）。アプリが前面で鳴動カードを表示している間の画面操作のみ。**ロック画面・通知上のボタンによるスヌーズではない**（ネイティブ統合は別 Issue）。通知が届くことと、画面のボタンが押せることは別の保証である。
- 新 phase `snoozed`。`StoredAlarm.snooze = { count, notificationId, dueAtMs, pending? }`。`cycleId`・`mainAlarmId`・`dueAtMs` は不変で、スヌーズは起床証拠ではない。`canSuppressAlarm` / `processAwakeResponseFailSafe` は `armed`・`step_candidate` だけを対象にするため、スヌーズ中の発生は元の期限後に抑止できない。
- ロック順（Issue #15 の編集・停止・削除と同じ）: スヌーズ・停止・復旧は 1 回ごとに「サスペンションのロック → 保存キューの 1 ターン（`transactAlarmDefinitions`）」の中で動く（`src/snoozeTransaction.ts`）。サービスはトランザクション専用の保存スナップショットを読み書きし、書き込みごとにリセット未完了を再確認する。保存キューを待つ関数（`saveStoredAlarm` など）は中から呼ばない（自分のキューを待って止まるため）。リセット未完了中は、予約・取り消し・書き込みの前に `StorageResetPendingError` で拒否する。
- 押下の流れ（`src/snooze.ts` の `createSnoozeService`、同一キューで直列化）: 鳴動中か・回数・次の発生との期限・OS 予約件数（他アプリ分を含め 64 件）を確認 → 要求 ID を `snooze.pending` として**保存してから**予約 → 予約一覧で確認 → `snoozed` と回数・配信 ID を保存。連打は同じ処理を共有し、回数は 1 回しか増えない。
- 失敗（予約・確認・保存・容量・期限）はいずれも成功表示を出さず、鳴動を維持する。作った通知だけを取り消し、取り消しを確認できない場合は要求 ID を保存したまま残す（再起動時に取り消す）。元の通知は、置き換えが確認できるまで触らない。
- 停止は鳴動中でもスヌーズ待機中でも、その発生が持つ全 OS 通知（main・check-in・現在のスヌーズ・保留中の要求 ID・stray・メモリ保持分）を対象にする。tick が OS の main 配信より先に鳴動へ進めた直後でも、まだ保留中の main が後から鳴らないようにするため。いずれかを取り消す**前**に、全 ID を `snooze.pending`（`dismissed` の write-ahead）として保存する。保存できなければ何も取り消さず `SAVE_FAILED`。各 ID は読み戻しで消えたことを確認し、確認できない ID は記録に残して `cleanup: 'unconfirmed'`、復旧が取り消す。全て確認できたら記録を消す（この書き込みが拒否されても `dismissed` のまま復旧が片付ける）。ID 無しの分岐は main が常に含まれるため存在しない。アラームの無効化・削除・リセットも同じ ID を取り消す／記録から集める（`alarmCancellation`、`storageReset`）。
- 再起動・前面復帰: 待機中のスヌーズの通知が OS に無く時刻が未来なら同じ ID・同じ時刻で再予約する（回数は増えない）。再予約できなければ警告を出し、アプリ表示中は時刻に鳴る。スヌーズ時刻から 30 分以内に発見したら鳴動、超過なら無音の `missed`（8.1 と同じ猶予、基準はスヌーズ時刻）。
- スヌーズ待機中は画面を点けたままにする（`shouldKeepScreenAwake`）。待機中は鳴動中と同じく一覧の編集・切替・削除を受け付けない（`findAlarmListLock` が `snoozed` を返す）。スヌーズの通知を残したまま古い予約を差し替えると、取り消されない通知が鳴るため。中断された試行（`snooze.pending`）が残る発生を持つアラームの編集も、復旧で片付くまで拒否する。配信通知は保存済みの最新状態に対して `markDeliveredCycleRinging` で適用し、古い読み取りのコピーを書き戻さない。キュー整合（Issue #13）はスヌーズ中の発生の元の通知を作り直さず、スヌーズの配信 ID を孤児として取り消さない。
- 物理端末での通知配信・音・VoiceOver・最大文字サイズでの到達性は未確認。単体テスト・export は実機動作の証拠ではない。

## 9. 複数アラーム操作

### オフ

definition が持つ check-in と main を個別に cancel し、OS pending 一覧で消失を確認する。成功後に `enabled=false`、`cycles=[]` を保存する。確認できなければ設定を変更せずエラーを表示する。

### オン

repeat rule から先3周期を再計算し、新しい cycle ID と notification ID を発行する。過去になった「今日だけ」は再利用せず、新規作成を求める。一覧の行には元の日付と「終了」を表示（accessibility label も同じ）し、終了済みでオフの定義は Switch を無効にして、編集・オンで別の日付へ移せないようにする（`prepareAlarmEnable` / `describeTodayOnlyExpiry`）。自動で翌日へ繰り越さず、「Once」へ改名もしない。

### 削除

確認ダイアログ後、対象 definition の通知だけを解除する。解除成功後に definition を削除する。

### 編集（時刻・繰り返し。Issue #15）

一覧の「編集」から追加フォームを現在の時刻・繰り返しで事前入力して開く。鳴動中・期限到達済みの周期が1つでもある間は開始も保存も拒否する（`findAlarmListLock`。保存時は最新の状態で再判定）。同じ definition の停止処理・停止 journal・前回の編集が残る間も拒否する。保存は `editAlarmDefinition`（`src/alarmEdit.ts`）が次の順で行い、停止確認と同じ排他（`suppressionJournal.exclusive`）と保存 queue の中で実行する。

1. 排他と保存 queue を取得した後に時計を読み直し（`now()` を注入）、最新の保存データで検査する（未来の周期が10秒以上先か。`today` は元の日付を保持し、日付・時刻が過ぎていれば拒否）。オフの definition は通知を扱わず、時刻と繰り返しだけを保存して終える。
2. OS の実際の予約数（`getAllScheduledNotificationsAsync`。Expo Go ホストなど他の通知も数える）＋新しい main 通知数（最大3）が64を超える場合は、何も変更せず拒否する。先に確保するのは main だけなので、10件満杯（60件）でも編集できる。main を空けるために別の main を犠牲にすることはしない。
3. 編集 journal（`already-up/alarm-edit-journal/v1`）に旧 ID 一覧を記録し（`scheduling`）、新しい main を1件ずつ予約する。予約する ID は呼び出し側で決め（`${cycleId}-main`。SDK 57 の `scheduleNotificationAsync` の `identifier`）、OS 呼び出しの前に journal へ記録する。クラッシュや応答の喪失があっても、記録済みの ID を取り消せば孤児が残らない。
4. 予約に1件でも失敗（メイン通知）した場合は、記録済みの新 ID だけを取り消し、旧アラームはそのまま残す。取り消しを確認できない新 ID は journal に残して次回起動で再試行する。
5. 予約後に時計を読み直し、旧周期が期限に達していた、または新周期の先頭が10秒未満になった場合は、新 ID を取り消して中止する（旧アラームは完全に不変）。問題なければ新周期（check-in ID は予約前に記録）を journal に記録（`replacing`）してから、自分の旧 ID だけを確認付きで取り消す。順序は旧 main → 旧 check-in。各取り消しの直前に時計を読み直し、期限に達した旧周期の通知は取り消さず、その周期のデータ（鳴動前後を含む）も新しい definition に残す。旧 main を1件も消す前に失敗・期限到達した場合は新 ID を取り消して旧アラームを維持する（旧 check-in にも触れていないため、完全に不変）。旧 main を消した後に失敗した場合は、新周期が予約済みのため新しい内容で確定し、残った旧 ID を journal に残して注意を表示する（`cleanupPending`）。取り消しが例外でも OS の一覧から消えていれば取り消し済みとして扱う。
6. 旧通知を解放した後に、新しい check-in を予約する（任意）。予約数を数え直し、64を超える場合や予約に失敗した場合は、その周期の check-in だけを省略して警告にする。main は決して省かない。
7. 保存直前にもう一度時計を読み、期限に達していて main を取り消せていない旧周期は新周期と一緒に保存する。新しい definition（時刻・繰り返し・歩数と window は 0 から）の保存に成功したら journal を消す。保存が2回失敗した場合は journal を残し、次回起動で `recoverPendingAlarmEdit` が完了させる。

復旧は起動時（停止 journal の復旧より前）に行う。`scheduling` は新 ID のみ取り消して旧アラームを維持し、`replacing` は新周期を保存して残った旧 ID を取り消す（OS に存在しない新 check-in ID は外す。復旧時点で期限に達している旧周期とその通知は残す）。journal が残る definition は補充・オン/オフ・削除・再編集を行わない。`suppressed` を確定する条件（記録済み ID の取り消し確認後）と、Expo Go ホストなど無関係な通知を取り消さない原則は変えない。歩数の方針（前面・予定の60分前から）も変えない。

### 鳴動停止・起床確認後

`today` は無効化する。繰り返し設定は完了周期を残りの周期と区別し、予約枠を最大3件へ補充する。

## 10. 保存と移行

- v2 key: `already-up/alarm-definitions/v2`
- legacy key: `already-up/active-alarm/v1`
- v2 は `{ version: 2, alarms }` として保存する。
- ID 重複、時刻範囲、repeat rule、cycle shape、最大10件を load / save の両方で検証する。`stepCountFromMs` は任意項目で、存在する場合だけ有限の数値であることを検証する（未設定の旧データは有効）。
- 全ての read-modify-write は直列 mutation queue 内で最新値を読み直し、通知応答・歩数更新・画面操作・起動時補充が互いの保存結果を古い snapshot で上書きしない。
- v2 が存在せず valid な v1 がある場合、`today` definition 1件へ移行し、v2 保存成功後に v1 key を削除する。
- malformed data では推測復旧せず、予約済み通知を勝手に解除しない。
- 読めない保存データからの脱出は、失敗カード（`loadFailed`）上の「通知を解除してリセット」だけから、2回の確認（`Alert` 2連続）を経て実行する。起動・前面復帰・通知応答・補充などの自動経路は保存データも通知も消さない（`tests/appWiring.test.ts`）。
- リセットは再利用できる `createStorageResetService`（`src/storageReset.ts`）が行う。`cancelAllScheduledNotificationsAsync` は使わない（Expo Go は他プロジェクトの通知と同じ予約キューを共有する）。解除対象は、新規予約の payload に付く固定マーカー `owner: 'already-up/v1'` に加え、kind ごとの必須 ID（main は alarmId・cycleId、check-in は alarmId・cycleId・mainAlarmId・category）が揃う通知（`isOwnedAlarmNotification`）と、単独で検証に通った保存元（definitions v2、legacy、suppression journal）の正確な ID だけ。壊れた JSON から ID を推測しない。
- **互換性の制限**: マーカー導入前に予約された通知は payload だけでは他の Expo Go プロジェクトの通知と区別できない。保存済みの正確な ID（definitions・legacy・suppression journal・中断した intent）が読める場合に限り解除し、それ以外の契約形式の通知は kind/title だけで解除せず「判別不能」として残す。通知応答（action）の解釈はマーカーなしでも従来どおり受け付ける。
- reset は `{ ambiguousCount }` を返す。1件以上残る場合は「判別できない古い通知が残り、鳴る場合がある」という警告を表示し、`already-up/storage-reset-limitation/v1` に記録して再起動後も起動時に再確認・再表示する（残りが0件になれば自動で消す）。判別不能な通知は保存データの回復と新規アラームの追加を妨げない。
- 手順は、①`already-up/storage-reset-intent/v1` に意図と既知 ID を保存、②該当通知を ID 指定で解除、③予約キューを再取得して残りがないことを確認、④definitions・legacy・cancellation journal・suppression journal を削除、⑤最後に intent を削除。解除を確認できなければ保存データと intent を残して失敗を返す。intent が残る間は起動時も失敗カードを維持し、利用者が再試行する（自動再開しない）。
- reset は suppression journal の排他 → `runExclusiveAlarmStorage`（definitions と cancellation journal のキュー）の順で直列化し、停止・追加・補充と同時に走らない。

## 11. UI 契約

- 上部はブランド、画面タイトル、追加ボタンだけにし、prototype / presentation 表示を置かない。
- 次回アラームは時刻、日付、残り時間を表示する。歩数 window 開始前は進捗barを出さず「起床確認は HH:MM から」「アプリ表示中に100歩」と開始時刻を示し、window 中だけ「起床確認 N / 100歩」と進捗barを表示する。進捗は現在の window で数えた歩数だけを使う。
- 通常文字サイズでは有効時 / idleのsummary cardを同じ140pt固定高とし、一覧の開始位置を動かさない。Dynamic Typeのアクセシビリティscroll時だけ、文字を切らないため同じ140pt最小高から内容に応じて拡張する。
- 設定一覧は時刻、repeat label、次回日付、toggle、予約範囲、編集、削除を表示する。「編集」は削除と同じ44pt以上のボタンで、押すと追加フォームを同じ部品のまま事前入力して開く（タイトル「アラームを編集」、確定「この内容で保存」。オフの definition は「オフのまま保存します」と概要に示す）。予約範囲は `describeScheduleCoverage`（`src/scheduleCoverage.ts`）で、未来の `armed` / `step_candidate` 周期だけから求める。

  | `describeScheduleCoverage` | 行の表示 |
  |---|---|
  | `off`（オフ） | `通知は予約されていません` |
  | `none`（オンだが未来の監視周期がない） | `予約がありません`（警告色） |
  | `scheduled`（`isRunningLow = false`） | `{最後の周期の日付}まで予約済み`（例: `10/7(水)まで予約済み`） |
  | `scheduled`（`isRunningLow = true`。`today` 以外で残り1周期以下） | `{日付}まで予約済み・アプリを開くと先の分を予約します`（警告色） |
  | 上と同じで、直近の補充に失敗（5章。`getScheduleCoverageLine` の `refillFailed`） | `{日付}まで予約済み・先の分を予約できませんでした`（警告色）。アプリを開いていても補充できないため、開くよう促さない |

  日付は次回アラーム card と同じ `M/D(曜)` 形式とする。通知配送の警告中（11.1）は、オンの各行で予約範囲の代わりに配送できない理由を同じ警告色で表示する。
- メイン画面は通常文字サイズでは外側を `View` として viewport 内に固定し、ページ全体をスクロールさせない。アラーム一覧だけを独立した `ScrollView` とし、件数が増えた場合もヘッダー、次回アラーム、追加導線、一覧panelの丸い下端をviewport内へ固定する。
- Dynamic Type の `fontScale > 1.3` では情報欠落を避けるアクセシビリティ例外として外側スクロールを許可し、通常文字サイズでは一覧以外を固定する。
- 追加フォームはメイン画面の layout tree に挿入せず、背景を blur する `Modal` 上のサブ画面として表示する。タイトル直下の「時刻」「繰り返し」で内容を分け、選択中のglass lensをspring移動させる。通常端末（高さ700pt以上、幅360pt以上、`fontScale <= 1.3`）はsheet高を固定して内部スクロールを無効化し、繰り返しと100歩の説明も1画面内で操作できる。小さい画面・狭い画面・大きい文字では情報欠落を避けるためフォーム本体だけを内部スクロールし、repeat labelは2行まで許可する。
- 時刻設定の標準操作はnative pickerとする。iOSは「時刻」内の先頭に`display="spinner"`の216pt wheelを常時表示し、選択帯を含めて角丸surface内にclipする。Androidは公式推奨のimperative APIで`display="clock"` dialogを開く。選択時刻と`数字で入力`はpicker後段のsecondary controlとし、表示時刻をタップした場合だけ時・分のnumeric keyboard inputへ切り替える。入力は`0..23` / `0..59`を確定時に検証し、不正値では親のalarm stateを更新しない。編集中はpickerを閉じて追加CTAと「繰り返し」切替を無効化する。`fontScale > 1.3`では横並びcopyを縦積みにする。
- 状態通知はstatus barの下、brand rowより上のabsolute overlay layerへspring表示し、メインlayoutを押し下げない。上端のdrag handleでgestureを示し、閉じるbuttonに加えて、上方向へ32px以上または十分な上向き速度でswipeするとdismissし、未達gestureは元の位置へ戻す。Reduce Motion時は自動springを無効化する。
- 追加エラーはスクロール領域外の固定footerに表示し、custom曜日未選択のようなdisabled理由は表示中のtabにかかわらず常時示す。dangerはassertive、その他の状態通知はpoliteとしてassistive technologyへ通知する。ただし頻繁なalarm toggleは完全成功時のbannerを出さない。例外による失敗はdanger、アラーム本体を保存できても一部の起床確認通知を予約できなかった場合だけwarningを表示する。追加処理中はtab、picker、repeat、曜日、確定操作をすべて無効化する。
- iOS 26 以降は `expo-glass-effect` の native Liquid Glass を使う。旧iOSとWebは `expo-blur`、Androidは既存UIの見た目と負荷を維持するため、SDK更新後も半透明 surfaceへfallbackする（`blurMethod="none"`）。Reduce Transparency 有効時はsemantic stateを保った不透明度の高い surface に切り替える。
- Glassは背景写真と操作面の関係を示す上部summary、追加、通知、時刻編集、選択lens、確定へ限定する。alarm list panelと各alarm cardは読みやすいstandard materialを維持し、大面積の背景全体を一律に透明化しない。
- 追加フォームの「時刻／繰り返し」とrepeat controlは、それぞれ1つのglass lensを選択肢間でspring移動させ、単なる背景色の切替にしない。native GlassView自体のopacityはanimateせず、wrapperのgeometryを移動する。Reduce Motion時は選択位置を即時更新する。
- Glass surface 上でも本文・操作のコントラストを維持し、tintは主操作・選択・statusの意味がある箇所だけに使う。glass-on-glassを避ける。
- ホーム背景は端末のローカル時刻とtimezoneだけから決定し、同一の湖畔景観をphotorealisticに生成した夜明け、昼、夕暮れ、夜の4 assetを連続cross-fadeする。基準の日の出は06:00、日の入りは18:00とし、codeで星、太陽、月、山を描くillustration layerは使わない。背景はdecorativeとしてaccessibility treeから除外し、上部scrimでstatus barとheaderの白文字contrastを維持する。
- 背景assetのopacity計算は純粋関数に分離し、任意時刻で隣接する最大2 assetだけを合計opacity 1でblendする。React Nativeの`Image`もopacityが0より大きい最大2枚だけをmountし、4枚同時decodeを避ける。既定は位置情報を使わない固定06:00/18:00で、任意の日の出・日の入り設定は11.5に従う。国籍、networkは入力しない。
- Web は UI smoke test とし、通知操作を disabled にする。

### 11.1 通知配送状態

アプリが画面に表示されていない間（閉じている・画面ロック・ほかのアプリが前面。background / terminated）にアラームを鳴らせるのは OS の local notification だけであるため、通知権限から配送状態 `NotificationDeliveryState` を判定し（`src/notificationDelivery.ts`）、鳴らない可能性がある間は「設定済み」に見える表示をしない。判定できない場合は `unknown` とし、`ok` とみなさない。

| `getPermissionsAsync()` の結果 | 状態 |
|---|---|
| 結果なし（`null` / `undefined`） | `unknown` |
| iOS `status` 0（NOT_DETERMINED）/ 1（DENIED） | `off` |
| iOS `status` 3（PROVISIONAL。通知センターへ静かに配送） | `silent` |
| iOS `status` 2（AUTHORIZED）/ 4（EPHEMERAL）かつ `allowsSound === false` | `silent` |
| iOS `status` 2 / 4（上記以外） | `ok` |
| iOS `status` がそれ以外の値 | `unknown` |
| `ios` なし（Android） | `granted` なら `ok`、それ以外は `off` |
| 取得時の例外 | `unknown` |

確認のライフサイクル:

| 契機 | 動作 |
|---|---|
| 起動直後（読み込み完了前） | 状態は `null`（未確認）。警告しない |
| 起動時の読み込み完了後 | `getPermissionsAsync()` で確認する（prompt は出さない） |
| `AppState` が `active` へ変化 | 再確認する。設定アプリから戻った時の復旧と、設定後の無効化を検知する |
| アラームの追加・オン/オフ操作の終了後 | 成功・失敗とも再確認する（権限 prompt の結果を反映） |
| Web | 確認しない（`null` のまま） |

警告は「状態が `ok` 以外」かつ「オンのアラームが1件以上」の場合だけ表示する（`shouldWarnNotificationDelivery`）。

| 状態 | summary card（鳴動中でない場合） | オンの各行 |
|---|---|---|
| `ok` | 通常の次回アラーム / idle card | 予約範囲（11章。例: `10/7(水)まで予約済み`） |
| `off` | 「通知がオフです」「通知がオフのため、次のアラーム {日付} {時刻} は、アプリを画面に表示したままにしていないと鳴りません。」 | `通知オフ・アプリ表示中のみ鳴ります` |
| `silent` | 「通知の音がオフです」「通知の音がオフのため、次のアラーム {日付} {時刻} は、アプリを画面に表示したままにしていないと音が出ません。」 | `通知音オフ・アプリ表示中のみ音が出ます` |
| `unknown` | 「通知の状態を確認できません」「…鳴るか確認できません。」 | `通知の状態を確認できません` |

- 警告 card は次回アラーム card を置き換える danger 状態であり、閉じられない。配色は鳴動 card の danger tone を流用し、Dynamic Type で文言を切らないため140pt最小高から拡張する。
- 次回周期がない場合（オンだが予約なし）も、日付を除いた文言で警告する。
- `設定を開く`（`accessibilityRole="button"`、44pt以上）は `Linking.openSettings()` を呼ぶ。Expo Go では Expo Go の設定画面が開く。失敗時は danger notice を出す。
- 通知なしで鳴らせるのは端末内ループ音だけであり、ループ音は期限の時点でアプリが画面に表示されている間にしか鳴り始められない（`ringing` への移行と再生開始は JS の1秒 tick で行うため、アプリを閉じている・画面ロック中・ほかのアプリが前面の間は鳴り始めない。11.2）。一度鳴り始めたループ音は `setAudioModeAsync({ shouldPlayInBackground: true })` により background でも継続する設定とする。`expo-audio` config plugin の `enableBackgroundPlayback`（UIBackgroundModes への `audio` 追加）は prebuild / development build でのみ反映され、App Store 版 Expo Go では Expo Go 本体の Info.plist に依存する（Expo Go 57.0.9 の bundle は UIBackgroundModes に `audio` を含む）。画面ロック・アプリ切替の後も鳴り続けるかは Expo Go 実機で未確認（BED-08）。そのため `off` / `silent` の文言は「アプリを画面に表示したままにしていないと」鳴らない（音が出ない）、行は「アプリ表示中のみ」とし、「アプリを閉じていると」に限定しない。表示中は鳴るため、常に鳴らないとも表示しない。
- 鳴動中は鳴動 card を優先し、各行の警告だけを表示する。
- 配送状態はアラーム周期の状態を変更しない。`off` でも予約・保存済み周期を解除しない。

### 11.2 就寝時の表示と画面スリープ防止（2026-10-05決定）

Expo Go 配布のままでは、アプリを閉じる・画面がロックされると、アラームは main 通知の通知音1回だけになり、ループ音と歩数確認は動かない。owner 決定（2026-10-05）により、当面は「アプリを画面に表示したまま充電して寝る」ことを正式手順とし、監視中は画面を消さない。本番は自前ビルド（native alarm / AlarmKit 等）へ移行する（ALR-001）。配布方式と native config は変更しない。

画面スリープ防止の条件は純粋関数 `shouldKeepScreenAwake(alarms, nowMs)`（`src/bedsideMode.ts`）で判定する。

| 状態 | 画面を消さない |
|---|---|
| いずれかの周期が `ringing`（定義の `enabled` は問わない。鳴動 card とループ音が `enabled` に依存しないため） | する |
| オンの定義に `armed` / `step_candidate` 周期があり、`dueAtMs <= now + 24時間`（`KEEP_AWAKE_LOOKAHEAD_MS`。ちょうど24時間後を含む） | する |
| 上記のうち期限を過ぎた監視周期（1秒 tick で `ringing` へ移る直前） | する（移行前に画面が消えてアプリが止まるのを防ぐ） |
| オンの監視周期が24時間より先だけ、オフの定義だけ、停止済み（`suppressed` / `dismissed`）周期だけ、アラームなし | しない（端末の自動ロック設定に従う） |

ライフサイクル（`App.tsx`）:

- 条件が true かつアプリが前面にある間だけ `activateKeepAwakeAsync('already-up/bedside')` を呼び、条件が false になった時・前面でなくなった時・unmount 時に同じ tag で `deactivateKeepAwake` を呼ぶ。他の keep-awake 利用（Expo の開発用 tag など）とは tag で分離する。
- 開発モード（`expo start` の dev bundle）では、Expo の `registerRootComponent` が `withDevTools` 経由で `useKeepAwake(ExpoKeepAwakeTag)` をセッション全体で有効にする。tag が別なので bedside の解除はこれを解除せず、上の条件に関係なく画面は消えない。条件どおりの動作は production の JS bundle（`npx expo start --no-dev --minify` を Expo Go で読み込む）でだけ確認できる（BED-05）。
- 前面の判定は `isForegroundAppState`。`background` だけを前面外とし、`active`、`inactive`（iOS の Control Center 表示・着信 overlay 中など）、読み取れない状態は前面とみなす。誤って画面を消すより、画面を点けたままにする方を安全側とする。`active` に戻るたびに再取得する。
- Web では呼ばない。activate の失敗はアプリを止めず、warning notice `getBedsideGuidance(配送状態).keepAwakeFailure`（下の就寝案内の表）を表示する。文言は失敗した時点の最新の配送状態で決め、配送状態の変化で keep-awake を掛け直さない。deactivate の失敗は無視する。
- 画面の明るさは変更しない。手動ロック、ほかのアプリへの切替、着信などによる中断は防げない。

就寝案内 footer:

- 文言は純粋関数 `getBedsideGuidance(配送状態)`（`src/bedsideMode.ts`）で決め、footer・追加フォームの100歩の説明（2行をつないだ1行）・keep-awake 失敗 notice に同じものを使う。
- 1行目は常に「寝るときはアプリを画面に表示したまま充電してください」（12pt / 700）。「開いたまま」は習慣で画面をロックした後も満たしていると読めるため使わない。
- 2行目（11pt / 600）は画面ロックとアプリを閉じることの両方を挙げ、配送状態（11.1）に応じて届かない通知音を約束しない。配送状態だけで決め、オンのアラームの有無には依存しない（これから追加する人にも正しい）。未確認（`null`。Web では常に `null`）は確認前に通知音を約束しないため `unknown` と同じにする。11pt 未満にしない。

| 配送状態 | 2行目 | keep-awake 失敗 notice |
|---|---|---|
| `ok` | 画面ロック・アプリを閉じると通知音1回だけ・歩数確認なし | 画面を点けたままにできませんでした。画面が消えるとアラームは通知音1回だけ・歩数確認なしになるため、端末の自動ロックをオフにしてください。 |
| `off` | 画面ロック・アプリを閉じると鳴りません | 画面を点けたままにできませんでした。画面が消えるとアラームが鳴らないため、端末の自動ロックをオフにしてください。 |
| `silent` | 画面ロック・アプリを閉じると音が出ません | 画面を点けたままにできませんでした。画面が消えるとアラームの音が出ないため、端末の自動ロックをオフにしてください。 |
| `unknown` / 未確認（`null`） | 画面ロック・アプリを閉じると鳴るか確認できません | 画面を点けたままにできませんでした。画面が消えるとアラームが鳴るか確認できないため、端末の自動ロックをオフにしてください。 |

- 配置: footer は `ScreenFrame`（通常は固定レイアウト、`fontScale > 1.3` では画面全体がスクロール）の外に置き、`SafeAreaView` の最下部（下端の safe area の上）に flex の兄弟要素として固定する。スクロール位置・文字サイズ・画面高（iPhone SE の667pt を含む）にかかわらず初期表示で見える。絶対配置で重ねず、footer の高さはコンテンツ領域から差し引かれるため、操作要素を覆わない。通常は `flex: 1` の一覧 panel が縮み（一覧は内部スクロールで全件に到達できる）、`fontScale > 1.3` では footer より上のスクロール領域が縮む。幅は `screen` と同じ最大620pt・左右16pt。
- footer 全体を1つの accessibility 要素とし、2行をつないだ label を読み上げる。`allowFontScaling` を有効にし、`maxFontSizeMultiplier` は2とする（固定表示のため、最大の文字サイズでもスクロール領域を大きく残す）。幅が足りない場合は省略せず折り返す。
- 背景写真の上に自前の backdrop（`rgba(6, 21, 45, 0.86)`、角丸12pt）を敷き、文字は `#FFFFFF` / `#C5CDD8` とする。写真が白・黒のどちらでも 4.5:1 以上のコントラストを保つことを unit test で確認する（`BEDSIDE_FOOTER_COLORS`）。

### 11.3 実機テスト前の既存デザイン修正（2026-10-15）

新しい画面や外観は追加せず、既存の card・行・フォームの挙動と文言を直した。判定は `src/homeStatus.ts` の純粋関数で行う。

- 鳴動中（`isAlarmListLocked`）は一覧のスイッチと削除を無効にし、一覧を薄く表示して読み上げ対象から外す。繰り返しの全周期をここから誤って取り消さないため。
- 鳴動 card は見出し「鳴っています」、停止ボタン「アラームを止める」（56pt以上。起床確認ではなく音を止める操作）。鳴り始めに停止ボタンへ VoiceOver フォーカスを移す（300ms 後。追加画面が開いていた場合は閉じた後。iOS は onDismiss の100ms 後、ほかは700ms 後）。別の読み上げ（announce）は行わず、フォーカスが当たった停止ボタンの label（日本語は「10/15(水) 07:00のアラームが鳴っています。アラームを止める」、英語は日付つきで “The 7:00 AM alarm for Wed, 10/15 is ringing. Stop alarm”。スヌーズ鳴動では、その配信の時刻と日付 `getRingingDisplay` を使う。時刻は端末の言語と12/24時間設定に従う。11.6。`getRingingStopA11yLabel`）が読まれる。実機の VoiceOver では未測定。
- 停止済みで期限前の回は、card 下と該当行に「10/3(土) 07:00 は100歩（または通知）で起床確認済みのため鳴りません」を表示する（`describeSuppressedOccurrence`。`stepCandidateRecorded` で理由を分ける）。
- 歩数が使えない（端末にない・拒否・エラー）ときは進捗barと「n / 100歩」を隠し、「歩数による停止を確認できません。予定を確認してください」を表示する（先頭に「この端末では歩数を使えません。」「歩数の利用が許可されていません。」「歩数を計測できません。」のいずれかが付く）。通知配送や停止の保存が不明な場合もあるため、アラームが鳴るとは約束しない。拒否時だけ「設定を開く」。この間 card は最小140ptから内容に応じて伸びる（`getStepGuidance`）。
- 保存データを読み込めない場合（`loadFailed`）は通常の空状態や「次のアラームはありません」を出さず、閉じられない danger card と一覧の説明を表示し、＋を無効にして理由を読み上げに含める。カード末尾に、再起動でも直らない場合の最後の手段として「通知を解除してリセット」（44pt以上、折り返し可）を置く。処理中は無効化し、失敗時もカードを維持し、一部がすでに消えている場合があること・再実行で続きから再開することを通知する。成功すると＋が有効になる。バナーは使わない（次の操作で消えるため）。
- 追加フォームは全タブ共通で「平日・初回 10/5 07:00（2日9時間後）」を追加ボタン上に表示し、24時間より先は注意色にする（`summarizeNewAlarm`）。追加成功バナーにも初回日時を入れる。
- 最大文字サイズ: 画面名・時刻（card・一覧・鳴動）は1行で自動縮小し、＋は文字拡大しない。鳴動 card の補足文は時刻と重ならない通常の並びにした。
- 小さい文字の色は `HOME_COLORS`（`src/ui/tokens.ts`）に集約し、`tests/homeContrast.test.ts` で白・黒の背景写真上でも 4.5:1（進捗barは 3:1）を固定する。native Liquid Glass 表示の実測はできていない。

### 11.4 設定・データとプライバシー（Issue #21、2026-10-15）

**設計ターゲット（実装前に確定）。** 新しい外観や素材は作らない。視覚の基準は既存の `App.tsx` のヘッダー行、`AlarmComposerModal` の sheet（`modalRoot` の薄い暗幕、白い角丸 sheet、見出し＋閉じる行、`GlassSurface` の丸い閉じるボタン）、`GlassSurface` とする。Product Design の get-context は親が事前実行済みで、本変更はその結果（既存デザインを守る）に従う。このセッションで公式 skill を別途実行してはおらず、新規の画像・ブランド・アイコン素材も生成していない。

**選定した案。**

| 案 | 内容 | 採否 |
| --- | --- | --- |
| A | ヘッダーの＋の隣に小さな設定ボタンを置き、composer と同じ見た目の sheet（`SettingsModal`）を開く | **採用** |
| B | 一覧の末尾に常設のデータ削除ボタン | 不採用。鳴動停止・アラーム一覧より目立ち、誤操作しやすい |
| C | 専用のフルスクリーン画面を追加 | 不採用。既存にない画面遷移を新設する |

- 設定ボタンは＋と同じ 52pt のガラス円（最小44pt以上）。ラベルは「設定とプライバシー」、ロール button。グリフは文字「⋯」（新規アイコン素材なし）。拡大しない。
- `SettingsModal` は再利用できる枠（タイトル、閉じる、スクロール本文、`children` 差し込み口）。後続の背景・言語設定は同じ枠へ足す。今回は無関係な設定を置かない。
- 本文は `SafeArea` を避けた `ScrollView`。最大文字サイズでも「閉じる」と削除ボタンに届く。削除ボタンは 44pt 以上で折り返し可。
- 先頭にプライバシー要約（保存する項目・保存先・外部送信しないこと）、続けて「データの削除」。詳細は `docs/PRIVACY.md`。
- 削除は native `Alert` の2段階確認。鳴動中は sheet を開かず設定ボタンも無効にする（停止ボタンと一覧の優先順位を変えない）。鳴動はこの sheet より優先し、開いている間に鳴り始めたら sheet を閉じる。
- 削除の失敗時は画面上のアラームを書き換えない（保存側は一部がすでに消えている場合がある）。その旨と、再実行で続きから再開すること、削除が終わるまでアラームの追加・変更ができないことを sheet 内に残す。再起動後は未完了の削除意図が残るため、既存の復旧カードから続行する。自動では削除しない。
- 既存の「通知を解除してリセット」（保存読込失敗カード）は同じ `createStorageResetService` を使い、挙動を変えない。

### 11.5 診断コードと復旧文言（Issue #20、2026-10-15）

**設計ターゲット。** 新しい外観・素材は作らない。既存の `NoticeBanner`（ガラスのバナー）と保存失敗カード、歩数の状態行の見た目を保ち、診断コードは本文の下に小さく添える二次情報にする。開発者向けの画面・ダイアログ・コピー操作は追加しない。Product Design の公式 skill をこのセッションで別途実行してはおらず、画像生成もしていない。

**カタログ（`src/errorCatalog.ts`）。** 失敗点ごとに、安定した機械コード（例 `MAIN_UNVERIFIED`）、事実だけを述べる日本語の `message`、回復手順 `recovery`、`tone`、`retry`（`none` / `manual` / `next_launch`）を持つ。翻訳用に `errors.<CODE>.message` / `.recovery` のキーを返す（Issue #22 が §11.6 のとおり `Messages.errors` に日本語・英語の全文を持つ）。

| 区分 | コード |
| --- | --- |
| 通知権限 | `NTF_PERMISSION_DENIED`（拒否）、`NTF_PERMISSION_CHECK_FAILED`（状態を読めない）、`NTF_SETUP_FAILED`、`NTF_UNSUPPORTED_PLATFORM` |
| メイン登録・確認 | `MAIN_REGISTER_FAILED`、`MAIN_UNVERIFIED`（登録後に OS の予約一覧で確認できない・一覧を読めない）、`MAIN_PARTIAL` |
| 起床確認のみ | `CHECKIN_REGISTER_FAILED`（メインは残る、tone=warning）、`CHECKIN_PARTIAL` |
| 歩数センサー | `SENSOR_UNAVAILABLE`、`SENSOR_AVAILABILITY_UNKNOWN`、`SENSOR_PERMISSION_DENIED`、`SENSOR_PERMISSION_UNKNOWN`、`SENSOR_READ_FAILED` |
| 保存 | `STORAGE_READ_FAILED`、`STORAGE_CORRUPT`、`STORAGE_SAVE_FAILED`、`STORAGE_JOURNAL_CORRUPT`、`STORAGE_JOURNAL_SAVE_FAILED`、`STORAGE_RESET_PENDING`、`STORAGE_RESET_INCOMPLETE` |
| 無効な操作・期限 | `ACTION_INVALID`、`ACTION_STALE`、`DEADLINE_PASSED`、`TIME_*`、`REPEAT_INVALID`、`ALARM_*`、`ARM_LEAD_TOO_SHORT`、`STEP_COUNT_INVALID` |
| 取り消し | `CANCEL_UNKNOWN`、`CANCEL_NOT_VERIFIED`、`SUPPRESSION_JOURNAL_NOT_WRITTEN`、`SUPPRESSION_SAVE_FAILED`、`CANCEL_RECOVERY_INCOMPLETE`、`DISABLE_CANCEL_INCOMPLETE`、`DELETE_CANCEL_INCOMPLETE`、`ROLLBACK_INCOMPLETE`、`NOTIFICATION_CANCEL_UNVERIFIED` |

全コードの一覧は `ERROR_CODES`。名前の変更・再利用はしない（追加のみ）。

**不変条件。**
- UI は `error.message` を読まない。コードは `errorCodeOf`（既知のカタログコードを持つ値だけ）で取り、文言は必ずカタログから出す。ファイルパスやトークンを含み得る OS・保存層の例外文は、`AppError.cause` に保持するだけで画面・notice に出さない。
- メイン通知は予約直後に OS の予約一覧で ID を確認する（`withMainVerification`、読み取りのみ）。確認できない・一覧を読めない場合は `MAIN_UNVERIFIED` とし、周期を保存せず、成功表示を出さない。一覧を読めないだけで通知が実在する場合があるため、文言は「鳴るかどうか分かりません。別の目覚ましを併用」とする。この確認に失敗しても自動で取り消し・再予約しない。
- 起床確認だけが失敗した場合はメインを残し、warning と `CHECKIN_REGISTER_FAILED` を出す（その回は起床確認による停止を使えない）。
- 取り消しの失敗・不明（`CANCEL_UNKNOWN` / `CANCEL_NOT_VERIFIED`）は破壊的操作のため自動再試行しない。`retry: 'next_launch'` を持つのは、既存の耐久ジャーナルを続きから実行するもの（停止の保存復旧、無効化・削除の取り消し）だけ。有限の再試行は、取り消し確認後の保存 2 回（既存）以外に増やしていない。
- スヌーズ・停止の結果は「操作の成否」「通知の取り消し確認（`cleanup`）」「追跡の保存先（`tracking: 'memory_only'`）」「後続処理（refill）」を別々に扱い、片方の成功でもう片方の警告を消さない。拒否されたスヌーズ（`SNOOZE_CLEANUP_UNCONFIRMED` / `SNOOZE_CLEANUP_MEMORY_ONLY`）、受理されたスヌーズ（`SNOOZE_ACCEPTED_CLEANUP_*`）、成立した停止（`STOP_CLEANUP_*`）、起動時の復旧（`SNOOZE_RECOVERY_MEMORY_ONLY`）は別コード。メモリのみの追跡は「端末に記録している」と言わず、アプリ終了で失われると伝える。`STOP_SAVE_FAILED` は最初の保存の失敗＝通知を一つも取り消していない状態（旧 `STOP_CANCEL_FAILED` は停止が cancel 失敗を返さなくなったため削除）。停止成功後の refill 失敗と取り消し未確認は `noticeFromCodes` で両方の文を表示する。表示順は `presentStopped` / `presentSnoozed`（音 → 確定済みスナップショット → refill）。
- 診断コードは notice の二次行（小さい文字、`selectable`、VoiceOver は「エラーコード …」）、保存失敗カードの末尾、歩数の状態行に出す。本文の文は、コードがなくても意味が通る。

**未統合（他 Issue のマージ後）。** `docs/REMAINING_ISSUES.md` の ALR-009「Issue #20 の状況」に記録。

### 11.6 日本語/英語表示とアクセシビリティ（Issue #22、2026-10-15）

**設計ターゲット（実装前に確定）。** 新しい外観・素材・画面は作らない。視覚の基準は既存の写真背景、`GlassSurface`、追加 sheet（composer）、設定 sheet、ホームの各 card とし、文言を差し替えても同じ配置・色・余白で読めることを目標にする。Product Design の公式 skill は、新規画面や再設計ではなく既存デザイン内の文言・状態表現の修正にあたるため、このセッションでは実行していない（未実行として記録）。画像生成もしていない。

**選定した案。**

| 案 | 内容 | 採否 |
| --- | --- | --- |
| A | 全文言を型付き ja / en カタログへ集約し、端末の言語と時計設定に追従。既存の見た目は変えず、折り返し・スクロール・状態の文字表現だけ足す | **採用** |
| B | アプリ内に言語切替の設定画面を足す | 不採用。永続設定を増やさず端末の言語に従う方針。設定 sheet は後続の設定のための枠のまま |
| C | 画面ごとに文字列を直接書き換える | 不採用。日英の欠落をコンパイル時に検出できない |

**言語の決め方。** `src/i18n/locale.ts`（RN 非依存）。端末の言語順位のうち最初に対応する言語（日本語・英語）を使い、対応言語が無ければ日本語。端末が英語なら英語。永続設定は持たず、`expo-localization`（SDK 57、Expo Go 同梱。公式ドキュメント v57 の Localization / Localization guide を確認）の `getLocales()` / `getCalendars()` を `src/i18n/deviceLocale.ts` だけで読む。iOS はアプリ実行中に結果が変わらないが Android は再起動なしで変わるため、アプリが前面へ戻るたび（`AppState` の `active`）に読み直す。config plugin は `supportedLocales: ['ja', 'en']`（端末設定のアプリ別言語用）だけを設定し、ネイティブ再ビルドを要する設定は増やさない。

**カタログ。** `src/i18n/ja.ts` が正本で `Messages` 型を兼ね、`src/i18n/en.ts` は同じ型なので、キーや引数の過不足はコンパイルで失敗する。文は関数（引数）で組み立て、文の途中に英語/日本語の断片を継ぎ足さない。内部 ID（通知のアクション・カテゴリ ID、周期 ID、`reason` コード、保存キー）・ポリシー値（100歩、60分、10秒、最大10件など）・保存する時刻は言語に依存せず、カタログに入れない。

**日付と時刻。** `src/i18n/format.ts`（`Intl.DateTimeFormat`、設定を引数で受ける純関数）。表示は端末の12/24時間設定（`getCalendars()[0].uses24hourClock`）を最優先し、不明なら日本語は24時間・英語は言語の慣習に従う。24時間表示は `hourCycle: 'h23'`（0:05 が「24:05」にならない）。曜日名・日付も端末の言語。時刻ピッカー（iOS の wheel、Android の clock dialog）にも同じ 12/24 設定と言語を渡す。

**エラー。** 失敗の正本は `src/errorCatalog.ts`（Issue #20）で、安定した機械コード（`code`）・`tone`・`retry`・原因（`AppError.cause`）は言語に依存しない。文は `Messages.errors[code]`（`message` と `recovery`）から表示時に引く。日本語は `ERROR_CODES` と同じ表（`JA_ERROR_TEXTS`）、英語は `src/i18n/errors.en.ts`（`Record<ErrorCode, …>` なので 1 コードでも欠けると型エラー）。画面は `noticeFromCodeIn` / `noticeFromCodesIn` / `describeErrorIn`（`src/i18n/errorText.ts`）で、現在の言語の `ErrorNotice`（コード・tone は不変）にする。複数の結果（停止成立＋後続失敗＋取り消し未確認）は全ての文を残し、最も重い tone と先頭のコードを使い、文の間は言語ごとの区切り（`common.sentenceGap`）を入れる。`Error.message` や `new Error('…')` に日本語を直書きしない（例外の `message` は日本語のカタログ文で、画面には出さない）。コードを持たない例外（OS・ライブラリ由来）の文言は読まず `UNEXPECTED_FAILURE` 等の定型文にする。保存する値と再試行キー（`refill_failed:<code>` 等）にエラー文は含めず、言語に依存しない。持続的な警告・復旧カードなど、コードに結びつかない画面固有の文だけ `Messages` の個別キーに置く。

**通知。** 文面は予約時の言語で固定される（OS が保持するため、言語を変えても既に予約済みの通知は元の言語のまま。次回の補充・再予約から新しい言語になる）。`notificationService.setNotificationMessages` は前面復帰のたびに更新する。アクション ID・カテゴリ ID・チャンネル ID は変えず、ボタンの文言（「起きています」/ "I’m up"）、プレビュー文、Android のチャンネル名だけを訳す。

**アクセシビリティ。**

- 追加ボタン（＋）、設定（⋯）、閉じる（×）など文字の無い操作は `accessibilityLabel` をカタログから設定する。主要な Pressable は `accessibilityRole="button"` で、停止・追加・確認は `disabled` / `busy` を伝える。追加が無効のときは理由（曜日未選択・直前すぎる時刻など）を `accessibilityHint` にも載せる。
- 警告は色だけに頼らない。一覧の予約状況が警告のとき「⚠」を付け、読み上げは「注意: …」/ "Warning: …" を先頭に付ける。状態通知は既存の記号と live region、オン/オフ・終了は文字で表示する。
- 追加 sheet は `accessibilityViewIsModal`、見出し（header ロール）を持ち、開いたとき見出しへフォーカスを送る。設定 sheet も modal と header を持つ。フォームは内部スクロールし、追加ボタンはスクロール外のフッターに固定して小さい画面・最大文字でも届く。
- 最大文字サイズ・英語の長い文でも、1行で切り詰めるのは「自動縮小する時刻・見出し」だけ（テストで固定）。警告カードの見出しと操作、歩数の進捗行は折り返す。小さい操作は 44pt 以上。
- 鳴動時のフォーカスは既存どおり停止ボタンへ移り、ラベルは端末の時刻形式の時刻と鳴動中であることを含む（12時間設定なら「7:00 AM」）。

**検証の範囲。** `tests/i18n.test.ts`（言語決定、ja/en の鍵・引数の一致、日英の混入、Intl 整形、12/24 時間、プレーン文のエラー）、`tests/accessibility.test.ts`（JSX の構造確認）、既存の純関数テスト（ja を明示）。VoiceOver / TalkBack の読み上げ、実機の英語表示の折り返し、実機での言語・12/24 切替は**未確認**（`docs/DEVICE_TEST.md` 17）。

**統合済みの機能（2026-10-15、main 9a9afd7 に再統合）。** #15 編集（composer の編集モード、編集ボタン、編集ジャーナルの失敗）、#25 日の出・日の入り設定（地域名、状態文、選択マーカー）、#30 今回だけスキップ（ボタン・確認・通知・警告）の文言とアクセシビリティ名を ja/en カタログへ移した。編集の失敗は `AlarmEditError.catalogCode`（`src/errorCatalog.ts` のコード）で表し、表示時に現在の言語で引く（暫定の `src/i18n/appError.ts` は廃止し、カタログを両言語の正本にした）。`circadianTheme` の位相計算は main のまま（位相ラベルは未使用のため削除）。

**統合済みの機能（2026-10-15、main 9b3eba3 に再統合）。** #16 スヌーズ（スヌーズ中カード・ボタン・通知本文・結果通知）、#20 診断コード（101 コードの日英文、警告／停止の部分成功／メモリのみ追跡、エラーコードの読み上げ）、#29 原子的配送、#13 補充の追従、#43 通知チャンネルの警告。スヌーズ・停止の結果は `snoozeOutcome` が `TextContext` を受けて現在の言語で出す。時刻は `Formatter`（端末の 12/24 時間とタイムゾーン）で整形し、`HH:mm` を組み立てない。内部の論理日付・期限・検証（UTC 基準のずらし処理を含む）は表示と分離し、言語や時計設定で変わらない。**#17 / #19 / #21 も統合済み（ローカル作業ツリー）。** 見逃しカードの告知（`planMissedAnnouncement`。cycleId ごとに1回、鳴動中は保留して停止後に告知、確認済み・削除済み ID は prune。文言は `messages.missed.cardAnnouncement`）、見逃し確認済みの集約 notice（`getMissedAcknowledgementNotice(result, issues, messages)`。コードと tone は言語で変わらず、文は `Messages` から引く。main / check-in / 受理済みスヌーズの 3 ID を個別に dismiss）、読込失敗カードのスクロール（`getScreenScrollPolicy`）、リセット時の配信済み通知の dismiss、削除中は設定を閉じられない `closeSettings`（ref 参照）と、失敗時にホームへも出す `messages.settings.failedHome`。日英とも日本語のみの UI は残さない。

**ネイティブの権限文言。** 歩数（`NSMotionUsageDescription`）と現在地（`NSLocationWhenInUseUsageDescription`）の許可ダイアログ文は、ネイティブビルドでは `locales/{ja,en}.json` で日英化される。Expo Go ではホストアプリの文言が表示され、このアプリでは変えられない（制限として記録。実機未確認）。

## 12. Platform 制約

| 制約 | 現行動作 |
|---|---|
| Pedometer background 非対応 | 起床確定にせず main を残す |
| 歩数監視 window（2026-10-05決定） | 最も近い未来周期を、期限の60分前からアプリを画面に表示している間だけ監視し、その間に歩いた分だけ数える。前夜・日中の歩数、他周期の停止に使った歩数、アプリを閉じている間・背面にある間の歩数（iOS の歩数履歴を含む）は数えない。確認できなければ main を残す |
| アプリを閉じる / 画面ロック（Expo Go） | main 通知の通知音1回だけ。ループ音・歩数確認なし。就寝時はアプリを画面に表示したまま充電する手順とし、表示中は鳴動中・24時間以内の監視周期がある間だけ画面を消さない（11.2）。手動ロック・アプリ切替は防げない |
| 通知権限拒否 | 新規アラームを追加しない。既存のオンのアラームは解除せず、summary を閉じられない警告へ置き換え、各行に通知オフを表示する（11.1） |
| 通知音オフ / provisional | 予約は維持し、`silent` 警告を表示する（11.1） |
| 消音スイッチ / 音量 / Focus / Android の channel 単位の音設定 | 検出しない。`ok` 表示でも鳴動保証はない |
| check-in 登録失敗 | main を残し警告 |
| main 登録失敗 | 周期を保存しない |
| cancel 未確認 | `suppressed` にしない |
| Focus / 消音 / 音量 | 鳴動保証なし。release gate で扱う |
| app terminated 時の action | JS handler 不実行の可能性。main が残る安全側 failure |
| 3周期を越える未起動 | 追加周期が補充されない |
| production app identity 未確定 | `app.alreadyup.prototype` を維持し、人間承認なしに app identity を変更しない |
| Web native time picker非対応 | dialはExpo Go実機で使用する旨を表示し、UI / bundle smokeだけ行う |

## 13. Verification matrix

| ID | シナリオ | 期待結果 |
|---|---|---|
| POL-01 | 99歩 | 対象 main を維持 |
| POL-02 | 期限前100歩 + cancel verified | 対象周期だけ suppress |
| POL-03 | 期限時100歩 | main 優先 |
| POL-04 | 古い cycle action | 現周期を維持 |
| POL-05 | 前夜21:00から数えた100歩で07:00を評価 | `STEP_COUNT_OUTSIDE_WINDOW` で main を維持 |
| POL-06 | 06:00（60分前ちょうど）から数えた100歩 | 07:00 周期だけ suppress |
| POL-07 | window 開始の1ms前から数えた歩数、または翌日周期へ同じ歩数を適用 | 拒否して main を維持 |
| POL-08 | window 内に予約された周期 | `armedAtMs` から数え、それより前の歩数は拒否 |
| POL-09 | 06:30 を 06:10 に停止した後の 07:00 | 06:10 以降の歩数だけを数える |
| POL-10 | window 開始と異なる `stepCountFromMs` の保存歩数 | 0 から数え直す。同じ開始時刻なら大きい方を保持 |
| POL-11 | window 開始前 | Pedometer を購読せず、開始時刻を表示する |
| POL-12 | 06:30・06:40・07:00 の毎日設定で 06:30 を 06:10 に停止し、06:30 が整理された後の 07:00 | 07:00 の `stepCountFromMs` は 06:10 のまま。06:00 から数えた歩数は拒否 |
| POL-13 | 保存済み `stepCountFromMs` より前から数えた100歩 | `processStepThresholdFailSafe` が取消前に `STEP_COUNT_OUTSIDE_WINDOW` で拒否。進捗保存も `stale_window` で無視 |
| POL-14 | window 中にアプリを背面へ移す・閉じてから歩き、戻る | 背面へ移った時点で購読を外し（`shouldWatchSteps`）、戻った後は保存済み歩数から数える。背面中の歩数と iOS の歩数履歴は数えない（実機検証は未実施） |
| REP-01 | 毎日 | 次の3日を計算 |
| REP-02 | 金曜の平日設定 | 月・火・水を計算 |
| REP-03 | 過去の今日だけ | 翌日へ繰り越さず拒否 |
| REP-04 | 終了した今日だけをオンにする | 元の日付を保持して拒否。行と accessibility label に元の日付と「終了」を表示。繰り返しは変更なし（実機 VoiceOver 確認は未実施） |
| MUL-01 | 2設定の片方を suppress | 他方の IDs は不変 |
| MUL-02 | toggle off | 対象 definition の通知だけ解除 |
| MUL-03 | delete | 対象 definition だけ削除 |
| UI-01 | アラームをoff / on | summary card高と一覧開始位置が変わらない |
| UI-02 | noticeを短く上swipe | bannerは元位置へ戻る |
| UI-03 | noticeを32px以上または高速で上swipe | bannerをdismiss |
| UI-04 | iOS wheel / Android clock | 選択時刻が親formへ反映 |
| UI-05 | 表示時刻をタップ | keyboard direct inputへ切り替え |
| UI-06 | 通常端末で追加フォームの「時刻／繰り返し」を切替 | sheetとfooterが動かず、内容領域はスクロールしない |
| UI-07 | iOS wheelの選択帯 | 216pt wheelを縦に欠けさせず、横方向は角丸surface内に収まる |
| UI-08 | 高さ700pt未満、幅360pt未満、または`fontScale > 1.3` | フォーム本体だけがスクロールし、全操作へ到達できる |
| UI-09 | 02:00 / 06:00 / 12:00 / 18:00 / 21:00のlocal time | phaseとnight / dawn / day / dusk写真weightが期待する状態になる |
| UI-10 | 23:59:59から00:00:00へ遷移 | night写真weightが不連続に飛ばない |
| EDT-01 | 有効なアラームを時刻・繰り返し変更 | 新しい3周期を先に予約し、旧 check-in → main の自分の ID だけを確認付きで取り消し、新周期（歩数 0）を保存する。他の definition の ID は不変 |
| EDT-02 | 新周期の予約失敗、記録の保存失敗、最初の旧 main の取り消し失敗、予約中の期限到達 | 記録済みの新 ID を取り消し、旧アラーム（check-in を含む ID と保存内容）は不変（`tests/alarmEdit.test.ts`） |
| EDT-03 | OS の予約数＋新 main 数が64超 / 10件満杯（60件） | 何も予約・取り消しせず拒否 / 10件満杯でも編集でき、常に64以内。空きが足りない check-in だけ省略（main は省かない） |
| EDT-07 | 待機・予約・取り消しの途中で旧周期が期限に達する | 期限到達済みの旧通知は取り消さず、旧周期のデータを残す（取り消し前なら編集を中止） |
| EDT-04 | 鳴動中・期限到達済み・停止処理未完了・前回の編集が未完了 | 開始も保存も拒否 |
| EDT-05 | 途中で終了（`scheduling` / `replacing`） | 起動時に新 ID だけ取り消して旧維持 / 新周期を保存して残りの旧 ID を取り消す |
| EDT-06 | オフのアラーム / `today` の編集 | 通知を触らず保存 / 元の日付を保持し、過ぎていれば拒否 |
| UI-11 | alarm toggle完全成功 / 部分予約失敗 / 例外失敗 | 完全成功時はbannerなし、部分予約失敗時はwarning、例外失敗時はdanger noticeを表示する |
| NTF-01 | iOS 未決定・拒否 / provisional / 許可＋音オフ / 許可 / 未知の status / 結果なし | `off` / `silent` / `silent` / `ok` / `unknown` / `unknown` |
| NTF-02 | `ok` 以外でオンのアラームあり | 閉じられない警告 card と各行の警告を表示し、「次のアラーム」「…まで予約済み」を表示しない |
| NTF-03 | オフのアラームだけ、アラームなし、または未確認（`null`） | 警告しない |
| NTF-04 | 設定アプリで通知をオフにしてアプリへ戻る / オンに戻して戻る | `active` で再確認し、警告を表示 / 通常表示へ戻す（実機確認が必要） |
| SCH-01 | オフ / オンで未来の監視周期なし / 3周期 / 繰り返しで残り1周期 / `today` で残り1周期 | `off` / `none` / `scheduled`（最後の期限） / `isRunningLow` / `isRunningLow` ではない。期限を過ぎた周期と鳴動・停止済み周期は数えない |
| SCH-02 | 通知からの停止だけで2周期進めた後にアプリへ戻る（権限あり） | `active` で先3周期まで補充し、行が「…まで予約済み」に戻る（実機確認が必要） |
| SCH-03 | 権限なしでアプリへ戻る | 補充も権限 prompt も行わない |
| SCH-04 | 同じ予約失敗が続く状態でアプリへ繰り返し戻る | notice は最初の1回だけ。解消後の再発は再通知する |
| SCH-05 | 残り1周期の繰り返しアラームで、直近の補充が問題を報告した・停止 journal のため補充しなかった / 補充に成功した | `…まで予約済み・先の分を予約できませんでした` / `…まで予約済み・アプリを開くと先の分を予約します`。今回の補充の対象外だった definition は前回の結果を保つ（`recordRefillAttempt`） |
| SCH-06 | `today` / 毎日・平日・曜日指定の main 通知 | 本文に「アプリを開くと次回以降の予約を続けます。」を添えない / 添える（`repeats`） |
| REC-01 | OS キューから main だけ消えた周期 | 同じ `cycleId` で main を再予約し、旧 check-in を cancel して新 main を指す check-in を作る |
| REC-02 | check-in だけ消えた周期 | main は変更せず check-in だけ再予約。時刻を過ぎた check-in は作らない |
| REC-03 | OS キューを読めない / 権限なし | 予約も取消もせず `unverified` / `missing`。「予約済み」を出さない |
| REC-04 | 権限を戻した後の照合 / 照合の繰り返し | 修復し、2 回目は何も予約しない |
| REC-05 | `suppressed` / `dismissed` / `ringing`、未完了 cancel・suppression のある alarm、オフの alarm | 再作成も変更もしない |
| REC-06 | OS キューに無関係な ID | 取消しない（cancel は保存した ID のみ） |
| REC-07 | 修復中に期限へ到達 / checkpoint 保存失敗 | 再予約せず鳴動経路へ / 直前に予約した ID を cancel して例外 |
| REC-08 | タイムゾーン変更（繰り返し） | 壁時計 HH:mm に合わせて組み直し、新規予約 → cancel の順。`suppressed` の時刻は空ける |
| REC-09 | タイムゾーン変更（今日だけ） | 元の日付に固定。元の壁時計が過去なら元の予約を残す |
| REC-10 | 同じタイムゾーン（DST 境界を含む） | 組み直さない |
| BED-01 | 鳴動中（オフの定義を含む） / オンで23時間59分後・ちょうど24時間後の監視周期 / 期限を過ぎた監視周期 / `step_candidate` | `shouldKeepScreenAwake` が true |
| BED-02 | アラームなし / オフの定義だけ / 24時間より1ms以上先だけ / `suppressed`・`dismissed` だけ | false |
| BED-03 | `AppState` が `background` / `active` / `inactive` / 不明 | `background` だけ画面スリープ防止を解除する |
| BED-04 | 就寝案内 footer の文字色 | 背景写真が白・黒のどちらでも 4.5:1 以上 |
| BED-05 | Expo Go 実機で production の JS bundle（`npx expo start --no-dev --minify`）を読み込み、一覧を表示したまま自動ロック時間を過ぎるまで待つ | 24時間以内にオンのアラームがあれば画面が消えない。すべてオフにする・停止後に24時間より先だけになると自動ロックに戻る（実機確認が必要）。`npx expo start` の dev bundle では Expo の `withDevTools` がセッション中ずっと画面を点けたままにするため、この確認に使えない |
| BED-06 | iPhone SE（667pt）を含む画面高、Dynamic Type 標準〜最大（`fontScale > 1.3` の画面スクロールを含む） | footer がスクロールせずに初期表示で見え、上のコンテンツ（一覧 panel またはスクロール領域）が縮む。footer は操作要素に重ならず、文字を省略せず、画面からはみ出さない（実機確認が必要） |
| BED-07 | 配送状態 `ok` / `off` / `silent` / `unknown`・未確認（`null`） | `getBedsideGuidance` の1行目は常に「…画面に表示したまま…」。2行目は「画面ロック・アプリを閉じると」に続けて「通知音1回だけ・歩数確認なし」/「鳴りません」/「音が出ません」/「鳴るか確認できません」。`ok` 以外の2行目と keep-awake 失敗 notice は通知音に触れない |
| BED-08 | Expo Go 実機でアプリ表示中にアラームを鳴らし、鳴動中に画面をロック・ほかのアプリへ切替する | ループ音が停止操作まで鳴り続ける（`shouldPlayInBackground` と Expo Go 本体の background audio に依存。実機確認が必要） |
| I18N-01 | 端末の言語が `ja` / `en` / 未対応言語（例 `fr`）/ `fr` の次に `en` | 日本語 / 英語 / 日本語 / 英語（最初に対応する言語） |
| I18N-02 | ja / en カタログのキーと引数 | 完全に一致。英語に日本語、日本語に英語の定型文が混ざらない |
| I18N-03 | 端末の12/24時間設定が日本語・英語それぞれで異なる | 設定が言語の既定より優先。24時間は 00:05 を「24:05」と表示しない |
| I18N-04 | `AppError` を英語で表示、コードを持たない例外 | カタログの英語、定型文。保存する識別子は言語非依存 |
| I18N-05 | コード内の日本語文字列 | カタログ以外には無い |
| A11Y-01 | すべての Pressable | `accessibilityRole="button"` か非表示の装飾。文字の無い操作はカタログのラベル |
| A11Y-02 | 警告の予約状況行 | 「⚠」と「注意:」/ "Warning:" の読み上げ。色だけでは伝えない |
| A11Y-03 | 追加 / 設定 sheet | modal、見出し、スクロール外の主操作。composer は開くと見出しへフォーカス |
| A11Y-04 | 1行 `numberOfLines` の Text | 自動縮小か文字拡大の上限付きだけ |

## 14. 参照資料

- [Safety verification: コード・基準・テスト対応](SAFETY_VERIFICATION.md)
- [Expo Notifications — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [Expo Pedometer — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/pedometer/)
- [Expo Localization — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/localization/)（`getLocales()` / `getCalendars()`、Expo Go 同梱、前面復帰時の再取得）と [Localization guide](https://docs.expo.dev/guides/localization/)
- [Expo KeepAwake — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/keep-awake/)
- [Expo DateTimePicker — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/date-time-picker/)
- [Expo LinearGradient — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/linear-gradient/)
- [React Native 0.86 PanResponder](https://reactnative.dev/docs/0.86/panresponder)
- [Apple: Scheduling a notification locally](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)
- [Apple: UILocalNotification pending limit](https://developer.apple.com/documentation/uikit/uilocalnotification)
- [Apple Watch notifications](https://support.apple.com/guide/watch/notifications-apd9b833c9f3/watchos)

### 11.5 任意の日の出・日の入り背景（ALR-017）

**設計の根拠（UI実装前に確定）。** 目的は、背景の明暗の切替を実際の日照に近づける任意機能であり、アラームの時刻・鳴動・予約とは独立する。既存の共通 `SettingsModal`（issue 21）の本文へ差し込む1セクション `SunriseSettings` とし、新しい設定入口・sheetは作らない。部品は設定sheetの白いsurfaceに合わせ、既存の `UI_COLORS` と `LiquidRepeatSelector` 系の角丸chipの見た目を流用する。選択状態は `radio` role と `checked` で伝え、全操作は高さ48pt以上、地域は折り返すgridで最大文字サイズでも崩れない。glassは主要操作限定の方針（11章）に従い、このセクションでは使わない。状態は1行の `polite` live regionで、固定へ戻した理由を短く事実だけで示す。

- 既定は固定06:00/18:00。保存がなければ見た目は従来と完全に同一。
- 選択肢は「固定」「小さな内蔵地域（座標＋IANA timezone。権限不要）」「現在地を使う（明示ボタンのみ）」。
- 現在地は、そのボタンを押した時だけ前景で一度、`Accuracy.Lowest`（約3km）で取得する。起動時・設定画面表示時に権限を求めない。バックグラウンド位置・追跡・サーバー・ジオコーディングは使わない。10秒で時間切れとし、失敗は固定のまま。固定・地域の選択やデータ削除の後に届いた古い結果は破棄する。
- 保存は `already-up/sun-preference/v1` のみ。`mode`、地域ID、または0.1度（約11km）に丸めた緯度経度＋timezone＋保存時刻。生の座標や移動履歴は保存しない。固定を選ぶと位置は削除される。全データ削除（`storageReset`）はこのキーも消す。
- 日の出・日の入りは `suncalc`（2.1.1、MIT、依存なし）で端末内計算する。日付は選択地点のtimezoneの暦日で決め、DST当日・日付変更線をまたぐ地域も地点の暦日で扱う。位置情報モードは保存時のtimezoneと端末のtimezoneが一致する間だけ使う。
- 次の場合は固定に戻し、短く理由を示す: 権限の取り消し、端末timezoneの変更、保存データの不正・未知の地域、timezoneを確定できない、白夜・極夜。
- 結果は地点＋暦日ごとに最大4件だけ保持し、日付変更・前面復帰で再計算する。タイマーによる位置取得はしない。

**統合済み。** `App.tsx` が `useSunBackground(nowMs, sunStorageCoordination)` を無条件に呼び、`getCircadianTheme(new Date(nowMs), sun.schedule)` へ渡す。`SunriseSettings` は共通 `SettingsModal` の本文に置く。保存はアラームと同じ排他制御と `assertNoPendingReset` の内側で行い、削除確定時に `beginDeletion()` で取得中の位置問い合わせ・読み込み・保存を同期的に無効化する。完了で `completeDeletion()`、失敗で `failDeletion()`（設定と許可操作は再実行まで無効）。計算の検証は USNO API の取得値（`tests/sunSchedule.test.ts` 内のURLと座標・日付・UTCオフセット）を基準にする。物理端末での位置情報許可・取得は未確認。
