/**
 * fml_calc（模擬の計算。計画 24.2.2。print-craft の pcraft_preview に相当）: 中核の calcSettings を評価の Worker で動かし、取得したレコード（fml_record）に設定を当てた
 * 項目ごとの前後の値を返す（値を返す唯一のツール。CLI の calc と同じ例外）。レコードは更新しない。
 *   - records は 1 回に 10 件まで（AI に返す量）。返す行は変わった項目と印のある項目だけ（all: true で全項目。1 レコード 300 行まで）。応答全体は 64 KiB で打ち切る
 *   - normalize のエラーがあれば計算しない（invalid）。エラーか sink のあるレコードは findings に error（status は ok。結果を利用者に伝える）
 *   - 文脈（ログインユーザー、イベント、mobile、接続先）は引数と接続のファイルの profile で決まる。ユーザー情報は既定のテストデータ（架空）か users/ のファイル
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { EVENT_RE, InputError, readJsonLimited, validateEvent, type CalcLine, type CalcRecordResult, type KintoneRecord } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok, type Finding } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { evalTargetOf, jobOf, runJob } from "./eval.ts";
import { baseUrlFields, checkRelPaths, folderOf, fromError, recordFileFor, rel, withJsonError } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { timeoutSchema } from "./normalize.ts";
import { usersSchema } from "./save.ts";

/** 1 回のレコード数の上限 */
export const MAX_RECORDS = 10;
/** 1 レコードの行の上限と、エラーの上限 */
const MAX_LINES = 300;
const MAX_ERRORS = 20;
/** 応答の大きさの上限（文字） */
const MAX_RESULT_CHARS = 64 * 1024;

const NOTE = "既存のレコードは変わっていない（模擬）。反映は設定画面で取り込み → 保存 → 運用環境に反映。既存レコードは「既存レコードを変更」か「一括計算」で";

interface RecordOut {
  id: string;
  changed: number;
  lines: CalcLine[];
  linesOmitted?: number;
  errors: CalcRecordResult["errors"];
  errorCount?: number;
  sinks: string[];
  failed: boolean;
}

function shape(r: CalcRecordResult, all: boolean): RecordOut {
  const picked = all ? r.lines : r.lines.filter((l) => l.changed || l.marks.length > 0);
  const lines = picked.slice(0, MAX_LINES);
  return {
    id: r.id,
    changed: r.changed,
    lines,
    ...(picked.length > lines.length ? { linesOmitted: picked.length - lines.length } : {}),
    errors: r.errors.slice(0, MAX_ERRORS),
    ...(r.errors.length > MAX_ERRORS ? { errorCount: r.errors.length } : {}),
    sinks: r.sinks,
    failed: r.failed
  };
}

