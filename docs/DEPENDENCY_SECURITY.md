# Dependency security: 修正版のない advisory の到達可能性評価（ALR-014）

評価日 2026-10-15 / Expo SDK 57.0.29 / React Native 0.86.3 / node 26.0.0。`npm audit` は 16 件（high のみ）。原因は次の 2 advisory で、残りは依存関係の伝播である。どちらも**修正済みとは扱わない**。

| advisory | 対象 | 修正版 | npm が提案する修正 |
| --- | --- | --- | --- |
| GHSA-vfj7-8cjw-p6xm（再帰深さによる DoS） | `braces@3.0.3`（`<=3.0.3`） | なし | `expo@44.0.6` への downgrade（不採用） |
| GHSA-86w9-cpqp-85rv（入れ子 DigestAlgorithm の署名検証） | `node-forge@1.4.0`（`<=1.4.0`） | なし | 同上 |

`omit=dev` や「開発ツールだから」を根拠にしない。lockfile 上、これらはすべて `dev: false`（`expo` が runtime dependency）なので、評価はインストール済みソースの呼び出し経路で行った。

## 結論の区分

- **緩和（mitigation）**: なし。脆弱な入力が到達する経路を見つけられなかったため、保護コードは追加していない。
- **非到達（根拠つき・仮定あり）**: 下記 A〜C の仮定が成り立つ限り、脆弱な入力は両 advisory の関数に届かない。仮定は `npm run security:check` と `tests/dependencySecurity.test.ts` が検査する。
- **未解決**: 修正版が公開されるまで advisory 自体は残る。仮定の外（下記）は評価していない。期限付き例外は 2026-11-14 まで（`security/advisory-exceptions.json`）。

## braces（GHSA-vfj7-8cjw-p6xm）

- importer: `micromatch@4.0.8` のみ（lockfile の dependents を検査）。micromatch の importer は `metro-file-map` 2 コピー（`node_modules/metro-file-map` 0.84.6、`node_modules/@expo/metro/node_modules/metro-file-map` 0.84.5）の `src/watchers/common.js` のみ。
- `micromatch/index.js` で `braces()` を呼ぶのは `micromatch.parse` と `micromatch.braces`（`braceExpand` 経由）だけ。metro-file-map が呼ぶのは `micromatch.some` のみで、`some` は `picomatch` を直接使い braces を通らない。metro-file-map 側に `some` 以外の使用はない。
- 仮にパターンが braces に届いても、渡されるパターンは `**/package.json`、`**/<healthCheckFilePrefix>*`、`**/*.<extension>`（Metro config の sourceExts/assetExts 由来）で、ファイルパスや HTTP 入力ではない。`metro.config.*` はリポジトリになく、Expo 既定の拡張子に `{` はない。
- 実行時の確認（再現手順は下の「トレース手順」）: `expo export --platform all --source-maps` と、`expo start --localhost` に対する manifest・bundle 要求を `scripts/trace/dependency-trace.cjs` 付きで実行し、`braces`/`micromatch` の load は記録されたが `braces()` 呼び出しは 0 件だった。0 件を根拠にするのは、`tests/dependencyTrace.test.ts` の陽性対照（実際に `micromatch.braces` / `micromatch.parse` を呼ぶと `braces` イベントが出る）が通る場合に限る。`micromatch.some` は braces を load するが呼ばない（同テストの陰性対照）。
- Expo CLI の dev server は `@expo/cli` 同梱の `@expo/metro-file-map@57.0.4` を使い、これは micromatch に依存しない。Metro HTTP 面（manifest・bundle）の入力はファイル監視のパターンに使われない。
- mobile / web bundle: export した iOS / Android / web の sourcemap（iOS 750 / Android 758 / web 497 sources）に braces・micromatch・picomatch・node-forge・metro-file-map は含まれない。`@expo/cli/.../metro-require/require.js`（Metro の module loader）のみが `@expo/cli` 由来。端末上の runtime には届かない。

## node-forge（GHSA-86w9-cpqp-85rv）

- importer は 2 か所のみ: `@expo/code-signing-certificates@0.0.6` と `@expo/cli@57.0.30` の `run/ios/codeSigning/Security.js`。
- 署名検証 (`.verify`) の呼び出し:
  - `@expo/code-signing-certificates`: `validateSelfSignedCertificate`（証明書の自己署名検証）、`signBufferRSASHA256AndVerify`（直前にローカル秘密鍵で作った署名を検証）、CSR の自己署名検証（`generateDevelopmentCertificateFromCSR`、`@expo/cli` からは呼ばれない）。
  - `@expo/cli` の呼び出し元は `utils/codesigning.js` のみ。`Security.js`（`expo run:ios` の keychain 証明書）は PEM の parse だけで verify しない。
