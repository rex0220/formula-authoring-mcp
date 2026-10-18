/**
 * fml_status（作業フォルダーを使わない診断。実装案 5.1 ②、15.8）: サーバーの版、中核の版、出し分け、作業フォルダーの設定、計算式プラグインの zip の設定、
 * できること（capabilities.authoring: 計算式プラグインの zip と互換表、capabilities.kintone: kintone の接続のファイルが設定されていて読めるか）。
 * 準備ができているか（ready）と、足りないときに次にすること（next）を文でも返す（AI が手順の文から推し量らないように。5.2）。
 * 作業フォルダーの形・environments.json・アプリのフォルダーの印は fml_workspace_status だけが返す（r3 MAJOR 6）。秘密の値は出さない。
 * 問題があっても status は ok（ready: false と理由の code。15.10）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import path from "node:path";
import { buildProblem, compatInfo } from "../compat.ts";
import { loadConnections } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { ok } from "../result.ts";
import { VERSION, coreVersion } from "../version.ts";
import { connectionNext, problemOf } from "./connection-report.ts";
import { zipReport } from "./zip-report.ts";

export function registerStatus(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_status",
    {
      title: "計算式プラグインの環境の診断",
      description:
        "kintone の計算式プラグイン（rex0220 formula）の設定づくりの環境の診断。サーバーの版、作業フォルダー、計算式プラグインの zip の設定、kintone の接続のファイルが使えるか。" +
        "準備ができているか（ready）と、足りないときに次にすること（next）を返す。状態は推し量らず、このツールで確かめる。秘密の値は出さない。読み取りだけ",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      let workspace: Record<string, unknown>;
      let root: string | undefined;
      const next: string[] = [];
      if (ctx.surface === "desktop") {
        const ws = ctx.binding.desktopWorkspace();
        root = ws.root;
        // 絶対パスは返さない（フォルダーの名前だけ。Codex の B1 レビュー MAJOR 3）
        workspace = ws.root ? { configured: true, name: path.basename(ws.root) } : { configured: false, problem: ws.problem };
        if (!ws.root) next.push(String(ws.problem));
      } else {
        workspace = { registered: ctx.binding.registered.roots.length, names: ctx.binding.registered.roots.map((r) => path.basename(r)), ignoredInvalidEntries: ctx.binding.registered.dropped };
        if (ctx.binding.registered.roots.length === 0) next.push("作業フォルダーが未登録。作業フォルダーで計算式プラグインのツール（fml_save_settings など）を呼ぶと登録の確認が出る（登録の後は /mcp で formula を再接続）");
      }
      const bp = buildProblem();
      if (bp) next.push(`互換表と合わない: ${bp}（formula MCP を入れ直す・更新する）`);
      const zip = await zipReport(ctx, root);
      if (zip.next) next.push(zip.next);
      // kintone の接続のファイル（ファイルの名前と、読めるか・理由の code だけ。中身は fml_workspace_status）
      let kintone: Record<string, unknown>;
      try {
        const set = loadConnections(ctx.connectionFile, { workspaceRoots: ctx.binding.knownRoots(), env: ctx.env });
        kintone = { ready: true, fileName: set.fileName, profiles: set.profiles.size };
      } catch (e) {
        const p = problemOf(e);
        kintone = { ready: false, ...(ctx.connectionFile ? { fileName: path.basename(ctx.connectionFile) } : {}), code: p.code };
        next.push(connectionNext(p, ctx.surface));
      }
      const authoring = { ready: !bp && zip.report.compatible === true, ...(bp ? { code: "incompatible-build" } : zip.report.code ? { code: zip.report.code } : !zip.report.configured ? { code: "not-configured" } : {}) };
      return ok({
        ready: next.length === 0,
        next: next.length ? next : ["準備ができている。手順と資料は fml_docs、作業フォルダーの診断は fml_workspace_status"],
        version: VERSION,
        core: coreVersion(),
        compat: compatInfo(),
        surface: ctx.surface,
        node: process.version,
        platform: process.platform,
        workspace,
        capabilities: { authoring, kintone },
        pluginZip: zip.report
      });
    }
  );
}
