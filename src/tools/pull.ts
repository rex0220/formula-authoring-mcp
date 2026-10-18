/**
 * fml_pull（アプリの今の設定を取る。計画 24.2）: kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得する」（GET だけ）。
 * 設定画面の「設定をダウンロード」と同じ封筒形式で、アプリのフォルダー kintone/<profile>/<番号>-<アプリ名>/ に、ダウンロードと同じ名前で新しいファイルとしてだけ置く
 * （上書きしない。フォルダーが無ければ印を置いて作る。15.5）。Desktop は運用環境の設定だけ（動作テスト環境はアプリ管理の権限が要る）。
 * 返すのは要約と digest（設定ファイルそのものは返さない）。保存値の読み取り（readConfig / toExportBody）に計算式プラグインの zip の authoring API（主スレッドのエンジン）を使う
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FileExistsError, InputError, RestError, WRITE_ROOTS, appDirFor, assertChangeAllowed, digestOf, ensureAppFolder, pullSettings, resolveWrite, snapshotNameOf, summarizeSettings, writeNewFile } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { checkWritable, fromError, precheckAppWrite, redactPersonal, rel } from "./files.ts";
import { appSchema, kintoneFor, profileOf, profileSchema } from "./kintone.ts";

export function registerPull(server: McpServer, ctx: ServerContext): void {
  const preview =
    ctx.surface === "claude-code"
      ? { preview: z.boolean().optional().describe("動作テスト環境（保存して未反映）の設定（アプリ管理の権限が要る）") }
      : {};
  server.registerTool(
    "fml_pull",
    {
      title: "アプリの今の計算式プラグインの設定を取る",
      description:
        "kintone のアプリに入っている計算式プラグイン（rex0220 formula）の今の設定を取り、設定画面の「設定をダウンロード」と同じ形・同じ名前で作業フォルダーのアプリのフォルダーに新しく置く（上書きしない）。" +
        "kintone の API ラボ（プラグインの設定情報を取得する API）を有効にした環境だけ。kintone には読み取り（GET）だけ。要約と digest を返す。" +
        "取れなければ、利用者に設定画面でダウンロードしてもらい inbox/ に置いて fml_take。結果を推し量らず、このツールで確かめる",
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
          const pluginId = w.engine.source.pluginId;
          if (!pluginId) throw new InputError("計算式プラグインのプラグイン ID が分からない（計算式プラグインの zip に PUBKEY が無い）");
          const t = profileOf(w.mode, input.profile);
          const appId = input.app;
          // 保存先に書けるか（実体が作業フォルダーの中、印が今の接続のこのアプリのもの）を kintone に送る前に確かめる
          const existing = precheckAppWrite(w.root, t.def, appId, snapshotNameOf(appId), "snapshot", t.mode);
          const k = kintoneFor(t, appId);
          const usePreview = "preview" in input && input.preview === true;
          let result;
          try {
            result = await pullSettings(k.client, w.engine, { app: appId, preview: usePreview, guestSpaceId: k.guestSpaceId, pluginId });
          } catch (e) {
            if (e instanceof RestError && /plugin\/config/.test(e.apiPath ?? "")) {
              return failure(
                "failed",
                "RestError",
                `${e.message}。確かめること: kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得または更新するREST API」が有効か、権限（運用中: レコード閲覧。API トークンでも可 / 動作テスト環境: アプリ管理）、アプリに計算式プラグインが入っているか。取れなければ、利用者に設定画面で「設定をダウンロード」してもらい、inbox/ に置いて fml_take`
              );
            }
            throw e;
          }
          const dir = existing ?? appDirFor(w.root, t.def.profile, appId, result.appName);
          const real = checkWritable(w.root, path.join(dir, snapshotNameOf(appId)), WRITE_ROOTS.kintone, "snapshot", t.mode);
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
              summary: summarizeSettings(redactPersonal(result.envelope), rel(w.root, real), { defaults: { misc: w.engine.api.MISC_DEFAULTS as Record<string, unknown> } }),
              profile: t.def.profile,
              ...(k.guestSpaceId ? { guestSpaceId: k.guestSpaceId } : {}),
              auth: k.authLabel,
              baseUrl: k.client.baseUrl,
              next: "直すなら fml_edit で -edit.json に写し、fml_summary（digest）→ fml_update_fields"
            },
            { digest: digestOf(text) }
          );
        } catch (e) {
          return fromError(e);
        }
      })
  );
}
