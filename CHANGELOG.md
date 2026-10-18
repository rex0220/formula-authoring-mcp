# 変更履歴

formula MCP（Claude Desktop の拡張機能「計算式 設定オーサリング（Formula）」と、Claude Code のプラグイン `formula`）の、利用者に見える変更です。新しい版が上です。

## 0.1.0（2026-10-18）

初めての版。中核は `@rex0220/formula-authoring-tools` 0.2.0（計算式プラグイン Ver.101 以降、authoring API 1）。

- Claude Code のプラグイン `formula`（marketplace `rex0220-formula`）と Claude Desktop の `.mcpb`
- ツール: `fml_docs`、`fml_status`、`fml_workspace_status`、`fml_save_settings`、`fml_update_fields`、`fml_summary`、`fml_normalize`、`fml_calc`、`fml_fields`、`fml_record`、`fml_users`、`fml_pull`、`fml_files`、`fml_take`、`fml_edit`、`fml_diff`（Desktop は `kintone_get_app`、`kintone_list_records` も）
- kintone の接続は接続のファイル（kSQL の `ksql.config.json` と同じ形）の profile だけ。`fml_users` は profile の `userApiToken`
- 評価（normalize / calc / 保存の検査）は Worker で、時間上限付き
