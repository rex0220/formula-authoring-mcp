/**
 * kintone への接続（GET だけ。中核の createRestClient: 許可した API だけ、送信先は接続先だけ、受け取る量に上限）。
 * 中核 2.0.0（実装案 15 章）: kintone の接続のファイル（kSQL の ksql.config.json と同じ形。設定項目 kintoneConfig）の profile だけを使う。
 *   - profile は引数、無ければ defaultProfile、無ければ dev（kSQL と同じ）。ゲストスペースは profile の guestSpaceId（1 つの profile は 1 つのスペース）
 *   - 認証はその profile のそのアプリの tokenMap か、ログイン名とパスワード。作業フォルダーの .env の KINTONE_* と environments.json は読まない
 *   - アプリは番号。Desktop のツールはアプリの URL も（オリジンが profile の接続先と同じで、ゲストスペースが profile と同じときだけ。5.4、15.8）
 * 秘密の値は応答に入れない（中核の誤りの文も、HTTP の状態と kintone のエラーコードと決まったヒントだけ）
 */
import { z } from "zod";
import {
  ConnectionError,
  InputError,
  PROFILE_NAME_RE,
  authFor,
  createRestClient,
  describeAuth,
  pickProfile,
  requireProfiles,
  type ConnectionSet,
  type ProfileDef,
  type RestClient,
  type WorkspaceMode
} from "../core.ts";
import type { ServerContext } from "../context.ts";

/** 使う profile（呼び出しの初めに読んだ接続） */
export interface ProfileTarget {
  mode: WorkspaceMode;
  set: ConnectionSet;
  def: ProfileDef;
}

export interface KintoneTarget extends ProfileTarget {
  client: RestClient;
  authLabel: string;
  /** profile のゲストスペース（通常のスペースは無い） */
  guestSpaceId?: number;
}

/** 使う profile を決める（接続のファイルが無い・移行で止まっていれば ConnectionError）。mode は呼び出しの初めに読んだもの */
export function profileOf(mode: WorkspaceMode, profile: string | undefined): ProfileTarget {
  const conn = requireProfiles(mode, "kintone の操作");
  return { mode, set: conn.set, def: pickProfile(conn.set, profile) };
}

/** 接続のファイルを読んで、使う profile を決める */
export function profileFor(ctx: ServerContext, root: string, profile: string | undefined): ProfileTarget {
  return profileOf(ctx.mode(root), profile);
}

/** その profile のそのアプリの認証で kintone に接続する */
export function kintoneFor(t: ProfileTarget, appId: number): KintoneTarget {
  const auth = authFor(t.set, t.def, appId);
  return { ...t, client: createRestClient(auth), authLabel: `${describeAuth(auth)}（profile ${t.def.profile}）`, ...(t.def.guestSpaceId ? { guestSpaceId: t.def.guestSpaceId } : {}) };
}

export const appSchema = z.number().int().positive().describe("アプリの番号");

export const profileSchema = z
  .string()
  .regex(PROFILE_NAME_RE)
  .optional()
  .describe("kintone の接続のファイルの profile の名前（省略すると defaultProfile、無ければ dev）");

/**
 * Desktop のツールのアプリの指定: 番号か、アプリの URL（https、オリジンが profile の接続先と同じ、/k/<番号>/ か /k/guest/<スペース>/<番号>/。
 * ブラウザーから写した詳細画面・編集画面（…/<番号>/show#record=3、…/<番号>/edit）も、アプリの番号だけを使う（2026-10-10 の手での確認 3。Takashi「OK」）。
 * URL のゲストスペースは profile の guestSpaceId と同じとき（通常の URL を guest の profile に、guest の URL を通常の profile に渡すと guest-mismatch）。
 * ユーザー名・パスワードの部分があれば断る。query と fragment（レコードの番号など）は見ない（5.4、15.8）
 */
export function appRefOf(app: number | string, def: ProfileDef): number {
  if (typeof app === "number") return app;
  if (/^\d+$/.test(app)) {
    const n = Number(app);
    if (n > 0 && Number.isSafeInteger(n)) return n;
  }
  let u: URL;
  try {
    u = new URL(app);
  } catch {
    throw new InputError("アプリは番号か、アプリの URL（https://<サブドメイン>.cybozu.com/k/<番号>/）で指定する");
  }
  if (u.username || u.password) throw new InputError("アプリの URL にユーザー名・パスワードの部分は書かない");
  const origin = new URL(def.baseUrl).origin;
  if (u.protocol !== "https:" || u.origin !== origin) throw new InputError(`アプリの URL が profile「${def.profile}」の接続先（${origin}）のものでない（別の接続先の URL から番号だけを使わない）`);
  const m = u.pathname.match(/^\/k\/(?:guest\/(\d+)\/)?(\d+)(?:\/(?:show|edit))?\/?$/);
  if (!m) throw new InputError("アプリの URL は /k/<番号>/（詳細画面の /k/<番号>/show#record=… も可）か /k/guest/<スペース>/<番号>/ の形");
  const appId = Number(m[2]);
  const guest = m[1] ? Number(m[1]) : null;
  if (!Number.isSafeInteger(appId) || appId <= 0 || (guest !== null && (!Number.isSafeInteger(guest) || guest <= 0))) throw new InputError("アプリの URL の番号が正の整数でない");
  if (guest !== def.guestSpaceId) {
    throw new ConnectionError(
      guest !== null
        ? `アプリの URL はゲストスペース ${guest} のもの。profile「${def.profile}」は${def.guestSpaceId ? `ゲストスペース ${def.guestSpaceId}` : "通常のスペース"}の接続（ゲストスペースごとに profile を分ける）`
        : `profile「${def.profile}」はゲストスペース ${def.guestSpaceId} の接続。通常のスペースのアプリの URL は使えない（profile を分ける）`,
      "guest-mismatch"
    );
  }
  return appId;
}
