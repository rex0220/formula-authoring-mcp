// fml_docs（手順と資料。計画 24.3）: 目次（版の行、資料の元のコミット、作業の順・決まり、章の一覧）、章、大きい資料は見出しの一覧と query、
// 知らない章は名前の一覧を付けて誤り。作業フォルダーを使わない（未登録・未設定でも読める）。文章だけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, VERSION, connect, connectClaudeCode } from "./helpers.mjs";

const SOURCE = JSON.parse(readFileSync(path.join(ROOT, "references", "template", "SOURCE.json"), "utf8"));
const KEYS = ["howto-new", "howto-edit", "requirements", "explain", "test-app", "results", "constraints", "usable", "connections", "patterns", "spec", "function-list", "test-users", "sample-settings"];
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
