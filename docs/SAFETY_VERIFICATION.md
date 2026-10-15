# Safety Verification: コード・基準・テスト対応

Issue 29（保存の版管理・冪等性）で実際に存在し、実行したテストだけを記載する。記載のない基準は未検証であり、カバレッジを推定しない。

## 実行結果

### 履歴: 元の Issue 29 最終実行（2026-10-15、commit 90e39、PR 47 のマージ前）

この節はその時点の記録であり、以後の `npm test` の件数を示すものではない。

- `npm test`: tests 793 / pass 793 / fail 0（最終実行。途中の 778 は最終値ではない）
- `npx tsc --noEmit`: エラーなし
- `npm run security:check`: 文書化済み・期限内の例外のみ
- `npx expo install --check`: Dependencies are up to date（SDK 57）
- `npx expo export --platform ios`: 成功（実機起動の証明ではない）

### PR 47 後追い指摘の修正（main 841f637 の上、worktree 未コミット状態）

実際に実行した結果。上の履歴とは別の実行である。

- `npm test`: tests 933 / pass 933 / fail 0
- `npx tsc --noEmit`: エラーなし
- `npx expo export --platform ios`: 成功（実機起動の証明ではない）
- `npm run security:check`: 成功

## 鳴動遷移（配信された main 通知 → ringing）

実装: `markCycleRinging`（`src/alarmDefinitionMutations.ts`）、`saveCycleRinging`（`src/alarmStorage.ts`）。App の received listener はこの 1 経路だけで ringing にする（Issue 16 の `markDeliveredCycleRinging` は App から外し、2 回の遷移は走らせない。同関数は `src/snooze.ts` に残り、Issue 16 のテストだけが使う）。時計は queue 内 transaction で `readNowMs()` により読む。App は `Date.now` 関数を渡す（数値を事前取得しない）。

| 基準 | コード | テスト |
|---|---|---|
| armed / step_candidate で一致・期限到達なら ringing | `markCycleRinging` | `tests/alarmDefinitionMutations.test.ts` › markCycleRinging › rings an armed or step_candidate cycle that matches and is due |
| 終端（suppressed/dismissed/missed）を古い・重複配信で復活させない | 同上 | › never revives a finished cycle from an old or duplicate delivery |
| 既に ringing なら変更しない | 同上 | › a repeated delivery of a ringing cycle changes nothing |
| 未知の phase は触らない | 同上 | › a phase this build does not know is left alone |
| cycle・main 通知・due の完全一致（exact identity） | 同上 | › requires the exact cycle, main notification and due time |
| 期限前は鳴らさない | 同上 | › does not ring before the stored deadline |
| 回復窓超過は無音 missed | `classifyDueCycle` | › a delivery discovered after the recovery window becomes silent missed |
| 停止と配信の競合でどちらの順でも終端が勝つ | `transactAlarmDefinitions` | `tests/ringingTransition.test.ts` › a delivery racing a stop cannot overwrite the finished cycle, in either order |
| missed 確認応答との競合で dismissed を維持 | 同上 | › a delivery racing a missed-cycle acknowledgement keeps it dismissed |
| 重複配信は 1 回だけ ringing、後の停止を戻さない | 同上 | › duplicate deliveries ring once and a later stop is not undone |
| 古い main 通知は現行 cycle を変えない | 同上 | › a delivery for an older main notification leaves the current cycle armed |
| 空・破損・旧版 store を配信で修復・上書きしない | 同上 | › an empty or unreadable store is never repaired by a delivery |
| 時計は queue 内で読む（blocker 完了後。時計を期限前へ戻せば armed 維持、回復窓超過なら missed） | `saveCycleRinging` | › the clock is read inside the queued transaction, after a blocker finishes |
| reset 保留中は配信を拒否し、何も書かない | `saveCycleRinging` → `assertNoPendingReset` | `tests/ringingTransition.test.ts` › while a reset is pending, a delivery is refused and writes nothing（`saveCycleRinging` を直接呼ぶ） |
| reset 完了前に作られた配信結果は stale、完了後の結果は fresh | `stampStorageResult` / `isStaleStorageResult` | › a delivery result from before a finished reset is stale, a later one is fresh（直接呼び） |
| snoozed は現行 `snooze.notificationId` を `snooze.dueAtMs` 以降に受けた時だけ ringing。元 main・旧 snooze・別 due では起きない。元 `dueAtMs` は不変 | `markCycleRinging` | › a snoozed cycle rings only for its current snooze notification at its snooze due time |
| snooze 配信が回復窓を超えて見つかれば無音 missed | `classifyDueCycle` | › a snooze delivery found past the recovery window becomes silent missed |
| snooze 配信と停止の競合、重複配信で dismissed を復活させない | `transactAlarmDefinitions` | › a snooze delivery racing a stop never revives the stopped cycle |
| snooze の時計も queue 内で読む | `saveCycleRinging` | › the snooze clock is read inside the queued transaction |
| listener の catch は reset 保留を `reportResetPending` で表示し、一般の保存失敗にしない | `App.tsx` | `tests/appWiring.test.ts` › a failed delivery save reports a pending deletion instead of a generic failure（配線検査） |
| App が `saveCycleRinging` のみを `Date.now` 関数付きで呼ぶ | `App.tsx` | `tests/appWiring.test.ts` › a delivered alarm notification is applied to the latest stored state / a delivered main notification rings through the atomic transition only |
| Issue 16 の snooze 遷移（現行 snooze 通知のみ・元 deadline 不変・上限 3 回） | `markDeliveredCycleRinging`（旧経路、テスト専用） | `tests/snoozeLockIntegration.test.ts`（変更なし、緑） |

