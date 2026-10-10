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

import type { LineRange, Listing, Lookup, Recent, Scan, Span, View, ChangedFile, LineStat } from '../types'
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
  threadsList,
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
import { findingComments, isFinding, placeOf } from './ledger'
import { hostOf, mediaOf, plain, plainBlock, sampleOf } from './media'
import type { Picture } from './pictures'
import { PICTURES_SHOWN, fetchPicture, isFetched, isPictureFile, localPicture } from './pictures'
import type { PatchFile } from './patch'
import { CONTEXT, CONTEXTS, applyHunk, hunkMark, readPatch } from './patch'
import type { Comment, Draft, Listed, Overview, RequestAct, Run as ForgeRun } from './review'
import {
  markViewed,
  readViewed,
  changeComment,
  fold,
  suggestionOf,
  unfold,
  whoAmI,
  actOnRequest,
  readOverview,
  draftComment,
  draftId,
  isDraft,
  submitDrafted,
  fetchComments,
  parseRequest,
  isOnWholeFile,
  postComment,
  postGeneral,
  quoteOf,
  listRequests,
  replyComment,
  requestOfBranch,
  repoPrefix,
  resolveRequest,
  resolveThread,
} from './review'
import type { Run } from './run'
import { tail } from './run'
import type { Job } from './scan'
import { allFilesOf, historyOf, isQueued, noteTouched, scanRepo } from './scan'
import type { FileWindow, Insight } from './screens/file'
import { FILE_COMMENT, fileScreen } from './screens/file'
import type { Shell } from './screens/frame'
import { COMMENT_COLOR, TOP_MARGIN, frame, kitOf, stateOf } from './screens/frame'
import type { GraphWindow } from './screens/graph'
import { graphScreen } from './screens/graph'
import { helpScreen } from './screens/help'
import { listScreen } from './screens/list'
import { isMarkdownFile, markdownScreen } from './screens/markdown'
import type { ChangesWindow } from './screens/changes'
import { changesScreen } from './screens/changes'
import { overviewScreen } from './screens/overview'
import { pictureScreen } from './screens/picture'
import { recentsScreen } from './screens/recents'
import { requestsScreen } from './screens/requests'
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
import { stepShown } from './changes'
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

// How the repo stood when it was last looked at (see `git.repoMark`), and
// the timer's count of ticks: every so many, `watchRepo` looks again.
let repoMarked: { repo: string; mark: string } | undefined
let ticks = 0
let isWatching = false
// Ticks of the 400 ms timer between two looks at the repo: about 4 seconds.
const WATCH_TICKS = 10

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
      // Where the first of each run of removed lines was, in the base.
      removedAt: Record<number, number>
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
// The same for the review being written in the file tree's box.
let reviewDraft = ''
let reviewRound = 0
// And for the comment on the request as a whole being written there.
let talkDraft = ''
let talkRound = 0

// How the language-server bridge runs its commands, made by `serverRun` from
// the first handle that needs it.
let servers: ServerRun | undefined

// What the language server knows of the file the file screen shows, written
// by `loadInsight` (and dropped by `loadSource` for a commit's file). Read
// after the file itself, so the file draws first and gains these.
let insight: ({ path: string } & Insight) | undefined
// The file `loadInsight` is reading for, while it is: the screen says so.
let insightFor: string | undefined

// Opens the pane on a file at a line, for another mod that names the place: a
// path that is absolute, or from the session's folder. The repository the
// file is in becomes the one under review, unless the folder under review
// already holds the file.
const showPlace = async ($: EngineInterface, named: string, line: number): Promise<void> => {
  const run = runOf($)
  const root = await $.session.cwd().catch(() => '')
  const full = placeOf(named, root)
  const now = await read($, view)
  let repo = now.repo !== '' && full.startsWith(`${now.repo}/`) ? now.repo : ''

  if (repo === '') {
    const top = await run(['git', '-C', full.replace(/\/[^/]*$/, ''), 'rev-parse', '--show-toplevel'])
    // Outside any repository, the session's folder is listed where it holds
    // the file.
    repo = top.exitCode === 0 ? top.stdout.trim() : root

    if (repo === '' || !full.startsWith(`${repo}/`)) {
      $.ui.toast(`Lens: ${named} is not in a git repository or this session's folder`)

      return
    }

    await openReview($, repo, undefined)
  }

  const path = full.slice(repo.length + 1)

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
  await $.ui.open({ id: PANE, title: 'Lens', focus: true })
}

// The ledger mod's run, where that mod is loaded: its findings are drawn with
// a request's comments.
const LEDGER_RUN = { plugin: 'ledger', key: 'run' } as const

// The comments on the pull or merge request under review, as the forge gave
// them, with the folder under review's place in the repo (`prefix`). Written
// by `loadComments`; `postReview` adds the comment it posted.
let commentsCache: { key: string; prefix: string; comments: Comment[] } | undefined

// The open request of the branch checked out, where it has one: its comments
// show on the working tree's files without a comparison being set up.
// Written by `findBranchRequest`, with each scan of the working tree.
let branchRequest:
  | {
      repo: string
      branch: string
      typed: string
      label: string
      // What it is called, the branch it targets, and when the forge said so.
      title: string
      baseRef: string
      url: string
      at: number
      // What the branch changes since it forked from that target, read
      // again with every scan: the commit it forked at, and the files.
      base: string
      files: ChangedFile[]
      stats: Record<string, LineStat>
    }
  | undefined

// The repo's open pull or merge requests, for the compare panel to offer.
// Written by `loadRequests`, when the panel opens.
let requestsCache: { repo: string; list: Listed[] } | undefined

// The whole comparison as one page, for the changes screen: what git said of
// the repo, base and target in `key`. Written by `loadPatch`, when that
// screen opens or is refreshed; `patchWanted` is the key being read.
// `staged` is the marks of the hunks the index holds (see `hunkMark`).
let patchCache: { key: string; files: PatchFile[]; refusal: string; staged: Set<string> } | undefined
// How many unchanged lines each file expanded on that page shows round its
// changes, by path, for the page in `key`; and how many each press adds.
let pageMore: { key: string; by: Map<string, number> } = { key: '', by: new Map() }
const MORE_STEP = 20
// The hunk whose undoing the page is asking about, by its name; '' for none.
let hunkAsked = ''
let patchWanted: string | undefined
// The files of that page as the highlighter coloured them, by path, and the
// ones asked for: written by `colorPage` as each stretch of the page is drawn.
let pageColors: { key: string; lines: Map<string, Span[][]>; asked: Set<string> } = {
  key: '',
  lines: new Map(),
  asked: new Set(),
}
// How many files are highlighted at a time, and how many times one is asked
// for before it is left plain; `colorTries` counts them, by page and path.
const COLORED_AT_ONCE = 3
const COLOR_TRIES = 3
const colorTries = new Map<string, number>()
// The changes screen's window as last drawn, for the scroll hook.
let pageWindow: ChangesWindow = { maxTop: 0 }

// The view with its count of asked-for drawings one higher: what a module
// value changing (a list read, a file coloured) writes to have the pane
// drawn again. A value written back unchanged is no change to draw for.
const nudged = (last: View): View => ({ ...last, redraws: (last.redraws ?? 0) + 1 })

// How many requests' ticks are kept between sessions.
const REVIEWED_KEPT = 40
// And how many ticked files of each.
const REVIEWED_PATHS = 2000
// How many lines of a request's description the file tree shows.
const ABOUT_LINES = 3
// The most comments one review holds unsent.
const DRAFTS_KEPT = 200

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
let fileWindow: FileWindow = { maxTop: 1, shown: undefined, crumbBox: undefined }
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

// The open file where it is a picture: itself and what it was before, each
// as a file the terminal draws, or undefined where there is none to draw.
let shot:
  | { path: string; commit: string; now: Picture | undefined; before: Picture | undefined; against: string }
  | undefined

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

  // A picture is not read as text: it is made a file the terminal draws,
  // and so is what it was on the other side, where it was a different one.
  if (isPictureFile(path)) {
    const { base, target, diffBase } = await read($, view)
    const own = commit === '' && diffBase?.path === path && diffBase.base !== '' ? diffBase.base : ''
    const other = commit === '' ? own || base || 'HEAD' : commit === target && base !== '' ? base : `${commit}^`
    const [now, was] = await Promise.all([localPicture(run, repo, path, commit), localPicture(run, repo, path, other)])

    shot = {
      path,
      commit,
      now,
      before: was !== undefined && was.file !== now?.file ? was : undefined,
      against: /^[0-9a-f]{40}$/.test(other) ? other.slice(0, 8) : other,
    }
    cache = { path, commit, lines: [], removed: {}, removedAt: {}, changed: undefined }
    insight = undefined
    const stamp = await $.clock.now()
    await update($, source, () => ({ path, lineCount: 0, note: '', stamp }))

    return
  }

  const committed = commit === '' ? undefined : await git.fileAt(run, repo, path, commit)
  const { lines, note } = await readSource(
    run,
    file => $.fs.read(file).catch(() => ''),
    repo,
    path,
    committed,
  )
  const { base, target, diffBase } = await read($, view)
  // A file of the branch's request is read against where the request forked.
  const own = commit === '' && diffBase?.path === path && diffBase.base !== '' ? diffBase.base : ''
  const diff = await git.fileDiff(run, repo, path, commit, own || base, target ?? '', own !== '')

  cache = { path, commit, lines, removed: diff.removed, removedAt: diff.removedAt, changed: diff.changed }
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
  // The ticks of the requests reviewed before come back with the review.
  void readReviewed($).then(reviewed => update($, view, (last): View => ({ ...last, reviewed })))
  // And the comments written for a review and not sent yet.
  void readDrafts($).then(drafts => update($, view, (last): View => ({ ...last, drafts })))
  await update($, scan, () => ({ ...NO_SCAN, status: 'running' }))
  job = { isProject: false }
  await $.ui.open({ id: PANE, title: 'Lens', focus: true })

  // A folder git does not know has nothing to compare: its files are listed.
  if ((await git.findRepo(runOf($), repo)) === '') {
    return `Listing ${repo}, which is not in a git repository: its code files are checked, and nothing is compared.`
  }

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

