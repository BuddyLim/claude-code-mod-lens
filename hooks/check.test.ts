import { expect, test } from 'claude-code/testing'

import type { Diag } from '../types'
import {
  explain,
  groupByRoot,
  hasNameSearch,
  isAwaited,
  isCheckable,
  labelNew,
  parsePyright,
  parseRuff,
  parseTerraform,
  parseTsc,
  refreshServed,
  toolsAwaited,
  uncheckedNotes,
} from './check'
import type { Run as ServerRun } from './lsp'

const diag = (line: number, severity: Diag['severity'] = 'error'): Diag => ({
  path: 'a.py',
  line,
  col: 1,
  endCol: 0,
  severity,
  tool: 'pyright',
  rule: 'r',
  message: 'm',
})

test('pyright lines become 1-based and paths relative', async () => {
  const out = JSON.stringify({
    generalDiagnostics: [
      {
        file: '/repo/app/a.py',
        severity: 'error',
        message: 'bad',
        rule: 'reportArgumentType',
        range: { start: { line: 41, character: 4 }, end: { line: 41, character: 8 } },
      },
    ],
  })

  expect(parsePyright(out, '/repo')).toEqual([
    {
      path: 'app/a.py',
      line: 42,
      col: 5,
      endCol: 9,
      severity: 'error',
      tool: 'pyright',
      rule: 'reportArgumentType',
      message: 'bad',
    },
  ])
  expect(parsePyright('not json', '/repo')).toBe(undefined)
})

test('ruff and tsc output parse', async () => {
  const ruff = JSON.stringify([
    { code: 'F401', message: 'unused', filename: '/repo/a.py', location: { row: 2, column: 8 } },
  ])

  expect(parseRuff(ruff, '/repo')?.[0]?.rule).toBe('F401')
  expect(parseTsc("src/a.ts(12,5): error TS2322: Type 'x' is wrong.\nnoise")).toEqual([
    {
      path: 'src/a.ts',
      line: 12,
      col: 5,
      endCol: 0,
      severity: 'error',
      tool: 'tsc',
      rule: 'TS2322',
      message: "Type 'x' is wrong.",
    },
  ])
})

test('files group under their project folder, relative to it', async () => {
  const out = 'frontend/src/a.tsx\tfrontend\nfrontend/src/b.ts\tfrontend\nscript.ts\t.\n'

  expect([...groupByRoot(out)]).toEqual([
    ['frontend', ['src/a.tsx', 'src/b.ts']],
    ['.', ['script.ts']],
  ])
})

test('a diagnostic the base had on the same line text is pre-existing', async () => {
  const head = [diag(5), diag(9), diag(1)].map(one => ({ ...one, path: 'a.py' }))
  const labelled = labelNew(
    [...head, { ...diag(1), path: 'untouched.py' }],
    [{ ...diag(3), path: 'a.py' }],
    { 'a.py': ['', '', '', '', 'x = load()', '', '', '', 'y = load()'] },
    { 'a.py': ['', '', 'x = load()'] },
  )

  // The one that only moved down is old; the others are new; a file the base
  // was not checked for is left unmarked.
  expect(labelled.map(one => one.isNew)).toEqual([false, true, true, undefined])
})

test('terraform validate gives placed diagnostics and unplaced notes', async () => {
  const out = JSON.stringify({
    valid: false,
    diagnostics: [
      {
        severity: 'error',
        summary: 'Invalid default value for variable',
        detail: 'a number is required.',
        range: {
          filename: 'main.tf',
          start: { line: 10, column: 13 },
          end: { line: 10, column: 20 },
        },
      },
      { severity: 'error', summary: 'Missing required provider', detail: 'Run terraform init.' },
    ],
  })

  expect(parseTerraform(out, 'infra')).toEqual({
    diags: [
      {
        path: 'infra/main.tf',
        line: 10,
        col: 13,
        endCol: 20,
        severity: 'error',
        tool: 'terraform',
        rule: '',
        message: 'Invalid default value for variable: a number is required.',
      },
    ],
    notes: ['terraform (infra) is not set up here: run terraform init in infra, then press r'],
  })
  expect(parseTerraform('not json', '.')).toBe(undefined)
})

