# AlreadyUp MVP 設計

## 1. 目的

AlreadyUp は、アラームの直前に「起きている」と確定できたときだけメインアラームを抑止するアプリである。

最優先の安全要件は次の 1 文に集約される。

> 起きていると確定できない場合はアラームを鳴らす。

避けるべき最重大事故は「本当は寝ているのに、推定や処理失敗によってアラームを止めてしまうこと」である。そのため、誤って鳴ること（false positive）は許容しても、誤って止めること（unsafe suppression）は許容しない。

## 2. MVP の境界

### 含む

- 1 件のメインアラームをローカル通知として先にスケジュールする
- アラーム時刻の 60 秒前に起床確認通知を表示する
- 確認通知の「起きています」アクションで、対応するメインアラームだけを停止する
- iPhone の Pedometer で foreground 中の 20 歩を起床候補として検知する
- iPhone の actionable notification を Apple Watch に転送して操作できるようにする
- 有効なアラーム周期を端末内に保存し、古い応答と区別する

### 含まない

- HealthKit の睡眠ステージによる自動抑止
- watchOS 専用アプリ、WatchConnectivity、Watch 側の独自センサー処理
- バックグラウンドでの継続的な歩数監視
- 通常通知を越える鳴動保証
- 複数アラーム、繰り返し、スヌーズ
- armed 中の手動解除（誤操作による鳴動漏れを避けるため）
- 細かなエラー復旧と全ライフサイクルの網羅

HealthKit や Apple Watch の自動睡眠判定は、Watch を着けていない可能性があること、リアルタイムの起床確定として扱いにくいことから MVP の根拠にはしない。

## 3. 用語と証拠レベル

| 用語 | 意味 | アラーム停止の根拠になるか |
|---|---|---|
| `UNKNOWN` | 起床を確定できる情報がない | ならない |
| `STEP_CANDIDATE` | アラーム設定後に iPhone が 20 歩を検知 | ならない |
| `CONFIRMED_AWAKE` | 有効な確認通知で、期限前に「起きています」を明示操作 | なる |
| `STALE` | 古い周期、別のアラーム、期限外の確認 | ならない |
| `ERROR` | 権限、センサー、保存、応答、キャンセル等の失敗 | ならない |

20 歩は「一度動いた」証拠にすぎず、その後の再睡眠を否定できない。座って作業していて歩数が増えない場合との区別にも使えないため、歩数の多寡から睡眠を推定しない。

`CONFIRMED_AWAKE` はアラーム直前に提示した通知への能動操作であり、MVP で唯一の正の証拠である。確認後 60 秒以内に再睡眠する残余リスクはあるが、早い時間の歩数より新鮮な証拠として採用する。

## 4. 全体構成

```mermaid
flowchart LR
    UI["Expo / React Native UI"]
    Policy["Fail-safe policy"]
    Store["AsyncStorage"]
    Ped["iPhone Pedometer"]
    IOS["iOS local notifications"]
    Watch["Apple Watch notification forwarding"]

    UI --> Policy
    Policy <--> Store
    Ped -->|"20 steps = candidate only"| Policy
    Policy -->|"schedule main first"| IOS
    Policy -->|"schedule check-in at T-60s"| IOS
    IOS --> Watch
    Watch -->|"confirm_awake action"| Policy
    Policy -->|"cancel exact main notification"| IOS
```

Watch から独自データを送るのではなく、iOS アプリが登録した通知カテゴリとアクションを Watch 側に転送する。この構成では watchOS target を追加せずに MVP を試せる。

## 5. データ契約

有効な周期は最低限、次の情報を一体として扱う。

```ts
type AlarmCycle = {
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
  phase: 'armed' | 'step_candidate' | 'suppressed' | 'ringing' | 'dismissed';
  stepCount: number;
  stepCandidateAtMs?: number;
  confirmedAtMs?: number;
  stepCandidateRecorded: boolean;
};
```

確認通知の payload は、別周期の通知を誤って適用しないため、次の相関情報を持つ。

```ts
type AwakeCheckInData = {
  kind: 'awake_checkin';
  cycleId: string;
  mainAlarmId: string;
};
```

