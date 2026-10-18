/**
 * fml_normalize（検査。計画 24.2）: 中核の normalizeSettings を評価の Worker で、書き戻さずに実行する（CLI の normalize。check で --check）。
 * 書くのは保存のツール（fml_save_settings / fml_update_fields）だけ。エラーがあれば invalid（findings にエラー）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_TIMEOUT_SEC } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok, type Finding } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { evalTargetOf, jobOf, runJob } from "./eval.ts";
import { baseUrlFields, checkRelPaths, fromError } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { usersSchema } from "./save.ts";

/** --check の差の件数の上限（AI に返す量） */
const MAX_CHECK_DIFFS = 50;

export const timeoutSchema = z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional().describe(`評価の時間上限（秒。1〜${MAX_TIMEOUT_SEC}。既定 60。重い式のとき上げる）`);

export function registerNormalize(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_normalize",
    {
      title: "計算式プラグインの設定を検査",
      description:
        "計算式プラグイン（rex0220 formula）の設定 JSON を設定画面と同じ手順で検査（normalize）し、エラー・警告・情報を返す。ファイルは書き換えない。" +
        "check: true で、入力と既定値を補った出力の差（項目定義が古くないか、ダウンロードを直す前の確認）も返す。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス）"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダー kintone/… の中の設定なら省略できる。省略すると封筒の appId の fields/<appId>.json"),
          check: z.boolean().optional().describe("入力と出力の差を確かめる（ダウンロード / pull した設定を直す前）"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（APP_URL などの評価に使う接続先。アプリのフォルダーの中のファイルは省略する）"),
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
          const t = await evalTargetOf(w, input.path, input);
          const out = await runJob(w, jobOf(w, t, "normalize", { check: input.check === true }), input.timeoutSec);
          const n = out.normalize;
          const findings = [...(n.findings as unknown as Finding[]), ...out.engineWarnings.map((m) => ({ level: "warning", rule: "engine", message: m }))];
          const checkDiffs = n.checkDiffs ? { count: n.checkDiffs.length, items: n.checkDiffs.slice(0, MAX_CHECK_DIFFS) } : undefined;
          if (n.hasErrors || !n.output) return failure("invalid", "NormalizeError", `normalize のエラーがある: ${n.summary.split("\n")[0]}`, findings);
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
