// formula MCP のための Claude Code のフック（formula MCP の hooks/register.ts の写し。実装案 4 章、4.1、4.2。計画 24.6）。
//   - 作業フォルダーを使うツール（① fml_save_settings など、項目検証の fv_*（MCP 0.4.0）、③ fml_workspace_status）の workspaceId を、
//     今のセッションのフォルダーに合う登録済みの作業フォルダーの実際のパスに書き換える（AI が渡した値は使わない）
//   - 作業フォルダーを使わないツール（② fml_docs、fml_status）には何もしない
//   - 未登録なら利用者に確認して（$.ui.ask）登録する（$.config.set）。登録したら「もう一度実行」と返す
//   - 直接の Write / Edit で settings/**/*.json と kintone/**、users/**（実データ）を変えるのを、登録の状態と関係なく拒否する（4.2）
//   - どの拒否のフックも .catch で失敗を拒否にする（fail-closed）
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

/**
 * 作業フォルダーを使うツール（① と ③）。このプラグインの MCP サーバー（mcp__plugin_formula_formula__）のものだけ。
 * ほかのサーバーの同じ名前のツール（Desktop の Cowork で拡張機能 .mcpb の formula が一緒に見えるとき。作業フォルダーは拡張機能の設定で決まり、フックは要らない）は捕まえない
 * （0.2.3 までは mcp__.+__ で捕まえ、拡張機能の fml_try まで「設定項目の行が見つからない」で止めていた。0.2.4）。項目検証の fv_* は 7 つとも作業フォルダーを使う（0.4.0）
 */
const WORKSPACE_TOOL = /^mcp__plugin_formula_formula__(fml_(save_settings|workspace_status|update_fields|summary|normalize|calc|try|fields|record|users|pull|files|take|edit|diff)|fv_(save_settings|update_rows|summary|normalize|check|pull|diff))$/

/**
 * 登録した後の案内。設定（/config）を変えてもプラグインの MCP サーバーは起動し直さず、/mcp の再接続か
 * Claude Code の起動し直しで新しい値が届く（2026-10-09 の手での確認）。登録は作業フォルダーごとに最初の 1 回だけなので、
 * そのときだけ利用者に再接続してもらう（2026-10-09 Takashi）
 */
const RECONNECT = '/mcp で formula を再接続（Reconnect）するか、Claude Code を起動し直してから、もう一度実行してください'

/** 直接の Write / Edit を拒否するパス（作業フォルダーからの相対。区切りは / にそろえる） */
const PROTECTED = [/^kintone(\/|$)/, /^settings\/.+\.json$/i, /^users(\/|$)/]

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
const sepOf = (p: string) => (isWindowsPath(p) ? '\\' : '/')
const foldCase = (p: string) => (isWindowsPath(p) ? p.toLowerCase() : p)
const trimSep = (p: string) => p.replace(/[\\/]+$/, '') || p

/** パスを実際のパス（symlink を解く）に直す。フォルダーだけ。だめなら undefined */
async function realDir($: $, p: string): Promise<string | undefined> {
  const st = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
  return st?.kind === 'dir' && st.realPath ? foldCase(trimSep(st.realPath)) : undefined
}

/**
 * Write がまだ無いファイル・フォルダーを指してもよいように、着地する実際のパスを返す（実装案 4.2。safe-path.ts と同じ考え）。
 * パスの . と .. を字面でたたんでから、存在する一番深い親を実際のパス（symlink を解く）に直し、残りをつなげる。
 * ドライブ相対・ネットワーク（\\ や //）・空・. / .. の名前は解決しない（undefined → 拒否）
 */
async function placed($: $, p: string): Promise<string | undefined> {
  if (/^[A-Za-z]:(?![\\/])/.test(p) || /^[\\/][\\/]/.test(p)) return undefined
  const sep = sepOf(p)
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : ''
  const parts: string[] = []
  for (const part of p.slice(drive.length).split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const name = parts[parts.length - 1]
  if (name === undefined || /^[A-Za-z]:/.test(name)) return undefined
  // 一番深い存在する親を探す（ファイルそのものから順にさかのぼる）
  for (let i = parts.length; i >= 0; i--) {
    const head = `${drive}${sep}${parts.slice(0, i).join(sep)}`
    const st = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (st?.realPath === undefined) continue
    const rest = parts.slice(i)
    if (rest.length > 0 && st.kind !== 'dir') return undefined // ファイルの下には置けない
    const base = trimSep(st.realPath)
    return foldCase(rest.length === 0 ? base : `${base}${sepOf(base)}${rest.join(sepOf(base))}`)
  }
  return undefined
}

const isUnder = (child: string, parent: string) => child === parent || child.startsWith(parent + sepOf(parent))

/**
 * 設定項目の値を、パスの並びにする。2026-10-09 の手での確認で、文字列の配列（"multiple": true）の設定項目は
 * /config の行にならなかったので、文字列 1 つに JSON の配列（["/Users/…"]）を入れる形にした
 */
function rootsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || value.trim() === '') return []
  const t = value.trim()
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return [t]
}

/** 登録済みの作業フォルダー（設定項目）を実際のパスに直す */
async function registeredRoots($: $, value: unknown): Promise<string[]> {
  const list = rootsOf(value)
  const out: string[] = []
  for (const v of list) {
    const r = await realDir($, String(v))
    if (r && !out.includes(r)) out.push(r)
  }
  return out
}

