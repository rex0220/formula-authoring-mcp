# 既存の設定を変える

1. **今の設定を取る** — `fml_pull`（app、profile）でアプリの今の設定をアプリのフォルダーに `rex0220-formula-app<番号>-<日時>.json`（ダウンロードと同じ名前）で取る（kintone の API ラボの機能が有効なとき）。取れなければ、利用者に設定画面の「設定をダウンロード」を頼み、作業フォルダーの `inbox/` に置いてもらって `fml_take` でアプリのフォルダーへ移す。`fml_files`（app）で一覧（先頭が今の設定）
2. **写す** — `fml_edit`（app か path）で `…-edit.json` に写す。**ダウンロード / pull のファイルは書き換えない**（直すのは写し）
3. **見る** — `fml_summary`（path = -edit.json）で全体（項目の一覧、ランク順 = 計算順）と digest、`field` で直す項目の計算式の全文
4. **直す** — `fml_update_fields`（path、expectedDigest、rows）。rows は直す項目の行（`fieldcode` と、変える元の値 `state` / `formulaSet` / `edit` / `hide` / `rank` だけ）の配列。複数の項目をまとめて差し替えられる。共通の設定（各種設定、一覧、権限）を変えるなら `common`。保存は normalize を通る（エラーがあれば invalid で変わらない）。結果の `diff` に変わった項目（★ = 既存レコードの値に影響する項目）
5. **calc と差** — `fml_calc` で値を確かめ、`fml_diff`（before = ダウンロード / pull、after = -edit.json）を利用者に見せる
6. **反映方法** — howto-new の 7 と同じ。取り込み方は「項目の置換」で、変えた項目だけチェックしてもらう（共通の設定を変えていなければ「共通の設定」のチェックを外す）。反映したら、次の `fml_pull`（またはダウンロード → `fml_take`）が新しい今の設定になり、写し（-edit.json）は消してよいと伝える（消すかは利用者が決めて利用者が消す）

接続のファイルが無いとき（`fml_workspace_status` の mode が not-configured）は、利用者に設定画面のダウンロードを `settings/` に置いてもらい、同じ名前では直さず写し（`settings/APP<番号>-<アプリ名>-edit.json` を `fml_save_settings` で作る）を `fml_update_fields` で直す。
