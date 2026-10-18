/**
 * fml_try（式の試し計算。計画 25 章。tools 0.3.0 の trySettings）: 同梱のサンプルアプリ（全項目タイプ × 2、テーブル 2 つ、レコード 3 件 = 典型 / 端 / 空）に
 * 式ごとに 1 行だけの設定を組み、評価の Worker で normalize（検査）→ calc（模擬）した値を返す。利用者のアプリ・レコード・接続は使わない
 * （関数の解説や使用例、式の断片を、推し量らずに実際の計算式エンジンで確かめる）。
 *   - 作業フォルダー（①）は policy（副作用のある関数の承認）とユーザー情報のテストデータ（users/）のために使う。ファイルは読むだけ・書かない
 *   - 式は 1 回 10 まで。値は 1 つ 2,000 文字、式は 4,000 文字。応答全体（structuredContent）は 64 KiB を超えれば failed（式かレコードを減らす）
 *   - 値（value）は対象の型に入れた後の値（kintone に保存される形）。違うときはエンジンの生の値（raw）も返す
 *   - 架空の項目と値（計画 25.3。2026-10-18 Takashi）: fields で標本に項目を足す、data で簡略形の値のレコード（土台は base の標本）、app で利用者のアプリの項目定義
 *     （作業フォルダーの fields.json。アプリのフォルダーか fields/<番号>.json）に data の架空の値を当てる（標本のレコードは使えない）。値は AI が作る架空のもの
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  describeSampleApp, EVENT_RE, EXTRA_TYPES, InputError, TRY_MAX_DATA, TRY_MAX_EXTRA_FIELDS, TRY_MAX_FORMULAS, TRY_MAX_FORMULA_CHARS, TRY_MAX_OPTIONS, legacyBlockedError, pickProfile, readFieldsFile, resolveRead, validateEvent,
  type EvalJob, type FieldsFile, type TryFormulaResult
} from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok, type Finding } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema, type WorkContextForTool } from "./common.ts";
import { runJob } from "./eval.ts";
import { appDirIn, assertReadable, checkRelPaths, fromError, rel, usersSourceFor, withJsonError } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { timeoutSchema } from "./normalize.ts";
import { usersSchema } from "./save.ts";

/** 1 つの値（JSON にしたもの）と誤りの文の長さの上限（文字） */
const MAX_VALUE_CHARS = 2000;
const MAX_MESSAGE_CHARS = 300;
/** 応答全体（structuredContent の JSON）の上限（バイト） */
const MAX_RESULT_BYTES = 64 * 1024;

const NOTE = "同梱のサンプルアプリ（架空）での模擬。利用者のアプリの項目・選択肢・レコードとは違う。利用者の設定を確かめるのは fml_calc。kintone には何も送っていない";
const NOTE_APP = "利用者のアプリの項目定義に架空の値（data）を当てた模擬。レコードは更新していない。実際のレコードで確かめるのは fml_record → fml_calc。kintone には何も送っていない";

/** 足す項目の子（テーブルの中。table / fields は無い） */
const childFieldSchema = z
  .object({
    code: z.string().min(1).max(128).describe("フィールドコード（標本の項目と重ならないもの。文字・数字・_。数字で始まらない）"),
    type: z.string().min(1).max(40).describe(`型（${EXTRA_TYPES.filter((t) => t !== "SUBTABLE").join(" / ")}。TEXT などの別名も可）`),
    label: z.string().max(128).optional().describe("ラベル（省略はコード）"),
    options: z.array(z.string().min(1).max(100)).min(1).max(TRY_MAX_OPTIONS).optional().describe("選択肢（DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT で必須。ほかの型には付けない）")
  })
  .strict();
const fieldSchema = childFieldSchema
  .extend({
    type: z.string().min(1).max(40).describe(`型（${EXTRA_TYPES.join(" / ")}。TEXT / TABLE などの別名も可）`),
    table: z.string().min(1).max(128).optional().describe("既存のテーブル（テーブル1 / テーブル2 か、この配列で先に足したテーブル）の子として足すときのテーブルのコード"),
    fields: z.array(childFieldSchema).min(1).max(TRY_MAX_EXTRA_FIELDS).optional().describe("SUBTABLE の子（type が SUBTABLE のときだけ）")
  })
  .strict();

/**
 * 利用者のアプリの項目定義（app）: 接続のファイルがあればその profile のアプリのフォルダーの fields.json、無ければ fields/<番号>.json（fml_fields の出力）。
 * 接続先（APP_URL）はその profile の baseUrl
 */
