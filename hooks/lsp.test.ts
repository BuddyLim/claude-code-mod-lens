import { expect, test } from 'claude-code/testing'

import {
  LSP_FILE,
  isOtherServed,
  isServed,
  lspCalls,
  lspDiagnostics,
  lspInlayHints,
  lspOutline,
  lspReferences,
  lspSemanticTokens,
  lspServed,
  lspSymbol,
  lspWorkspaceSymbols,
  parseBridge,
  parseServed,
  parseSymbol,
  servedTools,
  stopLsp,
  toDiag,
  unservedNotes,
  type Run,
} from './lsp'
import { LSP_BRIDGE_PY } from './lsp-bridge'

type Call = { argv: string[]; stdin: string; cwd: string }

// A `run` that answers the install command with the script's path and every
// bridge command with `answer`, and keeps what it was called with.
const fakeRun = (answer: string | (() => never), calls: Call[] = []): Run => {
  return async (argv, init) => {
    calls.push({ argv, stdin: init?.stdin ?? '', cwd: init?.cwd ?? '' })

    if (init?.stdin === LSP_BRIDGE_PY) {
      return { exitCode: 0, stdout: '/tmp/lens-lsp-501/bridge.py', stderr: '' }
    }

    if (typeof answer === 'function') {
      return answer()
    }

    return { exitCode: 0, stdout: answer, stderr: '' }
  }
}

const range = (line: number, from: number, endLine: number, to: number) => ({
  start: { line, character: from },
  end: { line: endLine, character: to },
})

test('a protocol diagnostic becomes 1-based, its end kept on one line', async () => {
  expect(
    toDiag('app/a.py', 'pyright', {
      range: range(10, 21, 10, 25),
      severity: 1,
      code: 'reportArgumentType',
      message: 'Argument of type "str"',
    }),
  ).toEqual({
    path: 'app/a.py',
    line: 11,
    col: 22,
    endCol: 26,
    severity: 'error',
    tool: 'pyright',
    rule: 'reportArgumentType',
    message: 'Argument of type "str"',
  })
})

test('a range that ends on a later line has no end column', async () => {
  expect(toDiag('a.ts', 'tsserver', { range: range(3, 4, 5, 1), message: 'm' }).endCol).toBe(0)
  expect(toDiag('a.ts', 'tsserver', { message: 'm' })).toEqual({
    path: 'a.ts',
    line: 1,
    col: 1,
    endCol: 0,
    severity: 'error',
    tool: 'tsserver',
    rule: '',
    message: 'm',
  })
})

test('severities map to error, warning and info; a numeric code is a rule', async () => {
  const severityOf = (severity: number) => toDiag('a.tf', 'terraform-ls', { severity }).severity

  expect([1, 2, 3, 4, 9].map(severityOf)).toEqual(['error', 'warning', 'info', 'info', 'info'])
  expect(toDiag('a.ts', 'tsserver', { code: 2322 }).rule).toBe('2322')
  expect(toDiag('a.ts', 'tsserver', { code: 'TS2322' }).rule).toBe('TS2322')
})

test('the bridge answer lists what was covered, sorted, with its notes', async () => {
  const out = JSON.stringify({
    ok: true,
    files: {
      'web/b.ts': {
        tool: 'tsserver',
        diagnostics: [
          { range: range(4, 2, 4, 3), severity: 1, code: 'TS2322', message: 'second' },
          { range: range(1, 6, 1, 7), severity: 2, code: 'TS6133', message: 'first' },
        ],
      },
      'app/a.py': { tool: 'pyright', diagnostics: [] },
      'app/c.py': {
        tool: 'pyright',
        diagnostics: [{ range: range(0, 0, 0, 4), severity: 3, code: 'reportX', message: 'c' }],
      },
    },
    notes: ['terraform-ls not installed'],
  })
  const parsed = parseBridge(out)

  expect(parsed.covered).toEqual(['app/a.py', 'app/c.py', 'web/b.ts'])
  expect(parsed.notes).toEqual(['terraform-ls not installed'])
  expect(parsed.diags.map(diag => [diag.path, diag.line, diag.tool, diag.severity])).toEqual([
    ['app/c.py', 1, 'pyright', 'info'],
    ['web/b.ts', 2, 'tsserver', 'warning'],
    ['web/b.ts', 5, 'tsserver', 'error'],
  ])
})

