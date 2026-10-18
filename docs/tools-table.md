# ツールの表（formula MCP）

計画 24.2 の一覧を、ツールごとの約束にした表。print-craft MCP の `docs/tools-table.md` と同じ形。

- **種類**: ① 作業フォルダーを使う（`workspaceId` を持つ。照合と互換表の判定を通す）、② 作業フォルダーを使わない（`workspaceId` を持たない）、③ 作業フォルダーの診断（`workspaceId` を持ち照合は通す。互換表の判定はしない）
- **出す画面**: 起動の引数 `--surface claude-code | desktop` で決める（プラグインの `.mcp.json` と `.mcpb` の manifest に固定で書く）
- 入力は全ツール `additionalProperties: false`。パスはすべて作業フォルダーからの相対で、区切りは `/`（`..`・絶対パス・ドライブ名・`~`・`\`・NUL は denied、`./`・末尾の `/`・`//` は invalid）
- 応答は全ツール共通の形（`ok / invalid / incompatible / conflict / denied / failed`、`findings`、`digest`）。`fml_docs` だけ文章
- 読み取りだけのツールには `annotations: { readOnlyHint: true, openWorldHint: false }`

| ツール | 種類 | Claude Code | Desktop | 読み取りだけ | 入力 | 返すもの | 書く先 | CLI 相当 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fml_docs` | ② | 出す | 出す | ○ | `{ section?, query? }` | 目次 / 章 / 合う節 | — | （資料） |
| `fml_status` | ② | 出す | 出す | ○ | `{}` | 版、互換表、作業フォルダー、計算式プラグインの zip（読めるか、版、authoring API の版）、`capabilities`（authoring / kintone） | — | `version` |
| `fml_workspace_status` | ③ | 出す | 出す | ○ | `{ workspaceId }` | 動く形、接続のファイル（profile ごと。秘密の値は返さない）、アプリのフォルダーの印、zip | — | `version` |
| `fml_save_settings` | ① | 出す | 出す | — | `{ workspaceId, path, content, fields?, expectedAbsent: true, profile?, users? }` | `findings`、`summary`、`digest`、`contextBaseUrl` | `settings/`、`temp/`、`kintone/<profile>/<アプリ>/`（新しい設定） | `normalize --out` |
| `fml_update_fields` | ① | 出す | 出す | — | `{ workspaceId, path, expectedDigest, rows, common?, fields?, profile?, users? }` | `findings`、`summary`、`diff`、`digest` | 同上（`-edit.json` と新しい設定。ダウンロード / pull は不可） | `normalize --out`（写しを直す） |
| `fml_summary` | ① | 出す | 出す | ○ | `{ workspaceId, path, field? }` | 要約（ランク順）、封筒、`fieldcodes`、`digest` | — | `summary` |
| `fml_normalize` | ① | 出す | 出す | ○ | `{ workspaceId, path, fields?, check?, profile?, users?, timeoutSec? }` | `findings`、`summary`、`size`、`checkDiffs` | — | `normalize` / `--check` |
| `fml_calc` | ① | 出す | 出す | ○（模擬） | `{ workspaceId, path, records（1〜10）, app?, fields?, profile?, users?, user?, event?, action?, status?, nextStatus?, mobile?, all?, timeoutSec? }` | レコードごとの項目の前後の値（変わった項目と印のある項目。300 行 / 64 KiB で打ち切り）、エラー、`contextLine`、`notice`、`note` | — | `calc` |
| `fml_fields` | ① | 出す | 出す | — | `{ workspaceId, app, profile?, preview?, lang? }` | 要約（1 項目 1 行。○ = 計算式を設定できる型）、一覧の数、ルックアップ先の数 | `kintone/<profile>/<アプリ>/fields.json`（フォルダーが無ければ印を置いて作る） | `fields` + `--summary` |
| `fml_record` | ① | 出す | 出す | — | `{ workspaceId, app, id, profile?, fieldsFrom? }` | 形の要約だけ（値は返さない） | `kintone/<profile>/<アプリ>/records/<番号>.json`（0o600。フォルダーが無ければ「先に `fml_fields`」） | `record` + `--summary` |
| `fml_users` | ① | 出す | 出す | — | `{ workspaceId, profile?, onlyReferenced?, maxCalls?, file? }` | 件数（ユーザー / 組織 / グループ）、呼び出し数、要約（人数だけ） | `users/<ホスト>.json`（0o600） | `users --pull` / `--summary` |
| `fml_pull` | ① | 出す | 出す（運用環境だけ） | — | `{ workspaceId, app, profile?, preview? }` | 要約、`digest` | `kintone/<profile>/<アプリ>/rex0220-formula-app<番号>-<日時>.json`（新しいファイルとしてだけ） | `pull` |
| `fml_files` | ① | 出す | 出す | ○ | `{ workspaceId, app?, profile? }` | 名前だけ（アプリのフォルダー / profile ごとのフォルダーと印 / `settings/` などの JSON / `inbox/` の件数） | — | `files` |
| `fml_take` | ① | 出す | 出す | — | `{ workspaceId, profile? }` | 移したファイルと理由 | `inbox/` → `kintone/<profile>/<アプリ>/` | `take` |
| `fml_edit` | ① | 出す | 出す | — | `{ workspaceId, path? \| app?, profile? }` | 写した `-edit.json` | `kintone/<profile>/<アプリ>/*-edit.json` | `edit` |
| `fml_diff` | ① | 出す | 出す | ○ | `{ workspaceId, before, after }` | 項目ごとの差（★ = 既存レコードの値に影響）、共通の設定の差 | — | `diff` |
| `kintone_get_app` | ① | **出さない** | 出す | ○ | `{ workspaceId, app（番号か URL）, profile? }` | `appId`、`name`、`code`、`spaceId`、`threadId` | — | （新規） |
| `kintone_list_records` | ① | **出さない** | 出す | ○ | `{ workspaceId, app, query?, profile? }` | 5 件の形だけ | — | （新規） |

## 担当の分け方

| 処理 | Claude Code | Desktop |
| --- | --- | --- |
| アプリを探す・レコードを選ぶ（値を見る） | 公式の kintone MCP | `kintone_get_app` / `kintone_list_records`（形だけ） |
| テスト用アプリとテストデータ（書き込み） | 公式の kintone MCP（利用者が明示したときだけ。テンプレートの CLAUDE.md） | できない（利用者が作る） |
| 項目・レコード・設定の保存と要約、検査・保存・模擬の計算 | formula MCP | formula MCP |
| 設定の反映、既存レコードの再計算 | 利用者（設定画面） | 利用者（設定画面） |
