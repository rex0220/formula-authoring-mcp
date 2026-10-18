/**
 * fml_calc（模擬の計算。計画 24.2.2。print-craft の pcraft_preview に相当）: 中核の calcSettings を評価の Worker で動かし、取得したレコード（fml_record）に設定を当てた
 * 項目ごとの前後の値を返す（値を返す唯一のツール。CLI の calc と同じ例外）。レコードは更新しない。
 *   - records は 1 回に 10 件まで（AI に返す量）。返す行は変わった項目と印のある項目だけ（all: true で全項目。1 レコード 300 行まで）。応答全体は 64 KiB で打ち切る
 *   - normalize のエラーがあれば計算しない（invalid）。エラーか sink のあるレコードは findings に error（status は ok。結果を利用者に伝える）
 *   - 文脈（ログインユーザー、イベント、mobile、接続先）は引数と接続のファイルの profile で決まる。ユーザー情報は既定のテストデータ（架空）か users/ のファイル
 *   - click（MCP 0.3.0。中核 0.4.0 の計画 26 章）: ボタン（BUTTON / DIALOG）の行を計算の後に押した模擬（押す前の表示と、押した後に変わる項目）を records[].click に返す
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { EVENT_RE, InputError, readJsonLimited, validateEvent, type CalcLine, type CalcRecordResult, type ClickResult, type KintoneRecord } from "../core.ts";
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
/** 1 レコードの行の上限と、エラーの上限、sink の上限 */
const MAX_LINES = 300;
const MAX_ERRORS = 20;
const MAX_SINKS = 20;
/** 1 つの値（before / after を JSON にしたもの）とエラーの文の長さの上限（文字） */
const MAX_VALUE_CHARS = 2000;
const MAX_ERROR_CHARS = 300;
/** 応答全体（result + findings を JSON にしたもの）の大きさの上限（バイト。Codex のレビュー MAJOR 5） */
const MAX_RESULT_BYTES = 64 * 1024;

/** 長い値を切る（文字列はそのまま、ほかは JSON にして。切ったときは印を付ける） */
function cutValue(v: unknown): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined || s.length <= MAX_VALUE_CHARS) return v;
  return `${s.slice(0, MAX_VALUE_CHARS)}…（${s.length.toLocaleString()} 文字を切った）`;
}
const cutText = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

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
  /** ボタンのクリックの模擬（click を指定したとき） */
  click?: ClickResult & { changesOmitted?: number };
}

function shapeClick(c: ClickResult): ClickResult & { changesOmitted?: number } {
  const changes = c.changes.slice(0, MAX_LINES).map((l) => ({ ...l, before: cutValue(l.before), after: cutValue(l.after) }));
  return {
    display: c.display ? (Object.fromEntries(Object.entries(c.display).map(([k, v]) => [k, cutValue(v)])) as Record<string, unknown>) : null,
    changes,
    ...(c.changes.length > changes.length ? { changesOmitted: c.changes.length - changes.length } : {}),
    errors: c.errors.slice(0, MAX_ERRORS).map((e) => ({ ...e, message: cutText(e.message, MAX_ERROR_CHARS) })),
    sinks: c.sinks.slice(0, MAX_SINKS).map((s) => cutText(s, MAX_ERROR_CHARS)),
    failed: c.failed
  };
}