function appFieldsOf(w: WorkContextForTool, app: number, profile: string | undefined): { file: string; baseUrl?: string } {
  if (w.mode.kind === "profiles") {
    const def = pickProfile(w.mode.connections.set, profile);
    const dir = appDirIn(w.root, def, app);
    if (!dir) throw new InputError(`アプリ ${app} のフォルダー（kintone/${def.profile}/${app}-…）が無い（fml_fields で取る）`);
    const file = path.join(dir, "fields.json");
    if (!existsSync(file)) throw new InputError(`アプリのフォルダーに fields.json が無い: ${rel(w.root, file)}（fml_fields で取る）`);
    assertReadable(w.root, file, w.mode);
    return { file, baseUrl: def.baseUrl };
  }
  if (profile !== undefined) throw new InputError("profile は kintone の接続のファイルがあるときだけ使える");
  if (w.mode.kind === "legacy-blocked") throw legacyBlockedError();
  const file = resolveRead(path.posix.join("fields", `${app}.json`), w.root);
  if (!existsSync(file)) throw new InputError(`項目定義のファイルが無い: ${rel(w.root, file)}（fml_fields で取る）`);
  return { file };
}

function cutValue(v: unknown): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined || s.length <= MAX_VALUE_CHARS) return v;
  return `${s.slice(0, MAX_VALUE_CHARS)}…（${s.length.toLocaleString()} 文字を切った）`;
}
const cutText = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function shape(r: TryFormulaResult): TryFormulaResult {
  return {
    ...r,
    formula: cutText(r.formula, TRY_MAX_FORMULA_CHARS),
    findings: r.findings.map((f) => ({ ...f, message: cutText(f.message, MAX_MESSAGE_CHARS) })),
    values: r.values.map((v) => ({ ...v, value: cutValue(v.value), ...(v.raw !== undefined ? { raw: cutValue(v.raw) } : {}), ...(v.error ? { error: cutText(v.error, MAX_MESSAGE_CHARS) } : {}) }))
  };
}

