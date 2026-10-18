# 使えるもの（積極的に使ってよい）

- `LET(x, 式, …, 式)` で変数。`FSET(x, 値)` で LET の変数の値を変えられる（ループで積み上げる: `LET(s, "", t, ARRAY_FOR(3, i, FSET(s, s & i)), s)`）
- `REPLACEALL(項目, ARRAY(p1, r1, p2, r2, …))` / `REPLACERE(項目, ARRAY(…), "g")` で置換の組を配列で（入れ子を平らに）
- 条件付き集計 `SUMIF` / `COUNTIF` / `LASTIF` / `FIRSTIF`、テーブルの行番号 `ROWNO(テーブル)`、空の既定 `NVL`
- テーブルの集計 `TLTABLE(テーブル, TPKEY(キー), TPVAL(値), TPOUT(出力の列), TPSORT(並び))`（分類ごとの集計を別のテーブルに出す。patterns の章の集計）
- ユーザー情報 `UINFO(LOGIN_CODE(), "#boss")`（カスタマイズ項目は `#コード`）、`OUSERS(組織)`、`GUSERS(グループ)`（各種設定「ユーザー情報」が ON のとき。既定のテストデータは test-users の章）
- 関数の説明と使用例は function-list の章（`fml_docs` の query に関数名）。定型の計算（集計・小計・転記・行番号・初期の行・ユーザー情報 …）は patterns の章を「やりたいこと」の言葉で探す（関数名から探す前にこちら）
