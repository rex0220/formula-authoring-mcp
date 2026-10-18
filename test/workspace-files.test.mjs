// 作業フォルダーのファイルを扱うツールと pull（計画 24.2）: fml_files、fml_take、fml_edit、fml_diff、fml_pull。
// kintone は test/mock-fetch.mjs の偽物。プラグインの設定は、この試験が中核（計算式プラグインの zip の authoring API の writeConfig）で保存の形にしてファイルに置く。
// アプリのフォルダー（kintone/<profile>/<番号>-<アプリ名>/）を使うのは、kintone の接続のファイルがあるときだけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@rex0220/formula-authoring-tools/core";
import { FIELDS_TEXT, SETTINGS_TEXT, SKIP as skip, ZIP, connEnv, connectClaudeCode, leakedTokens, makeConn, makeWorkspace, saveInput, sc, settings } from "./helpers.mjs";

const tmp = skip ? null : realpathSync(mkdtempSync(path.join(os.tmpdir(), "fml-mcp-pluginconfig-")));
const CONFIG = tmp ? path.join(tmp, "plugin-config.json") : "";
if (!skip) {
  // 設定画面が保存した形（kit の writeConfig の圧縮形式 + 共通項目）
  const engine = await core.loadEngine({ pluginZip: ZIP });
  const r = await core.normalizeSettings({ settingsText: SETTINGS_TEXT, settingsFile: "settings/a.json", fields: JSON.parse(FIELDS_TEXT), engine });
  if (!r.output) throw new Error(`fixture の設定が normalize を通らない: ${r.summary}`);
  const { date, pluginName, pluginID, PluginVersion, appId, appName, ...body } = r.output;
  const stored = await engine.api.writeConfig({ ...body, pluginLastUpdate: "2026-10-18 10:00:00", pluginUpdater: "佐藤" }, "compressed");
  writeFileSync(CONFIG, JSON.stringify(stored));
}
const DEV_DIR = "kintone/dev/2305-テーブル内集計";
const SNAP = /^rex0220-formula-app2305-\d{8}-\d{6}\.json$/;

