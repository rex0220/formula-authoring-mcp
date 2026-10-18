// 保存した設定の流れ（計画 24.2）: fml_summary（digest、項目）→ fml_update_fields（rows / common、digest 照合、invalid では変えない）→ fml_normalize（check）→
// fml_calc（レコードに当てた前後の値。1 回 10 件まで。normalize のエラーがあれば計算しない）。Worker の出力は標準出力に出ない（JSON-RPC が壊れない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RECORD_TEXT, SKIP as skip, connectClaudeCode, makeWorkspace, saveInput, sc, settings } from "./helpers.mjs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rowsJson = (...rows) => JSON.stringify(rows);

test("fml_summary → fml_update_fields → fml_normalize（check）→ fml_calc の流れ（settings/ と records/<app>-<id>.json）", { skip }, async () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "records"));
  writeFileSync(path.join(root, "records", "2305-7.json"), RECORD_TEXT);
  const s = await connectClaudeCode([root]);
  try {
    const saved = sc(await s.call("fml_save_settings", saveInput(root, "settings/APP2305-テーブル内集計.json")));
    assert.equal(saved.status, "ok", JSON.stringify(saved));
    const file = path.join(root, "settings", "APP2305-テーブル内集計.json");

    const sum = sc(await s.call("fml_summary", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json" }));
    assert.equal(sum.status, "ok", JSON.stringify(sum));
    assert.equal(sum.digest, sha(file));
    assert.deepEqual([sum.result.appId, sum.result.appName, sum.result.pluginVersion, sum.result.fieldCount], [2305, "テーブル内集計", "101", 6]);
    assert.ok(sum.result.fieldcodes.includes("金額合計"));
    assert.match(sum.result.text, /金額合計/);
    assert.doesNotMatch(sum.result.text, /各種設定の既定との差は出していない/);
    const one = sc(await s.call("fml_summary", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", field: "金額合計" }));
    assert.match(one.result.text, /SUMIF\(分類="小計",金額\)/);

    // 差し替え: ランクと共通の設定。digest が変わり、diff に項目が出る
    const up = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: sum.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 5 }), common: JSON.stringify({ pluginEnable: false }) }));
    assert.equal(up.status, "ok", JSON.stringify(up));
    assert.equal(up.digest, sha(file));
    assert.notEqual(up.digest, sum.digest);
    assert.deepEqual(up.result.diff.fields.map((f) => [f.fieldcode, f.keys, f.affectsRecords]), [["金額合計", ["rank"], true]], "ランクは計算の順なので既存レコードの値に影響しうる（中核の判定）");
    assert.ok(up.result.diff.common.some((l) => /pluginEnable/.test(l)));
    const stale = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: sum.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) }));
    assert.deepEqual([stale.status, stale.error.code], ["conflict", "ConflictError"]);
    const unknown = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: up.digest, rows: rowsJson({ fieldcode: "存在しない", rank: 1 }) }));
    assert.deepEqual([unknown.status, unknown.error.code], ["invalid", "InputError"]);
    const badFormula = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: up.digest, rows: rowsJson({ fieldcode: "金額合計", formulaSet: "不明な項目 + 1" }) }));
    assert.deepEqual([badFormula.status, badFormula.error.code], ["invalid", "NormalizeError"]);
    assert.equal(sha(file), up.digest, "invalid ではファイルを変えない");

    const norm = sc(await s.call("fml_normalize", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", check: true }));
    assert.equal(norm.status, "ok", JSON.stringify(norm));
    assert.equal(norm.result.checkDiffs.count, 0, "保存した設定は既定値を補った形なので差 0");
    assert.equal(norm.result.appId, 2305);
    assert.ok(norm.findings.some((f) => f.rule === "plugin.disabled"), "pluginEnable: false の警告");

    const calc = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", records: [7] }));
    assert.equal(calc.status, "ok", JSON.stringify(calc));
    assert.equal(calc.result.appId, 2305);
    assert.equal(calc.result.records.length, 1);
    const r7 = calc.result.records[0];
    assert.equal(r7.id, "7");
    assert.equal(r7.failed, false);
    assert.deepEqual(r7.errors, []);
    const total = r7.lines.find((l) => l.fieldcode === "金額合計");
    assert.ok(total, JSON.stringify(r7.lines));
    assert.equal(String(total.after), "800", "明細 2×100 + 3×200 の小計 800 の合計");
    assert.ok(r7.changed > 0);
    assert.match(calc.result.contextLine, /アプリ 2305/);
    assert.match(calc.result.note, /既存のレコードは変わっていない/);
    assert.ok(!calc.findings.some((f) => f.level === "error"), JSON.stringify(calc.findings));
    const none = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", records: [8] }));
    assert.deepEqual([none.status, none.error.code], ["invalid", "InputError"], "レコードのファイルが無い");
    const tooMany = await s.call("fml_calc", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", records: Array.from({ length: 11 }, (_, i) => i + 1) });
    assert.equal(tooMany.isError, true, "1 回 10 件まで");
    assert.ok(!s.stderr().includes("Unexpected token"), "標準出力に Worker の出力が混ざって JSON-RPC が壊れていない");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fml_calc: normalize のエラーがあれば計算しない（invalid）。重い式は時間上限で failed（timeoutSec）", { skip }, async () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "records"));
  writeFileSync(path.join(root, "records", "2305-7.json"), RECORD_TEXT);
  mkdirSync(path.join(root, "settings"));
  const e = JSON.parse(settings());
  e.pluginInfos[0].formulaSet = "不明な項目 + 1";
  writeFileSync(path.join(root, "settings", "bad.json"), JSON.stringify(e));
  const heavy = JSON.parse(settings());
  heavy.pluginInfos[0].formulaSet = "ARRAY_COUNT(ARRAY_FOR(100000,i,ARRAY_FOR(100,j,i*j)))";
  writeFileSync(path.join(root, "settings", "heavy.json"), JSON.stringify(heavy));
  const s = await connectClaudeCode([root]);
  try {
    const bad = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/bad.json", records: [7] }));
    assert.deepEqual([bad.status, bad.error.code], ["invalid", "NormalizeError"]);
    assert.ok(bad.findings.some((f) => f.rule === "formula.ref"));
    const t0 = Date.now();
    const slow = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/heavy.json", records: [7], timeoutSec: 2 }));
    assert.deepEqual([slow.status, slow.error.code], ["failed", "EvalTimeoutError"], JSON.stringify(slow));
    assert.ok(Date.now() - t0 < 20000, "数秒で止まる");
    // 時間切れの後も次の呼び出しは動く（Worker は呼び出しごと）
    const n = sc(await s.call("fml_normalize", { workspaceId: root, path: "settings/bad.json" }));
    assert.equal(n.status, "invalid");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});
