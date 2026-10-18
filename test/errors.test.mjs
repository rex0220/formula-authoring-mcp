// 誤りの文の扱い（Codex のレビュー BLOCKER 1・3）: Worker の中の例外・想定外の例外の文（レコードの値や zip のパスを含みうる）を返さない。
// User API に無いコードを返さない。src/tools/files.ts を直接読む（Node の型の除去）
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvalError, EvalTimeoutError, InputError, PluginZipError, UsersPullError } from "@rex0220/formula-authoring-tools/core";
import { fromError, setErrorLogger } from "../src/tools/files.ts";
import { describeZipError } from "../src/zip-error.ts";

const SECRET = "RECORD-VALUE-SECRET-/Users/someone/zip.zip";
const sc = (r) => r.structuredContent;

test("Worker の中の例外: 入力の誤りはそのまま（invalid）、zip の誤りは種類ごとの決まった文、それ以外は種類だけ（文は返さない。標準エラーにも文を出さない）", () => {
  const logged = [];
  setErrorLogger((l) => logged.push(l));
  const input = sc(fromError(new EvalError("項目定義のファイルが無い: fields/1.json", "InputError", undefined, "input")));
  assert.deepEqual([input.status, input.error.code, input.error.message], ["invalid", "InputError", "項目定義のファイルが無い: fields/1.json"]);
  const zip = sc(fromError(new EvalError(`計算式プラグインの zip が無い: ${SECRET}`, "PluginZipError", "missing", "zip")));
  assert.deepEqual([zip.status, zip.error.code], ["failed", "PluginZipError"]);
  assert.match(zip.error.message, /計算式プラグインの zip が無い/);
  assert.ok(!zip.error.message.includes(SECRET));
  const other = sc(fromError(new EvalError(`Cannot read ${SECRET}`, "TypeError")));
  // name を偽装した例外（kind は other のまま）も文を返さない
  const forged = sc(fromError(new EvalError(`forged ${SECRET}`, "InputError", undefined, "other")));
  assert.deepEqual([forged.status, forged.error.code], ["failed", "InputError"]);
  assert.ok(!forged.error.message.includes(SECRET) && !forged.error.message.includes("forged"));
  assert.deepEqual([other.status, other.error.code], ["failed", "TypeError"]);
  assert.ok(!other.error.message.includes(SECRET) && !other.error.message.includes("Cannot read"));
  assert.match(other.error.message, /想定外の誤り（TypeError）/);
  const timeout = sc(fromError(new EvalTimeoutError("評価が 2 秒を超えたので止めた")));
  assert.deepEqual([timeout.status, timeout.error.code], ["failed", "EvalTimeoutError"]);
  assert.ok(!logged.join("\n").includes(SECRET), "標準エラーにも文を出さない");
  assert.ok(logged.some((l) => /TypeError/.test(l)), "種類は標準エラーに残す");
});

test("想定外の例外: 種類だけ（文は返さない）。PluginZipError（主スレッド）は種類ごとの決まった文", () => {
  setErrorLogger(() => undefined);
  const r = sc(fromError(new RangeError(`too big: ${SECRET}`)));
  assert.deepEqual([r.status, r.error.code], ["failed", "RangeError"]);
  class Evil extends Error {}
  Object.defineProperty(Evil, "name", { value: "SECRET-CTOR" });
  const evil = sc(fromError(Object.assign(new Evil("x"), { name: "SECRET-NAME" })));
  assert.deepEqual([evil.status, evil.error.code], ["failed", "Error"], "constructor.name と name は使わない");
  assert.ok(!JSON.stringify(evil).includes("SECRET"));
  assert.ok(!r.error.message.includes(SECRET) && !r.error.message.includes("too big"));
  const z = sc(fromError(new PluginZipError(`zip: ${SECRET}`, "not-formula", { pluginVersion: "7" })));
  assert.deepEqual([z.status, z.error.code], ["failed", "PluginZipError"]);
  assert.ok(!z.error.message.includes(SECRET));
  const inp = sc(fromError(new InputError("fields が要る")));
  assert.deepEqual([inp.status, inp.error.message], ["invalid", "fields が要る"]);
});

test("User API に無いコード: 式が参照しているコードを返さない（種類だけ）。呼び出し数の上限の文はそのまま", () => {
  const r = sc(fromError(new UsersPullError("式が参照しているユーザーが無い: user_secret1, user_secret2（コードを確かめる。全部取るなら --only-referenced を外す）")));
  assert.deepEqual([r.status, r.error.code], ["failed", "UsersPullError"]);
  assert.ok(!r.error.message.includes("user_secret1"));
  assert.match(r.error.message, /式が参照しているユーザーが無い（コードは返さない/);
  const org = sc(fromError(new UsersPullError("式が参照している組織が無い: org_x（コードを確かめる）")));
  assert.ok(!org.error.message.includes("org_x"));
  const max = sc(fromError(new UsersPullError("User API の呼び出しが 300 回を超えた（--max で上げる）")));
  assert.match(max.error.message, /300 回/);
});

test("describeZipError: PluginZipError でない例外（zip の authoring API の getter など）は組み込みの名前だけ（fml_status / fml_workspace_status の文）", () => {
  class Evil extends TypeError {}
  Object.defineProperty(Evil, "name", { value: "SECRET-CTOR" });
  const r = describeZipError(Object.assign(new Evil(SECRET), { name: "SECRET-NAME" }), "claude-code");
  assert.equal(r.code, "unexpected");
  assert.match(r.text, /想定外の誤り: TypeError/);
  assert.ok(!r.text.includes("SECRET"));
});
