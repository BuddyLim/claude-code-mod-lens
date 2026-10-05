// The hooks module: the wiring. It declares the session's state, holds what
// is too big or too short-lived to be state, and has every function that
// touches the engine handle `$` (the engine follows `$` only into functions
// declared at the top of this file, so they cannot live anywhere else). Each
// of those is thin: it makes a `run` from the handle, calls the module that
// knows the subject (git.ts, check.ts, scan.ts, lsp.ts, review.ts), and puts
// the answer where the screens read it. The render hook builds each screen's
// model and actions and routes to the screen (screens/), which is a pure view.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { LineRange, Listing, Lookup, Recent, Scan, Span, View } from '../types'
import { hasNameSearch } from './check'
import { diagsByLine, diagsOf } from './diags'
import * as git from './git'
import type { Blamed } from './git'
import {
  LIST_ROWS,
  callsList,
  implementationsList,
  lookupOf,
  namesList,
  usesList,
} from './lists'
import type { Run as ServerRun } from './lsp'
import {
  isServed,
  lspCalls,
  lspInlayHints,
  lspOutline,
  lspReferences,
  lspSemanticTokens,
  lspSymbol,
  lspWorkspaceSymbols,
} from './lsp'
import type { InlayHint, SemanticToken } from './lsp-types'
import { ISSUES_SENT, codeBlock, diagBlock, issueList, quoteBlock, talkBlock } from './prompt'
import { cleanUp, recentOf, remember, settledRecents } from './recents'
import type { Comment, Run as ForgeRun } from './review'
import {
  fetchComments,
  parseRequest,
  postComment,
  listRequests,
  replyComment,
  repoPrefix,
  resolveRequest,
  resolveThread,
} from './review'
import type { Run } from './run'
import { tail } from './run'
import type { Job } from './scan'
import { allFilesOf, historyOf, isQueued, noteTouched, scanRepo } from './scan'
import type { FileWindow, Insight } from './screens/file'
import { fileScreen } from './screens/file'
import type { Shell } from './screens/frame'
import { frame, kitOf } from './screens/frame'
import type { GraphWindow } from './screens/graph'
import { graphScreen } from './screens/graph'
import { helpScreen } from './screens/help'
import { listScreen } from './screens/list'
import { isMarkdownFile, markdownScreen } from './screens/markdown'
import { recentsScreen } from './screens/recents'
import { treeScreen } from './screens/tree'
import { foldOf } from './semantic'
import type { Settings } from './settings'
import { DEFAULTS, settingsOf } from './settings'
import { readSource } from './source'
import {
  NO_CRUMB,
  NO_LISTING,
  NO_PICKED,
  NO_SCAN,
  NO_SOURCE,
  NO_SYMBOL,
  NO_VIEW,
  changedDiags,
  comparisonOf,
  settledPicked,
  settledScan,
  settledView,
  totalsOf,
} from './state'
import { clamp, foldEnd } from './text'

const PANE = 'lens'
// How many unchanged files opened from the tree of every file stay among
// those checked.
const EXTRA_FILES = 20
// The most lines of code sent to the prompt with a review thread.
const TALK_CODE = 80

// The session's state. Its shapes are the contract's (types/index.d.ts) and
// its defaults are in state.ts; the atoms are written here because the
// engine reads a state reference only in the file that uses it.
const view = atom({ plugin: 'lens', key: 'view' } as const, NO_VIEW)
const scan = atom({ plugin: 'lens', key: 'scan' } as const, NO_SCAN)
const source = atom({ plugin: 'lens', key: 'source' } as const, NO_SOURCE)
const listing = atom({ plugin: 'lens', key: 'listing' } as const, NO_LISTING)
const picked = atom({ plugin: 'lens', key: 'picked' } as const, NO_PICKED)
// The repos reviewed lately, as the store holds them between sessions: the
// copy the recents screen draws from, written by `rememberReview`,
// `forgetReview` and the /lens command.
const recents = atom({ plugin: 'lens', key: 'recents' } as const, [] as Recent[])
// The frame of the busy mark, stepped by the timer while a scan runs.
const spin = atom({ plugin: 'lens', key: 'spin' } as const, 0)
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// What the module holds beside the state. A reload of the mod drops all of
// it, and each is asked for again where it is missed. Every one below is
// written only by the function or hook its comment names; the rest of the
// session's caches belong to the modules that fill them (the history and
// the list of every file to scan.ts, the base's diagnostics to check.ts).

// The person's settings, read from the module's options when it registers
// (a change in the config menu loads the module again with the new ones).
let settings: Settings = DEFAULTS

// The scan queue, written by anything that wants a scan and taken by the
// timer: a reload drops a waiting scan, and the next refresh asks again.
let job: Job | undefined
let isBusy = false

// The open file's coloured lines, written by `loadSource`. A whole file is
// too much to keep as state, so a reload loses them and the render hook asks
// for them again through `wanted`, which the timer takes.
let cache:
  | {
      path: string
      // The commit the file was read at; '' for the working tree's.
      commit: string
      lines: Span[][]
      removed: Record<number, string[]>
      // A commit's own changed lines; the working tree's come from the scan.
      changed: LineRange[] | undefined
    }
  | undefined
let wanted: string | undefined
let isLoading = false

// The commit or stash message as typed so far, and the comment being typed:
// each field holds its own text, and these are the copies the buttons beside
// it read. Written by the fields' actions, and cleared by `commitFiles`,
// `stashFiles` and `postReview` once what was typed has been used.
let draft = ''
let draftBody = ''
let commentDraft = ''
// How many comments have been sent or dropped: see `FileModel.commentRound`.
let commentRound = 0

// How the language-server bridge runs its commands, made by `serverRun` from
// the first handle that needs it.
let servers: ServerRun | undefined

// What the language server knows of the file the file screen shows, written
// by `loadInsight` (and dropped by `loadSource` for a commit's file). Read
// after the file itself, so the file draws first and gains these.
let insight: ({ path: string } & Insight) | undefined
// The file `loadInsight` is reading for, while it is: the screen says so.
let insightFor: string | undefined

// The comments on the pull or merge request under review, as the forge gave
// them, with the folder under review's place in the repo (`prefix`). Written
// by `loadComments`; `postReview` adds the comment it posted.
let commentsCache: { key: string; prefix: string; comments: Comment[] } | undefined

// The repo's open pull or merge requests, for the compare panel to offer.
// Written by `loadRequests`, when the panel opens.
let requestsCache: { repo: string; list: { typed: string; title: string }[] } | undefined

// What the folder the breadcrumb last opened holds, written by `loadCrumb`.
let crumbCache: { dir: string; entries: string[] } | undefined

// Who last changed each line of the file the blame column was asked for,
// written by `loadBlame`.
let blameCache: { path: string; commit: string; lines: Blamed[] } | undefined

// What the render hook leaves for the scroll hook and the timer: the graph's
// and the file's windows as last drawn (see `GraphWindow`, `FileWindow`),
// and whether the pane's own scroll needs holding one row down, for a screen
// that draws its own window; the drawing asks, the timer does it.
let graphWindow: GraphWindow = { header: 0, kinds: [], maxTop: 0, bodyMax: 0 }
let fileWindow: FileWindow = { maxTop: 1, crumbBox: undefined }
let wantPin = false

const noteEdit = async ($: EngineInterface, path: string): Promise<void> => {
  const { repo, isTelling } = await read($, view)

  if (repo !== '' && path.startsWith(`${repo}/`)) {
    job = { isProject: false }

    if (isTelling ?? false) {
      noteTouched(path.slice(repo.length + 1))
    }
  }
}

// Every command of the session is run through this: the handle's own
// `process.run`, made never to reject (see `Run`).
const runOf =
  ($: EngineInterface): Run =>
  (argv, init) =>
    $.process
      .run(argv, init ?? {})
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

