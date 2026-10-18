/**
 * fml_fields（項目定義。計画 24.2）: kintone から項目定義・レイアウト・一覧・アプリ名を取り、アプリのフォルダー kintone/<profile>/<番号>-<アプリ名>/fields.json に
 * 保存して、要約（1 項目 1 行。レイアウトの順、テーブルの子は字下げ、○ = 計算式を設定できる型）を返す。フォルダーが無ければ作る（中身より先に印を置く。15.5）。
 * 印が今の接続のこのアプリのものでなければ、kintone に送る前に conflict
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WRITE_ROOTS, appDirFor, contextTargetsOf, ensureAppFolder, fetchFields, listFields } from "../core.ts";
import { zipOf, type ServerContext } from "../context.ts";
import { ok, type Finding } from "../result.ts";
import { incompatibleResult, workspaceIdSchema } from "./common.ts";
import { checkWritable, fromError, precheckAppWrite, rel, writeChecked } from "./files.ts";
import { appSchema, kintoneFor, profileFor, profileSchema } from "./kintone.ts";

/** 要約の上限（AI に返す量） */
const MAX_SUMMARY_CHARS = 64 * 1024;

/** 計算式を設定できる型（zip の authoring API の TARGET_TYPES。zip が無くても要約は出す = ○ / － の印なし） */
async function targetTypes(ctx: ServerContext, root: string): Promise<ReadonlySet<string> | undefined> {
  const z = zipOf(ctx, root);
  if (!z.zip) return undefined;
  try {
    return new Set((await ctx.engine(z.zip)).api.TARGET_TYPES as readonly string[]);
  } catch {
    return undefined;
  }
}

export function registerFields(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_fields",
    {
      title: "kintone の項目定義を取る",
      description:
        "計算式プラグイン（rex0220 formula）の設定を作るアプリの項目定義（フィールドコード、型、ラベル、選択肢、テーブルの子、ルックアップ、一覧）を kintone から取り、作業フォルダーのアプリのフォルダーに保存して、1 項目 1 行の要約を返す（レイアウトの順。○ = 計算式を設定できる型）。" +
        "計算式にはラベルでなくフィールドコードを書く。kintone には読み取り（GET）だけ。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          app: appSchema,
          profile: profileSchema,
          preview: z.boolean().optional().describe("動作テスト環境（保存して未反映）の項目定義（アプリ管理の権限が要る）"),
          lang: z.enum(["ja", "en", "zh"]).optional().describe("ラベルの言語（既定 ja）")
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          const root = ctx.binding.resolve(input.workspaceId);
          const incompatible = incompatibleResult();
          if (incompatible) return incompatible;
          const t = profileFor(ctx, root, input.profile);
          const appId = input.app;
          // 保存先に書けるか（実体が作業フォルダーの中、印が今の接続のこのアプリのもの）を kintone に送る前に確かめる
          const existing = precheckAppWrite(root, t.def, appId, "fields.json", "fields", t.mode);
          const k = kintoneFor(t, appId);
          const file = await fetchFields(k.client, { app: appId, preview: input.preview === true, guestSpaceId: k.guestSpaceId, lang: input.lang });
          const dir = existing ?? appDirFor(root, t.def.profile, appId, file.appName);
          const target = path.join(dir, "fields.json");
          checkWritable(root, target, WRITE_ROOTS.kintone, "fields", t.mode);
          ensureAppFolder(dir, t.def, appId);
          const out = writeChecked(root, target, `${JSON.stringify(file, null, 2)}\n`, WRITE_ROOTS.kintone, "fields", t.mode);
          let summary = listFields(file, { targetTypes: await targetTypes(ctx, root) });
          const truncated = summary.length > MAX_SUMMARY_CHARS;
          if (truncated) summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}\n…（打ち切った。全体は ${rel(root, out)}）`;
          const targets = contextTargetsOf(file.properties);
          const findings: Finding[] = [
            ...(file.viewsNote ? [{ level: "info", rule: "fields.views", message: file.viewsNote }] : []),
            ...(truncated ? [{ level: "info", rule: "truncated", message: "要約を打ち切った" }] : [])
          ];
          return ok(
            {
              path: rel(root, out),
              appId,
              appName: file.appName,
              fieldCount: Object.keys(file.properties).length,
              viewCount: file.views ? Object.keys(file.views).length : null,
              lookupTargets: Object.keys(targets.lookupTargets).length,
              relatedTargets: Object.keys(targets.relatedTargets).length,
              summary,
              profile: t.def.profile,
              ...(k.guestSpaceId ? { guestSpaceId: k.guestSpaceId } : {}),
              auth: k.authLabel,
              baseUrl: k.client.baseUrl
            },
            findings.length ? { findings } : {}
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
