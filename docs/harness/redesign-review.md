# ハーネス再設計のレビュー記録

日付: 2026-09-19（日本時間）。対象はワークフロー定義書。アプリの受け入れ判定ではない。
メインが内蔵サブエージェントを指揮し、指定モデルは以下すべて `gpt-5.6-sol` / `high`。

## 初回レビュー

| エージェント | 役割 | 実際の結果 |
|---|---|---|
| `/root/native_code_review` | code | FAIL、blocking 2件 |
| `/root/native_architect_review` | architect | PASS、軽微な指摘1件 |
| `/root/native_requirements_review` | requirements | 中核PASS。入口文書の旧起動案内は別途修正が必要 |
| `/root/native_usability_review` | usability | PASS、軽微な指摘2件 |

全員が実装者と独立したスレッドでファイルを読んだ。読み取り専用を指示し、役割別の結果を回収した。
同時枠に合わせ、最初の3役割の一部が完了してから4番目を起動した。

## FIX 1

メインが `/root/native_workflow_writer` へ `followup_task` で以下を渡した。

- B1: 実ファイルの追加・変更・削除を許可範囲と保護対象へ照合する手順の欠落。実装者の自己申告に依存せず、違反時は停止・証拠保存とする。
- B2: ソース指紋から除外する `.harness` 内の必須実機証拠が改変・削除されても検知できない。検証ログも含め別の証拠一覧とハッシュを保存し、合格・再開前に確認する。
- A1: 明示モデル指定と `fork_turns` の制約を明文化する。
- U1/U2: 長時間作業中の進捗報告、確認前に独立した安全な作業を進めることを明文化する。

入口のREADME、現在の状態と実装プラン、検証記録の整合も同じ書き手へ委任した。

## 実測と保全

- 旧補助コードの回帰: `node --test tools/harness/test/*.test.mjs` → exit 0、22 pass、0 fail、0 skip。
- 新ワークフローの最小実行は `prototypes/workflow-mini/RESULT.md`。初回合格・意図的な不具合注入・実FAIL・FIX・再PASSを実測済み。
- tasks.json/product/reference-manifestのSHA-256は旧実行前の記録と一致し、アプリ受け入れ条件と製品仕様は変更していない。
- 旧 `.harness/state.json` のblocked/cleanupRequiredを解除していない。

## FIX 1後の再レビューと最終判定

| エージェント | 役割 | 実際の結果 |
|---|---|---|
| `/root/final_code_review` | code | PASS、B1/B2解消、blocking 0 |
| `/root/final_architect_review` | architect | PASS、blocking 0 |
| `/root/native_requirements_review` | requirements | PASS、blocking 0 |
| `/root/native_usability_review` | usability | PASS、U1/U2解消、blocking 0 |

各レビューは `gpt-5.6-sol` / `high`。既存レビュワーへの追加指示または新しい独立スレッドで実施した。レビュー中は対象文書を変更せず、全結果回収後にメインがこの最終記録と入口文書の完了状況を更新した。requirementsの軽微な指摘に従い、引き継ぎ文書の「進行記録はnative、必須証拠はevidence」という保存先の書き分けも明確にした。

**判定: ワークフロー定義書の再設計は合格。** アプリ実装の開始・合格ではない。

レビュー対象の中核文書SHA-256（レビュー後も変更なし）:

- WORKFLOW.md: `B8FDBD7D5B0B4C7B25CD717EB829639F13450FDC7D10CEC4CC192A0DD58C0920`
- roles.md: `1F39B0A032C7BE4F7E11EAC22F6E52F407372BE436168CABC216819A1602E724`
- review-rubric.md: `E041FCD73EF06C46B48EFFE77E83AE89821A453BBEDCE04B44316957FC874E3F`

ローカルMarkdownリンクの参照先存在を確認した。実測できた範囲は最小試作の実装/FIXと、Sol highによる定義書修正・4観点レビュー。Astraのcritical追加レビュー・診断、全工程の長時間運用、アプリ実機ゲートは未検証。旧実行の子孫終了確認はアプリ着手前の残課題として保持する。
