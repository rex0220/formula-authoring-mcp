# formula-authoring-mcp

kintone の計算式プラグイン（rex0220 formula。Ver.101 以降）の設定 JSON を、検査（normalize）と模擬の計算（calc）を通して作業フォルダーに保存・確認する **formula MCP**（0.4.0 から、項目検証プラグイン（rex0220 field validation）Ver.72 以降の設定も `fv_*` のツールで。式は計算式プラグインの zip（Ver.102 以降）で評価する）（Claude Code のプラグイン `formula` と Claude Desktop の `.mcpb`）。中核は npm の [`@rex0220/formula-authoring-tools/core`](https://www.npmjs.com/package/@rex0220/formula-authoring-tools)（テンプレート [formula-authoring](https://github.com/rex0220/formula-authoring) の tools と同じもの）。設計は formula の `doc/internal/オーサリングツール_実装計画.md` 24 章（非公開）と、[print-craft MCP の実装案](https://github.com/rex0220/print-craft-authoring-mcp/blob/main/docs/プラグイン化の実装案.md)（同じ契約。4 章 作業フォルダーの結び付け、5 章 ツールと入出力、7 章 互換表、15 章 接続のファイル）。

最新の版は [リリース](https://github.com/rex0220/formula-authoring-mcp/releases/latest)。

## 入れ方

- **Claude Desktop**: [リリース](https://github.com/rex0220/formula-authoring-mcp/releases/latest) から `formula-authoring-<版>.mcpb` をダウンロードしてダブルクリック。設定で、作業フォルダー、計算式プラグインの zip、kintone の接続のファイルを選ぶ（下の「設定項目」と「kintone の接続のファイル」）
- **Claude Code**（ターミナルの `claude`。Node.js 20 以降。サポートが続いている系列（22 以降）の最新の修正版を勧める。[SECURITY.md](SECURITY.md)）: `/plugin install formula --marketplace rex0220/formula-authoring-mcp`（Claude Code 2.1.275 以降。それより前は `/plugin marketplace add rex0220/formula-authoring-mcp` → `/plugin install formula@rex0220-formula`）。そのあと `/config` で、計算式プラグインの zip と kintone の接続のファイル。作業フォルダーは [formula-authoring](https://github.com/rex0220/formula-authoring) のテンプレートから作ったフォルダーが向く（`docs/` の資料と `.claude/settings.json` の守りがそろう。無くても動く）
- 計算式プラグインの zip は、アプリに入れたものと同じ版（Ver.101 以降）の、配布元から入手したものを使う。kintone の API トークンは、アプリごとのレコード閲覧だけのものを使う
- 使い方: チャットで「計算式プラグインで、アプリ 4328 の旅費明細を分類ごとに集計したい」のように頼む。AI は最初に `fml_docs` で手順を読み、項目定義（`fml_fields`）→ 代表のレコード（`fml_record`）→ 仕様の確認 → 設定の保存（`fml_save_settings`）→ 模擬の計算（`fml_calc`）→ 反映方法（設定画面でアップロード）の順に進める。kintone には読み取り（GET）だけで、**設定の反映と既存レコードの再計算は利用者が設定画面で行う**

利用者向け: [PRIVACY.md](PRIVACY.md)（プライバシーポリシー）、[SECURITY.md](SECURITY.md)（脆弱性の報告と、受け入れた危険）、[CHANGELOG.md](CHANGELOG.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（同梱の依存のライセンス）。

## ツール

| ツール | 中身 |
| --- | --- |
| `fml_docs` | 手順と資料（最初に呼ぶ。引数なしで目次、`section` で章、`query` で関数名などから探す） |
| `fml_status` / `fml_workspace_status` | 環境の診断（版、計算式プラグインの zip、接続のファイル）と作業フォルダーの診断（profile、アプリのフォルダーの印） |
| `fml_save_settings` | 新しい設定（封筒形式）を検査して保存（上書きしない） |
| `fml_update_fields` | 既存の設定の項目の行（`fieldcode`）を複数まとめて差し替え、共通の設定をキーごとに置き換える（`fml_summary` の digest を照合） |
| `fml_summary` | 設定の要約（項目の一覧、ランク順 = 計算順）と digest。`field` で 1 項目の計算式の全文 |
| `fml_normalize` | 検査だけ（書かない）。`check` で入力と出力の差 |
| `fml_calc` | 取ったレコードに設定を当てた模擬の計算（項目ごとの前後の値。1 回 10 件まで。評価は Worker で時間上限付き。kintone は更新しない） |
| `fml_try` | 同梱のサンプルアプリ（架空。全項目タイプ × 2、テーブル 2 つ、レコード 3 件）で式を試す（関数の解説・使用例・式の断片を実際の計算式エンジンで確かめる。利用者のアプリ・レコード・kintone は使わない）。`fields` で項目を足す、`data` で架空の値のレコード、`app` で利用者のアプリの項目定義（`fml_fields` で取ったもの）に架空の値 |
| `fml_fields` / `fml_record` / `fml_users` / `fml_pull` | kintone から項目定義・レコード（形だけ返す）・ユーザー情報のテストデータ（件数だけ返す）・アプリの今の設定を取る（GET だけ） |
| `fml_files` / `fml_take` / `fml_edit` / `fml_diff` | 作業フォルダーの一覧、`inbox/` のダウンロードをアプリのフォルダーへ、ダウンロードを `-edit.json` に写す（項目検証は `plugin: "field-validation"`）、2 つの設定の差 |
| `fv_save_settings` / `fv_update_rows` | 項目検証の新しい設定を検査して保存（上書きしない）/ 既存の設定の行（`fieldcode`）を差し替え・追加し、共通の設定をキーごとに置き換える（`fv_summary` の digest を照合） |
| `fv_summary` / `fv_normalize` / `fv_diff` | 項目検証の設定の要約と digest（`field` で 1 行の式の全文）/ 検査だけ（`check` で入力と出力の差）/ 2 つの設定の差 |
| `fv_check` | 取ったレコードに項目検証の設定を当てた判定の模擬（イベントごとの非表示・入力不可・必須・誤りの文・保存の前に入れる値。1 回 10 件・6 イベントまで。kintone は更新しない） |
| `fv_pull` | アプリの今の項目検証の設定を取る（GET だけ。ダウンロードと同じ名前） |
| `kintone_get_app` / `kintone_list_records` | Desktop だけ（Claude Code では公式の kintone MCP）。アプリの情報とレコードの形を数件 |

入出力の約束は print-craft MCP と同じ（`additionalProperties: false`、応答は `ok / invalid / incompatible / conflict / denied / failed` と `findings`）。詳しくは [docs/tools-table.md](docs/tools-table.md)。

## 設定項目

| | Desktop（拡張機能の設定） | Claude Code（`/config` の formula） |
| --- | --- | --- |
| 作業フォルダー | 「作業フォルダー」（必須。選ぶ画面で） | 「計算式プラグインの作業フォルダー」（初めて使うときに確認の画面から足す） |
| 計算式プラグインの zip | 「計算式プラグインの zip」（必須。アプリに入れたものと同じ版） | 「計算式プラグインの zip」（絶対パス。空なら作業フォルダーの `.env` の `FORMULA_PLUGIN_ZIP`） |
| kintone の接続 | 「kintone の接続のファイル」（任意・強く勧める） | 「計算式プラグインの接続のファイル（kintone）」（絶対パス。kSQL の ksql.config.json の形。`.env` ではない。任意・強く勧める） |

kintone の URL・API トークン・ログイン名・パスワードの設定項目はない（接続のファイルに書く）。接続のファイルが無くても、`settings/` などでの保存・検査・計算は動く（kintone から取るツールだけが使えない）。設定を変えたら Claude Code は `/mcp` で formula を再接続、Desktop は終了して起動し直す。

## kintone の接続のファイル

kSQL の `ksql.config.json` と同じ形のファイル。**kSQL のファイルをそのまま指しても、別のファイルでもよい**。formula が読むのは `defaultProfile` と、`profiles` の各 profile の `baseUrl`、`guestSpaceId`、`auth`（`token` / `userpass` / `auto`）、`username`、`password`、`passwordEnv`、`tokenMap`、`userApiToken`（`fml_users` の User API に使う cybozu.com 共通の API トークン。`env:<環境変数>` か値。formula だけが読むキー）だけ（ほかのキーは読まずに通す）。

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": { "baseUrl": "https://dev-example.cybozu.com", "tokenMap": { "APP101": "env:FORMULA_TOKEN_APP101", "APP102": "<閲覧だけの API トークン>" }, "userApiToken": "env:FORMULA_USER_API_TOKEN" },
    "prod": { "baseUrl": "https://example.cybozu.com", "tokenMap": { "APP4328": "env:FORMULA_TOKEN_APP4328" } },
    "guest15": { "baseUrl": "https://example.cybozu.com", "guestSpaceId": 15, "tokenMap": { "APP300": "env:FORMULA_TOKEN_APP300" } }
  }
}
```

- **作業フォルダーの外に置く**（作業フォルダーの中・中を指す symlink は使わない）。トークンかパスワードを直接書くなら `chmod 600`
- **アプリごとの閲覧だけの API トークンを強く勧める**。kSQL で書き込みにも使うトークンを formula と共有しない（下の「受け入れた危険」）
- profile の選び方: ツールの `profile`、無ければ `defaultProfile`、無ければ `dev`（kSQL と同じ）。ゲストスペースは profile の `guestSpaceId`（1 つの profile は 1 つのスペース。通常のスペースとゲストスペースの同じ番号のアプリは profile を分ける）
- アプリのフォルダーは作業フォルダーの `kintone/<profile>/<アプリ ID>-<アプリ名>/`（アプリ名は kintone から取る）。中の印 `.formula-app.json`（profile、接続先、ゲストスペース、アプリ ID）が今の接続と合わないフォルダーは使わない。profile の接続先を変えたら、古いフォルダーの名前を変えて退け、`fml_fields` か `fml_pull` で作り直す
- 本番のアプリも同じに扱う（読み取りだけにする守りは無い）。formula が kintone に送るのは GET だけ
- 状態は `fml_workspace_status`（profile ごとの接続先、認証の種類、アプリごとのトークンが使えるか。秘密の値と環境変数の名前は返さない）
- kSQL との違い（formula の方が厳しい）は print-craft MCP の README の表と同じ（環境変数の上書きを読まない、`env:` は対象のアプリだけ、`APP001` のような 0 詰めは誤り、形を検査して誤りの profile は使わない、接続のファイルが無ければ kintone を使うツールは使えない）

**受け入れた危険**: 作業フォルダーの外に置くのは誤操作の防止で、Claude Code の AI からの秘密の隔離ではない。Claude Code の AI は Read / Bash で接続のファイルも環境変数（`env:` の参照先）も読める（作業フォルダーの外を読むときは許可の確認が出る。許可の確認を外した使い方では出ない）。読まれたトークンは formula の外でも使えるので、書き込みもできるトークンは書き込みに使われうる。だから閲覧だけのトークンを使う。Desktop で formula MCP だけを有効にしていれば、formula MCP を通して接続のファイルや環境変数を読む手段は無い（ほかのファイル・shell の MCP を同じ Desktop で有効にしていれば、Claude Code と同じ危険がある）。

**環境変数（`env:`、`passwordEnv`、`userApiToken` の `env:`）**: formula MCP の環境変数は起動のときに決まる。変えたら Claude Code は `/mcp` で再接続、Desktop は起動し直す（接続のファイルの書き換えは再接続なしで効く）。Desktop から起動する formula MCP には、シェルの設定（`~/.zshrc` など）の環境変数は届かない。Desktop ではトークンを接続のファイルに直接書く（`chmod 600`）のが確実。

## 構成

| 場所 | 中身 |
| --- | --- |
| `src/` | formula MCP（MCP の SDK v2）。`server.ts`（ツールの登録）、`binding.ts`（作業フォルダーの結び付け）、`compat.ts`（互換表）、`docs.ts`（資料）、`paths.ts`（束ねた本体の隣の Worker と vendor/）、`tools/`（ツール。`eval.ts` が評価の Worker の仕事を組む） |
| `guide/` | `fml_docs` の手順の章（テンプレートの `docs/AI作業手順.md` を formula MCP のツールで書き直したもの） |
| `references/template/` | テンプレートの `docs/` と `samples/` の写し（`scripts/sync-references.mjs`。元のコミットと sha256 は `SOURCE.json`） |
| `compat.json` | 互換表（MCP の版、中核の版の範囲、中核の API の版、資料の元、authoring API の版、計算式プラグインの版の下限） |
| `build-mcp.mjs` | 1 つの CJS ファイルに束ねる → `dist/server/formula-mcp.cjs`。評価の Worker を ESM で束ねる → `dist/server/eval-worker.mjs`。束ねた依存の著作権表示 `THIRD_PARTY_NOTICES.md` も作る |
| `build-mcpb.mjs` / `scripts/mcpb-verify.mjs` | `.mcpb` を作る → `dist-mcpb/formula.mcpb` / 検査 |
| `scripts/build-plugin-zip.mjs` / `scripts/plugin-zip-verify.mjs` / `scripts/write-marketplace.mjs` | Claude Code のプラグインの zip を作る → `dist-plugin/formula-plugin-<版>.zip` / 検査 / リリースのときに `.claude-plugin/marketplace.json` を書く |
| `scripts/forbidden-files.mjs`、`scripts/zip.mjs` | 入れてはいけないもの（認証情報、レコードの値、ユーザー情報の実データ、実案件の設定、本物の kintone のホスト名）の検査 / 無圧縮の zip |
| `.claude-plugin/plugin.json`、`.mcp.json`、`hooks/` | Claude Code のプラグイン `formula`（フックは作業フォルダーの登録と、`settings/**/*.json`・`kintone/**`・`users/**` への直接の Write / Edit の拒否） |
| `test/` | 試験（束ねた本体を MCP のクライアントで起動する。kintone は `test/mock-fetch.mjs` の偽物。fixture はテスト用アプリ 2305 の項目定義・設定と合成のレコード） |

## 作り方と試験

リリース（`.mcpb`、Claude Code のプラグイン）の手順は [docs/リリース手順.md](docs/リリース手順.md)。

隣に `formula`（計算式プラグインの zip `dist/formula-plugin101.zip`。試験だけ。`FORMULA_TEST_PLUGIN_ZIP` で別の場所を指せる）があること。

中核は npm の `@rex0220/formula-authoring-tools` 0.6.0（lockfile で固定。`compat.json` の `coreVersion` は `>=0.6.0 <0.7.0`、`coreApiVersion` は 2）。公開前の中核で試すときは、隣の formula-authoring の `tools` で `npm pack` した tarball を `npm install --no-save <tgz>` で入れる（`package.json` と lockfile は変えない）。

```sh
npm ci
npm run check            # tsc
npm test                 # ビルド → 試験
npm run verify:mcpb      # ビルド → .mcpb → 検査
npm run verify:plugin    # ビルド → プラグインの zip → 検査（claude があれば plugin validate も）
npm run notices          # 依存を変えたとき: THIRD_PARTY_NOTICES.md を作り直す（差分を見てコミット）
node scripts/forbidden-files.mjs [--history]   # 入れてはいけないもの（--history は履歴のすべてのコミット）
claude plugin validate . && claude plugin test .   # プラグインの形とフックの試験
node scripts/sync-references.mjs   # テンプレートの資料を写し直す（compat.json の docsRevision も合わせる）
```

## 手で確かめること

リリースの候補で、Claude Code（`claude --plugin-dir .` か marketplace）と Desktop（`.mcpb`）の両方で: `fml_status` が `ready`、テスト用アプリの `fml_fields` → `fml_record` → `fml_save_settings` → `fml_calc` の流れ、`fml_try`（関数の使用例をサンプルアプリで確かめる。`describe: true`）、既存の設定の `fml_pull` → `fml_edit` → `fml_summary` → `fml_update_fields` → `fml_diff`、保存した設定が設定画面で取り込めること、`fml_calc` の値が「既存レコードを変更」の結果と一致すること、ログ（Desktop の `main.log`、Claude Code の標準エラー）に秘密の値とレコードの値が無いこと。結果は計画の 24 章（7-7）に書く。
