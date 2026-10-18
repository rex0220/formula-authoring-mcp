// kintone に接続するツール（計画 24.2）: fml_fields、fml_record、fml_users、Desktop だけの kintone_get_app / kintone_list_records。
// kintone は test/mock-fetch.mjs の偽物（Node の --import）。接続は kintone の接続のファイル（kSQL の形。作業フォルダーの外）の profile だけ。
// GET だけ、アプリごとのトークン、値を返さない、秘密の値・接続のファイルのパス・kintone のサーバーの文を返さない、接続の誤りの status と code を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONN, SKIP as skip, TOKENS, connEnv, connectClaudeCode, connectDesktop, fetchLog, leakedTokens, makeConn, makeWorkspace, sc, tokenHash } from "./helpers.mjs";

/** レコードの値・サーバーの文（応答に出てはいけない） */
const VALUES = ["部品X", "部品Y", "セットA", "DESCRIPTION-SECRET", "SERVER-SECRET-MESSAGE", "架空ユーザー01", "demo_user01"];
const noValues = (s) => VALUES.filter((v) => s.includes(v));
const APP_DIR = "kintone/dev/2305-テーブル内集計";

test("fml_fields: profile（無ければ defaultProfile）で取り、kintone/<profile>/<番号>-<アプリ名>/fields.json に保存（印を先に置く）。アプリごとのトークン、GET だけ、OS の KINTONE_* は読まない。要約は ○ 付き", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const log = fetchLog();
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_FETCH_LOG: log.file }), { mockFetch: true });
  try {
    const r = sc(await s.call("fml_fields", { workspaceId: root, app: 2305 }));
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.deepEqual([r.result.path, r.result.appId, r.result.appName, r.result.profile, r.result.baseUrl], [`${APP_DIR}/fields.json`, 2305, "テーブル内集計", "dev", "https://dev-x.cybozu.com"]);
    assert.match(r.result.auth, /API トークン（profile dev）/);
    assert.match(r.result.summary, /金額合計/);
    assert.match(r.result.summary, /○/, "計算式を設定できる型の印（zip を読んだ）");
    assert.equal(r.result.viewCount, 1);
    const mark = JSON.parse(readFileSync(path.join(root, APP_DIR, ".formula-app.json"), "utf8"));
    assert.deepEqual(mark, { schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: null, appId: 2305 });
    const reqs = log.requests();
    assert.ok(reqs.length >= 3 && reqs.every((q) => q.method === "GET" && q.host === "dev-x.cybozu.com"), JSON.stringify(reqs));
    assert.ok(reqs.every((q) => q.token === tokenHash(TOKENS.dev2305)), "アプリ 2305 のトークン");
    assert.ok(reqs.some((q) => /app\/views/.test(q.path)), "一覧も取る");
    // env: のトークン（APP101）と、prod の profile
    const r101 = sc(await s.call("fml_fields", { workspaceId: root, app: 101 }));
    assert.equal(r101.status, "ok", JSON.stringify(r101));
    assert.ok(log.requests().some((q) => q.query.app === "101" && q.token === tokenHash(TOKENS.dev101)), "env: の参照先のトークン");
    const prod = sc(await s.call("fml_fields", { workspaceId: root, app: 2305, profile: "prod" }));
    assert.deepEqual([prod.status, prod.result.path, prod.result.baseUrl], ["ok", "kintone/prod/2305-テーブル内集計/fields.json", "https://x.cybozu.com"]);
    // 無いアプリ: failed（サーバーの文は返さない）。知らない profile は invalid
    const none = sc(await s.call("fml_fields", { workspaceId: root, app: 9999 }));
    assert.deepEqual([none.status, none.error.code], ["failed", "RestError"]);
    const unknownProfile = sc(await s.call("fml_fields", { workspaceId: root, app: 2305, profile: "nope" }));
    assert.deepEqual([unknownProfile.status, unknownProfile.error.code], ["invalid", "unknown-profile"]);
    assert.deepEqual(noValues(s.output()), []);
    assert.deepEqual(leakedTokens(s.output()), []);
    assert.ok(!s.output().includes("other.cybozu.com"), "OS の KINTONE_BASE_URL は読まない");
  } finally {
    await s.close();
    conn.cleanup();
    log.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fml_record: アプリのフォルダーの records/<番号>.json に保存（本人だけが読める）。形の要約だけ返す（値は返さない）。フォルダーが無ければ止める", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const s = await connectClaudeCode([root], connEnv(conn.file), { mockFetch: true });
  try {
    const before = sc(await s.call("fml_record", { workspaceId: root, app: 2305, id: 7 }));
    assert.deepEqual([before.status, before.error.code], ["invalid", "InputError"], "先に fml_fields");
    assert.equal(sc(await s.call("fml_fields", { workspaceId: root, app: 2305 })).status, "ok");
    const r = sc(await s.call("fml_record", { workspaceId: root, app: 2305, id: 7 }));
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.equal(r.result.path, `${APP_DIR}/records/7.json`);
    assert.match(r.result.shape, /テーブル/);
    const file = path.join(root, APP_DIR, "records", "7.json");
    assert.ok(existsSync(file));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    // 既にある 0644 のファイルを取り直しても 0600 にする（writeFileSync の mode は作るときだけ。Codex のレビュー BLOCKER 2）
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      assert.equal(sc(await s.call("fml_record", { workspaceId: root, app: 2305, id: 7 })).status, "ok");
      assert.equal(statSync(file).mode & 0o777, 0o600, "取り直した後も本人だけ");
      assert.deepEqual(readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), [], "一時ファイルを残さない");
    }
    assert.deepEqual(noValues(s.output()), [], "レコードの値を返さない");
    const missing = sc(await s.call("fml_record", { workspaceId: root, app: 2305, id: 999 }));
    assert.deepEqual([missing.status, missing.error.code], ["failed", "RestError"]);
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fml_users: User API（Bearer の userApiToken）から users/<ホスト>.json に保存（0o600）。件数だけ返す。onlyReferenced で参照が無ければ何も書かない。file で既存の要約", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const log = fetchLog();
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_FETCH_LOG: log.file }), { mockFetch: true });
  try {
    const r = sc(await s.call("fml_users", { workspaceId: root }));
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.match(r.result.path, /^users\/.*dev-x.*\.json$/);
    assert.deepEqual([r.result.users, r.result.orgs, r.result.groups], [3, 1, 1]);
    assert.ok(r.result.calls >= 3);
    assert.match(r.result.auth, /profile dev/);
    const file = path.join(root, r.result.path);
    assert.ok(existsSync(file));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const reqs = log.requests();
    assert.ok(reqs.every((q) => q.method === "GET" && q.bearer !== null && q.token === null), "User API は Bearer（アプリのトークンは送らない）");
    assert.deepEqual(noValues(s.output()), [], "ユーザーのコードや名前を返さない");
    const again = sc(await s.call("fml_users", { workspaceId: root, file: r.result.path }));
    assert.deepEqual([again.status, again.result.users], ["ok", 3]);
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      assert.equal(sc(await s.call("fml_users", { workspaceId: root })).status, "ok");
      assert.equal(statSync(file).mode & 0o777, 0o600, "取り直した後も本人だけ（BLOCKER 2）");
    }
    // users/ の外のファイルはユーザー情報として読まない（settings/ や fields/ の JSON。Codex のレビュー MAJOR 6）
    const outside = sc(await s.call("fml_users", { workspaceId: root, file: "fields/2305.json" }));
    assert.deepEqual([outside.status, outside.error.code], ["denied", "PermissionError"]);
    assert.equal(sc(await s.call("fml_save_settings", { workspaceId: root, path: "settings/u.json", content: readFileSync(new URL("./fixtures/settings-2305.json", import.meta.url), "utf8"), fields: "fields/2305.json", expectedAbsent: true })).status, "ok");
    const asUsers = sc(await s.call("fml_normalize", { workspaceId: root, path: "settings/u.json", users: "settings/u.json" }));
    assert.deepEqual([asUsers.status, asUsers.error.code], ["denied", "PermissionError"]);
    // users/ の中の symlink が外（settings/）を指すものも読まない（実体で判定）
    symlinkSync(path.join(root, "settings", "u.json"), path.join(root, "users", "link.json"));
    const viaLink = sc(await s.call("fml_users", { workspaceId: root, file: "users/link.json" }));
    assert.deepEqual([viaLink.status, viaLink.error.code], ["denied", "PermissionError"]);
    // 参照するコードが無い設定
    assert.equal(sc(await s.call("fml_save_settings", { workspaceId: root, path: "settings/a.json", content: readFileSync(new URL("./fixtures/settings-2305.json", import.meta.url), "utf8"), fields: "fields/2305.json", expectedAbsent: true })).status, "ok");
    const only = sc(await s.call("fml_users", { workspaceId: root, onlyReferenced: "settings/a.json" }));
    assert.equal(only.status, "ok", JSON.stringify(only));
    assert.equal(only.result.path, null);
    assert.match(only.result.summary, /ユーザー情報の関数.*が無い/);
    assert.deepEqual(leakedTokens(s.output()), []);
  } finally {
    await s.close();
    conn.cleanup();
    log.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop: kintone_get_app は決めた項目だけ（説明・作成者は返さない）、URL も受け付ける。kintone_list_records は 5 件の形だけ（値は返さない）", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const s = await connectDesktop(root, connEnv(conn.file), { mockFetch: true });
  try {
    const app = sc(await s.call("kintone_get_app", { app: 2305 }));
    assert.equal(app.status, "ok", JSON.stringify(app));
    assert.deepEqual(app.result, { appId: 2305, name: "テーブル内集計", code: "", spaceId: null, threadId: null, profile: "dev", baseUrl: "https://dev-x.cybozu.com" });
    const byUrl = sc(await s.call("kintone_get_app", { app: "https://dev-x.cybozu.com/k/2305/show#record=7" }));
    assert.equal(byUrl.result.appId, 2305);
    const otherHost = sc(await s.call("kintone_get_app", { app: "https://x.cybozu.com/k/2305/" }));
    assert.deepEqual([otherHost.status, otherHost.error.code], ["invalid", "InputError"], "別の接続先の URL から番号だけを使わない");
    const list = sc(await s.call("kintone_list_records", { app: 2305, query: "order by $id desc" }));
    assert.equal(list.status, "ok", JSON.stringify(list));
    assert.equal(list.result.records.length, 5);
    const bad = sc(await s.call("kintone_list_records", { app: 2305, query: "limit 100" }));
    assert.deepEqual([bad.status, bad.error.code], ["invalid", "QueryError"]);
    assert.deepEqual(noValues(s.output()), []);
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("呼び出しの途中で接続のファイルが変わったら conflict（connection-changed）。何も書かない", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  const rewrite = path.join(conn.dir, "rewrite.json");
  const changed = { ...CONN, profiles: { ...CONN.profiles, dev: { ...CONN.profiles.dev, baseUrl: "https://x.cybozu.com" } } };
  writeFileSync(rewrite, JSON.stringify({ target: conn.file, content: changed }));
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_REWRITE_CONN: rewrite }), { mockFetch: true });
  try {
    const r = sc(await s.call("fml_fields", { workspaceId: root, app: 2305 }));
    assert.deepEqual([r.status, r.error.code], ["conflict", "connection-changed"], JSON.stringify(r));
    assert.ok(!existsSync(path.join(root, "kintone")), "何も書かない");
    assert.deepEqual(leakedTokens(s.output()), []);
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