test('an answer that is not the bridge JSON covers nothing and says why', async () => {
  expect(parseBridge('', 'Traceback\nOSError: boom')).toEqual({
    diags: [],
    covered: [],
    notes: ['language servers did not answer: OSError: boom'],
  })
  expect(parseBridge('{"ok": true, "files": {"a.py": {"tool"')).toEqual({
    diags: [],
    covered: [],
    notes: ['language servers did not answer: {"ok": true, "files": {"a.py": {"tool"'],
  })
  expect(parseBridge('{"ok": false, "error": "the bridge daemon did not start"}').notes).toEqual([
    'language servers did not answer: the bridge daemon did not start',
  ])
  expect(parseBridge('null').covered).toEqual([])
})

test('only files a server exists for are asked about', async () => {
  const names = ['a.py', 'b.pyi', 'c.ts', 'd.tsx', 'e.mts', 'f.cts', 'g.tf', 'h.tfvars']

  expect(names.every(name => LSP_FILE.test(name))).toBe(true)
  expect(['a.js', 'README.md', 'py', 'a.tfstate', 'a.pyc'].some(name => LSP_FILE.test(name))).toBe(
    false,
  )

  const calls: Call[] = []
  const none = await lspDiagnostics(fakeRun('{}', calls), '/repo', ['README.md', 'a.js'])

  expect(none).toEqual({ diags: [], covered: [], notes: [] })
  expect(calls.length).toBe(0)
})

test('a query writes the script, then sends the request to its client', async () => {
  const calls: Call[] = []
  const out = JSON.stringify({
    ok: true,
    files: {
      'app/a.py': {
        tool: 'pyright',
        diagnostics: [{ range: range(2, 0, 2, 3), severity: 1, code: 'reportX', message: 'bad' }],
      },
    },
    notes: ['terraform-ls not installed'],
  })
  const found = await lspDiagnostics(
    fakeRun(out, calls),
    '/repo',
    ['app/a.py', 'infra/main.tf', 'README.md'],
    { envRoot: '/work', timeoutMs: 30_000 },
  )

  expect(found.covered).toEqual(['app/a.py'])
  expect(found.notes).toEqual(['terraform-ls not installed'])
  expect(found.diags).toEqual([
    {
      path: 'app/a.py',
      line: 3,
      col: 1,
      endCol: 4,
      severity: 'error',
      tool: 'pyright',
      rule: 'reportX',
      message: 'bad',
    },
  ])

  const query = calls.find(call => call.argv.at(-1) === 'query')

  expect(calls.some(call => call.stdin === LSP_BRIDGE_PY)).toBe(true)
  expect(query?.argv.at(-2)).toBe('/tmp/lens-lsp-501/bridge.py')
  expect(query?.cwd).toBe('/tmp/lens-lsp-501')
  expect(JSON.parse(query?.stdin ?? '{}')).toEqual({
    repo: '/repo',
    files: ['app/a.py', 'infra/main.tf'],
    envRoot: '/work',
    timeout: 30,
  })
})

