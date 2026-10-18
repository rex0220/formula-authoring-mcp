// 保存した設定の流れ（計画 24.2）: fml_summary（digest、項目）→ fml_update_fields（rows / common、digest 照合、invalid では変えない）→ fml_normalize（check）→
// fml_calc（レコードに当てた前後の値。1 回 10 件まで。normalize のエラーがあれば計算しない）。Worker の出力は標準出力に出ない（JSON-RPC が壊れない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RECORD_TEXT, SETTINGS_TEXT, SKIP as skip, connEnv, connectClaudeCode, makeConn, makeWorkspace, saveInput, sc, settings } from "./helpers.mjs";

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
    assert.deepEqual([unknown.status, unknown.error.code], ["invalid", "NormalizeError"], "設定に無い行は足す行になり、アプリに無い項目は field.missing（MCP 0.3.2 から。それまでは InputError）");
    assert.ok(unknown.findings.some((f) => f.rule === "field.missing"), JSON.stringify(unknown.findings));
    const notCommon = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: up.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 1 }), common: JSON.stringify({ pluginFoo: 1 }) }));
    assert.deepEqual([notCommon.status, notCommon.error.code], ["invalid", "InputError"], "共通の設定でないキー（COMMON_KEYS の外）");
    // 設定に無い行を足す（ヘッダーの行。MCP 0.3.2）: 差分は added、ボタン・表示の行は ★ にしない
    const addHeader = sc(await s.call("fml_update_fields", { workspaceId: root, path: "settings/APP2305-テーブル内集計.json", expectedDigest: up.digest, rows: rowsJson({ fieldcode: "($HEADER1)", formulaSet: '"合計 " & 金額合計' }) }));
    assert.equal(addHeader.status, "ok", JSON.stringify(addHeader));
    assert.deepEqual(addHeader.result.diff.fields.map((f) => [f.fieldcode, f.kind, f.affectsRecords, f.display]), [["($HEADER1)", "added", false, true]]);
    up.digest = addHeader.digest;
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

