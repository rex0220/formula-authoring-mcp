/**
 * 計算式プラグインの zip の読み込みの誤りを、種類（中核の PluginZipError の code）ごとの決まった文にする（診断の fml_status / fml_workspace_status と、
 * 作業フォルダーを使うツールの failed / incompatible）。生の誤りの文（zip のパス、zip の中のコードの文）は返さない。
 * 「zip として読めない」と「読めるが合わない」を分け、分かっていれば計算式プラグインの版と authoring API の版を返す（print-craft MCP の Codex の B1 再レビュー MAJOR 1 と同じ）
 */
import type { Surface } from "./binding.ts";
import { MIN_PLUGIN_VERSION, PluginZipError, type PluginZipErrorCode } from "./core.ts";
import { zipGuide } from "./context.ts";

export interface ZipErrorReport {
  code: PluginZipErrorCode | "unexpected";
  /** zip として読めたか（分からないときは無い） */
  readable?: boolean;
  /** 版が対応外なら true（ツールの status は incompatible。それ以外は failed） */
  incompatible: boolean;
  /** 求めた zip の計算式プラグインの版・authoring API の版（分かっているときだけ。zip-changed / restart-required は求めた zip のものでないので出さない） */
  pluginVersion?: string;
  authoringApiVersion?: number;
  /** 決まった文（パスや zip の中のコードの文を含まない） */
  text: string;
}

const UNREADABLE = new Set<string>(["not-configured", "missing", "unreadable"]);
const INCOMPATIBLE = new Set<string>(["unsupported-version", "api-unsupported", "api-incomplete"]);
/** 誤りが求めた zip そのものの話でない（版を出すと取り違える） */
const NOT_ABOUT_THIS_ZIP = new Set<string>(["zip-changed", "restart-required"]);

export function describeZipError(e: unknown, surface: Surface): ZipErrorReport {
  if (!(e instanceof PluginZipError)) {
    return { code: "unexpected", incompatible: false, text: `計算式プラグインの zip を読み込めない（想定外の誤り: ${e instanceof Error ? e.constructor.name : typeof e}）。formula MCP を入れ直す・更新する` };
  }
  const about = !NOT_ABOUT_THIS_ZIP.has(e.code);
  const v = about ? e.info.pluginVersion || undefined : undefined;
  const api = about && typeof e.info.apiVersion === "number" ? e.info.apiVersion : undefined;
  const ver = v ? `（計算式プラグインの版 ${v}）` : "";
  const reconnect = surface === "desktop" ? "Claude Desktop を起動し直す" : "/mcp で formula を再接続する";
  const texts: Partial<Record<string, string>> = {
    "not-configured": `計算式プラグインの zip の場所が分からない。${zipGuide(surface)}`,
    missing: `計算式プラグインの zip が無い（設定の場所にファイルが無い）。${zipGuide(surface)}`,
    unreadable: "計算式プラグインの zip として読めない（壊れているか、kintone のプラグインの zip でない）。配布元から入手した計算式プラグインの zip を選ぶ",
    "not-formula": `計算式プラグインの zip ではない（プラグイン ID が違う）${ver}。配布元から入手した計算式プラグイン（rex0220 formula）の zip を選ぶ`,
    "unsupported-version": `計算式プラグインの版 ${v ?? "不明"} の zip には対応していない（Ver.${MIN_PLUGIN_VERSION} 以降の zip を選ぶ。アプリに入れたものと同じ版）`,
    "no-api": `計算式プラグインの zip${ver}に authoring API が無い（Ver.${MIN_PLUGIN_VERSION} 以降の、配布元から入手した zip を選ぶ）`,
    "engine-unreadable": `計算式プラグインの zip${ver}の計算式エンジンを読み込めない（壊れているか、組み替えられた zip）。配布元から入手した zip を選ぶ`,
    "api-unreadable": `計算式プラグインの zip${ver}の authoring API を読み込めない（壊れているか、組み替えられた zip）。配布元から入手した zip を選ぶ`,
    "api-unsupported": `計算式プラグインの zip${ver}の authoring API の版 ${api ?? "不明"} に、この formula MCP は対応していない（formula MCP を更新する）`,
    "api-mismatch": `計算式プラグインの zip の authoring API と manifest の版が違う${ver}（組み替えられた zip）。配布元から入手した zip を選ぶ`,
    "api-incomplete": `計算式プラグインの zip${ver}の authoring API に、formula MCP が使うものが無い（計算式プラグインと formula MCP の版を合わせる）`,
    "zip-changed": `計算式プラグインの zip が、このサーバーが読み込んだものと違う（別の zip か、読み込んだ後に変わった）。1 つのサーバーで使える zip は 1 つ。zip を変えたら ${reconnect}`
  };
  const previous = typeof e.info.previous === "string" ? e.info.previous : "不明";
  texts["restart-required"] = `前に計算式プラグインの zip の読み込みに失敗し（${previous}）、そのコードがこのサーバーに残っているので、読み込み直せない。zip を直したら ${reconnect}`;
  return {
    code: e.code,
    ...(UNREADABLE.has(e.code) ? { readable: false } : about ? { readable: true } : {}),
    incompatible: INCOMPATIBLE.has(e.code),
    ...(v ? { pluginVersion: v } : {}),
    ...(api !== undefined ? { authoringApiVersion: api } : {}),
    text: texts[e.code] ?? `計算式プラグインの zip を読み込めない（${e.code}）`
  };
}
