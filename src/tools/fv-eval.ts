/**
 * fv_normalize / fv_check（項目検証プラグインの設定の検査と判定の模擬。MCP 0.4.0。field-validation の計画 4.3、5 章、6 章）: 中核の fvNormalizeSettings / fvCheckSettings を評価の Worker で。
 *   - fv_normalize: 書き戻さずに検査する（CLI の fv normalize。check で --check）。書くのは fv_save_settings / fv_update_rows だけ
 *   - fv_check: fml_record で取ったレコードに設定を当てた判定（非表示・入力不可・必須・誤りの文・保存の前に入れる値）をイベントごとに返す。kintone は更新しない。
 *     records は 1 回に 10 件、イベントは 6 つまで。誤りの文と入れる値は中核が 200 文字で切る（メッセージの式と初期化の値にレコードの値が入りうる）。応答全体は 64 KiB まで
 *   - 式は計算式プラグインの zip のエンジンで評価する（項目検証の同梱のエンジンと違えば contextLine と findings で知らせる）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FV_CHECK_EVENTS_MAX, FV_EVENT_RE, InputError, readJsonLimited, type KintoneRecord } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok, type Finding } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { evalTargetOf, jobOf, runJob } from "./eval.ts";
import { baseUrlFields, checkRelPaths, folderOf, fromError, recordFileFor, rel, withJsonError } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { timeoutSchema } from "./normalize.ts";
import { usersSchema } from "./save.ts";

/** 1 回のレコード数の上限（AI に返す量。fml_calc と同じ） */
export const FV_MAX_RECORDS = 10;
/** --check の差の件数の上限 */
const MAX_CHECK_DIFFS = 50;
/** 1 イベントの行の上限と、応答全体の上限（バイト。structuredContent の JSON） */
const MAX_LINES = 300;
const MAX_RESULT_BYTES = 64 * 1024;

const NOTE = "既存のレコードの値は変わっていない（模擬）。反映は設定画面で設定をアップロード → 取り込み方（全置換 / 項目の置換）→ 保存 → 運用環境に反映。反映の後に既存のレコードを編集して保存するとき、新しい必須条件・検証条件で止まることがあり、隠れて「初期化」がオンの項目は初期値に戻る";

export function registerFvNormalize(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_normalize",
    {
      title: "項目検証プラグインの設定を検査",
      description:
        "項目検証プラグイン（rex0220 field validation）Ver.72 以降の設定 JSON を検査（封筒・キー・型、版、更新系の関数、項目定義との突き合わせ、式の構文と参照、警告）し、エラー・警告・情報を返す。ファイルは書き換えない。" +
        "式は計算式プラグインの zip で評価する。check: true で、入力と既定値を補った出力の差も返す。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダー kintone/… の中の設定なら省略できる。省略すると封筒の appId の fields/<appId>.json"),
          check: z.boolean().optional().describe("入力と出力の差を確かめる（ダウンロード / pull した設定を直す前）"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（評価の文脈の接続先。アプリのフォルダーの中のファイルは省略する）"),
          users: usersSchema,
          timeoutSec: timeoutSchema
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ path: input.path, fields: input.fields, users: input.users });
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          const t = await evalTargetOf(w, input.path, input, "field-validation");
          const out = await runJob(w, jobOf(w, t, "fv-normalize", { check: input.check === true }), input.timeoutSec);
          const n = out.normalize;
          const findings = [...(n.findings as unknown as Finding[]), ...out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }))];
          const checkDiffs = n.checkDiffs ? { count: n.checkDiffs.length, items: n.checkDiffs.slice(0, MAX_CHECK_DIFFS) } : undefined;
          if (n.hasErrors || !n.output) return failure("invalid", "NormalizeError", `fv normalize のエラーがある: ${n.summary.split("\n")[0]}`, findings);
          return ok(
            { path: t.file.relPath, summary: n.summary, ...(n.appId !== undefined ? { appId: n.appId } : {}), ...(n.size ? { size: n.size } : {}), ...(checkDiffs ? { checkDiffs } : {}), ...baseUrlFields(t.baseUrl) },
            { findings, digest: t.file.digest }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}

