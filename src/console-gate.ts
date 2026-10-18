/**
 * console の出力の行き先（標準出力は JSON-RPC だけ）。console のすべての出力（log・warn・dir・table など）を標準エラーへ回すが、
 * 計算式プラグインのエンジンを動かす処理（ctx.serial と ctx.engine の中）と、そこから続く非同期の処理（Promise、タイマー）の出力は捨てる
 * （AsyncLocalStorage でその処理の文脈だけを見る。同時に動くほかの要求や SDK の出力は捨てない。Codex の B1 3 回目 MINOR 1）。
 * 計算式プラグインの fileNameOf は $fname の評価の失敗を例外ごと console.log し、計算式プラグインが使う moment は日付として読めない値を警告（console.warn）に入れる。
 * どちらもレコードの値を含みうる（Desktop の main.log などに残さない。Codex の B1 再レビュー BLOCKER 1）。捨てたときは件数だけを 1 行で残す。
 * サーバー自身の記録（log）は process.stderr に直接書くので、ここを通らない。
 * 限界: zip の中のコードが process.stdout / process.stderr に直接書くものは捕まえない（計算式プラグインの zip のコードは同じプロセスで動く。
 * 配布元の zip はそうしない。改変された zip は受け入れた危険。threat-model.md の T4）
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";

interface QuietScope {
  dropped: number;
}

const scope = new AsyncLocalStorage<QuietScope>();
let report: (line: string) => void = () => undefined;

/** console のすべての出力を、標準エラーか（計算式プラグインのエンジンの処理の文脈なら）捨てる先に向ける。起動のときに 1 回 */
export function installConsoleGate(log: (line: string) => void): void {
  report = log;
  const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr });
  const target = console as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(toStderr as unknown as Record<string, unknown>)) {
    if (typeof v !== "function") continue;
    const method = v as (...a: unknown[]) => unknown;
    target[k] = (...a: unknown[]): unknown => {
      const s = scope.getStore();
      if (s) {
        s.dropped++;
        return undefined;
      }
      return method(...a);
    };
  }
}

/** fn と、そこから続く非同期の処理の console の出力を捨てる（重ねてよい。終わったときに捨てた件数を記録する。後から出た分は数えずに捨てる） */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  const s: QuietScope = { dropped: 0 };
  try {
    return await scope.run(s, fn);
  } finally {
    if (s.dropped > 0) report(`計算式プラグインのコードなどの console の出力を ${s.dropped} 件捨てた（レコードの値を含みうるので出さない）`);
  }
}
