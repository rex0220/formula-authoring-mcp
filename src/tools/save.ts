/**
 * fml_save_settings（新しい設定の保存。計画 24.2）: 中核の saveNewSettings（検査は Worker）。同じ名前があれば conflict（上書きしない）。
 * 説明は「何をするか」と「結果を推し量らず必ず呼ぶ」にとどめ、断る場合の一覧は書かない（print-craft の試作 0-3b: 説明から推し量ってツールを呼ばずに答えた。断る場合は fml_docs に置く）
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_SAVE_INPUT_BYTES, saveNewSettings } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { fromSaveResult, isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { baseUrlFields, checkRelPaths, fromError, trustedBaseUrl, usersSourceFor } from "./files.ts";
import { profileSchema } from "./kintone.ts";

export const usersSchema = z.string().min(1).max(512).optional().describe("ユーザー情報のテストデータ（users/ のファイル。作業フォルダーからの相対パス。fml_users で取ったもの）。省略すると既定の架空の 10 人");

export function registerSaveSettings(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_save_settings",
    {
      title: "計算式プラグインの新しい設定を保存",
      description:
        "kintone の計算式プラグイン（rex0220 formula）の新しい設定 JSON（封筒形式。項目ごとの計算式・ランク・各種設定）を、検査（normalize）を通して作業フォルダーに保存する。上書きはしない。" +
        "保存できるか・結果を推し量らず、必ずこのツールを呼び、返った status（ok / invalid / conflict / denied / failed）と findings をそのまま利用者に伝える。警告は保存を止めないが、消さずに伝える。保存の後は fml_calc で値を確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("保存先。作業フォルダーからの相対パス（例 kintone/dev/4328-出張管理/APP4328-出張管理.json、settings/APP2305-テーブル内集計.json）"),
          content: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).describe("設定 JSON（封筒形式。pluginID は \"rex0220 formula plugin\"。pluginInfos には計算式を置く項目の行だけ）の全文。UTF-8 で 256 KiB まで"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス。例 fields/2305.json）。アプリのフォルダー kintone/… の中に保存するときは省略する（同じフォルダーの fields.json を使う）。省略すると封筒の appId の fields/<appId>.json"),
          expectedAbsent: z.literal(true).describe("同じ名前のファイルが無いこと（上書きしない）。true だけ"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（APP_URL などの評価に使う接続先。アプリのフォルダー kintone/<profile>/… の中のファイルは省略する。省略すると defaultProfile、無ければ dev）"),
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
          const r = await saveNewSettings(
            { root: w.root, mode: w.mode, policy: w.policy, source: w.source, run: w.run(), baseUrl: baseUrl.baseUrl, usersSource: users.src, usersOrigin: users.origin },
            { path: input.path, content: input.content, fields: input.fields, expectedAbsent: input.expectedAbsent }
          );
          return fromSaveResult(r, baseUrlFields(baseUrl), ctx.surface);
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
