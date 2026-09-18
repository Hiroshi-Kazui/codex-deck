# 試験用 clamp の受け入れ条件

`clamp.mjs` は名前付き関数 `clamp(value, min, max)` をexportする。外部依存なし。

- C1: 範囲内と両端の数値はそのまま返す。小数・負数も扱う。
- C2: 下限未満はmin、上限超過はmaxを返す。minとmaxが同じ場合も同じ値を返す。
- C3: 引数のいずれかが有限のnumber以外ならTypeError。文字列の暗黙変換はしない。
- C4: 3引数が有限のnumberでmin > maxならRangeError。

この関数はハーネス試作の検証用fixtureであり、codex-deckのアプリコードではない。

検証: `node --test prototypes/workflow-mini/clamp.test.mjs`
レビュー報告: status、C1〜C4の個別判定とファイル/テスト証拠、blockingの問題・再現・必要な修正。
