# AlreadyUp

「起きている」と直前に明示確認できた場合だけ止まり、それ以外は鳴る、fail-safe 優先のアラーム MVP です。

この MVP は睡眠そのものを推定しません。Apple Watch を着けていない夜や、20 歩のあとに再び寝た場合でもアラームを止めないため、判断できない状態をすべて「鳴らす」側に倒します。

## MVP の挙動

| 入力・状態 | 判定 | メインアラーム |
|---|---|---|
| iPhone で 20 歩を検知 | 起床候補 | 止めない |
| アラーム 60 秒前の通知で「起きています」を明示操作 | 起床確定 | 対象のアラームだけ止める |
| 通知をタップしただけ、閉じた、無応答 | 不明 | 鳴らす |
| Apple Watch が未装着・ロック中・未接続 | 不明 | 鳴らす |
| センサー、応答処理、キャンセル処理が失敗 | 不明 | 鳴らす |

確認通知は iPhone の actionable local notification として作り、iOS の通知転送で Apple Watch に表示させます。MVP に watchOS 専用アプリや HealthKit の睡眠判定は含めません。

安全性を優先し、セット後から鳴動開始までの手動解除は MVP に含めません。アラームが鳴った後は「起きました・停止」で止められます。

> [!IMPORTANT]
> 通常のローカル通知は、消音、音量、Focus、通知設定、OS の配送判断などの影響を受けます。本 MVP は「起床を確認できなかったのにアプリが自動でアラームを抑止する」事故を避ける設計ですが、音が必ず鳴ることまでは保証しません。AlarmKit / Critical Alerts を含む本番対応は [残 Issue](docs/REMAINING_ISSUES.md) に分離しています。

## 技術構成

- Expo SDK 54 / React Native / TypeScript
- `expo-notifications`: メインアラーム、60 秒前の確認通知、通知アクション
- `expo-sensors` (`Pedometer`): アプリ実行中の歩数検知
- `@react-native-async-storage/async-storage`: 有効なアラーム周期の復元
- Apple Watch: iPhone 通知のミラーリング先として利用

実装契約と状態遷移は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## セットアップ

### 必要なもの

- Node.js と npm
- Expo Go をインストールした iPhone
- iPhone とペアリング済みの Apple Watch（Watch 経由の確認を試す場合）
- iPhone と開発マシンが接続できるネットワーク

このリポジトリは、App Store 版 Expo Go を使った iPhone 実機確認のため Expo SDK 54 を固定しています。Expo 公式も SDK 57 移行期間中の物理デバイスでは SDK 54 を使うよう案内しています。実装時は [Expo SDK 54 の versioned docs](https://docs.expo.dev/versions/v54.0.0/) を参照してください。

```sh
npm ci
npm start
```

ターミナルに表示された QR コードを iPhone で読み取り、Expo Go で開きます。接続できない場合は、ネットワークポリシーを確認したうえで `npx expo start --tunnel` を試せます。

初回起動時は通知とモーションの権限を許可します。Expo Go で Apple Watch の確認を試す場合は、Watch アプリの通知設定で「Expo Go」の通知ミラーリングを有効にし、Watch を手首に装着してロック解除してください。

## 手動確認

最初は現在時刻から 2 分以上先にアラームをセットすると、60 秒前の確認通知とメインアラームの両方を確認できます。

### Apple Watch で起床確定する

1. アラームをセットする。
2. iPhone をロックする。
3. Apple Watch を装着し、ロック解除した状態で待つ。
4. アラーム 60 秒前の確認通知で「起きています」を押す。
5. 対象のメインアラームが鳴らないことを確認する。

iPhone がアンロックされていると、原則として通知は Apple Watch ではなく iPhone に表示されます。通知の振り分け条件は [Watch routing matrix](docs/DESIGN.md#watch-routing-matrix) を参照してください。

### fail-safe を確認する

| シナリオ | 期待結果 |
|---|---|
| 20 歩だけ歩き、確認アクションを押さない | メインアラームが鳴る |
| 確認通知を閉じる、または無視する | メインアラームが鳴る |
| 古い確認通知、別周期の確認通知を操作する | 現在のメインアラームは鳴る |
| 期限と同時または期限後に確認する | メインアラームを抑止しない |
| 有効な周期の「起きています」を期限前に押す | その周期のメインアラームだけ止まる |

Watch / iPhone の実機 E2E は現環境では未実施です。特にアプリが terminated のときの通知アクション処理は未保証なので、デモ時はアプリを終了させずに確認してください。

## 開発時の検証

```sh
# fail-safe 判定と通知・storageオーケストレーションのテスト
npm test

# TypeScript
npm run typecheck

# Web 向けの静的 export（UI / bundle の smoke test のみ）
npm run export:web
```

Web では Apple Watch 転送、ローカル通知、Pedometer のネイティブ挙動を検証できません。これらは iPhone / Apple Watch 実機で確認する必要があります。

## 現在の制約

- Pedometer の継続監視は foreground PoC です。バックグラウンド中の 20 歩を保証しません。
- Apple Watch への表示は iOS の通知転送に依存し、iPhone / Watch のロック状態や通知設定で配送先が変わります。
- 通知アクションを押した時点で JavaScript 実行環境が終了済みの場合、キャンセル処理が走らずアラームが鳴る可能性があります。これは安全側の失敗ですが、UX としては未解決です。
- 通常通知のため、Focus や消音などを越えて鳴る保証はありません。
- 現開発環境には Xcode / CocoaPods / iOS Simulator がなく、native build と実機 E2E は未検証です。
- 残作業は [docs/REMAINING_ISSUES.md](docs/REMAINING_ISSUES.md) で Issue 化できる形式にまとめています。
- `npm audit --omit=dev` は現 lockfile に 19 件（moderate 8 / high 11）の advisory を報告します。自動修正候補は Expo SDK 57 への更新や React Native 0.72 への非互換な変更を含み、App Store 版 Expo Go との互換性を失うため、MVP では強制修正せず `ALR-014` で追跡します。

## 参照資料

- [Expo Notifications — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/notifications/)
- [Expo Pedometer — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/pedometer/)
- [Expo: Create a project（物理デバイスの Expo Go は SDK 54）](https://docs.expo.dev/get-started/create-a-project/)
- [Apple: Taking advantage of notification forwarding](https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding)
- [Apple: Notifications on Apple Watch](https://support.apple.com/guide/watch/notifications-apd9b833c9f3/watchos)
