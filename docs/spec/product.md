# codex-deck 製品仕様

この文書は合意済みの「cockpit を基にした codex-deck 詳細実装計画」の実装要件。
工程順と条件IDの正は milestones/tasks.json。未実装の要件も含む目標仕様であり、現状の完成宣言ではない。

## 完成形
Windows 用の別 Electron アプリ。cockpit の画面・操作を継承する。React/TypeScript strict/xterm/node-pty/better-sqlite3 を使い、main/preload/renderer/shared の境界を維持。
認証と対話のモデル・sandbox・approval はユーザーの Codex 設定を継承。Claude の bypassPermissions は移植しない。
データは %APPDATA%/codex-deck に分離。過去の cockpit データ移行なし。元アプリは参照専用。

## 接続とライフサイクル
ペインごとに Codex App Server --stdio とローカル通信中継、PTY 内の Codex --remote TUI を管理。
中継は127.0.0.1動的ポート、起動ごとのトークン。要求ID衝突を防ぎ、承認要求と未知メッセージをそのまま往復させる。
同じCLI実体を使用。プロセス世代で旧イベントを拒否。正確なthread IDで再開し、--lastに依存しない。
M0で実接続を検証する。方式が成立しない場合は仕様判断が必要であり、独断で別UIへ変更しない。
CLI 0.154.0のヘルプ・生成型は調査済みだが、実接続の成立は実装前時点で未検証。
App Server資料: https://developers.openai.com/ja-JP/docs/app-server

## 画面・入力・目的
最大4ペイン、1/2/4配置、ドラッグ分割と保存、PTYリサイズ。
固定高さ入力欄: Enter送信、Shift+Enter改行、Ctrl+Enter挿入のみ、Escape端末へフォーカス。IME変換確定を送信にしない。
目的未入力なら最初の実ユーザー入力を目的にする。タイトルは非同期に約20文字、失敗は目的先頭。
目的はthreadとは独立し明示完了まで維持。停止と完了を分ける。完了しても履歴と評価を保持。
再起動で配置/cwd/未完了目的を復元。Codexの再開は手動。

## 永続化・履歴
主キーはthread ID。sessionIdはforkで共有されることがあるため一意な会話キーとしない。
purposes/threads/runs/purpose_turns/evaluations/settings/archive_mirror をSQLiteで管理。
archive/<threadId>/events.jsonlに schemaVersion/eventId/sequence/time/threadId/turnId/itemId/runId/kind/payload を追記。
ユーザー入力、応答、公開されたreasoning、ツール呼び出しと状態、承認結果、境界、中断、目的関連を保存。
ツール出力本文、認証・接続トークンは保存しない。未知の会話イベントは由来を保ち、アカウント設定フレームは除外する。
完了を最終内容とし差分の二重表示を防ぐ。未完了は未完了として残す。
再開・ターン終了時にページング履歴を照合して欠落を補完。受信重複、部分書込、索引再構築に対応。
目的別の評価対象は関連するturnのみ。再開で取り込んだ過去履歴を新目的へ自動帰属させない。
目的・タイトル・本文の閲覧専用検索。不完全な記録は状態を表示。

## ミラー・使用量
任意のローカル同期フォルダへJSONLを非同期転送。保存先別進捗・失敗・復旧、過去分は明示バックフィル。
DB、内部チェックポイント、認証情報をミラーしない。ミラー失敗で対話を止めない。
使用量は公式thread token usageとaccount rate limits。累積/直近/cache/reasoningの二重加算禁止。
コンテキスト色は60%未満緑、60〜84%橙、85%以上赤。動的な時間枠・モデル・リセット時刻と更新時刻を表示。
未取得や古い値を明示し、架空の残量を表示しない。

## 補助モデル・評価
タイトルと評価は既定Codexモデルを継承、アプリ設定で変更可。独立した待ち行列、ephemeralの構造化出力、読み取り専用実行、時間制限。
目的完了時に保存済みの対象turnから評価。ユーザー入力優先、アシスタントの先頭/末尾を決定的な規則で抽出し、上限と省略を示す。
空入力はモデルを呼ばずskipped。円滑さ/ストレス/意思疎通コスト0〜100、要約、ユーザー側/環境側改善案。
再評価/異議申し立ては新規行、旧結果保持。前回評価と異議を入力に含め、機械的に同意しない。
最新成功評価を目的ごとに採用しISO月曜始まり週/月/全期間集計。SVGレーダーは正方向を揃え元数値も表示。主観的評価と明示。
MD/JSON出力とミラーを独立。レポート失敗でも評価を失わない。モデル失敗時に黙って別モデルへ切り替えない。

## Git・完了条件
新規開始のみdefault branchとpull --ff-only。dirtyにはuntrackedを含める。同じrepoを別ペインが使用中ならcheckout/pullをしない。
Gitなし/非repo/remote・upstream不在/不明/失敗でもCodex起動を許可し理由を表示。確認5秒・checkout20秒・pull30秒。
自動stash/reset/clean/commit/rebase/merge/pushなし。
typecheck/lint/unit/E2E/buildと実WindowsでのConPTY/IME/認証/4ペイン/復旧を確認。
ローカル非表示起動スクリプトと説明書まで。インストーラ、自動更新、公開配布は初版に含めない。