- category identifier: `awake_checkin`
- action identifier: `confirm_awake`
- action label: `起きています`

category / action identifier は固定値とし、表示文字列で判定しない。

## 6. スケジュール手順

アラーム設定時は、次の順序を崩さない。

1. 通知権限と通知カテゴリを準備する。
2. `cycleId` と `dueAtMs` を確定する。
3. メインアラームを OS にスケジュールし、`mainAlarmId` を得る。
4. `dueAtMs - 60 秒` に確認通知をスケジュールし、その通知 ID を得る。
5. メイン ID と確認通知 ID を含む有効周期を保存する。
6. Pedometer の foreground 監視を開始する。

メインを先に登録するのは、確認通知やセンサーの準備に失敗してもアラームを残すためである。プロセスが保存前に終了しても OS 上のメイン通知は残る。メイン通知のスケジュール自体が失敗した場合は「設定済み」と表示してはならない。確認通知のスケジュールが失敗した場合は、メインを残したまま警告状態にする。

## 7. 判定フロー

### 7.1 20 歩を検知した場合

1. 現在の周期に対する歩数を更新する。
2. 20 歩以上になったら `STEP_CANDIDATE` として記録する。
3. UI に起床候補であることを表示する。
4. メインアラームはキャンセルせず、60 秒前の確認通知を待つ。

20 歩到達直後の操作を抑止根拠にすると、アラームまでに再睡眠する時間が長くなる。したがって MVP で抑止可能な `confirm_awake` は `dueAtMs - 60 秒` にスケジュールした現在の確認通知に限定する。

### 7.2 「起きています」を操作した場合

以下をすべて満たす場合に限り、抑止処理へ進む。

1. action identifier が厳密に `confirm_awake` と一致する。
2. payload の `kind` が `awake_checkin` である。
3. payload の `cycleId` が現在有効な周期と一致する。
4. payload の `mainAlarmId` が現在有効なメイン通知 ID と一致する。
5. response の通知 ID が現在の `checkInNotificationId` と一致する。
6. 確認時刻が `dueAtMs - 60 秒` 以降かつ `dueAtMs` より前である。
7. 現在の周期がまだ `armed` または `step_candidate` である。

条件を満たしたら、payload ではなく保存済みの正本 ID を使ってメイン通知 1 件だけをキャンセルする。キャンセル前後の OS の scheduled notification 一覧で対象 ID の存在と消失を検証し、成功を確認したあとに `suppressed` と `confirmedAt` を保存する。

不一致、期限切れ、重複応答、例外、キャンセル失敗では `suppressed` に遷移しない。期限と同時の競合はアラーム優先とする。

### 7.3 無応答・通常タップ・dismiss

何もしない。メイン通知は OS に残る。

## 8. 状態遷移

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Arming: set alarm
    Arming --> Armed: main notification scheduled
    Arming --> Idle: main scheduling failed
    Armed --> Armed: 20 steps / unknown / no response
    Armed --> SuppressionPending: valid confirm_awake before due
    SuppressionPending --> Suppressed: exact main cancellation succeeded
    SuppressionPending --> Armed: validation or cancellation failed
    Armed --> Ringing: due reached
    SuppressionPending --> Ringing: due wins race
    Ringing --> Dismissed: user dismisses alarm
    Suppressed --> [*]
    Dismissed --> [*]
