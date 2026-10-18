/**
 * fml_record（レコード 1 件。計画 24.2）: kintone からレコードを取り、アプリのフォルダーの records/<番号>.json に保存して（fml_calc の入力。本人だけが読める 0o600）、
 * 形の要約だけを返す（文字数・行数・数値の桁・テーブルの行数・添付の件数。値は返さない。CLI の record --summary）。
 *   - アプリのフォルダー（kintone/<profile>/<番号>-…/）は fml_fields か fml_pull が作る。無ければ止める（15.5。record はフォルダーを作らない）
 *   - fieldsFrom（設定 JSON）を渡すと、その設定が使う項目だけに絞る（個人情報を減らす）
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { InputError, WRITE_ROOTS, describeRecord, fetchRecord, usedFieldCodes } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { ok } from "../result.ts";
import { incompatibleResult, lazyMode, workspaceIdSchema } from "./common.ts";
import { appDirIn, checkRelPaths, checkWritable, fromError, readSettingsFile, rel, writeChecked } from "./files.ts";
import { appSchema, kintoneFor, profileFor, profileSchema } from "./kintone.ts";

export function registerRecord(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_record",
    {
      title: "kintone のレコードを取る（calc 用）",
      description:
        "計算式プラグイン（rex0220 formula）の模擬の計算（fml_calc）に使うレコード 1 件を kintone から取り、作業フォルダーのアプリのフォルダーに保存する。返すのは形の要約だけ（値は返さない）。" +
        "代表の 1 件（テーブルが複数行、空の項目がある）を選ぶ。先に fml_fields（か fml_pull）でアプリのフォルダーを作る。kintone には読み取り（GET）だけ。保存したファイルはレコードの値を含む（コミットしない。Read で開かない）",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          app: appSchema,
          id: z.number().int().positive().describe("レコード番号"),
          profile: profileSchema,
          fieldsFrom: z.string().min(1).max(512).optional().describe("この設定 JSON が使う項目だけに絞る（作業フォルダーからの相対パス。normalize した設定）")
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (input) => {
      try {
        checkRelPaths({ fieldsFrom: input.fieldsFrom });
        const root = ctx.binding.resolve(input.workspaceId);
        const incompatible = incompatibleResult();
        if (incompatible) return incompatible;
        const t = profileFor(ctx, root, input.profile);
        const appId = input.app;
        const dir = appDirIn(root, t.def, appId);
        if (!dir) throw new InputError(`アプリ ${appId} のフォルダー（kintone/${t.def.profile}/${appId}-…）が無い。先に fml_fields（か fml_pull）でアプリのフォルダーを作る`);
        const target = path.join(dir, "records", `${input.id}.json`);
        let keep: Set<string> | undefined;
        const notes: string[] = [];
        if (input.fieldsFrom) {
          const settings = readSettingsFile(root, input.fieldsFrom, lazyMode(ctx, root)).settings;
          const codes = usedFieldCodes(settings);
          if (codes) keep = codes;
          else notes.push(`${input.fieldsFrom} に使う項目の情報（usedFields）が無いので絞らなかった（normalize した設定なら絞れる）`);
        }
        // 書けるかを kintone に送る前に確かめる（送ってから断らない）
        checkWritable(root, target, WRITE_ROOTS.kintone, "record", t.mode);
        const k = kintoneFor(t, appId);
        const file = await fetchRecord(k.client, { app: appId, id: input.id, guestSpaceId: k.guestSpaceId, keep });
        const out = writeChecked(root, target, `${JSON.stringify(file, null, 2)}\n`, WRITE_ROOTS.kintone, "record", t.mode, 0o600);
        return ok({
          path: rel(root, out),
          appId,
          id: input.id,
          shape: describeRecord(file),
          ...(file.keptFields ? { keptFields: file.keptFields.length } : {}),
          profile: t.def.profile,
          ...(k.guestSpaceId ? { guestSpaceId: k.guestSpaceId } : {}),
          auth: k.authLabel,
          baseUrl: k.client.baseUrl,
          note: `レコードの値を含む（コミットしない。Read で開かない）。fml_calc の records に ${input.id} を渡す${notes.length ? `。${notes.join("。")}` : ""}`
        });
      } catch (e) {
        return fromError(e);
      }
    }
  );
}
