/**
 * fml_update_fields（既存の設定の項目の行の差し替え。計画 24.2.1）: 中核の updateFields。fml_summary が返した digest（expectedDigest）を照合し、違えば conflict。
 * rows は fieldcode の行（元の値 state / formulaSet / edit / hide / rank だけ）を複数まとめて差し替える（設定に無い fieldcode には足さない）。common は共通の設定をキーごとに置き換える。
 * 説明は「何をするか」と「結果を推し量らず必ず呼ぶ」にとどめる
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { COMMON_KEYS, MAX_SAVE_INPUT_BYTES, MAX_UPDATE_ROWS, updateFields } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { fromSaveResult, isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { baseUrlFields, checkRelPaths, fromError, trustedBaseUrl, usersSourceFor } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { usersSchema } from "./save.ts";

export function registerUpdateFields(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_update_fields",
    {
      title: "計算式プラグインの設定の項目の行を差し替え",
      description:
        "計算式プラグイン（rex0220 formula）の既存の設定 JSON の、項目の行（fieldcode で選ぶ。計算式・有効・編集可・非表示・ランク）を複数まとめて差し替え、共通の設定（各種設定・一覧・権限など）をキーごとに置き換えて、検査（normalize）を通して保存する。" +
        "expectedDigest には fml_summary が返した digest を渡す（読んだ後に変わっていれば保存しない）。" +
        "保存できるか・結果を推し量らず、必ずこのツールを呼び、返った status と findings をそのまま利用者に伝える。警告は消さずに伝える。保存の後は fml_calc で値を確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス。-edit.json か、AI が作った設定。ダウンロード / pull のファイルは書き換えない）"),
          expectedDigest: z.string().regex(/^[0-9a-f]{64}$/).describe("fml_summary が返した digest（sha256 の 16 進 64 文字）"),
          rows: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).describe(`差し替える行の JSON の配列（1〜${MAX_UPDATE_ROWS} 行）。各行は fieldcode と、変える元の値（state、formulaSet、edit、hide、rank）だけ。例 [{"fieldcode":"金額合計","formulaSet":"SUM(金額)","rank":1}]。UTF-8 で 256 KiB まで`),
          common: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).optional().describe(`共通の設定の JSON（使えるキーは ${COMMON_KEYS.join("、")}。キーごとに丸ごと置き換える。封筒と pluginInfos は変えられない）。変えないなら省略`),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダー kintone/… の中の設定なら省略する（同じフォルダーの fields.json）。省略すると封筒の appId の fields/<appId>.json"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（APP_URL などの評価に使う接続先。アプリのフォルダーの中のファイルは省略する）"),
          users: usersSchema
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ path: input.path, fields: input.fields, users: input.users });
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          const baseUrl = trustedBaseUrl(w.mode, w.root, path.resolve(w.root, input.path), input.profile);
          const users = usersSourceFor(w.root, input.users, w.mode);
          const r = await updateFields(
            { root: w.root, mode: w.mode, policy: w.policy, source: w.source, run: w.run(), baseUrl: baseUrl.baseUrl, usersSource: users.src, usersOrigin: users.origin },
            { path: input.path, expectedDigest: input.expectedDigest, rows: input.rows, common: input.common, fields: input.fields }
          );
          return fromSaveResult(r, baseUrlFields(baseUrl), ctx.surface);
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
