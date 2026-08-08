# Remaining Issues

MVP で意図的に残した作業を、GitHub Issue に転記できる粒度で管理する。

現在のリポジトリには Git remote が設定されていないため、以下は GitHub 上には未作成である。remote と公開先が確定したら、各 `ALR-*` を 1 Issue として作成する。

## Priority の定義

| Priority | 意味 |
|---|---|
| P0 | 本番アラームとして使う前、または MVP の安全主張を検証するために必須 |
| P1 | MVP 後の信頼性・継続利用に必要 |
| P2 | 機能拡張・品質向上 |

## 一覧

| ID | Priority | タイトル | 主なリスク |
|---|---|---|---|
| ALR-001 | P0 | Focus・消音を含む鳴動保証を設計する | アラームを残しても音が出ない |
| ALR-002 | P0 | terminated 状態の Watch action を確実に処理する | 起床確認済みでも鳴る |
| ALR-003 | P0 | 通知権限と設定フローを fail-closed にする | 設定済みに見えて通知が存在しない |
| ALR-004 | P0 | Xcode / CocoaPods / 実機で native E2E を実施する | 主要経路が未検証 |
| ALR-005 | P1 | Watch routing matrix を網羅検証する | Watch に確認 action が届かない |
| ALR-006 | P1 | 歩数監視のライフサイクルを定義する | 候補検知の欠落・誤解 |
| ALR-007 | P1 | アラーム周期の永続化・競合・冪等性を強化する | 古い応答で誤抑止 |
| ALR-008 | P1 | OS 時刻変更・再起動・通知削除に対応する | 表示状態と OS 状態がずれる |
| ALR-009 | P1 | 詳細なエラー状態と復旧 UX を実装する | 利用者が安全状態を判断できない |
| ALR-010 | P1 | 複数アラーム・繰り返し・スヌーズを設計する | 実利用に不足 |
| ALR-011 | P1 | プライバシー・ログ・観測性を設計する | 不具合を再現できない／過剰収集 |
| ALR-012 | P2 | HealthKit / watchOS 専用アプリを評価する | 将来の精度・UX 改善余地 |
| ALR-013 | P2 | アクセシビリティと国際化を行う | 操作できない利用者が残る |
| ALR-014 | P1 | Expo / React Native の依存 advisory を解消する | 開発・bundle 処理時の既知脆弱性が残る |
| ALR-015 | P2 | App controller・sensor・UIを分割する | UI変更が安全中核へ波及しやすい |

---

## ALR-001: Focus・消音を含む鳴動保証を設計する

**Priority:** P0

### 背景

通常の local notification は、消音、通知音量、Focus、通知権限、端末状態、OS の配送判断に影響される。「キャンセルしない」ことは「必ず聞こえる」ことを意味しない。

### スコープ

- 対象 OS バージョンで AlarmKit の適用可否を調査する
- Critical Alerts entitlement の要件・審査・代替策を調査する
- Expo config plugin / native module / development build の必要性を決定する
- サポートする Focus、消音、音量、電源・再起動条件を明文化する
- 保証できない条件を UI と利用規約上で明示する

### 受け入れ条件

- [ ] サポート対象条件ごとに、使用 API と期待する鳴動動作が表になっている
- [ ] 消音、各 Focus、音量 0、ロック、Watch 装着有無、端末再起動の実機結果が記録されている
- [ ] 「必ず鳴る」と表示できる条件と、表示してはいけない条件が明確である
- [ ] 採用方式に対する自動テストまたは再現可能な手動テスト手順がある

---

## ALR-002: terminated 状態の Watch action を確実に処理する

**Priority:** P0

### 背景

現在の JavaScript listener だけでは、アプリプロセスが終了しているときに Watch の `confirm_awake` を処理してメイン通知をキャンセルできる保証がない。失敗時はアラームが残るので安全側だが、起床確認 UX として不完全である。

### スコープ

- foreground / background / suspended / terminated の各状態で action response を計測する
- Expo の background notification task、TaskManager、native AppDelegate 処理を比較する
- cold start の `getLastNotificationResponse` と重複処理を冪等にする
- action 時刻と期限が競合した場合はメインアラームを優先する

