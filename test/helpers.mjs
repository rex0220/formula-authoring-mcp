// 試験の共通: 束ねた formula MCP（dist/server/index.cjs）を MCP のクライアント（SDK v2）で起動して話す（print-craft MCP の test/helpers.mjs を元にした）。
// 計算式プラグインの zip は環境変数 FORMULA_TEST_PLUGIN_ZIP か、隣の formula の dist の formula-plugin<版>.zip で版が 101 以上の一番新しいもの（tools の devPluginZip と同じ。無ければ試験を飛ばす）。
// 試験は zip の版（PLUGIN_VERSION）と比べ、版を書き込まない（zip を新しい版にしても通るように。2026-10-24 Takashi「OK」）。
// kintone の接続のファイル（kSQL の ksql.config.json の形）は作業フォルダーの外の一時フォルダーに置く（makeConn）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readPluginZip } from "@rex0220/formula-authoring-tools/core";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const SERVER = path.join(ROOT, "dist", "server", "index.cjs");
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
function newestPluginZip() {
  const dist = path.resolve(ROOT, "../formula/dist");
  if (!existsSync(dist)) return null;
  const zips = readdirSync(dist).filter((f) => /^formula-plugin(\d+)\.zip$/.test(f) && Number(f.match(/\d+/)[0]) >= 101).sort();
  return zips.length ? path.join(dist, zips[zips.length - 1]) : null;
}
export const ZIP = process.env.FORMULA_TEST_PLUGIN_ZIP ?? newestPluginZip() ?? path.resolve(ROOT, "../formula/dist/formula-plugin101.zip");
export const SKIP = !existsSync(ZIP) && `計算式プラグインの zip が無い: ${ZIP}（FORMULA_TEST_PLUGIN_ZIP で指定できる）`;
/** 試験に使う zip の manifest の版（"101"、"102" …） */
export const PLUGIN_VERSION = existsSync(ZIP) ? readPluginZip(ZIP).pluginVersion : "";
export const SECRET = "TEST-not-a-real-token-0123456789";
/** テスト用アプリ 2305（テーブル内集計）の項目定義（fields の出力の形）、設定のダウンロード（Ver.100 の封筒）、合成のレコード 7 */
export const FIELDS_TEXT = readFileSync(path.join(here, "fixtures", "fields-2305.json"), "utf8");
export const SETTINGS_TEXT = readFileSync(path.join(here, "fixtures", "settings-2305.json"), "utf8");
export const RECORD_TEXT = readFileSync(path.join(here, "fixtures", "record-2305-7.json"), "utf8");
export const settings = (overrides = {}) => JSON.stringify({ ...JSON.parse(SETTINGS_TEXT), ...overrides });
/** 試験の実行の場所で決まる値を避けるため、起動の場所はドライブのいちばん上（Desktop と同じ。作業フォルダーには使わない） */
const SPAWN_CWD = path.parse(process.cwd()).root;

/** 作業フォルダー（実際のパス）。fields/2305.json を置く */
export function makeWorkspace(prefix = "fml-mcp-") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  mkdirSync(path.join(root, "fields"));
  writeFileSync(path.join(root, "fields", "2305.json"), FIELDS_TEXT);
  return root;
}

/** 試験のときだけ kintone の偽物を読み込ませる（Node の --import。test/mock-fetch.mjs） */
export const MOCK_FETCH = pathToFileURL(path.join(here, "mock-fetch.mjs")).href;

/** サーバーを起動してクライアントでつなぐ。応答と標準エラーを集める（秘密の値が出ないかの確かめ）。opt.mockFetch で kintone の偽物、opt.server で別に作った本体 */
export async function connect(args, env = {}, opt = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(opt.mockFetch ? ["--import", MOCK_FETCH] : []), opt.server ?? SERVER, ...args],
    env: { PATH: process.env.PATH ?? "", KINTONE_API_TOKEN: SECRET, ...env },
    cwd: SPAWN_CWD,
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "formula-mcp-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  const call = async (name, input) => {
    try {
      const r = await client.callTool({ name, arguments: input });
      seen.push(JSON.stringify(r));
      return r;
    } catch (e) {
      seen.push(String(e));
      return { isError: true, protocolError: e instanceof Error ? e.message : String(e) };
    }
  };
  return { client, call, close: () => client.close(), output: () => `${seen.join("\n")}\n${stderr}`, stderr: () => stderr };
}

/** Claude Code の形（--surface claude-code --roots [...]）で起動 */
export const connectClaudeCode = (roots, env = { FORMULA_PLUGIN_ZIP: ZIP }, opt = {}) => connect(["--surface", "claude-code", "--roots", JSON.stringify(roots)], env, opt);
/** Desktop の形（--surface desktop --workspace-dir …）で起動 */
export const connectDesktop = (dir, env = { FORMULA_PLUGIN_ZIP: ZIP }, opt = {}) => connect(["--surface", "desktop", "--workspace-dir", dir], env, opt);

export const sc = (r) => r.structuredContent;

/** 接続のファイルに直接書く試験のトークン（応答・標準エラーに出てはいけない） */
export const TOKENS = { dev2305: "TEST-dev-2305-not-a-real-token", dev101: "TEST-dev-101-not-a-real-token", prod2305: SECRET, guest2305: "TEST-guest-2305-not-a-real-token", userApi: "TEST-userapi-not-a-real-token" };
/** 開発（dev-x）と本番（x）とゲストスペース 7（x）。dev の APP101 は env:（FORMULA_TEST_TOKEN_101）。dev の User API のトークンは userApiToken */
export const CONN = {
  defaultProfile: "dev",
  profiles: {
    dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP2305: TOKENS.dev2305, APP101: "env:FORMULA_TEST_TOKEN_101", APP9999: TOKENS.dev2305 }, userApiToken: TOKENS.userApi },
    prod: { baseUrl: "https://x.cybozu.com", tokenMap: { APP2305: TOKENS.prod2305 } },
    guest7: { baseUrl: "https://x.cybozu.com", guestSpaceId: 7, tokenMap: { "2305": TOKENS.guest2305 } }
  }
};

/** kintone の接続のファイル（作業フォルダーの外の一時フォルダー）。write で書き換える */
export function makeConn(conn = CONN) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fml-mcp-conn-")));
  const file = path.join(dir, "ksql.config.json");
  const write = (data) => writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  write(conn);
  return { dir, file, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 接続のファイルを使うときの環境変数（OS の KINTONE_* は読まないことも確かめるため、別の接続先を入れておく） */
export const connEnv = (file, extra = {}) => ({ FORMULA_PLUGIN_ZIP: ZIP, FORMULA_KINTONE_CONFIG: file, FORMULA_TEST_TOKEN_101: TOKENS.dev101, KINTONE_BASE_URL: "https://other.cybozu.com", ...extra });

/** 偽の kintone が記録するトークンの短い digest（トークンそのものはログに書かない） */
export const tokenHash = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

/** 偽の kintone の要求のログ（FORMULA_TEST_FETCH_LOG） */
export function fetchLog() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fml-mcp-fetchlog-")));
  const file = path.join(dir, "fetch.log");
  return { file, requests: () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 秘密の値（試験のトークンすべて）が出ていないか */
export const leakedTokens = (text) => Object.values(TOKENS).filter((t) => text.includes(t));
export const saveInput = (root, p, content = SETTINGS_TEXT, extra = {}) => ({ workspaceId: root, path: p, content, fields: "fields/2305.json", expectedAbsent: true, ...extra });
