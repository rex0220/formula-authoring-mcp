/**
 * 束ねた本体からの相対の置き場所（計画 24.4 の 3、24.6）。build-mcp.mjs が import.meta.url を本体のファイルの URL に置き換えるので、
 * dist/server/formula-mcp.cjs の隣の eval-worker.mjs（評価の Worker の入口）と、dist/vendor/（中核のエンジンが読む moment）が決まる。
 * 束ねていないとき（src/ から型の確かめなど）は node_modules の中核のものを指す（本体は常に束ねて動かす）
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.basename(here) === "server" && existsSync(path.join(here, "eval-worker.mjs"));
const toolsDir = path.resolve(here, "..", "node_modules", "@rex0220", "formula-authoring-tools");

/** 評価の Worker の入口（絶対パス。中核の runEval の workerFile） */
export const WORKER_FILE = bundled ? path.join(here, "eval-worker.mjs") : path.join(toolsDir, "dist", "eval-worker.mjs");
/** moment の置き場所（中核の loadEngine の vendorDir） */
export const VENDOR_DIR = bundled ? path.resolve(here, "..", "vendor") : path.join(toolsDir, "vendor");