function shape(r: CalcRecordResult, all: boolean): RecordOut {
  const picked = all ? r.lines : r.lines.filter((l) => l.changed || l.marks.length > 0);
  const lines = picked.slice(0, MAX_LINES).map((l) => ({ ...l, before: cutValue(l.before), after: cutValue(l.after) }));
  return {
    id: r.id,
    changed: r.changed,
    lines,
    ...(picked.length > lines.length ? { linesOmitted: picked.length - lines.length } : {}),
    errors: r.errors.slice(0, MAX_ERRORS).map((e) => ({ ...e, message: cutText(e.message, MAX_ERROR_CHARS) })),
    ...(r.errors.length > MAX_ERRORS ? { errorCount: r.errors.length } : {}),
    sinks: r.sinks.slice(0, MAX_SINKS).map((s) => cutText(s, MAX_ERROR_CHARS)),
    failed: r.failed,
    ...(r.click ? { click: shapeClick(r.click) } : {})
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
        "ユーザー情報を使う式は既定のテストデータ（架空）、イベントで分岐する式は event の文脈（既定は「既存レコードを変更」と同じ allUpdate）で計算される。結果を推し量らず、このツールで確かめる。" +
        "click にボタン（BUTTON / DIALOG）の行の項目コードを渡すと、計算の後に押した模擬（押す前の表示と、押した後に変わる項目）も返す。最後は利用者が実機のテスト用アプリで押して確かめる",
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
          event: z.string().regex(EVENT_RE).optional().describe("イベントの種別（EV_INFO(\"type\") の値。正式な名前だけ: allUpdate（既定。既存レコードを変更）、batch（一括計算）、app.record.create.show / .submit / .submit.success、app.record.edit.show / .submit / .submit.success、app.record.create.change.<項目コード> / app.record.edit.change.<項目コード>、app.record.index.edit.show / .submit、app.record.detail.show、app.record.detail.process.proceed。mobile. を頭に付けるとモバイル）"),
          action: z.string().max(200).optional().describe("プロセス管理のアクション名（EV_INFO(\"action\")）"),
          status: z.string().max(200).optional().describe("プロセス管理の今のステータス（EV_INFO(\"status\")）"),
          nextStatus: z.string().max(200).optional().describe("プロセス管理の次のステータス（EV_INFO(\"nextStatus\")）"),
          mobile: z.boolean().optional().describe("モバイルの文脈で計算する"),
          all: z.boolean().optional().describe("変わらなかった項目の行も返す（既定は変わった項目と印のある項目だけ）"),
          click: z.string().min(1).max(128).optional().describe("ボタン（BUTTON / DIALOG）の行の項目コード（スペース項目は \"(要素ID)\"。fml_summary で行を見る）。計算の後に押した模擬を records[].click に返す（display = 押す前の表示、changes = 押した後に変わる項目。テンプレートの policy は既定で承認、外してあれば利用者に頼む。見た目・ダイアログの表示・change イベントは模擬しない）"),
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
          const job = jobOf(w, t, "calc", { calc: { appId, records, evType: ev.evType, event: ev.event, mobile: input.mobile === true, user: input.user, click: input.click } });
          const out = await runJob(w, job, input.timeoutSec);
          const n = out.normalize;
          const warnings = (n.findings as unknown as Finding[]).filter((f) => f.level !== "info");
          const findings: Finding[] = [...warnings, ...out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }))];
          if (n.hasErrors || !out.calc) return failure("invalid", "NormalizeError", `normalize のエラーがあるので計算しない（fml_normalize で確かめる）: ${n.summary.split("\n")[0]}`, n.findings as unknown as Finding[]);
          const c = out.calc;
          let shaped = c.records.map((r) => shape(r, input.all === true));
          for (const r of shaped) {
            if (r.sinks.length || r.errors.length) findings.push({ level: "error", rule: "calc.failed", message: `レコード ${r.id}: ${r.sinks.length ? "実行時の sink が呼ばれた（走査の漏れ。結果を採らない）" : `式の評価に失敗 ${r.errors.length} 件`}` });
            if (r.click && (r.click.failed || r.click.errors.length)) findings.push({ level: "error", rule: "calc.click", message: `レコード ${r.id}: クリックの模擬 ${r.click.failed ? "実行時の sink が呼ばれた（結果を採らない）" : cutText(r.click.errors[0].message, MAX_ERROR_CHARS)}` });
          }
          // 応答全体の上限（result と findings を JSON にしたバイト数。行を後ろから減らし、それでも超えればエラーの文を減らす）
          // 上限は structuredContent（ok、status、findings、result の JSON。content の文はその整形版）のバイト数。打ち切りの finding も含めて測る（Codex の r2 レビュー R4）
          const truncatedFinding: Finding = { level: "info", rule: "truncated", message: "返す量の上限（64 KiB）で行やエラーを打ち切った（linesOmitted / errorCount / click.changesOmitted）。レコード数を減らすか、項目を絞る" };
          const payload = () => ({ path: t.file.relPath, appId, contextLine: c.contextLine, notice: c.notice, summary: c.summary, records: shaped, failed: c.failed, ...(input.click !== undefined ? { click: input.click } : {}), ...baseUrlFields(t.baseUrl), note: NOTE });
          const bytes = () => Buffer.byteLength(JSON.stringify({ ok: true, status: "ok", findings: [...findings, ...(truncated ? [truncatedFinding] : [])], result: payload() }), "utf8");
          let truncated = false;
          let stage = 0;
          while (bytes() > MAX_RESULT_BYTES) {
            truncated = true;
            const longest = shaped.reduce((a, b) => (a.lines.length >= b.lines.length ? a : b), shaped[0]);
            const withErrors = shaped.find((r) => r.errors.length > 0 || r.sinks.length > 0);
            const withClick = shaped.find((r) => r.click && r.click.changes.length > 0);
            if (withClick && withClick.click) {
              // クリックの変わる項目から減らす（本体の行より先）
              const ck = withClick.click;
              const drop = Math.max(1, Math.ceil(ck.changes.length / 2));
              ck.changes = ck.changes.slice(0, ck.changes.length - drop);
              ck.changesOmitted = (ck.changesOmitted ?? 0) + drop;
            } else if (longest && longest.lines.length > 0) {
              const drop = Math.max(1, Math.ceil(longest.lines.length / 4));
              longest.lines = longest.lines.slice(0, longest.lines.length - drop);
              longest.linesOmitted = (longest.linesOmitted ?? 0) + drop;
            } else if (withErrors) {
              withErrors.errorCount = withErrors.errorCount ?? withErrors.errors.length;
              withErrors.errors = withErrors.errors.slice(0, Math.floor(withErrors.errors.length / 2));
              withErrors.sinks = withErrors.sinks.slice(0, Math.floor(withErrors.sinks.length / 2));
            } else if (stage === 0) {
              // 固定の部分: findings の文を切り、件数も減らす（normalize の警告の文は設定の文字列を含みうる）
              for (const f of findings) f.message = cutText(f.message, 200);
              findings.splice(20);
              stage = 1;
            } else if (stage === 1) {
              c.summary = cutText(c.summary, 500);
              c.contextLine = cutText(c.contextLine, 500);
              c.notice = cutText(c.notice, 500);
              stage = 2;
            } else if (stage === 2) {
              // 最後: レコードの結果を外した最小の応答（固定の部分は path 512、文 500 × 3、接続先 300、レコード 10 件の数だけ）
              shaped = shaped.map((r) => ({ id: r.id, changed: r.changed, lines: [], linesOmitted: (r.linesOmitted ?? 0) + r.lines.length, errors: [], errorCount: r.errorCount ?? r.errors.length, sinks: [], failed: r.failed, ...(r.click ? { click: { display: null, changes: [], changesOmitted: (r.click.changesOmitted ?? 0) + r.click.changes.length, errors: [], sinks: [], failed: r.click.failed } } : {}) }));
              findings.splice(0);
              stage = 3;
            } else {
              // ここには来ない（最小の応答は上限に収まる）。万一のときは文をすべて外す
              c.summary = c.contextLine = c.notice = "";
              break;
            }
          }
          if (truncated) findings.push(truncatedFinding);
          // 最後に必ず確かめる（上限の定義 = structuredContent の JSON のバイト数）
          if (bytes() > MAX_RESULT_BYTES) return failure("failed", "ResultTooLarge", "結果が返す量の上限（64 KiB）に収まらない（レコード数を減らす）");
          return ok(payload(), { findings });
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