// Reads a whole file as coloured lines and keeps it for the file screen, with
// what the diff view interleaves.
//
// With a `commit` the file is read as that commit left it, and its diff is
// what the commit changed; without one it is the working tree's file, against
// the base.
const loadSource = async (
  $: EngineInterface,
  repo: string,
  path: string,
  commit = '',
): Promise<void> => {
  const run = runOf($)
  const committed = commit === '' ? undefined : await git.fileAt(run, repo, path, commit)
  const { lines, note } = await readSource(
    run,
    file => $.fs.read(file).catch(() => ''),
    repo,
    path,
    committed,
  )
  const { base, target } = await read($, view)
  const diff = await git.fileDiff(run, repo, path, commit, base, target ?? '')

  cache = { path, commit, lines, removed: diff.removed, changed: diff.changed }
  const stamp = await $.clock.now()
  await update($, source, () => ({ path, lineCount: lines.length, note, stamp }))

  // What the language server adds comes after, so the file is not kept
  // waiting for it; only the working tree's files are on disk for a server.
  if (commit === '') {
    void loadInsight($, repo, path)
  } else {
    insight = undefined
  }
}

// The repos reviewed lately, as the store holds them.
const readRecents = async ($: EngineInterface): Promise<Recent[]> =>
  settledRecents(await $.store.get('recents').catch(() => undefined))

// Keeps the review as it stands (its repo, comparison and layout) for the
// sessions to come, where the person has not switched remembering off.
const rememberReview = async ($: EngineInterface): Promise<void> => {
  const now = await read($, view)

  if (!settings.remembers || now.repo === '') {
    return
  }

  const list = remember(
    await readRecents($),
    recentOf(now, await $.clock.now(), await git.mainRepoOf(runOf($), now.repo)),
  )

  await $.store.set('recents', list).catch(() => undefined)
  await update($, recents, () => list)
}

const forgetReview = async ($: EngineInterface, repo: string): Promise<void> => {
  const list = (await readRecents($)).filter(one => one.repo !== repo)

  await $.store.set('recents', list).catch(() => undefined)
  await update($, recents, () => list)
}

// Starts a review of a repo and opens the pane on it. With no `base` named,
// the repo is picked up where it was last left: its layout, and its
// comparison where git still knows both sides (a pull or merge request is
// fetched again). Answers what it did, in a sentence.
const openReview = async (
  $: EngineInterface,
  repo: string,
  base: string | undefined,
): Promise<string> => {
  const kept =
    base === undefined && settings.remembers
      ? (await readRecents($)).find(one => one.repo === repo)
      : undefined

  await update($, view, () => ({
    ...NO_VIEW,
    repo,
    base: base ?? 'HEAD',
    layout: kept?.layout ?? 'tree',
    isBrowsing: kept?.isBrowsing ?? false,
  }))
  await update($, scan, () => ({ ...NO_SCAN, status: 'running' }))
  job = { isProject: false }
  await $.ui.open({ id: PANE, title: 'Lens', focus: true })

  if (kept === undefined || (kept.base === 'HEAD' && kept.target === '')) {
    return `Reviewing ${repo} against ${base ?? 'HEAD'}.`
  }

  if (kept.requestTyped !== '') {
    void startCompare($, repo, '', kept.requestTyped)

    return `Reviewing ${repo}: fetching ${kept.requestTyped} again, as you left it.`
  }

  const run = runOf($)
  const isKnown =
    (await git.isCommit(run, repo, kept.base)) &&
    (kept.target === '' || (await git.isCommit(run, repo, kept.target)))

  if (!isKnown) {
    return `Reviewing ${repo} against HEAD (what it was last compared with is gone).`
  }

  await update($, view, (last): View => ({ ...last, base: kept.base, target: kept.target }))
  job = { isProject: false }

  return `Reviewing ${repo}: ${kept.target === '' ? 'the working tree' : kept.target} against ${kept.base}, as you left it.`
}

// Runs one scan with this handle. The pipeline itself is in scan.ts; what
// it reads and writes of the session goes through the ports made here.
const runScan = async ($: EngineInterface, taken: Job): Promise<void> => {
  const now = await read($, view)

  // Every change of what is compared starts a scan, so this is where the
  // review is kept for next time.
  void rememberReview($)

  // A comparison with another worktree is with its files as they stand now:
  // they are read again, and the scan runs against that.
  let base = now.base

  if ((now.baseWorktree ?? '') !== '') {
    const taken = await git.snapshotWorktree(runOf($), now.baseWorktree)

    if (taken.hash !== '' && taken.hash !== base) {
      base = taken.hash
      await update($, view, (last): View => ({ ...last, base }))
    }
  }

  await scanRepo(
    {
      run: runOf($),
      servers: serverRun($),
      readFile: path => $.fs.read(path).catch(() => ''),
      readScan: () => read($, scan),
      writeScan: change => update($, scan, change),
      onListed: async () => {
        if (now.screen === 'file') {
          await loadSource($, now.repo, now.file, now.commit ?? '')
        }
      },
      readComments: typed => loadComments($, now.repo, typed),
      showStatus: text => {
        $.ui.status(text === '' ? undefined : text)
      },
      tellClaude: text =>
        $.session
          .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
          .catch(() => undefined),
      // The file being read, where it is the side the checkers run over.
      openFile: async () => {
        const { screen, file, commit, target } = await read($, view)

        return screen === 'file' && (commit ?? '') === (target ?? '') ? file : ''
      },
      isOvertaken: () => job !== undefined,
    },
    {
      repo: now.repo,
      base,
      target: now.target ?? '',
      extra: now.extra ?? [],
      isBrowsing: now.isBrowsing ?? false,
      isTelling: now.isTelling ?? false,
      requestTyped: now.requestTyped ?? '',
      use: settings.checkers,
      marksNew: settings.marksNew,
    },
    taken,
  )
}

// Throws away the uncommitted changes in the given files, which cannot be
// undone, and scans again whatever happened.
const discardFiles = async (
  $: EngineInterface,
  repo: string,
  tracked: string[],
  staged: string[],
  untracked: string[],
): Promise<void> => {
  const refusal = await git.discard(runOf($), repo, tracked, staged, untracked)
  const count = tracked.length + staged.length + untracked.length

  $.ui.toast(
    refusal === '' ? `Discarded the changes in ${count} ${count === 1 ? 'file' : 'files'}` : refusal,
    { timeoutMs: refusal === '' ? 4000 : 10_000 },
  )
  await update($, view, last => ({ ...last, checked: [], isDiscarding: false }))
  job = { isProject: false }
}

// How the language-server bridge runs its commands: kept for the session, so
// the bridge's script is written once.
const serverRun = ($: EngineInterface): ServerRun => (servers ??= runOf($))

// Reads what the language server knows of a whole file, for the file screen:
// its outline (exact folds, the breadcrumb), what each name is (colours), the
// file's own lines (a server counts a tab as one column, the screen draws
// four), and, when they are switched on, its inlay hints. A file outside the
// folder under review, or of a kind no server reads, has none.
const loadInsight = async ($: EngineInterface, repo: string, path: string): Promise<void> => {
  if (path.startsWith('/') || !isServed(path)) {
    insight = undefined

    return
  }

  const run = serverRun($)

  insightFor = path

  const { isHinting } = await read($, view)
  const [raw, outline, semantic, hinted] = await Promise.all([
    $.fs.read(`${repo}/${path}`).catch(() => ''),
    lspOutline(run, repo, path),
    lspSemanticTokens(run, repo, path),
    (isHinting ?? false) ? lspInlayHints(run, repo, path, 1, 1_000_000) : undefined,
  ])
  const tokens = new Map<number, SemanticToken[]>()
  const hints = new Map<number, InlayHint[]>()

  for (const token of semantic.tokens) {
    tokens.set(token.line, [...(tokens.get(token.line) ?? []), token])
  }

  for (const hint of hinted?.hints ?? []) {
    hints.set(hint.line, [...(hints.get(hint.line) ?? []), hint])
  }

  insight = { path, raw: raw.split('\n'), items: outline.items, tokens, hints }

  if (insightFor === path) {
    insightFor = undefined
  }

  // The file screen reads the source's stamp: a new one redraws it.
  await update($, source, last => ({ ...last, stamp: last.stamp + 1 }))

  if ((isHinting ?? false) && (hinted?.hints.length ?? 0) === 0 && (hinted?.notes.length ?? 0) > 0) {
    $.ui.toast(hinted?.notes[0] ?? '', { timeoutMs: 6000 })
  }
}

