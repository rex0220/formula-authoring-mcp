# kintone の接続とアプリのフォルダー（接続のファイル）

formula MCP の kintone の接続は、利用者が設定した**接続のファイル**（kSQL の `ksql.config.json` と同じ形。作業フォルダーの外）の profile だけ。状態は `fml_status`（読めるか）と `fml_workspace_status`（profile ごとの接続先・認証の種類・アプリごとのトークンが使えるか、アプリのフォルダーの印の状態）で確かめる。

- 接続のファイルと、そこが名前を書いた環境変数（`env:` の参照先）は利用者のもの（秘密の値を含む）。**AI は読まない・書かない・表示しない**。足りない profile・トークンは利用者に足してもらう
- ツールの `profile`（省略は接続のファイルの `defaultProfile`、無ければ `dev`）と `app`（番号）。ゲストスペースは profile の `guestSpaceId` で決まる（1 つの profile は 1 つのスペース）
- アプリのフォルダー `kintone/<profile>/<番号>-<アプリ名>/`: `fields.json`（`fml_fields`）、`records/<番号>.json`（`fml_record`。レコードの値を含む）、設定のダウンロード / pull（`rex0220-formula-app<番号>-<日時>.json`。名前はそのまま。一番新しいものが今の設定）、直したもの（`…-edit.json`。`fml_edit`）、新しい設定（その他の `*.json`。`fml_save_settings`）、印（`.formula-app.json`。ツールが作る。消さない・書かない）
- フォルダーは `fml_fields`、`fml_pull`、`fml_take` が作る（印の無い・別の接続のフォルダーは使わない。`fml_workspace_status` の next に出る。利用者が名前を変えて退け、作り直す）
- 利用者が `inbox/` に置いたダウンロードは `fml_take` でアプリのフォルダーへ移す。中身は `fml_files`（app）と `fml_summary` で見る
- **ダウンロード / pull のファイルは書き換えない**。直すときは `fml_edit` で `-edit.json` に写し、`fml_update_fields` で直す。差分は `fml_diff`
- アプリのフォルダーの中のファイルなら、`fml_normalize` / `fml_calc` / `fml_save_settings` / `fml_update_fields` の `fields` は要らない（同じフォルダーの `fields.json`）。`fml_calc` の `records` は同じフォルダーの `records/<番号>.json`
- 新しい設定は、アプリのフォルダーに `APP<番号>-<アプリ名>.json` のような名前で保存する（`settings/` でなく。封筒の `appId` はそのフォルダーのアプリ）
- `fml_users` は profile の `userApiToken`（cybozu.com 共通の API トークン）か ログイン名とパスワード。出力は `users/<ホスト名>.json`（個人情報。Read で開かない。AI は件数だけを見る）
- 本番のアプリも同じに扱う（読み取りだけにする守りは無い。formula MCP が kintone に送るのは GET だけ）。本番へは、利用者が開発で確かめた同じファイルを本番の設定画面でアップロードする（「項目の置換」で変えた項目だけ。アプリが違うという注意は出るが取り込める。項目が合わなければ保存のときに止まる）。**一覧 ID はアプリごとに違う**ので、一覧別設定は本番の設定画面で選び直すよう、反映方法を伝えるときに添える
- 接続のファイルが無いとき（mode が not-configured）: kintone を使うツールと `kintone/` は使えない。`settings/` と `fields/`（利用者が置いた項目定義）での保存・検査・計算は動く。`environments.json` が残っていて止まるときは、利用者に接続のファイルへの移行を頼む（AI は書かない）
