// Checking: given the files of a change, what is wrong with them, and which
// of it the change brought.
//
// Which tools exist is this module's own business. The language servers are
// asked first and the command-line checkers (ruff, pyright, tsc, eslint,
// terraform) cover what they could not; each tool is run in the project its
// files belong to, and the base's version of a file is checked in an export
// of that commit, which git.ts makes. A caller sees diagnostics, notes on what could not run,
// and the names of the tools still out, and nothing of how any of it is done.
// The parsers are exported for their tests.

import type { ChangedFile, Diag, Severity } from '../types'
import { exportCommit, trackedFiles } from './git'
import type { Run as ServerRun } from './lsp'
import { lspDiagnostics, lspIsRunning } from './lsp'
import type { Run } from './run'
import { FILE_LIMIT, tail } from './run'
import type { Checkers } from './settings'

const PYTHON = /\.pyi?$/
const TYPESCRIPT = /\.[cm]?tsx?$/
const TERRAFORM = /\.(tf|tfvars)$/i
// The names the language servers' diagnostics carry as their tool.
const SERVER_TOOLS = ['pyright', 'tsserver', 'terraform-ls', 'terraform']
// What the language servers' own run is called while it is out.
const SERVERS = 'language servers'

// tsc and eslint start with `#!/usr/bin/env node`, and a Node installed
// through nvm is not on the PATH of a process started outside a login shell.
const WITH_NODE = [
  'sh',
  '-c',
  'command -v node >/dev/null || for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && PATH="$d:$PATH"; done; exec "$@"',
  'sh',
]

// For each file after the marker list, prints "file<tab>folder": the nearest
// folder at or above the file that holds one of the markers, or "." for none.
const NEAREST = `markers="$1"; shift
for f in "$@"; do
  d=$(dirname "$f")
  while :; do
    for m in $markers; do
      if [ -e "$d/$m" ]; then printf '%s\\t%s\\n' "$f" "$d"; continue 3; fi
    done
    [ "$d" = "." ] && break
    d=$(dirname "$d")
  done
  printf '%s\\t.\\n' "$f"
done`

// Whether a file is of a kind some checker reads; one that is not has
// nothing to say, which is not the same as being clean.
export const isCheckable = (path: string): boolean =>
  PYTHON.test(path) || TYPESCRIPT.test(path) || TERRAFORM.test(path)

// Whether a file is of a language whose server can search the project's names.
export const hasNameSearch = (path: string): boolean => PYTHON.test(path) || TYPESCRIPT.test(path)

// Whether a file's own checkers are among those still out: `pending` is the
// tools a check has started and not finished, as `Progress` named them.
export const isAwaited = (path: string, pending: readonly string[]): boolean =>
  pending.some(tool =>
    tool.startsWith(SERVERS)
      ? isCheckable(path)
      : PYTHON.test(path)
        ? tool.startsWith('ruff') || tool.startsWith('pyright')
        : TERRAFORM.test(path)
          ? tool.startsWith('terraform')
          : TYPESCRIPT.test(path) && (tool.startsWith('tsc') || tool.startsWith('eslint')),
  )

// The tools (as a diagnostic's `tool` names them) whose answers the pending
// ones will bring: what they found last time is not yet replaced.
export const toolsAwaited = (pending: readonly string[]): Set<string> =>
  new Set(
    pending.flatMap(tool => (tool.startsWith(SERVERS) ? SERVER_TOOLS : [tool.split(' ')[0] ?? ''])),
  )

// Told as each tool starts and finishes, with everything found so far, so a
// caller can show results as they come in.
export type Progress = {
  start: (tool: string) => void
  done: (tool: string, found: Diag[]) => void
}

export type Ports = {
  run: Run
  // How the language servers' bridge runs its commands.
  servers: ServerRun
  // A file's text by its absolute path; '' for one that cannot be read.
  readFile: (path: string) => Promise<string>
}

