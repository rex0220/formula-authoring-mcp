/**
 * 診断の計算式プラグインの zip の報告（fml_status / fml_workspace_status。Codex の B1 レビュー MAJOR 3）:
 * 実際に読んで、読めるか・互換か・計算式プラグインの版・authoring API の版を返す（パスの選び方だけで「準備ができている」と答えない）。
 * 絶対パスは返さない（ファイル名だけ）。読み込みの誤りは中核の PluginZipError の code（種類）と info（分かっている版）から決まった文にする
 * （生の誤りの文は返さない。「zip として読めない」と「読めるが合わない」を分ける。Codex の B1 再レビュー MAJOR 1）
 */
import path from "node:path";
import { zipProblem } from "../compat.ts";
import { zipGuide, zipOf, type ServerContext } from "../context.ts";
import { sanitizeMessage } from "../result.ts";
import { describeZipError } from "../zip-error.ts";

export interface ZipReport {
  configured: boolean;
  source: string;
  fileName?: string;
  readable?: boolean;
  compatible?: boolean;
  pluginVersion?: string;
  authoringApiVersion?: number;
  /** 読めない・合わないときの種類（中核の PluginZipError の code。想定外の誤りは unexpected） */
  code?: string;
  problem?: string;
}

const scrub = (message: string, zip: string | undefined): string => sanitizeMessage(zip ? message.split(zip).join(path.basename(zip)) : message);

/** 計算式プラグインの zip を読んで報告する。next に足す文も返す（問題が無ければ undefined） */
export async function zipReport(ctx: ServerContext, root: string | undefined): Promise<{ report: ZipReport; next?: string }> {
  const z = zipOf(ctx, root);
  if (z.problem) return { report: { configured: true, source: z.source, problem: scrub(z.problem, z.zip) }, next: `計算式プラグインの zip の設定が読めない: ${scrub(z.problem, z.zip)}` };
  if (!z.zip) {
    const where = ctx.surface === "claude-code" && !root ? "（作業フォルダーの .env にあれば使う）" : "";
    return { report: { configured: false, source: z.source }, next: `計算式プラグインの zip が未設定${where}。${zipGuide(ctx.surface)}` };
  }
  const base: ZipReport = { configured: true, source: z.source, fileName: path.basename(z.zip) };
  try {
    const engine = await ctx.engine(z.zip);
    const api = (engine.api as { apiVersion?: unknown } | undefined)?.apiVersion;
    const problem = zipProblem(engine);
    const report: ZipReport = { ...base, readable: true, compatible: !problem, pluginVersion: engine.source.pluginVersion, ...(typeof api === "number" ? { authoringApiVersion: api } : {}), ...(problem ? { problem } : {}) };
    return { report, ...(problem ? { next: `計算式プラグインの zip が合わない: ${problem}` } : {}) };
  } catch (e) {
    const r = describeZipError(e, ctx.surface);
    const report: ZipReport = {
      ...base,
      ...(r.readable !== undefined ? { readable: r.readable } : {}),
      compatible: false,
      ...(r.pluginVersion ? { pluginVersion: r.pluginVersion } : {}),
      ...(r.authoringApiVersion !== undefined ? { authoringApiVersion: r.authoringApiVersion } : {}),
      code: r.code,
      problem: r.text
    };
    return { report, next: r.text };
  }
}
