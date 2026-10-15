# リリースプロファイルと本番識別子の準備（ALR-016）

`app.config.ts` が `app.json` を基底に、環境変数 `APP_VARIANT` で識別子を切り替える。判定は `config/appIdentity.ts`（純粋関数、`tests/appIdentity.test.ts`）。署名・EAS・ストア申請・development build への移行は含まない。配布は引き続き Expo Go（SDK 57）。

## プロファイル

| APP_VARIANT | iOS bundle / Android package | 用途 |
|---|---|---|
| 未設定 / `development` | `app.alreadyup.prototype`（現状維持） | Expo Go での開発 |
| `preview` | `app.alreadyup.prototype.preview` | 内部確認用の分離。ストア配布不可 |
| `production` | 所有者が環境変数で与えた値のみ | 将来の本番。入力が不足・不正なら設定読み込み時に失敗する |

未知の `APP_VARIANT` は development へ戻さずエラーにする。

## production の必須入力（`.env.example` 参照、Git には空欄のみ）

`ALREADYUP_APP_NAME` / `ALREADYUP_IOS_BUNDLE_ID` / `ALREADYUP_ANDROID_PACKAGE` / `ALREADYUP_PRIVACY_URL` / `ALREADYUP_SUPPORT_URL` / `ALREADYUP_ASSETS_APPROVED=true`

任意: `ALREADYUP_EAS_OWNER`（ローカル production ビルドに EAS は不要。前後空白を除去し、設定されている場合のみ `owner` に入れる）。

拒否するもの: 未設定・空白、`prototype` を含む識別子、形式不正の識別子、https 以外・URL として不正・`example.com`/`localhost` 等のプレースホルダホストの URL（形式検証のみ。実在・到達性は確認しない）、`ALREADYUP_ASSETS_APPROVED` が `true` 以外。プライバシー/サポート URL は `extra.privacyPolicyUrl` / `extra.supportUrl` に入る。

確認: `APP_VARIANT=production npx expo config --type public`（入力なしでエラーになること）。

## 所有者の決定待ち（未決。エージェントは値を作らない）

- [ ] 所有主体（EAS owner / Apple・Google 開発者アカウント）
- [ ] 正式な bundle identifier / Android package / 表示名
- [ ] 公開プライバシーポリシー URL、サポート URL（公開状態・到達性は未確認）
- [ ] ストア説明文・スクリーンショット・年齢区分
- [ ] 識別子変更時の既存データ・通知・権限の移行方針
- [ ] 本番アイコン類の承認（`ALREADYUP_ASSETS_APPROVED`）
- [ ] development build / native alarm への移行判断（別途）

## 既存アセットの確認（出自は未確認）

| ファイル | サイズ | 状態 |
|---|---|---|
| `assets/icon.png` | 1024×1024 | Expo テンプレート由来の暫定アイコンの可能性。最終品ではない |
| `assets/splash-icon.png` | 1024×1024 | 同上 |
| `assets/android-icon-*.png` | 512×512 | 同上（adaptive icon 背景色 `#E6F4FE` も暫定） |
| `assets/favicon.png` | 48×48 | 同上 |
| `assets/backgrounds/circadian-*.jpg` | — | 実写風背景。ライセンス・生成元の記録が repo にない。出自の確認が必要 |

新しいブランドは別の視覚デザイン工程で作る。上記の出自記録が揃うまで、production アイコンとして承認しない。

## 実機確認（未実行）

clean install / upgrade の通知・モーション権限確認は未実施。設定の実装完了とは別に、所有者の識別子決定後に実施する。
