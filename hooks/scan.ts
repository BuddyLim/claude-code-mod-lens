// The scan: one pass over the comparison under review. It asks git what
// differs, shows that at once, has the files checked, and publishes what is
// found as it comes in. It holds no engine handle: the hooks module passes
// it the ports it works through.

import type { Diag, GraphRow, Scan } from '../types'
import type { Progress } from './check'
import { checkChange, isCheckable, refreshServed, toolsAwaited, uncheckedNotes } from './check'
import { isFadeOnly } from './diags'
import * as git from './git'
import type { Run as ServerRun } from './lsp'
import { issueList } from './prompt'
import type { Run } from './run'
import type { Checkers } from './settings'

// How many files are checked at a time. A batch is one run of each checker
// and cannot be added to once started, so the file a person opens waits for
// the batch under way: a smaller batch is a shorter wait, at the price of
// starting the checkers more often.
export const BATCH = 100

// The most files checked of a folder git does not know, where every file is
// listed and none is singled out by a change.
export const PLAIN_CHECKED = 1000

// How many issues an automatic note tells Claude.
const ISSUES_TOLD = 15

// What a scan is asked to do beyond the changed files: `isProject` checks
// every file of every project with the command-line checkers.
export type Job = { isProject: boolean }

// What is under review, as the pane's state has it when the scan starts.
export type Subject = {
  repo: string
  base: string
  // The commit compared against the base in place of the working tree, or ''.
  target: string
  // Unchanged files to check along with the changed.
  extra: readonly string[]
  // Whether the list of every tracked file is wanted too.
  isBrowsing: boolean
  // Whether Claude is told what its own edits broke.
  isTelling: boolean
  // What was typed to open the request under review, or ''.
  requestTyped: string
  // The checkers left switched on, and whether new is told from pre-existing.
  use: Checkers
  marksNew: boolean
}

export type Ports = {
  run: Run
  servers: ServerRun
  // A file's text by its absolute path; '' for one that cannot be read.
  readFile: (path: string) => Promise<string>
  // The scan's own state: as it stands, and a change to it.
  readScan: () => Promise<Scan>
  writeScan: (change: (last: Scan) => Scan) => Promise<unknown>
  // Called once git has answered and the changed files are published, before
  // the checkers start: the moment to read an open file again.
  onListed: () => Promise<void>
  // Reads the request's comments again; answers '' or why it could not.
  readComments: (typed: string) => Promise<string>
  // The one-line summary for the status line; '' clears it.
  showStatus: (text: string) => void
  // A note to Claude, in the conversation.
  tellClaude: (text: string) => Promise<unknown>
  // The file the person has open as the scan's side has it, or '': asked
  // before each batch, since that file is checked next.
  openFile: () => Promise<string>
  // Whether another scan has been asked for since this one started: a long
  // scan then stops between batches and leaves the rest to that one.
  isOvertaken: () => boolean
}

// The whole history as the graph lays it out. Thousands of rows are too much
// to keep as state, so a reload drops them and the scan it starts reads them
// again. Written by `scanRepo` alone; read through `historyOf`.
let history: { repo: string; rows: GraphRow[] } | undefined

// Every file git tracks in the folder under review, read while the tree of
// all files is showing; too many paths to keep as state. Written by
// `scanRepo` alone; read through `allFilesOf`.
let allFiles: { repo: string; paths: string[] } | undefined

// The files Claude has edited since it was last told about its new problems,
// relative to the folder under review (added through `noteTouched`), and the
// problems it has been told.
// The files of the scan under way that no batch has reached yet. Written by
// `scanRepo` alone; read through `isQueued`. The scan's `checked` count
// changing is what redraws the readers.
let queued: { repo: string; paths: Set<string> } | undefined

const touched = new Set<string>()
const told = new Set<string>()

// The history of the repo last scanned, when that is `repo`; else none yet.
export const historyOf = (repo: string): GraphRow[] =>
  history !== undefined && history.repo === repo ? history.rows : []

// Every tracked file of the repo last scanned with `isBrowsing`, when that
// is `repo`; else none yet.
export const allFilesOf = (repo: string): string[] =>
  allFiles !== undefined && allFiles.repo === repo ? allFiles.paths : []

// Whether a file of the scan under way is still waiting for its batch.
export const isQueued = (repo: string, path: string): boolean =>
  queued !== undefined && queued.repo === repo && queued.paths.has(path)