// What to check: the files `wanted` (relative to `repo`) of a comparison of
// `base` with the working tree or, when `target.ref` is not '', with that
// commit. `short` is each side's short hash, '' where git knows none; `files`
// is what differs between the sides. `isProject` asks for every file of
// every project, changed or not.
export type Ask = {
  repo: string
  base: { ref: string; short: string }
  target: { ref: string; short: string }
  files: readonly ChangedFile[]
  wanted: readonly string[]
  isProject: boolean
  // The checkers the person has left switched on, and whether the base is
  // checked too, to mark each diagnostic new or already there.
  use: Checkers
  marksNew: boolean
}

// What the checkers said about the base's version of the files last asked
// about, and those files' lines there. Kept while the base and the files
// stay the same, so an edit re-checks the working tree alone.
let before: { key: string; diags: Diag[]; texts: Record<string, string[]> } | undefined

// The same for the target commit, when the comparison is between two commits
// (a commit does not change, so its diagnostics are kept until the commit or
// the files asked about do).
let after: { key: string; diags: Diag[] } | undefined

// Checks the files asked about and marks each diagnostic as new or already
// there (`isNew`), where the base could be checked too. Never rejects for a
// tool that cannot run: `notes` says which could not, and why.
export const checkChange = async (
  ports: Ports,
  { repo, base, target, files, wanted, isProject, use, marksNew }: Ask,
  progress: Progress,
): Promise<{ diags: Diag[]; notes: string[] }> => {
  const notes: string[] = []
  // A language with every one of its checkers switched off is not asked about.
  const asked: Files = {
    python: (use.ruff || use.pyright ? wanted.filter(path => PYTHON.test(path)) : []).slice(0, FILE_LIMIT),
    typescript: (use.tsc || use.eslint ? wanted.filter(path => TYPESCRIPT.test(path)) : []).slice(
      0,
      FILE_LIMIT,
    ),
    terraform: (use.terraform ? wanted.filter(path => TERRAFORM.test(path)) : []).slice(0, FILE_LIMIT),
  }
  // A whole-project check wants every file, which the command-line checkers
  // give; anything else asks the language servers first.
  const useServers = use.servers && (target.ref !== '' || !isProject)
  // `side` is the tree the comparison reads and the checkers run over: the
  // working tree, or, when two commits are compared, an export of the target.
  let side = repo
  let checked: Diag[] = []

  if (target.ref === '') {
    checked = await checkTree(ports, repo, repo, asked, isProject, useServers, use, notes, progress)
  } else {
    const sideKey = `${repo}\n${target.short}\n${JSON.stringify(use)}\n${[...asked.python, ...asked.typescript, ...asked.terraform].join('\n')}`
    const exported = await exportCommit(ports.run, repo, target.ref, target.short, base.short)

    if (exported.dir === '') {
      notes.push(
        `diagnostics are not shown: ${target.ref} could not be exported to check it (${exported.refusal})`,
      )
    } else if (after?.key === sideKey) {
      side = exported.dir
      checked = after.diags
    } else {
      side = exported.dir
      checked = await checkTree(ports, repo, side, asked, false, useServers, use, notes, progress)
      after = { key: sideKey, diags: checked }
    }
  }

  // New or already there: the same checkers run over the base's version of
  // each modified file that has a diagnostic, and a diagnostic the base also
  // had, on a line with the same text, was there before the change.
  const statusOf = new Map(files.map(one => [one.path, one.status]))
  const troubled = [...new Set(checked.map(diag => diag.path))]
    .filter(path => statusOf.get(path) === 'M')
    .sort()
  const diags = checked.map(diag =>
    statusOf.get(diag.path) === '?' || statusOf.get(diag.path) === 'A'
      ? { ...diag, isNew: true }
      : diag,
  )

  if (troubled.length === 0 || !marksNew) {
    return { diags, notes }
  }

  const textsIn = async (tree: string): Promise<Record<string, string[]>> => {
    const texts: Record<string, string[]> = {}

    await Promise.all(
      troubled.map(async path => {
        texts[path] = (await ports.readFile(`${tree}/${path}`)).split('\n')
      }),
    )

    return texts
  }
  const key = `${repo}\n${base.short}\n${useServers}\n${JSON.stringify(use)}\n${troubled.join('\n')}`

  if (before?.key !== key && base.short !== '') {
    // The base is checked last and all at once; until it is, what is new
    // and what was there before is not known.
    progress.start('new or pre-existing')

    const exported = await exportCommit(
      ports.run,
      repo,
      base.ref,
      base.short,
      target.short || base.short,
    )

    if (exported.dir === '') {
      notes.push(
        `new or pre-existing is not marked: ${base.ref} could not be exported to check it (${exported.refusal})`,
      )
    } else {
      const missed: string[] = []
      // The base is asked the same way as the side it is compared with: a
      // diagnostic is matched by its tool and its words, and the servers
      // and the command-line checkers do not put them the same.
      const baseDiags = await checkTree(
        ports,
        repo,
        exported.dir,
        {
          python: troubled.filter(path => PYTHON.test(path)),
          typescript: troubled.filter(path => TYPESCRIPT.test(path)),
          terraform: troubled.filter(path => TERRAFORM.test(path)),
        },
        false,
        useServers,
        use,
        missed,
      )
      const texts = await textsIn(exported.dir)

      if (missed.length > 0) {
        notes.push(`on the base, ${missed[0] ?? ''}`)
      }

      before = { key, diags: baseDiags, texts }
    }
  }

  return {
    diags: before?.key === key ? labelNew(diags, before.diags, await textsIn(side), before.texts) : diags,
    notes,
  }
}

