/**
 * サーバーの文脈: 出し分け（--surface）、作業フォルダーの結び付け、設定項目の値（環境変数）、計算式プラグインのエンジン、評価の Worker の動かし方、ツールを 1 つずつ動かす仕組み。
 * 設定項目の値は起動時に一度だけ受け取り、中核に引数で渡す（中核は process.env を読まない）
 */
import { expandHome, isUnset, type Surface, type WorkspaceBinding } from "./binding.ts";
import { quietly } from "./console-gate.ts";
import { loadEngine, modeOf, pluginZipPath, unquote, type Engine, type EvalSource, type RunOptions, type WorkspaceMode } from "./core.ts";
import { VENDOR_DIR, WORKER_FILE } from "./paths.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServerContext {
  surface: Surface;
  binding: WorkspaceBinding;
  /** 設定項目の値（空と、置き換えられずに ${user_config.…} の字のまま届いたものは除いてある） */
  env: Env;
  log: (line: string) => void;
  /**
   * 計算式プラグインのエンジン（主スレッド。中核が 1 プロセスに 1 つだけ読む。互換表の判定、fml_summary の既定値、fml_pull の保存値の読み取りに使う）。
   * zip のコードを動かす前の失敗（無い・読めない・別のプラグイン・版）は次の呼び出しでやり直すが、動かし始めた後の失敗は、再接続（Desktop は再起動）まで
   * PluginZipError（restart-required）。読み込んだ後に別の zip や変わった zip を渡すと、中核が PluginZipError（zip-changed）で止める。
   * normalize / calc / 保存の検査は、このエンジンでなく評価の Worker（evalSource / runOptions。呼び出しごとに zip を読む）で行う（計画 24.5）
   */
  engine(zip: string): Promise<Engine>;
  /** 評価（Worker）の読み込み元（計算式プラグインの zip と、束ねた本体の隣の vendor/） */
  evalSource(zip: string): EvalSource;
  /** Worker の動かし方: 時間上限、束ねた入口、Worker の標準出力・標準エラーは親に流さず捨てる（件数だけ標準エラーに。レコードの値を含みうる） */
  runOptions(timeoutSec?: number): RunOptions;
  /** 中核のエンジン・Worker を使うツールは 1 つずつ動かす（エンジンは 1 つで setContext を挟むので重ねない。Worker を同時に 2 つ起動しない）。動かしている間の console の出力は捨てる */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** kintone の接続のファイル（設定項目 kintoneConfig = FORMULA_KINTONE_CONFIG。~ を展開し両端の引用符を外したもの。無ければ undefined） */
  connectionFile: string | undefined;
  /**
   * 動く形（print-craft MCP の実装案 15.4）: 接続のファイルがあれば profiles（読めなければ ConnectionError）、無くて environments.json があれば legacy-blocked、
   * 無ければ not-configured。呼び出しの初めに 1 回（接続のファイルはツールを呼ぶたびに読む。書き換えは再接続なしで効く）
   */
  mode(root: string): WorkspaceMode;
}

/** 未設定の値を除く（設定項目が空のとき、Claude Code は空の文字、ホストによっては ${user_config.…} の字のまま渡す） */
export function sanitizeEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && !isUnset(v)) out[k] = v;
  return out;
}

export function createServerContext(surface: Surface, binding: WorkspaceBinding, env: Env, log: (line: string) => void): ServerContext {
  let tail: Promise<unknown> = Promise.resolve();
  const clean = sanitizeEnv(env);
  const connectionFile = clean.FORMULA_KINTONE_CONFIG !== undefined ? expandHome(unquote(clean.FORMULA_KINTONE_CONFIG)) : undefined;
  return {
    surface,
    binding,
    env: clean,
    log,
    connectionFile,
    mode(root) {
      // 今の作業フォルダーも必ず入れる（接続のファイルがこの中にあれば使わない。15.3）
      const roots = [...new Set([root, ...binding.knownRoots()])];
      return modeOf(root, { configFile: connectionFile, workspaceRoots: roots, env: clean, surface: "mcp" });
    },
    engine(zip) {
      return quietly(() => loadEngine({ pluginZip: zip, vendorDir: VENDOR_DIR }));
    },
    evalSource(zip) {
      return { pluginZip: zip, vendorDir: VENDOR_DIR };
    },
    runOptions(timeoutSec) {
      return {
        ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        workerFile: WORKER_FILE,
        captureOutput: (chunk, stream) => log(`評価の Worker の${stream === "stdout" ? "標準出力" : "標準エラー"}を捨てた（${chunk.length} 文字。計算式プラグインのコードの出力はレコードの値を含みうるので出さない）`)
      };
    },
    serial(fn) {
      const quiet = () => quietly(fn);
      const run = tail.then(quiet, quiet);
      tail = run.catch(() => undefined);
      return run;
    }
  };
}

export interface ZipChoice {
  zip?: string;
  source: "設定項目" | "作業フォルダーの .env" | "無し";
  problem?: string;
}

/** 計算式プラグインの zip の場所: 設定項目（環境変数 FORMULA_PLUGIN_ZIP。絶対パスだけ）か、作業フォルダーの .env（今の CLI と同じ） */
export function zipOf(ctx: ServerContext, root: string | undefined): ZipChoice {
  const fromConfig = ctx.env.FORMULA_PLUGIN_ZIP !== undefined;
  try {
    const zip = fromConfig ? pluginZipPath({ cwd: root ?? "/", env: ctx.env, envFile: "/nonexistent-formula-mcp/.env" }) : root ? pluginZipPath({ cwd: root, env: {} }) : undefined;
    if (zip) return { zip, source: fromConfig ? "設定項目" : "作業フォルダーの .env" };
    return { source: "無し" };
  } catch (e) {
    return { source: fromConfig ? "設定項目" : "作業フォルダーの .env", problem: (e as Error).message };
  }
}

export function zipGuide(surface: Surface): string {
  return surface === "desktop"
    ? "拡張機能の設定で「計算式プラグインの zip」を選ぶ（アプリに入れたものと同じ版。Ver.101 以降）"
    : "/config で formula の「計算式プラグインの zip」に絶対パスを入れて /mcp で再接続する（作業フォルダーの .env の FORMULA_PLUGIN_ZIP でもよい。Ver.101 以降）";
}
