/**
 * kintone の接続のファイルの診断（実装案 15.8）。fml_status は読めるかと理由の code だけ、fml_workspace_status は profile ごとの中身も。
 *   - 返すのは接続のファイルの名前（パスは返さない）、profile の名前・ホスト・ゲストスペース・認証の種類・tokenMap のアプリの番号とトークンが使えるか、
 *     使えない profile とその理由（中核の決まった文。キーの名前まで）、警告。トークン・パスワード・ログイン名・環境変数の名前は返さない
 *   - 接続の誤りがあっても診断のツールの status は ok（ここでは誤りを code にして返す。15.10）
 */
import type { Surface } from "../binding.ts";
import { ConnectionError, pickProfile, type ConnectionSet, type ProfileDef } from "../core.ts";
import { sanitizeMessage } from "../result.ts";

export interface ConnectionProblem {
  code: string;
  message: string;
}

/** 接続のファイルの設定のしかた（出し分けごと） */
export function connectionGuide(surface: Surface): string {
  return surface === "desktop"
    ? "拡張機能の設定で「kintone の接続のファイル」を選ぶ（kSQL の ksql.config.json と同じ形。作業フォルダーの外に置く）"
    : "/config で formula の「計算式プラグインの接続のファイル（kintone）」に絶対パスを入れて /mcp で再接続する（kSQL の ksql.config.json と同じ形。作業フォルダーの外に置く。.env ではない）";
}

/** 接続の誤りを決まった形に（文は中核の決まった文。念のため絶対パスなどを除く） */
export function problemOf(e: unknown): ConnectionProblem {
  if (e instanceof ConnectionError) return { code: e.code, message: sanitizeMessage(e.message) };
  return { code: "unexpected", message: "接続のファイルの確認で想定外の誤り" };
}

/** 次にすること（利用者が直す。AI は接続のファイルを読まない・書かない） */
export function connectionNext(p: ConnectionProblem, surface: Surface): string {
  if (p.code === "not-configured") return `kintone を使うツール（fml_fields など）には、${connectionGuide(surface)}`;
  return `kintone の接続のファイルが使えない（${p.code}）: ${p.message}（利用者が直す。AI は接続のファイルを読まない・書かない）`;
}

function profileReport(def: ProfileDef): Record<string, unknown> {
  return {
    name: def.profile,
    host: def.host,
    guestSpaceId: def.guestSpaceId,
    auth: def.auth,
    ...(def.auth === "token" ? { tokenApps: def.tokenApps.map((appId) => ({ appId, ready: def.tokenReady[appId] === true })) } : { userpassReady: def.userpassReady })
  };
}

/** 読めた接続のファイルの中身（秘密の値と環境変数の名前を除く） */
export function connectionDetail(set: ConnectionSet): Record<string, unknown> {
  let defaultProfile: Record<string, unknown>;
  try {
    const def = pickProfile(set);
    defaultProfile = { name: def.profile, from: set.defaultProfile !== undefined ? "defaultProfile" : "dev" };
  } catch (e) {
    defaultProfile = { name: null, problem: problemOf(e) };
  }
  return {
    fileName: set.fileName,
    defaultProfile,
    profiles: [...set.profiles.values()].map(profileReport),
    ...(set.invalid.length ? { invalidProfiles: set.invalid.map((p) => ({ name: p.name, reason: p.reason })) } : {}),
    ...(set.warnings.length ? { warnings: [...set.warnings] } : {})
  };
}