### 受け入れ条件

- [ ] iPhone アプリを terminated にした状態で、Watch の action が期限前に対象メイン通知だけをキャンセルする
- [ ] 同じ応答が listener と cold start の両方に届いても二重処理で壊れない
- [ ] 期限と同時または期限後の action は抑止しない
- [ ] 処理不能時はメインを残し、次回起動時に理由を確認できる

---

## ALR-003: 通知権限と設定フローを fail-closed にする

**Priority:** P0

### 背景

通知権限が拒否・制限・後から変更された状態で「アラーム設定済み」と表示すると、OS 上に有効なアラームがない事故につながる。

### スコープ

- `undetermined` / `denied` / `provisional` / `granted` の扱いを定義する
- メイン通知を OS へ登録し、ID を得た後だけ `armed` にする
- 設定後の権限変更と通知設定変更を再検査する
- 確認通知だけ失敗した場合と、メイン通知が失敗した場合を分ける

### 受け入れ条件

- [ ] メイン通知を登録できない場合、UI は `armed` を表示しない
- [ ] 確認通知だけ登録できない場合、メインを残しつつ明確な警告を表示する
- [ ] 権限拒否から Settings へ移動して復旧する手順がある
- [ ] 設定後に権限を無効化した状態を検知できる

---

## ALR-004: Xcode / CocoaPods / 実機で native E2E を実施する

**Priority:** P0

### 背景

現開発環境には Xcode、CocoaPods、iOS Simulator、接続実機ツールがなく、iPhone / Apple Watch の native E2E を実行できていない。

### スコープ

- 対応 Xcode と CocoaPods を用意する
- Expo development build を作成する
- iPhone と Apple Watch のペアを準備する
- 通知カテゴリ、action、Pedometer、永続化を端末上で検証する
- 検証ログ、OS / WatchOS / 端末モデルを記録する

### 受け入れ条件

- [ ] development build が clean install から起動する
- [ ] iPhone 上で通知権限とモーション権限を取得できる
- [ ] iPhone ロック中に Watch へ確認 action が届く
- [ ] 有効な確認では抑止し、20 歩だけ・無応答・失敗時にはメインが残る
- [ ] 再現可能な E2E チェックリストと evidence が保存されている

---

## ALR-005: Watch routing matrix を網羅検証する

**Priority:** P1

### 背景

通知の配送先は、iPhone のロック状態、Watch の装着・ロック・接続、通知ミラーリング、Focus によって変わる。一般ルールだけではプロダクトの対応範囲を確定できない。

### スコープ