test("接続のファイルが無い作業フォルダー: fml_files は settings/ などの名前だけ、fml_diff は差。pull・take・edit と files の app / profile は not-configured", { skip }, async () => {
  const root = makeWorkspace();
  const s = await connectClaudeCode([root], { FORMULA_PLUGIN_ZIP: ZIP, FORMULA_TEST_PLUGIN_CONFIG: CONFIG }, { mockFetch: true });
  try {
    assert.equal(sc(await s.call("fml_save_settings", saveInput(root, "settings/集計.json"))).status, "ok");
    const changed = JSON.parse(settings());
    changed.pluginInfos[0].rank = 3;
    assert.equal(sc(await s.call("fml_save_settings", saveInput(root, "settings/集計-直した.json", JSON.stringify(changed)))).status, "ok");
    const files = sc(await s.call("fml_files", { workspaceId: root }));
    assert.equal(files.status, "ok");
    assert.equal(files.result.mode, "not-configured");
    assert.deepEqual(files.result.local.settings.sort(), ["settings/集計-直した.json", "settings/集計.json"]);
    assert.deepEqual(files.result.local.fields, ["fields/2305.json"]);
    assert.ok(!JSON.stringify(files).includes("SUMIF"), "中身は返さない");
    const d = sc(await s.call("fml_diff", { workspaceId: root, before: "settings/集計.json", after: "settings/集計-直した.json" }));
    assert.equal(d.status, "ok");
    assert.deepEqual(d.result.fields.map((f) => [f.fieldcode, f.keys]), [["金額合計", ["rank"]]]);
    assert.equal(d.result.affectsRecords, true, "ランクの変更は計算の順を変える");
    for (const [tool, input] of [["fml_pull", { app: 2305 }], ["fml_take", {}], ["fml_edit", { app: 2305 }], ["fml_files", { app: 2305 }], ["fml_files", { profile: "dev" }]]) {
      const r = sc(await s.call(tool, { workspaceId: root, ...input }));
      assert.deepEqual([r.status, r.error?.code], ["failed", "not-configured"], `${tool} ${JSON.stringify(input)}`);
    }
    assert.ok(!existsSync(path.join(root, "kintone")));
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("接続のファイル: pull はアプリのフォルダーにダウンロードと同じ名前（無ければ印を置いて作る）、files は app で新しい順、edit は -edit.json、take は inbox から名前のまま、update_fields は -edit.json を直す（ダウンロードは denied）", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_PLUGIN_CONFIG: CONFIG }), { mockFetch: true });
  try {
    const p = sc(await s.call("fml_pull", { workspaceId: root, app: 2305 }));
    assert.equal(p.status, "ok", JSON.stringify(p));
    assert.match(path.basename(p.result.path), SNAP);
    assert.equal(path.dirname(p.result.path), DEV_DIR);
    assert.deepEqual([p.result.appId, p.result.appName, p.result.revision, p.result.preview], [2305, "テーブル内集計", "12", false]);
    assert.match(p.result.summary, /金額合計/);
    assert.ok(existsSync(path.join(root, DEV_DIR, ".formula-app.json")), "印を置いて作る");
    const f1 = sc(await s.call("fml_files", { workspaceId: root, app: 2305 }));
    assert.deepEqual([f1.status, f1.result.folder, f1.result.fields, f1.result.snapshots.length, f1.result.current], ["ok", DEV_DIR, false, 1, path.basename(p.result.path)]);
    const e = sc(await s.call("fml_edit", { workspaceId: root, app: 2305 }));
    assert.deepEqual([e.status, e.result.existed, e.result.from], ["ok", false, p.result.path]);
    assert.equal(e.result.path, p.result.path.replace(/\.json$/, "-edit.json"));
    assert.deepEqual(sc(await s.call("fml_edit", { workspaceId: root, path: p.result.path })).result.existed, true, "既にあればそのまま");
    // -edit.json を直す（同じフォルダーの fields.json が要る → fml_fields）
    assert.equal(sc(await s.call("fml_fields", { workspaceId: root, app: 2305 })).status, "ok");
    const sum = sc(await s.call("fml_summary", { workspaceId: root, path: e.result.path }));
    assert.equal(sum.status, "ok", JSON.stringify(sum));
    const up = sc(await s.call("fml_update_fields", { workspaceId: root, path: e.result.path, expectedDigest: sum.digest, rows: JSON.stringify([{ fieldcode: "金額合計", rank: 2 }]) }));
    assert.equal(up.status, "ok", JSON.stringify(up));
    const snapUp = sc(await s.call("fml_update_fields", { workspaceId: root, path: p.result.path, expectedDigest: p.digest, rows: JSON.stringify([{ fieldcode: "金額合計", rank: 2 }]) }));
    assert.deepEqual([snapUp.status, snapUp.error.code], ["denied", "PermissionError"], "ダウンロード / pull は書き換えない");
    const d = sc(await s.call("fml_diff", { workspaceId: root, before: p.result.path, after: e.result.path }));
    assert.deepEqual(d.result.fields.map((f) => f.fieldcode), ["金額合計"]);
    // take: inbox のダウンロード（封筒の appId で行き先が決まる。名前のまま）
    mkdirSync(path.join(root, "inbox"));
    const name = "rex0220-formula-app2305-20261001-090000.json";
    writeFileSync(path.join(root, "inbox", name), settings());
    writeFileSync(path.join(root, "inbox", "other.json"), JSON.stringify({ pluginID: "other" }));
    const t = sc(await s.call("fml_take", { workspaceId: root }));
    assert.equal(t.status, "ok", JSON.stringify(t));
    assert.deepEqual(t.result.moved.map((m) => [m.file, m.to]), [[`inbox/${name}`, `${DEV_DIR}/${name}`]]);
    assert.equal(t.result.skipped, 1);
    assert.ok(existsSync(path.join(root, DEV_DIR, name)) && !existsSync(path.join(root, "inbox", name)));
    const f2 = sc(await s.call("fml_files", { workspaceId: root, app: 2305 }));
    assert.deepEqual([f2.result.snapshots.length, f2.result.edits.length, f2.result.current], [2, 1, path.basename(p.result.path)], "新しい順（先頭が今の設定）");
    const all = sc(await s.call("fml_files", { workspaceId: root }));
    assert.equal(all.result.mode, "profiles");
    assert.deepEqual(all.result.kintone.profiles.find((x) => x.name === "dev").folders.map((x) => [x.name, x.mark]), [["2305-テーブル内集計", "ok"]]);
    assert.deepEqual(leakedTokens(s.output()), []);
    assert.ok(!s.output().includes("佐藤"), "保存値の更新者の名前を返さない");
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull: API ラボが無効（404）なら failed と案内。同じ日時の名前が既にあれば conflict", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const s = await connectClaudeCode([root], connEnv(conn.file), { mockFetch: true });
  try {
    const r = sc(await s.call("fml_pull", { workspaceId: root, app: 2305 }));
    assert.deepEqual([r.status, r.error.code], ["failed", "RestError"]);
    assert.match(r.error.message, /API ラボ/);
    assert.doesNotMatch(r.error.message, /SERVER-SECRET-MESSAGE/);
    assert.ok(!existsSync(path.join(root, "kintone")), "取れなければ作らない");
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});
