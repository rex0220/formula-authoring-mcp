/**
 * ツールで共通の部品: 入力の workspaceId（出し分けで必須かが変わる）、作業フォルダーを決めて計算式プラグインのエンジンと評価の Worker を用意する流れ、
 * 中核の SaveResult の応答への写し方
 */
import { z } from "zod";
import { WorkspaceError, type Surface } from "../binding.ts";
import { buildProblem, zipProblem } from "../compat.ts";
import { PluginZipError, loadPolicy, type Engine, type EvalSource, type PluginZipErrorCode, type Policy, type RunOptions, type SaveResult, type WorkspaceMode } from "../core.ts";
import { zipGuide, zipOf, type ServerContext } from "../context.ts";
import { failure, ok, type Finding, type ToolResult } from "../result.ts";
import { describeZipError } from "../zip-error.ts";

/** workspaceId: Claude Code では必須（プラグインのフックが入れる）、Desktop では省略できる（設定の作業フォルダーを使う）。print-craft MCP の実装案 4.1 */
export function workspaceIdSchema(surface: Surface) {
  return surface === "claude-code"
    ? z.string().min(1).max(4096).describe("作業フォルダー（formula のプラグインのフックが入れる。AI は何を渡してもよい）")
    : z.string().min(1).max(4096).optional().describe("作業フォルダー（省略してよい。設定の作業フォルダーを使う）");
}

/** 作業フォルダーを使うツールの文脈（作業フォルダーの実際のパス、zip、主スレッドのエンジン、policy、動く形、評価の Worker の読み込み元と動かし方） */
export interface WorkContextForTool {
  root: string;
  zip: string;
  /** 主スレッドのエンジン（互換表の判定、fml_summary の既定値、fml_pull の保存値の読み取り。評価には使わない） */
  engine: Engine;
  policy: Policy;
  /** 呼び出しの初めに 1 回読んだ動く形（接続のファイル。15.4、15.6） */
  mode: WorkspaceMode;
  /** 評価（Worker）の読み込み元と動かし方（計画 24.5） */
  source: EvalSource;
  run: (timeoutSec?: number) => RunOptions;
}

/**
 * 作業フォルダーを決め、計算式プラグインのエンジンと policy を用意する。だめなら応答（denied / failed / incompatible）を返す。
 * 作業フォルダーの照合（4.1）→ 計算式プラグインの zip（設定項目か .env）→ エンジン（主スレッド。互換表の判定）→ policy（作業フォルダーの policy/authoring-policy.json）→
 * 動く形（接続のファイル。設定されていて読めなければ ConnectionError を投げる。1 接続の形に戻らない。15.4）
 */
export async function prepare(ctx: ServerContext, workspaceId: string | undefined): Promise<WorkContextForTool | ToolResult> {
  let root: string;
  try {
    root = ctx.binding.resolve(workspaceId);
  } catch (e) {
    if (e instanceof WorkspaceError) return failure("denied", "WorkspaceError", e.message);
    throw e;
  }
  const incompatible = incompatibleResult();
  if (incompatible) return incompatible;
  const zip = zipOf(ctx, root);
  // 設定の値の誤りの文（パスを含みうる）は返さない。中身は fml_status の pluginZip.problem（パスをファイル名にしたもの）で
  if (zip.problem) return failure("failed", "PluginZipError", `計算式プラグインの zip の設定が読めない（設定元: ${zip.source}）。fml_status で確かめる。${zipGuide(ctx.surface)}`);
  if (!zip.zip) return failure("failed", "PluginZipError", `計算式プラグインの zip が未設定。${zipGuide(ctx.surface)}`);
  let engine: Engine;
  try {
    engine = await ctx.engine(zip.zip);
  } catch (e) {
    if (!(e instanceof PluginZipError)) throw e;
    // 誤りの種類ごとの決まった文（zip のパスや zip の中のコードの文を返さない）。版が対応外は incompatible、それ以外（無い・読めない・変わった）は failed
    const r = describeZipError(e, ctx.surface);
    return r.incompatible ? failure("incompatible", "IncompatibleError", r.text) : failure("failed", "PluginZipError", r.text);
  }
  const zp = zipProblem(engine);
  if (zp) return failure("incompatible", "IncompatibleError", zp);
  const policy = loadPolicy(root);
  return { root, zip: zip.zip, engine, policy, mode: ctx.mode(root), source: ctx.evalSource(zip.zip), run: (t) => ctx.runOptions(t) };
}