export function registerFvCheck(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_check",
    {
      title: "項目検証プラグインの設定で判定の模擬",
      description:
        "項目検証プラグイン（rex0220 field validation）の設定 JSON を、fml_record で取ったレコードに当てて、イベントごとに項目の非表示・入力不可・必須・誤りの文・保存の前に入れる値（初期化）を返す（模擬。kintone のレコードは更新しない）。" +
        "要件どおりの判定になるかを確かめる。印のある項目だけを返す（all: true で全部）。テストデータのレコードで行う（メッセージの式と初期化の値にレコードの値が入りうる）。" +
        "画面への反映（枠線の色、グループの開閉）は模擬しない。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          records: z.array(z.number().int().positive()).min(1).max(FV_MAX_RECORDS).describe(`レコード番号（fml_record で取ったもの。1〜${FV_MAX_RECORDS} 件）`),
          app: z.number().int().positive().optional().describe("アプリの番号（アプリのフォルダー kintone/… の中の設定なら省略する。settings/ の設定は封筒の appId）"),
          events: z.array(z.string().regex(FV_EVENT_RE)).min(1).max(FV_CHECK_EVENTS_MAX).optional().describe(`イベント名（${FV_CHECK_EVENTS_MAX} つまで。省くと app.record.index.edit.change（一覧編集向けの判定と同じ。初期化 = 保存の前に入れる値は …submit のときだけ出るので、初期化を確かめるなら app.record.edit.submit などを渡す）。例 app.record.create.show、app.record.edit.change.<項目コード>、app.record.create.submit、app.record.index.edit.submit。mobile. を前に付けられる。詳細画面（detail.show）は模擬しない）`),
          lang: z.enum(["ja", "en", "zh"]).optional().describe("ログインユーザーの言語（検証条件のメッセージの言語。既定 ja）"),
          user: z.string().min(1).max(128).optional().describe("ログインユーザーのコード（ユーザー情報のテストデータに居ること。LOGIN_* や UINFO を使う式のとき）"),
          all: z.boolean().optional().describe("印の無い項目の行も返す"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダーの中の設定なら省略する。省略すると封筒の appId の fields/<appId>.json"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（評価の文脈の接続先。アプリのフォルダーの中のファイルは省略する）"),
          users: usersSchema,
          timeoutSec: timeoutSchema
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ path: input.path, fields: input.fields, users: input.users });
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          const t = await evalTargetOf(w, input.path, input, "field-validation");
          const folder = folderOf(w.root, t.file.file);
          const envelopeApp = typeof t.file.settings.appId === "number" ? t.file.settings.appId : undefined;
          const appId = folder?.appId ?? input.app ?? envelopeApp;
          if (appId === undefined) throw new InputError("app（アプリの番号）が要る（封筒に appId が無く、アプリのフォルダーの中でもない）");
          if (folder && input.app !== undefined && input.app !== folder.appId) throw new InputError(`app ${input.app} とファイルのフォルダーのアプリ（${folder.appId}）が違う`);
          if (envelopeApp !== undefined && envelopeApp !== appId) throw new InputError(`app ${appId} と設定の appId（${envelopeApp}）が違う`);
          const records = [];
          for (const id of [...new Set(input.records)]) {
            const file = recordFileFor(w.root, t.file.file, appId, id, w.mode);
            const data = (await withJsonError(w.root, file, "レコードのファイル", () => readJsonLimited(file))) as { record?: KintoneRecord; appId?: number; id?: number };
            if (!data.record || typeof data.record !== "object") throw new InputError(`${rel(w.root, file)} は fml_record の出力ではない`);
            records.push({ id: String(id), record: data.record, fileAppId: typeof data.appId === "number" ? data.appId : undefined, fileId: typeof data.id === "number" ? data.id : undefined });
          }
          const job = jobOf(w, t, "fv-check", { lang: input.lang });
          job.fvCheck = { appId, records, events: input.events, user: input.user, all: input.all === true };
          const out = await runJob(w, job, input.timeoutSec);
          const n = out.normalize;
          if (n.hasErrors || !out.fvCheck) return failure("invalid", "NormalizeError", `fv normalize のエラーがあるので判定しない（fv_normalize で確かめる）: ${n.summary.split("\n")[0]}`, n.findings as unknown as Finding[]);
          const c = out.fvCheck;
          const findings: Finding[] = [...(n.findings as unknown as Finding[]).filter((f) => f.level !== "info"), ...out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }))];
          if (c.failed) findings.unshift({ level: "warning", rule: "fv.errors", message: "誤り（文）のあるレコード・イベントがある（保存で止まる見込み。records[].events[].lines[].errors）" });
          let records2 = c.records.map((r) => ({ id: r.id, events: r.events.map((e) => ({ event: e.event, ok: e.ok, lines: e.lines.slice(0, MAX_LINES), ...(e.lines.length > MAX_LINES ? { linesOmitted: e.lines.length - MAX_LINES } : {}) })) }));
          const payload = () => ({ path: t.file.relPath, appId, contextLine: c.contextLine, notice: c.notice, failed: c.failed, records: records2, ...baseUrlFields(t.baseUrl), note: NOTE });
          const bytes = () => Buffer.byteLength(JSON.stringify({ ok: true, status: "ok", findings, result: payload() }), "utf8");
          let truncated = false;
          // 応答全体の上限: 行の多いイベントから半分ずつ減らす。それでも超えれば findings を減らす
          while (bytes() > MAX_RESULT_BYTES) {
            truncated = true;
            const all = records2.flatMap((r) => r.events);
            const longest = all.reduce((a, b) => (a.lines.length >= b.lines.length ? a : b), all[0]);
            if (longest && longest.lines.length > 0) {
              const drop = Math.max(1, Math.ceil(longest.lines.length / 2));
              longest.lines = longest.lines.slice(0, longest.lines.length - drop);
              (longest as { linesOmitted?: number }).linesOmitted = ((longest as { linesOmitted?: number }).linesOmitted ?? 0) + drop;
            } else if (findings.length > 1) findings.splice(Math.max(1, Math.floor(findings.length / 2)));
            else break;
          }
          if (truncated) findings.push({ level: "info", rule: "truncated", message: "返す量の上限（64 KiB）で行を打ち切った（linesOmitted）。レコード数かイベントを減らす" });
          if (bytes() > MAX_RESULT_BYTES) {
            records2 = records2.map((r) => ({ id: r.id, events: r.events.map((e) => ({ event: e.event, ok: e.ok, lines: [], linesOmitted: e.lines.length + ((e as { linesOmitted?: number }).linesOmitted ?? 0) })) }));
            if (bytes() > MAX_RESULT_BYTES) return failure("failed", "ResultTooLarge", "結果が返す量の上限（64 KiB）に収まらない（レコード数かイベントを減らす）");
          }
          return ok(payload(), { findings });
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
