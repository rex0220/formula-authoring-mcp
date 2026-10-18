// 束ねた formula MCP（dist/）を Claude Desktop の .mcpb にする（実装案 8.3。試作 0-3b / 0-4 と kSQL の build-mcpb.mjs を元にした。無圧縮の zip は scripts/zip.mjs）。
//   - manifest は package.json から（名前・版）。ツールの一覧は束ねた本体の tools/list と同じ（scripts/mcpb-verify.mjs が照合する）
//   - 設定項目: 作業フォルダー（directory、必須）、計算式プラグインの zip（file、必須）、kintone の接続のファイル（file、任意・強く勧める。kSQL の ksql.config.json と同じ形。実装案 15.4）
//   - 設定の値は引数でなく環境変数で渡す（mcp_config.env。試作 0-4 で、子のプロセスに届くことを確かめた）。トークンは接続のファイルに書く（設定項目に秘密の値は無い）
//   - 配布元・プライバシーポリシー（privacy_policies。kintone に接続するので要る。リリース手順 0-5）、束ねた依存の著作権表示（THIRD_PARTY_NOTICES.md。0-3）
//   - 入れてはいけないもの（scripts/forbidden-files.mjs。0-7）があれば作らない
// 使い方: node build-mcp.mjs && node build-mcpb.mjs  → dist-mcpb/formula.mcpb
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { problemsOf } from "./scripts/forbidden-files.mjs";
import { NOTICES_FILE } from "./scripts/third-party-notices.mjs";
import { createZip } from "./scripts/zip.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const outDir = join(root, "dist-mcpb");
export const outPath = join(outDir, "formula.mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 配布元（GitHub のリポジトリ） */
export const REPO_URL = "https://github.com/rex0220/formula-authoring-mcp";

/** Desktop の拡張機能の画面に出すツールの一覧（短い説明。AI に渡る説明は本体の tools/list） */
export const MANIFEST_TOOLS = [
  ["fml_docs", "計算式プラグインの設定づくりの手順と資料（最初に呼ぶ）"],
  ["fml_status", "環境の診断（作業フォルダー、計算式プラグインの zip）"],
  ["fml_workspace_status", "作業フォルダーの診断（kintone の接続とアプリのフォルダー）"],
  ["fml_save_settings", "新しい設定を検査して保存（上書きしない）"],
  ["fml_update_fields", "既存の設定の項目の行を差し替え"],
  ["fml_summary", "設定の要約と digest（項目の計算式）"],
  ["fml_normalize", "設定の検査（書き換えない）"],
  ["fml_calc", "レコードに設定を当てた模擬の計算（更新しない）"],
  ["fml_fields", "kintone の項目定義を取る"],
  ["fml_record", "kintone のレコードを取る（形だけ返す）"],
  ["fml_users", "User API からユーザー情報のテストデータを取る（件数だけ返す）"],
  ["fml_pull", "アプリの今の計算式プラグインの設定を取る"],
  ["fml_files", "作業フォルダーのファイルの一覧"],
  ["fml_take", "inbox のダウンロードをアプリのフォルダーへ"],
  ["fml_edit", "ダウンロードを -edit.json に写す"],
  ["fml_diff", "2 つの設定の差"],
  ["kintone_get_app", "kintone のアプリの情報"],
  ["kintone_list_records", "kintone のレコードの形を数件"]
];

export const manifest = {
  manifest_version: "0.3",
  name: "formula-authoring",
  display_name: "計算式 設定オーサリング（Formula）",
  version: pkg.version,
  description: "kintone の計算式プラグイン（rex0220 formula）の設定 JSON を、検査（normalize）と模擬の計算（calc）を通して作業フォルダーに保存・確認する。kintone には読み取り（GET）だけ",
  author: { name: "rex0220" },
  license: "MIT",
  homepage: REPO_URL,
  repository: { type: "git", url: REPO_URL },
  support: `${REPO_URL}/issues`,
  privacy_policies: [`${REPO_URL}/blob/main/PRIVACY.md`],
  server: {
    type: "node",
    entry_point: "server/index.cjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.cjs", "--surface", "desktop", "--workspace-dir", "${user_config.workspaceDir}"],
      env: {
        FORMULA_PLUGIN_ZIP: "${user_config.pluginZip}",
        FORMULA_KINTONE_CONFIG: "${user_config.kintoneConfig}"
      }
    }
  },
  tools: MANIFEST_TOOLS.map(([name, description]) => ({ name, description })),
  tools_generated: false,
  keywords: ["kintone", "formula", "計算式プラグイン", "mcp"],
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32"],
    runtimes: { node: ">=20.0.0" }
  },
  user_config: {
    workspaceDir: {
      type: "directory",
      title: "作業フォルダー",
      description: "計算式プラグインの設定・項目定義・レコードを置くフォルダー（無ければ最後の 1 段だけ作る）",
      required: true
    },
    pluginZip: {
      type: "file",
      title: "計算式プラグインの zip",
      description: "アプリに入れた計算式プラグイン（Ver.101 以降）の zip（配布元から入手したもの。同じ版）",
      required: true
    },
    kintoneConfig: {
      type: "file",
      title: "kintone の接続のファイル",
      description: "kSQL の ksql.config.json と同じ形のファイル（接続先と、アプリごとの閲覧だけの API トークン。作業フォルダーの外に置く。kSQL と同じファイルでもよい）。無ければ kintone を使うツールは使えない",
      required: false
    }
  }
};

const readme = `# 計算式 設定オーサリング（Formula）${pkg.version}

kintone の計算式プラグイン（rex0220 formula）の設定 JSON を、検査（normalize）と模擬の計算（calc）を通して作業フォルダーに保存・確認する Claude Desktop の拡張機能。
チャットで「計算式プラグインで〜」と頼む（最初に fml_docs が手順を返す）。kintone には読み取り（GET）だけ。秘密の値は応答・ログに出さない。
同梱の依存（MCP の SDK、zod、happy-dom など）の著作権表示とライセンスは THIRD_PARTY_NOTICES.md にある。
プライバシーポリシー、セキュリティ、変更履歴: ${REPO_URL}
`;

function files() {
  return [
    { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    { path: "server/index.cjs", data: readFileSync(join(dist, "server", "index.cjs")) },
    { path: "server/formula-mcp.cjs", data: readFileSync(join(dist, "server", "formula-mcp.cjs")) },
    { path: "server/eval-worker.mjs", data: readFileSync(join(dist, "server", "eval-worker.mjs")) },
    { path: "vendor/moment-with-locales.min.js", data: readFileSync(join(dist, "vendor", "moment-with-locales.min.js")) },
    { path: "vendor/moment.json", data: readFileSync(join(dist, "vendor", "moment.json")) },
    { path: "LICENSE", data: readFileSync(join(root, "LICENSE")) },
    { path: NOTICES_FILE, data: readFileSync(join(dist, NOTICES_FILE)) },
    { path: "README.md", data: Buffer.from(readme, "utf8") }
  ];
}

function isIgnored() {
  const p = join(root, ".gitignore");
  return existsSync(p) && readFileSync(p, "utf8").split(/\r?\n/).some((l) => ["dist-mcpb/", "*.mcpb"].includes(l.trim()));
}

// ---- 実行 ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-mcpb/ と *.mcpb が無い（成果物をコミットしない）");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entries = files();
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  const zip = createZip(entries);
  writeFileSync(outPath, zip);
  console.log(`[build-mcpb] ${outPath} (${zip.length.toLocaleString()} bytes; 版 ${pkg.version})`);
}
