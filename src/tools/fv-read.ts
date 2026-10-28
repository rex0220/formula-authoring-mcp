/**
 * fv_summary / fv_diff（項目検証プラグインの設定の要約と差。MCP 0.4.0。field-validation の計画 4.3）: 中核の fvSummarizeSettings / fvDiffSettings。読み取りだけ。
 *   - fv_summary: 封筒、共通の設定、行ごとの式の有無と短い式（field を付けるとその行の式の全文）、ファイル全体の digest（fv_update_rows に渡す）。設定ファイルそのものは返さない
 *   - fv_diff: 2 つの設定の差（共通の設定と行ごと）と、変わった行の項目コード
 *   - 封筒の pluginID が項目検証でなければ invalid（readSettingsFile の plugin。計算式の設定は fml_summary / fml_diff）。計算式プラグインの zip は要らない（fml_summary / fml_diff と同じ）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fvDiffSettings, fvSourceOf, fvSummarizeSettings } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { ok } from "../result.ts";
import { incompatibleResult, lazyMode, workspaceIdSchema } from "./common.ts";
import { checkRelPaths, fromError, readSettingsFile } from "./files.ts";

/** 要約・差の上限（AI に返す量） */
const MAX_TEXT_CHARS = 64 * 1024;
/** 変わった行の項目コードの上限 */
const MAX_LIST = 200;

const cut = (text: string): { text: string; truncated: boolean } => (text.length > MAX_TEXT_CHARS ? { text: `${text.slice(0, MAX_TEXT_CHARS)}\n…（打ち切った）`, truncated: true } : { text, truncated: false });

export function registerFvSummary(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_summary",
    {
      title: "項目検証プラグインの設定の要約",
      description:
        "項目検証プラグイン（rex0220 field validation）の設定 JSON の要約（共通の設定、行ごとの必須条件・入力不可・非表示・初期化・検証条件・テーブル内非表示の有無と短い式）か、field を付けるとその行の式の全文。" +
        "ファイル全体の digest（fv_update_rows に渡す）と封筒（アプリ番号・名前・版）も返す。設定ファイルそのものは返さない（Read で開かない）。読み取りだけ",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          field: z.string().min(1).max(200).optional().describe("式の全文を見る行の項目コード。省略すると全体の要約")
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ path: input.path });
          const root = ctx.binding.resolve(input.workspaceId);
          const incompatible = incompatibleResult();
          if (incompatible) return incompatible;
          const f = readSettingsFile(root, input.path, lazyMode(ctx, root), "field-validation");
          const t = cut(fvSummarizeSettings(f.settings, f.relPath, { field: input.field }));
          const s = f.settings;
          const rows = fvSourceOf(s).pluginInfos;
          return ok(
            {
              path: f.relPath,
              appId: typeof s.appId === "number" ? s.appId : null,
              appName: typeof s.appName === "string" ? s.appName : null,
              pluginVersion: typeof s.PluginVersion === "string" ? s.PluginVersion : null,
              date: typeof s.date === "string" ? s.date : null,
              rowCount: rows.length,
              onCount: rows.filter((r) => r.state).length,
              fieldcodes: rows.map((r) => r.fieldcode),
              text: t.text
            },
            { digest: f.digest, ...(t.truncated ? { findings: [{ level: "info", rule: "truncated", message: "要約を打ち切った" }] } : {}) }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}

export function registerFvDiff(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_diff",
    {
      title: "2 つの項目検証プラグインの設定の差",
      description:
        "項目検証プラグイン（rex0220 field validation）の 2 つの設定 JSON の差（共通の設定と、行ごとの式・検証条件・初期化・テーブル内非表示）と、変わった行の項目コード。" +
        "直した設定を取り込む前に利用者に見せる。読み取りだけ",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          before: z.string().min(1).max(512).describe("前の設定（作業フォルダーからの相対パス。ダウンロードなど）"),
          after: z.string().min(1).max(512).describe("後の設定（作業フォルダーからの相対パス。-edit.json など）")
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ before: input.before, after: input.after });
          const root = ctx.binding.resolve(input.workspaceId);
          const incompatible = incompatibleResult();
          if (incompatible) return incompatible;
          const mode = lazyMode(ctx, root);
          const a = readSettingsFile(root, input.before, mode, "field-validation");
          const b = readSettingsFile(root, input.after, mode, "field-validation");
          const d = fvDiffSettings(a.settings, b.settings, { before: a.relPath, after: b.relPath });
          const t = cut(d.lines.join("\n"));
          return ok(
            { before: a.relPath, after: b.relPath, changed: d.changed.slice(0, MAX_LIST), text: t.text },
            t.truncated || d.changed.length > MAX_LIST ? { findings: [{ level: "info", rule: "truncated", message: "差を打ち切った" }] } : {}
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
