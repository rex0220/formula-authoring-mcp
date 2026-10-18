// fml_workspace_status（作業フォルダーの診断。実装案 5.1 ③、15.8）: 照合は通す（未登録は denied）。動く形、kintone の接続のファイル
// （読めるか、既定の profile、profile ごとの接続先・認証の種類・トークンが使えるか、使えない profile、警告）、アプリのフォルダーの印の状態、
// 使われていない profile のフォルダー、environments.json。接続の誤りがあっても status は ok。秘密の値・環境変数の名前・パスは返さない。読み取りだけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as core from "@rex0220/formula-authoring-tools/core";
import { SKIP as skip, TOKENS, ZIP, connEnv, connectClaudeCode, connectDesktop, leakedTokens, makeConn, makeWorkspace, sc } from "./helpers.mjs";

test("接続のファイルが無い: mode は not-configured、next に設定のしかた（Claude Code は /config）。何も作らない。絶対パスを返さない", { skip }, async () => {
  const root = makeWorkspace();
  const s = await connectClaudeCode([root]);
  try {
    const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
    assert.equal(r.status, "ok");
    assert.deepEqual(r.result.workspace, { name: path.basename(root) });
    assert.equal(r.result.mode, "not-configured");
    assert.deepEqual(r.result.connection, { configured: false, ready: false, problem: { code: "not-configured", message: "kintone の接続のファイルが設定されていない" } });
    assert.match(r.result.next.join("\n"), /\/config で formula の「kintone の接続のファイル」/);
    assert.deepEqual([r.result.pluginZip.readable, r.result.pluginZip.compatible], [true, true]);
    assert.ok(!("legacyEnvironmentsJson" in r.result) && !("environmentsJson" in r.result), "無いときは environments.json のことを返さない（AI が作るものと読み違えた。手での確認 1）");
    assert.ok(!JSON.stringify(r).includes("environments.json"));
    assert.equal(r.result.ready, false);
    assert.ok(!JSON.stringify(r).includes(root), "絶対パスを返さない");
    assert.deepEqual(readdirSync(root), ["fields"], "診断は何も作らない");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("接続のファイル: profile ごとの接続先・認証の種類・tokenApps が使えるか、使えない profile と理由、既定の profile、警告、アプリのフォルダーの印の状態、使われていないフォルダー。秘密の値・環境変数の名前・パスは返さない", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn({
    defaultProfile: "dev",
    profiles: {
      dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP2305: TOKENS.dev2305, APP101: "env:FORMULA_TEST_TOKEN_101" } },
      up: { baseUrl: "https://x.cybozu.com", auth: "userpass", username: "formula-reader", passwordEnv: "FORMULA_TEST_PASSWORD" },
      bad: { baseUrl: "http://x.cybozu.com" }
    }
  });
  if (process.platform !== "win32") chmodSync(conn.file, 0o644);
  // アプリのフォルダー: 印の合うもの（中核が作る）、印の無いもの、使われていない profile のフォルダー（無い profile、使えない profile）
  const set = core.loadConnections(conn.file, { workspaceRoots: [root], env: {} });
  core.ensureAppFolder(path.join(root, "kintone", "dev", "2305-テーブル内集計"), core.pickProfile(set, "dev"), 2305);
  for (const d of ["kintone/dev/101-手作り", "kintone/stage/2305-x", "kintone/bad/2305-x"]) mkdirSync(path.join(root, d), { recursive: true });
  const s = await connectClaudeCode([root], connEnv(conn.file, { FORMULA_TEST_TOKEN_101: "" }));
  try {
    const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.equal(r.result.mode, "profiles");
    const c = r.result.connection;
    assert.deepEqual([c.configured, c.ready, c.fileName, c.defaultProfile], [true, true, "ksql.config.json", { name: "dev", from: "defaultProfile" }]);
    assert.deepEqual(c.profiles, [
      { name: "dev", host: "dev-x.cybozu.com", guestSpaceId: null, auth: "token", tokenApps: [{ appId: 101, ready: false }, { appId: 2305, ready: true }] },
      { name: "up", host: "x.cybozu.com", guestSpaceId: null, auth: "userpass", userpassReady: false }
    ]);
    assert.equal(c.invalidProfiles.length, 1);
    assert.equal(c.invalidProfiles[0].name, "bad");
    assert.match(c.invalidProfiles[0].reason, /baseUrl/);
    if (process.platform !== "win32") assert.match(c.warnings.join("\n"), /ほかの利用者も読める。chmod 600/);
    assert.deepEqual(r.result.appFolders.byProfile.dev, [
      { name: "101-手作り", appId: 101, mark: "missing" },
      { name: "2305-テーブル内集計", appId: 2305, mark: "ok" }
    ]);
    assert.deepEqual(r.result.appFolders.unused, [{ name: "bad", reason: "profile-invalid" }, { name: "stage", reason: "unknown-profile" }]);
    const next = r.result.next.join("\n");
    assert.match(next, /印の無い・壊れた・別の接続のアプリのフォルダーがある（使わない）: kintone\/dev\/101-手作り（missing）/);
    assert.match(next, /kintone\/bad、kintone\/stage/);
    assert.equal(r.result.ready, false);
    const text = s.output();
    assert.deepEqual(leakedTokens(text), []);
    for (const v of ["FORMULA_TEST_TOKEN_101", "FORMULA_TEST_PASSWORD", "formula-reader", conn.file, conn.dir, root]) assert.ok(!text.includes(v), `返さない: ${v}`);
  } finally {
    await s.close();
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("読めない接続のファイル・作業フォルダーの中の接続のファイル: 診断は ok（problem の code）、fml_status の capabilities.kintone も。environments.json が残っていれば移し方", { skip }, async () => {
  const root = makeWorkspace();
  const conn = makeConn();
  try {
    conn.write("{ broken");
    let s = await connectClaudeCode([root], connEnv(conn.file));
    try {
      const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
      assert.equal(r.status, "ok", "診断そのものは成功（読めないことを伝える）");
      assert.equal(r.result.mode, "error");
      assert.deepEqual([r.result.connection.configured, r.result.connection.ready, r.result.connection.fileName, r.result.connection.problem.code], [true, false, "ksql.config.json", "unreadable"]);
      assert.match(r.result.next.join("\n"), /利用者が直す。AI は接続のファイルを読まない・書かない/);
      const st = sc(await s.call("fml_status", {}));
      assert.deepEqual([st.status, st.result.ready, st.result.capabilities.kintone], ["ok", false, { ready: false, fileName: "ksql.config.json", code: "unreadable" }]);
      assert.equal(st.result.capabilities.authoring.ready, true);
      assert.ok(!s.output().includes(conn.file));
    } finally {
      await s.close();
    }
    const inside = path.join(root, "conn.json");
    writeFileSync(inside, "{}");
    s = await connectClaudeCode([root], connEnv(inside));
    try {
      const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
      assert.deepEqual([r.status, r.result.connection.problem.code], ["ok", "inside-workspace"]);
      assert.equal(sc(await s.call("fml_status", {})).result.capabilities.kintone.code, "inside-workspace");
    } finally {
      await s.close();
    }
    // environments.json が残っていて接続のファイルが無い: legacy-blocked と移し方。接続のファイルがあれば読まずに「消してよい」
    writeFileSync(path.join(root, "environments.json"), JSON.stringify({ environments: {} }));
    s = await connectClaudeCode([root], { FORMULA_PLUGIN_ZIP: ZIP });
    try {
      const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
      assert.deepEqual([r.result.mode, r.result.connection.problem.code, r.result.legacyEnvironmentsJson.exists], ["legacy-blocked", "legacy-config-present", true]);
      assert.match(r.result.legacyEnvironmentsJson.note, /tools 2\.0\.0 から使わない.*作らない/);
      assert.match(r.result.next.join("\n"), /environments\.json は tools 2\.0\.0 から使わない。kintone の接続のファイル/);
    } finally {
      await s.close();
    }
    conn.write({ profiles: { dev: { baseUrl: "https://dev-x.cybozu.com" } } });
    s = await connectClaudeCode([root], connEnv(conn.file));
    try {
      const r = sc(await s.call("fml_workspace_status", { workspaceId: root }));
      assert.equal(r.result.mode, "profiles");
      assert.match(r.result.next.join("\n"), /environments\.json は使わない（tools 2\.0\.0 から。接続のファイルを使う）。利用者が消してよい/);
    } finally {
      await s.close();
    }
  } finally {
    conn.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("未登録の workspaceId は denied（照合は通す）。Desktop では workspaceId を省略できる", { skip }, async () => {
  const root = makeWorkspace();
  const other = makeWorkspace("fml-mcp-other-");
  const s = await connectClaudeCode([root]);
  try {
    const r = await s.call("fml_workspace_status", { workspaceId: other });
    assert.deepEqual([sc(r).status, sc(r).error.code], ["denied", "WorkspaceError"]);
  } finally {
    await s.close();
  }
  const d = await connectDesktop(root);
  try {
    const r = sc(await d.call("fml_workspace_status", {}));
    assert.deepEqual([r.status, r.result.workspace], ["ok", { name: path.basename(root) }]);
    assert.match(r.result.next.join("\n"), /拡張機能の設定で「kintone の接続のファイル」を選ぶ/);
  } finally {
    await d.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
