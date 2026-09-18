# codex-deck

cockpitを参照して開発する、Windows向けCodexマルチペインアプリ。アプリ本体は未実装です。

作業再開時は[現在の状態と実装プラン](現在の状態と実装プラン.md)を確認してください。実装の入口は[開発ワークフロー](docs/harness/WORKFLOW.md)です。ユーザーと対話中のメインエージェントが内蔵サブエージェントへ実装と独立レビューを割り当て、検証・修正・記録を指揮します。

- [製品仕様](docs/spec/product.md)
- [M0〜M6のタスクと受け入れ条件](milestones/tasks.json)
- [工程の説明](milestones/README.md)
- [新方式の設計判断](docs/adr/0002-native-workflow.md)
- [検証記録](docs/harness-validation.md)

`tools/harness/cli.mjs` は旧CLI方式です。通常のアプリ実装指示から起動せず、旧方式の記録を新ワークフローの合格証拠として扱いません。
