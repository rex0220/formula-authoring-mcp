/**
 * 評価（normalize / calc）の仕事の組み立て（CLI の jobOf と同じ決まり）: 設定ファイル、項目定義、ユーザー情報、policy、接続先、計算式プラグインの zip をそろえて、
 * 中核の runEval（Worker。時間上限。計画 24.5）に渡す
 */
import path from "node:path";
import { readFieldsFile, runEval, type EvalJob, type EvalOutcome, type FieldsFile, type Lang, type UsersOrigin, type UsersSource } from "../core.ts";
import type { WorkContextForTool } from "./common.ts";
import { fieldsFileFor, readSettingsFile, trustedBaseUrl, usersSourceFor, withJsonError, type SettingsFile, type TrustedBaseUrl } from "./files.ts";

export interface EvalTarget {
  file: SettingsFile;
  fields: FieldsFile;
  fieldsFile: string;
  baseUrl: TrustedBaseUrl;
  users: { src: UsersSource; origin: UsersOrigin };
}

/** 設定ファイル・項目定義・接続先・ユーザー情報をそろえる（読む前に kintone/** の確かめ。アプリのフォルダーの設定は同じフォルダーの fields.json） */
export async function evalTargetOf(w: WorkContextForTool, settingsPath: string, opt: { fields?: string; profile?: string; users?: string }, plugin: "formula" | "field-validation" = "formula"): Promise<EvalTarget> {
  const file = readSettingsFile(w.root, settingsPath, w.mode, plugin);
  const fieldsFile = fieldsFileFor(w.root, file.file, opt.fields, w.mode, file.settings);
  const fields = await withJsonError(w.root, fieldsFile, "項目定義のファイル", () => readFieldsFile(fieldsFile));
  const baseUrl = trustedBaseUrl(w.mode, w.root, path.resolve(w.root, settingsPath), opt.profile);
  const users = usersSourceFor(w.root, opt.users, w.mode);
  return { file, fields, fieldsFile, baseUrl, users };
}

export function jobOf(w: WorkContextForTool, t: EvalTarget, kind: EvalJob["kind"], opt: { check?: boolean; lang?: Lang; calc?: EvalJob["calc"] } = {}): EvalJob {
  return {
    kind,
    pluginZip: w.source.pluginZip,
    devPluginDir: w.source.devPluginDir,
    mode: w.source.mode,
    vendorDir: w.source.vendorDir,
    baseUrl: t.baseUrl.baseUrl,
    settingsText: t.file.text,
    settingsFile: t.file.relPath,
    fields: t.fields,
    usersSource: t.users.src,
    usersOrigin: t.users.origin,
    policy: w.policy,
    check: opt.check,
    lang: opt.lang,
    ...(opt.calc ? { calc: opt.calc } : {})
  };
}

/** Worker で動かす（時間上限は引数、無ければ中核の既定 60 秒） */
export function runJob(w: WorkContextForTool, job: EvalJob, timeoutSec?: number): Promise<EvalOutcome> {
  return runEval(job, w.run(timeoutSec));
}
