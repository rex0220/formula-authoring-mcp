// 項目検証プラグインの設定のツール（MCP 0.4.0。field-validation の計画 4.3）: fv_save_settings → fv_summary（digest）→ fv_update_rows → fv_normalize（check）→
// fv_check（レコードに当てた判定）→ fv_diff。接続のファイルの形では fv_pull → fml_files（fvSnapshots）→ fml_edit（plugin: field-validation）→ fv_update_rows、fml_take。
// 材料は架空のアプリ 900（test/fixtures/fields-900.json、record-900-1.json）。式は計算式プラグインの zip で評価する
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@rex0220/formula-authoring-tools/core";
import { SETTINGS_TEXT, SKIP as skip, ZIP, connEnv, connectClaudeCode, leakedTokens, makeConn, makeWorkspace, sc } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIELDS_900 = readFileSync(path.join(here, "fixtures", "fields-900.json"), "utf8");
const RECORD_900 = readFileSync(path.join(here, "fixtures", "record-900-1.json"), "utf8");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rowsJson = (...rows) => JSON.stringify(rows);
const envelope = (infos, extra = {}) => JSON.stringify({ date: "2026-10-28 09:00:00", pluginName: "項目検証プラグイン", pluginID: "rex0220 field validation plugin", PluginVersion: "72", appId: 900, appName: "架空の申請", pluginEnable: true, pluginInfos: infos, ...extra });
const GOOD = [
  { fieldcode: "氏名", state: true, formulaSet: "1", condInfos: [{ state: true, condSet: '氏名 = "test"', jaSet: '"test は使えません"', enSet: '"test is not allowed"', zhSet: "" }] },
  { fieldcode: "金額", state: true, formulaSet: '区分 = "A"' }
];
const P = "settings/FV-APP900-架空の申請.json";

/** 1 接続の形の作業フォルダー（fields/900.json と records/900-1.json を置く） */
function makeFvWorkspace() {
  const root = makeWorkspace("fv-mcp-");
  writeFileSync(path.join(root, "fields", "900.json"), FIELDS_900);
  mkdirSync(path.join(root, "records"));
  writeFileSync(path.join(root, "records", "900-1.json"), RECORD_900);
  return root;
}

