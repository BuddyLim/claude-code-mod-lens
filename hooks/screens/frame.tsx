// What every screen shares: the elements a screen is drawn with, the line
// that says what is under review, the frame round a screen, and the few
// colours and marks more than one screen uses.
//
// A screen is a pure view: it takes these elements, a model of plain data
// and its actions (what a person can do there, as closures), and returns the
// tree to draw. It never sees the engine's handle.

import type { ElementTable, Elements, RenderChildren } from 'claude-code'

import type { Severity } from '../../types'
import { isFinding } from '../ledger'
import type { Comment } from '../review'

// The elements of the surface the pane is on. Every surface has the first
// three; a screen draws without the others where a surface lacks them.
export type Kit = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
  Input: Elements['terminal']['Input'] | undefined
  Markdown: Elements['terminal']['Markdown'] | undefined
  Raster: Elements['terminal']['Raster'] | undefined
  Link: Elements['terminal']['Link'] | undefined
}

export const kitOf = (table: ElementTable): Kit => ({
  Box: table.Box,
  Text: table.Text,
  Button: table.Button,
  Input: 'Input' in table ? table.Input : undefined,
  Markdown: 'Markdown' in table ? table.Markdown : undefined,
  Raster: 'Raster' in table ? table.Raster : undefined,
  Link: 'Link' in table ? table.Link : undefined,
})

// The changed files in one row of numbers: lines added and deleted across
// them, and the errors and other problems found in them. `fresh` is how many
// of those the change brought, where that is known.
export type Totals = {
  files: number
  added: number
  deleted: number
  errors: number
  others: number
  fresh: number | undefined
}

// What every screen says of the review itself, and the room it has.
export type Shell = {
  // The cells and rows a screen has to itself, inside the side padding and,
  // while a comparison is on, its border; `inset` is what that border takes
  // of each (2, or 0).
  columns: number
  rows: number
  inset: number
  // The cells left clear at each side of the screen (a setting).
  padding: number
  // The folder under review, by its own name.
  repoName: string
  // Whether the folder is in no git repository: its files are listed as they
  // stand, and nothing is compared.
  isPlain: boolean
  // The repo the folder under review is a worktree of, by name; '' when it
  // is the repo's main checkout (or its only one).
  worktreeOf: string
  // What is checked out, by branch name where there is one.
  headName: string
  // The side the comparison is read from (the target, or what is checked
  // out) and what it is read against, by a branch's name where it has one.
  side: string
  against: string
  // The pull or merge request under review, as a label; '' for none.
  request: string
  // The request whose comments the pane shows, by name ("PR #12"): the one
  // under review, or the open one of the branch checked out. '' for none.
  reviewing: string
  // Whether anything but the uncommitted changes is being compared.
  isComparing: boolean
  // While a scan runs: the mark that turns, and the tools still out.
  isScanning: boolean
  busyMark: string
  pending: readonly string[]
  // How many of the files to check have been, while they go in batches.
  checked: number
  toCheck: number
  // What else the pane is waiting on, in a few words ('' for nothing): the
  // language server reading the open file.
  working: string
  isProjectChecked: boolean
  // What a scan could not do, a line each.
  notes: readonly string[]
  totals: Totals
}

export const COLOR: Record<Severity, string> = { error: 'red', warning: 'yellow', info: 'cyan' }
export const MARK: Record<Severity, string> = { error: '✖', warning: '⚠', info: 'ℹ' }
// git's one-letter status as the letter a file's row shows (modified, added,
// deleted, renamed, type changed, new: the help screen spells them out), in
// the colour VS Code gives it.
export const STATUS_WORD: Record<string, [word: string, color: string]> = {
  M: ['m', '#e2c08d'],
  A: ['a', '#73c991'],
  D: ['d', '#f14c4c'],
  R: ['r', '#73c991'],
  T: ['t', '#e2c08d'],
  '?': ['n', '#73c991'],
}
export const CARD_BACKGROUND = '#1f1f1f'
// A worktree's mark and colour, on the graph's badges and the first line.
export const WORKTREE_ICON = '\u{f07c}'
export const WORKTREE_COLOR = '#4ec9b0'
export const COMMIT_BOX = '#3794ff'
export const STASH_ICON = '\u{f187}'
export const STASH_COLOR = '#a371f7'
// A request's review comments: their mark and their colour.
export const COMMENT_ICON = '\u{f075}'
export const COMMENT_COLOR = '#c586c0'
// The forges' own marks, and GitLab's own colour.
export const GITHUB_ICON = '\u{f09b}'
export const GITLAB_ICON = '\u{f296}'
export const GITLAB_COLOR = '#fc6d26'
// A ledger finding is drawn as a thread too, with a mark and a colour of its
// own: it comes from a review run in this session, not from the forge.
export const LEDGER_ICON = '\u{f0ae}'
export const LEDGER_COLOR = '#4fc1ff'
// The mark and the colour of a thread, by its first comment: a ledger
// finding's, or a request comment's. A resolved thread's colour is the
// caller's to choose.
export const talkIcon = (one: Comment): string => (isFinding(one) ? LEDGER_ICON : COMMENT_ICON)
export const talkColor = (one: Comment | undefined): string =>
  one !== undefined && isFinding(one) ? LEDGER_COLOR : COMMENT_COLOR