test('a bridge that cannot run covers nothing, so every file falls back', async () => {
  const thrown = await lspDiagnostics(
    fakeRun(() => {
      throw new Error('timed out after 165000 ms')
    }),
    '/repo',
    ['a.py'],
  )

  expect(thrown).toEqual({
    diags: [],
    covered: [],
    notes: ['language servers did not answer: timed out after 165000 ms'],
  })

  const noPython: Run = async (_argv, init) =>
    init?.stdin === LSP_BRIDGE_PY
      ? { exitCode: 0, stdout: '/tmp/lens-lsp-501/bridge.py', stderr: '' }
      : { exitCode: 127, stdout: '', stderr: 'sh: python3: command not found\n' }

  expect((await lspDiagnostics(noPython, '/repo', ['a.ts'])).notes).toEqual([
    'language servers did not answer: sh: python3: command not found',
  ])
})

test('stopping names the tree whose servers go, or nothing for the daemon', async () => {
  const calls: Call[] = []
  const run = fakeRun('{"ok": true}', calls)

  await stopLsp(run, '/tmp/export')
  await stopLsp(run)

  const stops = calls.filter(call => call.argv.at(-1) === 'stop').map(call => call.stdin)

  expect(stops).toEqual(['{"root":"/tmp/export"}', '{}'])
})

test('the embedded script holds nothing a raw template would trip on', async () => {
  expect(LSP_BRIDGE_PY.includes('def main():')).toBe(true)
  expect(LSP_BRIDGE_PY.includes('\\n')).toBe(true)
})

test('a symbol answer keeps its text, its notes and a whole definition', async () => {
  const inRepo = { path: 'app/a.py', line: 22, col: 5, isInRepo: true }

  expect(
    parseSymbol(
      JSON.stringify({ ok: true, text: 'def total() -> int', definition: inRepo, notes: [] }),
    ),
  ).toEqual({ text: 'def total() -> int', definition: inRepo, notes: [] })

  const outside = parseSymbol(
    JSON.stringify({
      ok: true,
      text: '(module) json',
      definition: { path: '/lib/json/__init__.pyi', line: 1, col: 1, isInRepo: false },
      notes: [],
      tool: 'pyright',
    }),
  )

  expect(outside.definition).toEqual({
    path: '/lib/json/__init__.pyi',
    line: 1,
    col: 1,
    isInRepo: false,
  })

  // Nothing at the place: no text, no definition, and no note either.
  expect(parseSymbol('{"ok": true, "text": "", "notes": []}')).toEqual({ text: '', notes: [] })
  // A definition with a part missing is left out.
  expect(
    parseSymbol('{"ok": true, "text": "x", "definition": {"path": "a.ts", "line": 0}}'),
  ).toEqual({ text: 'x', notes: [] })
  expect(parseSymbol('{"ok": true, "text": "", "notes": ["terraform-ls not installed"]}')).toEqual({
    text: '',
    notes: ['terraform-ls not installed'],
  })
})

test('a symbol answer that is not the bridge JSON has no text and one note', async () => {
  expect(parseSymbol('', 'Traceback\nOSError: boom')).toEqual({
    text: '',
    notes: ['language server did not answer: OSError: boom'],
  })
  expect(parseSymbol('{"ok": false, "error": "the bridge daemon did not start"}')).toEqual({
    text: '',
    notes: ['language server did not answer: the bridge daemon did not start'],
  })
  expect(parseSymbol('null').notes.length).toBe(1)
})

test('a symbol lookup sends its place to the client, and only for a known language', async () => {
  const calls: Call[] = []
  const out = JSON.stringify({
    ok: true,
    text: 'function describe(expense: Expense): string',
    definition: { path: 'web/a.tsx', line: 15, col: 10, isInRepo: true },
    notes: [],
  })
  const found = await lspSymbol(fakeRun(out, calls), '/repo', 'web/a.tsx', 35, 55, {
    envRoot: '/work',
    timeoutMs: 5_000,
  })

  expect(found).toEqual({
    text: 'function describe(expense: Expense): string',
    definition: { path: 'web/a.tsx', line: 15, col: 10, isInRepo: true },
    notes: [],
  })

  const asked = calls.find(call => call.argv.at(-1) === 'symbol')

  expect(asked?.argv.at(-2)).toBe('/tmp/lens-lsp-501/bridge.py')
  expect(JSON.parse(asked?.stdin ?? '{}')).toEqual({
    repo: '/repo',
    file: 'web/a.tsx',
    line: 35,
    col: 55,
    envRoot: '/work',
    timeout: 5,
  })

  const none: Call[] = []

  expect(await lspSymbol(fakeRun(out, none), '/repo', 'README.md', 1, 1)).toEqual({
    text: '',
    notes: ['no language server for this kind of file'],
  })
  expect(none.length).toBe(0)
})