type Files = { python: string[]; typescript: string[]; terraform: string[] }

// Runs the checkers over one tree of the repo's files: the working tree
// itself, or an export of a commit. Projects, virtualenvs and node_modules
// are always found in the working tree (`repo`), since an export has only
// what git tracks; `sink` takes a line for each tool that could not run.
// `isWhole` checks every file of every project with the command-line
// checkers; otherwise, with `useServers`, the language servers are asked
// first: they answer for the files given, in milliseconds once warm.
const checkTree = async (
  ports: Ports,
  repo: string,
  tree: string,
  { python, typescript, terraform }: Files,
  isWhole: boolean,
  useServers: boolean,
  use: Checkers,
  sink: string[],
  progress?: Progress,
): Promise<Diag[]> => {
  const found: Diag[] = []
  // A server speaks in the name of the checker it stands in for; what one
  // says for a checker that is switched off is left out.
  const isWanted = (diag: Diag): boolean =>
    diag.tool === 'pyright'
      ? use.pyright
      : diag.tool === 'tsserver'
        ? use.tsc
        : diag.tool.startsWith('terraform')
          ? use.terraform
          : true
  // `dir` is a folder of the repo, relative to it: the project a tool runs in.
  const at = (dir: string): string => (dir === '.' ? repo : `${repo}/${dir}`)
  const inTree = (dir: string): string => (dir === '.' ? tree : `${tree}/${dir}`)
  const under = (dir: string, path: string): string => (dir === '.' ? path : `${dir}/${path}`)
  const run = (argv: string[], timeoutMs = 60_000, dir = '.') =>
    ports.run(argv, { cwd: at(dir), timeoutMs })
  const exec = (argv: string[], timeoutMs: number, dir = '.') =>
    ports.run(argv, { cwd: inTree(dir), timeoutMs })
  const has = async (path: string, dir = '.'): Promise<boolean> =>
    (await run(['test', '-e', path], 60_000, dir)).exitCode === 0
  // The projects the given files belong to, each with its files relative to it.
  const projectsOf = async (markers: string, paths: string[]): Promise<Map<string, string[]>> =>
    paths.length === 0
      ? new Map()
      : groupByRoot((await run(['sh', '-c', NEAREST, 'sh', markers, ...paths])).stdout)
  // In a whole-project check, every project the repo tracks counts, changed or not.
  const addTracked = async (projects: Map<string, string[]>, patterns: string[]): Promise<void> => {
    for (const path of await trackedFiles(ports.run, repo, patterns)) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'

      if (!projects.has(dir)) {
        projects.set(dir, [])
      }
    }
  }
  const collect = (tool: string, parsed: Diag[] | undefined, stderr: string): void => {
    if (parsed === undefined) {
      sink.push(explain(tool, stderr))
    } else {
      found.push(...parsed)
    }

    progress?.done(tool, found)
  }
  const checks: Promise<void>[] = []

  if (python.length > 0 && use.ruff) {
    progress?.start('ruff')
    checks.push(
      exec(
        ['uvx', 'ruff', 'check', '--output-format', 'json', '--exit-zero', ...python],
        60_000,
      ).then(ran => collect('ruff', parseRuff(ran.stdout, tree), ran.stderr)),
    )
  }

  // Each Python project is checked from its own folder, with its own venv.
  const pythonProjects = await projectsOf('pyrightconfig.json pyproject.toml .venv venv', python)

  if (isWhole) {
    await addTracked(pythonProjects, ['*pyproject.toml', '*pyrightconfig.json'])

    if (pythonProjects.size === 0) {
      pythonProjects.set('.', [])
    }
  }

  // Each TypeScript project is the folder of the nearest tsconfig.json; its
  // tools are the nearest node_modules at or above it (a workspace hoists them).
  const typescriptProjects = await projectsOf('tsconfig.json', typescript)

  if (isWhole) {
    await addTracked(typescriptProjects, ['*tsconfig.json'])
  }

  const bins = new Map<string, string>()

  for (const dir of typescriptProjects.keys()) {
    const nearest = await run(['sh', '-c', NEAREST, 'sh', 'node_modules/.bin/tsc', under(dir, 'x')])
    const binDir = [...groupByRoot(nearest.stdout).keys()][0] ?? '.'

    bins.set(dir, `${at(binDir)}/node_modules/.bin`)

    // An export has no node_modules of its own; it borrows the working
    // tree's, so imports resolve there as they do here.
    if (tree !== repo) {
      await exec(
        ['ln', '-sfn', `${at(binDir)}/node_modules`, `${inTree(binDir)}/node_modules`],
        10_000,
      )
    }
  }

  // The language servers answer first. What they covered is not asked of
  // the command-line type checkers again; what they could not cover (a
  // server not installed, a file outside any project) still is.
  const served = new Set<string>()
  const asked = [...python, ...typescript, ...terraform]

  if (useServers && !isWhole && asked.length > 0) {
    // Servers not yet running take their time over the first answer (the
    // very first run fetches them), which is said while it lasts.
    const servers = (await lspIsRunning(ports.servers))
      ? SERVERS
      : `${SERVERS} (starting: the first answer can take a minute)`

    progress?.start(servers)

    const answer = await lspDiagnostics(
      ports.servers,
      tree,
      asked,
      tree === repo ? {} : { envRoot: repo },
    )

    for (const path of answer.covered) {
      served.add(path)
    }

    // A missing terraform-ls is not worth a note: the terraform command
    // below checks those files, and says so itself when it cannot.
    sink.push(...answer.notes.filter(note => !note.includes('terraform-ls')).map(explainServer))
    found.push(...answer.diags.filter(isWanted))
    progress?.done(servers, found)
  }

  // Terraform files no server answered for are validated by the terraform
  // command, a folder at a time: a folder is one configuration.
  const terraformDirs = new Set(
    terraform
      .filter(path => !served.has(path))
      .map(path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')),
  )

  for (const dir of terraformDirs) {
    checks.push(
      (async () => {
        progress?.start(`terraform (${dir})`)

        const ran = await exec(['terraform', 'validate', '-json', '-no-color'], 120_000, dir)
        const parsed = parseTerraform(ran.stdout, dir)

        sink.push(...(parsed?.notes ?? []))
        collect(`terraform (${dir})`, parsed?.diags, ran.stderr)
      })(),
    )
  }

  for (const [dir, paths] of pythonProjects) {
    const left = isWhole ? paths : paths.filter(path => !served.has(under(dir, path)))

    if (!use.pyright || (!isWhole && left.length === 0)) {
      continue
    }

    checks.push(
      (async () => {
        progress?.start(`pyright (${dir})`)

        const [hasDotVenv, hasVenv] = await Promise.all([
          has('.venv/bin/python', dir),
          has('venv/bin/python', dir),
        ])
        const python3 = hasDotVenv
          ? `${at(dir)}/.venv/bin/python`
          : hasVenv
            ? `${at(dir)}/venv/bin/python`
            : undefined
        const args = [
          '--outputjson',
          ...(python3 === undefined ? [] : ['--pythonpath', python3]),
          ...(isWhole ? [] : left),
        ]
        const installed = await exec(['pyright', ...args], 300_000, dir)
        // A pyenv shim only answers in a Python version that has pyright
        // installed, and a project's .python-version may pin another one;
        // uvx runs pyright whatever the folder's Python is.
        const ran =
          parsePyright(installed.stdout, tree) === undefined
            ? await exec([...WITH_NODE, 'uvx', 'pyright', ...args], 300_000, dir)
            : installed
        collect(`pyright (${dir})`, parsePyright(ran.stdout, tree), ran.stderr)
      })(),
    )
  }

  for (const [dir, paths] of typescriptProjects) {
    const bin = bins.get(dir) ?? `${at(dir)}/node_modules/.bin`
    const needsTsc = use.tsc && (isWhole || paths.some(path => !served.has(under(dir, path))))

    checks.push(
      (async () => {
        if (needsTsc && !(await has(`${bin}/tsc`))) {
          sink.push(
            `tsc skipped in ${here(dir)}: its packages are not installed. Run npm install (or pnpm, yarn, bun) there, then press r`,
          )
        } else if (needsTsc) {
          progress?.start(`tsc (${dir})`)

          // A solution-style tsconfig only lists references; the app's own
          // config is the one that holds the source files.
          const hasAppConfig = await has('tsconfig.app.json', dir)
          const ran = await exec(
            [
              ...WITH_NODE,
              `${bin}/tsc`,
              ...(hasAppConfig ? ['-p', 'tsconfig.app.json'] : []),
              '--noEmit',
              '--pretty',
              'false',
            ],
            300_000,
            dir,
          )
          const parsed = parseTsc(ran.stdout).map(diag => ({
            ...diag,
            path: under(dir, diag.path),
          }))
          const isRun = !(ran.exitCode > 0 && parsed.length === 0)

          // tsc speaks for the whole project, so what the server said of
          // some of its files is dropped: one tool's word per project.
          if (isRun) {
            const prefix = dir === '.' ? '' : `${dir}/`

            for (let at = found.length - 1; at >= 0; at -= 1) {
              if (found[at]?.tool === 'tsserver' && (found[at]?.path ?? '').startsWith(prefix)) {
                found.splice(at, 1)
              }
            }
          }

          collect(`tsc (${dir})`, isRun ? parsed : undefined, ran.stdout + ran.stderr)
        }

        if (paths.length === 0 || !use.eslint) {
          return
        }

        // A project that does not use eslint is not missing anything.
        if (!(await has(`${bin}/eslint`))) {
          return
        }

        progress?.start(`eslint (${dir})`)

        const ran = await exec(
          [...WITH_NODE, `${bin}/eslint`, '-f', 'json', ...paths],
          120_000,
          dir,
        )
        collect(`eslint (${dir})`, parseEslint(ran.stdout, tree), ran.stderr)
      })(),
    )
  }

  await Promise.all(checks)

  return found
}

