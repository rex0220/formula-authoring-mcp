// フックの試験（claude plugin test。試作 0-3a / 0-3b の試験を元にした）。セッションのフォルダー・ファイルの情報・設定の行は、試験の on で差し替える。
// $.ui.ask（登録の確認の画面）は差し替えない（答える者がいないので拒否になる）。確認の画面は手で試す（README.md）。
import { describe, expect, test } from 'claude-code/testing'

const PLUGIN = 'formula'
const MCP = (tool: string) => `mcp__plugin_${PLUGIN}_formula__${tool}`

/** 仮のファイルの仕組み: フォルダーとファイルと symlink（/link → /ws/kintone） */
const DIRS = new Set(['/ws', '/ws/settings', '/ws/kintone', '/ws/kintone/h', '/ws/temp', '/ws/sub', '/other'])
const FILES = new Set(['/ws/settings/a.json'])
const LINKS: Record<string, string> = { '/link': '/ws/kintone' }

/** Windows の Claude Code は $.fs.stat('/ws') を C:\ws に直してから渡すので、ドライブ名を外して区切りを / にそろえる */
const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

function fold(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  let joined = '/' + out.join('/')
  for (const [from, to] of Object.entries(LINKS)) if (joined === from || joined.startsWith(from + '/')) joined = to + joined.slice(from.length)
  return joined
}

type Setup = { session?: string; roots?: string[]; brokenRoot?: boolean; noRow?: boolean; mcpAnswer?: Record<string, unknown> }

/** 試験の on に、エンジンの代わりの答えを並べる。返り値は、下まで届いた tool.call の記録 */
function engine(on: any, { session = '/ws', roots = [], brokenRoot = false, noRow = false, mcpAnswer }: Setup) {
  const reached: Array<Record<string, unknown>> = []
  // $ の呼び出しの答えは { value }（OpValueOf）。失敗させるときは { deny }
  on('session.root', () => (brokenRoot ? { deny: 'root is broken' } : { value: session }))
  on('session.cwd', () => ({ value: session }))
  on('fs.stat', ($: unknown, e: { path: string }) => {
    const path = posix(e.path)
    const real = fold(path)
    const isLink = Object.keys(LINKS).some(l => path === l || path.startsWith(l + '/'))
    if (DIRS.has(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink, realPath: real } }
    if (FILES.has(real)) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink, realPath: real } }
    return { deny: `ENOENT ${e.path}` }
  })
  // 設定項目は文字列 1 つに JSON の配列（2026-10-09 の手での確認で、文字列の配列の設定項目は /config の行にならなかった）
  on('config.list', () => ({
    value: noRow
      ? [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { kind: 'engine' }, isLocked: false }]
      : [{ key: `${PLUGIN}.workspaceRoots`, label: '計算式プラグインの作業フォルダー', kind: 'text', value: JSON.stringify(roots), provider: { kind: 'plugin', name: PLUGIN }, isLocked: false }]
  }))
  on('tool.call', { tool: ['Write', 'Edit'] }, ($: unknown, e: Record<string, unknown>) => {
    reached.push(e)
    return { result: { type: 'create', filePath: e.file_path } }
  })
  on('tool.call', { tool: /^mcp__/ }, ($: unknown, e: Record<string, unknown>) => {
    reached.push(e)
    return mcpAnswer ?? { result: { content: [{ type: 'text', text: 'ok' }] } }
  })
  return reached
}

const isDenied = (r: any) => r?.deny !== undefined || r?.isError === true
const denyText = (r: any) => String(r?.deny ?? r?.text ?? '')