test("fml_calc: 応答全体を 64 KiB に収める（長い値は切る、行は減らす）。レコード番号は重複を除く", { skip }, async () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "records"));
  const rec = JSON.parse(RECORD_TEXT);
  // 商品（テーブルの子の文字列）に 50,000 文字の値を 4 行分
  for (const row of rec.record.テーブル.value) row.value.商品.value = "長".repeat(50000);
  writeFileSync(path.join(root, "records", "2305-7.json"), JSON.stringify(rec));
  // 10 件（番号 7〜16）に同じ中身を置き、全項目を返させる = 切った後の値（2,000 文字 × 4 行 × 10 件）でも上限を超え、全体の打ち切りが必ず動く（Codex の r3 レビュー N2）
  for (let id = 8; id <= 16; id++) writeFileSync(path.join(root, "records", `2305-${id}.json`), JSON.stringify({ ...rec, id, record: { ...rec.record, $id: { type: "__ID__", value: String(id) } } }));
  const s = await connectClaudeCode([root]);
  try {
    assert.equal(sc(await s.call("fml_save_settings", saveInput(root, "settings/a.json"))).status, "ok");
    const r = await s.call("fml_calc", { workspaceId: root, path: "settings/a.json", records: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16], all: true });
    const c = sc(r);
    assert.equal(c.status, "ok", JSON.stringify(c).slice(0, 300));
    assert.equal(c.result.records.length, 10);
    const dup = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/a.json", records: [7, 7] }));
    assert.equal(dup.result.records.length, 1, "重複は 1 つにする");
    assert.ok(Buffer.byteLength(JSON.stringify(c), "utf8") <= 64 * 1024, "structuredContent 全体（打ち切りの finding を含む）が上限の中");
    assert.ok(c.findings.some((f) => f.rule === "truncated"), "全体の打ち切りが動いた");
    assert.ok(c.result.records.some((x) => (x.linesOmitted ?? 0) > 0), "行を減らした");
    assert.ok(typeof r.content[0].text === "string" && r.content[0].text.length > 0, "content にも同じ中身");
    const one = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/a.json", records: [7] }));
    assert.ok(Buffer.byteLength(JSON.stringify(one), "utf8") <= 64 * 1024);
    assert.ok(JSON.stringify(one).includes("文字を切った") || one.findings.some((f) => f.rule === "truncated"), "切ったことが分かる");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker の中の想定外の例外（壊れた項目定義で中核が TypeError。文に値が入る）: 文を返さない（種類だけ）。fml_normalize も fml_save_settings も（Codex の r2 レビュー R1）", { skip }, async () => {
  const root = makeWorkspace();
  // 項目の定義が null だと中核の normalize（項目定義の組み立て）が TypeError を投げる（生の文 "Cannot set properties of null (setting 'ptcode')"）
  const orig = JSON.parse(readFileSync(path.join(root, "fields", "2305.json"), "utf8"));
  const broken = { ...orig, properties: { ...orig.properties, 金額合計: null } };
  writeFileSync(path.join(root, "fields", "2305.json"), JSON.stringify(broken));
  const s = await connectClaudeCode([root]);
  try {
    const saved = sc(await s.call("fml_save_settings", saveInput(root, "settings/a.json")));
    assert.equal(saved.status, "failed", JSON.stringify(saved));
    assert.ok(!saved.error.message.includes(root) && !/Cannot|ptcode|null/.test(saved.error.message), `生の文を返さない: ${saved.error.message}`);
    assert.match(saved.error.message, /想定外の誤り/);
    assert.ok(!existsSync(path.join(root, "settings", "a.json")), "保存しない");
    mkdirSync(path.join(root, "settings"), { recursive: true });
    writeFileSync(path.join(root, "settings", "b.json"), settings());
    const norm = sc(await s.call("fml_normalize", { workspaceId: root, path: "settings/b.json" }));
    assert.equal(norm.status, "failed", JSON.stringify(norm));
    assert.ok(!/Cannot|ptcode|null/.test(norm.error.message), norm.error.message);
    assert.deepEqual([norm.error.code], ["TypeError"], "種類は返す");
    assert.ok(!s.output().includes("Cannot set"), "標準エラーにも文を出さない");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fml_calc: 接続のファイルの baseUrl がとても長くても（固定の部分）、contextBaseUrl は 300 文字までで応答は上限の中（Codex の r4 レビュー M1）", { skip }, async () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "records"));
  writeFileSync(path.join(root, "records", "2305-7.json"), RECORD_TEXT);
  const huge = `https://${"a".repeat(70000)}.cybozu.com`;
  const conn = makeConn({ defaultProfile: "big", profiles: { big: { baseUrl: huge, tokenMap: { APP2305: "TEST-big-not-a-real-token" } } } });
  const s = await connectClaudeCode([root], connEnv(conn.file));
  try {
    assert.equal(sc(await s.call("fml_save_settings", saveInput(root, "settings/a.json"))).status, "ok");
    const c = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/a.json", records: [7], profile: "big" }));
    assert.equal(c.status, "ok", JSON.stringify(c).slice(0, 300));
    assert.ok(c.result.contextBaseUrl.length <= 301, "接続先は 300 文字まで");
    assert.ok(Buffer.byteLength(JSON.stringify(c), "utf8") <= 64 * 1024, "応答が上限の中");
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fml_calc: ボタンのクリックの模擬（click。MCP 0.3.0）: 計算後の実レコードで押し、押す前の表示と押した後に変わる項目（FSET_TADD の行、再計算）を返す。行が無い・ボタンでない式は invalid", { skip }, async () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "records"));
  writeFileSync(path.join(root, "records", "2305-7.json"), RECORD_TEXT);
  mkdirSync(path.join(root, "policy"));
  writeFileSync(path.join(root, "policy", "authoring-policy.json"), JSON.stringify({ allowFunctions: ["BUTTON", "FSET_TADD"], allowMiscChanges: true }));
  const s = await connectClaudeCode([root]);
  try {
    // 2305 にはスペース項目が無いので、チェックボックス（商品セット）の行にボタンを置く（normalize は型を問わない。実機ではスペース項目かヘッダーに置く）
    const base = JSON.parse(SETTINGS_TEXT);
    const row = { ...base.pluginInfos[0], fieldcode: "商品セット", formulaSet: "BUTTON(\"行を追加\", FSET_TADD(テーブル, \"[{'商品':'追加','分類':'明細','数量':'1','単価':'10'}]\"))", rank: "" };
    const saved = sc(await s.call("fml_save_settings", saveInput(root, "settings/button.json", settings({ pluginInfos: [...base.pluginInfos, row] }))));
    assert.equal(saved.status, "ok", JSON.stringify(saved));
    const calc = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/button.json", records: [7], click: "商品セット" }));
    assert.equal(calc.status, "ok", JSON.stringify(calc));
    assert.equal(calc.result.click, "商品セット");
    const r7 = calc.result.records[0];
    assert.deepEqual([r7.click.display.TYPE, r7.click.display.TITLE, r7.click.failed], ["BUTTON", "行を追加", false]);
    assert.deepEqual(r7.click.errors, []);
    const table = r7.click.changes.find((l) => l.fieldcode === "テーブル");
    assert.ok(table, JSON.stringify(r7.click.changes));
    assert.equal(table.after.length, table.before.length + 1, "FSET_TADD で 1 行足される");
    const added = table.after[table.after.length - 1].value;
    assert.deepEqual([added.商品.value, added.金額.value], ["追加", "10"], "足した行の 金額 は再計算（数量 × 単価）で入る");
    assert.ok(!calc.findings.some((f) => f.level === "error"), JSON.stringify(calc.findings));
    assert.match(calc.result.note, /既存のレコードは変わっていない/);
    const plain = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/button.json", records: [7] }));
    assert.equal(plain.result.records[0].click, undefined, "click を付けなければ押さない");
    assert.equal(plain.result.click, undefined);
    const notButton = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/button.json", records: [7], click: "金額合計" }));
    assert.deepEqual([notButton.status, notButton.error.code], ["invalid", "InputError"]);
    assert.match(notButton.error.message, /BUTTON \/ DIALOG を使っていない/);
    const noRow = sc(await s.call("fml_calc", { workspaceId: root, path: "settings/button.json", records: [7], click: "(sp1)" }));
    assert.deepEqual([noRow.status, noRow.error.code], ["invalid", "InputError"]);
    assert.ok(!s.stderr().includes("Unexpected token"));
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});
