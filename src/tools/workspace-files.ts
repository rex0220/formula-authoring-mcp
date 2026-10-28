/**
 * 作業フォルダーのファイルを扱うツール（計画 24.2。CLI の files / take / edit / diff）。
 *   - fml_files: app を付ければ profile のそのアプリのフォルダーの一覧（ダウンロード / pull は新しい順、-edit.json、新しい設定、records）。
 *     無ければ profile ごとのアプリのフォルダーの名前と印の状態、使われていない profile のフォルダーの名前、settings/ temp/ fields/ records/ users/ の JSON の名前、inbox/ の件数
 *     （Desktop の AI はファイルの一覧を見る手段が無い）。名前だけ（中身は返さない。印の合わないフォルダーの中は一覧しない。15.5）
 *   - fml_take: inbox/ のダウンロードを、名前のまま profile のアプリのフォルダーへ移す（上書きしない）
 *   - fml_edit: アプリのフォルダーのダウンロード / pull を -edit.json に写す（ダウンロードは書き換えない。既にあればそのまま。plugin: field-validation で項目検証のもの。MCP 0.4.0）
 *   - fml_diff: 2 つの設定の差（項目単位。★ = 既存レコードの値に影響する項目。権限のコードは件数）
 * アプリのフォルダー（kintone/**）を使うのは、kintone の接続のファイルがあるときだけ（profile の形。15.4）
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  FileExistsError,
  INBOX,
  InputError,
  WRITE_ROOTS,
  appFolderOfFile,
  appFoldersOf,
  assertChangeAllowed,
  diffSettings,
  editNameOf,
  listAppFolder,
  pickProfile,
  requireProfiles,
  resolveRead,
  resolveWrite,
  snapshotKindOf,
  takeInbox,
  unusedProfileDirs,
  writeNewFile,
  type WorkspaceMode
} from "../core.ts";
import type { ServerContext } from "../context.ts";
import { ok, sanitizeMessage, type Finding } from "../result.ts";
import { incompatibleResult, lazyMode, workspaceIdSchema } from "./common.ts";
import { appDirIn, checkRelPaths, fromError, insideDir, readSettingsFile, redactPersonal, rel } from "./files.ts";
import { appSchema, profileSchema } from "./kintone.ts";

/** 一覧の上限（AI に返す量） */
const MAX_LIST = 200;
/** 差の上限（AI に返す量） */
const MAX_DIFF_CHARS = 64 * 1024;

function namesUnder(root: string, dir: string, depth = 2): string[] {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string, left: number): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 1) walk(p, left - 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) out.push(rel(root, p));
      if (out.length > MAX_LIST) return;
    }
  };
  walk(resolveRead(dir, root), depth);
  return out;
}

/** 作業フォルダーの直下の、アプリのフォルダーの外のファイル（settings/ など。どの形でも使える） */
function localFiles(root: string): { files: Record<string, string[]>; truncated: boolean } {
  const files: Record<string, string[]> = {};
  for (const d of ["settings", "temp", "fields", "records", "users", "requirements"]) files[d] = namesUnder(root, d);
  const truncated = Object.values(files).some((l) => l.length > MAX_LIST);
  for (const d of Object.keys(files)) files[d] = files[d].slice(0, MAX_LIST);
  return { files, truncated };
}

/** profile ごとのアプリのフォルダーの名前と印の状態（中は一覧しない）と、使われていない profile のフォルダー（使えない profile か、接続のファイルに無い profile） */
function profileFolders(root: string, mode: Extract<WorkspaceMode, { kind: "profiles" }>, only: string | undefined) {
  const set = mode.connections.set;
  const defs = only !== undefined ? [pickProfile(set, only)] : [...set.profiles.values()];
  const profiles = defs.map((def) => ({
    name: def.profile,
    host: def.host,
    ...(def.guestSpaceId ? { guestSpaceId: def.guestSpaceId } : {}),
    folders: appFoldersOf(root, def).slice(0, MAX_LIST)
  }));
  const invalid = new Set(set.invalid.map((p) => p.name));
  const unused = only !== undefined ? [] : unusedProfileDirs(root, set).map((name) => ({ name, reason: invalid.has(name) ? "profile-invalid" : "unknown-profile" }));
  return { profiles, unused };
}

