/**
 * fv_pull（アプリの今の項目検証プラグインの設定を取る。MCP 0.4.0。field-validation の計画 4.2・4.3）: 中核の fvPullSettings（kintone の API ラボのプラグインの設定の GET だけ）。
 * fml_pull と同じ決まり: アプリのフォルダー kintone/<profile>/<番号>-<アプリ名>/ に、設定画面のダウンロードと同じ名前（rex0220-field-validation-app<番号>-<日時>.json）で
 * 新しいファイルとしてだけ置く（上書きしない。フォルダーが無ければ印を置いて作る）。書くのは元の値の封筒。保存値の読み取りに計算式プラグインの zip の authoring API（readConfig）を使う。
 * 返すのは要約と digest（設定ファイルそのものは返さない）
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FileExistsError, InputError, RestError, WRITE_ROOTS, appDirFor, assertChangeAllowed, digestOf, ensureAppFolder, fvPullSettings, fvSummarizeSettings, resolveWrite, snapshotNameOf, writeNewFile } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { checkWritable, fromError, precheckAppWrite, rel } from "./files.ts";
import { appSchema, kintoneFor, profileOf, profileSchema } from "./kintone.ts";

export function registerFvPull(server: McpServer, ctx: ServerContext): void {
  const preview =
    ctx.surface === "claude-code"
      ? { preview: z.boolean().optional().describe("動作テスト環境（保存して未反映）の設定（アプリ管理の権限が要る）") }
      : {};
  server.registerTool(
    "fv_pull",
    {
      title: "アプリの今の項目検証プラグインの設定を取る",
      description:
        "kintone のアプリに入っている項目検証プラグイン（rex0220 field validation）の今の設定を取り、設定画面の「設定をダウンロード」と同じ名前で作業フォルダーのアプリのフォルダーに新しく置く（上書きしない。中身は元の値の封筒）。" +
        "kintone の API ラボ（プラグインの設定情報を取得する API）を有効にした環境だけ。kintone には読み取り（GET）だけ。要約と digest を返す。" +
        "取れなければ、利用者に項目検証の設定画面でダウンロードしてもらい inbox/ に置いて fml_take。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          app: appSchema,
          profile: profileSchema,
          ...preview
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          const t = profileOf(w.mode, input.profile);
          const appId = input.app;
          const existing = precheckAppWrite(w.root, t.def, appId, snapshotNameOf(appId, new Date(), "field-validation"), "snapshot", t.mode);
          const k = kintoneFor(t, appId);
          const usePreview = "preview" in input && input.preview === true;
          let result;
          try {
            result = await fvPullSettings(k.client, w.engine, { app: appId, preview: usePreview, guestSpaceId: k.guestSpaceId });
          } catch (e) {
            if (e instanceof RestError && /plugin\/config/.test(e.apiPath ?? "")) {
              return failure(
                "failed",
                "RestError",
                `${e.message}。確かめること: kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得または更新するREST API」が有効か、権限（運用中: レコード閲覧。API トークンでも可 / 動作テスト環境: アプリ管理）、アプリに項目検証プラグインが入っているか。取れなければ、利用者に項目検証の設定画面で「設定をダウンロード」してもらい、inbox/ に置いて fml_take`
              );
            }
            throw e;
          }
          const name = snapshotNameOf(appId, new Date(), "field-validation");
          const dir = existing ?? appDirFor(w.root, t.def.profile, appId, result.appName);
          const real = checkWritable(w.root, path.join(dir, name), WRITE_ROOTS.kintone, "snapshot", t.mode);
          ensureAppFolder(dir, t.def, appId);
          const text = `${JSON.stringify(result.envelope, null, 2)}\n`;
          try {
            writeNewFile(real, text, () => {
              if (resolveWrite(rel(w.root, real), WRITE_ROOTS.kintone, w.root) !== real) throw new InputError("書く先のフォルダーが途中で変わった");
              assertChangeAllowed(w.root, real, "snapshot", t.mode);
            });
          } catch (e) {
            if (e instanceof FileExistsError) return failure("conflict", "ConflictError", `${rel(w.root, real)} は既にある（上書きしない）。少し待ってからやり直す（名前は日時で決まる）`);
            throw e;
          }
          return ok(
            {
              path: rel(w.root, real),
              appId,
              appName: result.appName,
              revision: result.revision,
              format: result.format,
              preview: usePreview,
              summary: fvSummarizeSettings(result.envelope, rel(w.root, real)),
              profile: t.def.profile,
              ...(k.guestSpaceId ? { guestSpaceId: k.guestSpaceId } : {}),
              auth: k.authLabel,
              baseUrl: k.client.baseUrl,
              next: "直すなら fml_edit（plugin: field-validation）で -edit.json に写し、fv_summary（digest）→ fv_update_rows → fv_check"
            },
            { digest: digestOf(text) }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
