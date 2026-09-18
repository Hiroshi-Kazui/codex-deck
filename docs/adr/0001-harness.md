# ADR-0001: 実装ハーネス

状態: 指揮方式は [ADR-0002](0002-native-workflow.md) により置き換え。以下は旧CLI方式の設計記録。アプリ接続方式の実機成立を宣言しない。

ユーザー選択: CLI自動実行、通常Sol、重要箇所と行き詰まり診断Astra。
工程管理はNode.jsの決定的な状態機械。実装者1体、別セッションのレビュー、重要工程だけ追加レビュー。
実測コマンドと条件別証拠をゲートにし、点数や実装者の自己申告を合格根拠にしない。
通常修正は正確なthread IDでresume。診断後と工程切替は新セッション。
全ソースハッシュで未追跡ファイルと初回コミット前も扱う。レビュー中は変更停止。
受け入れ条件やハーネスへの実装者による変更は検出停止。これは敵対的プロセスに対するOS隔離ではない。

依存の変更: npm registry への取得がEACCESで拒否されたため、予定したAjvを採用せず依存ゼロとする。
schemas.mjsは本リポジトリが使う限定JSON Schemaのみを検証する。汎用実装を称さず未知キーワードは拒否。
同じスキーマをCodex --output-schemaにも渡す。ローカル検証と意味上のレビュー整合性検査を重ねる。

参照: https://learn.chatgpt.com/docs/non-interactive-mode
参照: https://learn.chatgpt.com/docs/agent-configuration/agents-md