// A project's folder as a person reads it.
const here = (dir: string): string => (dir === '.' ? 'the folder under review' : dir)

// Why a tool did not run, with what to do about it where the reason is one
// of the usual ones; the tool's own last words otherwise. `tool` is the name
// progress knows it by ("pyright (backend)").
export const explain = (tool: string, stderr: string): string => {
  const name = tool.split(' ')[0] ?? tool
  const dir = /\((.*)\)$/.exec(tool)?.[1] ?? '.'
  const said = stderr.toLowerCase()
  const isMissing = /not found|no such file|enoent|cannot find|not installed/.test(said)

  if (/timed? ?out|etimedout|sigterm|killed/.test(said)) {
    return `${tool} was stopped: it took too long. Press r to try again; a first run can be slow while the tool is fetched`
  }

  if ((name === 'ruff' || name === 'pyright') && isMissing && /\buvx?\b/.test(said)) {
    return `${tool} did not run: uv is not installed. Install it (brew install uv), then press r`
  }

  if (name === 'pyright' && isMissing && said.includes('node')) {
    return `${tool} did not run: pyright needs Node, and none was found. Install Node (brew install node), then press r`
  }

  if ((name === 'tsc' || name === 'eslint') && isMissing && said.includes('node')) {
    return `${tool} did not run: Node was not found. Install Node (brew install node, or nvm install), then press r`
  }

  if (name === 'eslint' && /eslint\.config|no eslint configuration|couldn't find a configuration/.test(said)) {
    return `${tool} did not run: ${here(dir)} has no eslint config. Add an eslint.config.js there, or switch eslint off in /config`
  }

  if (name === 'terraform' && isMissing) {
    return `${tool} did not run: terraform is not installed. Install it (brew install terraform), then press r`
  }

  return `${tool} did not run: ${tail(stderr) || 'it printed nothing'}. Switch it off in /config if this project does not use it`
}