- 入力の出所: 署名検証の対象は (1) `app.json` の `updates.codeSigningCertificate` と `--private-key-path` で指定したローカルファイル、(2) EAS の development certificate（`extra.eas.projectId` とログインが必要）、(3) ローカルで生成した署名。HTTP 要求で攻撃者が渡せるのは `expo-expect-signature` ヘッダの `keyid` / `alg` 文字列だけで、証明書・署名は含まれない。
- このリポジトリは `updates` も `extra.eas.projectId` も持たず、`expo-updates` / `eas-cli` も使わないため、ガード（`!expectSignatureHeader` / `!easProjectId` / `!codeSigningCertificatePath`）で署名経路は null を返す。開発マシン上の dev server（`--localhost`、物理端末ではない）に `keyid="expo-root"` / `"custom"` を付けた manifest 要求は 200 を返し（node-forge は load されない）、`keyid="expo-go"` は 500（`cannot sign with embedded keyid=expo-go key`）で拒否された。署名検証（`verify`）の呼び出しは 0 件で、tracer が RSA 検証を検出できることは同テストの陽性対照（証明書・公開鍵の `verify`）で確認している。
- bundle: node-forge は export した mobile / web bundle に含まれない。

## 仮定（崩れたら再評価する）

- A: dependency の版・importer・呼び出し箇所が上記のまま（`checkCallPathAssumptions`）。
- B: Expo の code signing（`updates.codeSigningCertificate`、EAS project id、`expo-updates`）と `metro.config.*` を導入しない。導入する場合は、その証明書・鍵・拡張子の出所を再評価する。
- C: `npx expo start` の dev server は開発者のマシンで使い、信頼できないネットワークへ公開しない。`--lan` / `--tunnel` でも上の理由で署名検証へは届かないが、これは通信経路ではなく呼び出し経路の評価である。
- 範囲外: 他人の証明書・鍵ファイルを `--private-key-path` などで読み込む操作、EAS / Apple の配布・署名（`AGENTS.md` により未承認）、Expo Go 側アプリ内の依存。

## 残る影響と運用

- 残余影響: braces の DoS（ローカル CLI のハング）や node-forge の不正署名の誤受理が起こりうるのは、攻撃者が制御するパターンや証明書・署名が上の経路へ入った場合に限られる。現行設定ではそのような入力経路は確認できていない。
- 検査: `npm run security:check`（`npm audit --json` を実時計で評価）。CI は `expo export --platform all --source-maps --output-dir dist-ci` の後に `npm run security:check -- --dist dist-ci` を実行する。例外は次の場合に fail する: 期限切れ（2026-11-14 の翌日以降）、`expires` が実在する `YYYY-MM-DD` でない（`2026-13-01`・`2026-02-30`・空文字など）、現在時刻が不正、package / advisory URL / version の形式が不正（ワイルドカード不可）、インストール版の変化、例外外の advisory（severity を問わず新規・同一パッケージの別 advisory を含む）、呼び出し経路の仮定の変化。`--dist <export dir>` で export 済み sourcemap も検査する。
- 解除条件: braces / node-forge の修正版が公開されるか Expo が依存を更新したら、`npm audit` を再実行して例外を削除する。期限までに修正されなければ再評価する。
- 物理端末での確認は行っていない（本変更は dependency と検査スクリプト・CI のみ。端末の挙動は変えない）。

## トレース手順（再現可能）

```sh
OUT=$(mktemp -d)
# 1. tracer の陽性対照（braces / forge verify を実際に呼んで検出できること）
npx tsx --test tests/dependencyTrace.test.ts
# 2. export（sourcemap 付き）を tracer 付きで実行し、sourcemap を検査
TRACE_OUT=$OUT/export.jsonl NODE_OPTIONS="--require $PWD/scripts/trace/dependency-trace.cjs" \
  npx expo export --platform all --source-maps --output-dir $OUT/dist
npm run security:check -- --dist $OUT/dist
# 3. dev server（--localhost）を tracer 付きで起動し、別端末で manifest / bundle を要求
TRACE_OUT=$OUT/start.jsonl NODE_OPTIONS="--require $PWD/scripts/trace/dependency-trace.cjs" \
  npx expo start --localhost --port 8097
curl -H 'expo-platform: ios' -H 'expo-protocol-version: 1' \
  -H 'expo-expect-signature: keyid="expo-root", alg="rsa-v1_5-sha256"' http://localhost:8097/
# 4. 集計（0 でも 1 以上でも、陽性対照が通っていることが前提）
grep -c '"ev":"braces"' $OUT/*.jsonl; grep -c '"ev":"forge"' $OUT/*.jsonl
```

2026-10-15 の再実行（node 26.0.0、`--localhost`）: export は exit 0、sourcemap の source 数は android 758 / ios 750 / web 497、`security:check --dist` は exit 0。manifest は `expo-root` 200 / `custom` 200 / `expo-go` 500、bundle 200。export・dev server ともに `braces` イベント 0、`forge` イベント 0、node-forge の load もなかった。Node 22.23.3 でも `npm test`（282 件）と `security:check --dist` は通った。
