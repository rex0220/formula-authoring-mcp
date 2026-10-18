/**
 * fml_workspace_status（作業フォルダーの診断。実装案 5.1 ③、15.8）: 作業フォルダーの照合は通す（未登録なら denied）が、互換表の判定は通さない。
 * 動く形（profiles / not-configured / legacy-blocked。15.4）、kintone の接続のファイル（読めるか、既定の profile、profile ごとの接続先・認証の種類・
 * トークンが使えるか、使えない profile とその理由、警告）、アプリのフォルダーの名前と印の状態、使われていない profile のフォルダー、environments.json の有無、
 * 計算式プラグインの zip（ファイル名、読めるか、版）。接続の誤りがあっても status は ok（診断の結果として返す。15.10）。秘密の値と環境変数の名前は返さない。読み取りだけ
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WorkspaceError } from "../binding.ts";
import { ConnectionError, LEGACY_WORKSPACE_FILE, PathError, appFoldersOf, hasLegacyConfig, unusedProfileDirs, type ConnectionSet, type WorkspaceMode } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { failure, ok, sanitizeMessage, unexpected } from "../result.ts";
import { workspaceIdSchema } from "./common.ts";
import { connectionDetail, connectionNext, problemOf, type ConnectionProblem } from "./connection-report.ts";
import { zipReport } from "./zip-report.ts";

/** 一覧の上限（AI に返す量） */
const MAX_FOLDERS = 200;

/** profile ごとのアプリのフォルダーの名前と印の状態（中は一覧しない。15.5）と、使われていない profile のフォルダー */
function folderReport(root: string, set: ConnectionSet): { report: Record<string, unknown>; next: string[] } {
  const next: string[] = [];
  const byProfile: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const def of set.profiles.values()) {
    const folders = appFoldersOf(root, def);
    if (folders.length) byProfile[def.profile] = folders.slice(0, MAX_FOLDERS);
    for (const f of folders) if (f.mark !== "ok") bad.push(`kintone/${def.profile}/${f.name}（${f.mark}）`);
  }
  if (bad.length) {
    next.push(
      `印の無い・壊れた・別の接続のアプリのフォルダーがある（使わない）: ${bad.slice(0, 20).join("、")}${bad.length > 20 ? ` ほか ${bad.length - 20} 件` : ""}。` +
        "利用者が名前を変えて退け、fml_fields か fml_pull で作り直す（中のファイルは後で移す）"
    );
  }
  const invalid = new Set(set.invalid.map((p) => p.name));
  const unused = unusedProfileDirs(root, set).map((name) => ({ name, reason: invalid.has(name) ? "profile-invalid" : "unknown-profile" }));
  if (unused.length) next.push(`接続のファイルに無い（か使えない）profile のフォルダーがある（変えない）: ${unused.map((u) => `kintone/${u.name}`).join("、")}`);
  return { report: { byProfile, ...(unused.length ? { unused } : {}) }, next };
}

export function registerWorkspaceStatus(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_workspace_status",
    {
      title: "計算式プラグインの作業フォルダーの診断",
      description:
        "計算式プラグイン（rex0220 formula）の作業フォルダーの診断: kintone の接続のファイル（読めるか、既定の profile、profile ごとの接続先と認証の種類、トークンが使えるか）、アプリのフォルダーの状態、" +
        "計算式プラグインの zip（ファイル名、読めるか、版）。次にすること（next）を返す。状態は推し量らず、このツールで確かめる。読み取りだけ",
      inputSchema: z.object({ workspaceId: workspaceIdSchema(ctx.surface) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => {
      let root: string;
      try {
        root = ctx.binding.resolve(input.workspaceId);
      } catch (e) {
        if (e instanceof WorkspaceError) return failure("denied", "WorkspaceError", e.message);
        return unexpected(e);
      }
      try {
        const next: string[] = [];
        let mode: WorkspaceMode | undefined;
        let problem: ConnectionProblem | undefined;
        try {
          mode = ctx.mode(root);
        } catch (e) {
          if (!(e instanceof ConnectionError)) throw e;
          problem = problemOf(e);
        }
        const legacy = hasLegacyConfig(root);
        let connection: Record<string, unknown>;
        let folders: Record<string, unknown> | undefined;
        if (mode?.kind === "profiles") {
          const set = mode.connections.set;
          connection = { configured: true, ready: true, ...connectionDetail(set) };
          for (const w of set.warnings) next.push(`接続のファイルの注意: ${w}`);
          try {
            const r = folderReport(root, set);
            folders = r.report;
            next.push(...r.next);
          } catch (e) {
            // kintone/ などの実体が外を指す・同じ番号のフォルダーが 2 つ（外のパスや中身を返さない。Codex の B1 再レビュー BLOCKER 2）
            const msg = e instanceof PathError ? "kintone/ か profile のフォルダーの実体が作業フォルダーの外を指しているか、リンク切れ（symlink など）" : sanitizeMessage((e as Error).message);
            folders = { problem: msg };
            next.push(`アプリのフォルダーを確かめられない: ${msg}（利用者が直す）`);
          }
          if (legacy) next.push(`${LEGACY_WORKSPACE_FILE} は使わない（tools 2.0.0 から。接続のファイルを使う）。利用者が消してよい`);
        } else {
          const p = problem ?? (mode?.kind === "legacy-blocked" ? { code: "legacy-config-present", message: `${LEGACY_WORKSPACE_FILE} が残っていて、接続のファイルが無い` } : { code: "not-configured", message: "kintone の接続のファイルが設定されていない" });
          connection = { configured: ctx.connectionFile !== undefined, ready: false, ...(ctx.connectionFile ? { fileName: path.basename(ctx.connectionFile) } : {}), problem: p };
          next.push(
            p.code === "legacy-config-present"
              ? `${LEGACY_WORKSPACE_FILE} は tools 2.0.0 から使わない。kintone の接続のファイル（kSQL の ksql.config.json と同じ形）に移す（移すまで kintone を使うツールとアプリのフォルダーは止まる。settings/ の作業は動く）。移し方は fml_docs の作業フォルダーの形`
              : connectionNext(p, ctx.surface)
          );
        }
        const zip = await zipReport(ctx, root);
        if (zip.next) next.push(zip.next);
        return ok({
          ready: next.length === 0,
          next: next.length ? next : ["準備ができている"],
          workspace: { name: path.basename(root) },
          mode: mode?.kind ?? "error",
          connection,
          ...(folders ? { appFolders: folders } : {}),
          // environments.json は tools 1.x の形。残っているときだけ「使わない」と添えて返す（無いときに exists: false を返すと、AI が「作る必要がある」と読み違えた。
          // 2026-10-10 の手での確認 1。5.2「AI が読み違えない形にする」）
          ...(legacy ? { legacyEnvironmentsJson: { exists: true, note: `${LEGACY_WORKSPACE_FILE} は tools 1.x の環境の定義で、tools 2.0.0 から使わない（kintone の接続のファイルを使う）。作らない。残っていれば利用者が消してよい` } } : {}),
          pluginZip: zip.report
        });
      } catch (e) {
        return unexpected(e);
      }
    }
  );
}
