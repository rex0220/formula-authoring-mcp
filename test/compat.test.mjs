// 互換表（compat.json。実装案 7 章）: ビルドの組み合わせが合わなければビルドを止める。合わない互換表のビルド（試験用の --no-compat-check）では、
// 作業フォルダーを使うツールが incompatible、fml_docs / fml_status / fml_workspace_status は止めない。計算式プラグインの zip の版の上限を超えたら incompatible
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_VERSION, ROOT, SKIP as skip, VERSION, connectClaudeCode, makeWorkspace, saveInput, sc } from "./helpers.mjs";

const COMPAT = JSON.parse(readFileSync(path.join(ROOT, "compat.json"), "utf8"));

function buildWith(compat, extra = []) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fml-mcp-compat-")));
  const file = path.join(dir, "compat.json");
  writeFileSync(file, JSON.stringify(compat));
  const r = spawnSync(process.execPath, [path.join(ROOT, "build-mcp.mjs"), "--out", path.join(dir, "dist"), "--compat", file, ...extra], { encoding: "utf8" });
  return { dir, server: path.join(dir, "dist", "server", "index.cjs"), status: r.status, output: `${r.stdout}${r.stderr}` };
}

test("今の compat.json は今のビルドと合う（mcpVersion、資料の元）", () => {
  assert.equal(COMPAT.schemaVersion, 1);
  assert.equal(COMPAT.runtimeChecks.mcpVersion, VERSION);
  const source = JSON.parse(readFileSync(path.join(ROOT, "references", "template", "SOURCE.json"), "utf8"));
  assert.equal(COMPAT.runtimeChecks.docsRevision, source.short);
});

test("ビルドの組み合わせが互換表と合わなければ、ビルドを止める", () => {
  const b = buildWith({ ...COMPAT, runtimeChecks: { ...COMPAT.runtimeChecks, coreVersion: ">=9.0.0" } });
  try {
    assert.notEqual(b.status, 0);
    assert.match(b.output, /互換表とビルドの組み合わせが合わない.*中核の版/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("中核の API の版（coreApiVersion。tools 0.2.0 で 2）が互換表と違えばビルドを止める", () => {
  assert.equal(COMPAT.runtimeChecks.coreApiVersion, 2);
  for (const v of [1, undefined]) {
    const { coreApiVersion: _omit, ...rest } = COMPAT.runtimeChecks;
    const b = buildWith({ ...COMPAT, runtimeChecks: v === undefined ? rest : { ...rest, coreApiVersion: v } });
    try {
      assert.notEqual(b.status, 0, String(v));
      assert.match(b.output, /互換表とビルドの組み合わせが合わない.*中核の API の版/);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  }
});

test("合わない互換表のビルド: 作業フォルダーを使うツールは incompatible、資料・診断は読める", { skip }, async () => {
  const b = buildWith({ ...COMPAT, runtimeChecks: { ...COMPAT.runtimeChecks, docsRevision: "0000000" } }, ["--no-compat-check"]);
  assert.equal(b.status, 0, b.output);
  const root = makeWorkspace();
  const s = await connectClaudeCode([root], undefined, { server: b.server });
  try {
    const st = sc(await s.call("fml_status", {}));
    assert.equal(st.result.ready, false);
    assert.match(st.result.next.join("\n"), /互換表と合わない.*docsRevision/);
    assert.notEqual((await s.call("fml_docs", {})).isError, true);
    assert.equal(sc(await s.call("fml_workspace_status", { workspaceId: root })).status, "ok");
    for (const [tool, input] of [["fml_save_settings", saveInput(root, "settings/a.json")], ["fml_summary", { workspaceId: root, path: "settings/a.json" }], ["fml_fields", { workspaceId: root, app: 1 }]]) {
      const r = sc(await s.call(tool, input));
      assert.deepEqual([r.status, r.error.code], ["incompatible", "IncompatibleError"], tool);
    }
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("計算式プラグインの zip の版が互換表の上限を超えたら incompatible（上限は書いていないが、書けば効く）", { skip }, async () => {
  const b = buildWith({ ...COMPAT, runtimeChecks: { ...COMPAT.runtimeChecks, pluginVersion: { min: 100, max: 100 } } });
  assert.equal(b.status, 0, b.output);
  const root = makeWorkspace();
  const s = await connectClaudeCode([root], undefined, { server: b.server });
  try {
    const r = sc(await s.call("fml_save_settings", saveInput(root, "settings/a.json")));
    assert.deepEqual([r.status, r.error.code], ["incompatible", "IncompatibleError"]);
    assert.match(r.error.message, new RegExp(`版 ${PLUGIN_VERSION} は.*Ver\\.100 まで`));
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});
