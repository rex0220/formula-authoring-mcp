// fml_docs の章（section）の一覧と、その元のファイル（build-mcp.mjs が読み、本体に埋め込む。print-craft MCP の実装案 5.5。計画 24.3）。
//   guide: このリポジトリの guide/（formula MCP のツールで書いた手順。テンプレートの docs/AI作業手順.md を元にした）
//   ref:   references/template/（テンプレートの docs/ と samples/ の写し。scripts/sync-references.mjs）
// 順番が目次の順。キーは英数字（AI が打ち間違えにくく、Desktop のツールの引数でも崩れない）
export const DOC_SECTIONS = [
  { key: "howto-new", title: "新しい設定を作る（手順。仕様の確認 → 式 → 保存 → calc）", guide: "howto-new.md" },
  { key: "howto-edit", title: "既存の設定を変える（pull / take → edit → 差し替え → calc → diff）", guide: "howto-edit.md" },
  { key: "requirements", title: "要件を AI が作る（利用者のやりたいことが短いとき）", guide: "requirements.md" },
  { key: "explain", title: "計算式の解説を頼まれたら", guide: "explain.md" },
  { key: "try", title: "式の試し計算（同梱のサンプルアプリ。関数の解説・使用例・式の断片を fml_try で確かめる）", guide: "try.md" },
  { key: "test-app", title: "テスト用アプリとテストデータ（kintone への書き込みの唯一の例外）", guide: "test-app.md" },
  { key: "results", title: "結果の読み方（status、normalize のエラー・警告・情報、断る場合）", guide: "results.md" },
  { key: "constraints", title: "計算式の制約（守らないと動かない・壊れる）と計算の順", guide: "constraints.md" },
  { key: "usable", title: "使えるもの（積極的に使ってよい関数・書き方）", guide: "usable.md" },
  { key: "connections", title: "kintone の接続とアプリのフォルダー（接続のファイル。profile、kintone/<profile>/<番号>-<アプリ名>/）", guide: "connections.md" },
  { key: "patterns", title: "計算パターン集（やりたいこと → 式の例 → 確かめること）", ref: "docs/計算パターン.md" },
  { key: "patterns-verified", title: "計算パターンの検証（同梱のサンプルアプリと架空の値で評価した結果。✔ の例の根拠。大きい。query にパターン名）", ref: "docs/計算パターン_検証.md" },
  { key: "spec", title: "設定ファイル仕様（封筒、共通の設定、項目の行、上限）", ref: "docs/設定ファイル仕様.md" },
  { key: "function-list", title: "関数一覧（大きい。query に関数名）", ref: "docs/関数一覧.md" },
  { key: "test-users", title: "既定のテストデータ（架空のユーザー・組織・グループ）", ref: "docs/既定のテストデータ.md" },
  { key: "sample-settings", title: "雛形: 封筒形式の設定（新しい設定はこれを写す。各種設定 pluginMiscInfo は写さない）", ref: "samples/settings-source.json" }
];