function inboxCount(root: string): number {
  const dir = path.join(root, INBOX);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(resolveRead(INBOX, root), { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function registerWorkspaceFiles(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_files",
    {
      title: "計算式プラグインの作業フォルダーのファイルの一覧",
      description:
        "計算式プラグイン（rex0220 formula）と項目検証プラグイン（rex0220 field validation）の作業フォルダーのファイルの名前の一覧（中身は返さない）。app を付けると、kintone の接続のファイルの profile のそのアプリのフォルダー（ダウンロード / pull は新しい順で先頭が今の設定（計算式は snapshots、項目検証は fvSnapshots）、-edit.json、AI が作った設定、records）。" +
        "省くと、profile ごとのアプリのフォルダーの名前と状態、settings/ temp/ fields/ records/ users/ requirements/ の JSON、inbox/ の件数。読み取りだけ",
      inputSchema: z.object({ workspaceId: workspaceIdSchema(ctx.surface), app: appSchema.optional(), profile: profileSchema }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => {
      try {
        const root = ctx.binding.resolve(input.workspaceId);
        const incompatible = incompatibleResult();
        if (incompatible) return incompatible;
        const mode = ctx.mode(root);
        // profile を指定したら接続のファイルが要る（無いときに settings/ の一覧を返して読み違えさせない）
        if (input.profile !== undefined) requireProfiles(mode, "fml_files の profile");
        if (input.app !== undefined) {
          const set = requireProfiles(mode, "fml_files の app").set;
          const def = pickProfile(set, input.profile);
          const dir = appDirIn(root, def, input.app);
          if (!dir) throw new InputError(`アプリ ${input.app} のフォルダー（kintone/${def.profile}/${input.app}-…）が無い。先に fml_fields（か fml_pull）でアプリのフォルダーを作る`);
          const l = listAppFolder(dir, root);
          return ok({
            workspace: { name: path.basename(root) },
            profile: { name: def.profile, host: def.host, ...(def.guestSpaceId ? { guestSpaceId: def.guestSpaceId } : {}) },
            folder: rel(root, dir),
            fields: l.hasFields,
            snapshots: l.snapshots,
            current: l.snapshots[0] ?? null,
            edits: l.edits,
            others: l.others,
            fvSnapshots: l.fvSnapshots,
            fvCurrent: l.fvSnapshots[0] ?? null,
            fvEdits: l.fvEdits,
            records: l.records,
            note: "snapshots（計算式）と fvSnapshots（項目検証）のダウンロード / pull は書き換えない（fml_edit で -edit.json に写す。項目検証は plugin: field-validation）。others は AI が作った設定"
          });
        }
        const local = localFiles(root);
        const findings: Finding[] = local.truncated ? [{ level: "info", rule: "truncated", message: `一覧を ${MAX_LIST} 件で打ち切った` }] : [];
        let kintone: Record<string, unknown>;
        if (mode.kind === "profiles") {
          try {
            kintone = profileFolders(root, mode, input.profile);
          } catch (e) {
            kintone = { problem: sanitizeMessage(e instanceof Error ? e.message : String(e)) };
          }
        } else kintone = { mode: mode.kind, note: mode.kind === "not-configured" ? "kintone の接続のファイルが設定されていない（アプリのフォルダーは使えない）" : "environments.json が残っている（接続のファイルに移す）" };
        return ok({ workspace: { name: path.basename(root) }, mode: mode.kind, kintone, local: local.files, inbox: inboxCount(root) }, findings.length ? { findings } : {});
      } catch (e) {
        return fromError(e);
      }
    }
  );

  server.registerTool(
    "fml_take",
    {
      title: "inbox のダウンロードをアプリのフォルダーへ",
      description:
        "利用者が作業フォルダーの inbox/ に置いた計算式プラグイン（rex0220 formula）・項目検証プラグイン（rex0220 field validation）の設定のダウンロード（rex0220-formula-app<番号>-<日時>.json、rex0220-field-validation-app<番号>-<日時>.json）を、封筒の appId で kintone の接続のファイルの profile のアプリのフォルダーへ名前のまま移す（上書きしない。フォルダーが無ければ作る）。" +
        "移せなかったファイルは理由を返す。結果を推し量らず、このツールで確かめる",
      inputSchema: z.object({ workspaceId: workspaceIdSchema(ctx.surface), profile: profileSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) => {
      try {
        const root = ctx.binding.resolve(input.workspaceId);
        const incompatible = incompatibleResult();
        if (incompatible) return incompatible;
        const mode = ctx.mode(root);
        requireProfiles(mode, "fml_take");
        const r = takeInbox(root, mode, input.profile);
        const findings: Finding[] = [
          ...r.skipped.map((s) => ({ level: "warning", rule: "take.skipped", message: `${s.file}: ${s.reason}` })),
          ...r.warnings.map((m) => ({ level: "warning", rule: "take.warning", message: m }))
        ];
        const moved = r.moved.map((m) => ({ file: m.file, to: m.to, ...(m.same ? { same: true } : {}), ...(m.leftInInbox ? { leftInInbox: true } : {}) }));
        return ok({ moved, skipped: r.skipped.length, ...(moved.length === 0 && r.skipped.length === 0 ? { note: `${INBOX}/ に設定のファイルが無い` } : {}) }, { findings });
      } catch (e) {
        return fromError(e);
      }
    }
  );

  server.registerTool(
    "fml_edit",
    {
      title: "ダウンロードを -edit.json に写す",
      description:
        "計算式プラグイン（rex0220 formula）か項目検証プラグイン（rex0220 field validation）のアプリのフォルダーのダウンロード / pull のファイルを、直すための -edit.json に写す（ダウンロードのファイルは書き換えない。-edit.json が既にあればそのまま）。" +
        "path を省くと app の一番新しいダウンロード / pull（今の設定。plugin で計算式か項目検証かを選ぶ。既定は計算式）。kintone の接続のファイルがあるときだけ。結果を推し量らず、このツールで確かめる",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          path: z.string().min(1).max(512).optional().describe("ダウンロード / pull のファイル（作業フォルダーからの相対パス）"),
          app: appSchema.optional(),
          plugin: z.enum(["formula", "field-validation"]).optional().describe("どのプラグインの設定か（formula = 計算式（既定）、field-validation = 項目検証）。path を渡したときはファイルの名前で決まる"),
          profile: profileSchema
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) => {
      try {
        checkRelPaths({ path: input.path });
        const root = ctx.binding.resolve(input.workspaceId);
        const incompatible = incompatibleResult();
        if (incompatible) return incompatible;
        const mode = ctx.mode(root);
        const set = requireProfiles(mode, "fml_edit").set;
        let src = input.path;
        if (!src) {
          if (input.app === undefined) throw new InputError("path か app が要る");
          const def = pickProfile(set, input.profile);
          const dir = appDirIn(root, def, input.app);
          if (!dir) throw new InputError(`アプリ ${input.app} のフォルダー（kintone/${def.profile}/${input.app}-…）が無い。先に fml_fields（か fml_pull）`);
          const l = listAppFolder(dir, root);
          const fv = input.plugin === "field-validation";
          const snapshots = fv ? l.fvSnapshots : l.snapshots;
          if (!snapshots.length) throw new InputError(`${rel(root, dir)} に${fv ? "項目検証の" : ""}ダウンロード / pull のファイルが無い（設定画面でダウンロードして inbox/ に置き fml_take、または ${fv ? "fv_pull" : "fml_pull"}）`);
          src = rel(root, path.join(dir, snapshots[0]));
        }
        const folder = appFolderOfFile(root, path.resolve(root, src));
        const kind = snapshotKindOf(path.basename(src));
        if (!kind || !folder) throw new InputError(`写すのはアプリのフォルダーのダウンロード / pull のファイル（rex0220-formula-app<番号>-<日時>.json、項目検証は rex0220-field-validation-app<番号>-<日時>.json）: ${src}`);
        if (input.plugin !== undefined && input.plugin !== kind) throw new InputError(`plugin「${input.plugin}」とファイルの種類（${kind}）が違う`);
        if (input.profile !== undefined && input.profile !== folder.profile) throw new InputError(`profile「${input.profile}」とファイルのフォルダーの profile（${folder.profile}）が違う`);
        const f = readSettingsFile(root, src, mode, kind);
        const dest = resolveWrite(rel(root, editNameOf(f.file)), WRITE_ROOTS.kintone, root);
        const next = kind === "field-validation" ? "直す: fv_summary（digest）→ fv_update_rows → fv_check。差は fv_diff" : "直す: fml_summary（digest）→ fml_update_fields → fml_calc。差は fml_diff";
        if (existsSync(dest)) return ok({ path: rel(root, dest), from: f.relPath, existed: true, next: `既にある -edit.json を続けて直す（${next}）` });
        assertChangeAllowed(root, dest, "settings", mode);
        try {
          writeNewFile(dest, f.text, () => {
            if (resolveWrite(rel(root, dest), WRITE_ROOTS.kintone, root) !== dest) throw new InputError("書く先のフォルダーが途中で変わった");
            assertChangeAllowed(root, dest, "settings", mode);
          });
        } catch (e) {
          if (e instanceof FileExistsError) return ok({ path: rel(root, dest), from: f.relPath, existed: true, next: `既にある -edit.json を続けて直す（${next}）` });
          throw e;
        }
        return ok({ path: rel(root, dest), from: f.relPath, existed: false, next });
      } catch (e) {
        return fromError(e);
      }
    }
  );

  server.registerTool(
    "fml_diff",
    {
      title: "2 つの計算式プラグインの設定の差",
      description:
        "計算式プラグイン（rex0220 formula）の 2 つの設定 JSON の差（項目単位。★ = 計算式か有効が変わった = 既存レコードの値に影響する項目。共通の設定の差も）。" +
        "直した設定を取り込む前に利用者に見せる。読み取りだけ",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          before: z.string().min(1).max(512).describe("前の設定（作業フォルダーからの相対パス。ダウンロードなど）"),
          after: z.string().min(1).max(512).describe("後の設定（作業フォルダーからの相対パス。-edit.json など）")
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => {
      try {
        checkRelPaths({ before: input.before, after: input.after });
        const root = ctx.binding.resolve(input.workspaceId);
        const incompatible = incompatibleResult();
        if (incompatible) return incompatible;
        // 接続のファイルは kintone/** の中のファイルのときだけ読む（15.9 の表）
        const mode = lazyMode(ctx, root);
        const a = readSettingsFile(root, input.before, mode);
        const b = readSettingsFile(root, input.after, mode);
        // 権限のユーザー・組織・グループの値は伏せる（件数と digest。変わったかは分かる）
        const d = diffSettings(redactPersonal(a.settings), redactPersonal(b.settings), { before: a.relPath, after: b.relPath });
        let text = d.lines.join("\n");
        const truncated = text.length > MAX_DIFF_CHARS;
        if (truncated) text = `${text.slice(0, MAX_DIFF_CHARS)}\n…（打ち切った）`;
        return ok(
          { before: a.relPath, after: b.relPath, fields: d.fields, common: d.common.slice(0, MAX_LIST), text, affectsRecords: d.fields.some((f) => f.affectsRecords) },
          truncated ? { findings: [{ level: "info", rule: "truncated", message: "差を打ち切った" }] } : {}
        );
      } catch (e) {
        return fromError(e);
      }
    }
  );
}
