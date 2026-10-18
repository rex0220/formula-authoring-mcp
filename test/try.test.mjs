// fml_try（式の試し計算。計画 25 章）: 同梱のサンプルアプリに式ごとに 1 行だけの設定を組んで normalize → calc。作業フォルダーのファイルは読まない・書かない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { SKIP as skip, connectClaudeCode, makeWorkspace, sc } from "./helpers.mjs";

test("fml_try: 数値・テーブルの中・日付の値（型に入れた後の値と生の値）、誤りの式は findings、describe で項目の一覧。作業フォルダーに何も書かない", { skip }, async () => {
  const root = makeWorkspace();
  const before = readdirSync(root);
  const s = await connectClaudeCode([root]);
  try {
    const r = sc(await s.call("fml_try", {
      workspaceId: root,
      formulas: [
        { formula: "ROUND(数値1 / 3, 2)", as: "NUMBER" },
        { formula: "T1_数値 * 2", as: "NUMBER", table: "テーブル1" },
        { formula: 'DATE_FORMAT(日付1, "YYYY/MM/DD")' },
        { formula: "NOSUCH(1)" },
        { formula: "1", as: "FILE" }
      ],
      describe: true
    }));
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.deepEqual([r.result.app.appId, r.result.app.source, r.result.app.records], [4329, "sample", ["1", "2", "3"]]);
    const [round, row, date, unknown, file] = r.result.results;
    assert.deepEqual([round.status, round.target, round.values.map((v) => v.value)], ["ok", { code: "数値2", type: "NUMBER" }, ["411.33", "0", ""]]);
    assert.equal(round.values[0].raw, 411.33);
    assert.deepEqual([row.target, row.values.map((v) => v.value)], [{ code: "T1_数値", type: "NUMBER", table: "テーブル1" }, [["200", "400", "600"], ["0"], []]]);
    assert.deepEqual(date.values.map((v) => v.value), ["2026/01/15", "2026/02/28", ""]);
    assert.equal(unknown.status, "invalid");
    assert.ok(unknown.findings.some((f) => f.rule === "formula.unknown-function"));
    assert.equal(file.status, "invalid");
    assert.ok(file.findings.some((f) => f.rule === "try.target"));
    assert.deepEqual(r.findings.filter((f) => f.level === "error").map((f) => f.rule), ["try.invalid", "try.invalid"], "ok でない式は findings に");
    assert.match(r.findings.find((f) => f.rule === "try.invalid").message, /^\[4\] formula\.unknown-function/);
    assert.match(r.result.summary, /試し計算 5 式: ok 3、エラー 2/);
    assert.match(r.result.contextLine, /アプリ 4329、ログインユーザー authoring/);
    assert.match(r.result.fields, /数値1  NUMBER  ○/);
    assert.match(r.result.fields, /1: 典型/);
    assert.match(r.result.note, /サンプルアプリ（架空）での模擬/);
    assert.deepEqual(readdirSync(root), before, "作業フォルダーに何も書かない");

    const only2 = sc(await s.call("fml_try", { workspaceId: root, formulas: [{ formula: "数値2" }], records: [2] }));
    assert.equal(only2.status, "ok", JSON.stringify(only2));
    assert.deepEqual(only2.result.results[0].values, [{ record: "2", value: "-12.345", raw: -12.345 }]);
    assert.equal(only2.result.fields, undefined, "describe を付けなければ項目の一覧は返さない");

    const ev = sc(await s.call("fml_try", { workspaceId: root, formulas: [{ formula: 'EV_INFO("type")' }, { formula: "LOGIN_CODE()" }], records: [1], event: "app.record.create.show", user: "demo_user03" }));
    assert.equal(ev.status, "ok", JSON.stringify(ev));
    assert.deepEqual(ev.result.results.map((x) => x.values[0].value), ["app.record.create.show", "demo_user03"]);

    // 架空の項目と値（案 1・案 2）: 標本に項目を足し、簡略形の値のレコードで計算
    const custom = sc(await s.call("fml_try", {
      workspaceId: root,
      formulas: [{ formula: 'SUMIF(分類 = "明細", 金額)', as: "NUMBER" }, { formula: "単価 * 2", as: "NUMBER" }],
      fields: [{ code: "単価", type: "NUMBER" }, { code: "明細", type: "SUBTABLE", fields: [{ code: "分類", type: "DROP_DOWN", options: ["明細", "小計"] }, { code: "金額", type: "NUMBER" }] }],
      data: [{ 単価: 100, 明細: [{ 分類: "明細", 金額: 200 }, { 分類: "小計", 金額: 200 }] }, { 単価: -1.5 }]
    }));
    assert.equal(custom.status, "ok", JSON.stringify(custom));
    assert.deepEqual([custom.result.app.records, custom.result.app.extraFields], [["d1", "d2"], ["単価（NUMBER）", "明細（SUBTABLE: 分類, 金額）"]]);
    assert.deepEqual(custom.result.results.map((x) => [x.target.code, x.values.map((v) => v.value)]), [["単価", ["200", "0"]], ["数値1", ["200", "-3"]]], "型の指定なら式が使わない項目（短いコードの順。単価 を使う式の対象は 数値1）");
    const badData = sc(await s.call("fml_try", { workspaceId: root, formulas: [{ formula: "1" }], data: [{ ドロップダウン1: "Z" }] }));
    assert.deepEqual([badData.status, badData.error.code], ["invalid", "InputError"]);
    assert.match(badData.error.message, /data\[0\]\.ドロップダウン1: 選択肢に無い値 "Z"/);
    const badField = sc(await s.call("fml_try", { workspaceId: root, formulas: [{ formula: "1" }], fields: [{ code: "x", type: "DROP_DOWN" }] }));
    assert.match(badField.error.message, /fields\[0\]: DROP_DOWN には options/);

    // 利用者のアプリの項目定義（案 3）: 作業フォルダーの fields/2305.json に架空の値。標本のレコードは使えない
    const app = sc(await s.call("fml_try", {
      workspaceId: root, app: 2305,
      formulas: [{ formula: 'SUMIF(分類="小計", 金額)', as: "金額合計" }],
      data: [{ テーブル: [{ 分類: "明細", 金額: 200 }, { 分類: "小計", 金額: 200 }] }]
    }));
    assert.equal(app.status, "ok", JSON.stringify(app));
    assert.deepEqual([app.result.app.source, app.result.app.appId, app.result.app.records], ["app", 2305, ["d1"]]);
    assert.deepEqual(app.result.results[0].values, [{ record: "d1", value: "200", raw: 200 }]);
    assert.match(app.result.note, /利用者のアプリの項目定義に架空の値/);
    const appNoData = sc(await s.call("fml_try", { workspaceId: root, app: 2305, formulas: [{ formula: "1" }] }));
    assert.deepEqual([appNoData.status, appNoData.error.code], ["invalid", "InputError"]);
    const appMissing = sc(await s.call("fml_try", { workspaceId: root, app: 9999, formulas: [{ formula: "1" }], data: [{}] }));
    assert.match(appMissing.error.message, /項目定義のファイルが無い: fields\/9999\.json/);
    const appProfile = sc(await s.call("fml_try", { workspaceId: root, app: 2305, profile: "dev", formulas: [{ formula: "1" }], data: [{}] }));
    assert.match(appProfile.error.message, /profile は kintone の接続のファイルがあるときだけ/);

    // 引数の誤り: スキーマ（11 式、records 4、知らないキー、data 6 件、fields の知らないキー）は MCP が止める。users は users/ の中だけ
    for (const bad of [
      { workspaceId: root, formulas: Array.from({ length: 11 }, () => ({ formula: "1" })) },
      { workspaceId: root, formulas: [{ formula: "1" }], records: [4] },
      { workspaceId: root, formulas: [{ formula: "1", foo: 1 }] },
      { workspaceId: root, formulas: [] },
      { workspaceId: root, formulas: [{ formula: "1" }], data: [{}, {}, {}, {}, {}, {}] },
      { workspaceId: root, formulas: [{ formula: "1" }], fields: [{ code: "x", type: "NUMBER", foo: 1 }] }
    ]) {
      const b = await s.call("fml_try", bad);
      assert.ok(b.isError, JSON.stringify(b));
    }
    const users = await s.call("fml_try", { workspaceId: root, formulas: [{ formula: "1" }], users: "fields/2305.json" });
    assert.deepEqual([sc(users).status, sc(users).error.code], ["denied", "PermissionError"], "users は users/ の中のファイルだけ");
    assert.ok(!s.output().includes("TEST-not-a-real-token"), "秘密の値を出さない");
  } finally {
    await s.close();
  }
});