export function registerTry(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_try",
    {
      title: "計算式プラグインの式を同梱のサンプルアプリで試す",
      description:
        "計算式プラグイン（rex0220 formula）の式（関数の使い方、式の断片）を、同梱のサンプルアプリ（架空。全項目タイプ × 2（文字列1 / 数値1 / 日付1 …）、テーブル 2 つ（テーブル1 / テーブル2。子は T1_数値 など）、レコード 3 件 = 典型 / 端 / 空）で" +
        "実際の計算式エンジンに計算させ、レコードごとの値（対象の型に入れた後の値と、違うときは生の値）と検査のエラー・警告を返す。利用者のアプリ・レコード・kintone は使わない。" +
        "関数の解説や使用例を答えるとき、式の書き方に迷うときは、推し量らずこのツールで確かめる。as は型（NUMBER / TEXT（既定）/ DATE …）か項目コード、テーブルの中で計算するなら table。項目の一覧は describe: true。" +
        "fields で標本に項目（選択肢つき、テーブル）を足し、data で架空の値のレコードを作れる（利用者の項目コードや境界値で試す）。app で利用者のアプリの項目定義（fml_fields で取ったもの）に架空の値を当てる。利用者の設定を実際のレコードで確かめるのは fml_calc",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          formulas: z
            .array(
              z
                .object({
                  formula: z.string().min(1).max(TRY_MAX_FORMULA_CHARS).describe("計算式（サンプルアプリの項目コードで。例 ROUND(数値1 / 3, 2)、SUM(T1_数値)、DATE_FORMAT(日付1, \"YYYY/MM/DD\")）"),
                  as: z.string().min(1).max(100).optional().describe("対象の型（NUMBER / TEXT / DATE / DATETIME / TIME / DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT / LINK / RICH_TEXT / MULTI_LINE_TEXT）か項目コード。省略は TEXT（文字列 1 行。どの値も文字列で見える）。型のときは式が参照していない項目が対象になる"),
                  table: z.string().min(1).max(100).optional().describe("テーブルの中で計算する（行ごと）ときのテーブルのコード（テーブル1 / テーブル2）")
                })
                .strict()
            )
            .min(1)
            .max(TRY_MAX_FORMULAS)
            .describe(`式（1〜${TRY_MAX_FORMULAS} 個。式ごとに独立に計算する）`),
          records: z.array(z.number().int().min(1).max(3)).min(1).max(3).optional().describe("標本のレコードの番号（1 = 典型、2 = 端（0・負の小数・改行・未選択・月末）、3 = 空。省略は 3 件とも。data があるときの省略は無し。app のときは使えない）"),
          fields: z.array(fieldSchema).min(1).max(TRY_MAX_EXTRA_FIELDS).optional().describe(`標本に足す項目（架空。${TRY_MAX_EXTRA_FIELDS} 個まで、テーブルの子も数える）。例 [{ code: "単価", type: "NUMBER" }, { code: "分類", type: "DROP_DOWN", options: ["明細", "小計"] }, { code: "明細", type: "SUBTABLE", fields: [{ code: "金額", type: "NUMBER" }] }]`),
          data: z.array(z.record(z.string().min(1).max(128), z.unknown())).min(1).max(TRY_MAX_DATA).optional().describe(`架空の値のレコード（${TRY_MAX_DATA} 件まで。簡略形: { 項目コード: 値 }。数値は数か数字の文字列、日付は "YYYY-MM-DD"、日時は "YYYY-MM-DDTHH:mm:ssZ"、選択肢は選択肢の値（複数は配列）、ユーザー・組織・グループはコード（複数は配列）、テーブルは行の配列 [{ 子のコード: 値 }]。書かない項目は土台（base の標本）のまま。実在の個人情報は入れない）`),
          base: z.number().int().min(1).max(3).optional().describe("data の土台にする標本のレコード（1〜3。既定 3 = 空）"),
          app: z.number().int().positive().optional().describe("利用者のアプリの番号。その項目定義（fml_fields で取った fields.json）に data の架空の値を当てる（標本と records は使わない。選択肢・項目コードが実機と同じになる）"),
          profile: profileSchema.describe("app のアプリのフォルダーの profile（接続のファイルがあるとき。省略は defaultProfile）"),
          users: usersSchema,
          user: z.string().min(1).max(128).optional().describe("ログインユーザーのコード（ユーザー情報のテストデータに居ること。LOGIN_* や引数なしの UINFO() を使う式のとき。既定は authoring）"),
          event: z.string().regex(EVENT_RE).optional().describe("イベントの種別（EV_INFO(\"type\") の値。fml_calc と同じ。既定 allUpdate）"),
          action: z.string().max(200).optional().describe("プロセス管理のアクション名（EV_INFO(\"action\")）"),
          status: z.string().max(200).optional().describe("プロセス管理の今のステータス（EV_INFO(\"status\")）"),
          nextStatus: z.string().max(200).optional().describe("プロセス管理の次のステータス（EV_INFO(\"nextStatus\")）"),
          mobile: z.boolean().optional().describe("モバイルの文脈で計算する"),
          describe: z.boolean().optional().describe("サンプルアプリの項目（1 項目 1 行。○ = 計算式を設定できる型）とレコード 3 件の形も返す"),
          timeoutSec: timeoutSchema
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ users: input.users });
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          const users = usersSourceFor(w.root, input.users, w.mode);
          let appFields: FieldsFile | undefined;
          let baseUrl: string | undefined;
          if (input.app !== undefined) {
            const a = appFieldsOf(w, input.app, input.profile);
            appFields = await withJsonError(w.root, a.file, "項目定義のファイル", () => readFieldsFile(a.file));
            if (appFields.appId !== input.app) throw new InputError(`${rel(w.root, a.file)} はアプリ ${appFields.appId} の項目定義（app ${input.app}）`);
            baseUrl = a.baseUrl;
          } else if (input.profile !== undefined) throw new InputError("profile は app（利用者のアプリの項目定義）と一緒に使う");
          const given = input.action !== undefined || input.status !== undefined || input.nextStatus !== undefined ? { action: { value: input.action ?? "" }, status: { value: input.status ?? "" }, nextStatus: { value: input.nextStatus ?? "" } } : undefined;
          const ev = validateEvent(input.event, given);
          const job: EvalJob = {
            kind: "try",
            pluginZip: w.source.pluginZip,
            devPluginDir: w.source.devPluginDir,
            mode: w.source.mode,
            vendorDir: w.source.vendorDir,
            baseUrl,
            usersSource: users.src,
            usersOrigin: users.origin,
            policy: w.policy,
            try: {
              formulas: input.formulas, records: input.records, fields: input.fields, data: input.data, base: input.base, appFields,
              evType: ev.evType, event: ev.event, mobile: input.mobile === true, user: input.user
            }
          };
          const out = await runJob(w, job, input.timeoutSec);
          const t = out.try;
          if (!t) return failure("failed", "Error", "試し計算の結果が無い（中核の版を fml_status で確かめる）");
          const findings: Finding[] = out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }));
          for (const r of t.results) {
            if (r.status === "ok") continue;
            const first = r.findings.find((f) => f.level === "error");
            findings.push({ level: "error", rule: r.status === "failed" ? "try.failed" : "try.invalid", message: `[${r.index}] ${r.status === "failed" ? "実行時の sink が呼ばれた（結果を採らない）" : first ? `${first.rule}: ${cutText(first.message, MAX_MESSAGE_CHARS)}` : "検査のエラー"}` });
          }
          const results = t.results.map(shape);
          const fields = input.describe === true ? describeSampleApp(new Set(w.engine.api.TARGET_TYPES as readonly string[])) : undefined;
          const payload = { app: t.app, summary: t.summary, contextLine: t.contextLine, notice: t.notice, results, ...(fields !== undefined ? { fields } : {}), note: t.app.source === "app" ? NOTE_APP : NOTE };
          const bytes = Buffer.byteLength(JSON.stringify({ ok: true, status: "ok", findings, result: payload }), "utf8");
          if (bytes > MAX_RESULT_BYTES) return failure("failed", "ResultTooLarge", `結果が返す量の上限（64 KiB）に収まらない（${bytes.toLocaleString()} バイト。式かレコードを減らす）`);
          return ok(payload, { findings });
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