// Shows a list of places (or anything with a place) on the list screen; one
// with nothing in it is said in a toast instead, with the server's reason
// (`notes`) where it gave one.
const showList = async (
  $: EngineInterface,
  { title, rows, prompt }: Listing,
  notes: readonly string[],
): Promise<void> => {
  if (rows.length === 0) {
    $.ui.toast(notes[0] ?? `${title}: nothing found`, { timeoutMs: 6000 })

    return
  }

  await update($, listing, () => ({ title, rows: rows.slice(0, LIST_ROWS), prompt }))
  // Back from the list returns to the screen it was asked for on.
  await update(
    $,
    view,
    (last): View => ({
      ...last,
      screen: 'list',
      listBack: last.screen === 'list' ? (last.listBack ?? 'file') : last.screen === 'tree' ? 'tree' : 'file',
    }),
  )
}

// Everywhere the looked-up name is used.
const listReferences = async ($: EngineInterface, repo: string, at: Lookup): Promise<void> => {
  const answer = await lspReferences(serverRun($), repo, at.file, at.at, at.col)

  await showList($, usesList(at.name, at.file, answer.places), answer.notes)
}

// Who calls the looked-up function, or what it calls.
const listCalls = async (
  $: EngineInterface,
  repo: string,
  at: Lookup,
  direction: 'incoming' | 'outgoing',
): Promise<void> => {
  const answer = await lspCalls(serverRun($), repo, at.file, at.at, at.col, direction)

  await showList($, callsList(at.name, direction, answer.calls), answer.notes)
}

// What implements the looked-up interface, abstract method or protocol.
const listImplementations = async ($: EngineInterface, repo: string, at: Lookup): Promise<void> => {
  const answer = await lspSymbol(serverRun($), repo, at.file, at.at, at.col)

  await showList(
    $,
    implementationsList(at.name, answer.implementations ?? []),
    answer.notes.length > 0 ? answer.notes : ['The language server knows of none'],
  )
}

// Names anywhere in the project that match what was typed. `near` is a file
// of the project to search: it decides the language and the project.
const searchSymbols = async (
  $: EngineInterface,
  repo: string,
  query: string,
  near: string,
): Promise<void> => {
  if (query.trim() === '') {
    return
  }

  if (near === '') {
    $.ui.toast('There is no Python or TypeScript file here to search from')

    return
  }

  const answer = await lspWorkspaceSymbols(serverRun($), repo, query.trim(), near, {
    limit: LIST_ROWS,
  })

  await showList($, namesList(query.trim(), answer.hits), answer.notes)
}

// Asks the language server what a name on a line of a file is, and keeps the
// answer for the file screen to show. The column is found on the file's own
// text: the screen draws a tab as spaces, which a server does not count.
const lookUp = async (
  $: EngineInterface,
  repo: string,
  file: string,
  line: number,
  name: string,
): Promise<void> => {
  const raw = await $.fs.read(`${repo}/${file}`).catch(() => '')
  const col = Math.max(0, (raw.split('\n')[line - 1] ?? '').indexOf(name)) + 1
  const answer = await lspSymbol(serverRun($), repo, file, line, col)

  if (answer.text === '' && answer.notes.length > 0) {
    $.ui.toast(answer.notes[0] ?? 'The language server did not answer', { timeoutMs: 8000 })

    return
  }

  await update($, view, last => ({ ...last, symbol: lookupOf(file, name, line, col, answer) }))
}

// Reads what a folder of the folder under review holds, for the breadcrumb's
// list: folders first (their names end with a slash), then files, git's own
// folder left out. `left` is the column the list opens under.
const loadCrumb = async (
  $: EngineInterface,
  repo: string,
  dir: string,
  left: number,
): Promise<void> => {
  const ran = await runOf($)(['ls', '-1Ap', '--', dir === '' ? '.' : dir], { cwd: repo })

  if (ran.exitCode !== 0) {
    $.ui.toast(`That folder could not be read: ${tail(ran.stderr)}`, { timeoutMs: 6000 })

    return
  }

  const names = ran.stdout.split('\n').filter(name => name !== '' && name !== '.git/')

  crumbCache = {
    dir,
    entries: [
      ...names.filter(name => name.endsWith('/')),
      ...names.filter(name => !name.endsWith('/')),
    ],
  }
  await update(
    $,
    view,
    (last): View => ({ ...last, crumb: { kind: 'dir', dir, level: 0, left, top: -1 } }),
  )
}

// Reads who last changed each line of a file (as a commit left it, or as the
// working tree has it) and keeps it for the file screen's blame column.
const loadBlame = async (
  $: EngineInterface,
  repo: string,
  path: string,
  commit: string,
): Promise<void> => {
  const answer = await git.blame(runOf($), repo, path, commit, () => $.clock.now())

  if ('refusal' in answer) {
    $.ui.toast(`git blame did not go through: ${answer.refusal}`, { timeoutMs: 8000 })

    return
  }

  blameCache = { path, commit, lines: answer.lines }
  await update($, view, last => ({ ...last, isBlame: true }))
}

// Asks before undoing the last commit, saying whether it has been pushed:
// one that has stays on the remote, and the branch here falls behind it.
const askUndo = async ($: EngineInterface, repo: string): Promise<void> => {
  const pushed = await git.remotesWithHead(runOf($), repo)

  await update($, view, last => ({
    ...last,
    isUndoing: true,
    undoNote:
      pushed.length === 0
        ? 'It has not been pushed, so nothing else has it.'
        : `It is already on ${pushed[0] ?? 'a remote'}: undoing it here leaves it there, and this branch behind it.`,
  }))
}

// Takes the last commit back and keeps what it changed, as uncommitted edits.
const undoCommit = async ($: EngineInterface, repo: string): Promise<void> => {
  await report(
    $,
    await git.undoLastCommit(runOf($), repo),
    'Undid the last commit; its changes are uncommitted again',
  )
  await update($, view, last => ({ ...last, isUndoing: false, selected: '' }))
}

// Adds text to the end of the person's draft, on its own line, and never
// submits it: sending stays theirs.
const sendToComposer = async ($: EngineInterface, text: string): Promise<void> => {
  const draft = await $.prompt.read().then(
    box => box.text,
    () => '',
  )
  const lead = draft === '' || draft.endsWith('\n') ? '' : '\n'
  const filled = await $.prompt.fill({ text: `${lead}${text}\n`, mode: 'append' })

  $.ui.toast(
    filled.isFilled
      ? 'Added to the prompt'
      : `Could not add to the prompt${filled.refusal === undefined ? '' : ` (${filled.refusal})`}`,
  )
}

// Says how a git command that changes the repo went: `done` on success, the
// command's `refusal` (git's own last words) where it has one. A success
// clears the ticks and scans again, since the working tree is no longer what
// the pane shows.
const report = async ($: EngineInterface, refusal: string, done: string): Promise<boolean> => {
  if (refusal !== '') {
    $.ui.toast(refusal, { timeoutMs: 10_000 })

    return false
  }

  $.ui.toast(done)
  await update($, view, last => ({ ...last, checked: [] }))
  job = { isProject: false }

  return true
}

// Commits the ticked files and nothing else.
const commitFiles = async (
  $: EngineInterface,
  repo: string,
  paths: readonly string[],
  message: string,
  body = '',
): Promise<void> => {
  if (message.trim() === '') {
    $.ui.toast('Type a commit message first')

    return
  }

  if (
    await report(
      $,
      await git.commit(runOf($), repo, paths, message, body),
      `Committed ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`,
    )
  ) {
    draft = ''
    draftBody = ''
  }
}

// Stashes the ticked files, the untracked ones among them included.
const stashFiles = async (
  $: EngineInterface,
  repo: string,
  paths: readonly string[],
  message: string,
): Promise<void> => {
  const label = message.trim() || `${paths.length} ${paths.length === 1 ? 'file' : 'files'}`

  if (
    await report(
      $,
      await git.stash(runOf($), repo, paths, label),
      `Stashed ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`,
    )
  ) {
    draft = ''
  }
}