// Why git could not compare with the base, with what to do about it.
const explainDiff = (base: string, refusal: string): string =>
  /unknown revision|bad revision|ambiguous argument|not a valid object/i.test(refusal)
    ? `"${base}" is not a branch or commit in this repo, so nothing is compared. Pick one from the graph, or run /lens again with another`
    : `git could not compare with ${base}: ${refusal}`

// Notes a file Claude edited, for the next scan to tell it what that broke.
export const noteTouched = (path: string): void => {
  touched.add(path)
}

export const scanRepo = async (
  ports: Ports,
  { repo, base, target, extra, isBrowsing, isTelling, requestTyped, use, marksNew }: Subject,
  { isProject }: Job,
): Promise<void> => {
  if (repo === '') {
    return
  }

  await ports.writeScan((last): Scan => ({ ...last, status: 'running' }))

  const notes: string[] = []
  // Which languages have a server is asked while git answers: a server
  // installed, or added to the person's config file, since the last scan
  // counts from this one on.
  const [changes, misconfigured] = await Promise.all([
    git.readChanges(ports.run, repo, base, target),
    refreshServed(ports.servers, use.servers),
  ])

  if (changes.refusal !== undefined) {
    notes.push(explainDiff(base, changes.refusal))
  }

  notes.push(...misconfigured)

  const live = changes.files.filter(one => one.status !== 'D').map(one => one.path)
  // The files to check: what differs, and the unchanged files the person
  // opened from the tree of every file.
  const wanted = [...live, ...(target === '' ? extra : []).filter(path => !live.includes(path))]

  notes.push(...uncheckedNotes(wanted))

  // A folder git does not know has no change to list: every file of it is
  // listed instead, and those a checker reads are checked.
  if (changes.isPlain) {
    allFiles = { repo, paths: await git.folderFiles(ports.run, repo) }

    const code = allFiles.paths.filter(isCheckable)

    wanted.push(...code.slice(0, PLAIN_CHECKED))
    notes.push(...uncheckedNotes(allFiles.paths))

    if (allFiles.paths.length >= git.PLAIN_FILES) {
      notes.push(`only the first ${git.PLAIN_FILES} files of this folder are listed`)
    }

    if (code.length > PLAIN_CHECKED) {
      notes.push(`only the first ${PLAIN_CHECKED} of ${code.length} code files are checked`)
    }
  } else if (isBrowsing) {
    allFiles = { repo, paths: await git.trackedFiles(ports.run, repo) }
  }

  // The files are checked a batch at a time, so the first results show
  // while the rest wait their turn.
  let left = wanted.filter(isCheckable)
  const toCheck = left.length
  const finished = new Set<string>()
  const waiting = new Set(left)

  queued = { repo, paths: waiting }

  history = { repo, rows: changes.history }

  // What git alone answers (the files that differ, their line counts, the
  // history) is shown at once; the checkers, which take the time, fill the
  // diagnostics in when they are done.
  const listed = {
    files: changes.files,
    changed: changes.changed,
    stats: changes.stats,
    // The rows themselves are the module's (`history`); the count changing
    // is what redraws the graph.
    graph: [] as GraphRow[],
    graphCount: changes.history.length,
    branches: changes.branches,
    head: changes.head,
    headHash: changes.headHash,
    dirty: changes.dirty,
    stashes: changes.stashes,
    worktrees: changes.worktrees,
    isPlain: changes.isPlain,
  }

  await ports.writeScan(
    (last): Scan => ({
      ...last,
      ...listed,
      pending: [],
      status: 'running',
      notes: [...notes],
      checked: 0,
      toCheck,
    }),
  )
  await ports.onListed()

  const targetHash =
    target === '' || changes.isPlain ? '' : await git.shortHash(ports.run, repo, target)
  const baseShort = changes.isPlain ? '' : await git.shortHash(ports.run, repo, base)

  // The scan as it goes: which tools are still running, and what they have
  // found so far. A tool that has not reported yet keeps what it found last
  // time, so a count does not drop to nothing and climb back. The writes are
  // chained, so they land in order and none is left to land after the last.
  const previous = (await ports.readScan()).diags
  const running: string[] = []
  let written: Promise<unknown> = Promise.resolve()
  const publish = (found?: Diag[]): Promise<unknown> => {
    const awaited = toolsAwaited(running)

    written = written.then(() =>
      ports.writeScan(
        (last): Scan => ({
          ...last,
          pending: [...running],
          checked: finished.size,
          diags:
            found === undefined
              ? last.diags
              : [
                  ...found,
                  ...previous.filter(
                    old =>
                      // What was known of a file no batch has reached yet
                      // stands until its turn; of the others, what a tool
                      // still out said last time.
                      (waiting.has(old.path) ||
                        (awaited.has(old.tool) && !finished.has(old.path))) &&
                      !found.some(
                        one =>
                          one.path === old.path &&
                          one.line === old.line &&
                          one.tool === old.tool &&
                          one.message === old.message,
                      ),
                  ),
                ]
                  .filter(diag => !isFadeOnly(diag))
                  .slice(0, 5000),
        }),
      ),
    )

    return written
  }
  // What the batches before the one under way found.
  const diags: Diag[] = []
  const progress: Progress = {
    start: tool => {
      running.push(tool)
      void publish()
    },
    done: (tool, found) => {
      const at = running.indexOf(tool)

      if (at !== -1) {
        running.splice(at, 1)
      }

      void publish([...diags, ...found])
    },
  }

  for (let round = 0; round === 0 || left.length > 0; round += 1) {
    // The file the person is reading is checked next, whatever its place.
    const open = await ports.openFile()

    if (left.includes(open)) {
      left = [open, ...left.filter(path => path !== open)]
    }

    const batch = left.slice(0, BATCH)

    left = left.slice(BATCH)

    for (const path of batch) {
      waiting.delete(path)
    }

    const answer = await checkChange(
      {
        run: ports.run,
        servers: ports.servers,
        readFile: ports.readFile,
      },
      {
        repo,
        base: { ref: base, short: baseShort },
        target: { ref: target, short: targetHash },
        files: changes.files,
        // What no checker reads rides with the first batch: a whole-project
        // check is asked once, and finds what it finds wherever it is.
        wanted: round === 0 ? [...batch, ...wanted.filter(path => !isCheckable(path))] : batch,
        isProject: isProject && round === 0,
        use,
        marksNew,
      },
      progress,
    )

    diags.push(...answer.diags)
    notes.push(...answer.notes.filter(note => !notes.includes(note)))

    for (const path of batch) {
      finished.add(path)
    }

    await publish([...diags])

    // A scan asked for meanwhile takes over from here: it starts with what
    // this one found, and the open file first.
    if (left.length > 0 && ports.isOvertaken()) {
      return
    }
  }

  // Every write the scan made along the way has landed before its last one.
  await written
  queued = undefined

  // A request under review has its comments read with every scan, so a
  // refresh picks up what was said since.
  if (requestTyped !== '') {
    const refusal = await ports.readComments(requestTyped)

    if (refusal !== '') {
      notes.push(`comments were not read: ${refusal}`)
    }
  }

  await ports.writeScan(
    (): Scan => ({
      ...listed,
      pending: [],
      status: 'done',
      // A hint that code is never used fades that code and is no problem to
      // count or list, as in an editor.
      diags: diags.filter(diag => !isFadeOnly(diag)).slice(0, 5000),
      faded: diags.filter(isFadeOnly).slice(0, 2000),
      notes,
      isProjectChecked: isProject,
      checked: toCheck,
      toCheck,
    }),
  )

  // The count rides in the status line too, so a glance tells whether the
  // working tree is clean without the pane open. Each mod has its own entry
  // there, so this sits beside any other mod's.
  const changedPaths = new Set(changes.files.map(one => one.path))
  // Where nothing is compared, every problem found counts.
  const mine = changes.isPlain ? diags : diags.filter(diag => changedPaths.has(diag.path))
  const errorCount = mine.filter(diag => diag.severity === 'error').length

  ports.showStatus(
    // The engine writes the mod's name before its entry, so the entry is the count alone.
    // A clean change has nothing to say: '' takes the entry off the status line.
    mine.length === 0 ? '' : `✖ ${errorCount} ⚠ ${mine.length - errorCount}`,
  )

  // Where the person asked for it, Claude is told what its own edits broke:
  // the problems this scan found in the files it changed that the base did
  // not have, each of them once.
  if (isTelling && target === '' && touched.size > 0) {
    const fresh = diags.filter(
      diag =>
        touched.has(diag.path) &&
        diag.isNew !== false &&
        diag.severity !== 'info' &&
        !told.has(`${diag.path}\n${diag.tool}\n${diag.rule}\n${diag.message}`),
    )

    touched.clear()

    if (fresh.length > 0) {
      for (const diag of fresh) {
        told.add(`${diag.path}\n${diag.tool}\n${diag.rule}\n${diag.message}`)
      }

      await ports.tellClaude(
        `lens (automatic note, switched on by the user): after your edits, the checkers report ${fresh.length} new ${fresh.length === 1 ? 'problem' : 'problems'} in files you changed.\n${issueList(fresh, ISSUES_TOLD)}`,
      )
    }
  }
}
