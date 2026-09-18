# ADR-0002: メインエージェントが指揮する開発ワークフロー

状態: adopted for harness redesign。アプリ実装の開始・合格を意味しない。
日付: 2026-09-19（日本時間）。ADR-0001の外部CLIによる指揮方式を置き換える。

## 根拠

ユーザーが求めたハーネスは、メインによる実装サブエージェントへの指示、独立レビュー、FIX、反復を定義したワークフロー文書だった。参照元cockpitもメインが指揮する構造である。
Node.jsから別Codex CLIを起動する旧設計はこの要求を取り違えていた。通常PowerShellで旧smokeは成功したが、親のシェルがネットワーク制限を受ける環境では子CLIが接続できなかった。これは内蔵サブエージェントが使えない証拠ではなかった。

## 決定

- 正式な入口を `docs/harness/WORKFLOW.md` とし、メインが内蔵の委任・追加指示・状態確認ツールで実行する。
- 実装者1体、4観点レビュー、criticalの追加レビューと診断。モデル配分は既存のSol/Astra方針を維持し、effortはhighを明示する。
- タスクJSON、製品仕様、M0/IME/Windows実機ゲートを維持する。点数ではなく条件ごとの証拠で判定する既存方針も維持する。
- 旧コードと実行証拠は削除せず、旧方式と明示する。旧実行の未確認プロセス終了を新方式で勝手に合格扱いしない。
- 新方式はワークフロー定義書であり、権限隔離やタイマーの機械的強制を自作ランナーと同等に保証しない。メインの検証・記録と実際のホスト機能の範囲を明示する。

## 確認

`prototypes/workflow-mini/RESULT.md` に、内蔵エージェントで実装・独立レビュー・明示的な不具合注入・FAIL・FIX・再PASSを実測した記録がある。
公式の [Subagents](https://developers.openai.com/es-419/docs/agent-configuration/subagents) と [AGENTS.md](https://developers.openai.com/es-419/docs/agent-configuration/agents-md) を参照。設定ファイルの新設を前提にせず、この会話で使える委任ツールを使う。
正式ワークフローのレビュー結果は `docs/harness-validation.md` に記録する。
