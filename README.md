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
- 「時刻」「繰り返し」を分けてレイアウトを動かさない追加モーダルと、一覧だけをスクロールする固定ホーム画面
- native wheel / clock dialを標準にし、時刻表示タップ時は時・分をキーボードから直接入力
- 追加・削除・失敗時の状態通知は閉じるボタンまたは上スワイプでdismiss。頻繁なオン／オフ成功時はbannerを出さない
- 上部summaryと操作層へ絞ったLiquid Glassと、追加フォーム／繰り返しの選択に追従してspring移動するglass lens
- iOS 26のnative Liquid Glass、旧iOS / WebのBlur、Androidの安定したfallback、Reduce Transparency / Reduce Motion対応
- 端末のローカル時刻に合わせ、同じ湖畔景観の実写寄りな朝・昼・夕・夜写真を連続cross-fadeする背景

## 時間帯に合わせた背景

背景は端末の現在時刻とtimezoneを使い、位置情報権限や外部APIなしで変化します。現在は日の出を06:00、日の入りを18:00とする基準モデルで、同一構図から生成・最適化した夜明け、昼、夕暮れ、夜のphotorealistic assetを時間帯keyframe間でcross-fadeします。codeで描いた星・太陽・月・山のillustrationは使用せず、描画時にmountする写真も隣接する最大2枚に限定します。

国籍は日の出・日の入りを決める情報ではないため使用しません。実際の地域・季節に合わせる場合は、位置情報を任意で許可した利用者だけ緯度・経度から日の出・日の入りを算出する追加機能として扱います。

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

- Node.js 22 LTS（22.x の 22.13.0 以降）と npm を推奨します。任意の上位メジャーバージョンが対応するわけではありません。
- SDK 57 対応の Expo Go をインストールした iPhone（iOS 16.4 以降）
- iPhone と開発マシンが接続できるネットワーク
- Apple Watch 経由の確認を試す場合は、iPhone とペアリング済みの Watch

2026-09-05、実機の Expo Go が SDK 57 対応になったことを確認し、ユーザー承認のもと旧 SDK 54 固定を解除しました。このリポジトリは Expo SDK 57 を使用します。実装時は [Expo SDK 57 の versioned docs](https://docs.expo.dev/versions/v57.0.0/) を参照してください。

```sh
npm ci
npm start
```

別ネットワークから接続する場合は `npm start -- --tunnel --go` で起動してください。SDK 不一致のエラーは Tunnel や QR の作り直しだけでは解消しません。Expo Go とプロジェクトの SDK メジャーバージョンを合わせてください。

ターミナルの QR コードを iPhone のカメラまたは Expo Go で読み取ります。初回起動時は通知とモーションの権限を許可してください。

## 使い方

1. 右上の `＋` を押す。
2. 「時刻」で、iPhoneではwheel、Androidではclock dialから時刻を選ぶ。
3. 数字で直接指定したい場合だけ、表示時刻をタップして時・分を入力し、`この時刻に決定` を押す。
4. 「繰り返し」へ切り替え、「今日だけ」「毎日」「平日」「曜日指定」から鳴らす日を選ぶ。
5. `この内容で追加` を押す。
6. 一覧のスイッチでオン／オフを切り替える。不要な設定は `削除` から解除する。

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
npx expo install --check
npx expo-doctor
npx expo export --platform all
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

- [Expo Notifications — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [Expo Pedometer — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/pedometer/)
- [Expo GlassEffect — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/)
- [Expo BlurView — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/blur-view/)
- [Expo DateTimePicker — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/date-time-picker/)
- [Expo LinearGradient — SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/linear-gradient/)
- [React Native 0.86 PanResponder](https://reactnative.dev/docs/0.86/panresponder)
- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [Apple: Scheduling a notification locally](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)
- [Apple: Notifications on Apple Watch](https://support.apple.com/guide/watch/notifications-apd9b833c9f3/watchos)