test('a symbol lookup never rejects', async () => {
  const thrown = await lspSymbol(
    fakeRun(() => {
      throw new Error('timed out after 75000 ms')
    }),
    '/repo',
    'a.py',
    1,
    1,
  )

  expect(thrown).toEqual({
    text: '',
    notes: ['language server did not answer: timed out after 75000 ms'],
  })

  const noInstall: Run = async () => ({ exitCode: 1, stdout: '', stderr: 'mkdir: denied\n' })

  expect(await lspSymbol(noInstall, '/repo', 'a.ts', 1, 1)).toEqual({
    text: '',
    notes: ['language server did not answer: could not write the bridge script: mkdir: denied'],
  })
})

test('the embedded script answers symbol requests', async () => {
  expect(LSP_BRIDGE_PY.includes('def symbol(self, request):')).toBe(true)
  expect(LSP_BRIDGE_PY.includes('elif mode == "symbol":')).toBe(true)
})

test('a diagnostic tagged as unnecessary code is unused; no other gains the field', async () => {
  const unread = toDiag('a.py', 'pyright', {
    range: range(3, 7, 3, 9),
    severity: 4,
    message: '"os" is not accessed',
    tags: [1],
  })

  expect(unread.isUnused).toBe(true)
  expect(unread.severity).toBe('info')
  expect('isUnused' in toDiag('a.py', 'pyright', { message: 'm', tags: [2] })).toBe(false)
  expect('isUnused' in toDiag('a.py', 'pyright', { message: 'm', tags: [] })).toBe(false)

  const parsed = parseBridge(
    JSON.stringify({
      ok: true,
      files: {
        'a.tsx': {
          tool: 'tsserver',
          diagnostics: [
            { range: range(21, 6, 21, 12), severity: 1, code: 'TS6133', message: 'u', tags: [1] },
            { range: range(25, 16, 25, 23), severity: 1, code: 'TS2345', message: 'v' },
          ],
        },
      },
    }),
  )

  expect(parsed.diags.map(diag => [diag.rule, diag.isUnused])).toEqual([
    ['TS6133', true],
    ['TS2345', undefined],
  ])
})

test('a symbol answer keeps a whole signature, type and implementations', async () => {
  const signature = {
    label: 'total(expenses: Expense[]): number',
    parameters: ['expenses: Expense[]'],
    active: 0,
    docs: '',
  }
  const type = { path: 'web/a.tsx', line: 4, col: 16, isInRepo: true }
  const made = { path: '/lib/b.ts', line: 9, col: 3, isInRepo: false }
  const found = parseSymbol(
    JSON.stringify({
      ok: true,
      text: '(parameter) expenses: Expense[]',
      notes: [],
      signature,
      typeDefinition: type,
      implementations: [made, { path: 'c.ts', line: 0, col: 1 }, 'x'],
    }),
  )

  expect(found).toEqual({
    text: '(parameter) expenses: Expense[]',
    notes: [],
    signature,
    typeDefinition: type,
    implementations: [made],
  })

  // Past the last parameter, or not a number: no parameter is active.
  const past = parseSymbol(
    JSON.stringify({ ok: true, text: '', signature: { ...signature, active: 1 }, notes: [] }),
  )

  expect(past.signature?.active).toBe(-1)

  // Parts that are not whole are left out, as when the server sent none.
  expect(
    parseSymbol(
      JSON.stringify({
        ok: true,
        text: 'x',
        notes: [],
        signature: { parameters: [] },
        typeDefinition: { path: 'a.ts', line: 1 },
        implementations: [],
      }),
    ),
  ).toEqual({ text: 'x', notes: [] })
})