const applyStash = async (
  $: EngineInterface,
  repo: string,
  ref: string,
  isPop: boolean,
): Promise<void> => {
  await report(
    $,
    await git.restoreStash(runOf($), repo, ref, isPop),
    isPop ? `Popped ${ref}` : `Applied ${ref}`,
  )
}

// How the forge module runs its commands: in the folder under review.
const forgeRun =
  (run: Run, repo: string): ForgeRun =>
  (argv, timeoutMs = 60_000) =>
    run(argv, { cwd: repo, timeoutMs })

// Asks the forge for the repo's open requests and has the compare panel,
// which is already open, drawn again with them.
const loadRequests = async ($: EngineInterface, repo: string): Promise<void> => {
  requestsCache = { repo, list: await listRequests(forgeRun(runOf($), repo)) }
  await update($, view, (last): View => ({ ...last }))
}

// Starts a comparison between two things the person named: `side` is what is
// read (a branch or commit, or '' for the working tree) and `against` is what
// it is compared with. Each name is checked with git first, so a typo is said
// and nothing changes. Nothing is checked out: git diffs the two as they are.
const startCompare = async (
  $: EngineInterface,
  repo: string,
  side: string,
  against: string,
): Promise<void> => {
  const run = runOf($)
  const known = async (name: string): Promise<boolean> =>
    name === '' || (await git.isCommit(run, repo, name))
  let [from, to] = [side.trim(), against.trim()]
  let request = ''
  let typed = ''

  // A request is a comparison by itself (its head with where it forked from
  // its target), so it may be typed in either field, and what the other
  // field holds is set aside.
  const isRequest = async (name: string): Promise<boolean> =>
    name !== '' && parseRequest(name) !== undefined && !(await known(name))

  if (await isRequest(from)) {
    ;[from, to] = ['', from]
  } else if (await isRequest(to)) {
    from = ''
  } else if (from.startsWith('@')) {
    // A worktree, likewise, whichever field it was typed in.
    ;[from, to] = ['', from]
  }

  if (to === '') {
    $.ui.toast('Name a branch, a commit or a pull request to compare with')

    return
  }

  // "@name" is another worktree of the repo as its files stand, uncommitted
  // work and all: a commit is made of them (nothing of that worktree
  // changes) and compared with like any other. `beside` is its folder.
  let beside = ''

  if (to.startsWith('@')) {
    const name = to.slice(1)
    const other = ((await read($, scan)).worktrees ?? []).find(
      one => !one.isCurrent && one.path.split('/').pop() === name,
    )

    if (other === undefined) {
      $.ui.toast(`This repo has no other worktree called "${name}"`, { timeoutMs: 8000 })

      return
    }

    const taken = await git.snapshotWorktree(run, other.path)

    if (taken.hash === '') {
      $.ui.toast(`${name} could not be read as it stands: ${taken.refusal}`, { timeoutMs: 10_000 })

      return
    }

    beside = other.path
    to = taken.hash
  }

  // What is not a ref but reads as a pull or merge request (#12, !34, a
  // link) is looked up on the forge: its head is fetched under a ref of the
  // mod's own, and it is compared with where it forked from its target.
  if (from === '' && !(await known(to)) && parseRequest(to) !== undefined) {
    $.ui.toast(`Fetching ${to}…`)

    const answer = await resolveRequest(forgeRun(run, repo), to)

    if ('error' in answer) {
      $.ui.toast(answer.error, { timeoutMs: 10_000 })

      return
    }

    // What was typed is kept: the forge is asked about the request by it again,
    // for its comments and to post one.
    typed = to
    from = answer.side
    to = answer.against
    request = `${answer.label} → ${answer.target}${answer.title === '' ? '' : ` · ${answer.title}`}`
  }

  const unknown = !(await known(from)) ? from : !(await known(to)) ? to : undefined

  if (unknown !== undefined) {
    $.ui.toast(`"${unknown}" is not a branch or commit here`, { timeoutMs: 8000 })

    return
  }

  await update(
    $,
    view,
    (last): View => ({
      ...last,
      base: to,
      target: from,
      baseWorktree: beside,
      request,
      requestTyped: typed,
      isCommenting: false,
      commentLine: 0,
      screen: 'tree',
      isPicking: false,
      selected: '',
      commit: '',
      checked: [],
    }),
  )
  job = { isProject: false }
}

// Switches the repo to a branch, or to a commit with HEAD detached. Where
// git refuses, the person reads git's own reason.
const checkOut = async (
  $: EngineInterface,
  repo: string,
  target: string,
  isBranch: boolean,
): Promise<void> => {
  // A branch another worktree has checked out cannot be checked out here
  // too (git refuses); its worktree is where it is, so the review goes there.
  const held = isBranch
    ? ((await read($, scan)).worktrees ?? []).find(one => one.branch === target && !one.isCurrent)
    : undefined

  if (held !== undefined) {
    $.ui.toast(`${target} is checked out in the worktree ${held.path.split('/').pop() ?? ''}: reviewing it there`, {
      timeoutMs: 6000,
    })
    await openReview($, held.path, undefined)

    return
  }

  const refusal = await git.checkOut(runOf($), repo, target, isBranch)

  if (refusal !== '') {
    $.ui.toast(`Not checked out: ${refusal}`, { timeoutMs: 10_000 })

    return
  }

  $.ui.toast(isBranch ? `Checked out ${target}` : `Checked out ${target} (detached HEAD)`)
  // A checkout starts over: no comparison, just what is modified in the tree
  // now checked out, until the person picks a commit to compare with again.
  await update(
    $,
    view,
    (last): View => ({
      ...last,
      base: 'HEAD',
      target: '',
      baseWorktree: '',
      screen: 'tree',
      selected: '',
      commit: '',
    }),
  )
  job = { isProject: false }
}

// Reads the comments of the pull or merge request under review, and where in
// the repo the folder under review sits (a forge's paths are from the repo's
// root). Answers '' when it has them, else why not, in a sentence.
const loadComments = async ($: EngineInterface, repo: string, typed: string): Promise<string> => {
  const run = forgeRun(runOf($), repo)
  const [answer, prefix] = await Promise.all([fetchComments(run, typed), repoPrefix(run)])

  if ('error' in answer) {
    return answer.error
  }

  commentsCache = { key: `${repo}\n${typed}`, prefix, comments: answer.comments }

  return ''
}

// Posts one comment on a line of the request's head version of a file. It
// writes to the forge, so it runs only from the post button or Enter in the
// comment field, and says how it went.
const postReview = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  target: string,
  path: string,
  line: number,
  body: string,
): Promise<void> => {
  if (body.trim() === '') {
    $.ui.toast('Type the comment first')

    return
  }

  const run = forgeRun(runOf($), repo)
  const [head, prefix] = await Promise.all([git.fullHash(runOf($), repo, target), repoPrefix(run)])
  const answer = await postComment(
    run,
    typed,
    { path: `${prefix}${path}`, line, commit: head },
    body.trim(),
  )

  if ('error' in answer) {
    $.ui.toast(answer.error, { timeoutMs: 10_000 })

    return
  }

  if (commentsCache !== undefined && commentsCache.key === `${repo}\n${typed}`) {
    commentsCache.comments.push(answer.comment)
  }

  commentDraft = ''
  commentRound += 1
  $.ui.toast(`Comment posted on line ${line}`)
  await update($, view, last => ({ ...last, commentLine: 0 }))
}

// Answers the thread whose first comment is `root`, on the forge.
const postReply = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  root: Comment,
  body: string,
): Promise<void> => {
  if (body.trim() === '') {
    $.ui.toast('Type the reply first')

    return
  }

  const answer = await replyComment(forgeRun(runOf($), repo), typed, root, body.trim())

  if ('error' in answer) {
    $.ui.toast(answer.error, { timeoutMs: 10_000 })

    return
  }

  if (commentsCache !== undefined && commentsCache.key === `${repo}\n${typed}`) {
    // The forge's own path and line for a reply may be missing; it sits
    // where the thread does.
    commentsCache.comments.push({ ...answer.comment, path: root.path, line: root.line })
  }

  commentDraft = ''
  commentRound += 1
  $.ui.toast(`Replied to ${root.author}`)
  await update($, view, last => ({ ...last, commentLine: 0, replyTo: '' }))
}

