// The pane's state as the session holds it: what each value is before
// anything is known, how a value kept from an older version of the mod is
// read, and what every screen derives from it.
//
// The atoms themselves are declared in the hooks module (register.tsx): the
// engine reads a state reference only where it is written in that file.

import type {
  Crumb,
  Diag,
  GraphRow,
  Listing,
  Lookup,
  Picked,
  Scan,
  Source,
  View,
} from '../types'
import { sumStats } from './git'
import { shortRef } from './text'

export const NO_SYMBOL: Lookup = {
  file: '',
  name: '',
  at: 0,
  col: 0,
  text: '',
  path: '',
  line: 0,
  typePath: '',
  typeLine: 0,
  hasImplementations: false,
  signature: '',
}
// The breadcrumb's popover, closed.
export const NO_CRUMB: Crumb = { kind: 'none', dir: '', level: 0, left: 0, top: -1 }

export const NO_VIEW: View = {
  repo: '',
  base: 'HEAD',
  screen: 'tree',
  file: '',
  top: 1,
  cursor: -1,
  isExpanded: false,
  layout: 'tree',
  toggled: [],
  selected: '',
  isDiff: false,
  isChanges: false,
  commit: '',
  checked: [],
  origin: 'graph',
  reviewed: {},
  drafts: {},
  pageTop: 0,
  pageContext: 3,
  pageSpace: false,
  pageSplit: false,
  pageFinding: false,
  pageFind: '',
  pageCommitting: false,
  redraws: 0,
  bodyTop: 0,
  graphTop: 0,
  target: '',
  baseWorktree: '',
  request: '',
  requestTyped: '',
  isCommenting: false,
  commentLine: 0,
  commentFrom: 0, commentOld: 0,
  overviewFrom: 'tree',
  filter: '',
  editing: '',
  deleting: '',
  replyTo: '',
  diffBase: { path: '', base: '', name: '' },
  hidesResolved: false,
  isReviewing: false,
  talkOpen: '',
  talkReply: '',
  isPreview: true,
  isFinding: false,
  find: '',
  findAt: 0,
  isDiscarding: false,
  isHelp: false,
  symbol: NO_SYMBOL,
  isHinting: false,
  listBack: 'file',
  isMore: false,
  crumb: NO_CRUMB,
  backFile: '',
  backCommit: '',
  backTop: 1,
  isUndoing: false,
  undoNote: '',
  isBlame: false,
  isBrowsing: false,
  extra: [],
  isTelling: false,
  isPicking: false,
  pickA: '',
  pickB: '',
  pickField: 'b',
}
export const NO_SCAN: Scan = {
  status: 'idle',
  files: [],
  diags: [],
  changed: {},
  notes: [],
  isProjectChecked: false,
  stats: {},
  graph: [],
  graphCount: 0,
  branches: [],
  head: '',
  headHash: '',
  dirty: [],
  stashes: [],
  worktrees: [],
  pending: [],
  faded: [],
  checked: 0,
  toCheck: 0,
  isPlain: false,
}
export const NO_SOURCE: Source = { path: '', lineCount: 0, note: '', stamp: 0 }
export const NO_LISTING: Listing = { title: '', rows: [], prompt: '' }
export const NO_PICKED: Picked = { hash: '', files: [], stats: {}, subject: '', body: '' }

// A session keeps its state across a reload of the mod, so a value written
// by an older version may lack the fields added since, whatever its type
// says. Read through these, such a value has every field: a missing one is
// its default, and a reader need not ask.
export const settledView = (stored: View): View => ({ ...NO_VIEW, ...stored })
export const settledScan = (stored: Scan): Scan => ({ ...NO_SCAN, ...stored })
export const settledPicked = (stored: Picked): Picked => ({ ...NO_PICKED, ...stored })

// What is being compared with what, in the words every screen uses.
export type Comparison = {
  // What is checked out, by branch name where there is one.
  headName: string
  // The side the comparison is read from: the target, or what is checked out.
  side: string
  // What it is read against: the base, by a branch on its commit where
  // there is one.
  against: string
  // Whether anything but the uncommitted changes is compared. A base that is
  // the commit checked out compares it with itself, which is the same as no
  // comparison; with a target the comparison is between two commits of the
  // person's choosing and what is checked out plays no part.
  isComparing: boolean
  // The pull or merge request under review as a label, and what was typed to
  // open it, by which the forge is asked about it; '' when there is none.
  request: string
  requestTyped: string
}

export const comparisonOf = (now: View, found: Scan, history: readonly GraphRow[]): Comparison => {
  const headName =
    found.head === '' || found.head === 'HEAD'
      ? found.headHash || 'HEAD'
      : found.head
  // The base may be named by hash or by a branch or tag on its commit.
  const baseRow = history.find(
    row =>
      row.hash === now.base ||
      (row.refs ?? []).some(ref => ref.replace(/^(HEAD -> |tag: )/, '') === now.base),
  )
  const baseBranch = baseRow?.refs
    ?.map(ref => ref.replace(/^HEAD -> /, ''))
    .find(ref => found.branches.includes(ref))
  const request = now.target === '' ? '' : now.request

  return {
    headName,
    side: now.target === '' ? headName : shortRef(now.target),
    against:
      (now.baseWorktree ?? '') !== ''
        ? // As it is typed in the compare panel: the worktree's files as they stand.
          `@${now.baseWorktree.split('/').pop() ?? ''}`
        : (baseBranch ?? shortRef(now.base)),
    isComparing:
      now.target !== '' ||
      (now.base !== 'HEAD' &&
        now.base !== found.head &&
        now.base !== found.headHash &&
        (baseRow === undefined || baseRow.hash !== found.headHash)),
    request,
    requestTyped: request === '' ? '' : now.requestTyped,
  }
}

// The diagnostics in the files that differ: the ones a change answers for.
export const changedDiags = (found: Scan): Diag[] => {
  const changed = new Set(found.files.map(one => one.path))

  // Where nothing is compared, every problem found counts.
  return found.isPlain ? found.diags : found.diags.filter(diag => changed.has(diag.path))
}

// The changed files in one row of numbers; `inChanged` is `changedDiags`.
export const totalsOf = (found: Scan, inChanged: readonly Diag[]) => {
  const [added, deleted] = sumStats(found.files.map(one => found.stats[one.path] ?? [0, 0]))
  const errors = inChanged.filter(diag => diag.severity === 'error').length

  return {
    files: found.files.length,
    added,
    deleted,
    errors,
    others: inChanged.length - errors,
    fresh: inChanged.some(diag => diag.isNew !== undefined)
      ? inChanged.filter(diag => diag.isNew === true).length
      : undefined,
  }
}