test('references send their place and keep each whole place with its text', async () => {
  const calls: Call[] = []
  const out = JSON.stringify({
    ok: true,
    notes: ['showing the first 1000 of 1083 references'],
    total: 1083,
    places: [
      { path: 'app/a.py', line: 82, col: 7, isInRepo: true, text: 'class PaceCandidate:' },
      { path: '/lib/b.pyi', line: 3, col: 1, isInRepo: false },
      { path: 'app/c.py', line: 0, col: 1, isInRepo: true, text: 'not a place' },
    ],
  })
  const found = await lspReferences(fakeRun(out, calls), '/repo', 'app/a.py', 82, 7, {
    envRoot: '/work',
    timeoutMs: 5_000,
  })

  expect(found).toEqual({
    places: [
      { path: 'app/a.py', line: 82, col: 7, isInRepo: true, text: 'class PaceCandidate:' },
      { path: '/lib/b.pyi', line: 3, col: 1, isInRepo: false, text: '' },
    ],
    notes: ['showing the first 1000 of 1083 references'],
  })

  const asked = calls.find(call => call.argv.at(-1) === 'ask')

  expect(asked?.argv.at(-2)).toBe('/tmp/lens-lsp-501/bridge.py')
  expect(JSON.parse(asked?.stdin ?? '{}')).toEqual({
    what: 'references',
    repo: '/repo',
    file: 'app/a.py',
    line: 82,
    col: 7,
    envRoot: '/work',
    timeout: 5,
  })
})

test('callers and callees come back as nodes, in the direction asked for', async () => {
  const calls: Call[] = []
  const place = { path: 'app/a.py', line: 917, col: 5, isInRepo: true }
  const out = JSON.stringify({
    ok: true,
    notes: [],
    calls: [
      { name: 'persist', kind: 'function', place, detail: '(a.py)' },
      { name: 'no place', kind: 'function', detail: '' },
    ],
  })
  const found = await lspCalls(fakeRun(out, calls), '/repo', 'app/a.py', 366, 5, 'incoming')

  expect(found).toEqual({
    calls: [{ name: 'persist', kind: 'function', place, detail: '(a.py)' }],
    notes: [],
  })
  expect(JSON.parse(calls.find(call => call.argv.at(-1) === 'ask')?.stdin ?? '{}')).toEqual({
    what: 'calls',
    repo: '/repo',
    file: 'app/a.py',
    line: 366,
    col: 5,
    direction: 'incoming',
    timeout: 30,
  })
})

test('an outline keeps the entries that are whole, in the order sent', async () => {
  const out = JSON.stringify({
    ok: true,
    notes: [],
    items: [
      { name: 'Expense', kind: 'class', line: 9, endLine: 13, col: 1, depth: 0 },
      { name: 'amount', kind: 'variable', line: 11, endLine: 11, col: 5, depth: 1 },
      { name: 'broken', kind: 'variable', line: 11, col: 5, depth: 1 },
    ],
  })
  const calls: Call[] = []
  const found = await lspOutline(fakeRun(out, calls), '/repo', 'app/a.py')

  expect(found.notes).toEqual([])
  expect(found.items).toEqual([
    { name: 'Expense', kind: 'class', line: 9, endLine: 13, col: 1, depth: 0 },
    { name: 'amount', kind: 'variable', line: 11, endLine: 11, col: 5, depth: 1 },
  ])
  expect(JSON.parse(calls.find(call => call.argv.at(-1) === 'ask')?.stdin ?? '{}')).toEqual({
    what: 'outline',
    repo: '/repo',
    file: 'app/a.py',
    timeout: 30,
  })
})

