# AlreadyUp

自然に起きて100歩歩いたこと、または期限直前の明示操作を確認できた場合だけ、その時刻のアラームを止める fail-safe 優先のアラームアプリです。

睡眠そのものは推定しません。歩数、通知、保存、取消処理に失敗した場合は「起きている」と判断せず、対象アラームを残します。

## 主な機能

- 最大10件のアラーム
- 「今日だけ」「毎日」「平日」「曜日指定」の繰り返し
- アラームごとのオン／オフと削除
- 期限前の100歩による対象周期だけの自動停止
- iPhone / Apple Watch の確認通知から「起きています」を押した周期だけの停止
- foreground でのループ音と、background での local notification 音
- 既存の単一アラーム保存形式から複数アラーム形式への移行
- レイアウトを動かさない追加モーダルと、一覧だけをスクロールする固定ホーム画面
- iOS 26 の native Liquid Glass、旧iOS / WebのBlur、Androidの安定した半透明surface、Reduce Transparency向け高コントラストfallback

## 動作ルール

| 入力・状態 | 判定 | 対象アラーム |
|---|---|---|
| 期限前に100歩へ到達 | 起床確認 | その周期だけ停止 |
| 99歩以下 | 起床未確認 | 維持 |
| 期限直前の確認通知で「起きています」を押す | 起床確認 | その周期だけ停止 |
| 通知を閉じる、無応答、古い周期を操作 | 不明 | 維持 |
| センサー、保存、取消確認に失敗 | 不明 | 維持 |
| 期限と同時または期限後に確認 | 期限切れ | 維持 |

一度の100歩や確認操作が、別の時刻・別の日のアラームを止めることはありません。

## 繰り返しと通知予約

各アラームは、次の3周期を one-off local notification として個別に予約します。main alarm と起床確認通知を周期ごとに分けるため、最大件数は `10 alarms × 3 cycles × 2 notifications = 60 notifications` です。

この方式は iOS の保留 local notification 上限に収めつつ、周期ごとの安全な取消を可能にします。アプリ起動時、起床確認時、アラーム停止時に予約枠を補充します。

> [!IMPORTANT]
> アプリを3周期以上まったく開かない場合、その先の周期は補充されません。本番リリース前には native/background の再予約方式を実装し、端末再起動・時刻変更を含む E2E 検証が必要です。

## セットアップ

### 必要なもの

- Node.js と npm
- Expo Go をインストールした iPhone
- iPhone と開発マシンが接続できるネットワーク
- Apple Watch 経由の確認を試す場合は、iPhone とペアリング済みの Watch

このリポジトリは App Store 版 Expo Go で実機確認できるよう Expo SDK 54 に固定しています。実装時は [Expo SDK 54 の versioned docs](https://docs.expo.dev/versions/v54.0.0/) を参照してください。

```sh
npm ci
npm start
```

ターミナルの QR コードを iPhone のカメラまたは Expo Go で読み取ります。初回起動時は通知とモーションの権限を許可してください。

## 使い方

1. 右上の `＋` を押す。
2. 時刻を選ぶ。
3. 「今日だけ」「毎日」「平日」「曜日指定」から繰り返しを選ぶ。
4. `この内容で追加` を押す。
5. 一覧のスイッチでオン／オフを切り替える。不要な設定は `削除` から解除する。

「今日だけ」は現在より後の時刻だけ登録できます。時刻を過ぎた設定をもう一度使う場合は削除し、新しい時刻を登録してください。

## Apple Watch で起床確認する

1. アラームをオンにする。
2. iPhone をロックする。
3. Apple Watch を装着し、ロック解除した状態で待つ。
4. 期限直前の確認通知で「起きています」を押す。
5. 対応する周期だけが停止されることを確認する。

iPhone がアンロックされている場合、通知は原則として Watch ではなく iPhone に表示されます。

## 開発時の検証

```sh
npm test
npm run typecheck
npm run export:web
```

Web export は UI と bundle の smoke test です。通知、Pedometer、Apple Watch 転送は実機で確認する必要があります。

## 現在の重要な制約

- `Pedometer.watchStepCount` は background では更新されません。100歩のリアルタイム確認は foreground が前提です。
- 歩数監視は現在、最も近い周期をアプリ表示中に監視します。日中の歩行を翌朝へ混入させない監視開始時刻・リセット条件は、本番リリース前に確定が必要です。
- 通常の local notification は、消音、音量、Focus、通知権限、OS の配送判断に影響されます。音が必ず鳴る保証はありません。
- foreground のループ音は JavaScript 実行中のみです。background / terminated では通知音に依存します。
- 通知アクションを押した時に JavaScript 実行環境が終了している場合、取消処理が走らずアラームが鳴る可能性があります。これは安全側の失敗ですが、UX として未解決です。
- 先3周期を越える予約補充、端末再起動、timezone / 手動時刻変更との整合は本番リリース前の gate です。
- Expo Go は開発確認用です。App Store / Google Play 配布では development build と native alarm 能力を含む別の配布設計が必要です。
- iOS / Android のアプリ識別子は現在 `app.alreadyup.prototype` のままです。既存インストールとの同一性や署名に影響するため、本番識別子は人間承認後に変更します。

詳細な契約と状態遷移は [docs/DESIGN.md](docs/DESIGN.md)、本番リリースまでの残項目は [docs/REMAINING_ISSUES.md](docs/REMAINING_ISSUES.md) を参照してください。

## 参照資料

- [Expo Notifications — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/notifications/)
- [Expo Pedometer — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/pedometer/)
- [Expo GlassEffect — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/glass-effect/)
- [Expo BlurView — SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/blur-view/)
- [Apple: Scheduling a notification locally](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)
- [Apple: Notifications on Apple Watch](https://support.apple.com/guide/watch/notifications-apd9b833c9f3/watchos)
