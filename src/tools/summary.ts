/**
 * fml_summary（設定の要約。計画 24.2。print-craft の pcraft_buttons に相当）: 中核の summarizeSettings（1 項目 1 行。ランク順 = 計算順。field で 1 項目の計算式の全文）、
 * ファイル全体の digest（fml_update_fields に渡す）、封筒（appId、appName、PluginVersion、date）。設定ファイルそのものは返さない。読み取りだけ。
 * 権限のユーザー・組織・グループは件数だけ（コードは出さない）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { bodyOf, rowsOf, summarizeSettings } from "../core.ts";
import { zipOf, type ServerContext } from "../context.ts";
import { ok } from "../result.ts";
import { incompatibleResult, lazyMode, workspaceIdSchema } from "./common.ts";
import { checkRelPaths, fromError, readSettingsFile, redactPersonal } from "./files.ts";

/** 要約の上限（AI に返す量） */
const MAX_TEXT_CHARS = 64 * 1024;

/** 各種設定の既定（zip の authoring API の MISC_DEFAULTS。zip が無くても要約は出す） */
async function miscDefaults(ctx: ServerContext, root: string): Promise<Record<string, unknown> | undefined> {
  const z = zipOf(ctx, root);
  if (!z.zip) return undefined;
  try {
    return (await ctx.engine(z.zip)).api.MISC_DEFAULTS as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function registerSummary(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_summary",
    {
      title: "計算式プラグインの設定の要約",
      description:
        "計算式プラグイン（rex0220 formula）の設定 JSON の要約（項目数、各種設定の既定との差、ボタン、一覧、権限、ランク順 = 計算順の項目と計算式（80 字で切る））か、field を付けるとその項目の計算式の全文。" +
        "ファイル全体の digest（fml_update_fields に渡す）と封筒（アプリ番号・名前・版）も返す。設定ファイルそのものは返さない（Read で開かない）。読み取りだけ",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          field: z.string().min(1).max(200).optional().describe("計算式の全文を見る項目のフィールドコード。省略すると全体の要約")
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
          // 接続のファイルは kintone/** の中のファイルのときだけ読む（そのフォルダーの profile と印を確かめる。15.9 の表）
          const f = readSettingsFile(root, input.path, lazyMode(ctx, root));
          const misc = await miscDefaults(ctx, root);
          let text = summarizeSettings(redactPersonal(f.settings), f.relPath, { field: input.field, ...(misc ? { defaults: { misc } } : {}) });
          const truncated = text.length > MAX_TEXT_CHARS;
          if (truncated) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…（打ち切った）`;
          const rows = rowsOf(bodyOf(f.settings), f.relPath);
          const s = f.settings;
          return ok(
            {
              path: f.relPath,
              appId: typeof s.appId === "number" ? s.appId : null,
              appName: typeof s.appName === "string" ? s.appName : null,
              pluginVersion: typeof s.PluginVersion === "string" ? s.PluginVersion : null,
              date: typeof s.date === "string" ? s.date : null,
              fieldCount: rows.length,
              formulaCount: rows.filter((r) => r.state && r.formulaSet.trim() !== "").length,
              fieldcodes: rows.map((r) => r.fieldcode),
              text,
              ...(misc ? {} : { note: "各種設定の既定との差は出していない（計算式プラグインの zip を読めなかった。fml_status で確かめる）" })
            },
            { digest: f.digest, ...(truncated ? { findings: [{ level: "info", rule: "truncated", message: "要約を打ち切った" }] } : {}) }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