test('semantic tokens are decoded against the legend the bridge sends', async () => {
  const out = JSON.stringify({
    ok: true,
    notes: [],
    types: ['class', 'parameter', 'variable'],
    modifiers: ['declaration', 'static', 'async', 'readonly'],
    rows: [
      [4, 6, 7, 0, 1],
      [10, 16, 8, 1, 0],
      [21, 9, 8, 2, 9],
      [22, 1, 3, 7, 0],
      [0, 1, 3, 1, 0],
      'x',
    ],
  })
  const found = await lspSemanticTokens(fakeRun(out), '/repo', 'web/a.tsx')

  expect(found).toEqual({
    tokens: [
      { line: 4, col: 6, length: 7, type: 'class', modifiers: ['declaration'] },
      { line: 10, col: 16, length: 8, type: 'parameter', modifiers: [] },
      { line: 21, col: 9, length: 8, type: 'variable', modifiers: ['declaration', 'readonly'] },
    ],
    notes: [],
  })

  // A server without them: nothing, and the bridge's note.
  const none = JSON.stringify({
    ok: true,
    notes: ['pyright does not offer semantic tokens'],
    types: [],
    modifiers: [],
    rows: [],
  })

  expect(await lspSemanticTokens(fakeRun(none), '/repo', 'a.py')).toEqual({
    tokens: [],
    notes: ['pyright does not offer semantic tokens'],
  })
})

test('a search by name is sent with the file that picks the project, and a limit', async () => {
  const calls: Call[] = []
  const place = { path: 'web/src/client.ts', line: 4, col: 14, isInRepo: true }
  const out = JSON.stringify({
    ok: true,
    notes: [],
    hits: [{ name: 'ApiError', kind: 'class', container: '', place }, { name: 'lost' }],
  })
  const found = await lspWorkspaceSymbols(fakeRun(out, calls), '/repo', 'ApiError', 'web/src/a.tsx')

  expect(found).toEqual({
    hits: [{ name: 'ApiError', kind: 'class', container: '', place }],
    notes: [],
  })

  await lspWorkspaceSymbols(fakeRun(out, calls), '/repo', 'Api', 'web/src/a.tsx', { limit: 5 })

  const asked = calls.filter(call => call.argv.at(-1) === 'ask').map(call => JSON.parse(call.stdin))

  expect(asked).toEqual([
    { what: 'symbols', repo: '/repo', near: 'web/src/a.tsx', query: 'ApiError', limit: 50, timeout: 30 },
    { what: 'symbols', repo: '/repo', near: 'web/src/a.tsx', query: 'Api', limit: 5, timeout: 30 },
  ])
})

test('inlay hints keep their place, label and kind; an unknown kind is other', async () => {
  const calls: Call[] = []
  const out = JSON.stringify({
    ok: true,
    notes: [],
    hints: [
      { line: 21, col: 60, label: 'initialState: ', kind: 'parameter' },
      { line: 22, col: 13, label: ': number', kind: 'type' },
      { line: 30, col: 4, label: '= 1', kind: 'enum' },
      { line: 0, col: 4, label: 'lost', kind: 'type' },
    ],
  })
  const found = await lspInlayHints(fakeRun(out, calls), '/repo', 'web/a.tsx', 20, 30)

  expect(found).toEqual({
    hints: [
      { line: 21, col: 60, label: 'initialState: ', kind: 'parameter' },
      { line: 22, col: 13, label: ': number', kind: 'type' },
      { line: 30, col: 4, label: '= 1', kind: 'other' },
    ],
    notes: [],
  })
  expect(JSON.parse(calls.find(call => call.argv.at(-1) === 'ask')?.stdin ?? '{}')).toEqual({
    what: 'hints',
    repo: '/repo',
    file: 'web/a.tsx',
    fromLine: 20,
    toLine: 30,
    timeout: 30,
  })
})

