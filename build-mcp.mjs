// formula MCP を esbuild で 1 つの CJS ファイルにする（print-craft MCP の build-mcp.mjs を元にした。計画 24.6）。
//   - 中核（node_modules の @rex0220/formula-authoring-tools/core。版は lockfile で固定）、MCP の SDK v2、zod、happy-dom を束ねる
//   - 束ねたものは src/ と node_modules/ だけから作る（隣のリポジトリのソースを読まない）。外の require が残っていないことを確かめる
//   - 出力: dist/server/formula-mcp.cjs（本体）、dist/server/index.cjs（起動のファイル。main() を必ず呼ぶ。kSQL）、
//     dist/server/eval-worker.mjs（評価の Worker の入口。中核の dist/eval-worker.mjs を happy-dom ごと束ねた ESM。計画 24.5）、
//     dist/vendor/（中核のエンジンが読む moment。本体と Worker は paths.ts で「本体の 1 つ上の vendor/」を見る）
//   - CJS に import.meta.url は無いので、本体のファイルの URL に置き換える（src/paths.ts が自分の場所から eval-worker.mjs と vendor/ を探す）
//   - 互換表（compat.json。7 章）を埋め込み、ビルドの組み合わせ（版・中核の版・資料の元）が表と合うかを、束ねたもので確かめる（合わなければ止める）
//   - 束ねた依存の著作権表示（THIRD_PARTY_NOTICES.md）を dist/ に作り、リポジトリのものと同じかを確かめる（違えば止める。--write-notices で書き直す）
// 使い方: node build-mcp.mjs [--out <フォルダー>] [--compat <compat.json>] [--no-compat-check] [--write-notices]
//   （--out / --compat / --no-compat-check は試験用: 合わない互換表のビルドを作って、実行のときの incompatible を試す）
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_SECTIONS } from "./scripts/docs-sections.mjs";
import { bundledPackages, eol, NOTICES_FILE, renderNotices, vendorMoment } from "./scripts/third-party-notices.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dist = path.resolve(argOf("--out") ?? path.join(root, "dist"));
const compatFile = path.resolve(argOf("--compat") ?? path.join(root, "compat.json"));
const compatCheck = !process.argv.includes("--no-compat-check");
const compat = JSON.parse(readFileSync(compatFile, "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const toolsDir = path.join(root, "node_modules", "@rex0220", "formula-authoring-tools");
const tools = JSON.parse(readFileSync(path.join(toolsDir, "package.json"), "utf8"));
const outfile = path.join(dist, "server", "formula-mcp.cjs");
const workerOut = path.join(dist, "server", "eval-worker.mjs");

// 資料（fml_docs）: guide/ と references/template/（写した元のコミットと sha256 を照合する。手で直した写しを埋め込まない）
const refDir = path.join(root, "references", "template");
const source = JSON.parse(readFileSync(path.join(refDir, "SOURCE.json"), "utf8"));
const recorded = new Map(source.files.map((f) => [f.path, f.sha256]));
const used = new Set();
const sections = DOC_SECTIONS.map((d) => {
  if (d.guide) return { key: d.key, title: d.title, kind: "guide", text: readFileSync(path.join(root, "guide", d.guide), "utf8") };
  const data = readFileSync(path.join(refDir, d.ref));
  const sha = createHash("sha256").update(data).digest("hex");
  if (recorded.get(d.ref) !== sha) throw new Error(`references/template/${d.ref} が写したときと違う（scripts/sync-references.mjs で写し直す。手で直さない）`);
  used.add(d.ref);
  return { key: d.key, title: d.title, kind: "ref", text: data.toString("utf8") };
});
const unused = [...recorded.keys()].filter((p) => !used.has(p));
if (unused.length) throw new Error(`写したが使っていない資料がある（docs-sections.mjs に足すか、sync-references.mjs から外す）: ${unused.join(", ")}`);
const docs = { source: { repository: source.repository, commit: source.commit, short: source.short, dirty: source.dirty }, sections };

rmSync(dist, { recursive: true, force: true });

const leaked = (inputs) => inputs.filter((p) => /formula[\\/](src|lib|prod)[\\/]|plugin-config-kit[\\/]src|rexgrid[\\/]src/.test(p.replace(/\\/g, "/")));
const outside = (inputs) => inputs.filter((p) => !/^(src|node_modules)\//.test(p.replace(/\\/g, "/")));

// 評価の Worker の入口（中核の dist/eval-worker.mjs は happy-dom を外に置いているので、ここで束ねる。ESM のまま。Worker は本体と別のファイル）
const worker = await build({
  entryPoints: [path.join(toolsDir, "dist", "eval-worker.mjs")],
  outfile: workerOut,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  charset: "utf8",
  legalComments: "eof",
  external: ["bufferutil", "utf-8-validate"],
  // 束ねた CJS の依存（happy-dom など）が Node の組み込み（events など）を require するので、ESM でも require を使えるようにする（esbuild の __require は global の require を使う）
  banner: { js: `/*! formula MCP ${pkg.version} の評価の Worker（中核 @rex0220/formula-authoring-tools ${tools.version}）。MIT License. 計算式エンジンと計算式プラグインのコードは利用者の計算式プラグインの zip から読む（このファイルには含まれない） */\nimport { createRequire as __fml_createRequire } from "node:module"; const require = __fml_createRequire(import.meta.url);` },
  absWorkingDir: root,
  metafile: true,
  logLevel: "warning"
});
const workerInputs = Object.keys(worker.metafile.inputs);
if (outside(workerInputs).length) throw new Error(`評価の Worker に src/ と node_modules/ の外のファイルが束ねられている:\n  ${outside(workerInputs).join("\n  ")}`);
if (leaked(workerInputs).length) throw new Error(`評価の Worker に計算式プラグイン / kit / rexgrid のコードが入っている:\n  ${leaked(workerInputs).join("\n  ")}`);
const workerJs = readFileSync(workerOut, "utf8");
if (/\bfrom\s*["']happy-dom["']|require\(["']happy-dom/.test(workerJs)) throw new Error("評価の Worker に happy-dom が束ねられていない");

const result = await build({
  entryPoints: [path.join(root, "src", "server.ts")],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  charset: "utf8",
  // 束ねた依存（MCP の SDK、zod、happy-dom など）の著作権表示はファイルの末尾に残す
  legalComments: "eof",
  // ws（happy-dom の依存）の任意の高速化の部品。無ければ ws が自分で代わりを使う
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: `/*! formula MCP ${pkg.version}（中核 @rex0220/formula-authoring-tools ${tools.version}）。MIT License. 計算式エンジンと計算式プラグインのコードは利用者の計算式プラグインの zip から読む（このファイルには含まれない） */\nvar __fml_import_meta_url = require("node:url").pathToFileURL(__filename).href;`
  },
  define: {
    __FML_MCP_VERSION__: JSON.stringify(pkg.version),
    __FML_DOCS__: JSON.stringify(JSON.stringify(docs)),
    __FML_COMPAT__: JSON.stringify(JSON.stringify(compat)),
    "import.meta.url": "__fml_import_meta_url"
  },
  tsconfig: path.join(root, "tsconfig.json"),
  absWorkingDir: root,
  metafile: true,
  logLevel: "warning"
});

const inputs = Object.keys(result.metafile.inputs);
if (outside(inputs).length) throw new Error(`src/ と node_modules/ の外のファイルが束ねられている（隣のリポジトリを読まない）:\n  ${outside(inputs).join("\n  ")}`);
if (leaked(inputs).length) throw new Error(`本体に計算式プラグイン / kit / rexgrid のコードが入っている:\n  ${leaked(inputs).join("\n  ")}`);
if (!inputs.some((p) => p.replace(/\\/g, "/").startsWith("node_modules/@rex0220/formula-authoring-tools/dist/core.mjs"))) throw new Error("中核（@rex0220/formula-authoring-tools/dist/core.mjs）が束ねられていない");
const bundle = readFileSync(outfile, "utf8");
for (const re of [/require\(["']@modelcontextprotocol\//, /require\(["']zod(?:\/[^"']*)?["']\)/, /require\(["']happy-dom/, /require\(["']@rex0220\//]) {
  if (re.test(bundle)) throw new Error(`束ねていない依存が残っている: ${re}`);
}

// 束ねた依存の著作権表示: 本体と評価の Worker に入ったパッケージと、vendor/ の moment
const notices = renderNotices(
  bundledPackages(root, [
    { label: "本体", metafile: result.metafile },
    { label: "評価の Worker", metafile: worker.metafile }
  ]),
  vendorMoment(path.join(toolsDir, "vendor", "moment.json"))
);
writeFileSync(path.join(dist, NOTICES_FILE), notices);
const noticesPath = path.join(root, NOTICES_FILE);
if (process.argv.includes("--write-notices")) writeFileSync(noticesPath, notices);
else if (!existsSync(noticesPath) || eol(readFileSync(noticesPath, "utf8")) !== notices) throw new Error(`${NOTICES_FILE} が束ねた依存と合わない（npm run notices で作り直し、差分を確かめてコミットする）`);

writeFileSync(
  path.join(dist, "server", "index.cjs"),
  `#!/usr/bin/env node
// 起動のファイル: main() を必ず呼ぶ（直接起動されたかの判定で分けない。Desktop 同梱の Node では効かなかった。kSQL）
const { main } = require("./formula-mcp.cjs");
main().catch((err) => {
  process.stderr.write(\`[formula-mcp] \${err && err.name ? err.name : "Error"}: \${err && err.message ? err.message : ""}\\n\`);
  process.exitCode = 1;
});
`
);
mkdirSync(path.join(dist, "vendor"), { recursive: true });
for (const f of ["moment-with-locales.min.js", "moment.json"]) copyFileSync(path.join(toolsDir, "vendor", f), path.join(dist, "vendor", f));

// 束ねたものが読み込めるか（起動はしない。main と VERSION を持つか）と、互換表とビルドの組み合わせが合うか
const probe = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(outfile)}); if (typeof m.main !== "function") process.exit(2); console.log(JSON.stringify({ version: m.VERSION, problem: m.buildProblem() ?? null }))`], { encoding: "utf8" });
if (probe.status !== 0) throw new Error(`束ねたものが読み込めない（exit ${probe.status}）:\n${probe.stderr}`);
const probed = JSON.parse(probe.stdout.trim().split("\n").at(-1));
if (probed.version !== pkg.version) throw new Error(`束ねたものの版 ${probed.version} が package.json の ${pkg.version} と違う`);
if (compatCheck && probed.problem) throw new Error(`互換表とビルドの組み合わせが合わない（compat.json を直す）: ${probed.problem}`);

console.log(`[build-mcp] dist/server/formula-mcp.cjs (${bundle.length.toLocaleString()} bytes; ${inputs.length} inputs; 版 ${pkg.version}; 中核 tools ${tools.version}; 資料 ${sections.length} 章、元 ${source.short}${source.dirty ? "+dirty" : ""}; 評価の Worker ${workerJs.length.toLocaleString()} bytes)`);