test('a file waits on the tools of its own language, and on the servers', async () => {
  expect(isCheckable('a.py') && isCheckable('src/a.tsx') && isCheckable('main.tf')).toBe(true)
  expect(isCheckable('README.md')).toBe(false)
  expect(isAwaited('a.py', ['pyright (.)'])).toBe(true)
  expect(isAwaited('a.py', ['tsc (web)', 'eslint (web)'])).toBe(false)
  expect(isAwaited('web/a.ts', ['eslint (web)'])).toBe(true)
  expect(isAwaited('main.tf', ['language servers'])).toBe(true)
  expect(isAwaited('README.md', ['language servers'])).toBe(false)
  expect([...toolsAwaited(['ruff', 'tsc (web)', 'language servers'])]).toEqual([
    'ruff',
    'tsc',
    'pyright',
    'tsserver',
    'terraform-ls',
    'terraform',
  ])
})

test('a tool that could not run says what to do about it', () => {
  expect(explain('ruff', 'sh: uvx: command not found')).toContain('brew install uv')
  expect(explain('pyright (backend)', 'env: node: No such file or directory')).toContain(
    'needs Node',
  )
  expect(explain('tsc (frontend)', 'Error: process timed out')).toContain('took too long')
  expect(explain('eslint (web)', "ESLint couldn't find a configuration file")).toContain(
    'web has no eslint config',
  )
  expect(explain('terraform (.)', 'sh: terraform: command not found')).toContain(
    'brew install terraform',
  )
  // Anything else is the tool's own last words, and the way to silence it.
  expect(explain('ruff', 'boom')).toBe(
    'ruff did not run: boom. Switch it off in /config if this project does not use it',
  )
})

// A bridge whose table is `servers`, each reading one extension.
const bridgeWith =
  (servers: { name: string; extension: string; isInstalled: boolean }[], notes: string[] = []): ServerRun =>
  async argv => ({
    exitCode: 0,
    stdout:
      argv.at(-1) === 'served'
        ? JSON.stringify({
            ok: true,
            servers: servers.map(one => ({
              name: one.name,
              language: one.name.toUpperCase(),
              extensions: [one.extension],
              filenames: [],
              isInstalled: one.isInstalled,
              install: `get ${one.name}`,
            })),
            notes,
          })
        : '/tmp/lens-lsp-501/bridge.py',
    stderr: '',
  })

test('a file of another language is checked when its server is installed and servers are on', async () => {
  const bridge = bridgeWith(
    [
      { name: 'gopls', extension: '.go', isInstalled: true },
      { name: 'clangd', extension: '.c', isInstalled: false },
    ],
    ['servers.json: "x" is ignored: it must be an object'],
  )

  expect(isCheckable('cmd/main.go')).toBe(false)
  expect(await refreshServed(bridge, true)).toEqual(['servers.json: "x" is ignored: it must be an object'])

  expect(isCheckable('cmd/main.go') && hasNameSearch('cmd/main.go')).toBe(true)
  expect(isCheckable('src/a.c') || hasNameSearch('src/a.c') || hasNameSearch('main.tf')).toBe(false)
  expect(isCheckable('a.py') && isCheckable('main.tf')).toBe(true)
  // It waits on the servers, and on no command-line checker.
  expect(isAwaited('cmd/main.go', ['language servers (starting: the first answer can take a minute)'])).toBe(true)
  expect(isAwaited('cmd/main.go', ['ruff', 'pyright (.)', 'tsc (web)', 'terraform (.)'])).toBe(false)
  expect([...toolsAwaited(['language servers'])]).toEqual(['pyright', 'tsserver', 'terraform-ls', 'terraform', 'gopls'])
  expect(uncheckedNotes(['src/a.c', 'src/b.c', 'cmd/main.go', 'a.py'])).toEqual([
    'CLANGD is not checked: clangd is not installed (get clangd)',
  ])

  // With the servers switched off nothing checks it, though it can still be looked up in.
  expect(await refreshServed(bridge, false)).toEqual([])
  expect(isCheckable('cmd/main.go')).toBe(false)
  expect(hasNameSearch('cmd/main.go')).toBe(true)
  expect(uncheckedNotes(['src/a.c'])).toEqual([])
  expect(isCheckable('a.py')).toBe(true)

  await refreshServed(bridgeWith([]), true)
  expect(isCheckable('cmd/main.go') || hasNameSearch('cmd/main.go')).toBe(false)
})