// What the language servers' bridge said it could not do, with what to do
// about it where that is known.
export const explainServer = (note: string): string =>
  /\buv\b.*(not found|not installed)|python3?: (command )?not found/i.test(note)
    ? `${note}. The language servers need uv or python3 (brew install uv); the command-line checkers are used meanwhile`
    : note

// ---------------------------------------------------------------------------
// How each tool prints what it found.
// ---------------------------------------------------------------------------

const relative = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

const json = (out: string): unknown => {
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

// "file<tab>folder" lines into each folder's files, relative to that folder.
export const groupByRoot = (out: string): Map<string, string[]> => {
  const groups = new Map<string, string[]>()

  for (const line of out.split('\n')) {
    const [path, root] = line.split('\t')

    if (path === undefined || root === undefined || path === '') {
      continue
    }

    const inside = root === '.' ? path : path.slice(root.length + 1)
    groups.set(root, [...(groups.get(root) ?? []), inside])
  }

  return groups
}

type RuffItem = {
  code?: string | null
  message?: string
  filename?: string
  location?: { row?: number; column?: number }
  end_location?: { row?: number; column?: number }
}

export const parseRuff = (out: string, root: string): Diag[] | undefined => {
  const items = json(out)

  if (!Array.isArray(items)) {
    return undefined
  }

  return (items as RuffItem[]).map(item => ({
    path: relative(item.filename ?? '', root),
    line: item.location?.row ?? 1,
    col: item.location?.column ?? 1,
    endCol: item.end_location?.row === item.location?.row ? (item.end_location?.column ?? 0) : 0,
    severity: item.code ? 'warning' : 'error',
    tool: 'ruff',
    rule: item.code ?? 'syntax',
    message: item.message ?? '',
  }))
}

type PyrightItem = {
  file?: string
  severity?: string
  message?: string
  rule?: string
  range?: {
    start?: { line?: number; character?: number }
    end?: { line?: number; character?: number }
  }
}

const PYRIGHT_SEVERITY: Record<string, Severity> = {
  error: 'error',
  warning: 'warning',
  information: 'info',
}

export const parsePyright = (out: string, root: string): Diag[] | undefined => {
  const report = json(out) as { generalDiagnostics?: PyrightItem[] } | undefined

  if (!Array.isArray(report?.generalDiagnostics)) {
    return undefined
  }

  return report.generalDiagnostics.map(item => ({
    path: relative(item.file ?? '', root),
    line: (item.range?.start?.line ?? 0) + 1,
    col: (item.range?.start?.character ?? 0) + 1,
    endCol:
      item.range?.end?.line === item.range?.start?.line ? (item.range?.end?.character ?? -1) + 1 : 0,
    severity: PYRIGHT_SEVERITY[item.severity ?? ''] ?? 'info',
    tool: 'pyright',
    rule: item.rule ?? '',
    message: item.message ?? '',
  }))
}

type TerraformItem = {
  severity?: string
  summary?: string
  detail?: string
  range?: {
    filename?: string
    start?: { line?: number; column?: number }
    end?: { line?: number; column?: number }
  }
}

// `terraform validate -json`, run in `dir` (a folder of the repo, '.' for
// the repo itself). A diagnostic that names no file (the folder needs
// `terraform init`, say) is a note about the run, not about a line.
export const parseTerraform = (
  out: string,
  dir: string,
): { diags: Diag[]; notes: string[] } | undefined => {
  const report = json(out) as { diagnostics?: TerraformItem[] } | undefined

  if (!Array.isArray(report?.diagnostics)) {
    return undefined
  }

  const said = (item: TerraformItem): string =>
    [item.summary, item.detail].filter(part => part !== undefined && part !== '').join(': ')
  const placed = report.diagnostics.filter(item => item.range?.filename !== undefined)

  return {
    diags: placed.map(item => ({
      path: dir === '.' ? (item.range?.filename ?? '') : `${dir}/${item.range?.filename ?? ''}`,
      line: item.range?.start?.line ?? 1,
      col: item.range?.start?.column ?? 1,
      endCol:
        item.range?.end?.line === item.range?.start?.line ? (item.range?.end?.column ?? 0) : 0,
      severity: item.severity === 'warning' ? 'warning' : 'error',
      tool: 'terraform',
      rule: '',
      message: said(item),
    })),
    notes: report.diagnostics
      .filter(item => item.range?.filename === undefined)
      .map(item =>
        // A folder never initialised has no providers to validate against.
        /terraform init|not installed|missing required provider/i.test(said(item))
          ? `terraform (${dir}) is not set up here: run terraform init in ${here(dir)}, then press r`
          : `terraform (${dir}): ${said(item).replace(/\s+/g, ' ')}`,
      ),
  }
}

// `tsc --pretty false`: "src/a.ts(12,5): error TS2322: message".
export const parseTsc = (out: string): Diag[] =>
  out.split('\n').flatMap(line => {
    const hit = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line)

    return hit === null
      ? []
      : [
          {
            path: hit[1] ?? '',
            line: Number(hit[2]),
            col: Number(hit[3]),
            endCol: 0,
            severity: hit[4] === 'error' ? 'error' : 'warning',
            tool: 'tsc',
            rule: hit[5] ?? '',
            message: hit[6] ?? '',
          } satisfies Diag,
        ]
  })

