/**
 * 作業フォルダーのファイルの扱い（CLI の folderDefaults / jobOf / trustedBaseUrl / writeText と同じ決まりを、中核の関数で組む）。
 *   - 読むファイルは作業フォルダーの中だけ（resolveRead。.env・node_modules・.git は読まない）
 *   - 設定ファイルは計算式プラグインの封筒（pluginID）のものだけを読む（レコードのファイルなどを設定として読ませない）
 *   - アプリのフォルダー（kintone/<profile>/<番号>-…/）の中の設定は、同じフォルダーの fields.json と、その profile の接続先を使う（print-craft MCP の実装案 15 章）
 *   - kintone/** の中のファイルは、profile の形で、接続のファイルにある profile、印が今の接続のこのアプリのものときだけ読む（15.5）
 *   - 書く直前に、書ける場所と、kintone/ の下なら操作 × 場所・印・接続の許可（接続のファイルを読み直す）を確かめ直す
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { WorkspaceError as BindingError } from "../binding.ts";
import {
  AuthError,
  ConnectionError,
  DEFAULT_USERS,
  EvalError,
  EvalTimeoutError,
  FORMULA_CONFIG_PLUGIN_ID,
  FileExistsError,
  InputError,
  KINTONE_ROOT,
  KintoneUrlError,
  LockBusyError,
  MAX_INPUT_BYTES,
  NotAllowedError,
  PathError,
  PermissionError,
  PluginZipError,
  PolicyError,
  QueryError,
  RestError,
  UsersDataError,
  UsersPullError,
  WorkspaceError as CoreWorkspaceError,
  appFolderOfFile,
  assertAppMark,
  assertChangeAllowed,
  assertUsableInKintone,
  builtinErrorName,
  cleanupAll,
  connectionStatusOf,
  digestOf,
  findAppDir,
  isInside,
  jsonErrorWhere,
  pickProfile,
  profileDirOf,
  readJsonLimited,
  resolveRead,
  resolveWrite,
  validateUsersSource,
  type ChangeOp,
  type PluginZipErrorCode,
  type ProfileDef,
  type UsersOrigin,
  type UsersSource,
  type WorkspaceMode
} from "../core.ts";
import { failure, sanitizeMessage, type ToolResult } from "../result.ts";
import { describeZipError } from "../zip-error.ts";

/** 想定外の誤りの種類を標準エラーに残す（文は残さない: Worker の中の例外の文はレコードの値や zip のパスを含みうる。Codex のレビュー BLOCKER 3）。起動のときに main が渡す */
let errorLogger: (line: string) => void = () => undefined;
export function setErrorLogger(fn: (line: string) => void): void {
  errorLogger = fn;
}

export const rel = (root: string, abs: string): string => path.relative(root, abs).replace(/\\/g, "/");

/**
 * ツールの引数のパスは作業フォルダーからの相対パスだけ（print-craft MCP の実装案 5.1「..・絶対パス・ドライブ名・cwd を受け付けない」）。
 * 中核の resolveRead / resolveWrite は作業フォルダーの中を指す絶対パスや settings/../x.json も受け付けるので、入口で断る。\\ も断る（区切りは / にそろえる）
 */
export function checkRelPath(p: string, what = "パス"): void {
  if (p.includes("\0")) throw new PathError(`${what}に使えない文字がある`);
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("~")) throw new PathError(`${what}は作業フォルダーからの相対パスで書く（絶対パス・ドライブ名・~ は使わない）: ${p}`);
  if (p.includes("\\")) throw new PathError(`${what}の区切りは / にする（\\ は使わない）: ${p}`);
  if (p.split("/").some((seg) => seg === "..")) throw new PathError(`${what}に .. は使わない: ${p}`);
  if (p.split("/").some((seg) => seg === "" || seg === ".")) throw new InputError(`${what}はファイルの相対パスで書く（例 settings/a.json。先頭の ./、末尾の /、// は使わない）: ${p}`);
}

/** ツールの引数のパスをまとめて確かめる（undefined は飛ばす） */
export function checkRelPaths(paths: Record<string, string | undefined>): void {
  for (const [what, p] of Object.entries(paths)) if (p !== undefined) checkRelPath(p, what);
}

/** フォルダーの実体が作業フォルダーの中か（symlink で外を指していれば PathError）。一覧を作る前に確かめる */
export function insideDir(root: string, dir: string): string {
  return resolveRead(rel(root, dir), root);
}