test('the lookups never reject: any failure is an empty result and one note', async () => {
  const thrown = fakeRun(() => {
    throw new Error('timed out after 75000 ms')
  })
  const note = ['language server did not answer: timed out after 75000 ms']

  expect(await lspReferences(thrown, '/repo', 'a.py', 1, 1)).toEqual({ places: [], notes: note })
  expect(await lspCalls(thrown, '/repo', 'a.py', 1, 1, 'outgoing')).toEqual({
    calls: [],
    notes: note,
  })
  expect(await lspOutline(thrown, '/repo', 'a.py')).toEqual({ items: [], notes: note })
  expect(await lspSemanticTokens(thrown, '/repo', 'a.ts')).toEqual({ tokens: [], notes: note })
  expect(await lspWorkspaceSymbols(thrown, '/repo', 'x', 'a.ts')).toEqual({ hits: [], notes: note })
  expect(await lspInlayHints(thrown, '/repo', 'a.ts', 1, 9)).toEqual({ hints: [], notes: note })

  // Not the bridge's JSON, or its refusal.
  expect(await lspOutline(fakeRun('Traceback'), '/repo', 'a.py')).toEqual({
    items: [],
    notes: ['language server did not answer: Traceback'],
  })
  expect(await lspOutline(fakeRun('{"ok": false, "error": "boom"}'), '/repo', 'a.py')).toEqual({
    items: [],
    notes: ['language server did not answer: boom'],
  })

  // The bridge answered that there is nothing to give: its note, as it is.
  const missing = '{"ok": true, "notes": ["terraform-ls not installed"]}'

  expect(await lspReferences(fakeRun(missing), '/repo', 'main.tf', 1, 1)).toEqual({
    places: [],
    notes: ['terraform-ls not installed'],
  })

  // No server for the kind of file: nothing is run.
  const calls: Call[] = []
  const none = ['no language server for this kind of file']

  expect(await lspOutline(fakeRun('{}', calls), '/repo', 'README.md')).toEqual({
    items: [],
    notes: none,
  })
  expect(await lspWorkspaceSymbols(fakeRun('{}', calls), '/repo', 'x', 'README.md')).toEqual({
    hits: [],
    notes: none,
  })
  expect(calls.length).toBe(0)
})

test('the embedded script answers the lookups', async () => {
  expect(LSP_BRIDGE_PY.includes('def ask(self, request):')).toBe(true)
  expect(LSP_BRIDGE_PY.includes('elif mode == "ask":')).toBe(true)
  expect(LSP_BRIDGE_PY.includes('encodedSemanticClassifications-full')).toBe(true)
})

// The bridge's table with Go installed, and C# and Pulumi YAML known but not.
const TABLE = JSON.stringify({
  ok: true,
  servers: [
    { name: 'gopls', language: 'Go', extensions: ['.go'], filenames: [], isInstalled: true, install: 'go install gopls' },
    { name: 'csharp-ls', language: 'C#', extensions: ['.cs'], filenames: [], isInstalled: false, install: 'dotnet tool install --global csharp-ls' },
    { name: 'pulumi-lsp', language: 'Pulumi YAML', extensions: [], filenames: ['Pulumi.yaml', 'Pulumi.*.yaml'], isInstalled: false, install: '' },
    { name: 'yaml-ls', language: 'YAML', extensions: ['.yaml'], filenames: [], isInstalled: true, install: '' },
  ],
  notes: ['servers.json: "broken" is ignored: it needs a "command"'],
})
const NO_TABLE = '{"ok": true, "servers": [], "notes": []}'