type EslintFile = {
  filePath?: string
  messages?: {
    line?: number
    column?: number
    endLine?: number
    endColumn?: number
    severity?: number
    ruleId?: string | null
    message?: string
  }[]
}

export const parseEslint = (out: string, root: string): Diag[] | undefined => {
  const files = json(out)

  if (!Array.isArray(files)) {
    return undefined
  }

  return (files as EslintFile[]).flatMap(file =>
    (file.messages ?? []).map(message => ({
      path: relative(file.filePath ?? '', root),
      line: message.line ?? 1,
      col: message.column ?? 1,
      endCol: message.endLine === message.line ? (message.endColumn ?? 0) : 0,
      severity: message.severity === 2 ? 'error' : 'warning',
      tool: 'eslint',
      rule: message.ruleId ?? '',
      message: message.message ?? '',
    })),
  )
}

// Marks each diagnostic of the files checked on both sides as new or already
// there. Line numbers shift as a file is edited, so one is matched to the
// base's by tool, rule, message and the text of the line it sits on; each of
// the base's stands for one match, so a second copy of an old problem is new.
export const labelNew = (
  head: readonly Diag[],
  base: readonly Diag[],
  headTexts: Readonly<Record<string, readonly string[]>>,
  baseTexts: Readonly<Record<string, readonly string[]>>,
): Diag[] => {
  const keyOf = (diag: Diag, texts: Readonly<Record<string, readonly string[]>>): string =>
    [
      diag.path,
      diag.tool,
      diag.rule,
      diag.message,
      (texts[diag.path]?.[diag.line - 1] ?? '').trim(),
    ].join('\u0001')
  const left = new Map<string, number>()

  for (const diag of base) {
    const key = keyOf(diag, baseTexts)
    left.set(key, (left.get(key) ?? 0) + 1)
  }

  return head.map(diag => {
    if (headTexts[diag.path] === undefined) {
      return diag
    }

    const key = keyOf(diag, headTexts)
    const count = left.get(key) ?? 0

    if (count > 0) {
      left.set(key, count - 1)
    }

    return { ...diag, isNew: count === 0 }
  })
}