/** 動く形を、要るときだけ作る（kintone/** の中のファイルを読むときだけ接続のファイルを読む） */
export type ModeSource = WorkspaceMode | (() => WorkspaceMode);
const modeOfSource = (m: ModeSource): WorkspaceMode => (typeof m === "function" ? m() : m);

const inKintone = (root: string, file: string): boolean => isInside(path.resolve(root, file), path.join(root, KINTONE_ROOT));

/** kintone/** の中のファイルなら、読む前に確かめる（profile の形、接続のファイルにある profile、印。中核の assertUsableInKintone。15.5） */
export function assertReadable(root: string, file: string, mode: ModeSource): void {
  if (inKintone(root, file)) assertUsableInKintone(root, file, modeOfSource(mode));
}

/**
 * profile のアプリのフォルダー（kintone/<profile>/<番号>-…）。無ければ null。kintone/ と profile のフォルダーの実体は中核の findAppDir が確かめ、
 * 印が今の接続のこのアプリのものでなければ ConnectionError（conflict）
 */
export function appDirIn(root: string, def: ProfileDef, appId: number): string | null {
  const dir = findAppDir(root, def.profile, appId);
  if (!dir) return null;
  assertAppMark(dir, def, appId);
  return insideDir(root, dir);
}

export interface SettingsFile {
  /** 実際のパス */
  file: string;
  /** 作業フォルダーからの相対（区切りは /） */
  relPath: string;
  bytes: Buffer;
  text: string;
  settings: Record<string, unknown>;
  /** ファイルのバイト列の sha256（fml_update_fields の expectedDigest に渡す） */
  digest: string;
}

/** JSON のファイルを中核で読む関数を呼び、JSON として読めないときの文を決まった文に（what は「レコードのファイル」など） */
export async function withJsonError<T>(root: string, file: string, what: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof InputError && /を JSON として読めない/.test(e.message)) throw new InputError(`${what}を JSON として読めない: ${rel(root, file)}${jsonErrorWhere(e)}（中身は返さない）`);
    throw e;
  }
}

