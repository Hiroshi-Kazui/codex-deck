# ハーネス検証記録

## 現在の確認範囲（2026-09-19）

[ADR-0002](adr/0002-native-workflow.md)により、正式な開発手順は[WORKFLOW.md](harness/WORKFLOW.md)のメインエージェント主導方式となった。[小規模試作の記録](../prototypes/workflow-mini/RESULT.md)では、内蔵サブエージェントによる実装、独立レビューPASS、意図的な欠陥注入、実測のテストFAIL（4件成功・1件失敗）、元の実装者によるFIX、メインの再検証と独立再レビューPASS（5件成功・失敗0）を確認した。

この試作の役割は親モデルを継承した。指定したSol/Astraへのネイティブな切り替え、通常4観点とcritical追加レビュー、アプリ本体のM0〜M6、実機ゲートは試作では検証していない。

その後、ワークフロー定義書の修正担当と4観点の独立レビュワーを `gpt-5.6-sol` / `high` の明示指定で起動した。初回codeレビューは変更範囲の実測と証拠ファイルの照合に関するblocking 2件でFAIL。元の修正担当へFIXを渡し、再レビューでcode・architect・requirements・usabilityの全観点PASS、blocking 0を確認した。[再設計レビュー記録](harness/redesign-review.md)を参照。これは文書と内蔵委任の実測であり、Astraのcriticalレビュー・診断、アプリの実機ゲート、長時間運用の検証ではない。

旧CLIの自動テストは直近実行で22件成功、失敗・skipなし。これは旧CLIの回帰確認であり、新方式の合格証拠には含めない。

## 旧CLI方式の履歴（2026-09-18〜19、日本時間）

Windows / Node.js 24.13.0 / Codex CLI 0.154.0。初回の `node --test tools/harness/test/*.test.mjs` は21件成功、失敗・skipなし。`node tools/harness/cli.mjs doctor` はCLI実体・Git・参照元・書き込み先・13タスクの確認に成功した。隔離した環境と模擬Codexで、実装・検証・レビュー・FIX・停止・再開、証拠失効、二重起動、異常終了、通信拒否、時間上限、未確認の子孫プロセス終了を検証した。

この実行環境からの初回smokeとM0-01はモデル応答前に `wss://api.openai.com/v1/responses` への接続がソケット10013で拒否された。後に通常のログイン済みPowerShellで旧smokeを実施し、`.harness/live-smoke.json` は `2026-09-18T15:34:24.840Z` に `passed`、停止・再開の確認も記録した。この成功は旧CLIのsmokeに限る。

旧 `.harness/state.json` はM0-01を `blocked` と記録し、`cleanupRequired: { treeConfirmed: false, pid: 7488 }` が残る。旧runの子孫プロセス終了を確認していないため、この状態を勝手にクリアしない。M0-01のアプリコードは実装されていない。

npm registryへの接続拒否に合わせ、旧ハーネスは外部依存なしの限定スキーマ検証へ変更した。このサンドボックスで `taskkill /T` が拒否された場合は未確認の子孫プロセスを理由に自動再開を拒否する。参照元cockpit、ユーザーのCodex設定、Gitのremote/所有権は変更していない。