describe('4.2 直接の Write / Edit', () => {
  test('登録の前でも settings/*.json への Write を拒否する', async ($, on) => {
    const reached = engine(on, { roots: [] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/settings/new.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/fml_save_settings/)
    expect(denyText(r)).toMatch(/fv_save_settings/)
    expect(reached.length).toBe(0)
  })

  test('kintone/ の下への Edit を拒否する（.. を含むパス）', async ($, on) => {
    engine(on, { roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Edit', file_path: '/ws/settings/../kintone/h/a-edit.json', old_string: 'a', new_string: 'b' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('symlink（/link → /ws/kintone）を通した Write を拒否する', async ($, on) => {
    engine(on, { roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/link/h/x.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('セッションが作業フォルダーの下でも、作業フォルダーを起点に判定する', async ($, on) => {
    engine(on, { session: '/ws/sub', roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/kintone/h/new.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('temp/ への Write は通す', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/temp/x.txt', content: 'x' } as any)
    expect(isDenied(r)).toBe(false)
    expect(reached.length).toBe(1)
  })

  test('作業フォルダーの外は止めない', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/other/settings/a.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(false)
    expect(reached.length).toBe(1)
  })

  test('解決できないパスは拒否する', async ($, on) => {
    engine(on, { roots: ['/ws'] })
    const r = await $.tool.call({ tool: 'Write', file_path: '/nowhere/deep/x.json', content: '{}' } as any)
    expect(isDenied(r)).toBe(true)
  })

  test('フックが失敗したら拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'], brokenRoot: true })
    const r = await $.tool.call({ tool: 'Write', file_path: '/ws/temp/x.txt', content: 'x' } as any)
    expect(isDenied(r)).toBe(true)
    expect(reached.length).toBe(0)
  })
})

describe('4.1 workspaceId の書き換え', () => {
  test('作業フォルダーを使うツールの workspaceId を、登録済みの作業フォルダーに書き換える', async ($, on) => {
    const reached = engine(on, { session: '/ws/sub', roots: ['/ws'] })
    const r = await $.tool.call({ tool: MCP('fml_save_settings'), workspaceId: '/evil', path: 'settings/x.json', content: '{}', expectedAbsent: true } as any)
    expect(isDenied(r)).toBe(false)
    expect(reached[0]?.workspaceId).toBe('/ws')
  })

  test('項目検証の fv_* も 7 つとも書き換える（0.4.0）', async ($, on) => {
    const reached = engine(on, { session: '/ws/sub', roots: ['/ws'] })
    const tools = ['fv_save_settings', 'fv_update_rows', 'fv_summary', 'fv_normalize', 'fv_check', 'fv_pull', 'fv_diff']
    for (const tool of tools) await $.tool.call({ tool: MCP(tool), workspaceId: '/evil' } as any)
    expect(reached.length).toBe(tools.length)
    expect(reached.every(r => r.workspaceId === '/ws')).toBe(true)
  })

  test('作業フォルダーの診断（③）も書き換える', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'] })
    await $.tool.call({ tool: MCP('fml_workspace_status'), workspaceId: '' } as any)
    expect(reached[0]?.workspaceId).toBe('/ws')
  })

  test('作業フォルダーを使わないツール（②）は書き換えない', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'] })
    await $.tool.call({ tool: MCP('fml_docs') } as any)
    await $.tool.call({ tool: MCP('fml_status') } as any)
    expect(reached.length).toBe(2)
    expect('workspaceId' in reached[0]).toBe(false)
    expect('workspaceId' in reached[1]).toBe(false)
  })

  test('未登録で確認に答えられないときは拒否する（AI は答えられない）', async ($, on) => {
    const reached = engine(on, { roots: [] })
    const r = await $.tool.call({ tool: MCP('fml_save_settings'), workspaceId: '/ws', path: 'settings/x.json', content: '{}', expectedAbsent: true } as any)
    expect(isDenied(r)).toBe(true)
    expect(reached.filter(e => String(e.tool).startsWith('mcp__')).length).toBe(0)
  })

  test('サーバーが古い設定のまま断ったら、再接続を案内する', async ($, on) => {
    engine(on, {
      roots: ['/ws'],
      mcpAnswer: { result: { content: [{ type: 'text', text: '{"ok":false,"status":"denied","error":{"code":"WorkspaceError","message":"登録済みの作業フォルダーでない"}}' }], isError: true } }
    })
    const r = await $.tool.call({ tool: MCP('fml_save_settings'), workspaceId: '/ws', path: 'settings/x.json', content: '{}', expectedAbsent: true } as any)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/再接続/)
  })

  test('登録先の行が無ければ、確認の画面を出す前に拒否し、見つかった行の名前を出す', async ($, on) => {
    const reached = engine(on, { roots: [], noRow: true })
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { deny: 'no one to ask' }
    })
    const r = await $.tool.call({ tool: MCP('fml_workspace_status'), workspaceId: '' } as any)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/行も見つからない/)
    expect(denyText(r)).toMatch(/拡張機能の formula/)
    expect(asked).toBe(false)
    expect(reached.length).toBe(0)
  })

  test('ほかのサーバーの同じ名前のツール（Desktop の拡張機能の fml_try など）は捕まえない（0.2.4）', async ($, on) => {
    const reached = engine(on, { roots: [], noRow: true })
    for (const tool of ['mcp__formula-authoring__fml_try', 'mcp__local_mcpb_rex0220_formula-authoring__fml_save_settings']) {
      const r = await $.tool.call({ tool, workspaceId: '', formulas: [{ formula: '1' }] } as any)
      expect(isDenied(r)).toBe(false)
    }
    expect(reached.length).toBe(2)
    expect(reached[0]?.workspaceId).toBe('')
  })

  test('フックが失敗したら拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on, { roots: ['/ws'], brokenRoot: true })
    const r = await $.tool.call({ tool: MCP('fml_save_settings'), workspaceId: '/ws', path: 'settings/x.json', content: '{}', expectedAbsent: true } as any)
    expect(isDenied(r)).toBe(true)
    expect(reached.length).toBe(0)
  })
})