/** 設定ファイルを 1 回だけ読み、同じ中身から JSON と digest を作る（読み直すと、その間に変わったときにずれる）。kintone/** の中なら先に確かめる */
export function readSettingsFile(root: string, p: string, mode: ModeSource): SettingsFile {
  const file = resolveRead(p, root);
  if (!existsSync(file)) throw new InputError(`ファイルが無い: ${rel(root, file)}`);
  assertReadable(root, file, mode);
  const bytes = readFileSync(file);
  if (bytes.length > MAX_INPUT_BYTES) throw new InputError(`${rel(root, file)} が大きすぎる（${bytes.length.toLocaleString()} バイト。上限 ${MAX_INPUT_BYTES.toLocaleString()}）`);
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    throw new InputError(`${rel(root, file)} を JSON として読めない${jsonErrorWhere(e)}（中身は返さない）`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new InputError(`${rel(root, file)} の最上位はオブジェクト`);
  if ((settings as Record<string, unknown>).pluginID !== FORMULA_CONFIG_PLUGIN_ID) throw new InputError(`${rel(root, file)} は計算式プラグインの設定のファイルではない（封筒の pluginID が "${FORMULA_CONFIG_PLUGIN_ID}" でない）`);
  return { file, relPath: rel(root, file), bytes, text, settings: settings as Record<string, unknown>, digest: digestOf(bytes) };
}

/** アプリのフォルダーの中の設定か（場所で決める。保存の中核と同じ）。返り値は { dir, profile, appId } */
export function folderOf(root: string, file: string) {
  return appFolderOfFile(root, file);
}

/**
 * 項目定義のファイル。アプリのフォルダーの中の設定は、いつも同じフォルダーの fields.json（fields はそれと同じときだけ。別のアプリ・profile・fields/ の項目定義で検査しない。
 * 保存の中核と同じく denied）。ほかは引数の fields、無ければ封筒の appId の fields/<appId>.json（CLI の既定と同じ）。kintone/** の中なら先に確かめる
 */
export function fieldsFileFor(root: string, file: string, fields: string | undefined, mode: ModeSource, envelope?: Record<string, unknown>): string {
  const folder = folderOf(root, file);
  if (folder) {
    const own = path.join(folder.dir, "fields.json");
    if (!existsSync(own)) throw new InputError(`アプリのフォルダーに fields.json が無い: ${rel(root, own)}（fml_fields で取る）`);
    const f = resolveRead(own, root);
    if (fields !== undefined && resolveRead(fields, root) !== f) throw new PermissionError(`アプリのフォルダーの中の設定は、同じフォルダーの fields.json で検査する（fields は渡さないか、${rel(root, f)} にする）`);
    assertReadable(root, f, mode);
    return f;
  }
  const appId = typeof envelope?.appId === "number" && Number.isInteger(envelope.appId) && envelope.appId > 0 ? envelope.appId : undefined;
  const relFile = fields ?? (appId !== undefined ? path.posix.join("fields", `${appId}.json`) : undefined);
  if (!relFile) throw new InputError("fields（項目定義のファイル）が要る（設定の封筒に appId があれば fields/<appId>.json を既定にする。アプリのフォルダー kintone/<profile>/<番号>-…/ の中の設定なら同じフォルダーの fields.json を使う）");
  const f = resolveRead(relFile, root);
  if (!existsSync(f)) throw new InputError(`項目定義のファイルが無い: ${rel(root, f)}（fml_fields で取る）`);
  assertReadable(root, f, mode);
  return f;
}

/** 評価の文脈の接続先（APP_URL などの元。15.8） */
export interface TrustedBaseUrl {
  baseUrl?: string;
  reason?: string;
}

/**
 * 評価の文脈の接続先（フォルダー名は AI が作れるので、フォルダー名そのものは信用しない。接続のファイルの profile の baseUrl）。
 * アプリのフォルダーのファイルはその profile（引数の profile と違えば InputError）、ほかは引数の profile、無ければ defaultProfile（無ければ dev）。決まらなければ既定の接続先
 */
export function trustedBaseUrl(mode: WorkspaceMode, root: string, file: string, profile: string | undefined): TrustedBaseUrl {
  const folder = folderOf(root, file);
  if (folder && profile !== undefined && profile !== folder.profile) throw new InputError(`profile「${profile}」とファイルのフォルダーの profile（${folder.profile}）が違う`);
  if (mode.kind !== "profiles") return { reason: mode.kind === "legacy-blocked" ? "environments.json が残っている（接続のファイルに移す）" : "kintone の接続のファイルが設定されていない（APP_URL などは既定の接続先 https://example.cybozu.com で評価する）" };
  const set = mode.connections.set;
  if (folder) {
    const def = set.profiles.get(folder.profile);
    return def ? { baseUrl: def.baseUrl } : { reason: `profile「${folder.profile}」は接続のファイルに無い` };
  }
  try {
    return { baseUrl: pickProfile(set, profile).baseUrl };
  } catch (e) {
    if (e instanceof ConnectionError && profile === undefined) return { reason: "既定の profile が決まらない（profile を付けると接続先を使える）" };
    throw e;
  }
}

/** 応答に足す評価の文脈の接続先（接続のファイルの baseUrl は長さの上限が無いので、表示は 300 文字まで。Codex の r4 レビュー M1） */
export function baseUrlFields(t: TrustedBaseUrl): Record<string, unknown> {
  const url = t.baseUrl === undefined ? null : t.baseUrl.length > 300 ? `${t.baseUrl.slice(0, 300)}…` : t.baseUrl;
  return { contextBaseUrl: url, ...(t.reason ? { contextBaseUrlReason: t.reason } : {}) };
}

/** calc のレコードのファイル: アプリのフォルダーの設定なら同じフォルダーの records/<番号>.json、それ以外は records/<app>-<番号>.json（CLI と同じ） */
export function recordFileFor(root: string, settingsFile: string, appId: number, id: number, mode: ModeSource): string {
  const folder = folderOf(root, settingsFile);
  const f = folder ? resolveRead(path.join(folder.dir, "records", `${id}.json`), root) : resolveRead(path.posix.join("records", `${appId}-${id}.json`), root);
  if (!existsSync(f)) throw new InputError(`レコードのファイルが無い: ${rel(root, f)}（fml_record で取る）`);
  assertReadable(root, f, mode);
  return f;
}

/** ユーザー情報のテストデータ（users/ の中のファイルだけ。無ければ既定の架空の 10 人）。実体が users/ の外（settings/ や records/、symlink の先）なら denied（Codex のレビュー MAJOR 6） */
export function usersSourceFor(root: string, users: string | undefined, mode: ModeSource): { src: UsersSource; origin: UsersOrigin } {
  if (!users) return { src: DEFAULT_USERS, origin: { kind: "default" } };
  const abs = resolveRead(users, root);
  if (!isInside(abs, path.join(root, "users"))) throw new PermissionError(`ユーザー情報のファイルは users/ の中のものだけ（fml_users が書いたもの）: ${users}`);
  if (!existsSync(abs)) throw new InputError(`ユーザー情報のファイルが無い: ${rel(root, abs)}（fml_users で取る）`);
  assertReadable(root, abs, mode);
  return { src: validateUsersSource(readJsonLimited(abs), rel(root, abs)), origin: { kind: "file", file: rel(root, abs) } };
}

/** 書ける場所と許可を確かめる（書かない）。書く先の実際のパスを返す */
export function checkWritable(root: string, target: string, roots: readonly string[], op: ChangeOp, mode: WorkspaceMode): string {
  const real = resolveWrite(rel(root, target), roots, root);
  assertChangeAllowed(root, real, op, mode);
  return real;
}

/**
 * kintone に送る前に、保存先（アプリのフォルダー。無ければ作る場所）に書けるかを確かめる（送ってから断らない）。
 * 今あるフォルダーは印も確かめる。返り値は今あるフォルダー（無ければ null。作るのは取った後で、名前はアプリ名で決まる）
 */
export function precheckAppWrite(root: string, def: ProfileDef, appId: number, name: string, op: ChangeOp, mode: WorkspaceMode): string | null {
  const existing = appDirIn(root, def, appId);
  checkWritable(root, path.join(existing ?? path.join(profileDirOf(root, def.profile), String(appId)), name), [KINTONE_ROOT], op, mode);
  return existing;
}

/** 書く直前に、書ける場所と許可を確かめ直してから書く（CLI の writeText と同じ。書く先のパスが途中で変われば書かない）。fileMode はレコード・ユーザー情報の 0o600 */
export function writeChecked(root: string, target: string, text: string, roots: readonly string[], op: ChangeOp, mode: WorkspaceMode, fileMode?: number): string {
  const real = checkWritable(root, target, roots, op, mode);
  mkdirSync(path.dirname(real), { recursive: true });
  if (resolveWrite(rel(root, real), roots, root) !== real) throw new PermissionError(`書く先のフォルダーが途中で変わった（symlink など）: ${rel(root, real)}`);
  assertChangeAllowed(root, real, op, mode);
  if (fileMode === undefined) {
    writeFileSync(real, text, "utf8");
    return real;
  }
  // レコード・ユーザー情報（機微）: 本人だけが読める一時ファイル（wx、mode を fchmod で確かめてから中身を書く）を同じフォルダーに作り、名前の付け替えで置き換える。
  // 既にあるファイルに書き足してから chmod すると、その間は前の権限（0644 など）で読めるので、そうしない（Codex の r2 レビュー R2）
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = openSync(tmp, "wx", fileMode);
  let placed = false;
  try {
    fchmodSync(fd, fileMode);
    writeFileSync(fd, text, "utf8"); // fd に全部書き切る（writeSync の返りの長さに頼らない）
    closeSync(fd);
    fd = -1;
    renameSync(tmp, real);
    placed = true;
  } finally {
    // close と一時ファイルの削除は別々に（一方の失敗で他方を飛ばさない。Codex の r3 レビュー N3）
    if (fd !== -1) cleanupAll([() => closeSync(fd)]);
    if (!placed) cleanupAll([() => rmSync(tmp, { force: true })]);
  }
  return real;
}

/** 中核の誤りを応答に分ける（5.2）。分からない誤りは failed */
export function fromError(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof BindingError) return failure("denied", "WorkspaceError", message);
  // kintone の接続のファイル・アプリのフォルダーの印の誤り（15.10 の表）
  if (e instanceof ConnectionError) return failure(connectionStatusOf(e), e.code, message);
  // 作業フォルダーの形の食い違い（同じ番号のアプリのフォルダーが 2 つ。利用者が 1 つにする）。呼び出しの引数の誤りではない
  if (e instanceof CoreWorkspaceError) return failure("conflict", "WorkspaceError", message);
  if (e instanceof PathError) return failure("denied", "PathError", message);
  if (e instanceof PermissionError) return failure("denied", "PermissionError", message);
  if (e instanceof FileExistsError || e instanceof LockBusyError) return failure("conflict", "ConflictError", message);
  if (e instanceof QueryError) return failure("invalid", "QueryError", message);
  if (e instanceof KintoneUrlError) return failure("invalid", "KintoneUrlError", message);
  if (e instanceof UsersDataError) return failure("invalid", "UsersDataError", message);
  if (e instanceof InputError || e instanceof SyntaxError) return failure("invalid", "InputError", message);
  // 主スレッドの計算式プラグインの zip の誤り（fml_summary / fml_pull / fml_fields の engine）: 種類ごとの決まった文（パスを含まない）
  if (e instanceof PluginZipError) {
    const r = describeZipError(e, "claude-code");
    return failure(r.incompatible ? "incompatible" : "failed", r.incompatible ? "IncompatibleError" : "PluginZipError", r.text);
  }
  // 評価の Worker の誤り（時間切れの文は決まった文。それ以外の Worker の中の例外の文は、zip のコードがレコードの値を入れうるので返さない。Codex のレビュー BLOCKER 3）
  if (e instanceof EvalTimeoutError) return failure("failed", "EvalTimeoutError", message);
  if (e instanceof EvalError) return failure(e.kind === "input" ? "invalid" : "failed", { input: "InputError", zip: "PluginZipError", users: "UsersDataError", policy: "PolicyError", other: e.innerName }[e.kind], evalErrorText(e));
  // 参照するコードが User API に無い: コードは返さない（式の文字列は fml_summary で見る）
  if (e instanceof UsersPullError) return failure("failed", "UsersPullError", message.replace(/^(式が参照している(?:ユーザー|組織|グループ)が無い): .*$/s, "$1（コードは返さない。fml_summary の field で式の文字列を確かめる。全部取るなら onlyReferenced を外す）"));
  if (e instanceof PolicyError) return failure("failed", "PolicyError", message);
  if (e instanceof AuthError) return failure("failed", "AuthError", message);
  if (e instanceof NotAllowedError) return failure("denied", "NotAllowedError", message);
  if (e instanceof RestError) return failure("failed", "RestError", message);
  // 想定外の誤り: 種類だけを返し、文は返さない（文は値やパスを含みうる）。種類は instanceof で決めた組み込みの名前（主スレッドでも zip のコードが動く（pull / summary）ので name / constructor.name は使わない）。種類は標準エラーに残す
  const code = builtinErrorName(e);
  errorLogger(`想定外の誤り（${code}。文はレコードの値やパスを含みうるので出さない）`);
  return failure("failed", code, `想定外の誤り（${code}）。誤りの文は値やパスを含みうるので返さない。fml_status / fml_workspace_status で状態を確かめ、直らなければ利用者に伝える`);
}

