# codex-deck

Windows 用 Codex マルチペインアプリ。現在の仕様は `docs/spec/product.md`。
参照元は `C:/develop/cockpit`。参照元、認証情報、ユーザーの Codex 設定を変更しない。

## 作業の入口
- 工程・受け入れ条件: `milestones/tasks.json` と `milestones/README.md`。
- ハーネス: `docs/harness/WORKFLOW.md`。メインが内蔵サブエージェントを指揮する。実装者は割り当てられた1タスクだけを扱う。
- 設計判断: `docs/adr/`。実装のために受け入れ条件を弱めない。
- ハーネス本体の明示的な変更依頼では、下記のアプリ実装者向け凍結範囲を変更してよい。

## 境界
- Electron main は特権処理、preload は最小の型付き IPC、renderer は画面、shared は型と純関数。
- TUI の表示を解析して会話を推測しない。公式イベントを正規化する。
- thread/session/run/purpose の ID を混同しない。記録は追記、復旧可能にする。
- TypeScript strict。例外を黙殺せず、失敗理由を利用者に示す。
- Windows パスは path API を使う。プロンプトやユーザー入力をシェル文字列へ埋め込まない。
- 既存データを削除しない。自動 commit/push/reset/clean/stash はしない。
- アプリ実装者は `tools/harness`、`docs/harness`、`milestones`、`docs/spec`、`docs/adr`、本ファイル、`.gitignore` を変更しない。仕様判断が必要なら根拠と質問を返す。
- メインエージェントはワークフローに従い、内蔵ツールで実装者・独立レビュワーを起動して指揮する。実装者・レビュワー・診断者は孫エージェントを起動しない。
- モデル配分は既存計画を維持する。実装と通常の4観点レビューは `gpt-5.6-sol`、criticalの追加レビューと行き詰まり診断は `gpt-6-astra`。今回の定義では各役割 `high` を明示指定する。利用不可なら理由を記録し、黙って別モデルに切り替えない。
- `tools/harness/cli.mjs` は旧CLI方式。通常の実装指示から起動しない。旧状態を新ワークフローの合格記録として扱わない。

## 検証
- 受け入れテストは実際の振る舞いを検証する。空テスト・常時成功・skipによる合格は禁止。
- ハーネスの検証: `node --test tools/harness/test/*.test.mjs`。
- アプリはタスク指定の `verify:mN-NN` と typecheck/lint/test/build/test:e2e を整備する。
- テストは隔離したデータ・模擬 CLI を使う。実機ゲートだけ実 Codex を使用する。
- 実機ゲートを実施できなければ未検証として停止する。架空の証拠を作らない。
- 合格済みテストの繰り返しは、変更・失敗・未解決の懸念がある場合に限る。
