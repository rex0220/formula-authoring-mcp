/**
 * 作業フォルダーの結び付け（実装案 4.1。試作 0-3b の binding.ts を元にした）。
 *   - Desktop（--surface desktop）: 設定項目の作業フォルダー（--workspace-dir）を起動時に確かめて実際のパスに固定する。起動時の cwd は使わない。
 *     無ければ、すぐ上のフォルダーがあるときだけ最後の 1 段を作る（2026-10-09 Takashi）。起動時にだめなら、呼び出しのたびに同じ値で確かめ直す。
 *     ツールの workspaceId は省略できる。渡されて固定のフォルダーと違えば拒否
 *   - Claude Code（--surface claude-code）: 登録済みの作業フォルダー（--roots。設定項目の JSON の配列の文字列）を起動時に実際のパスに直す。
 *     絶対パスでない・存在しない・フォルダーでないものは捨てる。ツールの workspaceId（プラグインのフックが入れる）が登録済みのどれかと同じでなければ拒否
 * 設定項目の値は、前後の空白と両端の引用符を外し（Windows の「パスのコピー」。試作 0-4）、先頭の ~ をホームのフォルダーにしてから使う
 * （設定の欄はシェルを通らないので ~ が展開されない。試作 0-3b の Desktop で ~/… を入れて「絶対パスでない」になった）。値は AI の引数では変えられない。
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unquote } from "./core.ts";

export type Surface = "claude-code" | "desktop";

export interface ServerArgs {
  surface: Surface;
  /** desktop: 設定項目の作業フォルダー（生の値） */
  workspaceDirRaw?: string;
  /** claude-code: 登録済みの作業フォルダー（生の値。JSON の配列の文字列） */
  rootsRaw?: string;
}

/** 作業フォルダーの拒否（応答の error.code。フックが「登録済みの作業フォルダーでない」を見て再接続の案内に置き換える） */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

export class ArgumentError extends Error {
  override name = "ArgumentError";
}

/** 設定項目が空のとき、置き換えられずに ${user_config.…} の字のまま届いたときは「未設定」 */
export function isUnset(v: string | undefined): boolean {
  return v === undefined || v.trim() === "" || /^\$\{[^}]+\}$/.test(v.trim());
}

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** 先頭の ~ か ~/（~\）だけをホームのフォルダーにする（~user の形はそのまま＝絶対パスでないので断る） */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
}

/** 設定項目のパスの値: 引用符を外し、~ を展開する */
const settingPath = (v: string): string => expandHome(unquote(v));

export function parseArgs(argv: readonly string[]): ServerArgs {
  let surface: string | undefined;
  let workspaceDirRaw: string | undefined;
  let rootsRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--surface") surface = v;
    else if (a === "--workspace-dir") workspaceDirRaw = v ?? "";
    else if (a === "--roots") rootsRaw = v ?? "";
    else throw new ArgumentError(`知らない引数: ${a}`);
    i++;
  }
  if (surface !== "claude-code" && surface !== "desktop") throw new ArgumentError("--surface は claude-code か desktop");
  return { surface, workspaceDirRaw, rootsRaw };
}

export interface FixedWorkspace {
  /** 実際のパス（だめなら undefined） */
  root?: string;
  /** だめな理由（利用者にすること） */
  problem?: string;
  /** この呼び出しで作った（標準エラーに出すだけ。応答には出さない＝何度も起動し直す Desktop で読み違えないように。実装案 4.1） */
  createdNow?: boolean;
}

