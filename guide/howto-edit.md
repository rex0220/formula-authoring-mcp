# 既存の設定を変える

1. **今の設定を取る** — `fml_pull`（app、profile）でアプリの今の設定をアプリのフォルダーに `rex0220-formula-app<番号>-<日時>.json`（ダウンロードと同じ名前）で取る（kintone の API ラボの機能が有効なとき）。取れなければ、利用者に設定画面の「設定をダウンロード」を頼み、作業フォルダーの `inbox/` に置いてもらって `fml_take` でアプリのフォルダーへ移す。`fml_files`（app）で一覧（先頭が今の設定）
2. **写す** — `fml_edit`（app か path）で `…-edit.json` に写す。**ダウンロード / pull のファイルは書き換えない**（直すのは写し）
3. **見る** — `fml_summary`（path = -edit.json）で全体（項目の一覧、ランク順 = 計算順）と digest、`field` で直す項目の計算式の全文
4. **直す** — `fml_update_fields`（path、expectedDigest、rows）。rows は直す項目の行（`fieldcode` と、変える元の値 `state` / `formulaSet` / `edit` / `hide` / `rank` だけ）の配列。複数の項目をまとめて差し替えられる。**設定のファイルに無い行も足せる**（ヘッダーのボタン `($HEADER1)`、スペース項目 `(sp1)`、計算式の無かった項目。`fml_fields` の項目と最後の行の fieldcode。省いた値は既定 = `state` は `formulaSet` があれば true、`edit` / `hide` は false、`rank` は空。アプリに無い fieldcode は `field.missing` で invalid）。新しいファイルに全体を書き直さない。共通の設定（各種設定、一覧、権限）を変えるなら `common`。保存は normalize を通る（エラーがあれば invalid で変わらない）。結果の `diff` に変わった項目（`added` / `changed`、★ = 既存レコードの値に影響する項目。ボタン・表示の行は `display: true` で ★ にならない）
5. **calc と差** — `fml_calc` で値を確かめ、`fml_diff`（before = ダウンロード / pull、after = -edit.json）を利用者に見せる
6. **反映方法** — howto-new の 7 と同じ。取り込み方は「項目の置換」で、変えた項目だけチェックしてもらう（設定画面の言葉で書く（「全体を置き換える取り込み」などに言い換えない）。全体を取り込んでよいときも「全置換」と書く）（共通の設定を変えていなければ「共通の設定」のチェックを外す）。反映したら、次の `fml_pull`（またはダウンロード → `fml_take`）が新しい今の設定になり、写し（-edit.json）は消してよいと伝える（消すかは利用者が決めて利用者が消す）

接続のファイルが無いとき（`fml_workspace_status` の mode が not-configured）は、`fml_pull` / `fml_take` / `fml_edit` は使えない。利用者に設定画面のダウンロードを `settings/` に置いてもらい（`fml_files` で名前を見る。`fml_summary` で中身）、そのファイルは直さず、写しを `fml_save_settings` で作る（path は `settings/APP<番号>-<アプリ名>-直し.json` のように、ダウンロードの名前でも `-edit.json` でもない名前。content はダウンロードと同じ封筒。fields は利用者が置いた `fields/<番号>.json`）→ 写しを `fml_summary`（digest）→ `fml_update_fields` で直す → `fml_calc`（records は `records/<番号>-<レコード番号>.json`。fml_record は使えないので利用者が置く）→ `fml_diff`（ダウンロードと写し）。