export function registerCalc(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_calc",
    {
      title: "計算式プラグインの設定で模擬の計算",
      description:
        "計算式プラグイン（rex0220 formula）の設定 JSON を、fml_record で取ったレコードに当てて計算し、項目ごとの前後の値を返す（模擬。kintone のレコードは更新しない）。" +
        "要件どおりの値になるかを確かめる。評価は Worker で動き既定 60 秒で止まる。文脈が足りないとき（接続先、ルックアップ先、ログインユーザー）は名指しで止まるので、利用者に聞くか user を付ける。" +
        "ユーザー情報を使う式は既定のテストデータ（架空）、イベントで分岐する式は event の文脈（既定は「既存レコードを変更」と同じ allUpdate）で計算される。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          records: z.array(z.number().int().positive()).min(1).max(MAX_RECORDS).describe(`レコード番号（fml_record で取ったもの。1〜${MAX_RECORDS} 件）`),
          app: z.number().int().positive().optional().describe("アプリの番号（アプリのフォルダー kintone/… の中の設定なら省略する。settings/ の設定は封筒の appId）"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダーの中の設定なら省略する。省略すると封筒の appId の fields/<appId>.json"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（APP_URL などの評価に使う接続先。アプリのフォルダーの中のファイルは省略する）"),
          users: usersSchema,
          user: z.string().min(1).max(128).optional().describe("ログインユーザーのコード（ユーザー情報のテストデータに居ること。LOGIN_* や引数なしの UINFO() を使う式のとき）"),
          event: z.string().regex(EVENT_RE).optional().describe("イベントの種別（EV_INFO(\"type\") の値。例 allUpdate（既定。既存レコードを変更）、batch（一括計算）、create、edit、change、submit）"),
          action: z.string().max(200).optional().describe("プロセス管理のアクション名（EV_INFO(\"action\")）"),
          status: z.string().max(200).optional().describe("プロセス管理の今のステータス（EV_INFO(\"status\")）"),
          nextStatus: z.string().max(200).optional().describe("プロセス管理の次のステータス（EV_INFO(\"nextStatus\")）"),
          mobile: z.boolean().optional().describe("モバイルの文脈で計算する"),
          all: z.boolean().optional().describe("変わらなかった項目の行も返す（既定は変わった項目と印のある項目だけ）"),
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
          const t = await evalTargetOf(w, input.path, input);
          const folder = folderOf(w.root, t.file.file);
          const envelopeApp = typeof t.file.settings.appId === "number" ? t.file.settings.appId : undefined;
          const appId = folder?.appId ?? input.app ?? envelopeApp;
          if (appId === undefined) throw new InputError("app（アプリの番号）が要る（封筒に appId が無く、アプリのフォルダーの中でもない）");
          if (folder && input.app !== undefined && input.app !== folder.appId) throw new InputError(`app ${input.app} とファイルのフォルダーのアプリ（${folder.appId}）が違う`);
          const ids = [...new Set(input.records)];
          const records = [];
          for (const id of ids) {
            const file = recordFileFor(w.root, t.file.file, appId, id, w.mode);
            const data = (await withJsonError(w.root, file, "レコードのファイル", () => readJsonLimited(file))) as { record?: KintoneRecord; appId?: number; id?: number };
            if (!data.record || typeof data.record !== "object") throw new InputError(`${rel(w.root, file)} は fml_record の出力ではない`);
            records.push({ id: String(id), record: data.record, fileAppId: typeof data.appId === "number" ? data.appId : undefined, fileId: typeof data.id === "number" ? data.id : undefined });
          }
          const given = input.action !== undefined || input.status !== undefined || input.nextStatus !== undefined ? { action: { value: input.action ?? "" }, status: { value: input.status ?? "" }, nextStatus: { value: input.nextStatus ?? "" } } : undefined;
          const ev = validateEvent(input.event, given);
          const job = jobOf(w, t, "calc", { calc: { appId, records, evType: ev.evType, event: ev.event, mobile: input.mobile === true, user: input.user } });
          const out = await runJob(w, job, input.timeoutSec);
          const n = out.normalize;
          const warnings = (n.findings as unknown as Finding[]).filter((f) => f.level !== "info");
          const findings: Finding[] = [...warnings, ...out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }))];
          if (n.hasErrors || !out.calc) return failure("invalid", "NormalizeError", `normalize のエラーがあるので計算しない（fml_normalize で確かめる）: ${n.summary.split("\n")[0]}`, n.findings as unknown as Finding[]);
          const c = out.calc;
          let shaped = c.records.map((r) => shape(r, input.all === true));
          for (const r of shaped) {
            if (r.failed || r.errors.length) findings.push({ level: "error", rule: "calc.failed", message: `レコード ${r.id}: ${r.failed ? "実行時の sink が呼ばれた（走査の漏れ。結果を採らない）" : `式の評価に失敗 ${r.errors.length} 件`}` });
          }
          // 応答全体の上限（行を後ろから減らす）
          let truncated = false;
          const size = () => JSON.stringify(shaped).length;
          while (size() > MAX_RESULT_CHARS) {
            const longest = shaped.reduce((a, b) => (a.lines.length >= b.lines.length ? a : b));
            if (longest.lines.length === 0) break;
            const drop = Math.max(1, Math.ceil(longest.lines.length / 4));
            longest.lines = longest.lines.slice(0, longest.lines.length - drop);
            longest.linesOmitted = (longest.linesOmitted ?? 0) + drop;
            truncated = true;
          }
          if (truncated) findings.push({ level: "info", rule: "truncated", message: "返す量の上限（64 KiB）で行を打ち切った（linesOmitted）。レコード数を減らすか、項目を絞る" });
          return ok(
            { path: t.file.relPath, appId, contextLine: c.contextLine, notice: c.notice, summary: c.summary, records: shaped, failed: c.failed, ...baseUrlFields(t.baseUrl), note: NOTE },
            { findings }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