```

歩数の状態とアラームの状態は分離する。`STEP_CANDIDATE` が `Suppressed` への遷移を直接起こす経路は存在しない。

## 9. Watch routing matrix

iOS の通知は通常、iPhone と Watch の両方に同時表示されるのではなく、端末状態に応じて配送先が選ばれる。

| iPhone | Apple Watch | 期待される主な配送先 | MVP 上の扱い |
|---|---|---|---|
| アンロック・使用中 | 任意 | iPhone | iPhone で同じアクションを操作可能 |
| ロック中またはスリープ | 装着・アンロック・接続中 | Apple Watch | Watch での主要デモ経路 |
| ロック中またはスリープ | ロック中・未装着 | iPhone | Watch 確認なし。無応答なら鳴る |
| ロック中またはスリープ | 未接続・電源断・圏外 | iPhone | Watch 確認なし。無応答なら鳴る |
| 任意 | 通知ミラーリング無効 | iPhone | 設定案内が必要 |
| 任意 | Focus / 通知制限あり | OS 設定に依存 | 配送・音を保証しない |

この表は Apple の一般的な forwarding ルールに基づく。実際の action 表示、Focus、ロック、接続復帰、複数 Watch 等の組み合わせは実機検証を残 Issue とする。

## 10. ライフサイクルと fail-safe

| 事象 | 安全側の結果 |
|---|---|
| アプリ再起動 | 保存済み周期を復元し、確認できなければメインを残す |
| action response を取得できない | メインを残す |
| 古い action response を再取得 | cycle / ID / deadline 検証で無視する |
| 保存読み込み失敗 | メインを推測でキャンセルしない |
| Pedometer 権限拒否・停止 | 歩数候補なし。メインを残す |
| 確認通知の登録失敗 | メインを残し、確認不能を表示する |
| メイン通知のキャンセル失敗 | `suppressed` にせず、メインを残す |
| OS 時刻変更・再起動 | 現 MVP では完全未対応。メインを推測で消さない |

`getLastNotificationResponse` 等で cold start 時の応答を回収しても、必ず有効周期との相関を検証する。アプリが terminated の状態で Watch の action が JavaScript まで届くことは未検証であり、本番化前の P0 Issue とする。

## 11. 通知の限界

本 MVP のメインアラームは通常の local notification である。したがって、次を越えた鳴動保証はない。

- 通知権限の拒否または変更
- iPhone の消音、通知音量、Focus、Scheduled Summary 等
- Apple Watch 側の消音、Focus、装着・ロック状態
- OS の配送遅延、端末電源断、再起動

「不明なら通知を OS に残す」というアプリ内の fail-safe と、「音が必ず出る」という OS レベルの保証は別問題である。後者は AlarmKit、Critical Alerts entitlement、native integration、実機検証を含めて解決する必要がある。

## 12. 受け入れテスト

| ID | 条件 | 期待結果 |
|---|---|---|
| POL-01 | 証拠なしで期限到達 | 鳴る |
| POL-02 | 20 歩未満で期限到達 | 鳴る |
| POL-03 | 20 歩以上、明示確認なし | 鳴る |
| POL-04 | 正しい周期・確認通知 ID の `confirm_awake` を T-60 秒以降・期限前に操作 | 対象だけ抑止 |
| POL-05 | 古い周期の `confirm_awake` | 現在のアラームは鳴る |
| POL-06 | 別メイン ID の `confirm_awake` | 現在のアラームは鳴る |
| POL-07 | T-60 秒より前、または別の確認通知からの応答 | 鳴る |
| POL-08 | `dueAtMs` と同時または後の応答 | 鳴る |
| POL-09 | キャンセル API が失敗 | 鳴る側を維持 |
| POL-10 | 前周期で確認後、新しい周期を設定 | 新周期は自動抑止されない |
| LIFE-01 | バックグラウンド中に Watch で有効 action | 期限前に対象だけ抑止 |
| LIFE-02 | terminated 中に Watch で有効 action | 未検証。P0 Issue |
| ROUTE-01 | iPhone ロック、Watch 装着・アンロック | Watch に action が表示される |
| ROUTE-02 | iPhone アンロック | iPhone に action が表示される |

ポリシーテストが通っても OS 配送を証明したことにはならない。`LIFE-*` と `ROUTE-*` は iPhone / Apple Watch 実機で別途検証する。

## 13. 公式資料

- [Expo Notifications — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [Expo Pedometer — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/pedometer/)
- [Taking advantage of notification forwarding](https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding)
- [Adding actions to notifications on watchOS](https://developer.apple.com/documentation/watchos-apps/adding-actions-to-notifications-on-watchos)
- [Apple Watch notifications](https://support.apple.com/guide/watch/notifications-apd9b833c9f3/watchos)