// Marks the thread `root` starts as resolved, or open again, on the forge.
const settleThread = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  root: Comment,
  isResolved: boolean,
): Promise<void> => {
  const refusal = await resolveThread(forgeRun(runOf($), repo), typed, root.thread ?? '', isResolved)

  if (refusal !== '') {
    $.ui.toast(refusal, { timeoutMs: 10_000 })

    return
  }

  if (commentsCache !== undefined && commentsCache.key === `${repo}\n${typed}`) {
    for (const one of commentsCache.comments) {
      if (one.id === root.id || one.replyTo === root.id) {
        one.isResolved = isResolved
      }
    }
  }

  $.ui.toast(isResolved ? 'Thread resolved' : 'Thread reopened')
  // The file screen reads the source's stamp: a new one redraws it.
  await update($, source, last => ({ ...last, stamp: last.stamp + 1 }))
}

// Loads the file the pane asked for, when the module does not hold its lines.
const loadWanted = async ($: EngineInterface, path: string): Promise<void> => {
  const { repo, commit } = await read($, view)

  if (repo !== '') {
    await loadSource($, repo, path, commit ?? '')
  }
}

// The files a commit changed, with their line counts, for the graph screen.
const loadCommit = async ($: EngineInterface, repo: string, hash: string): Promise<void> => {
  const details = await git.commitDetails(runOf($), repo, hash)

  await update($, picked, () => details)
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  // What sessions leave on the machine is removed as one ends (not on a
  // /clear or a resume, where the process goes on): the exports of commits,
  // the refs requests were fetched under, the language servers' keeper.
  on('session.end', async ($, e, next) => {
    if (settings.cleansUp && e.reason !== 'clear' && e.reason !== 'resume') {
      const [{ repo }, list] = await Promise.all([read($, view), readRecents($)])

      await cleanUp(runOf($), [repo, ...list.map(one => one.repo)])
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lens',
      description: 'Review changed files with inline diagnostics: /lens [folder] [base ref]',
    })

    // A reload keeps the session's state but drops what the module held, so a
    // review already under way is scanned again with the code just loaded.
    if ((await read($, view)).repo !== '') {
      job = { isProject: false }
    }

    $.clock.every(400, () => {
      // A screen that draws its own window asked for the pane to be held one
      // row down (see `frame`): done here, once the screen has been drawn.
      if (wantPin) {
        wantPin = false
        void $.ui.scroll({ in: PANE, to: { key: 'pin' }, block: 'start' }).catch(() => undefined)
      }

      if (wanted !== undefined && !isLoading) {
        const path = wanted
        wanted = undefined
        isLoading = true
        void loadWanted($, path).finally(() => {
          isLoading = false
        })
      }

      // While a scan runs the busy mark turns: each step redraws its readers.
      if (isBusy) {
        void update($, spin, frame => (frame + 1) % SPINNER.length)
      }

      if (job === undefined || isBusy) {
        return
      }

      const taken = job
      job = undefined
      isBusy = true
      void runScan($, taken)
        .catch((error: unknown) =>
          update(
            $,
            scan,
            (last): Scan => ({
              ...last,
              status: 'done',
              pending: [],
              notes: [`The scan stopped on an error (${String(error)}). Press r to run it again`],
            }),
          ),
        )
        .finally(() => {
          isBusy = false
        })
    })

    return next(e)
  })

  on('command.run', { command: 'lens' }, async ($, e) => {
    const words = e.args.split(/\s+/).filter(word => word !== '')
    const isFolder = /^[~./]/.test(words[0] ?? '')
    const folder = isFolder ? (words[0] ?? '.') : '.'
    const base = isFolder ? words[1] : words[0]
    const repo = await git.findRepo(runOf($), folder)

    if (repo !== '') {
      return { text: await openReview($, repo, base) }
    }

    if (isFolder) {
      return {
        text: `/lens: ${folder} is not a folder inside a git repository. Check the path, or run /lens with no folder to pick a recent one.`,
      }
    }

    // Run where there is no repo, with none named: the pane opens on the
    // repos reviewed lately, to pick one.
    const list = await readRecents($)

    await update($, recents, () => list)
    await update($, view, () => NO_VIEW)
    await $.ui.open({ id: PANE, title: 'Lens', focus: true })

    return {
      text:
        list.length === 0
          ? 'This folder is not inside a git repository. Name one: /lens ~/Code/my-repo [base]'
          : 'This folder is not inside a git repository: pick a recent one in the pane, or name one (/lens ~/Code/my-repo).',
    }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await noteEdit($, e.file_path)

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await noteEdit($, e.file_path)

    return ran
  })

  // The file and graph screens draw their own window, so the person's wheel
  // and scroll keys move that window's first line and the engine's stays put.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const now = await read($, view)

    if (e.origin.kind !== 'person' || now.screen === 'tree' || now.screen === 'list') {
      return next(e)
    }

    // The list of keys is a page of the pane's own to scroll.
    if (now.isHelp ?? false) {
      return next(e)
    }

    // A rendered markdown file is a page of the pane's own to scroll.
    if (
      now.screen === 'file' &&
      isMarkdownFile(now.file) &&
      (now.isPreview ?? true) &&
      !(now.isDiff ?? false)
    ) {
      return next(e)
    }

    if (now.screen === 'graph') {
      // A tick with the pointer over the opened commit's body scrolls that
      // body; anywhere else, and from the keys, it scrolls the history.
      const { header, kinds, maxTop, bodyMax } = graphWindow
      const isOverBody =
        e.pointer !== undefined && kinds[e.pointer.row - header] === 'body' && bodyMax > 0

      await update($, view, last =>
        isOverBody
          ? { ...last, bodyTop: clamp((last.bodyTop ?? 0) + e.by, 0, bodyMax) }
          : { ...last, graphTop: clamp((last.graphTop ?? 0) + e.by, 0, maxTop) },
      )

      return {}
    }

    // A tick with the pointer over the breadcrumb's open list scrolls the list.
    const box = (now.crumb?.kind ?? 'none') === 'none' ? undefined : fileWindow.crumbBox

    if (
      box !== undefined &&
      e.pointer !== undefined &&
      e.pointer.row >= box.from &&
      e.pointer.row <= box.to
    ) {
      await update($, view, last => ({
        ...last,
        crumb: { ...(last.crumb ?? NO_CRUMB), top: clamp(box.top + e.by, 0, box.max) },
      }))

      return {}
    }

    await update($, view, last => ({
      ...last,
      top: clamp((last.top ?? 1) + e.by, 1, fileWindow.maxTop),
    }))

    return {}
  })

  // Builds the model and the actions of the screen the person is on, and has
  // that screen draw them. A model is plain data read here; an action is a
  // closure over this drawing's handle. Nothing here writes state: the
  // actions do, when they are pressed.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = kitOf($.ui.resolve(e))
    const { Text } = kit
    const now = settledView(await read($, view))
    const stored = await read($, scan)
    const found = settledScan(stored)

    if (now.repo === '') {
      return frame(
        kit,
        false,
        settings.sidePadding,
        recentsScreen(
          kit,
          { recents: await read($, recents), now: await $.clock.now() },
          {
            open: one => void openReview($, one.repo, undefined),
            forget: one => void forgetReview($, one.repo),
          },
        ),
      )
    }

    const { repo, target } = now
    const history = historyOf(repo)
    const compared = comparisonOf(now, found, history)
    const { isComparing, requestTyped } = compared
    // The request's comments, as the forge has them, on the files of the
    // folder under review: a forge's paths are from the repo's root, the
    // pane's from that folder. A comment on the request as a whole keeps its
    // empty path.
    const reviewed =
      requestTyped !== '' && commentsCache?.key === `${repo}\n${requestTyped}`
        ? commentsCache
        : undefined
    const comments = (reviewed?.comments ?? []).flatMap(one =>
      one.path === ''
        ? [one]
        : one.path.startsWith(reviewed?.prefix ?? '')
          ? [{ ...one, path: one.path.slice((reviewed?.prefix ?? '').length) }]
          : [],
    )
    // The comparison border takes a cell on each side, which the screens that
    // size their own window leave out of their width and height.
    const inset = isComparing ? 2 : 0
    // While a scan runs: a mark that turns. Reading its frame subscribes the
    // drawing only then, so an idle pane stays still.
    const busyMark =
      found.status === 'running' ? (SPINNER[(await read($, spin)) % SPINNER.length] ?? '') : ''
    const inChanged = changedDiags(found)

    // A scan from before the line counts and graph existed has neither: ask
    // for a fresh one, which the timer picks up.
    if (stored.stats === undefined && found.status !== 'running') {
      job ??= { isProject: false }
    }

    const shell: Shell = {
      columns: (e.props.bodyColumns ?? 80) - inset - 2 * settings.sidePadding,
      rows: (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - inset,
      inset,
      padding: settings.sidePadding,
      repoName: repo.split('/').pop() ?? '',
      // git lists the main checkout first; any other is a worktree of it.
      worktreeOf:
        found.worktrees.length > 1 && found.worktrees[0]?.isCurrent === false
          ? (found.worktrees[0].path.split('/').pop() ?? '')
          : '',
      headName: compared.headName,
      side: compared.side,
      against: compared.against,
      request: compared.request,
      isComparing,
      isScanning: found.status === 'running',
      busyMark,
      pending: found.pending,
      checked: found.checked,
      toCheck: found.toCheck,
      // Shown while the language server reads the open file: its colours,
      // outline and hints come after the file itself.
      working:
        now.screen === 'file' && insightFor === now.file && now.commit === ''
          ? 'language server reading this file…'
          : '',
      isProjectChecked: found.isProjectChecked,
      notes: found.notes,
      totals: totalsOf(found, inChanged),
    }
    // A screen that draws its own window (`isOwn`) needs the pane held one
    // row down (see `frame`): asked for here, done by the timer once the
    // screen has been drawn.
    const framed = (screen: RenderChildren, isOwn = false) => {
      if (isOwn) {
        wantPin = (e.props.scroll?.offset ?? 1) !== 1
      }

      return frame(kit, isComparing, settings.sidePadding, screen, isOwn)
    }

    // What several screens' actions are made of.
    const set = (change: (last: View) => View): void => void update($, view, change)
    const rescan = (): void => {
      job = { isProject: false }
    }
    const help = (): void => set(last => ({ ...last, isHelp: true }))

    if (now.isHelp) {
      return framed(
        helpScreen(kit, shell, now.screen, {
          close: () => set(last => ({ ...last, isHelp: false })),
        }),
      )
    }

    // Opens a file of the working tree at a line: a definition, a use, an
    // outline entry. A library's file is read from where it is installed,
    // outside what git tracks.
    const openAt = async (path: string, line: number): Promise<void> => {
      await loadSource($, repo, path)
      await update(
        $,
        view,
        (last): View => ({
          ...last,
          screen: 'file',
          file: path,
          commit: '',
          origin: 'tree',
          top: Math.max(1, line - 3),
          cursor: -1,
          isDiff: false,
          isPreview: false,
          symbol: NO_SYMBOL,
          crumb: NO_CRUMB,
        }),
      )
    }

    if (now.screen === 'list') {
      const shown = await read($, listing)

      return framed(
        listScreen(kit, shell, shown, {
          back: () => set((last): View => ({ ...last, screen: last.listBack ?? 'file' })),
          sendList: () => void sendToComposer($, shown.prompt),
          open: (path, line) => void openAt(path, line),
          help,
        }),
      )
    }

    // What the graph and the file tree both offer: a commit or a stash
    // opened under its row, a file of it opened as it left it, and a stash
    // brought back.
    const chosen = settledPicked(await read($, picked))
    const openCommitFile = async (id: string, path: string): Promise<void> => {
      await loadSource($, repo, path, id)
      await update(
        $,
        view,
        (last): View => ({
          ...last,
          screen: 'file',
          file: path,
          commit: id,
          // Where back returns to: the screen the file was opened from.
          origin: last.screen === 'tree' ? 'tree' : 'graph',
          top: 1,
          cursor: -1,
          isDiff: true,
        }),
      )
    }
    const pick = (id: string): void => {
      if (now.selected !== id) {
        void loadCommit($, repo, id)
      }

      set(last => ({
        ...last,
        selected: last.selected === id ? '' : id,
        bodyTop: 0,
      }))
    }

    if (now.screen === 'graph') {
      const drawn = graphScreen(
        kit,
        {
          shell,
          rows: history,
          stashes: found.stashes,
          worktrees: found.worktrees,
          requests: requestsCache?.repo === repo ? requestsCache.list : [],
          branches: found.branches,
          head: found.head,
          headHash: found.headHash,
          base: now.base,
          hasTarget: target !== '',
          selected: now.selected,
          picked: chosen,
          bodyTop: now.bodyTop,
          top: now.graphTop,
          isUndoing: now.isUndoing,
          undoNote: now.undoNote,
          isPicking: now.isPicking,
          pickA: now.pickA,
          pickB: now.pickB,
          pickField: now.pickField,
        },
        {
          back: () =>
            // Reached from a file's blame, back returns to that file,
            // where it was; otherwise to the file tree.
            set(
              (last): View =>
                (last.backFile ?? '') === ''
                  ? { ...last, screen: 'tree' }
                  : {
                      ...last,
                      screen: 'file',
                      file: last.backFile,
                      commit: last.backCommit ?? '',
                      top: last.backTop ?? 1,
                      selected: '',
                      backFile: '',
                    },
            ),
          help,
          refresh: rescan,
          scrollTo: line => set(last => ({ ...last, graphTop: line })),
          open: pick,
          openFile: (id, path) => void openCommitFile(id, path),
          applyStash: ref => void applyStash($, repo, ref, false),
          popStash: ref => void applyStash($, repo, ref, true),
          compareWith: hash => {
            rescan()
            set(
              (last): View => ({
                ...last,
                base: hash,
                target: '',
                baseWorktree: '',
                screen: 'tree',
                selected: '',
              }),
            )
          },
          checkOutBranch: name => void checkOut($, repo, name, true),
          checkOutCommit: hash => void checkOut($, repo, hash, false),
          askUndo: () => void askUndo($, repo),
          undo: () => void undoCommit($, repo),
          keepCommit: () => set(last => ({ ...last, isUndoing: false })),
          toggleCompare: () => {
            if (!now.isPicking) {
              void loadRequests($, repo)
            }

            set(
              (last): View => ({
                ...last,
                isPicking: !now.isPicking,
                // It opens on the comparison in force, ready to change.
                pickA: last.target ?? '',
                pickB: isComparing ? last.base : '',
                pickField: 'b',
              }),
            )
          },
          cancelCompare: () => set((last): View => ({ ...last, isPicking: false })),
          typeCompare: (field, text) =>
            set(
              (last): View =>
                field === 'a'
                  ? { ...last, pickA: text, pickField: 'a' }
                  : { ...last, pickB: text, pickField: 'b' },
            ),
          takeOffer: value =>
            set(
              (last): View =>
                now.pickField === 'a'
                  ? { ...last, pickA: value, pickField: 'b' }
                  : { ...last, pickB: value },
            ),
          compare: (side, against) => void startCompare($, repo, side, against),
          switchWorktree: path => {
            $.ui.toast(`Now reviewing the worktree ${path.split('/').pop() ?? ''}`, { timeoutMs: 5000 })
            void openReview($, path, undefined)
          },
        },
      )

      graphWindow = drawn.window

      return framed(drawn.tree, true)
    }

    if (now.screen === 'tree') {
      const statusOf = new Map(found.files.map(one => [one.path, one.status]))
      // What "send issues" hands the prompt: the diagnostics the change
      // brought, or every one in the changed files where that is not known.
      const isFreshKnown = inChanged.some(diag => diag.isNew !== undefined)
      const sendable = isFreshKnown ? inChanged.filter(diag => diag.isNew === true) : inChanged
      const needTicks = () => $.ui.toast('Tick some files first (☐)')

      return framed(
        treeScreen(
          kit,
          {
            shell,
            files: found.files,
            stats: found.stats,
            dirty: found.dirty,
            diags: found.diags,
            isScanned: found.status === 'done',
            isQueued: path => isQueued(repo, path),
            layout: now.layout,
            toggled: now.toggled,
            checked: now.checked,
            isDiscarding: now.isDiscarding,
            isMore: now.isMore || settings.showsAllKeys,
            isBrowsing: now.isBrowsing,
            allFiles: now.isBrowsing ? allFilesOf(repo) : [],
            isTelling: now.isTelling,
            issuesToSend: sendable.length,
            comments,
            stashes: found.stashes,
            selected: now.selected,
            picked: chosen,
            bodyTop: now.bodyTop,
          },
          {
            refresh: rescan,
            checkProject: () => {
              job = { isProject: true }
            },
            switchLayout: () =>
              void update(
                $,
                view,
                (last): View => ({ ...last, layout: now.layout === 'tree' ? 'list' : 'tree' }),
              ).then(() => rememberReview($)),
            openGraph: () => set((last): View => ({ ...last, screen: 'graph', backFile: '' })),
            stopComparing: () => {
              rescan()
              set((last): View => ({ ...last, base: 'HEAD', target: '', baseWorktree: '' }))
            },
            toggleMore: () => set(last => ({ ...last, isMore: !(last.isMore ?? false) })),
            help,
            toggleAllFiles: () => {
              rescan()
              set(last => ({ ...last, isBrowsing: !now.isBrowsing }))
            },
            sendIssues: () =>
              sendable.length === 0
                ? $.ui.toast('There are no issues to send')
                : void sendToComposer(
                    $,
                    `${isFreshKnown ? 'New issues' : 'Issues'} in my changes (${sendable.length}):\n${issueList(sendable, ISSUES_SENT)}`,
                  ),
            toggleTelling: () => set(last => ({ ...last, isTelling: !(last.isTelling ?? false) })),
            // The language server of the first changed file it can read searches.
            searchNames: query =>
              void searchSymbols(
                $,
                repo,
                query,
                [...found.files.map(one => one.path), ...now.extra].find(hasNameSearch) ?? '',
              ),
            // From the file tree a file opens as the working tree has it, or,
            // while two commits are compared, as the target commit has it, in
            // the diff view.
            open: async path => {
              // A file the change does not touch has not been checked: opening
              // it asks for it to be, along with the last few opened the same
              // way.
              if (target === '' && !found.files.some(one => one.path === path)) {
                await update($, view, last => ({
                  ...last,
                  extra: [path, ...(last.extra ?? []).filter(one => one !== path)].slice(0, EXTRA_FILES),
                }))
                rescan()
              }

              await loadSource($, repo, path, target)
              await update(
                $,
                view,
                (last): View => ({
                  ...last,
                  screen: 'file',
                  file: path,
                  commit: target,
                  origin: 'tree',
                  top: 1,
                  cursor: -1,
                  // In a comparison a file opens on what differs.
                  isDiff: isComparing ? true : last.isDiff,
                }),
              )
            },
            toggleFolder: key =>
              set(last => ({
                ...last,
                toggled: (last.toggled ?? []).includes(key)
                  ? (last.toggled ?? []).filter(path => path !== key)
                  : [...(last.toggled ?? []), key],
              })),
            // A tick box ticks or unticks all its paths together.
            tick: paths =>
              set(last => {
                const held = new Set(last.checked ?? [])
                const isAll = paths.every(path => held.has(path))

                for (const path of paths) {
                  if (isAll) {
                    held.delete(path)
                  } else {
                    held.add(path)
                  }
                }

                return { ...last, checked: [...held] }
              }),
            tickOnly: paths => set(last => ({ ...last, checked: [...paths] })),
            typeMessage: text => {
              draft = text
            },
            typeDetails: text => {
              draftBody = text
            },
            commit: (paths, entered) =>
              paths.length === 0
                ? needTicks()
                : void commitFiles(
                    $,
                    repo,
                    paths,
                    entered?.message ?? draft,
                    entered?.details ?? draftBody,
                  ),
            stash: paths =>
              paths.length === 0 ? needTicks() : void stashFiles($, repo, paths, draft),
            askDiscard: paths =>
              paths.length === 0 ? needTicks() : set(last => ({ ...last, isDiscarding: true })),
            // What a discard does to a file depends on what git has of it:
            // tracked, added but never committed, or not tracked at all.
            discard: paths =>
              void discardFiles(
                $,
                repo,
                paths.filter(path => !['?', 'A'].includes(statusOf.get(path) ?? '')),
                paths.filter(path => statusOf.get(path) === 'A'),
                paths.filter(path => statusOf.get(path) === '?'),
              ),
            keepChanges: () => set(last => ({ ...last, isDiscarding: false })),
            openStash: pick,
            openStashFile: (ref, path) => void openCommitFile(ref, path),
            scrollBody: line => set(last => ({ ...last, bodyTop: line })),
            applyStash: ref => void applyStash($, repo, ref, false),
            popStash: ref => void applyStash($, repo, ref, true),
          },
        ),
      )
    }

    // Reading the source subscribes the drawing: a load changes its stamp.
    const shown = await read($, source)
    // '' is the working tree's file; a hash is the file as that commit left it.
    const { file, commit } = now
    const held = cache !== undefined && cache.path === file && cache.commit === commit ? cache : undefined
    const lines = held?.lines

    if (lines === undefined) {
      wanted = file
    }

    const lineCount = lines?.length ?? 0
    const texts = (lines ?? []).map(spans => spans.map(span => span[1]).join(''))
    // The checkers ran on the working tree (or, between two commits, on the
    // target), so a file at any other commit has no diagnostics.
    const isChecked = commit === '' || commit === target
    const diags = isChecked ? diagsOf(found.diags, file) : []
    // A file the other side does not have is new from its first line to its last.
    const fileStatus = (isChecked ? found.files : chosen.files).find(one => one.path === file)?.status
    // Where back returns: a commit's file was opened from the graph or the
    // file tree, the working tree's from the file tree.
    const back = (): void =>
      set(
        (was): View => ({
          ...was,
          screen: commit === '' ? 'tree' : (was.origin ?? 'graph'),
          commit: '',
        }),
      )
    const { Markdown } = kit

    // Markdown shows rendered unless the person asked for its source or its diff.
    if (Markdown !== undefined && isMarkdownFile(file) && now.isPreview && !now.isDiff && lines !== undefined) {
      return framed(
        markdownScreen(
          { ...kit, Markdown },
          { shell, file, commit, text: texts.join('\n') },
          {
            back,
            help,
            showSource: () => set(was => ({ ...was, isPreview: false })),
            showDiff: () => set(was => ({ ...was, isDiff: true })),
            sendSelection: () =>
              void $.ui.selection().then(selected =>
                selected === undefined || selected.text.trim() === ''
                  ? $.ui.toast('Nothing is selected: drag over some text first')
                  : sendToComposer($, quoteBlock(file, selected.text)),
              ),
          },
        ),
      )
    }

    // The blame column: who last changed each line, where it has been asked
    // for and still belongs to the file as shown.
    const blame =
      now.isBlame &&
      blameCache !== undefined &&
      blameCache.path === file &&
      blameCache.commit === commit &&
      // git counts a file's lines; the file screen also counts the empty one
      // after a final newline. An empty list is a file with no history.
      (blameCache.lines.length === 0 || Math.abs(blameCache.lines.length - lineCount) <= 1)
        ? blameCache.lines
        : undefined
    // What the language server added for this file, once it has answered.
    const info = insight !== undefined && insight.path === file && commit === '' ? insight : undefined
    // Only the request's own head version of a file can be commented on.
    const canComment = reviewed !== undefined && commit === target
    const isCommenting = now.isCommenting && canComment
    const symbol = now.symbol.file === file ? now.symbol : undefined
    const talk = commit === target ? comments.filter(one => one.path === file && one.line > 0) : []
    // The first comment of the thread on a line: what a reply answers and
    // what resolving settles. A reply is listed under the comment it answers.
    const rootOn = (n: number): Comment | undefined => {
      const first = talk.find(one => one.line === n)

      return first === undefined || first.replyTo === undefined
        ? first
        : (talk.find(one => one.id === first.replyTo) ?? first)
    }
    const drawn = fileScreen(
      kit,
      {
        shell,
        file,
        commit,
        isChecked,
        lines,
        texts,
        note: shown.note,
        removed: held?.removed ?? {},
        changed: commit === '' ? (found.changed[file] ?? []) : (held?.changed ?? []),
        isNewFile: fileStatus === '?' || fileStatus === 'A',
        diags,
        faded: commit === '' ? found.faded.filter(diag => diag.path === file) : [],
        blame,
        insight: info,
        top: now.top,
        cursor: now.cursor,
        isExpanded: now.isExpanded,
        isDiff: now.isDiff,
        isMore: now.isMore || settings.showsAllKeys,
        isHinting: now.isHinting,
        isFinding: now.isFinding,
        find: now.find,
        findAt: now.findAt,
        canComment,
        isCommenting,
        commentLine: now.commentLine,
        replyTo: now.replyTo,
        commentRound,
        talk,
        crumb: now.crumb,
        folder: crumbCache,
        symbol,
      },
      {
        back,
        help,
        refresh: rescan,
        toggleMore: () => set(was => ({ ...was, isMore: !now.isMore })),
        scrollTo: line => set(last => ({ ...last, top: line })),
        showIssue: (cursor, top) => set(last => ({ ...last, cursor, top })),
        nextChange: top =>
          top === undefined ? $.ui.toast('No more changes below') : set(last => ({ ...last, top })),
        toggleDiff: () => set(was => ({ ...was, isDiff: !was.isDiff })),
        toggleExpanded: () => set(was => ({ ...was, isExpanded: !was.isExpanded })),
        toggleBlame: () =>
          blame === undefined
            ? void loadBlame($, repo, file, commit)
            : set(was => ({ ...was, isBlame: false })),
        toggleHints: () =>
          // The hints are read with the rest of what the server knows
          // of the file, so switching them on reads that again.
          void update($, view, was => ({
            ...was,
            isHinting: !(was.isHinting ?? false),
          })).then(() => loadInsight($, repo, file)),
        showRendered: () => set(was => ({ ...was, isPreview: true, isDiff: false })),
        find: () =>
          // Open, it opens the field empty; already open, it puts the
          // keyboard back in the field to type another search.
          now.isFinding
            ? void $.ui.focus({ requestId: PANE, key: 'find-text' })
            : set(was => ({ ...was, isFinding: true, find: '', findAt: 0 })),
        typeFind: text => set(was => ({ ...was, find: text, findAt: 0 })),
        showMatch: (index, top) => set(last => ({ ...last, findAt: index, top })),
        leaveFindField: () => void $.ui.focus({ requestId: PANE, key: 'find-next' }),
        closeFind: () => set(was => ({ ...was, isFinding: false, find: '' })),
        pressLine: n =>
          // While commenting on a request, a line number picks the line
          // to comment on.
          isCommenting
            ? set(last => ({ ...last, commentLine: n, replyTo: '' }))
            : // The fold is the function or class the server says starts
              // here; without a server, what the indentation suggests.
              void sendToComposer(
                $,
                codeBlock(
                  file,
                  n,
                  (info === undefined ? undefined : foldOf(info.items, n))?.to ?? foldEnd(texts, n),
                  texts,
                ),
              ),
        sendIssues: n =>
          void sendToComposer(
            $,
            diagBlock(
              file,
              n,
              (diagsByLine(diags, lineCount).get(n) ?? []).map(({ diag }) => diag),
              texts,
            ),
          ),
        // A review thread goes with the code it is about: the function or
        // class that starts on its line, or else a few lines either side.
        sendTalk: n => {
          const fold = (info === undefined ? undefined : foldOf(info.items, n))?.to ?? foldEnd(texts, n)
          const [from, to] =
            fold > n ? [n, Math.min(fold, n + TALK_CODE)] : [Math.max(1, n - 3), Math.min(lineCount, n + 3)]

          void sendToComposer(
            $,
            // The request's label is what its header line starts with.
            talkBlock(
              compared.request.split(' → ')[0] ?? '',
              file,
              n,
              talk.filter(one => one.line === n),
              from,
              to,
              texts,
            ),
          )
        },
        // What the person last dragged over with the mouse, as a quoted block.
        sendSelection: async () => {
          const selected = await $.ui.selection()

          if (selected === undefined || selected.text.trim() === '') {
            $.ui.toast('Nothing is selected: drag over some code first')

            return
          }

          await sendToComposer($, quoteBlock(file, selected.text))
        },
        // Looks up the name the person dragged over: the pane cannot tell
        // where the pointer is inside a line, so the selection says which
        // name, and its first place on screen says where.
        lookUpSelection: async (from, to) => {
          const name = ((await $.ui.selection())?.text ?? '').trim()

          if (name === '' || name.includes('\n')) {
            $.ui.toast('Drag over one name first, then press t')

            return
          }

          const line = texts.findIndex((text, at) => at + 1 >= from && at + 1 <= to && text.includes(name))

          if (line === -1) {
            $.ui.toast(`"${name}" is not on screen`)

            return
          }

          await lookUp($, repo, file, line + 1, name)
        },
        closeLookup: () => set(was => ({ ...was, symbol: NO_SYMBOL })),
        listUses: () => void (symbol && listReferences($, repo, symbol)),
        listCallers: () => void (symbol && listCalls($, repo, symbol, 'incoming')),
        listCallees: () => void (symbol && listCalls($, repo, symbol, 'outgoing')),
        listImplementations: () => void (symbol && listImplementations($, repo, symbol)),
        openFile: (path, line) => void openAt(path, line),
        // Pressing a line's blame opens its commit in the graph, about where
        // it sits.
        openCommit: hash => {
          const at = history.findIndex(row => row.hash === hash)

          if (at === -1) {
            $.ui.toast(`${hash} is older than the graph reaches`)

            return
          }

          void loadCommit($, repo, hash)
          set(
            (last): View => ({
              ...last,
              screen: 'graph',
              commit: '',
              selected: hash,
              bodyTop: 0,
              graphTop: Math.max(0, at * 2 - 3),
              // Where the graph's back button returns to.
              backFile: last.file,
              backCommit: last.commit ?? '',
              backTop: last.top ?? 1,
            }),
          )
        },
        toggleFolder: (dir, left) =>
          now.crumb.kind === 'dir' && now.crumb.dir === dir
            ? set(was => ({ ...was, crumb: NO_CRUMB }))
            : void loadCrumb($, repo, dir, left),
        toggleNames: (level, left) =>
          set(
            (was): View => ({
              ...was,
              crumb:
                now.crumb.kind === 'symbol' && now.crumb.level === level
                  ? NO_CRUMB
                  : { kind: 'symbol', dir: '', level, left, top: -1 },
            }),
          ),
        listFolder: (dir, left) => void loadCrumb($, repo, dir, left),
        closeCrumb: () => set(was => ({ ...was, crumb: NO_CRUMB })),
        jumpTo: line => set(was => ({ ...was, top: line, crumb: NO_CRUMB })),
        toggleCommenting: () =>
          set(was => ({
            ...was,
            isCommenting: !isCommenting,
            commentLine: 0,
            replyTo: '',
          })),
        replyOn: n => {
          const root = rootOn(n)

          if (root !== undefined) {
            set(was => ({ ...was, isCommenting: true, commentLine: n, replyTo: root.id }))
          }
        },
        resolveOn: (n, isResolved) => {
          const root = rootOn(n)

          if (root !== undefined) {
            void settleThread($, repo, requestTyped, root, isResolved)
          }
        },
        cancelComment: () => {
          commentDraft = ''
          commentRound += 1
          set(was => ({ ...was, commentLine: 0, replyTo: '' }))
        },
        typeComment: text => {
          commentDraft = text
        },
        postComment: entered => {
          const root = now.replyTo === '' ? undefined : rootOn(now.commentLine)

          if (root !== undefined) {
            void postReply($, repo, requestTyped, root, entered ?? commentDraft)

            return
          }

          void postReview(
            $,
            repo,
            requestTyped,
            target,
            file,
            now.commentLine,
            entered ?? commentDraft,
          )
        },
      },
    )

    fileWindow = drawn.window

    return framed(drawn.tree, true)
  })
}
