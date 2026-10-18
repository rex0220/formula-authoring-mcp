// 試験のときだけ、サーバーのプロセスに Node の --import で読み込ませる kintone の偽物（本体のコードには試験の仕掛けを入れない。print-craft MCP の test/mock-fetch.mjs を元にした）。
// globalThis.fetch を差し替え、x.cybozu.com / dev-x.cybozu.com のアプリ 2305 / 101 に決まった応答を返す。User API（/v1/users.json など）も偽物（架空の 3 人）。
// 送られた要求（メソッド、URL、認証のヘッダーがあるか、その値の sha256 の先頭 16 文字）を FORMULA_TEST_FETCH_LOG のファイルに 1 行ずつ書く
// （ヘッダーの値そのものは書かない。アプリごとに正しいトークンを送ったかを digest で確かめる）
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIELDS = JSON.parse(readFileSync(path.join(here, "fixtures", "fields-2305.json"), "utf8"));
const RECORD = JSON.parse(readFileSync(path.join(here, "fixtures", "record-2305-7.json"), "utf8")).record;
const NAMES = { 2305: "テーブル内集計", 101: "テーブル内集計" };
const LOG = process.env.FORMULA_TEST_FETCH_LOG;
/**
 * 試験だけ: 最初の要求を受けたときに、kintone の接続のファイルを書き換える（呼び出しの途中の接続の変化を再現する。connection-changed）。
 * 値は指示のファイルのパス（{ target: 接続のファイル, content: 新しい中身 }）。1 回使ったら消す
 */
const REWRITE = process.env.FORMULA_TEST_REWRITE_CONN;
/** 計算式プラグインが保存した形のプラグインの設定（試験が中核の authoring API で作ってファイルに置く） */
const PLUGIN_CONFIG = process.env.FORMULA_TEST_PLUGIN_CONFIG;
const FORMULA_PLUGIN_ID = "dhgihghfgfmibkdldkeibboabfnmdpke";
const HOSTS = new Set(["x.cybozu.com", "dev-x.cybozu.com"]);
const APPS = new Set(["2305", "101"]);

/** User API の架空のデータ（個人情報なし） */
const USERS = [
  { id: "1", code: "demo_user01", name: "架空ユーザー01", email: "", valid: true, customItemValues: [{ code: "boss", value: "demo_user02" }] },
  { id: "2", code: "demo_user02", name: "架空ユーザー02", email: "", valid: true, customItemValues: [] },
  { id: "3", code: "demo_user03", name: "架空ユーザー03", email: "", valid: true, customItemValues: [] }
];
const ORGS = [{ id: "10", code: "sales", name: "営業部", parentCode: null }];
const GROUPS = [{ id: "20", code: "manager", name: "管理者" }];

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { code: "GAIA_AP01", id: "x", message: "SERVER-SECRET-MESSAGE 指定したアプリは存在しません" });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = init.headers ?? {};
  const hasToken = Object.keys(headers).some((k) => /^x-cybozu-(api-token|authorization)$/i.test(k) || /^authorization$/i.test(k));
  const hashOf = (re) => {
    const k = Object.keys(headers).find((h) => re.test(h));
    return k ? createHash("sha256").update(String(headers[k])).digest("hex").slice(0, 16) : null;
  };
  const token = hashOf(/^x-cybozu-api-token$/i);
  const auth = hashOf(/^x-cybozu-authorization$/i);
  const bearer = hashOf(/^authorization$/i);
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ method: init.method ?? "GET", host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), hasToken, token, auth, bearer })}\n`);
  if (REWRITE && existsSync(REWRITE)) {
    const { target, content } = JSON.parse(readFileSync(REWRITE, "utf8"));
    writeFileSync(target, JSON.stringify(content), { mode: 0o600 });
    rmSync(REWRITE);
  }
  if (!HOSTS.has(url.host)) return notFound();
  if (!hasToken) return json(401, { code: "CB_AU01", id: "x", message: "SERVER-SECRET-MESSAGE ログインしてください" });
  // User API（cybozu.com 共通。Bearer か パスワード認証）
  const u = url.pathname.match(/^\/v1\/(users|organizations|groups|organization\/users|group\/users|user\/organizations|user\/groups)\.json$/);
  if (u) {
    const q = url.searchParams;
    const codes = q.getAll("codes[]");
    const pick = (list) => (codes.length ? list.filter((x) => codes.includes(x.code)) : list);
    if (u[1] === "users") return json(200, { users: pick(USERS) });
    if (u[1] === "organizations") return json(200, { organizations: pick(ORGS) });
    if (u[1] === "groups") return json(200, { groups: pick(GROUPS) });
    if (u[1] === "organization/users") return json(200, { userTitles: USERS.slice(0, 2).map((x) => ({ user: x, title: null })) });
    if (u[1] === "group/users") return json(200, { users: USERS.slice(0, 1) });
    if (u[1] === "user/organizations") return json(200, { organizationTitles: [{ organization: ORGS[0], title: null }] });
    if (u[1] === "user/groups") return json(200, { groups: GROUPS });
  }
  const m = url.pathname.match(/^\/k\/(?:guest\/(\d+)\/)?v1\/(.+)\.json$/);
  if (!m) return notFound();
  const api = m[2];
  const q = url.searchParams;
  const appOf = (k) => (APPS.has(q.get(k) ?? "") ? q.get(k) : null);
  if (api === "app" && appOf("id")) {
    return json(200, { appId: q.get("id"), code: "", name: NAMES[q.get("id")], description: "<b>説明の全文 DESCRIPTION-SECRET</b>", spaceId: m[1] ? "11" : null, threadId: m[1] ? "12" : null, creator: { code: "taro", name: "山田太郎" }, modifier: { code: "taro", name: "山田太郎" } });
  }
  if ((api === "app/form/fields" || api === "preview/app/form/fields") && appOf("app")) return json(200, { properties: FIELDS.properties, revision: "5" });
  if ((api === "app/form/layout" || api === "preview/app/form/layout") && appOf("app")) return json(200, { layout: FIELDS.layout, revision: "5" });
  if ((api === "app/views" || api === "preview/app/views") && appOf("app")) return json(200, { views: { 一覧A: { id: "5555", name: "一覧A", index: "0", type: "LIST" } }, revision: "5" });
  if (api === "record" && appOf("app") && q.get("id") === "7") return json(200, { record: RECORD });
  if ((api === "app/plugin/config" || api === "preview/app/plugin/config") && appOf("app")) {
    if (q.get("id") !== FORMULA_PLUGIN_ID || !PLUGIN_CONFIG) return json(404, { code: "GAIA_PL18", id: "x", message: "SERVER-SECRET-MESSAGE プラグインが追加されていません" });
    return json(200, { config: JSON.parse(readFileSync(PLUGIN_CONFIG, "utf8")), revision: "12" });
  }
  if (api === "records" && appOf("app")) {
    const rec = (id) => ({ ...RECORD, $id: { type: "__ID__", value: String(id) } });
    return json(200, { records: [rec(7), rec(8), rec(9), rec(10), rec(11), rec(12)], totalCount: null });
  }
  return notFound();
};
