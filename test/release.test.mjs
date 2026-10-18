// 配布の部品の試験（リリース手順 0-3・0-7・0-9）: 入れてはいけないもの、著作権表示、zip、marketplace.json
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_URL } from "../build-mcpb.mjs";
import { forbiddenReasons, problemsOf, realHosts, repoProblems } from "../scripts/forbidden-files.mjs";
import { bundledPackages, packageDir, renderNotices, sourceUrl } from "../scripts/third-party-notices.mjs";
import { marketplace } from "../scripts/write-marketplace.mjs";
import { createZip, readZip } from "../scripts/zip.mjs";
import { ROOT } from "./helpers.mjs";

test("リポジトリ（git が扱うファイル）に、入れてはいけないものと本物の環境のホスト名が無い", (t) => {
  let problems;
  try {
    problems = repoProblems(ROOT);
  } catch (e) {
    t.skip(`git が使えない: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  assert.deepEqual(problems, []);
});

test("入れてはいけないパスの決まり", () => {
  for (const p of [".env", "a/.env.local", "env/x", "records/2305-7.json", "users/dev-x.cybozu.com.json", "kintone/dev/2305-テーブル内集計/fields.json", "inbox/x.json", "policy/authoring-policy.json", "settings/APP1.json", "rex0220-formula-app2305-20261010.json", "ksql.config.json", "a/b.pem"]) {
    assert.ok(forbiddenReasons(p).length, p);
  }
  for (const p of [".env.example", "src/settings.ts", "docs/out.md", "out/a.html", "test/fixtures/settings-2305.json", "scripts/forbidden-files.mjs", "environment.md"]) {
    assert.deepEqual(forbiddenReasons(p), [], p);
  }
});

test("ホスト名の決まり: 例のサブドメインと、名前を伏せた書き方は通す。文字のファイルだけ見る", () => {
  assert.deepEqual(realHosts("https://x.cybozu.com https://dev-x.cybozu.com/k/1/ https://example.cybozu.com https://js.cybozu.com/momentjs/ https://<サブドメイン>.cybozu.com {subdomain}.cybozu.com /\\.cybozu\\.com$/"), []);
  // 本物に見える例は、このファイル自身がリポジトリの検査に当たらないように組み立てる
  const host = (sub, domain = "cybozu.com") => [sub, domain].join(".");
  assert.deepEqual(realHosts(`https://${host("Acme-Dev")}/k/ と ${host("acme.s")} と ${host("foo", "kintone.com")}`), [host("acme-dev"), host("acme.s"), host("foo", "kintone.com")]);
  assert.equal(problemsOf([["a.bin", Buffer.from([0, 0x61, 0x63, 0x6d, 0x65])], ["README.md", Buffer.from(`https://${host("acme")}`)]]).length, 1);
});

test("著作権表示: パッケージのフォルダー、入手先、出力に入ったものだけ、改行、囲み、LICENSE が無ければ止める", () => {
  assert.equal(packageDir("node_modules/zod/v4/core/x.js"), "node_modules/zod");
  assert.equal(packageDir("node_modules/@modelcontextprotocol/server/dist/index.js"), "node_modules/@modelcontextprotocol/server");
  assert.equal(packageDir("node_modules/a/node_modules/@s/b/i.js"), "node_modules/a/node_modules/@s/b");
  assert.equal(packageDir("src/server.ts"), undefined);
  assert.equal(sourceUrl({ repository: { url: "git+https://github.com/o/r.git" } }), "https://github.com/o/r");
  assert.equal(sourceUrl({ repository: "github:o/r" }), "https://github.com/o/r");
  assert.equal(sourceUrl({ repository: "o/r" }), "https://github.com/o/r");
  assert.equal(sourceUrl({ repository: { url: "git://github.com/o/r.git" } }), "https://github.com/o/r");
  assert.equal(sourceUrl({ homepage: "http://x" }), undefined);

  const dir = mkdtempSync(path.join(os.tmpdir(), "fml-notices-"));
  try {
    for (const [name, lic] of [["a", "Copyright A\n```inner```"], ["b", "B"]]) {
      mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
      writeFileSync(path.join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
      writeFileSync(path.join(dir, "node_modules", name, "LICENSE"), lic.replace(/\n/g, "\r\n"));
    }
    const metafile = { outputs: { out: { inputs: { "node_modules/a/i.js": { bytesInOutput: 10 }, "node_modules/b/i.js": { bytesInOutput: 0 }, "src/x.ts": { bytesInOutput: 5 } } } } };
    const pkgs = bundledPackages(dir, [{ label: "本体", metafile }]);
    assert.deepEqual(pkgs.map((p) => p.name), ["a"], "出力のバイトが 0 のパッケージ（木揺すりで消えたもの）は載せない");
    assert.equal(pkgs[0].texts[0], "Copyright A\n```inner```", "改行は \\n にそろえる");
    const md = renderNotices(pkgs, { version: "2.24.0", license: "MIT", url: "https://js.cybozu.com/momentjs/2.24.0/moment-with-locales.min.js" });
    assert.match(md, /\| a \| 1\.0\.0 \| MIT \| 本体 \|/);
    assert.ok(md.includes("\n````text\nCopyright A\n```inner```\n````\n"), "文中のバッククォートより長い囲み");
    assert.ok(md.includes("Copyright (c) JS Foundation and other contributors"), "vendor/ の moment のライセンス");
    rmSync(path.join(dir, "node_modules", "a", "LICENSE"));
    assert.throws(() => bundledPackages(dir, [{ label: "本体", metafile }]), /LICENSE のファイルが無い/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zip: 書いて読める、同じ中身は同じバイト列、おかしな名前と重複は読まない", () => {
  const entries = [
    { path: "a.txt", data: Buffer.from("A") },
    { path: "dir/b.json", data: Buffer.from("{}") }
  ];
  const zip = createZip(entries);
  assert.ok(zip.equals(createZip(entries)), "同じ中身なら同じバイト列（sha256 で固定して配る）");
  const back = readZip(zip);
  assert.deepEqual([...back.keys()], ["a.txt", "dir/b.json"]);
  assert.equal(back.get("dir/b.json").toString(), "{}");
  for (const bad of ["../x", "/abs", "a/../b", "dir/"]) assert.throws(() => readZip(createZip([{ path: bad, data: Buffer.from("x") }])), /名前がおかしい/, bad);
  assert.throws(() => readZip(createZip([...entries, entries[0]])), /重複/);
});

test("marketplace.json: archive の source（リリースの zip と sha256）。版は書かず、入れる前に見える項目は plugin.json から", () => {
  const plugin = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.homepage, REPO_URL);
  assert.equal(plugin.privacyPolicyUrl, `${REPO_URL}/blob/main/PRIVACY.md`);
  const sha = "0".repeat(64);
  const m = marketplace(plugin, sha);
  assert.equal(m.name, "rex0220-formula");
  assert.equal(m.plugins.length, 1);
  const [entry] = m.plugins;
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.version, undefined, "版は plugin.json だけ（両方に書くと食い違いの警告）");
  assert.deepEqual(entry.source, { source: "archive", url: `${REPO_URL}/releases/download/v${plugin.version}/formula-plugin-${plugin.version}.zip`, sha256: sha });
  assert.deepEqual([entry.description, entry.license, entry.repository], [plugin.description, "MIT", REPO_URL]);
});
