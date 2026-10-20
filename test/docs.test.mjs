// fml_docs（手順と資料。計画 24.3）: 目次（版の行、資料の元のコミット、作業の順・決まり、章の一覧）、章、大きい資料は見出しの一覧と query、
// 知らない章は名前の一覧を付けて誤り。作業フォルダーを使わない（未登録・未設定でも読める）。文章だけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, VERSION, connect, connectClaudeCode } from "./helpers.mjs";

const SOURCE = JSON.parse(readFileSync(path.join(ROOT, "references", "template", "SOURCE.json"), "utf8"));
const KEYS = ["navi", "howto-new", "howto-edit", "requirements", "explain", "try", "qa", "test-app", "results", "constraints", "usable", "connections", "patterns", "patterns-verified", "spec", "function-list", "test-users", "sample-settings"];
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("目次: 1 行目に版、資料の元のコミット、作業の順と決まり（推し量らない、既存のレコードは変わらない）、章の一覧。作業フォルダーが未登録・zip が未設定でも読める。文章だけ", async () => {
  const s = await connect(["--surface", "claude-code", "--roots", ""], {});
  try {
    const { tools } = await s.client.listTools();
    const docs = tools.find((t) => t.name === "fml_docs");
    assert.equal(tools[0].name, "fml_docs", "最初に呼ぶツールを先頭に");
    assert.match(docs.description, /最初に呼ぶ/);
    assert.match(docs.description, /計算式プラグイン（rex0220 formula）/);
    assert.match(docs.description, /集計/);
    assert.equal(docs.annotations.readOnlyHint, true);
    const r = await s.call("fml_docs", {});
    assert.notEqual(r.isError, true);
    assert.equal(r.structuredContent, undefined, "文章だけ");
    const t = textOf(r);
    assert.match(t.split("\n")[0], new RegExp(`^formula MCP ${VERSION.replace(/\./g, "\\.")}（中核`));
    assert.match(t, new RegExp(`資料の元: rex0220/formula-authoring ${SOURCE.short}`));
    assert.match(t, /推し量らない/);
    assert.match(t, /既存のレコードは変わっていない/);
    for (const k of KEYS) assert.match(t, new RegExp(`^- ${k} — `, "m"), k);
  } finally {
    await s.close();
  }
});

test("章: 手順は丸ごと、大きい資料（関数一覧）は見出しの一覧（query で読む）。query は関数名がその節の最初の行にあるものを先に。知らない章は名前の一覧を付けて誤り", async () => {
  const s = await connectClaudeCode([], {});
  try {
    const howto = textOf(await s.call("fml_docs", { section: "howto-new" }));
    assert.match(howto, /fml_save_settings/);
    assert.match(howto, /フィールドコード/);
    assert.match(howto, /仕様の確認/);
    const edit = textOf(await s.call("fml_docs", { section: "howto-edit" }));
    assert.match(edit, /fml_update_fields/);
    const patterns = textOf(await s.call("fml_docs", { section: "patterns" }));
    assert.match(patterns, /TLTABLE/);
    const big = textOf(await s.call("fml_docs", { section: "function-list" }));
    assert.ok(big.length < 32 * 1024, `大きい資料は丸ごと返さない（${big.length}）`);
    assert.match(big, /query/);
    const sumif = textOf(await s.call("fml_docs", { section: "function-list", query: "SUMIF" }));
    assert.match(sumif, /SUMIF/);
    const any = textOf(await s.call("fml_docs", { query: "小計" }));
    assert.match(any, /\[patterns/);
    assert.ok(any.length <= 26 * 1024);
    const sample = textOf(await s.call("fml_docs", { section: "sample-settings" }));
    assert.match(sample, /"pluginID": "rex0220 formula plugin"/);
    const none = textOf(await s.call("fml_docs", { query: "NO_SUCH_FUNCTION_XYZ" }));
    assert.match(none, /合う節は無い/);
    const unknown = await s.call("fml_docs", { section: "howto" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.status, "invalid");
    assert.match(unknown.structuredContent.error.message, /howto-new、howto-edit/);
  } finally {
    await s.close();
  }
});

test("使い方ナビ（navi）と QA（qa。0.3.7）: 目次・指示・fml_docs の説明に案内。navi はテンプレートの使い方ナビ、qa は答えを fml_try で確かめる手順。fml_try を使う場面は 4 か所で同じ（QA を含む）", async () => {
  const s = await connect(["--surface", "claude-code", "--roots", ""], {});
  try {
    const { tools } = await s.client.listTools();
    const docs = tools.find((t) => t.name === "fml_docs");
    const tryTool = tools.find((t) => t.name === "fml_try");
    assert.match(docs.description, /使い方・できること・頼み方を聞かれたとき（navi）、QA（問題と答え）を作るとき（qa）/);
    const index = textOf(await s.call("fml_docs", {}));
    assert.match(index, /頼み方・今の設定の変え方を聞かれたら navi。QA（問題と答え）の作成を頼まれたら qa（答えは fml_try で確かめてから出す）/);
    const instructions = String(s.client.getInstructions?.() ?? "");
    assert.match(instructions, /聞かれたら fml_docs の navi。QA（問題と答え）の作成を頼まれたら fml_docs の qa/);
    const navi = textOf(await s.call("fml_docs", { section: "navi" }));
    for (const h of ["## 1. できること", "## 2. 使い方の流れ", "## 3. 頼み方", "## 4. 今の計算式を変える", "## 5. AI がしないこと"]) assert.ok(navi.includes(h), h);
    for (const id of ["36b77265b178baf754ef", "dca414a52918fa102c01", "20e782175507fbc941a6", "ae83c6d5ce50ff7a9a73"]) assert.ok(navi.includes(id), `記事 ${id}`);
    assert.match(navi, /QA を 10 題作って/);
    const qa = textOf(await s.call("fml_docs", { section: "qa" }));
    assert.match(qa, /答えは推し量らず、必ず `fml_try` で確かめてから出す/);
    assert.match(qa, /`fml_try` 1 回で計算する/);
    const tryGuide = textOf(await s.call("fml_docs", { section: "try" }));
    const rule = "資料と自分の理解が食い違うとき、QA（問題と答え）を作るとき（答えを確かめる";
    for (const [name, text] of [["指示", instructions], ["目次", index], ["fml_try の説明", tryTool.description], ["try の章", tryGuide]]) assert.ok(text.includes(rule), `${name} の fml_try を使う場面に QA`);
  } finally {
    await s.close();
  }
});
