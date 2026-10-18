/**
 * 互換表（compat.json。実装案 7 章）。ビルドのときに埋め込み、実行のときに確かめる。
 *   - runtimeChecks: schemaVersion（知らない値なら拒否）、mcpVersion（このサーバーの版）、coreVersion（束ねた中核の版の範囲）、
 *     coreApiVersion（束ねた中核の入口の API の版 CORE_API_VERSION。tools 2.0.0 で 2。実装案 15.11）、
 *     docsRevision（埋め込んだ資料の元のコミット）、authoringApiVersions と pluginVersion.min（計算式プラグインの zip を読んだとき）
 *   - 合わなければ、作業フォルダーを使うツールを incompatible で止める（判定できないときも止める）。fml_docs / fml_status /
 *     fml_workspace_status は止めない（登録の前や版が合わないときにも、目次・版・診断を読めるように。5.1）
 *   - プレリリースの版は、範囲に明記したときだけ通す（ここでは明記しないので通さない）
 */
import { CORE_API_VERSION, type Engine } from "./core.ts";
import { DOCS } from "./docs.ts";
import { VERSION, coreVersion } from "./version.ts";

declare const __FML_COMPAT__: string;

export interface Compat {
  schemaVersion: number;
  runtimeChecks: {
    mcpVersion: string;
    coreVersion: string;
    coreApiVersion: number;
    docsRevision: string;
    authoringApiVersions: number[];
    pluginVersion: { min: number; max?: number };
  };
  informational?: Record<string, unknown>;
}

export const SUPPORTED_SCHEMA = 1;

let parsed: { compat?: Compat; problem?: string } | undefined;

function load(): { compat?: Compat; problem?: string } {
  if (parsed) return parsed;
  try {
    if (typeof __FML_COMPAT__ !== "string") return (parsed = { problem: "互換表が埋め込まれていない（ビルドの誤り）" });
    const c = JSON.parse(__FML_COMPAT__) as Compat;
    return (parsed = { compat: c });
  } catch (e) {
    return (parsed = { problem: `互換表が読めない: ${(e as Error).message}` });
  }
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

export function parseSemver(v: string): SemVer | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" } : undefined;
}

function cmp(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** 範囲（空白で区切った >= > <= < = と版。版だけなら =）に入るか。読めない範囲・版は false。プレリリースは通さない */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v || v.pre) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(p);
    if (!m) return false;
    const b = parseSemver(m[2])!;
    const c = cmp(v, b);
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}

/** ビルドの組み合わせ（版・中核・資料）の判定。合わなければ理由 */
export function buildProblem(): string | undefined {
  const { compat, problem } = load();
  if (problem || !compat) return problem ?? "互換表が無い";
  if (compat.schemaVersion !== SUPPORTED_SCHEMA) return `互換表の schemaVersion ${String(compat.schemaVersion)} を知らない（このサーバーは ${SUPPORTED_SCHEMA}）`;
  const r = compat.runtimeChecks;
  if (!r || typeof r !== "object") return "互換表に runtimeChecks が無い";
  if (r.mcpVersion !== VERSION) return `互換表の mcpVersion ${String(r.mcpVersion)} とこのサーバーの版 ${VERSION} が違う`;
  const core = coreVersion().toolsVersion;
  if (typeof r.coreVersion !== "string" || !satisfies(core, r.coreVersion)) return `束ねた中核の版 ${core} が互換表の範囲 ${String(r.coreVersion)} に入らない`;
  if (r.coreApiVersion !== CORE_API_VERSION) return `束ねた中核の API の版 ${String(CORE_API_VERSION)} と互換表の coreApiVersion ${String(r.coreApiVersion)} が違う`;
  if (r.docsRevision !== DOCS.source.short) return `埋め込んだ資料の元 ${DOCS.source.short || "（無し）"} と互換表の docsRevision ${String(r.docsRevision)} が違う`;
  if (!Array.isArray(r.authoringApiVersions) || !r.authoringApiVersions.length || !r.pluginVersion || typeof r.pluginVersion.min !== "number") return "互換表の authoringApiVersions / pluginVersion が読めない";
  return undefined;
}

/** 計算式プラグインの zip の判定（authoring API の版、計算式プラグインの版の下限と上限） */
export function zipProblem(engine: Engine): string | undefined {
  const { compat } = load();
  if (!compat) return "互換表が無い";
  const r = compat.runtimeChecks;
  const api = (engine.api as { apiVersion?: unknown } | undefined)?.apiVersion;
  if (typeof api !== "number" || !r.authoringApiVersions.includes(api)) return `計算式プラグインの zip の authoring API の版 ${String(api)} は、このサーバーが扱う版（${r.authoringApiVersions.join(", ")}）でない`;
  const pv = Number(engine.source.pluginVersion);
  if (!Number.isInteger(pv)) return `計算式プラグインの zip の版が読めない: ${engine.source.pluginVersion}`;
  if (pv < r.pluginVersion.min) return `計算式プラグインの zip の版 ${pv} は、このサーバーが扱う版（Ver.${r.pluginVersion.min} 以降）より古い`;
  if (r.pluginVersion.max !== undefined && pv > r.pluginVersion.max) return `計算式プラグインの zip の版 ${pv} は、このサーバーが扱う版（Ver.${r.pluginVersion.max} まで）より新しい。formula MCP を更新する`;
  return undefined;
}

export function compatInfo(): Record<string, unknown> {
  const { compat, problem } = load();
  return compat ? { schemaVersion: compat.schemaVersion, ...compat.runtimeChecks, problem: buildProblem() ?? null } : { problem };
}
