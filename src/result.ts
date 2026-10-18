/**
 * 応答の形（実装案 5.2。kSQL の toToolResult にそろえる）。
 *   成功: { ok: true, status: "ok", findings, result, digest? }
 *   失敗: { ok: false, status, error: { code, message }, findings }、isError: true
 * status は ok / invalid（呼び出しの引数・利用者の入力の誤り。normalize のエラーを含む）/ incompatible（互換表に合わない）/
 * conflict（呼び出しの途中の変更、digest が違う、ファイルがある、接続とアプリのフォルダーの印が合わない、同じアプリのフォルダーが 2 つ）/
 * denied（決まり・境界による拒否: 作業フォルダーの外・未登録・書けない場所・ダウンロードのファイル・作業フォルダーの中の接続のファイル）/
 * failed（要る設定が無い・読めない・形が違う、通信の失敗、時間切れ・上限・想定外の失敗）。実装案 5.2、15.10
 * content の文字と structuredContent は同じ中身。秘密の値は入れない
 */
import os from "node:os";

export type Status = "ok" | "invalid" | "incompatible" | "conflict" | "denied" | "failed";

export interface Finding {
  level: string;
  rule: string;
  message: string;
  [key: string]: unknown;
}

/** findings の件数の上限（AI に返す量。超えたら打ち切って truncated を出す。5.2） */
export const MAX_FINDINGS = 100;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export function toResult(payload: Record<string, unknown>, isError = false, meta?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError, ...(meta ? { _meta: meta } : {}) };
}

/** 上限を超えたら、上限 - 1 件と truncated の 1 件（合わせて上限の件数。Codex の B1 レビュー MINOR 2） */
export function capFindings(findings: readonly Finding[]): Finding[] {
  const safe = findings.map((f) => (typeof f.message === "string" ? { ...f, message: sanitizeMessage(f.message) } : f));
  if (safe.length <= MAX_FINDINGS) return safe;
  const kept = MAX_FINDINGS - 1;
  return [...safe.slice(0, kept), { level: "info", rule: "truncated", message: `findings を ${kept} 件で打ち切った（ほかに ${safe.length - kept} 件）` }];
}

/** meta は結果の _meta（MCP Apps の UI にだけ渡すもの。モデルの文脈に入れない。preview の MCP App。実装案 16 章） */
export function ok(result: Record<string, unknown>, opt: { findings?: readonly Finding[]; digest?: string; meta?: Record<string, unknown> } = {}): ToolResult {
  return toResult({ ok: true, status: "ok", findings: capFindings(opt.findings ?? []), result, ...(opt.digest ? { digest: opt.digest } : {}) }, false, opt.meta);
}

/** 誤りの文のホームのフォルダーを ~ に（作業フォルダーの絶対パスと利用者の名前を AI に返さない。Codex の B1 レビュー MAJOR 3） */
export function scrubHome(message: string): string {
  const home = os.homedir();
  return home && home.length > 1 ? message.split(home).join("~") : message;
}

let scrubRoots: RegExp[] = [];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** パスの前後の区切りとみなす文字（空白、引用符、括弧、句読点など）。これ以外の文字が続く・前にあるときは、別のパスの一部として置き換えない */
const DELIMS = "\\s\"'`()（）「」『』【】\\[\\]<>{}、。，,:：;；=";

/**
 * 作業フォルダーの絶対パスに当たる正規表現。区切りは / と \ のどちらでも、Windows は大文字小文字を区別しない。
 * 前が文の始まりか区切りの文字（/other/work/app の途中に当てない）、後ろがパスの区切り（続きは作業フォルダーからの相対として残す）か、
 * 文の終わり・区切りの文字のときだけ当てる（/work/app で /work/app-copy に当てない。Codex の B1 3 回目 MINOR 2、4 回目 MINOR 1）。
 * 「場所/work/app」のように区切りの文字の無いものは置き換えない（ホームのフォルダーは scrubHome が ~ にする）
 */
export function rootPattern(root: string, platform: NodeJS.Platform = process.platform): RegExp {
  const body = root.split(/[\\/]+/).map(escapeRe).join("[\\\\/]+");
  return new RegExp(`(?<=^|[${DELIMS}])${body}(?:[\\\\/]+|(?=$|[${DELIMS}]))`, platform === "win32" ? "gi" : "g");
}

/** 誤りの文から除く作業フォルダー（起動のときに登録済み・設定の作業フォルダーを渡す。長いものから置き換える） */
export function setScrubRoots(roots: readonly string[], platform: NodeJS.Platform = process.platform): void {
  scrubRoots = [...new Set(roots)]
    .filter((r) => r.replace(/[\\/]+$/, "").length > 3)
    .sort((a, b) => b.length - a.length)
    .map((r) => rootPattern(r.replace(/[\\/]+$/, ""), platform));
}

/**
 * JSON.parse の誤りの文（Node 20 から「Unexpected token 'x', "…" is not valid JSON」の形で中身の一部が入る）の中身を除く。
 * 読んだファイル（レコード、設定）の値を返さない。位置（position / line / column）だけの文はそのまま（Codex の B1 再レビュー）。
 * MCP が読む JSON（設定・項目定義・レコード）は読み込みの境で決まった文にしてある（files.ts の withJsonError）。これは中核の中の読み込みなどへの備え
 */
const JSON_SNIPPET = /(?:Unexpected token '[\s\S]{1,2}', )?(?:\.\.\.)?"[\s\S]*? is not valid JSON/g;

/** AI に返す文: JSON の中身の一部を除き、作業フォルダーの絶対パスを相対に、ホームのフォルダーを ~ に */
export function sanitizeMessage(message: string): string {
  let m = message.replace(JSON_SNIPPET, "JSON として読めない（中身は返さない）");
  for (const re of scrubRoots) m = m.replace(re, (hit) => (/[\\/]$/.test(hit) ? "" : "（作業フォルダー）"));
  return scrubHome(m);
}

export function failure(status: Exclude<Status, "ok">, code: string, message: string, findings: readonly Finding[] = []): ToolResult {
  return toResult({ ok: false, status, error: { code, message: sanitizeMessage(message) }, findings: capFindings(findings) }, true);
}

/** 想定外の誤りを failed に（誤りの種類はクラスの名前。文は中核の決まった文。秘密の値を含まない） */
export function unexpected(e: unknown): ToolResult {
  // 種類は組み込みの Error の名前だけ（name / constructor.name は使わない）。文は返さない（値やパスを含みうる。Codex の r2 / r5 レビュー）
  const code = e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof ReferenceError ? "ReferenceError" : e instanceof SyntaxError ? "SyntaxError" : "Error";
  return failure("failed", code, `想定外の誤り（${code}）。誤りの文は値やパスを含みうるので返さない。fml_status で状態を確かめ、直らなければ利用者に伝える`);
}