/** Desktop の作業フォルダーを確かめて固定する */
export function fixWorkspace(raw: string | undefined): FixedWorkspace {
  if (isUnset(raw)) return { problem: "作業フォルダーが設定されていない。拡張機能の設定で作業フォルダーを選ぶ" };
  const dir = settingPath(raw as string);
  if (!path.isAbsolute(dir)) return { problem: "作業フォルダーが絶対パスでない。拡張機能の設定で選び直す" };
  let createdNow = false;
  if (!existsSync(dir)) {
    const parent = path.dirname(dir);
    let parentIsDir = false;
    try {
      parentIsDir = statSync(realpathSync(parent)).isDirectory();
    } catch {
      // すぐ上のフォルダーが無い
    }
    if (!parentIsDir) return { problem: `作業フォルダーが無く、すぐ上のフォルダー（${path.basename(parent)}）も無いので作らない。フォルダーを作るか、選び直す` };
    try {
      mkdirSync(dir); // 最後の 1 段だけ（recursive にしない）
      createdNow = true;
    } catch (e) {
      // Desktop は短い間に何度も起動し直すので、別の起動が先に作っていてもよい
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { problem: `作業フォルダーを作れなかった（${(e as NodeJS.ErrnoException).code ?? "Error"}）` };
    }
  }
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return { problem: "作業フォルダーがフォルダーでない（同じ名前のファイルがある）。選び直す" };
    return { root: real, createdNow };
  } catch {
    return { problem: "作業フォルダーが存在しない。選び直す" };
  }
}

/** Claude Code の登録済みの作業フォルダーを実際のパスに直す（だめなものは捨てて数だけ数える） */
export function canonicalRoots(raw: string | undefined): { roots: string[]; dropped: number } {
  if (isUnset(raw)) return { roots: [], dropped: 0 };
  const t = (raw as string).trim();
  let list: string[] = [t];
  if (t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      list = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      list = [];
    }
  }
  const roots: string[] = [];
  let dropped = 0;
  for (const v of list) {
    try {
      const p = settingPath(v);
      if (!path.isAbsolute(p)) throw new Error("not absolute");
      const real = realpathSync(p);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
      if (!roots.some((r) => fold(r) === fold(real))) roots.push(real);
    } catch {
      dropped++;
    }
  }
  return { roots, dropped };
}

/** 作業フォルダーの状態（サーバーに 1 つ。Desktop は起動時にだめなら呼び出しのたびに確かめ直す） */
export class WorkspaceBinding {
  readonly args: ServerArgs;
  private desktop: FixedWorkspace = {};
  readonly registered: { roots: string[]; dropped: number };

  constructor(args: ServerArgs, log: (line: string) => void = () => {}) {
    this.args = args;
    this.registered = args.surface === "claude-code" ? canonicalRoots(args.rootsRaw) : { roots: [], dropped: 0 };
    if (args.surface === "desktop") {
      this.desktop = fixWorkspace(args.workspaceDirRaw);
      if (this.desktop.createdNow) log(`作業フォルダーを作った: ${this.desktop.root}`);
    }
  }

  /** Desktop の作業フォルダー（起動時にだめなら確かめ直す） */
  desktopWorkspace(): FixedWorkspace {
    if (!this.desktop.root) this.desktop = fixWorkspace(this.args.workspaceDirRaw);
    return this.desktop;
  }

  /** このサーバーが知っている作業フォルダー（kintone の接続のファイルがこの中にあれば使わない。実装案 15.3） */
  knownRoots(): string[] {
    if (this.args.surface === "desktop") {
      const root = this.desktopWorkspace().root;
      return root ? [root] : [];
    }
    return [...this.registered.roots];
  }

  /** ツールの workspaceId から作業フォルダーの実際のパスを決める。だめなら WorkspaceError */
  resolve(workspaceId: string | undefined): string {
    if (this.args.surface === "desktop") {
      const ws = this.desktopWorkspace();
      if (!ws.root) throw new WorkspaceError(ws.problem ?? "作業フォルダーが決まらない");
      if (workspaceId !== undefined && !this.same(workspaceId, ws.root)) throw new WorkspaceError("workspaceId が設定の作業フォルダーと違う（workspaceId は省略してよい）");
      return ws.root;
    }
    if (workspaceId === undefined || workspaceId.trim() === "") throw new WorkspaceError("workspaceId が要る（formula のプラグインのフックが入れる）");
    const hit = this.registered.roots.find((r) => this.same(workspaceId, r));
    if (!hit) throw new WorkspaceError("登録済みの作業フォルダーでない（登録したばかりなら /mcp で formula を再接続する）");
    return hit;
  }

  private same(candidate: string, root: string): boolean {
    try {
      return fold(realpathSync(settingPath(candidate))) === fold(root);
    } catch {
      return false;
    }
  }
}