// Scans again when the repo has changed under the pane: a commit, a
// checkout, a merge, an edit or a stash made anywhere (Claude's own shell,
// another terminal, an editor). Only while the pane is open, and never
// while a scan is running or waiting.
const watchRepo = async ($: EngineInterface): Promise<void> => {
  const { repo } = await read($, view)

  if (repo === '' || isBusy || job !== undefined) {
    return
  }

  const open = await $.ui.panes().catch(() => [])

  if (!open.some(one => one.id === PANE)) {
    return
  }

  const mark = await git.repoMark(runOf($), repo)

  if (mark === '') {
    return
  }

  // The first look only notes how things stand: the scan that opened the
  // review has just read them.
  if (repoMarked !== undefined && repoMarked.repo === repo && repoMarked.mark !== mark) {
    job ??= { isProject: false }
  }

  repoMarked = { repo, mark }
}

// Runs one scan with this handle. The pipeline itself is in scan.ts; what
// it reads and writes of the session goes through the ports made here.
const runScan = async ($: EngineInterface, taken: Job): Promise<void> => {
  const now = await read($, view)

  // Every change of what is compared starts a scan, so this is where the
  // review is kept for next time.
  void rememberReview($)

  // With no request under review, the branch checked out may have one open:
  // its comments are then read as a request's are.
  const requestTyped =
    (now.target ?? '') !== '' && (now.requestTyped ?? '') !== ''
      ? now.requestTyped
      : (now.target ?? '') === ''
        ? await findBranchRequest($, now.repo)
        : ''

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
      requestTyped,
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
  { title, rows, prompt, commit }: Listing,
  notes: readonly string[],
): Promise<void> => {
  if (rows.length === 0) {
    $.ui.toast(notes[0] ?? `${title}: nothing found`, { timeoutMs: 6000 })

    return
  }

  await update($, listing, () => ({
    title,
    rows: rows.slice(0, LIST_ROWS),
    prompt,
    ...(commit === undefined ? {} : { commit }),
  }))
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
  (argv, timeoutMs = 60_000, stdin) =>
    run(argv, { cwd: repo, timeoutMs, ...(stdin === undefined ? {} : { stdin }) })

// How long what the forge said of a branch's request is taken as still so.
const BRANCH_REQUEST_MS = 5 * 60_000

// Finds the open request of the branch checked out, asking the forge at most
// once in a while for the same branch; '' when it has none.
const findBranchRequest = async ($: EngineInterface, repo: string): Promise<string> => {
  const run = runOf($)
  const branch = (await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim()
  const at = await $.clock.now()

  if (
    branchRequest === undefined ||
    branchRequest.repo !== repo ||
    branchRequest.branch !== branch ||
    at - branchRequest.at > BRANCH_REQUEST_MS
  ) {
    const found = await requestOfBranch(forgeRun(run, repo), branch)

    branchRequest = {
      repo,
      branch,
      typed: found?.typed ?? '',
      label: found?.label ?? '',
      title: found?.title ?? '',
      baseRef: found?.baseRef ?? '',
      url: found?.url ?? '',
      at,
      base: '',
      files: [],
      stats: {},
    }
  }

  // The forge's word is kept a while; what the branch changes is git's to
  // say, and a commit made since changes it.
  if (branchRequest.typed !== '' && branchRequest.baseRef !== '') {
    Object.assign(branchRequest, await git.requestChanges(run, repo, branchRequest.baseRef))
  }

  return branchRequest.typed
}

// Asks the forge for the repo's open requests and has the compare panel,
// which is already open, drawn again with them.
// The overview of the request under review, as the forge gave it, or why it
// did not. Written by `loadOverview`, when the overview screen opens.
let overviewCache: { key: string; overview: Overview | undefined; refusal: string } | undefined
let overviewWanted: string | undefined
// Who is signed in to the forge for a repo, by the name comments carry: read
// once for each, by `loadMe`, so the person's own comments can be told.
let meCache: { repo: string; me: string } | undefined
let meWanted = ''

const loadMe = async ($: EngineInterface, repo: string): Promise<void> => {
  meWanted = repo
  meCache = { repo, me: await whoAmI(forgeRun(runOf($), repo)) }
  await update($, view, nudged)
}
// The action on a request the overview is asking about before it is done
// (of which request, and which), and whether one is under way.
// The request being opened from the list, as it is typed; '' for none.
let requestOpening = ''
let requestAsked: { key: string; act: RequestAct | '' } = { key: '', act: '' }
let requestActing = false

// The pictures of descriptions, by their address: fetched (the file that
// holds each), being fetched, or not drawable. Held for the session, and
// held to a size: the oldest go when it is passed.
const pictureCache = new Map<string, Picture | 'loading' | 'none'>()
const PICTURES_KEPT = 200

// Lets the oldest pictures go once more are held than are kept.
const trimPictures = (): void => {
  if (pictureCache.size > PICTURES_KEPT) {
    for (const old of [...pictureCache.keys()].slice(0, pictureCache.size - PICTURES_KEPT)) {
      pictureCache.delete(old)
    }
  }
}

// How a request stands, in a few parts for a row of the file tree: its
// checks (the worst of them says how they stand), what its reviews come to,
// and whether it merges. Each part is the state that colours it, in the
// forge's own word, and the words to say.
const standingOf = (overview: Overview | undefined): [state: string, words: string][] => {
  if (overview === undefined) {
    return []
  }

  const marks = overview.checks.map(check => stateOf(check.state)[0])
  const failed = marks.filter(mark => mark === '✖').length
  const going = marks.filter(mark => mark === '●').length

  return [
    ...(overview.checks.length === 0
      ? [['NONE', 'no checks'] as [string, string]]
      : [
          failed > 0
            ? (['FAILURE', `${failed} of ${marks.length} checks fail`] as [string, string])
            : going > 0
              ? (['PENDING', `${going} of ${marks.length} checks running`] as [string, string])
              : (['SUCCESS', `${marks.length} ${marks.length === 1 ? 'check passes' : 'checks pass'}`] as [string, string]),
        ]),
    ...(overview.decision === ''
      ? []
      : [[overview.decision, overview.decision.toLowerCase().replace(/_/g, ' ')] as [string, string]]),
    ...(overview.mergeable === ''
      ? []
      : [[overview.mergeable, overview.mergeable.toLowerCase().replace(/_/g, ' ')] as [string, string]]),
  ]
}

const loadOverview = async ($: EngineInterface, repo: string, typed: string): Promise<void> => {
  const key = `${repo}\n${typed}`

  overviewWanted = key

  const answer = await readOverview(forgeRun(runOf($), repo), typed)

  if (overviewWanted === key) {
    overviewWanted = undefined
    overviewCache =
      'error' in answer
        ? { key, overview: undefined, refusal: plain(answer.error).slice(0, 300) }
        : { key, overview: answer.overview, refusal: '' }
    await update($, view, nudged)
  }
}

const loadRequests = async ($: EngineInterface, repo: string): Promise<void> => {
  requestsCache = { repo, list: await listRequests(forgeRun(runOf($), repo)) }
  await update($, view, nudged)
}

// Reads the whole comparison for the changes screen and has it drawn again.
const loadPatch = async (
  $: EngineInterface,
  repo: string,
  base: string,
  target: string,
  key: string,
  context: number,
  ignoresSpace: boolean,
): Promise<void> => {
  patchWanted = key

  // With the working tree's own changes, what the index holds is read
  // beside them, the same way, to say which hunks are staged.
  const [read, index] = await Promise.all([
    readPatch(runOf($), repo, base, target, { context, ignoresSpace }),
    target === '' && !ignoresSpace
      ? readPatch(runOf($), repo, base, '', { context, isStaged: true })
      : Promise.resolve({ files: [], refusal: '' }),
  ])

  // A comparison asked for since is the one that counts.
  if (patchWanted === key) {
    patchCache = {
      key,
      ...read,
      staged: new Set(index.files.flatMap(file => file.hunks.map(hunk => hunkMark(file, hunk)))),
    }
    patchWanted = undefined
    await update($, view, nudged)
  }
}

// Shows more of one file round its changes on the page of every change: the
// file is read again with more unchanged lines, and takes its place there.
const expandFile = async (
  $: EngineInterface,
  repo: string,
  base: string,
  target: string,
  key: string,
  path: string,
  ignoresSpace: boolean,
): Promise<void> => {
  const held = patchCache?.key === key ? patchCache : undefined
  const at = held?.files.findIndex(file => file.path === path) ?? -1

  if (held === undefined || at === -1) {
    return
  }

  const context = (pageMore.key === key ? (pageMore.by.get(path) ?? 0) : 0) + MORE_STEP

  if (pageMore.key !== key) {
    pageMore = { key, by: new Map() }
  }

  pageMore.by.set(path, context)

  const read = await readPatch(runOf($), repo, base, target, { context, ignoresSpace, paths: [path] })
  const [again] = read.files

  if (again !== undefined && patchCache === held) {
    held.files[at] = again
    await update($, view, nudged)
  }
}

// Highlights the files the changes screen has drawn and not yet coloured, a
// few at a time, drawing the page again as each few come in. A file is read
// as the comparison's new side has it: the target commit's, or the working
// tree's.
const colorPage = async (
  $: EngineInterface,
  key: string,
  repo: string,
  target: string,
  paths: readonly string[],
): Promise<void> => {
  if (pageColors.key !== key) {
    pageColors = { key, lines: new Map(), asked: new Set() }
  }

  const held = pageColors
  const wanted = paths.filter(path => !held.asked.has(path))

  for (const path of wanted) {
    held.asked.add(path)
  }

  const run = runOf($)

  for (let at = 0; at < wanted.length; at += COLORED_AT_ONCE) {
    await Promise.all(
      wanted.slice(at, at + COLORED_AT_ONCE).map(async path => {
        const { lines, note } = await readSource(
          run,
          file => $.fs.read(file).catch(() => ''),
          repo,
          path,
          undefined,
          target,
        )

        // Where the highlighter did not run there are no colours to add. It
        // may only have been slow to start (its first run, or a scan under
        // way beside it), so the file is asked for again a couple of times.
        if (note === '') {
          held.lines.set(path, lines)
        } else {
          const tries = (colorTries.get(`${key}\n${path}`) ?? 0) + 1

          colorTries.set(`${key}\n${path}`, tries)

          if (tries < COLOR_TRIES) {
            held.asked.delete(path)
          }
        }
      }),
    )

    if (pageColors === held) {
      await update($, view, nudged)
    }
  }
}

// The files ticked as reviewed, as the store keeps them between sessions.
const readReviewed = async ($: EngineInterface): Promise<Record<string, string[]>> => {
  const stored: unknown = await $.store.get('reviewed').catch(() => undefined)
  const kept: Record<string, string[]> = {}

  if (typeof stored === 'object' && stored !== null) {
    for (const [key, paths] of Object.entries(stored)) {
      if (Array.isArray(paths)) {
        kept[key] = paths
          .filter((path): path is string => typeof path === 'string')
          .slice(-REVIEWED_PATHS)
      }
    }
  }

  // What the store holds is held to the same limits as what is written.
  return Object.fromEntries(Object.entries(kept).slice(-REVIEWED_KEPT))
}

// The comments written for reviews and not sent yet, as the store keeps them
// between sessions: only what reads as a draft is taken.
const readDrafts = async ($: EngineInterface): Promise<View['drafts']> => {
  const stored: unknown = await $.store.get('drafts').catch(() => undefined)
  const kept: View['drafts'] = {}

  if (typeof stored === 'object' && stored !== null) {
    for (const [key, list] of Object.entries(stored).slice(-REVIEWED_KEPT)) {
      if (Array.isArray(list)) {
        kept[key] = list.flatMap((one: unknown): Draft[] => {
          const draft = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>

          return typeof draft.id === 'string' &&
            typeof draft.path === 'string' &&
            typeof draft.line === 'number' &&
            typeof draft.body === 'string'
            ? [
                {
                  id: draft.id,
                  path: draft.path,
                  line: draft.line,
                  body: draft.body,
                  ...(typeof draft.startLine === 'number' ? { startLine: draft.startLine } : {}),
                  ...(typeof draft.oldLine === 'number' ? { oldLine: draft.oldLine } : {}),
                },
              ]
            : []
        })
      }
    }
  }

  return kept
}

// Changes a request's drafts, here and in the store. A request left with
// none is dropped, and the oldest give way as the reviewed ticks do.
const changeDrafts = async (
  $: EngineInterface,
  key: string,
  change: (list: readonly Draft[]) => Draft[],
): Promise<void> => {
  await update($, view, (last): View => {
    const { [key]: held = [], ...rest } = last.drafts ?? {}
    const list = change(held).slice(-DRAFTS_KEPT)

    return {
      ...last,
      drafts: Object.fromEntries(
        [...Object.entries(rest), ...(list.length === 0 ? [] : [[key, list] as const])].slice(-REVIEWED_KEPT),
      ),
    }
  })
  await $.store.set('drafts', (await read($, view)).drafts ?? {}).catch(() => undefined)
}

// Ticks or unticks a file of a request as reviewed, here and in the store.
// The request last ticked is kept last, and the oldest give way.
// The request whose "viewed" marks the forge keeps, once they have been
// read: its id there, and the folder under review's place in the repo. An
// empty id is a forge that keeps none (the ticks are then the pane's own).
let viewedCache: { key: string; id: string; prefix: string } | undefined
let viewedWanted = ''

// Reads the files the person has marked as viewed on the forge, and makes
// them the request's ticks: the forge's word is the one that counts, since
// it is what the request's own page shows.
const loadViewed = async ($: EngineInterface, repo: string, typed: string, key: string): Promise<void> => {
  viewedWanted = key

  const run = forgeRun(runOf($), repo)
  const [seen, prefix] = await Promise.all([readViewed(run, typed), repoPrefix(run)])

  viewedCache = { key, id: seen?.id ?? '', prefix }

  if (seen !== undefined) {
    const paths = seen.viewed
      .filter(path => path.startsWith(prefix))
      .map(path => path.slice(prefix.length))
      .slice(-REVIEWED_PATHS)

    await update($, view, (last): View => {
      const { [key]: _held, ...rest } = last.reviewed ?? {}

      return {
        ...last,
        reviewed: Object.fromEntries([...Object.entries(rest), [key, paths]].slice(-REVIEWED_KEPT)),
      }
    })
    await $.store.set('reviewed', (await read($, view)).reviewed ?? {}).catch(() => undefined)
  }
}

const toggleReviewed = async ($: EngineInterface, key: string, path: string): Promise<void> => {
  await update($, view, (last): View => {
    const { [key]: held = [], ...rest } = last.reviewed ?? {}
    const paths = (
      held.includes(path) ? held.filter(one => one !== path) : [...held, path]
    ).slice(-REVIEWED_PATHS)

    return {
      ...last,
      reviewed: Object.fromEntries([...Object.entries(rest), [key, paths]].slice(-REVIEWED_KEPT)),
    }
  })
  await $.store.set('reviewed', (await read($, view)).reviewed ?? {}).catch(() => undefined)
}

// Marks several files of a request as reviewed, or as not, in one go.
const setReviewed = async (
  $: EngineInterface,
  key: string,
  paths: readonly string[],
  isOn: boolean,
): Promise<void> => {
  const named = new Set(paths)

  await update($, view, (last): View => {
    const { [key]: held = [], ...rest } = last.reviewed ?? {}
    const kept = held.filter(one => !named.has(one))

    return {
      ...last,
      reviewed: Object.fromEntries(
        [...Object.entries(rest), [key, (isOn ? [...kept, ...paths] : kept).slice(-REVIEWED_PATHS)]].slice(-REVIEWED_KEPT),
      ),
    }
  })
  await $.store.set('reviewed', (await read($, view)).reviewed ?? {}).catch(() => undefined)
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
  // The first line, when the comment is on several (`line` is the last).
  from = 0,
  // The removed line it is on, by its number in the other side (`line` is
  // then 0); 0 for a comment on this side.
  old = 0,
): Promise<void> => {
  if (body.trim() === '') {
    $.ui.toast('Type the comment first')

    return
  }

  const run = forgeRun(runOf($), repo)
  // With no target, the request is the checked-out branch's: its head is HEAD.
  const [head, prefix] = await Promise.all([
    git.fullHash(runOf($), repo, target === '' ? 'HEAD' : target),
    repoPrefix(run),
  ])
  const answer = await postComment(
    run,
    typed,
    {
      path: `${prefix}${path}`,
      line,
      commit: head,
      ...(from > 0 && from < line ? { startLine: from } : {}),
      ...(old > 0 ? { oldLine: old } : {}),
    },
    unfold(body.trim()),
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
  $.ui.toast(line === 0 ? `Comment posted on ${path}` : `Comment posted on line ${line}`)
  await update($, view, last => ({ ...last, commentLine: 0, commentFrom: 0, commentOld: 0 }))
}

// Answers the thread whose first comment is `root`, on the forge.
const postReply = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  root: Comment,
  body: string,
): Promise<void> => {
  if (isFinding(root)) {
    $.ui.toast('A ledger finding has no thread to answer: send it to the prompt instead')

    return
  }

  if (body.trim() === '') {
    $.ui.toast('Type the reply first')

    return
  }

  const answer = await replyComment(forgeRun(runOf($), repo), typed, root, unfold(body.trim()))

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
  await update($, view, last => ({ ...last, commentLine: 0, commentFrom: 0, commentOld: 0, replyTo: '', editing: '' }))
}

// Marks the thread `root` starts as resolved, or open again, on the forge.
const settleThread = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  root: Comment,
  isResolved: boolean,
): Promise<void> => {
  if (isFinding(root)) {
    $.ui.toast('A ledger finding is closed in the ledger, once it is fixed')

    return
  }

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

// Submits a review of the request under review, and says how it went.
// Posts a comment on the request as a whole. `quoted` is the comment it
// answers, which it then starts by quoting: neither forge threads these, so
// that is how an answer says what it is to.
const sendTalk = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  quoted: Comment | undefined,
  body: string,
): Promise<void> => {
  if (body.trim() === '') {
    $.ui.toast('Type the comment first')

    return
  }

  const answer = await postGeneral(
    forgeRun(runOf($), repo),
    typed,
    `${quoted === undefined ? '' : quoteOf(quoted)}${unfold(body.trim())}`,
  )

  if ('error' in answer) {
    $.ui.toast(answer.error, { timeoutMs: 10_000 })

    return
  }

  if (commentsCache !== undefined && commentsCache.key === `${repo}\n${typed}`) {
    commentsCache.comments.push(answer.comment)
  }

  talkDraft = ''
  talkRound += 1
  $.ui.toast(quoted === undefined ? 'Comment posted' : `Replied to ${quoted.author}`)
  await update($, view, (last): View => ({ ...last, talkReply: '' }))
}

const sendReview = async (
  $: EngineInterface,
  repo: string,
  typed: string,
  verdict: 'approve' | 'request-changes' | 'comment',
  summary: string,
  // The request's head when it is not what is checked out ('' then).
  target = '',
): Promise<void> => {
  const run = forgeRun(runOf($), repo)
  const key = `${repo}\n${typed}`
  const drafts = (await read($, view)).drafts?.[key] ?? []
  // The comments written for the review go with it, on the request's head.
  const [commit, prefix] =
    drafts.length === 0
      ? ['', '']
      : await Promise.all([git.fullHash(runOf($), repo, target === '' ? 'HEAD' : target), repoPrefix(run)])
  const { refusal, sent } = await submitDrafted(run, typed, verdict, unfold(summary), { drafts, commit, prefix })

  // What reached the forge is no longer waiting, whether or not the rest did.
  if (sent.length > 0) {
    await changeDrafts($, key, list => list.filter(one => !sent.includes(one.id)))
  }

  if (refusal !== '') {
    $.ui.toast(refusal, { timeoutMs: 10_000 })

    return
  }

  reviewDraft = ''
  reviewRound += 1
  $.ui.toast(
    `${verdict === 'approve' ? 'Approved' : verdict === 'comment' ? 'Review sent' : 'Changes requested'}${sent.length === 0 ? '' : `, with ${sent.length} ${sent.length === 1 ? 'comment' : 'comments'}`}`,
  )
  await update($, view, last => ({ ...last, isReviewing: false }))
  // What was said shows among the request's comments on the next scan.
  job = { isProject: false }
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

      ticks += 1

      if (ticks % WATCH_TICKS === 0 && !isWatching) {
        isWatching = true
        void watchRepo($)
          .catch(() => undefined)
          .finally(() => {
            isWatching = false
          })
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
    const isRecent = words[0] === 'recent' && words.length === 1
    // A folder git does not know is opened too, to list its files.
    const repo = isRecent
      ? ''
      : (await git.findRepo(runOf($), folder)) || (await git.findFolder(runOf($), folder))

    if (repo !== '') {
      return { text: await openReview($, repo, base) }
    }

    if (isFolder) {
      return {
        text: `/lens: ${folder} is not a folder. Check the path, or run /lens recent to pick a recent one.`,
      }
    }

    // Asked for the repos reviewed lately (/lens recent), or run where the
    // folder cannot be read: the pane opens on them, to pick one.
    const list = await readRecents($)

    await update($, recents, () => list)
    await update($, view, () => NO_VIEW)
    await $.ui.open({ id: PANE, title: 'Lens', focus: true })

    return {
      text:
        list.length === 0
          ? 'Nothing has been reviewed lately. Name a folder: /lens ~/Code/my-repo [base]'
          : 'Pick a recent one in the pane, or name a folder (/lens ~/Code/my-repo).',
    }
  })

  // The parked mod, where it is loaded, asks for a place to be shown (a file
  // reference pressed on one of its items): the pane opens on that file at
  // that line, reviewing the repository the file is in.
  on('state.set', { plugin: 'parked', key: 'jump' }, async ($, e, next) => {
    const written = await next(e)
    const asked = e.value

    if (asked !== null && asked !== undefined && asked.path !== '') {
      void showPlace($, asked.path, asked.line).catch(() => undefined)
    }

    return written
  })

  // The ledger mod asks the same way, for the place of a finding.
  on('state.set', { plugin: 'ledger', key: 'jump' }, async ($, e, next) => {
    const written = await next(e)
    const asked = e.value

    if (asked !== null && asked !== undefined && asked.path !== '') {
      void showPlace($, asked.path, asked.line).catch(() => undefined)
    }

    return written
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

    // The screens as long as their lists are pages of the pane's own to scroll.
    if (
      e.origin.kind !== 'person' ||
      now.screen === 'tree' ||
      now.screen === 'list' ||
      now.screen === 'requests' ||
      now.screen === 'overview'
    ) {
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

    // The page of every change draws its own window too: the wheel and the
    // scroll keys move its first row.
    if (now.screen === 'changes') {
      await update(
        $,
        view,
        (last): View => ({ ...last, pageTop: clamp((last.pageTop ?? 0) + e.by, 0, pageWindow.maxTop) }),
      )

      return {}
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
      // In the changes-only view the window steps among the lines that show.
      top: clamp(
        fileWindow.shown === undefined
          ? (last.top ?? 1) + e.by
          : stepShown(fileWindow.shown, last.top ?? 1, e.by),
        1,
        fileWindow.maxTop,
      ),
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
    const { isComparing } = compared
    // The request whose comments show: the one under review, or else the
    // open request of the branch checked out.
    const ofBranch =
      target === '' && branchRequest?.repo === repo && branchRequest.branch === found.head
        ? branchRequest
        : undefined
    const requestTyped = compared.requestTyped || (ofBranch?.typed ?? '')
    const requestLabel = (compared.request.split(' → ')[0] ?? '') || (ofBranch?.label ?? '')
    // The request's comments, as the forge has them, on the files of the
    // folder under review: a forge's paths are from the repo's root, the
    // pane's from that folder. A comment on the request as a whole keeps its
    // empty path.
    const reviewed =
      requestTyped !== '' && commentsCache?.key === `${repo}\n${requestTyped}`
        ? commentsCache
        : undefined
    const requestComments = (reviewed?.comments ?? [])
      .flatMap(one =>
        one.path === ''
          ? [one]
          : one.path.startsWith(reviewed?.prefix ?? '')
            ? [{ ...one, path: one.path.slice((reviewed?.prefix ?? '').length) }]
            : [],
      )
      // What other people wrote is drawn as plain text: nothing in it that
      // a terminal would act on reaches the pane.
      .map(one => ({ ...one, author: plain(one.author), body: plainBlock(one.body) }))
    // The ledger mod's review findings, where it is loaded and has a run, join
    // them: each shows on its line as a thread does. Reading the run here
    // draws the pane again when it changes.
    const ledgerRun = await $.state.get(LEDGER_RUN).then(
      got => got.value,
      () => undefined,
    )
    const sessionRoot = await $.session.cwd().catch(() => '')
    // With a request under review, who the person is on the forge is asked
    // once, to tell their own comments by.
    if (requestTyped !== '' && meCache?.repo !== repo && meWanted !== repo) {
      void loadMe($, repo)
    }

    // And what the request says of itself is read once, for the file tree
    // to show its title and the first lines of its description.
    const aboutKey = `${repo}\n${requestTyped}`
    const aboutRequest = requestTyped !== '' && overviewCache?.key === aboutKey ? overviewCache : undefined

    if (requestTyped !== '' && aboutRequest === undefined && overviewWanted !== aboutKey) {
      void loadOverview($, repo, requestTyped)
    }

    // The comments written for the review and not sent yet are drawn where
    // they will sit, as comments of their own kind.
    const drafts = requestTyped === '' ? [] : (now.drafts[`${repo}\n${requestTyped}`] ?? [])
    const comments = [
      ...requestComments,
      ...drafts.map(draftComment),
      ...findingComments(
        ledgerRun,
        repo,
        sessionRoot,
        found.files.map(one => one.path),
      ),
    ]
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
      rows: (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - inset - TOP_MARGIN,
      inset,
      padding: settings.sidePadding,
      repoName: repo.split('/').pop() ?? '',
      isPlain: found.isPlain,
      // git lists the main checkout first; any other is a worktree of it.
      worktreeOf:
        found.worktrees.length > 1 && found.worktrees[0]?.isCurrent === false
          ? (found.worktrees[0].path.split('/').pop() ?? '')
          : '',
      headName: compared.headName,
      side: compared.side,
      against: compared.against,
      request: compared.request,
      reviewing: requestLabel,
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
    const framed = (screen: RenderChildren, isOwn = false, color?: string) => {
      if (isOwn) {
        wantPin = (e.props.scroll?.offset ?? 1) !== 1
      }

      return frame(kit, isComparing, settings.sidePadding, screen, isOwn, color)
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

    // Opens a file as a commit left it, at a line, on its diff.
    const openCommitAt = async (id: string, path: string, line: number): Promise<void> => {
      await loadSource($, repo, path, id)
      await update(
        $,
        view,
        (last): View => ({
          ...last,
          screen: 'file',
          file: path,
          commit: id,
          origin: 'tree',
          top: Math.max(1, line - 3),
          cursor: -1,
          isDiff: true,
          isPreview: false,
        }),
      )
    }
    // Every thread of the request under review, on the list screen.
    const listThreads = (): void =>
      void showList(
        $,
        { ...threadsList(requestLabel, comments), commit: target },
        ['This request has no review comments yet'],
      )

    if (now.screen === 'list') {
      const shown = await read($, listing)

      return framed(
        listScreen(kit, shell, shown, {
          back: () => set((last): View => ({ ...last, screen: last.listBack ?? 'file' })),
          sendList: () => void sendToComposer($, shown.prompt),
          // A request's threads sit on its head commit; anything else is a
          // place in the working tree.
          open: (path, line) =>
            void ((shown.commit ?? '') === ''
              ? openAt(path, line)
              : openCommitAt(shown.commit ?? '', path, line)),
          help,
        }),
      )
    }

    // The files of the request under review ticked as reviewed, and the
    // name they are kept under; '' with no request, when nothing is ticked.
    const seenKey = requestTyped === '' ? '' : `${repo}\n${requestTyped}`
    const seen = seenKey === '' ? [] : (now.reviewed[seenKey] ?? [])
    // Where the forge keeps "viewed" marks of its own (GitHub), they are
    // read once for the request and are what the ticks start as; a tick
    // made here is then made there too.
    if (seenKey !== '' && viewedCache?.key !== seenKey && viewedWanted !== seenKey) {
      void loadViewed($, repo, requestTyped, seenKey)
    }

    const markReviewed = (path: string): void => {
      if (seenKey === '') {
        return
      }

      const held = viewedCache?.key === seenKey ? viewedCache : undefined
      const isNowViewed = !seen.includes(path)

      void toggleReviewed($, seenKey, path)

      if (held !== undefined && held.id !== '') {
        void markViewed(forgeRun(runOf($), repo), requestTyped, held.id, `${held.prefix}${path}`, isNowViewed).then(
          refusal => {
            if (refusal !== '') {
              $.ui.toast(`Ticked here, but not on the forge: ${refusal}`, { timeoutMs: 8000 })
            }
          },
        )
      }
    }

    // A folder's tick: every file under it is marked, or every one unmarked,
    // here at once and on the forge one after another, with one word said
    // if the forge refused any.
    const markReviewedAll = (paths: readonly string[], isOn: boolean): void => {
      const todo = paths.filter(path => seen.includes(path) !== isOn)

      if (seenKey === '' || todo.length === 0) {
        return
      }

      const held = viewedCache?.key === seenKey ? viewedCache : undefined

      void (async () => {
        await setReviewed($, seenKey, todo, isOn)

        let refused = ''

        for (const path of held !== undefined && held.id !== '' ? todo : []) {
          refused ||= await markViewed(forgeRun(runOf($), repo), requestTyped, held?.id ?? '', `${held?.prefix ?? ''}${path}`, isOn)
        }

        if (refused !== '') {
          $.ui.toast(`Ticked here, but not all on the forge: ${refused}`, { timeoutMs: 8000 })
        }
      })()
    }

    if (now.screen === 'overview') {
      const key = `${repo}\n${requestTyped}`
      const held = overviewCache?.key === key ? overviewCache : undefined

      if (held === undefined && overviewWanted !== key && requestTyped !== '') {
        void loadOverview($, repo, requestTyped)
      }

      // The description's first pictures are fetched once each, from the
      // forge's own hosts alone, and drawn when they have come.
      const forge = hostOf(held?.overview?.url ?? '')
      const wantedPictures = mediaOf(held?.overview?.body ?? '')
        .filter(one => one.kind === 'image' && isFetched(one.url, forge))
        .slice(0, PICTURES_SHOWN)
        .filter(one => !pictureCache.has(one.url))

      for (const one of wantedPictures) {
        trimPictures()
        pictureCache.set(one.url, 'loading')
        void fetchPicture(runOf($), one.url, forge).then(picture => {
          pictureCache.set(one.url, picture ?? 'none')

          return update($, view, nudged)
        })
      }

      return framed(
        overviewScreen(
          kit,
          {
            shell,
            label: requestLabel,
            overview: held?.overview,
            refusal: requestTyped === '' ? 'No request is under review' : (held?.refusal ?? ''),
            pictures: pictureCache,
            now: await $.clock.now(),
            asking: requestAsked.key === key ? requestAsked.act : '',
            isActing: requestActing,
          },
          {
            // Back goes where the overview was opened from: the list of requests, or the file tree.
            back: () => {
              if (now.overviewFrom === 'requests' && requestsCache?.repo !== repo) {
                void loadRequests($, repo)
              }

              // Leaving the request's page this way, the tree is nobody's
              // next step: it has nothing behind it to go back to.
              set(
                (last): View => ({
                  ...last,
                  screen: last.overviewFrom === 'requests' ? 'requests' : 'tree',
                  codeFrom: 'tree',
                }),
              )
            },
            // On to the code: the files it changes, or every change on one page.
            openFiles: () => set((last): View => ({ ...last, screen: 'tree', codeFrom: 'overview' })),
            openChanges: () => {
              patchCache = undefined
              pageColors = { key: '', lines: new Map(), asked: new Set() }
              set((last): View => ({ ...last, screen: 'changes', pageTop: 0, codeFrom: 'overview' }))
            },
            refresh: () => {
              overviewCache = undefined
              set(nudged)
            },
            ask: act => {
              requestAsked = { key, act }
              set(nudged)
            },
            // Done only from the question's own yes: the action must be the
            // one asked about, of this request.
            act: act => {
              if (requestAsked.key !== key || requestAsked.act !== act || requestActing) {
                return
              }

              requestAsked = { key: '', act: '' }
              requestActing = true
              set(nudged)
              void actOnRequest(forgeRun(runOf($), repo), requestTyped, act)
                .then(refusal => {
                  $.ui.toast(
                    refusal !== ''
                      ? refusal
                      : `${requestLabel}: ${act === 'checkout' ? 'checked out' : act === 'ready' ? 'marked ready' : act === 'close' ? 'closed' : 'merged'}`,
                    { timeoutMs: refusal === '' ? 5000 : 12_000 },
                  )
                })
                .finally(() => {
                  requestActing = false
                  // What the forge and the working tree say now is read again.
                  overviewCache = undefined
                  job = { isProject: false }
                  void update($, view, nudged)
                })
            },
            // What has come in since the person last reviewed it: the
            // request's head against the commit that review was of.
            sinceReview: () => {
              const from = held?.overview?.lastReviewed ?? ''

              if (from === '') {
                $.ui.toast('You have not reviewed this request yet')
              } else if (target === '') {
                $.ui.toast('Open the request from the requests list (p) first, then compare')
              } else {
                void startCompare($, repo, target, from)
              }
            },
            help,
          },
        ),
      )
    }

    if (now.screen === 'requests') {
      const prefix = `${repo}\n`

      return framed(
        requestsScreen(
          kit,
          {
            shell,
            list: requestsCache?.repo === repo ? requestsCache.list : undefined,
            current: requestTyped,
            opening: requestOpening,
            reviewed: Object.fromEntries(
              Object.entries(now.reviewed)
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, paths]) => [key.slice(prefix.length), paths.length]),
            ),
            now: await $.clock.now(),
          },
          {
            back: () => set((last): View => ({ ...last, screen: 'tree', codeFrom: 'tree' })),
            refresh: () => {
              requestsCache = undefined
              void loadRequests($, repo)
              set(nudged)
            },
            // A request is a comparison by itself: its head against where it
            // forked, which the file tree then lists.
            //
            // Opened from the list, a request is first shown as what it is
            // (its title, what it says of itself, where it stands): the
            // overview, from which its files and its changes are a key
            // away. Where the request could not be opened, the list stays.
            //
            // One is opened at a time: the list gives way to the shape of
            // the page that is coming as soon as one is pressed, so there is
            // nothing left to press twice, and a press that does arrive
            // while one is being opened is dropped.
            open: typed => {
              if (requestOpening !== '') {
                return
              }

              requestOpening = typed
              set(nudged)
              void startCompare($, repo, '', typed)
                .then(async () => {
                  if ((await read($, view)).requestTyped === typed) {
                    overviewCache = undefined
                    await update($, view, (last): View => ({ ...last, screen: 'overview', overviewFrom: 'requests' }))
                  }
                })
                .finally(() => {
                  requestOpening = ''

                  return update($, view, nudged)
                })
            },
            help,
          },
        ),
      )
    }

    if (now.screen === 'changes') {
      // The branch's own request, with no comparison on, is read as the
      // request has it: from where the branch forked, to the files as they
      // stand.
      const isOfBranch = !isComparing && ofBranch !== undefined && ofBranch.base !== ''
      const pageBase = isOfBranch ? ofBranch.base : now.base
      const pageKey = `${repo}\n${pageBase}\n${target}\n${now.pageContext}\n${now.pageSpace}`
      const page = patchCache?.key === pageKey ? patchCache : undefined

      if (page === undefined && patchWanted !== pageKey) {
        void loadPatch($, repo, pageBase, target, pageKey, now.pageContext, now.pageSpace)
      }

      // A change is staged or undone a hunk at a time only where the page is
      // of the working tree against what is checked out, spaces and all: a
      // hunk read any other way is not one git takes back.
      const canStage =
        target === '' && !isComparing && !isOfBranch && !found.isPlain && !now.pageSpace && now.base === 'HEAD'

      const drawn = changesScreen(
          kit,
          {
            shell,
            top: now.pageTop,
            context: now.pageContext,
            ignoresSpace: now.pageSpace,
            colors: pageColors.key === pageKey ? pageColors.lines : new Map(),
            title: isOfBranch
              ? `${requestLabel}: your branch as it stands`
              : shell.request !== ''
                ? shell.request
                : isComparing
                  ? `${shell.side} vs ${shell.against}`
                  : 'Uncommitted changes',
            files: page?.files,
            refusal: page?.refusal ?? '',
            statusOf: new Map(
              [...(ofBranch?.files ?? []), ...found.files].map(one => [one.path, one.status]),
            ),
            comments: comments.filter(one => !(now.hidesResolved && one.isResolved === true)),
            canMark: seenKey !== '',
            reviewed: seen,
            untracked: found.files.filter(one => one.status === '?').length,
            isSplit: now.pageSplit,
            isFinding: now.pageFinding,
            find: now.pageFind,
            canStage,
            staged: page?.staged ?? new Set<string>(),
            asking: hunkAsked,
            isCommitting: now.pageCommitting && canStage,
          },
          {
            back: () => set((last): View => ({ ...last, screen: last.codeFrom === 'overview' ? 'overview' : 'tree' })),
            refresh: () => {
              rescan()
              patchCache = undefined
              pageColors = { key: '', lines: new Map(), asked: new Set() }
              set(nudged)
            },
            // A file opens as the comparison has it, and back returns here.
            open: (path, line) =>
              void (target === '' ? openAt(path, line) : openCommitAt(target, path, line)).then(() =>
                update($, view, (last): View => ({ ...last, origin: 'changes' })),
              ),
            toggleReviewed: markReviewed,
            scrollTo: row => set((last): View => ({ ...last, pageTop: row })),
            say: text => $.ui.toast(text),
            // More lines round each change, step by step and back round;
            // and lines that differ only in their spaces, left out or not.
            moreContext: () =>
              set((last): View => {
                const at = CONTEXTS.findIndex(step => step === (last.pageContext ?? CONTEXT))

                return { ...last, pageContext: CONTEXTS[(at + 1) % CONTEXTS.length] ?? CONTEXT }
              }),
            toggleSpace: () => set((last): View => ({ ...last, pageSpace: !(last.pageSpace ?? false) })),
            toggleSplit: () => set((last): View => ({ ...last, pageSplit: !(last.pageSplit ?? false) })),
            expand: path => void expandFile($, repo, pageBase, target, pageKey, path, now.pageSpace),
            toggleFind: () =>
              set((last): View => ({ ...last, pageFinding: !(last.pageFinding ?? false), pageFind: '' })),
            setFind: text => set((last): View => ({ ...last, pageFind: text.trim().slice(0, 200) })),
            ask: name => {
              hunkAsked = name
              set(nudged)
            },
            // A hunk is handed back to git as git wrote it: into the index,
            // out of it, or undone in the file. Undoing is done only from
            // its own question's yes.
            hunk: (path, index, how, mark) => {
              const file = page?.files.find(one => one.path === path)
              const hunk = file?.hunks[index]

              if (!canStage || file === undefined || hunk === undefined) {
                return
              }

              // The hunk acted on is the one whose button was pressed: where
              // the page has been read again since and that place holds
              // another, nothing is done.
              if (hunkMark(file, hunk) !== mark) {
                $.ui.toast('That change has moved since it was drawn: look again, then press')

                return
              }

              // And an undoing is of the very hunk that was asked about.
              if (how === 'discard' && hunkAsked !== mark) {
                return
              }

              hunkAsked = ''
              void applyHunk(runOf($), repo, file, hunk, how).then(refusal => {
                $.ui.toast(
                  refusal !== ''
                    ? `git did not ${how} it: ${refusal}`
                    : how === 'discard'
                      ? `That change is undone in ${path}`
                      : how === 'stage'
                        ? 'Staged'
                        : 'Taken back out of what is staged',
                  { timeoutMs: refusal === '' ? 3000 : 10_000 },
                )
                // The page is read again where it stands.
                patchCache = undefined
                pageMore = { key: '', by: new Map() }
                rescan()
                void update($, view, nudged)
              })
            },
            toggleCommit: () =>
              set((last): View => ({ ...last, pageCommitting: !(last.pageCommitting ?? false) })),
            // What is staged is committed as it is: no file is named, so
            // nothing but the index goes into the commit.
            commitStaged: message => {
              if (message.trim() === '') {
                $.ui.toast('Type what changed first')

                return
              }

              void runOf($)(['git', 'commit', '-m', unfold(message.trim())], { cwd: repo, timeoutMs: 60_000 }).then(
                done => {
                  $.ui.toast(
                    done.exitCode === 0
                      ? 'Committed what was staged'
                      : `git did not commit: ${(done.stderr || done.stdout).trim().split('\n').pop() ?? ''}`,
                    { timeoutMs: done.exitCode === 0 ? 4000 : 10_000 },
                  )

                  if (done.exitCode === 0) {
                    patchCache = undefined
                    rescan()
                    void update($, view, (last): View => ({ ...nudged(last), pageCommitting: false }))
                  }
                },
              )
            },
            help,
          },
        )

      pageWindow = drawn.window

      // The files in and just under the window are highlighted, where they
      // have not been.
      if (
        page !== undefined &&
        drawn.shown.some(path => pageColors.key !== pageKey || !pageColors.asked.has(path))
      ) {
        void colorPage($, pageKey, repo, target, drawn.shown)
      }

      return framed(drawn.tree, true)
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
      // The files listed are those whose path holds what the person typed
      // to narrow the lists by, whatever its case; all of them with nothing
      // typed.
      const wanted = now.filter.trim().toLowerCase()
      const isListed = (path: string): boolean => wanted === '' || path.toLowerCase().includes(wanted)

      return framed(
        treeScreen(
          kit,
          {
            shell,
            files: found.files.filter(one => isListed(one.path)),
            filter: now.filter,
            // Where b goes back to, when the files were opened from the
            // request's own page; '' for a tree that is nobody's next step.
            backTo: now.codeFrom === 'overview' && requestTyped !== '' ? plain(requestLabel).slice(0, 40) : '',
            about:
              requestTyped === ''
                ? undefined
                : {
                    // Whatever the forge said is drawn as plain text of a
                    // bounded length, whichever answer it came in.
                    label: plain(requestLabel).slice(0, 80),
                    title: plain(aboutRequest?.overview?.title ?? ofBranch?.title ?? '').slice(0, 300),
                    lines: sampleOf(aboutRequest?.overview?.body ?? '', ABOUT_LINES, Math.max(20, shell.columns - 4)),
                    isLoading: aboutRequest === undefined,
                    refusal: plain(aboutRequest?.refusal ?? '').slice(0, 300),
                    standing: standingOf(aboutRequest?.overview),
                  },
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
            isPlain: found.isPlain,
            isBrowsing: now.isBrowsing || found.isPlain,
            allFiles: now.isBrowsing || found.isPlain ? allFilesOf(repo).filter(isListed) : [],
            isTelling: now.isTelling,
            issuesToSend: sendable.length,
            comments,
            canMark: seenKey !== '',
            reviewed: seen,
            stashes: found.stashes,
            isReviewing: now.isReviewing,
            pending: drafts.length,
            reviewRound,
            talkOpen: now.talkOpen,
            talkReply: now.talkReply,
            talkRound,
            request:
              ofBranch === undefined || ofBranch.files.length === 0
                ? undefined
                : {
                    isGitlab: ofBranch.label.startsWith('MR'),
                    typed: ofBranch.typed,
                    url: ofBranch.url,
                    title: ofBranch.title,
                    files: ofBranch.files.filter(one => isListed(one.path)),
                    stats: ofBranch.stats,
                  },
            selected: now.selected,
            picked: chosen,
            bodyTop: now.bodyTop,
          },
          {
            refresh: rescan,
            listThreads,
            // A file of the branch's request opens as the working tree has
            // it, on what the request changes in it; one not edited here is
            // checked along with the rest from then on.
            openRequestFile: async path => {
              if (ofBranch === undefined) {
                return
              }

              const isListed = found.files.some(one => one.path === path)

              await update(
                $,
                view,
                (last): View => ({
                  ...last,
                  diffBase: { path, base: ofBranch.base, name: ofBranch.baseRef },
                  extra: isListed
                    ? (last.extra ?? [])
                    : [path, ...(last.extra ?? []).filter(one => one !== path)].slice(0, EXTRA_FILES),
                }),
              )

              if (!isListed) {
                rescan()
              }

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
                  top: 1,
                  cursor: -1,
                  isDiff: !isMarkdownFile(path),
                  isPreview: isMarkdownFile(path),
                }),
              )
            },
            toggleReviewing: () => {
              reviewDraft = ''
              reviewRound += 1
              set(last => ({ ...last, isReviewing: !now.isReviewing }))
            },
            typeReview: text => {
              reviewDraft = text
            },
            submitReview: (verdict, entered) =>
              void sendReview($, repo, requestTyped, verdict, entered ?? reviewDraft, target),
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
              set((last): View => ({ ...last, base: 'HEAD', target: '', baseWorktree: '', codeFrom: 'tree' }))
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
            setFilter: text => set((last): View => ({ ...last, filter: text.trim().slice(0, 200) })),
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
              if (target === '' && !found.isPlain && !found.files.some(one => one.path === path)) {
                await update($, view, last => ({
                  ...last,
                  extra: [path, ...(last.extra ?? []).filter(one => one !== path)].slice(0, EXTRA_FILES),
                }))
                rescan()
              }

              await update($, view, (last): View => ({ ...last, diffBase: NO_VIEW.diffBase }))
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
                  // In a comparison a file opens on what differs; markdown
                  // opens as it reads, its threads set into the page.
                  // Where git knows nothing of the folder, nothing differs.
                  isDiff:
                    isMarkdownFile(path) || found.isPlain ? false : isComparing ? true : last.isDiff,
                  isPreview: isMarkdownFile(path) ? true : last.isPreview,
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
            openOverview: () => {
              // Asked again each time it is opened: checks and reviews move.
              overviewCache = undefined
              set((last): View => ({ ...last, screen: 'overview', overviewFrom: 'tree' }))
            },
            // Back to what the request is, where its files were opened from
            // there: the overview as it was, which keeps where it came from.
            backToOverview: () => set((last): View => ({ ...last, screen: 'overview' })),
            openRequests: () => {
              void loadRequests($, repo)
              set((last): View => ({ ...last, screen: 'requests' }))
            },
            openChanges: () => {
              // Read again each time it is opened: the files may have changed.
              patchCache = undefined
              pageColors = { key: '', lines: new Map(), asked: new Set() }
              set((last): View => ({ ...last, screen: 'changes', pageTop: 0, codeFrom: 'tree' }))
            },
            toggleReviewed: markReviewed,
            markAll: markReviewedAll,
            openTalk: id => set((last): View => ({ ...last, talkOpen: id })),
            writeTalk: id => {
              talkDraft = ''
              talkRound += 1
              set((last): View => ({ ...last, talkReply: id }))
            },
            typeTalk: text => {
              talkDraft = text
            },
            postTalk: entered =>
              void sendTalk(
                $,
                repo,
                requestTyped,
                comments.find(one => one.id === now.talkReply && one.path === ''),
                entered ?? talkDraft,
              ),
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
          // A file opened from the page of every change goes back to it.
          screen: was.origin === 'changes' ? 'changes' : commit === '' ? 'tree' : (was.origin ?? 'graph'),
          commit: '',
        }),
      )
    const { Markdown } = kit

    // A picture is drawn as itself, beside what it was where it changed.
    if (isPictureFile(file)) {
      const drawn = shot !== undefined && shot.path === file && shot.commit === commit ? shot : undefined

      return framed(
        pictureScreen(
          kit,
          {
            shell,
            file,
            commit,
            isLoaded: held !== undefined && drawn !== undefined,
            now: drawn?.now,
            before: drawn?.before,
            against: drawn?.against ?? '',
          },
          { back, help, refresh: () => void loadSource($, repo, file, commit) },
        ),
      )
    }

    // The request's threads on this file's lines, for the rendered page.
    const pageTalk =
      commit === target
        ? comments.filter(
            one =>
              one.path === file &&
              one.line > 0 &&
              !(now.hidesResolved && one.isResolved === true),
          )
        : []

    // Markdown shows rendered unless the person asked for its source or its diff.
    if (Markdown !== undefined && isMarkdownFile(file) && now.isPreview && !now.isDiff && lines !== undefined) {
      return framed(
        markdownScreen(
          { ...kit, Markdown },
          { shell, file, commit, text: texts.join('\n'), talk: pageTalk },
          {
            back,
            help,
            showSource: () => set(was => ({ ...was, isPreview: false })),
            showDiff: () => set(was => ({ ...was, isDiff: true })),
            sendTalk: n =>
              void sendToComposer(
                $,
                talkBlock(
                  requestLabel,
                  file,
                  n,
                  pageTalk.filter(one => one.line === n),
                  Math.max(1, n - 3),
                  Math.min(lineCount, n + 3),
                  texts,
                ),
              ),
            // The source at the thread's line, on the diff, where the
            // thread's card has reply and resolve.
            openSource: n =>
              set(was => ({ ...was, isPreview: false, isDiff: true, top: Math.max(1, n - 3) })),
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
    // Whether the file's diff is against a base of its own (see `View.diffBase`).
    const isOwnDiff = commit === '' && now.diffBase.path === file && now.diffBase.base !== ''
    const talk =
      commit === target
        ? comments
            // A comment or a ledger finding on the file as a whole has no
            // line of its own: it is shown on the file's first, and says so.
            .map(one =>
              one.path === file && isOnWholeFile(one)
                ? { ...one, line: 1, body: `(whole file) ${one.body}` }
                : one,
            )
            // A comment on a removed line is shown under the removed lines
            // it is among: on the line of this side they are drawn before.
            .map(one => {
              const old = one.path === file && one.line === 0 ? (one.oldLine ?? 0) : 0
              const before =
                old === 0
                  ? undefined
                  : Object.entries(held?.removedAt ?? {}).find(
                      ([at, first]) => old >= first && old < first + (held?.removed[Number(at)]?.length ?? 0),
                    )?.[0]

              return before === undefined
                ? one
                : {
                    ...one,
                    line: clamp(Number(before), 1, Math.max(1, lineCount)),
                    body: `(removed line ${old}) ${one.body}`,
                  }
            })
            .filter(
              one =>
                one.path === file &&
                one.line > 0 &&
                // A resolved thread is left out where the person asked for that.
                !(now.hidesResolved && one.isResolved === true),
            )
        : []
    // The first comment of the thread on a line: what a reply answers and
    // what resolving settles. A reply is listed under the comment it answers.
    const rootOn = (n: number): Comment | undefined => {
      // A request's thread before a ledger finding on the same line: reply
      // and resolve are the thread's.
      const first =
        talk.find(one => one.line === n && !isFinding(one) && !isDraft(one)) ??
        talk.find(one => one.line === n && !isDraft(one))

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
        removedAt: held?.removedAt ?? {},
        changed:
          commit === '' && !isOwnDiff ? (found.changed[file] ?? []) : (held?.changed ?? []),
        diffAgainst: isOwnDiff ? now.diffBase.name : '',
        isNewFile: fileStatus === '?' || fileStatus === 'A',
        diags,
        faded: commit === '' ? found.faded.filter(diag => diag.path === file) : [],
        blame,
        insight: info,
        top: now.top,
        cursor: now.cursor,
        isExpanded: now.isExpanded,
        isDiff: now.isDiff,
        isChanges: now.isChanges,
        isMore: now.isMore || settings.showsAllKeys,
        isHinting: now.isHinting,
        isFinding: now.isFinding,
        find: now.find,
        findAt: now.findAt,
        canComment,
        isCommenting,
        commentLine: now.commentLine,
        commentFrom: now.commentFrom,
        commentOld: now.commentOld,
        me: meCache?.repo === repo ? meCache.me : '',
        editing: now.editing,
        deleting: now.deleting,
        draft: now.editing === '' ? '' : commentDraft,
        replyTo: now.replyTo,
        hidesResolved: now.hidesResolved,
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
        // Round the three views: the file, its diff, the diff cut down to
        // what differs.
        toggleDiff: () =>
          set(was =>
            !was.isDiff
              ? { ...was, isDiff: true, isChanges: false }
              : !(was.isChanges ?? false)
                ? { ...was, isChanges: true }
                : { ...was, isDiff: false, isChanges: false },
          ),
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
        // A removed line picked to comment on: the box opens under the line
        // of this side that those removed lines are drawn before.
        pressOldLine: (old, before) =>
          set(last => ({
            ...last,
            commentLine: clamp(before, 1, Math.max(1, lineCount)),
            commentFrom: 0,
            commentOld: old,
            replyTo: '',
            editing: '',
          })),
        pressLine: n =>
          // While commenting on a request, a line number picks the line
          // to comment on.
          // With the box already open on a line, a later line's number
          // stretches the comment down to it (the first line stays); the
          // first line's own number, or an earlier one, starts again there.
          isCommenting
            ? set(last => {
                const first = (last.commentFrom ?? 0) > 0 ? last.commentFrom : (last.commentLine ?? 0)

                return first > 0 && n > first && (last.replyTo ?? '') === ''
                  ? { ...last, commentLine: n, commentFrom: first, commentOld: 0 }
                  : { ...last, commentLine: n, commentFrom: 0, commentOld: 0, replyTo: '' }
              })
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
        // Only the card pressed goes to the prompt: a request's thread is
        // other people's words, and is not sent along with the ledger's
        // findings on the same line, nor they with it.
        sendTalk: (n, isLedger = false) => {
          const fold = (info === undefined ? undefined : foldOf(info.items, n))?.to ?? foldEnd(texts, n)
          const [from, to] =
            fold > n ? [n, Math.min(fold, n + TALK_CODE)] : [Math.max(1, n - 3), Math.min(lineCount, n + 3)]

          void sendToComposer(
            $,
            // The request's label is what its header line starts with.
            talkBlock(
              requestLabel,
              file,
              n,
              talk.filter(one => one.line === n && isFinding(one) === isLedger && !isDraft(one)),
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
            set(was => ({ ...was, isCommenting: true, commentLine: n, commentFrom: 0, commentOld: 0, replyTo: root.id }))
          }
        },
        resolveOn: (n, isResolved) => {
          const root = rootOn(n)

          if (root !== undefined) {
            void settleThread($, repo, requestTyped, root, isResolved)
          }
        },
        toggleResolved: () => set(was => ({ ...was, hidesResolved: !now.hidesResolved })),
        listThreads,
        cancelComment: () => {
          commentDraft = ''
          commentRound += 1
          set(was => ({ ...was, commentLine: 0, commentFrom: 0, commentOld: 0, replyTo: '', editing: '' }))
        },
        commentOnFile: () => {
          commentDraft = ''
          commentRound += 1
          set(was => ({
            ...was,
            commentLine: was.commentLine === FILE_COMMENT ? 0 : FILE_COMMENT,
            commentFrom: 0, commentOld: 0,
            replyTo: '',
          }))
        },
        // A comment of the person's own: put back in the field to be
        // changed; asked about, then removed; and any comment given a
        // thumbs-up.
        editComment: (id, n) => {
          commentDraft = fold(comments.find(one => one.id === id)?.body ?? '')
          commentRound += 1
          set(was => ({
            ...was,
            isCommenting: true,
            editing: id,
            deleting: '',
            commentLine: n,
            commentFrom: 0, commentOld: 0,
            replyTo: '',
          }))
        },
        askDelete: id => set(was => ({ ...was, deleting: id })),
        deleteComment: id => {
          const one = comments.find(held => held.id === id)

          if (one === undefined || now.deleting !== id) {
            return
          }

          void changeComment(forgeRun(runOf($), repo), requestTyped, one, 'delete').then(refusal => {
            if (refusal !== '') {
              $.ui.toast(refusal, { timeoutMs: 10_000 })
            } else {
              // What answered it goes from the pane with it; the forge keeps
              // or drops those as it does.
              if (commentsCache !== undefined) {
                commentsCache.comments = commentsCache.comments.filter(
                  held => held.id !== id && held.replyTo !== id,
                )
              }

              $.ui.toast('Comment deleted')
            }

            set(was => ({ ...was, deleting: '' }))
          })
        },
        likeComment: id => {
          const one = comments.find(held => held.id === id)

          if (one !== undefined) {
            void changeComment(forgeRun(runOf($), repo), requestTyped, one, 'like').then(refusal =>
              $.ui.toast(refusal === '' ? `👍 added to ${one.author}'s comment` : refusal, {
                timeoutMs: refusal === '' ? 4000 : 10_000,
              }),
            )
          }
        },
        // Drops comments written for the review and not sent yet.
        discardDrafts: ids =>
          void changeDrafts($, `${repo}\n${requestTyped}`, list =>
            list.filter(one => !ids.includes(one.id)),
          ),
        // Back to a comment on the one line the box is under.
        commentOnOneLine: () => set(was => ({ ...was, commentFrom: 0 })),
        typeComment: text => {
          commentDraft = text
        },
        // An answer to a thread is posted at once. A comment of its own waits
        // with the review's others unless it is asked to go now (`isNow`).
        postComment: (entered, how = 'review') => {
          const isNow = how === 'now'
          const root = now.replyTo === '' ? undefined : rootOn(now.commentLine)
          const typedText = (entered ?? commentDraft).trim()
          // A suggestion is the typed text as a replacement for the lines
          // the comment is on, in the form the forge offers to apply.
          const body = how === 'suggest' && typedText !== '' ? suggestionOf(typedText) : unfold(typedText)
          // A comment of the person's own being changed takes what the
          // field holds in place of what it said.
          const edited = now.editing === '' ? undefined : comments.find(one => one.id === now.editing)

          if (edited !== undefined) {
            void changeComment(forgeRun(runOf($), repo), requestTyped, edited, { edit: unfold(typedText) }).then(
              refusal => {
                if (refusal !== '') {
                  $.ui.toast(refusal, { timeoutMs: 10_000 })

                  return
                }

                const held = commentsCache?.comments.find(one => one.id === edited.id)

                if (held !== undefined) {
                  held.body = unfold(typedText)
                }

                commentDraft = ''
                commentRound += 1
                $.ui.toast('Comment changed')
                set(was => ({ ...was, commentLine: 0, commentFrom: 0, commentOld: 0, replyTo: '', editing: '' }))
              },
            )

            return
          }

          if (root !== undefined) {
            void postReply($, repo, requestTyped, root, entered ?? commentDraft)

            return
          }

          if (!isNow) {
            if (body === '') {
              $.ui.toast('Type the comment first')

              return
            }

            // A comment on a removed line is on no line of this side.
            const line = now.commentLine === FILE_COMMENT || now.commentOld > 0 ? 0 : now.commentLine

            commentDraft = ''
            commentRound += 1
            void $.clock
              .now()
              .then(at =>
                changeDrafts($, `${repo}\n${requestTyped}`, list => [
                  ...list,
                  {
                    id: `${at}-${list.length}`,
                    path: file,
                    line,
                    body,
                    ...(now.commentFrom > 0 && now.commentFrom < line ? { startLine: now.commentFrom } : {}),
                    ...(now.commentOld > 0 ? { oldLine: now.commentOld } : {}),
                  },
                ]),
              )
              .then(() => {
                $.ui.toast(
                  `Added to your review (${drafts.length + 1} waiting): send it from the file tree with v`,
                  { timeoutMs: 6000 },
                )
                set(was => ({ ...was, commentLine: 0, commentFrom: 0, commentOld: 0, replyTo: '', editing: '' }))
              })

            return
          }

          void postReview(
            $,
            repo,
            requestTyped,
            target,
            file,
            // Line 0 is the file as a whole.
            now.commentLine === FILE_COMMENT || now.commentOld > 0 ? 0 : now.commentLine,
            entered ?? commentDraft,
            now.commentFrom,
            now.commentOld,
          )
        },
      },
    )

    fileWindow = drawn.window

    // While commenting, the frame is in the comments' colour.
    return framed(drawn.tree, true, isCommenting ? COMMENT_COLOR : undefined)
  })
}
