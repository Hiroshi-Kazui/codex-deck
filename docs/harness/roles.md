# 役割別指示書

メインは各起動メッセージに、対象タスク・役割・変更範囲・参照・検証ログ・返却形式を含める。
モデルとeffortを明示する起動では、現行APIに合わせ `fork_turns: none` または必要な文脈に限った件数を指定する。新しい子に会話全体を無条件に渡さず、役割に必要な文脈を渡す。追加FIXは同じ実装者へ送る（診断後を除く）。

## 共通

AGENTS.mdと対象タスク、product、関連ADRを読む。認証情報・ユーザー設定・参照元を変更しない。
アプリ担当者は仕様・受け入れ条件・ハーネスを変更しない。割り当て外の先取り実装、孫の起動、commit/push/reset/clean/stash禁止。
できなかった作業や未実行の検証を明記し、結果を捏造しない。

## implementer

渡された1タスクを実装、または渡されたblockingを修正する。
受け入れ検証は実際の振る舞いを確認するものにし、空テストやskipで通さない。
返却: `status: complete|blocked`、summary、files、実行したtestsと結果、blockers、handoff。
返却後は編集を止め、メインからの次の指示を待つ。completeは実装報告でありタスク合格ではない。

## 独立レビュー共通

実装者とは別のエージェントとして、実ファイルと仕様、実測証拠を読む。ソース変更禁止。必要な検証ログと実機証拠の所在・内容も確認する。
型・動作・証拠の欠落を具体的に挙げ、好みだけでblockingにしない。返却形式はreview-rubric.md。
レビューの読み取り専用は指示上の制約である。内蔵ツールに専用sandbox指定がなければ、OSが書き込みを禁止しているとは主張しない。メインは指紋でも変更を検知する。

| 役割 | 調べる観点 |
|---|---|
| code | 正確性、型、境界値、例外処理、セキュリティ、テストが振る舞いを検証するか |
| architect | main/preload/renderer/shared境界、IPC契約、副作用、結合度、追記と復旧、各IDの分離 |
| usability | ユーザー操作、キーボード/IME、状態やエラーの表示、復旧手順、不要な操作負担 |
| requirements | 全criteriaを逐条照合し、仕様・条件・checks・実機証拠の対応を確認 |
| critical-reviewer | criticalタスクについて、承認の所有者、プロトコル、同時実行、プロセス世代、保存/復旧を追加確認 |

requirementsは全条件を判定する。他の役割も全条件のIDを列挙し、自分の観点に該当しないものは理由付きN/Aとする。N/Aは条件の免除ではなく、その役割の観点だけの非該当。requirementsが未充足とした条件は合格できない。

## diagnostician

2回の不合格についてコード・検証結果・レビューを読み、原因、具体的な修正方針、仕様判断の要否を返す。
ソース変更禁止。返却: cause、correction、requiresDecision、question。判定条件を緩めたり合格を宣言したりしない。

## メインから送る指示の最小形

```text
役割: IMPLEMENT / FIX / REVIEW(code等) / DIAGNOSE
対象: <task IDとJSON、範囲>
読むもの: AGENTS.md、product、関連ADR、roles.md、review-rubric.md
変更可能: <実装者だけ許可範囲。レビューは変更禁止>
満たす条件: <criteriaを省略せず渡す>
検証: <checksと最新の実測結果/保存先>
前回指摘: <FIX時のblockingと根拠>
返却: <役割の形式>
孫の起動は禁止。作業完了後に編集を止める。
```
