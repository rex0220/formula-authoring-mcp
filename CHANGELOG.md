# 変更履歴

formula MCP（Claude Desktop の拡張機能「計算式 設定オーサリング（Formula）」と、Claude Code のプラグイン `formula`）の、利用者に見える変更です。新しい版が上です。

## 0.2.0（2026-10-18）

中核は `@rex0220/formula-authoring-tools` 0.3.0。

- `fml_try`: 同梱のサンプルアプリ（架空。全項目タイプ × 2、テーブル 2 つ、レコード 3 件 = 典型 / 端 / 空）で式を試す。関数の解説・使用例・式の断片を、利用者のアプリ・レコードが無くても実際の計算式エンジンで確かめる（レコードごとの値と、検査のエラー・警告）。`describe: true` でサンプルアプリの項目の一覧
- `fml_try` の架空の項目と値: `fields` でサンプルアプリに項目（選択肢つき、テーブル）を足す、`data` で架空の値のレコード（簡略形）、`app` で利用者のアプリの項目定義（`fml_fields` で取った `fields.json`）に架空の値を当てる（利用者の項目コード・選択肢・境界値で式を確かめる。kintone には何も送らない）
- `fml_docs` に try の章。目次と指示に「関数の解説・使用例・式の断片は fml_try で確かめてから答える」

## 0.1.0（2026-10-18）

初めての版。中核は `@rex0220/formula-authoring-tools` 0.2.0（計算式プラグイン Ver.101 以降、authoring API 1）。

- Claude Code のプラグイン `formula`（marketplace `rex0220-formula`）と Claude Desktop の `.mcpb`
- ツール: `fml_docs`、`fml_status`、`fml_workspace_status`、`fml_save_settings`、`fml_update_fields`、`fml_summary`、`fml_normalize`、`fml_calc`、`fml_fields`、`fml_record`、`fml_users`、`fml_pull`、`fml_files`、`fml_take`、`fml_edit`、`fml_diff`（Desktop は `kintone_get_app`、`kintone_list_records` も）
- kintone の接続は接続のファイル（kSQL の `ksql.config.json` と同じ形）の profile だけ。`fml_users` は profile の `userApiToken`
- 評価（normalize / calc / 保存の検査）は Worker で、時間上限付き