/** 互換表とビルドの組み合わせが合わなければ incompatible（作業フォルダーを使うツールだけが使う。7 章） */
export function incompatibleResult(): ToolResult | undefined {
  const p = buildProblem();
  return p ? failure("incompatible", "IncompatibleError", `${p}（formula MCP を入れ直す・更新する）`) : undefined;
}

/** 動く形を要るときに 1 回だけ読む（kintone/** の中のファイルを読むときだけ。fml_summary / fml_diff は接続のファイルが壊れていても settings/ を読める。15.9 の表） */
export function lazyMode(ctx: ServerContext, root: string): () => WorkspaceMode {
  let m: WorkspaceMode | undefined;
  return () => (m ??= ctx.mode(root));
}

export const isToolResult = (v: unknown): v is ToolResult => typeof v === "object" && v !== null && "content" in v && "isError" in v;

/** 中核が code を返さなかったときの誤りの種類 */
const DEFAULT_CODE: Record<Exclude<SaveResult["status"], "ok">, string> = {
  invalid: "InputError",
  conflict: "ConflictError",
  denied: "PermissionError",
  failed: "Error"
};

/**
 * 中核の SaveResult を応答に（確定の後に片付けられなかったときは ok に cleanup と note を添える。extra は ok の応答に足す値）。
 * 中核の文は決まった文（Worker の中の想定外の例外は種類だけ。save.ts の safeMessageOf）。zip の誤りは種類ごとの決まった文に（パスを含まない）
 */
export function fromSaveResult(r: SaveResult, extra: Record<string, unknown> = {}, surface: Surface = "claude-code"): ToolResult {
  const findings = r.findings as unknown as Finding[];
  if (r.status === "ok") {
    return ok(
      { path: r.path, ...(r.summary ? { summary: r.summary } : {}), ...(r.diff ? { diff: r.diff } : {}), ...extra, ...(r.cleanup ? { cleanup: r.cleanup, note: r.message } : {}) },
      { findings, digest: r.digest }
    );
  }
  const message = r.code === "PluginZipError" && r.zipCode ? describeZipError(new PluginZipError(r.message ?? "", r.zipCode as PluginZipErrorCode, {}), surface).text : r.message ?? r.status;
  return failure(r.status, r.code ?? DEFAULT_CODE[r.status], message, findings);
}

/** 1 つの値（before / after / value を JSON にしたもの）の長さの上限（文字）。MCP 0.3.6 で 2,000 → 16,000（テーブル自身の式で作れる 100 行が収まる。応答全体の 64 KiB はそのまま） */
export const MAX_VALUE_CHARS = 16000;

/**
 * 長い値を切る。テーブル（行の配列）は行の切れ目で切り、省いた行の数を返す（JSON として読めるまま。MCP 0.3.6）。
 * 1 行目だけで上限を超えるとき・配列でない値は、今までどおり JSON の文字列の先頭を残して印を付ける
 */
export function cutValueRows(v: unknown): { value: unknown; rowsOmitted?: number } {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined || s.length <= MAX_VALUE_CHARS) return { value: v };
  if (Array.isArray(v)) {
    const kept: unknown[] = [];
    let len = 2;
    for (const row of v) {
      const n = JSON.stringify(row)?.length ?? 4;
      if (len + n + 1 > MAX_VALUE_CHARS) break;
      kept.push(row);
      len += n + 1;
    }
    if (kept.length > 0) return { value: kept, rowsOmitted: v.length - kept.length };
  }
  return { value: `${s.slice(0, MAX_VALUE_CHARS)}…（${s.length.toLocaleString()} 文字を切った）` };
}

export const cutValue = (v: unknown): unknown => cutValueRows(v).value;

/** 項目の前後の値を切る（テーブルを行の切れ目で切ったら beforeRowsOmitted / afterRowsOmitted に省いた行の数） */
export function cutLine<T extends { before: unknown; after: unknown }>(l: T): T & { beforeRowsOmitted?: number; afterRowsOmitted?: number } {
  const b = cutValueRows(l.before);
  const a = cutValueRows(l.after);
  return { ...l, before: b.value, after: a.value, ...(b.rowsOmitted ? { beforeRowsOmitted: b.rowsOmitted } : {}), ...(a.rowsOmitted ? { afterRowsOmitted: a.rowsOmitted } : {}) };
}
