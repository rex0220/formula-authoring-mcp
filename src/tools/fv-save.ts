/**
 * fv_save_settings / fv_update_rows（項目検証プラグインの設定の保存。MCP 0.4.0。field-validation の計画 4.3）: 中核の fvSaveNewSettings / fvUpdateRows（検査は Worker の fv-normalize）。
 * fml_save_settings / fml_update_fields と同じ約束（上書きしない、digest の照合、書ける場所、状態と誤りの文）。書くのは元の値の封筒（項目検証の設定画面で「設定をアップロード」できる形）。
 * 説明は「何をするか」と「結果を推し量らず必ず呼ぶ」にとどめる（断る場合は fml_docs の fv）
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FV_COMMON_KEYS, FV_ROW_KEYS, MAX_SAVE_INPUT_BYTES, MAX_UPDATE_ROWS, fvSaveNewSettings, fvUpdateRows } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { fromSaveResult, isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { baseUrlFields, checkRelPaths, fromError, trustedBaseUrl, usersSourceFor } from "./files.ts";
import { profileSchema } from "./kintone.ts";
import { usersSchema } from "./save.ts";

const FV_NEXT = "確かめる: fv_check（取ったレコードに当てた判定の模擬）。差は fv_diff";

export function registerFvSaveSettings(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_save_settings",
    {
      title: "項目検証プラグインの新しい設定を保存",
      description:
        "kintone の項目検証プラグイン（rex0220 field validation）Ver.72 以降の新しい設定 JSON（封筒形式。項目ごとの必須条件・入力不可・非表示・初期化・検証条件・テーブル内非表示）を、検査（fv normalize。式は計算式プラグインの zip で評価）を通して作業フォルダーに保存する。上書きはしない。" +
        "保存できるか・結果を推し量らず、必ずこのツールを呼び、返った status（ok / invalid / conflict / denied / failed）と findings をそのまま利用者に伝える。警告は保存を止めないが、消さずに伝える。保存の後は fv_check で判定を確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("保存先。作業フォルダーからの相対パス（例 settings/FV-APP4376-経費申請.json、kintone/dev/4376-経費申請/FV-経費申請.json）"),
          content: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).describe("設定 JSON（封筒形式。pluginID は \"rex0220 field validation plugin\"、PluginVersion は \"72\" 以上。pluginInfos には設定する項目の行だけ。fml_docs の fv-sample-settings を写す）の全文。UTF-8 で 256 KiB まで"),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス。例 fields/4376.json）。アプリのフォルダー kintone/… の中に保存するときは省略する（同じフォルダーの fields.json を使う）。省略すると封筒の appId の fields/<appId>.json"),
          expectedAbsent: z.literal(true).describe("同じ名前のファイルが無いこと（上書きしない）。true だけ"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（評価の文脈の接続先。アプリのフォルダーの中のファイルは省略する）"),
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
          const r = await fvSaveNewSettings(
            { root: w.root, mode: w.mode, policy: w.policy, source: w.source, run: w.run(), baseUrl: baseUrl.baseUrl, usersSource: users.src, usersOrigin: users.origin },
            { path: input.path, content: input.content, fields: input.fields, expectedAbsent: input.expectedAbsent }
          );
          return fromSaveResult(r, { ...baseUrlFields(baseUrl), ...(r.status === "ok" ? { next: FV_NEXT } : {}) }, ctx.surface);
        } catch (e) {
          return fromError(e);
        }
      })
  );
}

export function registerFvUpdateRows(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fv_update_rows",
    {
      title: "項目検証プラグインの設定の行を差し替え・追加",
      description:
        "項目検証プラグイン（rex0220 field validation）の既存の設定 JSON の、項目の行（fieldcode で選ぶ）を複数まとめて差し替え・追加し、共通の設定（プラグイン有効・非表示前処理・NOTE・説明・枠線など）をキーごとに置き換えて、検査（fv normalize）を通して保存する（新しいファイルに全体を書き直さない）。" +
        "expectedDigest には fv_summary が返した digest を渡す（読んだ後に変わっていれば保存しない）。" +
        "保存できるか・結果を推し量らず、必ずこのツールを呼び、返った status と findings と diff をそのまま利用者に伝える。警告は消さずに伝える。保存の後は fv_check で判定を確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).describe("設定 JSON のファイル（作業フォルダーからの相対パス。fml_edit（plugin: field-validation）で写した -edit.json か、AI が作った設定。ダウンロード / pull のファイルは書き換えない）"),
          expectedDigest: z.string().regex(/^[0-9a-f]{64}$/).describe("fv_summary が返した digest（sha256 の 16 進 64 文字）"),
          rows: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).describe(`差し替える・足す行の JSON の配列（1〜${MAX_UPDATE_ROWS} 行）。各行は fieldcode と、変えるキー（${FV_ROW_KEYS.filter((k) => k !== "fieldcode").join("、")}）だけ。キーごとに丸ごと置き換える（condInfos は検証条件の全部、テーブルの行の tblfields は列の非表示の全部）。設定に無い fieldcode の行は足す（state を省けば true、ほかは既定）。例 [{"fieldcode":"金額","formulaSet":"区分 = \\"A\\""},{"fieldcode":"備考","hideSet":"区分 = \\"B\\"","init":true}]。UTF-8 で 256 KiB まで`),
          common: z.string().min(1).max(MAX_SAVE_INPUT_BYTES).optional().describe(`共通の設定の JSON（使えるキーは ${FV_COMMON_KEYS.join("、")}。キーごとに丸ごと置き換える。封筒と pluginInfos は変えられない）。変えないなら省略`),
          fields: z.string().min(1).max(512).optional().describe("項目定義のファイル（作業フォルダーからの相対パス）。アプリのフォルダー kintone/… の中の設定なら省略する（同じフォルダーの fields.json）。省略すると封筒の appId の fields/<appId>.json"),
          profile: profileSchema.describe("kintone の接続のファイルの profile（評価の文脈の接続先。アプリのフォルダーの中のファイルは省略する）"),
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
          const r = await fvUpdateRows(
            { root: w.root, mode: w.mode, policy: w.policy, source: w.source, run: w.run(), baseUrl: baseUrl.baseUrl, usersSource: users.src, usersOrigin: users.origin },
            { path: input.path, expectedDigest: input.expectedDigest, rows: input.rows, common: input.common, fields: input.fields }
          );
          return fromSaveResult(r, { ...baseUrlFields(baseUrl), ...(r.status === "ok" ? { next: FV_NEXT } : {}) }, ctx.surface);
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
