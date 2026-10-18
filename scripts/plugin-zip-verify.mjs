// プラグインの zip の検査（リリース手順 0-9。mcpb-verify.mjs の Claude Code 版）:
//   1. zip を開いて、中身の一覧（決まったファイルだけ）、入れてはいけないもの、版（plugin.json と package.json）、THIRD_PARTY_NOTICES.md がリポジトリと同じ、
//      .mcp.json が zip の中の本体を指し、計算式プラグインの zip と接続のファイルを env で渡す、hooks.json のモジュールが zip にある
//   2. 展開して、Claude Code と同じ形（.mcp.json の command と args。${CLAUDE_PLUGIN_ROOT} は展開したフォルダー）で起動し、MCP のクライアント（SDK v2）で話す:
//      指示の 1 行目に版、ツールの一覧、fml_status、保存（zip の中の本体と vendor/ の moment で検査が通る）、試験用の API トークンが応答・標準エラーに出ないこと
//   3. claude があれば claude plugin validate（展開したフォルダー。CLAUDE=<claude の実行ファイル> で指定できる）
//   4. sha256 と、marketplace.json の archive の項目（scripts/write-marketplace.mjs が書く）を出す
// 使い方: node build-mcp.mjs && node scripts/build-plugin-zip.mjs && node scripts/plugin-zip-verify.mjs
//   （計算式プラグインの zip は FORMULA_TEST_PLUGIN_ZIP か隣の formula の dist/formula-plugin101.zip）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MARKETPLACE_NAME, outPath, PLUGIN_FILES, PLUGIN_NAME } from "./build-plugin-zip.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { eol, NOTICES_FILE } from "./third-party-notices.mjs";
import { readZip } from "./zip.mjs";
import { archiveSource } from "./write-marketplace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tmp", "plugin-zip-verify");
const ZIP = process.env.FORMULA_TEST_PLUGIN_ZIP ?? path.resolve(root, "../formula/dist/formula-plugin101.zip");
const TEST_TOKEN = "TEST-not-a-real-token-0123456789"; // 本物の資格情報は使わない

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  assert(existsSync(ZIP), `計算式プラグインの zip が無い: ${ZIP}`);
  const entries = readZip(outPath);
  const expected = [...PLUGIN_FILES.map(([p]) => p), "README.md"];
  assert(JSON.stringify([...entries.keys()].sort()) === JSON.stringify([...expected].sort()), `中身が違う: ${[...entries.keys()].join(", ")}`);
  const problems = problemsOf(entries);
  assert(!problems.length, `入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  assert(eol(entries.get(NOTICES_FILE).toString("utf8")) === eol(readFileSync(path.join(root, NOTICES_FILE), "utf8")), `${NOTICES_FILE} がリポジトリのものと違う`);

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(entries.get(".claude-plugin/plugin.json").toString("utf8"));
  assert(plugin.name === PLUGIN_NAME && plugin.version === pkg.version, `plugin.json の名前・版: ${plugin.name} ${plugin.version}`);
  assert(path.basename(outPath) === `formula-plugin-${plugin.version}.zip`, "zip の名前に版");
  for (const [k, v] of Object.entries(plugin.userConfig)) assert((v.sensitive === true) === /token|password|username/i.test(k), `プラグインの ${k} の sensitive（秘密の値の項目だけ）`);
  const server = JSON.parse(entries.get(".mcp.json").toString("utf8")).mcpServers?.["formula"];
  assert(server?.command === "node" && server.args[0] === "${CLAUDE_PLUGIN_ROOT}/dist/server/index.cjs" && entries.has("dist/server/index.cjs"), ".mcp.json が zip の中の本体を指す");
  assert(server.env?.FORMULA_PLUGIN_ZIP === "${user_config.pluginZip}" && server.env?.FORMULA_KINTONE_CONFIG === "${user_config.kintoneConfig}", "計算式プラグインの zip と接続のファイルは env で渡す");
  assert(!server.args.some((a) => /pluginZip|kintoneConfig/.test(a)), "zip と接続のファイルを引数に入れない");
  const hooks = JSON.parse(entries.get("hooks/hooks.json").toString("utf8"));
  assert(Array.isArray(hooks.modules) && hooks.modules.every((m) => entries.has(path.posix.join("hooks", m))), "hooks.json のモジュールが zip にある");
  assert(!entries.has("package.json") && ![...entries.keys()].some((p) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|bun\.lock)$/.test(p)), "package.json と lockfile は入れない（依存を入れさせない）");

  rmSync(tmp, { recursive: true, force: true });
  const pluginDir = path.join(tmp, "plugin");
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(pluginDir, p)), { recursive: true });
    writeFileSync(path.join(pluginDir, p), data);
  }
  const workspace = path.join(realpathSync(tmp), "workspace");
  mkdirSync(path.join(workspace, "fields"), { recursive: true });
  writeFileSync(path.join(workspace, "fields", "2305.json"), readFileSync(path.join(root, "test", "fixtures", "fields-2305.json")));
  const connFile = path.join(realpathSync(tmp), "ksql.config.json");
  writeFileSync(connFile, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://x.cybozu.com", tokenMap: { APP2305: TEST_TOKEN } } } }), { mode: 0o600 });
  const values = { "${CLAUDE_PLUGIN_ROOT}": pluginDir, "${user_config.workspaceRoots}": JSON.stringify([workspace]), "${user_config.pluginZip}": ZIP, "${user_config.kintoneConfig}": connFile };
  const fill = (s) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
  const argv = server.args.map(fill);
  const env = { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_ROOT: pluginDir };
  for (const [k, v] of Object.entries(server.env)) env[k] = fill(v);
  const transport = new StdioClientTransport({ command: process.execPath, args: argv, env, cwd: path.parse(process.cwd()).root, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "plugin-zip-verify", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  let toolCount = 0;
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    seen.push(JSON.stringify(r));
    return r;
  };
  try {
    const instructions = client.getInstructions?.() ?? client.getDiscoverResult?.()?.instructions;
    assert(String(instructions).split("\n")[0].startsWith(`formula MCP ${plugin.version}（`), "指示の 1 行目に版");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    toolCount = names.length;
    assert(names.includes("fml_save_settings") && names.includes("fml_status") && !names.includes("kintone_get_app"), `Claude Code のツールの一覧: ${names.join(", ")}`);
    assert(tools.every((t) => t.inputSchema?.additionalProperties === false), "inputSchema は additionalProperties: false");
    const st = (await call("fml_status", {})).structuredContent;
    assert(st.result.ready === true && st.result.surface === "claude-code" && st.result.workspace.registered === 1, `準備ができた: ${JSON.stringify(st.result.next)}`);
    assert(st.result.pluginZip.readable === true && st.result.pluginZip.compatible === true, "計算式プラグインの zip を読めて互換");
    const input = { workspaceId: workspace, path: "settings/APP2305-テーブル内集計.json", content: readFileSync(path.join(root, "test", "fixtures", "settings-2305.json"), "utf8"), fields: "fields/2305.json", expectedAbsent: true };
    const saved = (await call("fml_save_settings", input)).structuredContent;
    assert(saved.status === "ok" && existsSync(path.join(workspace, input.path)), `保存できる（zip の中の本体と vendor/ で検査が通る）: ${JSON.stringify(saved)}`);
  } finally {
    await client.close();
  }
  assert(!seen.join("\n").includes(TEST_TOKEN) && !stderr.includes(TEST_TOKEN), "応答と標準エラーにトークンが出ない");

  // claude plugin validate（claude が無ければ飛ばす）
  const claude = process.env.CLAUDE ?? "claude";
  const v = spawnSync(claude, ["plugin", "validate", pluginDir], { encoding: "utf8" });
  if (v.error?.code === "ENOENT") console.log(`[plugin-zip-verify] claude が無いので plugin validate は飛ばした（CLAUDE=<claude の実行ファイル> で指定できる）`);
  else assert(v.status === 0, `claude plugin validate が通らない:\n${v.stdout}${v.stderr}`);

  const zip = readFileSync(outPath);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  console.log(`[plugin-zip-verify] ok（${path.basename(outPath)} ${plugin.version}、${zip.length.toLocaleString()} bytes、ツール ${toolCount}、node ${process.version} で起動${v.error ? "" : "、claude plugin validate 済み"}）`);
  console.log(`sha256 ${sha256}`);
  console.log(`marketplace（${MARKETPLACE_NAME}）の source: ${JSON.stringify(archiveSource(plugin.version, sha256))}`);
}


main().catch((e) => {
  console.error(`[plugin-zip-verify] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