UI は `isStaleStorageResult` で reset 前の結果を捨てる `setCurrentAlarms` 経由でのみ状態を反映する。reset 保留中の他の変異拒否は `tests/storageResetGuard.test.ts` が対象。

## ログに依存しない方針の検証（実行済み部分のみ）

- ALR-006（歩数監視）: 今回は鳴動遷移のみを実行・検証した。歩数監視のライフサイクルは本節の対象外。
- ALR-007（周期の永続化・競合・冪等性）: 上表の配信遷移（競合・重複・版/破損 store 非修復・reset gate）が実行済み。他の全経路を網羅したとは主張しない。
- ALR-011（プライバシー・ログ）: 診断カタログは Issue 20 で未実装（pending）。現行の UI エラー文言ヘルパーと record mapping の必要性は維持し、新たな raw native error を UI に出さない。この節は実行したテストの範囲に限る。

## 未検証（物理端末・native）

以下は pending のまま。自動テストでは証明できない。

- 実機での通知配信・音・Focus/消音下の鳴動（ALR-001, ALR-004）
- terminated 状態の Watch action 処理（ALR-002）。**ALR-002 は native 未達成で、fulfilled とは扱わない。**
- Watch routing（ALR-005）、実機の歩数監視（ALR-006）、OS 時刻変更・再起動（ALR-008）

詳細は [REMAINING_ISSUES.md](REMAINING_ISSUES.md) と [DEVICE_TEST.md](DEVICE_TEST.md) を参照。

## 配信 due の完全一致と missed 確認応答（PR 47 後追い）

実装: `buildMainNotificationData` / `buildSnoozeNotificationData` / `readMainDeliveryIdentity`（`src/alarmContracts.ts`）、`src/notificationService.ts`、`App.tsx` の received listener、`acknowledgeMissedAlarms`（`src/missedAcknowledgement.ts`）。

| 基準 | テスト |
|---|---|
| main・snooze の通知 payload に予約した正確な `dueAtMs` が入る（snooze は snooze 自身の due） | `tests/deliveryDueIdentity.test.ts` › main and snooze payloads carry the exact scheduled due time / the scheduling functions use the payload builders |
| listener が payload の due を `saveCycleRinging` へ渡す（配線検査） | › the listener passes the payload due time to the atomic transition |
| 誤った deadline の配信は鳴らさない／snooze は snooze due で判定し元 cycle due は不一致 | › a delivered main payload rings only at its own due time / a delivered snooze payload is judged at the snooze due |
| 不正・非有限の `dueAtMs` は拒否し、legacy 扱いにしない | › malformed or non-finite provided due values are rejected |
| due なしの既存キュー通知は明示的 legacy フォールバック、snooze は現行 ID が必須 | › an already queued payload without a due time keeps the explicit legacy fallback |
| 遅れて missed になった snooze の確認応答で main と snooze の両 ID を persist 後に dismiss | `tests/missedAcknowledgement.test.ts` › a late missed snooze is acknowledged and both of its delivered ids are dismissed after persisting |
| ID 重複排除、dismiss 失敗でも他 ID を試行、persist されなかった cycle・将来/迷子通知は触らない | › delivered ids are de-duplicated... / only persisted cycles are dismissed |

制限: Expo SDK 57 の通知ドキュメントを確認したが、`content.data` は任意の JSON であり、`dueAtMs` の追加に SDK 固有の制約は見つかっていない。実機での配信確認は未実施。