/** セッションのフォルダーと、それを含む登録済みの作業フォルダー（4.1） */
async function locate($: $, rootsValue: unknown) {
  const session = await realDir($, await $.session.root())
  if (session === undefined) return { session: undefined, matched: [] as string[] }
  const roots = await registeredRoots($, rootsValue)
  return { session, matched: roots.filter(r => isUnder(session, r)) }
}

/** 設定項目の行（`<plugin>.workspaceRoots`）。$.config.list で実際のキーを確かめる */
async function rootsRow($: $) {
  const rows = await $.config.list()
  return rows.find(r => r.key === `${$.plugin.name}.workspaceRoots`)
}

export const register: Register = (on, options) => {
  // ① ③: workspaceId を書き換える。未登録なら登録の確認
  on('tool.call', { tool: WORKSPACE_TOOL }, async ($, e, next) => {
    const row = await rootsRow($)
    const { session, matched } = await locate($, row?.value ?? options.workspaceRoots)
    if (session === undefined) return { deny: 'formula: セッションのフォルダーを解決できない' }
    if (matched.length === 1) {
      const result = await next({ ...e, workspaceId: matched[0] })
      // フックでは登録済みなのに、サーバーが「登録済みの作業フォルダーでない」と断った = サーバーが古い設定のまま動いている
      const text = JSON.stringify((result as { result?: unknown }).result ?? '')
      if (text.includes('WorkspaceError') && text.includes('登録済みの作業フォルダーでない'))
        return { deny: `formula: 作業フォルダーは登録済みだが、formula MCP が古い設定のまま動いている。${RECONNECT}` }
      return result
    }
    if (matched.length > 1) return { deny: 'formula: 登録済みの作業フォルダーが 2 つ以上合う。/config で整理する' }
    // 登録先の行が無ければ、確認の画面を出す前に断る（利用者に選ばせてから断らない）。見つかった行の名前（値は出さない）を付ける
    if (row === undefined) {
      const keys = (await $.config.list()).map(r => r.key).filter(k => k.startsWith($.plugin.name))
      return {
        deny:
          `formula: このセッションのフォルダー（${session}）は登録済みの作業フォルダーの中でなく、登録先の設定項目 ${$.plugin.name}.workspaceRoots の行も見つからない（このプラグインの行: ${keys.join(', ') || '無し'}）。` +
          'Claude Code では作業フォルダーで起動する。Desktop（Cowork）では拡張機能の formula（.mcpb）を使う'
      }
    }
    // 未登録: 利用者本人に確認する（AI は答えられない。headless では拒否される）
    let dismissed = false
    const answer = await $.ui
      .ask(`このフォルダーを計算式プラグインの作業フォルダーとして登録しますか？（${session}）`, ['登録する', '登録しない'])
      .catch(() => {
        dismissed = true
        return undefined
      })
    if (dismissed) return { deny: 'formula: 作業フォルダーの登録の確認に答えが無かった（閉じた、または確認の画面を出せない実行）' }
    // 試作: 返ってきた答えの形を確かめるため、断るときに答えをそのまま付ける（選んだ文字だけ。秘密の値ではない）
    if (answer !== '登録する') return { deny: `formula: 利用者が作業フォルダーを登録しなかった（答え: ${JSON.stringify(answer)?.slice(0, 200)}）` }
    const current = rootsOf(row.value)
    const set = await $.config.set({ key: row.key, value: JSON.stringify([...current, session]) })
    if ('deny' in set && set.deny !== undefined) return { deny: `formula: 登録できなかった（${set.deny}）` }
    // 設定を変えるとプラグインが読み込み直される。同じ呼び出しは続けない（実装案 4.1）
    return { deny: `formula: 作業フォルダーを登録しました。${RECONNECT}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'formula: 作業フォルダーの確認に失敗した' }))

  // 4.2: 直接の Write / Edit で settings/**/*.json と kintone/** を変えない（登録の状態と関係なく）
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const filePath = String((e as { file_path?: unknown }).file_path ?? '')
    const row = await rootsRow($).catch(() => undefined)
    const { session, matched } = await locate($, row?.value ?? options.workspaceRoots)
    if (session === undefined) return { deny: 'formula: セッションのフォルダーを解決できない' }
    if (matched.length > 1) return { deny: 'formula: 起点の作業フォルダーが 1 つに決まらない' }
    const base = matched.length === 1 ? matched[0] : session
    const absolute = isWindowsPath(filePath) || filePath.startsWith('/') ? filePath : `${await $.session.cwd()}${sepOf(base)}${filePath}`
    const real = await placed($, absolute)
    if (real === undefined) return { deny: 'formula: 書き込む先を解決できない' }
    if (!isUnder(real, base)) return next(e) // 起点のフォルダーの外は止めない（計算式プラグインと関係のないファイル）
    const rel = real.slice(base.length + 1).replace(/\\/g, '/')
    if (PROTECTED.some(re => re.test(rel)))
      return { deny: `formula: ${rel} は直接書き換えない。formula MCP の保存のツール（fml_save_settings / fml_update_fields、項目検証は fv_save_settings / fv_update_rows）を使う` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'formula: 書き込む先の確認に失敗した' }))

  // 起動の知らせ（登録済みの作業フォルダーの数）
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const row = await rootsRow($).catch(() => undefined)
    const n = rootsOf(row?.value).length
    $.ui.toast(`formula: 登録済みの作業フォルダー ${n} 件`)
    return result
  })
}
