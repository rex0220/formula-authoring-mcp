# 結果の読み方

## 応答の形（全ツール共通）

- 成功: `{ "ok": true, "status": "ok", "findings": [...], "result": {...}, "digest": "..." }`
- 失敗: `{ "ok": false, "status": "invalid" | "incompatible" | "conflict" | "denied" | "failed", "error": { "code", "message" }, "findings": [...] }`

| status | 意味 | すること |
| --- | --- | --- |
| `invalid` | 呼び出しの引数・利用者の入力の誤り。normalize のエラー（`NormalizeError`。findings にエラー）を含む | findings の規則名（下の表）で直して、もう一度ツールを呼ぶ |
| `incompatible` | formula MCP と中核・資料・計算式プラグインの zip の版が合わない | 利用者に formula MCP の更新か、zip の版（アプリに入れたものと同じ。Ver.101 以降）の確認を頼む |
| `conflict` | 同じ名前のファイルがある、digest が違う（読んだ後に変わった）、別の保存が進行中、アプリのフォルダーの印が今の接続と合わない、呼び出しの途中で接続が変わった | `fml_summary` で読み直してやり直す。印・接続は利用者が直す |
| `denied` | 作業フォルダーの外、未登録の作業フォルダー、書けない場所、ダウンロード / pull のファイル、接続のファイルに無い profile のフォルダー、接続のファイルが無いときの kintone/ | 回り道をしない（ほかのツールでファイルを消す・書き換えない）。利用者に伝える |
| `failed` | 計算式プラグインの zip が無い・読めない、接続のファイルの誤り、kintone の通信の失敗、評価の時間切れ、想定外の失敗 | `fml_status` / `fml_workspace_status` で状態を確かめ、利用者に伝える |

`findings` の `level` は `error` / `warning` / `info`。**警告は保存を止めないが、消さずに利用者に伝える**。`truncated` は返す量の上限で打ち切ったことを示す。`fml_calc` / `fml_try` の値は 1 つ 16,000 字まで。長いテーブルは行の切れ目で切り、省いた行の数を `afterRowsOmitted` / `beforeRowsOmitted`（`fml_calc` の項目の前後）、`valueRowsOmitted`（`fml_try` の値）に返す（返った行は JSON の配列のまま読める）。テーブル以外の長い値は先頭を残して「…（N 文字を切った）」。**省いた行があることを利用者に伝え、確かめた行（先頭の何行）を書く**

## normalize の結果（規則名は findings の `rule`）

エラーが 1 つでもあると保存・計算をしない。

| エラー | 意味と直し方 |
| --- | --- |
| `schema.json` / `schema.rows` / `schema.unknown-key` | JSON として読めない、`pluginInfos` の形が違う、知らないキー（設定画面は黙って捨てるので書き間違いを見逃さないためにエラー）。spec の章で確かめる |
| `envelope.plugin` / `envelope.version` / `envelope.app` | 封筒の誤り。`pluginID` は `"rex0220 formula plugin"`。`PluginVersion` が zip より新しい。`appId` が正の整数でない、または項目定義のアプリと違う |
| `field.missing` | 今のアプリに無い項目（ラベルで書いた、綴りの違い、別アプリの項目、削除された項目） |
| `field.type` / `field.flag` | その型には計算式を置けない / HEADER・SPACER・GROUP に編集、HEADER・SPACER に非表示 |
| `rank.range` | ランクが整数（-10000〜10000）か `""` でない |
| `formula.syntax` / `formula.unknown-function` / `formula.ref` | 評価できない（エンジンの文言を読む）/ 無い関数（function-list で名前を確かめる）/ 今のアプリに無い項目を参照 |
| `formula.circular` | 自己参照か 2 項目の相互参照（各種設定 `circular_refer` が OFF のとき） |
| `formula.side-effect` | policy で承認していない副作用のある関数（テンプレートの既定は BUTTON / DIALOG / FSET / FSET_TADD を承認。CLIPBORD_WRITE は未承認）。formula MCP は評価しない。要るなら利用者に policy の `allowFunctions` を頼む（AI は書かない） |
| `event.set` | EV_SET（テスト用）が設定に残っている |
| `userinfo.off` | 各種設定「ユーザー情報」が OFF なのに UINFO 系を使う |
| `views.missing` | 一覧別設定に今のアプリに無い一覧 ID |
| `schema.saved` / `size.limit` | 保存値がスキーマに合わない / 大きすぎる（256 KB） |

| 警告（消さずに利用者に伝える） | 意味 |
| --- | --- |
| `misc.changed` / `authority.limited` / `plugin.disabled` / `tool.disabled` | 各種設定が既定と違う（利用者が決めること）/ 権限が全員でない / プラグイン無効 / 計算式ツール無効 |
| `field.lookup` / `field.subtable` / `field.disabled` | ルックアップ項目に計算式（値を上書きする）/ テーブル自身の計算式は行数の制御 / 計算式があるが無効 |
| `formula.context` | kintone の文脈が要る関数（LOGIN_* / LOOKUP_GETID / APP_URL …）。calc はダミー層の値 |
| `formula.volatile` | RAND / NOW / TODAY / UUID など再計算のたびに値が変わる。既存レコードを変更で毎回変わる。固定するなら `NVL(項目, UUID())` |
| `formula.aggregate` | テーブル内の項目でテーブルの集計関数（行ごとに全体を集計する。小計の行などで意図したものか） |
| `event.fcode` | `EV_INFO("fcode")` は値変更イベントでしか入らない |
| `userinfo.unknown` | 使うテストデータに無いユーザー・組織・グループのコードらしき文字列（実データで確かめるなら、利用者に頼んで `fml_users`（onlyReferenced）で取る） |

`info`（Ver.100 の設定、捨てるキー、内部番号は設定画面が補う、保存値の大きさ、イベントで結果が変わる項目、ユーザー情報を使う項目、項目でない識別子、3 項目以上の循環）は要るときだけ伝える。

## fml_calc の結果

- `records[].lines` は項目ごとの `before` → `after`（既定は変わった項目と印のある項目だけ）。`marks` の印: 副作用のある関数、イベントで変わる、再計算のたびに変わる、ユーザー情報・kintone の文脈に依る
- `records[].errors` は式の評価の失敗（項目、段、文）。`failed: true` は実行時の sink が呼ばれた（走査の漏れ。結果を採らない）。どちらも findings に `calc.failed`
- `contextLine` は計算の文脈（アプリ、ログインユーザー、mobile、イベント、ユーザー情報の出所）。`notice` はユーザー情報が架空（既定のテストデータ）であることなど
- `records[].click`（`click` を付けたとき）はボタンのクリックの模擬: `display` = 押す前の表示（`TYPE` / `TITLE` / `HTML` / `ICON` / `SCAN` …）、`changes` = 押した後に変わる項目（`fieldcode` / `before` / `after`。計算式の無い項目も。`changesOmitted` は打ち切り）、`errors`（`phases` の `display` = 返り値がボタンでない、`click` = クリック時の式の失敗 = 実機はレコードを変えない）、`failed`（sink）。findings に `calc.click`。見た目・ダイアログの表示・change イベントは模擬しない（最後は利用者が実機で押す。try の章）
- **既存のレコードは変わっていない（模擬）**。反映は設定画面で。設定を作った・変えたときは利用者に必ず伝える（説明だけの答えには付けない）。「既存レコードを変更」「一括計算」を勧めるのは、値を計算する項目を変えたとき（`fml_update_fields` / `fml_diff` の差分の ★）だけ。ボタン・表示だけの変更なら「値は変わらないので要らない」と伝える
