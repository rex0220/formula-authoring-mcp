// Claude Code のプラグインの zip（B2。リリース手順 0-9、実装案 8.1）: GitHub のリリースに置き、marketplace の archive が sha256 で固定して指す。
//   - 中身はプラグインに要るものだけ: .claude-plugin/plugin.json、.mcp.json、hooks/（試験と tsconfig を除く）、dist/server/、dist/vendor/、
//     LICENSE、THIRD_PARTY_NOTICES.md、短い README。プラグインの root は zip のいちばん上（archive は「いちばん上か 1 段下」を受け付ける）
//   - package.json と lockfile は入れない（Claude Code が依存を入れようとしない。本体は束ねてある）
//   - 入れてはいけないもの（scripts/forbidden-files.mjs。0-7）があれば作らない。版は package.json・plugin.json・compat.json がそろっていること
// 使い方: node build-mcp.mjs && node scripts/build-plugin-zip.mjs → dist-plugin/formula-plugin-<版>.zip
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../build-mcpb.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { NOTICES_FILE } from "./third-party-notices.mjs";
import { createZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-plugin");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
const compat = JSON.parse(readFileSync(path.join(root, "compat.json"), "utf8"));

/** marketplace（.claude-plugin/marketplace.json）の名前と、プラグインの名前 */
export const MARKETPLACE_NAME = "rex0220-formula";
export const PLUGIN_NAME = plugin.name;
export const zipName = (version) => `formula-plugin-${version}.zip`;
export const outPath = path.join(outDir, zipName(pkg.version));

/** zip に入れるファイル（zip の中のパスと、リポジトリの中の元） */
export const PLUGIN_FILES = [
  [".claude-plugin/plugin.json", ".claude-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["hooks/register.ts", "hooks/register.ts"],
  ["dist/server/index.cjs", "dist/server/index.cjs"],
  ["dist/server/formula-mcp.cjs", "dist/server/formula-mcp.cjs"],
  ["dist/server/eval-worker.mjs", "dist/server/eval-worker.mjs"],
  ["dist/vendor/moment-with-locales.min.js", "dist/vendor/moment-with-locales.min.js"],
  ["dist/vendor/moment.json", "dist/vendor/moment.json"],
  ["LICENSE", "LICENSE"],
  [NOTICES_FILE, `dist/${NOTICES_FILE}`]
];

const readme = `# formula ${pkg.version}（Claude Code のプラグイン）

kintone の計算式プラグイン（rex0220 formula。Ver.101 以降）と項目検証プラグイン（rex0220 field validation。Ver.72 以降。式の評価は計算式プラグインの zip の Ver.102 以降）の設定 JSON を、検査と模擬の計算・判定を通して作業フォルダーに保存・確認する Claude Code のプラグイン（formula MCP と、作業フォルダーの結び付け・設定ファイルへの直接の書き込みを止めるフック）。kintone には読み取り（GET）だけ。

- 入れ方: \`/plugin install ${PLUGIN_NAME} --marketplace rex0220/formula-authoring-mcp\`（Claude Code 2.1.275 以降。それより前は \`/plugin marketplace add rex0220/formula-authoring-mcp\` → \`/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}\`）
- 設定: \`/config\` で、計算式プラグインの zip と kintone の接続のファイル
- 使い方、プライバシーポリシー、セキュリティ、変更履歴: ${REPO_URL}
- 同梱の依存の著作権表示とライセンス: ${NOTICES_FILE}
`;

/** zip の中身。版のずれ・ファイルの欠け・入れてはいけないものがあれば止める */
export function pluginEntries() {
  if (plugin.version !== pkg.version || compat.runtimeChecks?.mcpVersion !== pkg.version) {
    throw new Error(`版がそろっていない: package.json ${pkg.version}、plugin.json ${plugin.version}、compat.json ${compat.runtimeChecks?.mcpVersion}`);
  }
  const missing = PLUGIN_FILES.filter(([, from]) => !existsSync(path.join(root, from))).map(([, from]) => from);
  if (missing.length) throw new Error(`無いファイル（先に node build-mcp.mjs）: ${missing.join(", ")}`);
  const entries = [...PLUGIN_FILES.map(([p, from]) => ({ path: p, data: readFileSync(path.join(root, from)) })), { path: "README.md", data: Buffer.from(readme, "utf8") }];
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  return entries;
}

function isIgnored() {
  const p = path.join(root, ".gitignore");
  return existsSync(p) && readFileSync(p, "utf8").split(/\r?\n/).some((l) => l.trim() === "dist-plugin/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-plugin/ が無い（成果物をコミットしない）");
  const zip = createZip(pluginEntries());
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, zip);
  console.log(`[build-plugin-zip] ${outPath} (${zip.length.toLocaleString()} bytes; 版 ${pkg.version})`);
}