test('the table the bridge lists says which other files a server reads', async () => {
  // Before any answer: Python, TypeScript and Terraform, as ever.
  expect(isServed('a.py') && isServed('b.tsx') && isServed('c.tf')).toBe(true)
  expect(isServed('cmd/main.go')).toBe(false)
  expect(servedTools()).toEqual([])

  const calls: Call[] = []

  expect(await lspServed(fakeRun(TABLE, calls))).toEqual([
    'servers.json: "broken" is ignored: it needs a "command"',
  ])
  expect(calls.at(-1)?.argv.slice(-2)).toEqual(['/tmp/lens-lsp-501/bridge.py', 'served'])

  expect(isServed('cmd/main.go') && isServed('cmd/MAIN.GO') && isOtherServed('cmd/main.go')).toBe(true)
  expect(isServed('a.py') && !isOtherServed('a.py')).toBe(true)
  // Known to the table, and not installed: not served.
  expect(isServed('app/Program.cs')).toBe(false)
  expect(isServed('README.md') || isServed('go') || isServed('main.gox')).toBe(false)
  // A whole name counts before an extension, unless only the extension's server is installed.
  expect(isServed('infra/Pulumi.dev.yaml') && isServed('infra/other.yaml')).toBe(true)
  expect(servedTools()).toEqual(['gopls', 'yaml-ls'])
  expect(unservedNotes(['app/Program.cs', 'app/Other.cs', 'cmd/main.go', 'README.md', 'a.py'])).toEqual([
    'C# is not checked: csharp-ls is not installed (dotnet tool install --global csharp-ls)',
  ])

  // The files it reads are now asked about, and looked up in.
  const asked: Call[] = []
  const out = '{"ok": true, "files": {"cmd/main.go": {"tool": "gopls", "diagnostics": [{"message": "m"}]}}}'
  const found = await lspDiagnostics(fakeRun(out, asked), '/repo', ['cmd/main.go', 'app/Program.cs', 'a.md'])

  expect(JSON.parse(asked.at(-1)?.stdin ?? '{}').files).toEqual(['cmd/main.go'])
  expect(found.diags.map(diag => [diag.path, diag.tool, diag.message])).toEqual([['cmd/main.go', 'gopls', 'm']])
  expect((await lspSymbol(fakeRun('{"ok": true, "text": "func main()"}'), '/repo', 'cmd/main.go', 1, 1)).text).toBe(
    'func main()',
  )
  expect((await lspOutline(fakeRun('{}'), '/repo', 'app/Program.cs')).notes).toEqual([
    'no language server for this kind of file',
  ])

  // A bridge that cannot answer leaves the table as it was.
  expect(await lspServed(fakeRun('Traceback'))).toEqual([])
  expect(await lspServed(fakeRun('{"ok": false, "error": "boom"}'))).toEqual([])
  expect(await lspServed(fakeRun(() => { throw new Error('boom') }))).toEqual([])
  expect(isServed('cmd/main.go')).toBe(true)

  expect(await lspServed(fakeRun(NO_TABLE))).toEqual([])
  expect(isServed('cmd/main.go')).toBe(false)
})

test('a table answer keeps the servers that are whole', async () => {
  expect(parseServed('not json')).toBe(undefined)
  expect(parseServed('{"ok": true}')).toBe(undefined)
  expect(
    parseServed(
      JSON.stringify({
        ok: true,
        servers: [null, 'x', { name: '' }, { name: 'zls', extensions: ['.ZIG', 3], isInstalled: 'yes' }],
        notes: ['a', 3],
      }),
    ),
  ).toEqual({
    servers: [{ name: 'zls', language: 'zls', extensions: ['.zig'], filenames: [], isInstalled: false, install: '' }],
    notes: ['a'],
  })
})

test('the embedded script holds the table of servers and its config file', async () => {
  expect(LSP_BRIDGE_PY.includes('elif mode == "served":')).toBe(true)
  expect(LSP_BRIDGE_PY.includes('"~/.claude/lens/servers.json"')).toBe(true)

  for (const name of ['pyright', 'tsserver', 'terraform-ls', 'clangd', 'csharp-ls', 'gopls', 'rust-analyzer', 'pulumi-lsp']) {
    expect(LSP_BRIDGE_PY.includes(`    "${name}": {`)).toBe(true)
  }
})
