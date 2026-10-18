/**
 * fml_users（ユーザー情報のテストデータ。計画 24.2）: User API からユーザー・組織・グループと所属を取り、users/<ホスト名>.json に保存する（個人情報。0o600。コミットしない）。
 * 返すのは件数と呼び出し数と要約（人数だけ。コードや名前は出さない）。onlyReferenced に設定のファイルを渡すと、式が文字列で参照するコードとその所属だけ
 * （引数なしの UINFO() などがあれば全部取る）。file を渡すと取らずに既存のファイルの要約。認証は profile の userApiToken（cybozu.com 共通の API トークン）かログイン名とパスワード
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFAULT_MAX_CALLS, WRITE_ROOTS, createRestClient, describeAuth, pullReferencedUsers, pullUsers, referencedCodesOf, summarizeUsers, userApiAuthFor, usersFileNameOf, type UsersSource } from "../core.ts";
import type { ServerContext } from "../context.ts";
import { ok } from "../result.ts";
import { isToolResult, prepare, workspaceIdSchema } from "./common.ts";
import { checkRelPaths, fromError, readSettingsFile, rel, usersSourceFor, writeChecked } from "./files.ts";
import { profileFor, profileSchema } from "./kintone.ts";

export function registerUsers(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "fml_users",
    {
      title: "ユーザー情報のテストデータを取る",
      description:
        "計算式プラグイン（rex0220 formula）のユーザー情報の関数（UINFO / OINFO / GINFO / OUSERS / GUSERS）を実データで確かめるため、kintone の User API からユーザー・組織・グループと所属を取り、作業フォルダーの users/ に保存する。返すのは件数だけ（コードや名前は返さない）。" +
        "onlyReferenced に設定 JSON を渡すと、式が参照するコードとその所属だけを取る。file を渡すと取らずに既存のファイルの要約。省略すれば既定の架空の 10 人で計算できるので、利用者が実データを求めたときだけ。kintone には読み取り（GET）だけ",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema(ctx.surface),
          profile: profileSchema,
          onlyReferenced: z.string().min(1).max(512).optional().describe("設定 JSON のファイル（作業フォルダーからの相対パス）。式が文字列で参照するコードとその所属だけを取る"),
          maxCalls: z.number().int().min(1).max(2000).optional().describe(`User API の呼び出し数の上限（既定 ${DEFAULT_MAX_CALLS}）`),
          file: z.string().min(1).max(512).optional().describe("既存のユーザー情報のファイル（users/ の中。作業フォルダーからの相対パス）。渡すと取らずに要約だけ返す")
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    (input) =>
      ctx.serial(async () => {
        try {
          checkRelPaths({ onlyReferenced: input.onlyReferenced, file: input.file });
          const w = await prepare(ctx, input.workspaceId);
          if (isToolResult(w)) return w;
          if (input.file) {
            const u = usersSourceFor(w.root, input.file, w.mode);
            return ok({ path: input.file, summary: summarizeUsers(u.src, u.origin), ...counts(u.src) });
          }
          const t = profileFor(ctx, w.root, input.profile);
          const auth = userApiAuthFor(t.set, t.def);
          const client = createRestClient(auth);
          const authLabel = `${describeAuth(auth)}（profile ${t.def.profile}）`;
          const target = path.join(w.root, "users", usersFileNameOf(client.baseUrl));
          let r: { source: UsersSource; calls: number };
          let note: string;
          if (input.onlyReferenced) {
            const f = readSettingsFile(w.root, input.onlyReferenced, w.mode);
            const ref = referencedCodesOf(f.settings, (formula) => w.engine.api.stripFormula(formula) as string);
            if (ref.dynamic.length) {
              r = await pullUsers(client, { maxCalls: input.maxCalls });
              note = `onlyReferenced は使えないので全部取った: ログインユーザーや項目の値で決まる呼び出しがある（${ref.dynamic.slice(0, 3).join("、")}${ref.dynamic.length > 3 ? ` ほか ${ref.dynamic.length - 3}` : ""}）`;
            } else if (!ref.users.length && !ref.orgs.length && !ref.groups.length) {
              return ok({ path: null, summary: `${f.relPath} の式にユーザー情報の関数（UINFO / OINFO / GINFO / OUSERS / GUSERS）が無い。取るものが無いので何も書かない（全部取るなら onlyReferenced を外す）`, users: 0, orgs: 0, groups: 0, calls: 0 });
            } else {
              r = await pullReferencedUsers(client, ref, { maxCalls: input.maxCalls });
              note = `${f.relPath} の ${ref.fields} 項目の式が参照するコード（ユーザー ${ref.users.length}、組織 ${ref.orgs.length}、グループ ${ref.groups.length}）とその所属だけ`;
            }
          } else {
            r = await pullUsers(client, { maxCalls: input.maxCalls });
            note = "すべてのユーザー・組織・グループと所属";
          }
          const out = writeChecked(w.root, target, `${JSON.stringify(r.source, null, 2)}\n`, WRITE_ROOTS.users, "record", w.mode, 0o600);
          const relPath = rel(w.root, out);
          return ok({
            path: relPath,
            ...counts(r.source),
            calls: r.calls,
            summary: summarizeUsers(r.source, { kind: "file", file: relPath }),
            auth: authLabel,
            baseUrl: client.baseUrl,
            note: `${note}。個人情報を含む（コミットしない。Read で開かない。終わったら利用者が消す）。fml_calc / fml_normalize の users に ${relPath} を渡す`
          });
        } catch (e) {
          return fromError(e);
        }
      })
  );
}

function counts(src: UsersSource): { users: number; orgs: number; groups: number } {
  return { users: src.users.length, orgs: src.organizations.length, groups: src.groups.length };
}
