// テンプレート（formula-authoring）の docs/ と samples/ を references/template/ に写す（print-craft MCP の実装案 3.2、5.5、8.2、12.4 と同じ考え。計画 24.3）。
//   - 写すのは AI が読む資料だけ（計算パターン集とその検証、設定ファイル仕様、関数一覧、既定のテストデータ、封筒形式の雛形）。利用者向けの手順書（README、バージョンアップ手順）と
//     CLI の手順（AI作業手順.md。MCP では guide/ に fml_* 版を置く）は写さない
//   - 写した元のコミットと、各ファイルの sha256・大きさを references/template/SOURCE.json に書く（build-mcp.mjs が照合する。手で二重に直さない）
//   - 元の資料にコミットしていない変更があれば止める（--allow-dirty で写せるが、SOURCE.json に dirty と書く）
// 使い方: node scripts/sync-references.mjs [テンプレートのフォルダー（既定 ../formula-authoring）] [--allow-dirty]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const template = path.resolve(root, args.find((a) => !a.startsWith("--")) ?? "../formula-authoring");
const outDir = path.join(root, "references", "template");

export const FILES = [
  "docs/使い方ナビ.md",
  "docs/計算パターン.md",
  "docs/計算パターン_検証.md",
  "docs/設定ファイル仕様.md",
  "docs/関数一覧.md",
  "docs/既定のテストデータ.md",
  "samples/settings-source.json",
  "docs/項目検証/設定ファイル仕様.md",
  "docs/項目検証/検証パターン.md",
  "samples/項目検証/settings-source.json"
];

const git = (...a) => execFileSync("git", ["-C", template, ...a], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirtyFiles = git("status", "--porcelain", "--", ...FILES);
if (dirtyFiles && !allowDirty) {
  console.error(`元の資料にコミットしていない変更がある（コミットしてから写す。--allow-dirty で写せる）:\n${dirtyFiles}`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
const files = [];
for (const f of FILES) {
  const src = path.join(template, f);
  const dst = path.join(outDir, f);
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const data = readFileSync(dst);
  files.push({ path: f, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
const source = { repository: "rex0220/formula-authoring", commit, short: commit.slice(0, 7), dirty: Boolean(dirtyFiles), copiedAt: new Date().toISOString(), files };
writeFileSync(path.join(outDir, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
console.log(`[sync-references] ${files.length} ファイルを ${path.relative(root, outDir)} に写した（元 ${source.repository} ${source.short}${source.dirty ? "、未コミットの変更あり" : ""}。${files.reduce((n, f) => n + f.bytes, 0).toLocaleString()} バイト）`);