test("fv_save_settings → fv_summary → fv_update_rows → fv_normalize（check）→ fv_check → fv_diff（settings/ と records/<app>-<id>.json）", { skip }, async () => {
  const root = makeFvWorkspace();
  const s = await connectClaudeCode([root]);
  try {
    const saved = sc(await s.call("fv_save_settings", { workspaceId: root, path: P, content: envelope(GOOD), expectedAbsent: true }));
    assert.equal(saved.status, "ok", JSON.stringify(saved));
    const file = path.join(root, P);
    assert.equal(saved.digest, sha(file));
    assert.match(saved.result.next, /fv_check/);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.pluginID, "rex0220 field validation plugin");
    assert.ok(!("pluginFields" in written), "書くのは元の値の封筒");
    const formula = sc(await s.call("fv_save_settings", { workspaceId: root, path: "settings/f.json", content: SETTINGS_TEXT, fields: "fields/2305.json", expectedAbsent: true }));
    assert.deepEqual([formula.status, formula.error.code], ["invalid", "InputError"], "計算式の設定は fml_save_settings");
    const again = sc(await s.call("fv_save_settings", { workspaceId: root, path: P, content: envelope(GOOD), expectedAbsent: true }));
    assert.deepEqual([again.status, again.error.code], ["conflict", "ConflictError"]);

    const sum = sc(await s.call("fv_summary", { workspaceId: root, path: P }));
    assert.equal(sum.status, "ok", JSON.stringify(sum));
    assert.equal(sum.digest, sha(file));
    assert.deepEqual([sum.result.appId, sum.result.pluginVersion], [900, "72"]);
    assert.ok(sum.result.fieldcodes.includes("氏名") && sum.result.fieldcodes.includes("金額"));
    const one = sc(await s.call("fv_summary", { workspaceId: root, path: P, field: "氏名" }));
    assert.match(one.result.text, /test は使えません/);

    const up = sc(await s.call("fv_update_rows", { workspaceId: root, path: P, expectedDigest: sum.digest, rows: rowsJson({ fieldcode: "備考", hideSet: '区分 = "A"', init: true }), common: JSON.stringify({ pluginComment: "メモ" }) }));
    assert.equal(up.status, "ok", JSON.stringify(up));
    assert.equal(up.digest, sha(file));
    assert.deepEqual(up.result.diff.changed, ["備考"]);
    const stale = sc(await s.call("fv_update_rows", { workspaceId: root, path: P, expectedDigest: sum.digest, rows: rowsJson({ fieldcode: "金額", formulaSet: "1" }) }));
    assert.deepEqual([stale.status, stale.error.code], ["conflict", "ConflictError"]);
    const update = sc(await s.call("fv_update_rows", { workspaceId: root, path: P, expectedDigest: up.digest, rows: rowsJson({ fieldcode: "金額", formulaSet: "TLTABLE(1) > 0" }) }));
    assert.deepEqual([update.status, update.error.code], ["invalid", "NormalizeError"]);
    assert.ok(update.findings.some((f) => f.rule === "formula.update"), JSON.stringify(update.findings));
    assert.equal(sha(file), up.digest, "invalid ではファイルを変えない");

    const norm = sc(await s.call("fv_normalize", { workspaceId: root, path: P, check: true }));
    assert.equal(norm.status, "ok", JSON.stringify(norm));
    assert.equal(norm.result.checkDiffs.count, 0, "保存した設定は既定値を補った形なので差 0");

    const chk = sc(await s.call("fv_check", { workspaceId: root, path: P, records: [1], events: ["app.record.edit.submit"], lang: "en" }));
    assert.equal(chk.status, "ok", JSON.stringify(chk));
    assert.match(chk.result.contextLine, /言語 en.*エンジン 計算式 Ver\.\d+ の zip/);
    const lines = chk.result.records[0].events[0].lines;
    const line = (code) => lines.find((l) => l.field === code);
    assert.deepEqual(line("氏名").errors, ["test is not allowed"], "検証条件の英語のメッセージ");
    assert.equal(line("金額").required, true, "区分 = A なので必須");
    assert.deepEqual([line("備考").hidden, line("備考").reset], [true, { value: JSON.parse(FIELDS_900).properties.備考.defaultValue }], "隠れて初期化（項目の初期値に戻す）");
    assert.ok(chk.findings.some((f) => f.rule === "fv.errors"));
    assert.match(chk.result.note, /既存のレコードの値は変わっていない/);
    const wrongApp = sc(await s.call("fv_check", { workspaceId: root, path: P, records: [1], app: 901 }));
    assert.deepEqual([wrongApp.status, wrongApp.error.code], ["invalid", "InputError"]);
    const badEvent = await s.call("fv_check", { workspaceId: root, path: P, records: [1], events: ["app.record.foo"] });
    assert.equal(badEvent.isError, true, "イベント名はスキーマで止める");

    const before = "settings/FV-before.json";
    writeFileSync(path.join(root, before), envelope(GOOD));
    const d = sc(await s.call("fv_diff", { workspaceId: root, before, after: P }));
    assert.equal(d.status, "ok", JSON.stringify(d));
    assert.ok(d.result.changed.includes("備考"));
    writeFileSync(path.join(root, "settings", "f.json"), SETTINGS_TEXT);
    const dFormula = sc(await s.call("fv_diff", { workspaceId: root, before: "settings/f.json", after: P }));
    assert.deepEqual([dFormula.status, dFormula.error.code], ["invalid", "InputError"], "計算式の設定は fml_diff");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("接続のファイル: fv_pull はアプリのフォルダーにダウンロードと同じ名前、fml_files の fvSnapshots、fml_edit（plugin: field-validation）、fv_update_rows は -edit.json を直す（ダウンロードは denied）、fml_take は項目検証のダウンロードも移す", { skip }, async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fv-mcp-pluginconfig-")));
  const config = path.join(tmp, "fv-config.json");
  const engine = await core.loadEngine({ pluginZip: ZIP });
  writeFileSync(config, JSON.stringify(await engine.api.writeConfig({ pluginEnable: true, pluginInfos: [{ fieldcode: "金額合計", state: true, formulaSet: "1", disabledSet: "", hideSet: "", init: false, condInfos: [] }] }, "compressed")));
  const root = makeWorkspace("fv-mcp-");
  const conn = makeConn();
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_FV_PLUGIN_CONFIG: config }), { mockFetch: true });
  const DEV_DIR = "kintone/dev/2305-テーブル内集計";
  try {
    const p = sc(await s.call("fv_pull", { workspaceId: root, app: 2305 }));
    assert.equal(p.status, "ok", JSON.stringify(p));
    assert.match(path.basename(p.result.path), /^rex0220-field-validation-app2305-\d{8}-\d{6}\.json$/);
    assert.equal(path.dirname(p.result.path), DEV_DIR);
    assert.match(p.result.summary, /金額合計/);
    assert.match(p.result.next, /plugin: field-validation/);
    const f1 = sc(await s.call("fml_files", { workspaceId: root, app: 2305 }));
    assert.deepEqual([f1.result.snapshots.length, f1.result.fvSnapshots.length, f1.result.fvCurrent], [0, 1, path.basename(p.result.path)]);
    const noFormula = sc(await s.call("fml_edit", { workspaceId: root, app: 2305 }));
    assert.equal(noFormula.status, "invalid", "計算式のダウンロードは無い");
    const e = sc(await s.call("fml_edit", { workspaceId: root, app: 2305, plugin: "field-validation" }));
    assert.deepEqual([e.status, e.result.existed, e.result.from], ["ok", false, p.result.path], JSON.stringify(e));
    assert.match(e.result.next, /fv_update_rows/);
    const mismatch = sc(await s.call("fml_edit", { workspaceId: root, path: p.result.path, plugin: "formula" }));
    assert.equal(mismatch.status, "invalid");
    assert.equal(sc(await s.call("fml_fields", { workspaceId: root, app: 2305 })).status, "ok");
    const sum = sc(await s.call("fv_summary", { workspaceId: root, path: e.result.path }));
    assert.equal(sum.status, "ok", JSON.stringify(sum));
    const up = sc(await s.call("fv_update_rows", { workspaceId: root, path: e.result.path, expectedDigest: sum.digest, rows: rowsJson({ fieldcode: "金額合計", hideSet: "1" }) }));
    assert.equal(up.status, "ok", JSON.stringify(up));
    const snapUp = sc(await s.call("fv_update_rows", { workspaceId: root, path: p.result.path, expectedDigest: p.digest, rows: rowsJson({ fieldcode: "金額合計", hideSet: "1" }) }));
    assert.deepEqual([snapUp.status, snapUp.error.code], ["denied", "PermissionError"], "ダウンロード / pull は書き換えない");
    const d = sc(await s.call("fv_diff", { workspaceId: root, before: p.result.path, after: e.result.path }));
    assert.deepEqual(d.result.changed, ["金額合計"]);
    mkdirSync(path.join(root, "inbox"));
    const name = "rex0220-field-validation-app2305-20261001-090000.json";
    writeFileSync(path.join(root, "inbox", name), readFileSync(path.join(root, p.result.path)));
    const t = sc(await s.call("fml_take", { workspaceId: root }));
    assert.deepEqual(t.result.moved.map((m) => [m.file, m.to]), [[`inbox/${name}`, `${DEV_DIR}/${name}`]], JSON.stringify(t));
    const f2 = sc(await s.call("fml_files", { workspaceId: root, app: 2305 }));
    assert.deepEqual([f2.result.fvSnapshots.length, f2.result.fvEdits.length, f2.result.fvCurrent], [2, 1, path.basename(p.result.path)], "新しい順（先頭が今の設定）");
    assert.ok(!existsSync(path.join(root, "inbox", name)));
    assert.deepEqual(leakedTokens(s.output()), []);
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
