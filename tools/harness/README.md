# Codex 実装ハーネス

> これは旧CLI方式の記録。現在の入口は [メインが指揮するワークフロー](../../docs/harness/WORKFLOW.md)。通常の実装依頼から以下のrun/resumeを起動しない。旧コード・証拠の保全と明示的な旧方式調査のために残す。

Node.js 24以上とログイン済みCodex CLIを使用。npm installは不要。
実装者はSol、通常レビューは別セッションのSol、criticalタスクの追加レビューと診断はAstra。
モデルIDと上限は `config.json` に集約。既定モデルへの黙ったフォールバックはしない。

```powershell
node --test tools/harness/test/*.test.mjs
node tools/harness/cli.mjs doctor
node tools/harness/cli.mjs run --through M6
node tools/harness/cli.mjs status
node tools/harness/cli.mjs stop
node tools/harness/cli.mjs resume
```

runの起動は指定範囲の実装・検証・レビューの実行指示。M0の実機ゲートを通過するまでM1へ進まない。
Codex の実行環境が `CODEX_SANDBOX_NETWORK_DISABLED=1` を設定している場合、実モデル用 run/resume は状態を作る前に拒否する。親エージェントが応答できても子の Codex CLI が API に接続できるとは限らない。接続可能なホストで実行する必要があり、この検査は接続成功を保証しない。
doctor はこの環境では `modelNetwork: blocked-by-environment` を報告する。別の環境で成功した smoke の結果を現在の環境の接続証拠として扱わない。
このハーネスを作成しただけでは、アプリ本体の自動実装は開始されない。
初回コミットは不要。Gitのownershipエラーがあればdoctorで検出し、global safe.directoryの一括許可を自動設定しない。
Codexの権限は実装workspace-write/レビューread-only、approval never。認証は既存CLIを使用し、認証ファイルをコピーしない。
制約によって必要操作が実行できない場合は具体的な理由を表示して停止。sandboxやhook trustを迂回しない。
CLIはexeを優先、npmインストール版はbin/codex.jsをNodeで起動し、PowerShell実行ポリシーを変更しない。

## 状態と再開

`.harness/state.json`に状態、`events.jsonl`に追記イベント、`runs/<id>/`にプロンプト・構造化結果・完全ログを保存。
通常修正は正確なthread IDでresumeし、診断後は新しい実装セッションへ切り替える。
完了したタスクは再実行しない。停止中にソースが変われば完了済みタスクの証拠を失効させ、検証とレビューをやり直す。
途中の実装や利用者変更をreset/cleanで捨てない。停止操作はハーネスが起動したプロセスを対象とする。
強制終了後に旧子プロセスが生きている場合は自動でPIDを信頼して終了させず、確認を依頼する。
Windowsでtaskkill /Tが拒否された場合は所有する直接の子だけを終了し、子孫の終了を未確認として記録する。未確認のままresumeしない。
残存プロセスを確認・終了した後だけ `node tools/harness/cli.mjs recover --confirm-processes-closed` を実行する。この操作は利用者の確認を記録するもので、自動の終了確認ではない。
反復上限に達したタスクは同じ状態のresumeだけでは上限をリセットしない。原因を修正すると内容変更を検出して再試行できる。
未検証、実機操作待ち、認証エラー、利用不可モデルは合格扱いしない。

## 判定と効率

- タスク定義から実コマンドを起動し、終了コードとソースハッシュを保存。
- 条件IDの欠落・重複、blockingを含むPASS、壊れたJSONを拒否。
- レビューは読み取り専用、criticalではSolとAstraが同じ変更を並列レビュー。
- 実装者がハーネス/仕様/受け入れ条件を変更した場合は停止。これは事後検知であり、悪意あるプロセスに対する隔離の代用ではない。
- 同一タスク最大初回+修正3回、2回失敗後にAstra診断1回。一時通信失敗のみ最大2再試行。既にファイルを変更した失敗は盲目的に再実行しない。
- agent30分/check10分/run120分。制限到達は保存して停止。
- コストは実測トークンと実行時間で比較。価格推定や無根拠な「最適」判定はしない。

## 実モデルの試験

```powershell
node tools/harness/smoke.mjs
```

SolとAstraの実モデル使用量が発生する。`.harness/smoke/`の隔離repoで小さな加算関数を実装し、意図的中断・再開・検証・独立レビューを確認する。
結果は `.harness/live-smoke.json`。外部接続/ログイン/モデル権限がない場合はblockedを記録し、模擬試験の結果と混同しない。
Windowsソケット10013/EACCESを検出した場合は無駄な再接続を続けず停止する。実行環境で外部接続が禁止されている場合、通常のPowerShellから同じsmokeコマンドを実行する必要がある。
ログにコードや会話が含まれるため `.harness` はGit管理外。外部送信や自動公開はしない。

## 障害時

statusのreasonと該当runsディレクトリのexecution.json/stdout/stderrを確認する。
1. 認証:通常のターミナルでCodexにログイン後resume。
2. 仕様判断:対象条件と根拠を確認し、利用者の指示に基づいて仕様/タスクを変更後resume。
3. 旧プロセス:状態に記録されたPIDが今回の実行か確認して終了後resume。
4. 実機操作:タスクが示す操作結果と証拠を取得後resume。
ハーネスや条件を実装者が改変した場合、diffを確認して復元または意図した変更を確定する。自動ロールバックは行わない。
