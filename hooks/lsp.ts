// Diagnostics, symbol lookups and the other things an editor asks of its
// language server (references, callers, outline, semantic tokens, a search by
// name, inlay hints), from long-running language servers, through
// the bridge in lsp-bridge.ts. Nothing here touches the engine: the caller hands in `run`
// (its `$.process.run`), and every call is one short-lived command. The first
// call writes the bridge script to a temp folder; the script's client mode
// starts the daemon when it is not running, and the daemon keeps one server
// per language and project until it has been idle for half an hour.
import type { Diag, Severity } from '../types'
import { LSP_BRIDGE_PY } from './lsp-bridge'
import type {
  CallNode,
  InlayHint,
  OutlineItem,
  Place,
  PlaceLine,
  SemanticToken,
  Signature,
  SymbolHit,
} from './lsp-types'

export type Run = (
  argv: string[],
  init?: { cwd?: string; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type LspOptions = {
  // Where a project's virtualenv and node_modules are looked for when `repo`
  // has none: the working tree, when `repo` is an export of a commit. The
  // project's folder is the same path under it.
  envRoot?: string
  // How long the servers may take to answer, in milliseconds (two minutes).
  timeoutMs?: number
}

export type LspResult = {
  diags: Diag[]
  // The files a server answered for; the rest still need another checker.
  covered: string[]
  // Why a language's server could not be used, one line each.
  notes: string[]
}

// A diagnostic as the Language Server Protocol spells it: 0-based positions,
// the end exclusive.
export type LspDiagnostic = {
  range?: {
    start?: { line?: number; character?: number }
    end?: { line?: number; character?: number }
  }
  severity?: number
  code?: string | number
  message?: string
  // 1 is DiagnosticTag.Unnecessary: code that is never used.
  tags?: number[]
}

type BridgeAnswer = {
  ok?: boolean
  error?: string
  files?: Record<string, { tool?: string; diagnostics?: LspDiagnostic[] }>
  notes?: string[]
}

// The files the bridge has a server for whatever else is installed: Python,
// TypeScript and Terraform. `isServed` adds what its table of servers reads.
export const LSP_FILE = /\.(pyi?|[cm]?tsx?|tf|tfvars)$/i

// One server of the bridge's table (the built-in ones, and the person's own
// from ~/.claude/lens/servers.json), as its `served` answer lists them.
export type ServedBy = {
  // Also the tool its diagnostics carry.
  name: string
  // What a person calls the language, for a note.
  language: string
  // In lower case, each with its dot.
  extensions: string[]
  // Whole file names, `*` and `?` standing for anything.
  filenames: string[]
  isInstalled: boolean
  // How to get the server; '' when the table does not say.
  install: string
}

// The table as the bridge last listed it, in the order a file is matched.
// The screens ask about a file as they draw, with nothing to await, so the
// answer is kept here and a scan asks again (`lspServed`). Empty until the
// first answer: `LSP_FILE` alone is then what is served, as it was before
// there was a table.
let table: { server: ServedBy; names: RegExp[] }[] = []

// A whole file name with `*` and `?` in it, as the bridge reads one.
const namePattern = (name: string): RegExp =>
  new RegExp(
    `^${name
      .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  )

// The server that reads a file, as the bridge picks it: one that is installed
// before one that is not, a file's whole name before its extension.
const serverOf = (path: string): ServedBy | undefined => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lower = name.toLowerCase()

  for (const group of [table.filter(one => one.server.isInstalled), table]) {
    const found =
      group.find(one => one.names.some(pattern => pattern.test(name))) ??
      group.find(one => one.server.extensions.some(extension => lower.endsWith(extension)))

    if (found !== undefined) {
      return found.server
    }
  }

  return undefined
}

// Whether a file that is not Python, TypeScript or Terraform is read by a
// server of the table that is installed.
export const isOtherServed = (path: string): boolean =>
  !LSP_FILE.test(path) && serverOf(path)?.isInstalled === true

// Whether the bridge has a server for a file.
export const isServed = (path: string): boolean => LSP_FILE.test(path) || isOtherServed(path)

// The names of the table's installed servers: the tools their diagnostics carry.
export const servedTools = (): string[] =>
  table.filter(one => one.server.isInstalled).map(one => one.server.name)

// For the files a server of the table would read were it installed: one line
// for each such server, saying what to install.
export const unservedNotes = (paths: readonly string[]): string[] => {
  const notes = new Set<string>()

  for (const path of paths) {
    const server = LSP_FILE.test(path) ? undefined : serverOf(path)

    if (server !== undefined && !server.isInstalled) {
      notes.add(
        `${server.language} is not checked: ${server.name} is not installed${server.install === '' ? '' : ` (${server.install})`}`,
      )
    }
  }

  return [...notes]
}

// DiagnosticTag.Unnecessary.
const UNNECESSARY = 1

const SEVERITY: Record<number, Severity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' }

// One protocol diagnostic of `path`, as the pane keeps them: 1-based, and
// `endCol` only when the range ends on the line it starts on.
export const toDiag = (path: string, tool: string, item: LspDiagnostic): Diag => {
  const start = item.range?.start
  const end = item.range?.end
  const line = start?.line ?? 0

  const diag: Diag = {
    path,
    line: line + 1,
    col: (start?.character ?? 0) + 1,
    endCol: end?.line === line && end.character !== undefined ? end.character + 1 : 0,
    severity: SEVERITY[item.severity ?? 1] ?? 'info',
    tool,
    rule: item.code === undefined ? '' : String(item.code),
    message: item.message ?? '',
  }

  if (Array.isArray(item.tags) && item.tags.includes(UNNECESSARY)) {
    diag.isUnused = true
  }

  return diag
}

const byPlace = (a: Diag, b: Diag): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col

const failed = (why: string): LspResult => ({
  diags: [],
  covered: [],
  notes: [`language servers did not answer: ${why}`],
})

const lastLine = (text: string): string => text.trim().split('\n').pop()?.slice(0, 200) ?? ''

// What the bridge's client printed, as diagnostics. Anything but its JSON
// answer (the command failed, or its output was cut) covers no file and says
// why in a note, so every file falls back to the other checkers.
export const parseBridge = (stdout: string, stderr = ''): LspResult => {
  let answer: BridgeAnswer | undefined

  try {
    answer = JSON.parse(stdout) as BridgeAnswer
  } catch {
    answer = undefined
  }

  if (answer === undefined || answer === null || typeof answer !== 'object') {
    return failed(lastLine(stderr) || lastLine(stdout) || 'no output')
  }

  if (answer.ok !== true) {
    return failed(answer.error ?? 'no reason given')
  }

  const diags: Diag[] = []
  const covered: string[] = []

  for (const [path, file] of Object.entries(answer.files ?? {})) {
    covered.push(path)

    for (const item of file.diagnostics ?? []) {
      diags.push(toDiag(path, file.tool ?? '', item))
    }
  }

  return {
    diags: diags.sort(byPlace),
    covered: covered.sort(),
    notes: (answer.notes ?? []).map(String),
  }
}

// Writes the script on stdin to this user's bridge folder (the socket, lock
// and log live beside it) and prints its path. Written under another name
// first, so a client never reads half a script.
const INSTALL = [
  'd="/tmp/lens-lsp-$(id -u)"',
  'mkdir -p -m 700 "$d" && [ -O "$d" ] || exit 1',
  'cat > "$d/bridge.py.$$" && mv "$d/bridge.py.$$" "$d/bridge.py" && printf %s "$d/bridge.py"',
].join('\n')

// uv picks a Python whatever the folder pins; the system's is the fallback.
const PYTHON =
  'command -v uv >/dev/null 2>&1 && exec uv run --no-project python "$@"; exec python3 "$@"'

// The script's path, per `run` it was written with: a caller that keeps one
// `run` writes the script once per load of the module, and one that makes a
// new `run` each time writes it each time (a few milliseconds). A script that
// differs from the one a running daemon was started from makes the client
// replace that daemon, so an update takes effect on the next call.
const installed = new WeakMap<Run, Promise<string>>()

const install = (run: Run): Promise<string> => {
  const known = installed.get(run)

  if (known !== undefined) {
    return known
  }

  const writing = run(['sh', '-c', INSTALL], { stdin: LSP_BRIDGE_PY, timeoutMs: 10_000 }).then(
    ran => {
      const path = ran.stdout.trim()

      if (ran.exitCode !== 0 || !path.endsWith('/bridge.py')) {
        throw new Error(`could not write the bridge script: ${lastLine(ran.stderr) || 'no output'}`)
      }

      return path
    },
  )
  installed.set(run, writing)
  // A failure is not remembered: the next call tries again.
  writing.catch(() => {
    installed.delete(run)
  })

  return writing
}

const bridge = async (
  run: Run,
  mode: 'query' | 'symbol' | 'ask' | 'served' | 'stop',
  request: object,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const script = await install(run)

  return run(['sh', '-c', PYTHON, 'sh', script, mode], {
    cwd: script.slice(0, script.lastIndexOf('/')),
    stdin: JSON.stringify(request),
    timeoutMs,
  })
}

// Diagnostics for `files` (paths relative to `repo`, an absolute real path)
// from the language servers that cover them. Never rejects: a bridge that
// cannot run covers nothing and says why in `notes`.
export const lspDiagnostics = async (
  run: Run,
  repo: string,
  files: readonly string[],
  options: LspOptions = {},
): Promise<LspResult> => {
  const wanted = files.filter(isServed)

  if (wanted.length === 0) {
    return { diags: [], covered: [], notes: [] }
  }

  const timeoutMs = options.timeoutMs ?? 120_000

  try {
    const ran = await bridge(
      run,
      'query',
      { repo, files: wanted, envRoot: options.envRoot, timeout: timeoutMs / 1000 },
      // The client gives the daemon a little longer than the servers get.
      Math.min(timeoutMs + 45_000, 600_000),
    )

    return parseBridge(ran.stdout, ran.stderr)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []

// What the bridge's client printed for `served`: its table and its notes, or
// undefined for anything but its JSON answer.
export const parseServed = (stdout: string): { servers: ServedBy[]; notes: string[] } | undefined => {
  let answer: { ok?: unknown; servers?: unknown; notes?: unknown } | null | undefined

  try {
    answer = JSON.parse(stdout) as typeof answer
  } catch {
    answer = undefined
  }

  if (answer === undefined || answer === null || answer.ok !== true || !Array.isArray(answer.servers)) {
    return undefined
  }

  const servers: ServedBy[] = []

  for (const one of answer.servers as Partial<Record<keyof ServedBy, unknown>>[]) {
    if (one !== null && typeof one === 'object' && typeof one.name === 'string' && one.name !== '') {
      servers.push({
        name: one.name,
        language: typeof one.language === 'string' && one.language !== '' ? one.language : one.name,
        extensions: stringsOf(one.extensions).map(extension => extension.toLowerCase()),
        filenames: stringsOf(one.filenames),
        isInstalled: one.isInstalled === true,
        install: typeof one.install === 'string' ? one.install : '',
      })
    }
  }

  return { servers, notes: stringsOf(answer.notes) }
}

// Asks the bridge for its table of servers and keeps it, for `isServed` and
// the rest above to answer from. Resolves with what is wrong with the
// person's config file, one line for each entry left out. Never rejects: a
// bridge that cannot answer leaves the table as it was, and says nothing
// (the next thing asked of it says why).
export const lspServed = async (run: Run): Promise<string[]> => {
  try {
    const answer = parseServed((await bridge(run, 'served', {}, 20_000)).stdout)

    if (answer === undefined) {
      return []
    }

    table = answer.servers.map(server => ({ server, names: server.filenames.map(namePattern) }))

    return answer.notes
  } catch {
    return []
  }
}

// Whether the servers' keeper is already up: one that is not has to start,
// and its servers with it, before the first answer comes.
export const lspIsRunning = async (run: Run): Promise<boolean> =>
  run(['sh', '-c', 'test -S "/tmp/lens-lsp-$(id -u)/bridge.sock"'], { timeoutMs: 5000 }).then(
    ran => ran.exitCode === 0,
    () => false,
  )

// Stops the servers of the projects at or under `root` (an export that is
// about to be deleted), or, with no root, the daemon and every server. A
// daemon that is not running is left that way.
export const stopLsp = async (run: Run, root?: string): Promise<void> => {
  try {
    await bridge(run, 'stop', root === undefined ? {} : { root }, 40_000)
  } catch {
    // Nothing to stop, or nothing to stop it with.
  }
}

// What a language server knows about the symbol at one place.
export type LspSymbol = {
  // Plain text: the signature or type as the server writes it, then a blank
  // line and the docs when there are any. '' when the server has nothing.
  text: string
  // Where the symbol is declared, when the server can say: 1-based, and
  // `path` relative to the repo when it is inside it, else absolute.
  definition?: { path: string; line: number; col: number; isInRepo: boolean }
  // The call the place is inside the arguments of, when it is in one.
  signature?: Signature
  // Where the symbol's type is declared, when that is not `definition`.
  typeDefinition?: Place
  // What implements it, for an interface, an abstract method or a protocol
  // (at most 50). Left out when the server knows of none.
  implementations?: Place[]
  // Why nothing came back: no server for the language, not installed, timed
  // out. Empty when the server answered, even with nothing (no symbol there).
  notes: string[]
}

type SymbolAnswer = {
  ok?: boolean
  error?: string
  text?: unknown
  definition?: { path?: unknown; line?: unknown; col?: unknown; isInRepo?: unknown }
  signature?: unknown
  typeDefinition?: unknown
  implementations?: unknown
  notes?: unknown[]
}

const noSymbol = (why: string): LspSymbol => ({
  text: '',
  notes: [`language server did not answer: ${why}`],
})

const isPlace = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1

const fields = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

// A whole place of an answer, or undefined when a part of it is missing.
const toPlace = (value: unknown): Place | undefined => {
  const at = fields(value)

  if (
    at === undefined ||
    typeof at.path !== 'string' ||
    at.path === '' ||
    !isPlace(at.line) ||
    !isPlace(at.col)
  ) {
    return undefined
  }

  return { path: at.path, line: at.line, col: at.col, isInRepo: at.isInRepo === true }
}

const toSignature = (value: unknown): Signature | undefined => {
  const found = fields(value)

  if (found === undefined || typeof found.label !== 'string') {
    return undefined
  }

  const parameters = listOf(found.parameters).map(textOf)
  const active = found.active

  return {
    label: found.label,
    parameters,
    active:
      typeof active === 'number' && Number.isInteger(active) && active < parameters.length
        ? Math.max(active, -1)
        : -1,
    docs: textOf(found.docs),
  }
}

// What the bridge's client printed for a symbol request. Anything but its JSON
// answer has no text and says why in one note.
export const parseSymbol = (stdout: string, stderr = ''): LspSymbol => {
  let answer: SymbolAnswer | undefined

  try {
    answer = JSON.parse(stdout) as SymbolAnswer
  } catch {
    answer = undefined
  }

  if (answer === undefined || answer === null || typeof answer !== 'object') {
    return noSymbol(lastLine(stderr) || lastLine(stdout) || 'no output')
  }

  if (answer.ok !== true) {
    return noSymbol(answer.error ?? 'no reason given')
  }

  const found: LspSymbol = {
    text: typeof answer.text === 'string' ? answer.text : '',
    notes: (answer.notes ?? []).map(String),
  }
  const at = answer.definition

  if (
    at !== undefined &&
    at !== null &&
    typeof at.path === 'string' &&
    at.path !== '' &&
    isPlace(at.line) &&
    isPlace(at.col)
  ) {
    found.definition = { path: at.path, line: at.line, col: at.col, isInRepo: at.isInRepo === true }
  }

  const signature = toSignature(answer.signature)
  const typeDefinition = toPlace(answer.typeDefinition)
  const implementations: Place[] = []

  for (const item of listOf(answer.implementations)) {
    const place = toPlace(item)

    if (place !== undefined) {
      implementations.push(place)
    }
  }

  if (signature !== undefined) {
    found.signature = signature
  }

  if (typeDefinition !== undefined) {
    found.typeDefinition = typeDefinition
  }

  if (implementations.length > 0) {
    found.implementations = implementations
  }

  return found
}

// What the language server knows about the symbol at a position: 1-based line
// and column in `file`, a path relative to `repo` (an absolute real path). The
// column counts the line's own characters as a string index does (UTF-16 code
// units; a tab is one). Uses the daemon and servers the diagnostics use, and
// opens the file in its server when it is not open yet. Never rejects: any
// failure is `text: ''` and one note. `options.timeoutMs` is how long the
// server may take (30 seconds when not given). Inside a call's arguments the
// answer has that call's `signature`; `typeDefinition` and `implementations`
// are there when the server has them (pyright has no implementations).
export const lspSymbol = async (
  run: Run,
  repo: string,
  file: string,
  line: number,
  col: number,
  options: LspOptions = {},
): Promise<LspSymbol> => {
  if (!isServed(file)) {
    return { text: '', notes: ['no language server for this kind of file'] }
  }

  const timeoutMs = options.timeoutMs ?? 30_000

  try {
    const ran = await bridge(
      run,
      'symbol',
      { repo, file, line, col, envRoot: options.envRoot, timeout: timeoutMs / 1000 },
      Math.min(timeoutMs + 45_000, 600_000),
    )

    return parseSymbol(ran.stdout, ran.stderr)
  } catch (error) {
    return noSymbol(error instanceof Error ? error.message : String(error))
  }
}

// What the bridge's client printed for one of the lookups below: its answer's
// fields and notes. Anything but its JSON answer is no fields and one note.
type Asked = { answer: Record<string, unknown>; notes: string[] }

const unanswered = (why: string): Asked => ({
  answer: {},
  notes: [`language server did not answer: ${why}`],
})

const parseAsked = (stdout: string, stderr: string): Asked => {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = undefined
  }

  const answer = fields(parsed)

  if (answer === undefined) {
    return unanswered(lastLine(stderr) || lastLine(stdout) || 'no output')
  }

  if (answer.ok !== true) {
    return unanswered(typeof answer.error === 'string' ? answer.error : 'no reason given')
  }

  return { answer, notes: listOf(answer.notes).map(String) }
}

// One lookup in the server of `file`, with the daemon and servers everything
// else here uses. Never rejects. The server may take `options.timeoutMs` (30
// seconds when not given).
const ask = async (
  run: Run,
  what: 'references' | 'calls' | 'outline' | 'tokens' | 'symbols' | 'hints',
  file: string,
  request: object,
  options: LspOptions,
): Promise<Asked> => {
  if (!isServed(file)) {
    return { answer: {}, notes: ['no language server for this kind of file'] }
  }

  const timeoutMs = options.timeoutMs ?? 30_000

  try {
    const ran = await bridge(
      run,
      'ask',
      { what, ...request, envRoot: options.envRoot, timeout: timeoutMs / 1000 },
      Math.min(timeoutMs + 45_000, 600_000),
    )

    return parseAsked(ran.stdout, ran.stderr)
  } catch (error) {
    return unanswered(error instanceof Error ? error.message : String(error))
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

// Everywhere the symbol at a place is used, its declaration included, each
// with the text of its line: the project's own files first, then installed
// packages, each in path and line order. At most 1,000 (a note says how many
// there were). The place is 1-based, as for `lspSymbol`. A place with no symbol
// is no places and no note.
export const lspReferences = async (
  run: Run,
  repo: string,
  file: string,
  line: number,
  col: number,
  options: LspOptions = {},
): Promise<{ places: PlaceLine[]; notes: string[] }> => {
  const { answer, notes } = await ask(run, 'references', file, { repo, file, line, col }, options)
  const places: PlaceLine[] = []

  for (const item of listOf(answer.places)) {
    const place = toPlace(item)

    if (place !== undefined) {
      places.push({ ...place, text: textOf(fields(item)?.text) })
    }
  }

  return { places, notes }
}

// Who calls the function at a place ('incoming') or what it calls
// ('outgoing'), one level. A node's place is where that caller or callee is
// declared (its name), not the line of the call. At most 500.
export const lspCalls = async (
  run: Run,
  repo: string,
  file: string,
  line: number,
  col: number,
  direction: 'incoming' | 'outgoing',
  options: LspOptions = {},
): Promise<{ calls: CallNode[]; notes: string[] }> => {
  const request = { repo, file, line, col, direction }
  const { answer, notes } = await ask(run, 'calls', file, request, options)
  const calls: CallNode[] = []

  for (const item of listOf(answer.calls)) {
    const node = fields(item)
    const place = toPlace(node?.place)

    if (node !== undefined && place !== undefined) {
      calls.push({
        name: textOf(node.name),
        kind: textOf(node.kind),
        place,
        detail: textOf(node.detail),
      })
    }
  }

  return { calls, notes }
}

// The file's functions, classes, methods, variables and so on, in the file's
// order, a parent before its children. `line`..`endLine` is all an entry
// spans (a decorator above it included); `col` is its name's column when the
// name is on `line`, else where the span starts. At most 5,000.
export const lspOutline = async (
  run: Run,
  repo: string,
  file: string,
  options: LspOptions = {},
): Promise<{ items: OutlineItem[]; notes: string[] }> => {
  const { answer, notes } = await ask(run, 'outline', file, { repo, file }, options)
  const items: OutlineItem[] = []

  for (const item of listOf(answer.items)) {
    const entry = fields(item)

    if (
      entry !== undefined &&
      isPlace(entry.line) &&
      isPlace(entry.endLine) &&
      isPlace(entry.col) &&
      isCount(entry.depth)
    ) {
      items.push({
        name: textOf(entry.name),
        kind: textOf(entry.kind),
        line: entry.line,
        endLine: entry.endLine,
        col: entry.col,
        depth: entry.depth,
      })
    }
  }

  return { items, notes }
}

// What every name in the file is, in the file's order. The bridge sends each
// token as [line, col, length, type, modifier bits] against a legend, which
// keeps a large file's answer small; at most 100,000 tokens (a note says so).
export const lspSemanticTokens = async (
  run: Run,
  repo: string,
  file: string,
  options: LspOptions = {},
): Promise<{ tokens: SemanticToken[]; notes: string[] }> => {
  const { answer, notes } = await ask(run, 'tokens', file, { repo, file }, options)
  const types = listOf(answer.types).map(textOf)
  const names = listOf(answer.modifiers).map(textOf)
  const tokens: SemanticToken[] = []

  for (const row of listOf(answer.rows)) {
    const [line, col, length, type, bits] = listOf(row)
    const name = isCount(type) ? types[type] : undefined

    if (isPlace(line) && isPlace(col) && isCount(length) && isCount(bits) && name) {
      tokens.push({
        line,
        col,
        length,
        type: name,
        modifiers: names.filter((modifier, index) => modifier !== '' && (bits & (1 << index)) !== 0),
      })
    }
  }

  return { tokens, notes }
}

// Symbols anywhere in the project whose name matches `query`, the closest
// matches and the project's own files first. `near` is a file of the project
// (relative to `repo`): it picks the server and the project. At most
// `options.limit` hits (50 when not given, never more than 500).
export const lspWorkspaceSymbols = async (
  run: Run,
  repo: string,
  query: string,
  near: string,
  options: LspOptions & { limit?: number } = {},
): Promise<{ hits: SymbolHit[]; notes: string[] }> => {
  const request = { repo, near, query, limit: options.limit ?? 50 }
  const { answer, notes } = await ask(run, 'symbols', near, request, options)
  const hits: SymbolHit[] = []

  for (const item of listOf(answer.hits)) {
    const hit = fields(item)
    const place = toPlace(hit?.place)

    if (hit !== undefined && place !== undefined) {
      hits.push({
        name: textOf(hit.name),
        kind: textOf(hit.kind),
        container: textOf(hit.container),
        place,
      })
    }
  }

  return { hits, notes }
}

// The inferred types and parameter names the server would draw inside lines
// `fromLine`..`toLine` (1-based, both included), in the file's order. A label
// carries the space it is drawn with ('amount: ' before an argument, ': int'
// after a name). At most 5,000.
export const lspInlayHints = async (
  run: Run,
  repo: string,
  file: string,
  fromLine: number,
  toLine: number,
  options: LspOptions = {},
): Promise<{ hints: InlayHint[]; notes: string[] }> => {
  const request = { repo, file, fromLine, toLine }
  const { answer, notes } = await ask(run, 'hints', file, request, options)
  const hints: InlayHint[] = []

  for (const item of listOf(answer.hints)) {
    const hint = fields(item)

    if (hint !== undefined && isPlace(hint.line) && isPlace(hint.col)) {
      hints.push({
        line: hint.line,
        col: hint.col,
        label: textOf(hint.label),
        kind: hint.kind === 'type' || hint.kind === 'parameter' ? hint.kind : 'other',
      })
    }
  }

  return { hints, notes }
}