/**
 * Worker の中の誤りの文（決まった文だけ）: 入力の誤り（中核の InputError。相対パスと決まった文）はそのまま、計算式プラグインの zip の誤りは種類ごとの決まった文、
 * それ以外（zip のコードの例外、想定外）は種類だけ（文は返さない）
 */
function evalErrorText(e: EvalError): string {
  // 種類（kind）は中核が instanceof で決めたもの（zip のコードが name を偽装しても other のまま）
  if (e.kind === "input" || e.kind === "users" || e.kind === "policy") return sanitizeMessage(e.message);
  if (e.kind === "zip" && e.code) return describeZipError(new PluginZipError(e.message, e.code as PluginZipErrorCode, {}), "claude-code").text;
  errorLogger(`評価の Worker の中の誤り（${e.innerName}${e.code ? ` ${e.code}` : ""}。文は出さない）`);
  return `評価の途中で想定外の誤り（${e.innerName}）。誤りの文は値やパスを含みうるので返さない。fml_normalize で設定を確かめ、fml_status で計算式プラグインの zip を確かめる`;
}

const shortHash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 8);

/**
 * AI に返す前に、設定の中の個人を指す値を伏せる（権限のユーザー・組織・グループのコード）。
 * 件数と短い digest にする（変わったかは分かるように。fml_diff）。設定ファイルそのものは変えない
 */
export function redactPersonal(settings: Record<string, unknown>): Record<string, unknown> {
  const auth = settings.authority;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return settings;
  const a: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
  for (const [k, label] of [["users", "ユーザー"], ["organizations", "組織"], ["groups", "グループ"]] as const) {
    const v = a[k];
    if (v && typeof v === "object") {
      const n = Array.isArray(v) ? v.length : Object.keys(v as Record<string, unknown>).length;
      if (n > 0) a[k] = `（${label} ${n} 件。値は出さない #${shortHash(v)}）`;
    }
  }
  return { ...settings, authority: a };
}