- [設計上の routing matrix](DESIGN.md#watch-routing-matrix) の各セルを実機検証する
- 通知ミラーリング無効、Bluetooth 切断、Watch 電源断、Focus 同期を含める
- action が iPhone / Watch のどちらから押されたか区別できるか確認する

### 受け入れ条件

- [ ] 全セルに OS / WatchOS バージョン付きの実測結果がある
- [ ] Watch に届かない条件をアプリ内で案内できる
- [ ] 配送先にかかわらず、同じ `confirm_awake` 契約で安全に処理される
- [ ] action origin を識別できない場合、その制約を仕様に明記する

---

## ALR-006: 歩数監視のライフサイクルを定義する

**Priority:** P1

### 背景

Expo Pedometer の live update は foreground PoC であり、iPhone ロック後やアプリ終了後の 20 歩を保証しない。一方、歩数は候補にすぎないため、欠落してもメインアラームの安全性には影響させてはならない。

### スコープ

- foreground / background / suspended / terminated の計測範囲を実測する
- `getStepCountAsync` と native `CMPedometer` の利用可否を評価する
- 再起動、日付跨ぎ、権限変更時の baseline を定義する
- 20 歩到達時の候補表示と重複更新を定義する

### 受け入れ条件

- [ ] サポートする計測状態と非サポート状態が明文化されている
- [ ] 歩数欠落・誤差・API 失敗がメイン通知の自動キャンセルにつながらない
- [ ] 1 周期につき候補状態の更新が無制限に増えない
- [ ] 20 歩後に再睡眠しても、明示確認なしならメインが鳴るテストがある

---

## ALR-007: アラーム周期の永続化・競合・冪等性を強化する

**Priority:** P1

### 背景

古い action、複数 listener、再起動、素早い再設定、期限との競合で誤って現在のメイン通知を消さない保証が必要である。

### スコープ

- storage schema の versioning と破損時の扱いを定義する
- `cycleId` / `mainAlarmId` / `dueAtMs` の厳密な相関検証を行う
- listener、cold start、画面操作を冪等化する
- 設定し直し時の旧通知の扱いを定義する

### 受け入れ条件

- [ ] 古い周期・別 ID・期限外・重複 response が現在のメインを消さない
- [ ] storage が空・破損・旧 version でも通知を推測でキャンセルしない
- [ ] 期限競合ではアラームが優先される
- [ ] property-based または同等の境界値テストがある

---

## ALR-008: OS 時刻変更・再起動・通知削除に対応する

**Priority:** P1

### 背景

タイムゾーン変更、手動時刻変更、端末再起動、OS 設定からの通知削除で、保存済み状態と OS の scheduled notification がずれる可能性がある。

### スコープ

- absolute date と wall-clock time の仕様を決定する
- 起動・復帰時に scheduled notification と保存状態を照合する
- 端末再起動、DST、タイムゾーン変更を検証する
- 不整合時の fail-closed UI を定義する

### 受け入れ条件

- [ ] 各時刻変更シナリオの期待動作と実機結果がある
- [ ] メイン通知が OS 上にないのに「設定済み」と表示しない
- [ ] 不整合解消のために無関係な通知をキャンセルしない
- [ ] 再スケジュールが必要な場合は利用者に明示する

---

## ALR-009: 詳細なエラー状態と復旧 UX を実装する

**Priority:** P1

### 背景

MVP では fail-safe の核を優先し、細かなエラーハンドリングを後続に分離した。単なる `console.error` では、利用者がアラームの安全状態を判断できない。

### スコープ

- 通知権限、メイン登録、確認登録、Pedometer、storage、action 検証、キャンセルを別エラーとして扱う
- retry 可否と上限を定義する
- 「メインは残っている」「アラーム自体が未設定」を視覚的に区別する
- ユーザー向け文言と診断コードを分離する

### 受け入れ条件

- [ ] 各失敗点に一意な診断コードとユーザー向け説明がある
- [ ] メインの存在を確認できない場合に成功表示しない
- [ ] キャンセル失敗では `suppressed` と表示しない
- [ ] retry が重複通知や誤キャンセルを起こさない

---

## ALR-010: 複数アラーム・繰り返し・スヌーズを設計する

**Priority:** P1

### 背景

MVP は 1 件の単発アラームのみを対象とする。複数化すると action と対象通知の相関、曜日、再設定、スヌーズの安全規則が必要になる。

### スコープ

- 複数周期の ID・保存モデルを設計する
- 曜日繰り返し、翌日繰り越し、スヌーズを定義する
- 確認が他アラームへ波及しないことを保証する

### 受け入れ条件

- [ ] 1 回の確認が対応する 1 アラームだけを抑止する
- [ ] 翌日・別曜日の確認状態が引き継がれない
- [ ] スヌーズ後も「不明なら鳴る」が維持される
- [ ] 複数 notification の上限と cleanup 方針がある

---

## ALR-011: プライバシー・ログ・観測性を設計する

**Priority:** P1

### 背景

権限・通知・ライフサイクル不具合の解析には evidence が必要だが、睡眠や行動時刻はセンシティブである。

### スコープ

- 保存するイベントと保持期間を最小化する
- 歩数・起床確認・通知配送のログ方針を定義する
- export / delete と同意 UI を設計する
- secrets や不要な個人情報をログに含めない

### 受け入れ条件

- [ ] 収集項目、目的、保存先、保持期間が文書化されている
- [ ] 診断に不要な raw motion / Health データを保存しない
- [ ] 利用者がローカルデータを削除できる
- [ ] ログなしでも fail-safe 判定が動作する

---

## ALR-012: HealthKit / watchOS 専用アプリを評価する

**Priority:** P2

### 背景

HealthKit の sleep analysis や watchOS app は追加の起床証拠・UX 改善になり得るが、Watch 未装着時やデータ遅延を理由にアラームを止めてはならない。

### スコープ

- HealthKit の awake / asleep sample の更新遅延と権限を実測する
- WatchConnectivity と Watch 単独 action の利点を比較する
- Watch 未装着・低電力・充電中の fallback を定義する
- 追加証拠を fail-safe policy に統合する方法を設計する

### 受け入れ条件

- [ ] HealthKit の「データなし」を起床扱いしない
- [ ] 古い sleep sample で現在のアラームを抑止しない
- [ ] Watch 未装着でもメインアラームが残る
- [ ] 導入可否の ADR と実測 evidence がある

---

## ALR-013: アクセシビリティと国際化を行う

**Priority:** P2

### 背景

起床直後の短い確認操作は、VoiceOver、Dynamic Type、色覚、運動機能、言語設定にかかわらず誤操作しにくい必要がある。

### スコープ

- VoiceOver label / hint と focus order を整備する
- Dynamic Type、大きな文字、コントラスト、触覚を検証する
- 通知 action の短く誤解しにくい文言を検証する
- 日時・言語・12/24 時間表記を locale 対応する

### 受け入れ条件

- [ ] VoiceOver だけでアラーム設定と明示確認ができる
- [ ] 最大文字サイズで主要操作が欠けない
- [ ] 色だけに依存せず armed / warning / suppressed を区別できる
- [ ] 対応 locale ごとに日時と通知文言の QA がある

---

## ALR-014: Expo / React Native の依存 advisory を解消する

**Priority:** P1

### 背景

2026-08-08 時点の `npm audit --omit=dev` は、Expo SDK 57 の transitive dependency を中心に 18 件（moderate 7 / high 11、critical 0）を報告する。`npm audit fix --force` の提案は Expo 53 / React Native 0.72 への非互換な downgrade を含み、プロジェクトの SDK 57 固定と衝突するため実行していない。

### スコープ

- 各 advisory の到達可能性を mobile runtime / Metro・CLI・asset 処理に分けて評価する
- Expo SDK 57 の修正版または上位 SDK への安全な更新経路を確認する
- untrusted asset を Metro / `image-size` に入力する開発フローを制限する
- 強制 downgrade や `--force` を使わず lockfile を更新する

### 受け入れ条件

- [ ] high / critical advisory が 0、または非到達性と期限付き risk acceptance が記録されている
- [ ] `npx expo-doctor` が全チェックを通過する
- [ ] `npm test` / `npm run typecheck` / `npm run export:web` が更新後も通る
- [ ] Expo SDK 57 から外れる場合は、versioned docs に基づく移行差分が記録されている

---

## ALR-015: App controller・sensor・UIを分割する

**Priority:** P2

### 背景

安全判定と通知順序は純粋な policy / orchestrator に分離済みだが、`App.tsx` には通知listener、Pedometer lifecycle、画面状態、表示component、stylesが集中している。MVPの即時安全欠陥ではないが、将来のUI変更とライフサイクル変更の影響範囲が広い。

### スコープ

- `useAlarmController` と `useStepCandidate` を抽出する
- 状態別画面と共通componentを分離する
- orchestratorの純粋契約を維持し、React hooksから安全判定を逆流させない
- 分割前後で通知・storage統合テストを維持する

### 受け入れ条件

- [ ] 通知response、Pedometer、UI renderingの責務が別moduleになっている
- [ ] `alarmPolicy` / `alarmOrchestrator` にReact Native依存が入らない
- [ ] 現在の33テスト相当以上が通過する
- [ ] armed / step candidate / suppressed / ringingの画面回帰を確認できる