// The colour of a review thread that has been resolved.
export const RESOLVED_COLOR = '#9a8444'
// How many lines of a commit's body show at once.
export const BODY_ROWS = 12
// The most files listed under a commit or a stash.
export const COMMIT_FILES = 40
// The border drawn round every screen while a comparison is on.
const COMPARE_COLOR = '#ffab40'

// A review comment in one line: who said it, what, and whether it is settled.
export const said = (one: Comment): string =>
  `${one.author}: ${one.body.replace(/\s+/g, ' ')}${one.isResolved === true ? '  ✓ resolved' : ''}`

// The first line of every screen: the folder, what is compared, and while a
// scan runs, what it is waiting on.
export const statusLine = ({ Text }: Kit, shell: Shell) => (
  <Text dimColor wrap="truncate-end">
    {/* A worktree says so first and in colour: its files are not the main
        checkout's, which is easy to forget once inside it. */}
    {shell.worktreeOf === '' ? (
      ''
    ) : (
      <Text color={WORKTREE_COLOR} dimColor={false} bold>
        {WORKTREE_ICON} worktree of {shell.worktreeOf} ·{' '}
      </Text>
    )}
    {shell.repoName} ·{' '}
    {shell.isPlain ? 'not a git repository' : shell.request === '' ? shell.side : shell.request}
    {shell.request !== '' || shell.isPlain
      ? ''
      : shell.isComparing
        ? ` vs ${shell.against}`
        : ' · uncommitted changes'}
    {shell.request === '' && shell.reviewing !== '' ? ` · ${shell.reviewing}` : ''}
    {shell.isScanning
      ? ` · ${shell.busyMark} ${shell.pending.length === 0 ? 'reading changes' : `checking: ${shell.pending.join(', ')}`}`
      : ''}
    {shell.isScanning && shell.toCheck > shell.checked && shell.checked > 0
      ? ` · ${shell.checked} of ${shell.toCheck} files checked`
      : ''}
    {shell.working === '' ? '' : ` · ${shell.working}`}
    {shell.isProjectChecked ? ' · whole project checked' : ''}
  </Text>
)

export const notesOf = ({ Text }: Kit, notes: readonly string[]) =>
  notes.map(note => (
    <Text color="yellow" wrap="truncate-end">
      ! {note}
    </Text>
  ))

// Every screen has `h`: the keys that work on it, and what the marks mean.
export const helpButton = ({ Button }: Kit, onPress: () => void) => (
  <Button plain key="help" hotkey="h" label="keys" onPress={onPress} />
)

// The frame round a screen. While a comparison is on, every screen is drawn
// inside a bright border, so it cannot be mistaken for the plain view of the
// working tree. Every screen also keeps a little air on each side, so its
// text does not sit against the pane's own edge (or the comparison border).
//
// A screen that draws its own window (`isOwn`: the file, the graph) is as
// tall as the pane, which leaves the pane nothing to scroll, and its scroll
// keys (the arrows, page up and down) are only raised while it has rows to
// scroll. So such a screen gets a blank row above it and a few below, and
// the pane is to be held one row down (the `pin` key, which the hooks
// module's timer scrolls to): there is then always a row either way, the
// keys always raise `ui.scroll`, and the scroll hook turns them into moves
// of the screen's window.
export const frame = (
  { Box, Text }: Kit,
  isComparing: boolean,
  padding: number,
  screen: RenderChildren,
  isOwn = false,
  // The border's colour in place of the comparison's own: the comments',
  // while a comment is being written.
  color = COMPARE_COLOR,
) => {
  const framed = isComparing ? (
    <Box
      key="pin"
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={padding}
    >
      {screen}
    </Box>
  ) : (
    <Box key="pin" flexDirection="column" paddingX={padding}>
      {screen}
    </Box>
  )

  if (!isOwn) {
    return framed
  }

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {framed}
      <Text> </Text>
      <Text> </Text>
      <Text> </Text>
    </Box>
  )
}
