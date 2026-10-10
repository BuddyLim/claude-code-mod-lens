// The file screen: a whole file in a window of the screen's own, with each
// line's diagnostics and review comments beside it, the lines the other side
// had (the diff view), who last changed each line (blame), a breadcrumb that
// opens lists to jump from, a search, and the card of a looked-up name.
//
// Only the lines the window has rows for are drawn, so the tree stays small
// however long the file is; what the scroll hook needs to move the window is
// returned with it.

import type { RenderChildren } from 'claude-code'

import type { Crumb, Diag, LineRange, Lookup, Span } from '../../types'
import { countLabel, diagsByLine } from '../diags'
import { changeLines, stepShown } from '../changes'
import type { Blamed } from '../git'
import { kindColor } from '../lists'
import type { InlayHint, OutlineItem, SemanticToken } from '../lsp-types'
import type { MiniLine } from '../minimap'
import { minimapCells } from '../minimap'
import { markSpans, withInlays } from '../parts'
import { isFinding as isLedgerFinding } from '../ledger'
import type { Comment } from '../review'
import { applySemantic, enclosing, outlineRows } from '../semantic'
import { clamp, findMatches, shortRef, wrapText } from '../text'
import { iconOf } from '../tree'
import type { Kit, Shell } from './frame'
import {
  CARD_BACKGROUND,
  COLOR,
  COMMENT_COLOR,
  RESOLVED_COLOR,
  COMMIT_BOX,
  talkColor as colorOfTalk,
  talkIcon,
  MARK,
  helpButton,
  notesOf,
  said,
  statusLine,
} from './frame'
import { isMarkdownFile } from './markdown'

// What `commentLine` holds while the comment being typed is on the file as a
// whole, not on a line of it.
export const FILE_COMMENT = -1
// The blame column: a short hash, eight letters of the author, how long ago.
const BLAME_WIDTH = 21
// How many lines of a looked-up name's type and docs the file screen shows.
const SYMBOL_LINES = 8
// The narrowest the breadcrumb's popover is; it widens to its longest entry.
const CRUMB_WIDTH = 46
const ADDED_BACKGROUND = '#1f3a24'
const FOUND_BACKGROUND = '#7a4a00'
const REMOVED_BACKGROUND = '#4b1d1d'
// The most removed lines drawn above one line; the window cannot scroll
// inside a run of them, so a longer run is cut with a count.
const REMOVED_LINES = 20
const MINIMAP_COLUMNS = 6
// The minimap is a small corner block, not a full-height column.
const MINIMAP_ROWS = 12
// A pane narrower than this has no room to spare for the minimap.
const MINIMAP_FROM_COLUMNS = 60

// What the language server knows of the file: the file's own lines (a server
// counts a tab as one column, the screen draws four), its outline, what each
// name is, and its inlay hints, by line.
export type Insight = {
  raw: string[]
  items: OutlineItem[]
  tokens: Map<number, SemanticToken[]>
  hints: Map<number, InlayHint[]>
}

// How many lines of a comment show while the file is not expanded.
const TALK_FOLDED = 3

export type FileModel = {
  shell: Shell
  file: string
  // The commit the file is shown at; '' for the working tree's.
  commit: string
  // Whether the file as shown is what the checkers ran on: the working
  // tree's, or the comparison's own target. Only then has it diagnostics.
  isChecked: boolean
  // The file's coloured lines, and the same as plain text; undefined while
  // they are being read. `note` says why highlighting did not run, if so.
  lines: readonly Span[][] | undefined
  texts: readonly string[]
  note: string
  // The lines the other side had, by the line they came before; the lines
  // this side changed; and whether the other side has no such file at all.
  removed: Readonly<Record<number, string[]>>
  changed: readonly LineRange[]
  isNewFile: boolean
  // The file's diagnostics, sorted, and the code said to be never used.
  diags: readonly Diag[]
  faded: readonly Diag[]
  // Who last changed each line, while the blame column shows.
  blame: readonly Blamed[] | undefined
  insight: Insight | undefined
  // The first line of the window (1-based), the diagnostic stepped to (its
  // place among `diags`, -1 for none), and the switches of the view.
  top: number
  cursor: number
  isExpanded: boolean
  isDiff: boolean
  // Whether the diff is cut down to what differs: each change and each
  // commented line, with a few lines around it.
  isChanges: boolean
  isMore: boolean
  isHinting: boolean
  // The search: whether its field shows, what is typed, the match the
  // person is on.
  isFinding: boolean
  find: string
  findAt: number
  // A request's review: whether this file can be commented on, whether a
  // line number now picks the line to comment on, the line picked (0 for
  // none yet), and what was said on this file's lines.
  canComment: boolean
  isCommenting: boolean
  commentLine: number
  // The first line of the comment being typed when it is on several (then
  // `commentLine` is the last); 0 when it is on one.
  commentFrom: number
  // The thread being answered, by its first comment's id; '' for none.
  replyTo: string
  // What the diff is against, by name, when that is not the comparison's
  // base: the branch a request targets. '' otherwise.
  diffAgainst: string
  // Whether resolved threads are being left out (they are then not in `talk`).
  hidesResolved: boolean
  // Counts the comments sent or dropped: the field keeps its own text under
  // its key, so each new comment gets a field of its own, empty.
  commentRound: number
  talk: readonly Comment[]
  // The breadcrumb's open list, and what the folder it last opened holds.
  crumb: Crumb
  folder: { dir: string; entries: readonly string[] } | undefined
  // The name last looked up in this file.
  symbol: Lookup | undefined
}

export type FileActions = {
  // Returns to where the file was opened from.
  back: () => void
  help: () => void
  refresh: () => void
  toggleMore: () => void
  // Moves the window so `line` is its first.
  scrollTo: (line: number) => void
  // Steps to a diagnostic (its place among the file's), opening its card.
  showIssue: (index: number, top: number) => void
  // Goes to the next place the file differs; `top` is undefined when there
  // is none below.
  nextChange: (top: number | undefined) => void
  toggleDiff: () => void
  toggleExpanded: () => void
  toggleBlame: () => void
  toggleHints: () => void
  // Shows a markdown file rendered again.
  showRendered: () => void
  // The search: its field opened (or given the keyboard back), typed in,
  // a match gone to, the keyboard handed back to the pane's keys, closed.
  find: () => void
  typeFind: (text: string) => void
  showMatch: (index: number, top: number) => void
  leaveFindField: () => void
  closeFind: () => void
  // Pressing a line's number: its block goes to the prompt, or, while
  // commenting, the line is picked to comment on.
  pressLine: (line: number) => void
  // Puts a line's diagnostics, with its code, into the prompt.
  sendIssues: (line: number) => void
  // Puts the review thread on a line, with the code it is about, into the prompt.
  // `isLedger` says which card on the line was pressed: the ledger's
  // findings, or (the default) the request's thread. Only that one is sent.
  sendTalk: (line: number, isLedger?: boolean) => void
  // Opens the comment box under a line as an answer to the thread there, and
  // marks that thread resolved or open again. Both write to the forge only
  // once the person posts or presses.
  replyOn: (line: number) => void
  resolveOn: (line: number, isResolved: boolean) => void
  cancelComment: () => void
  // Opens the box for a comment on the file as a whole.
  commentOnFile: () => void
  // Brings a comment on several lines back to the one its box is under.
  commentOnOneLine: () => void
  // Leaves resolved threads out, or shows them again; lists every thread.
  toggleResolved: () => void
  listThreads: () => void
  // Puts what was dragged over into the prompt.
  sendSelection: () => void
  // Looks up the name dragged over, among the lines `from`..`to` on screen.
  lookUpSelection: (from: number, to: number) => void
  closeLookup: () => void
  listUses: () => void
  listCallers: () => void
  listCallees: () => void
  listImplementations: () => void
  // Opens a file of the working tree at a line.
  openFile: (path: string, line: number) => void
  // Opens the commit that last changed a line, in the graph.
  openCommit: (hash: string) => void
  // The breadcrumb: a folder's list opened under column `left` (or closed
  // if it is the one open), the same for the names at a level of the
  // outline, a folder listed in the list already open, and the list closed.
  toggleFolder: (dir: string, left: number) => void
  toggleNames: (level: number, left: number) => void
  listFolder: (dir: string, left: number) => void
  closeCrumb: () => void
  // Scrolls to a name picked from the breadcrumb's list, and closes it.
  jumpTo: (line: number) => void
  // Commenting on a request: switched on or off, typed, and posted (Enter
  // passes the field's text; the button posts what was typed so far).
  toggleCommenting: () => void
  typeComment: (text: string) => void
  postComment: (entered?: string) => void
}

// The window as drawn, for the scroll hook: the furthest its first line may
// go (where the file's last line sits on the bottom row), and where the
// breadcrumb's open list sits among the pane's rows (which rows are over it,
// where it is scrolled to, and how far it can go), if one is open.
//
// `shown` is the lines the changes-only view draws, in order, which the
// window then steps among; undefined while every line shows.
export type FileWindow = {
  maxTop: number
  shown: readonly number[] | undefined
  crumbBox: { from: number; to: number; top: number; max: number } | undefined
}

export const fileScreen = (
  kit: Kit,
  model: FileModel,
  actions: FileActions,
): { tree: RenderChildren; window: FileWindow } => {
  const { Box, Button, Text, Input, Raster } = kit
  const { shell, file, commit, lines, texts, removed, changed, isNewFile, diags, blame } = model
  const { isDiff, isMore, isFinding, isCommenting, commentLine, crumb, symbol } = model
  const info = model.insight
  const lineCount = lines?.length ?? 0
  const byLine = diagsByLine(diags, lineCount)
  const columns = shell.columns
  const hasMinimap = Raster !== undefined && columns >= MINIMAP_FROM_COLUMNS
  const blameWidth = blame === undefined ? 0 : BLAME_WIDTH + 1
  const codeColumns = columns - (hasMinimap ? MINIMAP_COLUMNS + 1 : 0) - blameWidth
  const gutter = String(Math.max(1, lineCount)).length
  const cardWidth = Math.max(24, Math.min(90, codeColumns - gutter - 4))
  // The code the checkers say is never used, by line.
  const fadedByLine = new Map<number, Diag[]>()

  for (const diag of model.faded) {
    fadedByLine.set(diag.line, [...(fadedByLine.get(diag.line) ?? []), diag])
  }

  // Where the outline's functions and classes start, for the minimap: only
  // the top two levels, or a long file's map is all outline.
  const heads = new Map<number, 1 | 2>()

  for (const item of info?.items ?? []) {
    if (item.depth <= 1 && ['function', 'method', 'constructor'].includes(item.kind)) {
      heads.set(item.line, 1)
    } else if (item.depth <= 1 && ['class', 'interface', 'type', 'enum'].includes(item.kind)) {
      heads.set(item.line, 2)
    }
  }

  // What the language server said of the name last looked up, wrapped to
  // the pane and cut to a few lines: its type or signature, then its docs.
  const symbolLines =
    symbol === undefined
      ? []
      : wrapText(symbol.text === '' ? 'The language server has nothing on that name.' : symbol.text, columns - 6).slice(
          0,
          SYMBOL_LINES,
        )
  // How many lines the breadcrumb needs: each part is its icon, its name
  // and a separator, and a part that does not fit goes to the next line.
  const crumbLength =
    (file.startsWith('/') ? [file] : file.split('/')).reduce(
      (sum, part) => sum + part.length + 5,
      0,
    ) +
    (info === undefined ? [] : enclosing(info.items, model.top)).reduce(
      (sum, item) => sum + item.name.length + 5,
      2,
    )
  const crumbLines = clamp(Math.ceil(crumbLength / columns), 1, 3)
  // The rows the header takes: status, the buttons (which wrap in a narrow
  // pane), each note, and the title. The window gets what is left.
  const headerRows =
    // The status, the breadcrumb and the title.
    2 +
    crumbLines +
    // Its box: a border above and below, the name, the lines, the call it
    // sits in when there is one, and two rows of buttons.
    (symbol === undefined ? 0 : symbolLines.length + 5 + (symbol.signature === '' ? 0 : 1)) +
    (isDiff ? 1 : 0) +
    (isFinding ? 3 : 0) +
    // The row of the whole-file button.
    (isCommenting ? 1 : 0) +
    // The box a comment on the file as a whole is typed in.
    (isCommenting && commentLine === FILE_COMMENT ? 4 : 0) +
    // The main row of buttons, and the box of the rest when it is open.
    Math.ceil(100 / columns) +
    (isMore ? 2 + Math.ceil(170 / Math.max(20, columns - 4)) : 0) +
    shell.notes.length + (model.note === '' ? 0 : 1)
  const room = clamp(shell.rows - headerRows, 5, 256)
  // Both are settled further down, once each line's height is known.
  let top = clamp(model.top, 1, lineCount)
  let maxTop = Math.max(1, lineCount)

  const moveTo = (line: number) => actions.scrollTo(clamp(line, 1, maxTop))
  // The changes-only view: the lines that show, or undefined where every
  // line does (a new file is all change, and a file with nothing changed or
  // said has nothing to cut down to).
  const cut =
    isDiff && model.isChanges && !isNewFile
      ? changeLines(
          lineCount,
          changed,
          Object.keys(removed).map(Number),
          model.talk.map(one => one.line),
        )
      : []
  const shown = cut.length === 0 ? undefined : cut
  const firstLine = shown?.[0] ?? 1
  const lastLine = shown?.[shown.length - 1] ?? lineCount
  // The line drawn after one and before it, among those that show.
  const nextLine = (n: number): number =>
    shown === undefined ? n + 1 : (shown.find(line => line > n) ?? lineCount + 1)
  const prevLine = (n: number): number =>
    shown === undefined ? n - 1 : ([...shown].reverse().find(line => line < n) ?? 0)
  // Moves the window by rows' worth of the lines that show.
  const moveBy = (by: number) =>
    moveTo(shown === undefined ? top + by : stepShown(shown, top, by))
  // The next commented line below the window's first lines, or the one
  // above; from the last it goes round to the first.
  const stepTalk = (way: 1 | -1) => {
    const lines = [...new Set(model.talk.map(one => one.line))].sort((one, other) => one - other)
    const here = top + 2
    const next =
      way === 1
        ? (lines.find(line => line > here) ?? lines[0])
        : ([...lines].reverse().find(line => line < here) ?? lines[lines.length - 1])

    if (next !== undefined) {
      moveTo(next - 2)
    }
  }

  const stepIssue = (by: number): void => {
    if (diags.length === 0) {
      return
    }

    const cursor = (model.cursor + by + diags.length) % diags.length
    const line = clamp(diags[cursor]?.line ?? 1, 1, lineCount)

    actions.showIssue(cursor, clamp(line - Math.floor(room / 3), 1, maxTop))
  }

  // The full text of a line's diagnostics: the card a hover floats over the
  // code, and the one the stepped-to line shows in the flow.
  const card = (here: readonly { diag: Diag; index: number }[]) =>
    here.flatMap(({ diag }) => [
      <Text color={COLOR[diag.severity]} bold>
        {MARK[diag.severity]} {diag.tool}
        {diag.rule === '' ? '' : ` ${diag.rule}`}
        {diag.isNew === undefined ? '' : diag.isNew ? ' · new' : ' · pre-existing'}
      </Text>,
      <Text>{diag.message.replace(/[ \t ]+/g, ' ')}</Text>,
    ])

  // The request's comments on this file's lines.
  const talkByLine = new Map<number, Comment[]>()

  for (const one of model.talk) {
    talkByLine.set(one.line, [...(talkByLine.get(one.line) ?? []), one])
  }

  // The search: what is typed in the find field, where it occurs, and which
  // match the person is on.
  const matches = isFinding ? findMatches(texts, model.find) : []
  const foundByLine = new Map<number, (readonly [number, number])[]>()

  for (const match of matches) {
    foundByLine.set(match.line, [...(foundByLine.get(match.line) ?? []), [match.from, match.to]])
  }

  const matchAt = matches.length === 0 ? -1 : clamp(model.findAt, 0, matches.length - 1)
  const stepMatch = (by: number): void => {
    if (matches.length === 0) {
      return
    }

    const next = (Math.max(0, matchAt) + by + matches.length) % matches.length

    actions.showMatch(next, clamp((matches[next]?.line ?? 1) - Math.floor(room / 3), 1, maxTop))
  }

  // One line of the file as elements, and how many rows they take.
  // `offset` is the row of the window the line starts on, where it is being
  // placed (not just measured): it decides which way the line's card opens.
  const codeLine = (spans: readonly Span[], n: number, offset?: number) => {
    const here = byLine.get(n) ?? []
    const first = here[0]
    const isChanged = isNewFile || changed.some(range => n >= range[0] && n <= range[1])
    const isAdded = isDiff && isChanged
    const worst = here.some(({ diag }) => diag.severity === 'error')
      ? 'error'
      : (first?.diag.severity ?? 'warning')
    // The line as it is drawn: the tokenizer's colours, corrected where the
    // language server knows what a name is; then the marks (diagnostics,
    // search matches, code that is never used); then the server's inlay
    // hints, which are not in the file and so go in last.
    const parts = withInlays(
      markSpans(
        info === undefined ? spans : applySemantic(spans, info.tokens.get(n) ?? [], info.raw[n - 1]),
        here.map(({ diag }) => [diag.col, Math.max(diag.endCol, diag.col + 1)] as const),
        foundByLine.get(n) ?? [],
        [
          ...(fadedByLine.get(n) ?? []),
          ...here.filter(({ diag }) => diag.isUnused === true).map(({ diag }) => diag),
        ].map(diag => [diag.col, Math.max(diag.endCol, diag.col + 1)] as const),
      ),
      model.isHinting ? (info?.hints.get(n) ?? []) : [],
      info?.raw[n - 1],
    )
    const length = parts.reduce((sum, part) => sum + part.text.length, 0)
    const isOpen = model.isExpanded || here.some(({ index }) => index === model.cursor)
    // The message rides on the code's own row when the code leaves it room.
    const isBeside = gutter + 2 + length + 16 <= codeColumns
    const codeRows = Math.max(1, Math.ceil((gutter + 2 + length) / codeColumns))

    // The line number is the line's handle: pressing it adds the fold that
    // starts there (or the line alone) to the prompt.
    const number = (
      <Box flexShrink={0}>
        {/* A run of lines from one commit names it on its first line only. */}
        {blame !== undefined &&
          (n > 1 && (blame[n - 1]?.hash ?? '') === (blame[n - 2]?.hash ?? '') ? (
            <Text>{' '.repeat(BLAME_WIDTH + 1)}</Text>
          ) : (blame[n - 1]?.hash ?? '') === '' ? (
            <Text dimColor>{'uncommitted'.padEnd(BLAME_WIDTH + 1)}</Text>
          ) : (
            [
              <Button
                plain
                dimColor
                key={`blame:${n}`}
                label={`${blame[n - 1]?.hash ?? ''} ${(blame[n - 1]?.author ?? '').slice(0, 8).padEnd(8)} ${(blame[n - 1]?.age ?? '').padStart(4)}`}
                // Pressing a line's blame opens its commit in the graph.
                onPress={() => actions.openCommit(blame[n - 1]?.hash ?? '')}
              />,
              <Text> </Text>,
            ]
          ))}
        {/* The lines the comment being typed is on are marked down their
            edge, so a stretch of several can be seen before it is posted. */}
        {isCommenting &&
        commentLine > 0 &&
        n <= commentLine &&
        n >= (model.commentFrom > 0 ? model.commentFrom : commentLine) ? (
          <Text color={COMMENT_COLOR}>┃</Text>
        ) : (
          <Text color="green">{isAdded ? '+' : isChanged ? '▎' : ' '}</Text>
        )}
        <Button
          plain
          dimColor
          key={`ln:${n}`}
          label={String(n).padStart(gutter)}
          onPress={() => actions.pressLine(n)}
        />
        <Text> </Text>
      </Box>
    )
    const code = (
      <Text backgroundColor={isAdded ? ADDED_BACKGROUND : undefined}>
        {parts.length === 0 ? ' ' : ''}
        {parts.map(part =>
          part.isHint ? (
            // An inlay hint is the server's aside, not the file's text.
            <Text color={part.color} italic dimColor>
              {part.text}
            </Text>
          ) : part.isFaded && !part.isMarked && !part.isFound ? (
            // Code that is never used is faded, as an editor fades it.
            <Text color={part.color === '' ? undefined : part.color} dimColor>
              {part.text}
            </Text>
          ) : part.isFound ? (
            // A search's match is lit, and keeps a diagnostic's underline.
            <Text
              color={part.isMarked ? COLOR[worst] : part.color === '' ? undefined : part.color}
              backgroundColor={FOUND_BACKGROUND}
              underline={part.isMarked}
            >
              {part.text}
            </Text>
          ) : part.isMarked ? (
            <Text color={COLOR[worst]} underline>
              {part.text}
            </Text>
          ) : part.color === '' ? (
            part.text
          ) : (
            <Text color={part.color}>{part.text}</Text>
          ),
        )}
      </Text>
    )

    // What reviewers said on this line: one cut line, or the whole thread
    // when everything is expanded.
    const talk = talkByLine.get(n) ?? []
    // They are drawn as one card under the line, a thread as a review tool
    // shows it: who and when, then what was said, replies indented. Folded,
    // the card keeps the first comment's opening lines and counts the rest.
    const talkWidth = Math.max(24, Math.min(100, codeColumns - gutter - 4))
    // A request's thread and the ledger's findings on the same line are two
    // cards, each in its colour: a finding is no answer to the thread.
    const forgeTalk = talk.filter(one => !isLedgerFinding(one))
    const ledgerTalk = talk.filter(isLedgerFinding)
    const cardFor = (group: readonly Comment[], isLedger: boolean) => {
      if (group.length === 0) {
        return { height: 0, rows: [] }
      }

      const talkLines: { text: string; kind: 'head' | 'body' | 'more' }[] = []
      const scope = isLedger ? ':ledger' : ''

    for (const [at, one] of (model.isExpanded ? group : group.slice(0, 1)).entries()) {
      // A finding stands by itself; an answer in a thread is set in.
      const indent = at === 0 || isLedger ? '' : '  '
      const body = wrapText(one.body.trim(), talkWidth - 4 - indent.length)

      talkLines.push({
        kind: 'head',
        text: `${indent}${at === 0 || isLedger ? talkIcon(one) : '↳'} ${one.author} · ${one.when.slice(0, 10)}${one.startLine === undefined ? '' : ` · lines ${one.startLine}–${one.line}`}${one.isResolved === true ? ' · ✓ resolved' : ''}${one.isOutdated === true ? ' · outdated' : ''}`,
      })

      for (const line of model.isExpanded ? body : body.slice(0, TALK_FOLDED)) {
        talkLines.push({ kind: 'body', text: `${indent}${line}` })
      }

      if (!model.isExpanded && (body.length > TALK_FOLDED || group.length > 1)) {
        const rest = group.length - 1
        const counted = isLedger
          ? `${rest} more ${rest === 1 ? 'finding' : 'findings'}`
          : `${rest} ${rest === 1 ? 'reply' : 'replies'}`

        talkLines.push({
          kind: 'more',
          text: `${[body.length > TALK_FOLDED ? '…' : '', rest > 0 ? counted : ''].filter(part => part !== '').join(' ')} · e expands`,
        })
      }
    }

      // What can be done with the thread sits on the card's last row. The
      // ledger's findings are closed in the ledger, and have no thread to
      // answer: theirs holds the way to the prompt alone.
      const isSettled = isLedger
        ? group.every(one => one.isResolved === true)
        : group.some(one => one.isResolved === true)
      const canSettle = !isLedger && group.some(one => one.isResolved !== undefined)
      // A settled thread steps back: a dim gold in place of its own colour.
      const talkColor = isSettled ? RESOLVED_COLOR : colorOfTalk(group[0])
      const height = talkLines.length + 2 + (model.canComment ? 1 : 0)

      return {
        height,
        rows: [
          <Box
            marginLeft={gutter + 2}
            width={talkWidth}
            height={height}
            flexDirection="column"
            borderStyle="round"
            borderColor={talkColor}
            paddingX={1}
            overflow="hidden"
          >
            {talkLines.map((line, at) => {
              const text = (
                <Text
                  wrap="truncate-end"
                  color={line.kind === 'head' ? talkColor : undefined}
                  bold={line.kind === 'head'}
                  dimColor={line.kind === 'more'}
                >
                  {line.text}
                </Text>
              )

              // The card's first row carries its handle, as a problem's
              // does: pressed, the thread and its code go to the prompt.
              return at === 0 ? (
                <Box height={1} columnGap={1} overflow="hidden">
                  <Button plain key={`talk:${n}${scope}`} label="↗" onPress={() => actions.sendTalk(n, isLedger)} />
                  {text}
                </Box>
              ) : (
                text
              )
            })}
            {model.canComment && (
              <Box height={1} columnGap={3} overflow="hidden">
                {!isLedger && (
                  <Button plain key={`reply:${n}`} label="↩ reply" onPress={() => actions.replyOn(n)} />
                )}
                {canSettle && (
                  <Button
                    plain
                    key={`settle:${n}`}
                    label={isSettled ? '↺ reopen' : '✓ resolve'}
                    onPress={() => actions.resolveOn(n, !isSettled)}
                  />
                )}
                <Button
                  plain
                  key={`talk-send:${n}${scope}`}
                  label="↗ to prompt"
                  onPress={() => actions.sendTalk(n, isLedger)}
                />
              </Box>
            )}
          </Box>,
        ],
      }
    }
    const cards = [cardFor(forgeTalk, false), cardFor(ledgerTalk, true)]
    const cardHeight = cards.reduce((sum, card) => sum + card.height, 0)
    // The box a comment or a reply is typed in opens under the line it is
    // for (under the thread, when it answers one). Only Enter or its post
    // button sends anything to the forge.
    const isWriting = isCommenting && commentLine === n && Input !== undefined
    // The field has a row to itself and the buttons the one under it, so a
    // narrow pane does not squeeze the field against them.
    const writeHeight = isWriting ? 4 : 0
    // The lines a comment being typed is on, when it is on more than one.
    const isRange = model.commentFrom > 0 && model.commentFrom < n
    const answered = model.replyTo === '' ? undefined : forgeTalk[0]
    const writeRows =
      isWriting && Input !== undefined
        ? [
            <Box
              marginLeft={gutter + 2}
              width={talkWidth}
              height={4}
              flexDirection="column"
              borderStyle="round"
              borderColor={COMMENT_COLOR}
              paddingX={1}
              overflow="hidden"
            >
              <Box height={1} overflow="hidden">
                <Input
                  key={`comment-text:${model.commentRound}`}
                  label={
                    answered !== undefined
                      ? `reply to ${answered.author}`
                      : isRange
                        ? `comment on lines ${model.commentFrom}–${n}`
                        : `comment on line ${n}`
                  }
                  placeholder="what to say, then Enter"
                  submitLabel="post"
                  autoFocus
                  onInput={actions.typeComment}
                  onSubmit={value => actions.postComment(value)}
                />
              </Box>
              <Box height={1} overflow="hidden" columnGap={2}>
                <Button key="comment-post" variant="primary" label="post" onPress={() => actions.postComment()} />
                <Button key="comment-cancel" label="cancel" onPress={actions.cancelComment} />
              </Box>
            </Box>,
          ]
        : []
    // One element as tall as its lines and its border: the window counts the
    // card and the box by `talkHeight`.
    const talkHeight = cardHeight + writeHeight
    const talkRows = [...cards.flatMap(card => card.rows), ...writeRows]

    if (first === undefined) {
      return {
        rows: codeRows + talkHeight,
        elements: [
          <Box>
            {number}
            {code}
          </Box>,
          ...talkRows,
        ],
      }
    }

    // A Button takes no colour of its own, so the message stays a Text in
    // its severity's colour and the arrow before it is the handle: pressing
    // it adds the line's diagnostics, with its code, to the prompt. The
    // message is cut to fit so the arrow is never pushed off the row.
    const briefRoom = Math.max(
      8,
      isBeside ? codeColumns - gutter - length - 10 : codeColumns - gutter - 8,
    )
    // A line's message is marked NEW when the change brought any of its
    // diagnostics, and drawn dim when every one of them was already there.
    const isFresh = here.some(({ diag }) => diag.isNew === true)
    const isOld = here.every(({ diag }) => diag.isNew === false)
    const briefText = `${isFresh ? 'NEW ' : ''}${first.diag.message.split('\n')[0] ?? ''}${here.length > 1 ? `  +${here.length - 1} more` : ''}`
    const brief = (
      <Box flexShrink={0}>
        <Button plain key={`err:${n}`} label="↗" onPress={() => actions.sendIssues(n)} />
        <Text color={COLOR[worst]} dimColor={isOld} bold={isFresh}>
          {' '}
          {MARK[worst]}{' '}
          {briefText.length > briefRoom ? `${briefText.slice(0, briefRoom - 1)}…` : briefText}
        </Text>
      </Box>
    )
    const cardRows = here.reduce(
      (sum, { diag }) => sum + 1 + Math.ceil(diag.message.length / Math.max(1, cardWidth - 4)),
      2,
    )

    // The card opens above its line where the window has the rows for it,
    // and below where it has not (the first lines of the window): there it
    // would run off the top.
    const isBelow = !isOpen && offset !== undefined && offset < cardRows
    const cardBox = (place: { top: number } | { bottom: number }, scope?: string) => (
      <Box
        position="absolute"
        {...place}
        left={gutter + 2}
        width={cardWidth}
        display="none"
        hover={scope === undefined ? { display: 'flex' } : { display: 'flex', scope }}
        flexDirection="column"
        borderStyle="round"
        borderColor={COLOR[worst]}
        backgroundColor={CARD_BACKGROUND}
        paddingX={1}
      >
        {card(here)}
      </Box>
    )

    return {
      rows: codeRows + (isOpen ? cardRows : isBeside ? 0 : 1) + talkHeight,
      // A card that opens below is drawn after every row of the window, or
      // the rows under its line would be painted over it; it and its line
      // share a hover group, so the pointer on the line still reveals it.
      overlay: isBelow ? cardBox({ top: (offset ?? 0) + codeRows }, `card:${n}`) : undefined,
      elements: [
        <Box key={`line:${n}`} {...(isBelow ? { hover: { scope: `card:${n}` } } : {})}>
          {number}
          <Box flexShrink={isBeside ? 0 : 1}>{code}</Box>
          {isBeside && (
            <Box flexShrink={1} marginLeft={2}>
              {brief}
            </Box>
          )}
          {/* Above its line the card can hang off the line itself: rows are
              painted top to bottom, so nothing after it covers it there. */}
          {!isOpen && !isBelow && cardBox({ bottom: 1 })}
        </Box>,
        !isBeside && !isOpen && <Box marginLeft={gutter + 2}>{brief}</Box>,
        isOpen && (
          <Box
            marginLeft={gutter + 2}
            width={cardWidth}
            flexDirection="column"
            borderStyle="round"
            borderColor={COLOR[worst]}
            paddingX={1}
          >
            {card(here)}
          </Box>
        ),
        ...talkRows,
      ],
    }
  }

  // Only the lines the window has rows for are drawn, so the tree stays
  // small however long the file is.
  const windowRows = []
  // The cards that open below their line, drawn after the rows (see `codeLine`).
  const overlays: RenderChildren[] = []
  let used = 0
  let last = top - 1

  // In the diff view the lines the base had and the working tree dropped
  // are drawn above the line they came before, as a diff interleaves them.
  const removedRows = (before: number) => {
    const gone = isDiff ? (removed[before] ?? []) : []
    const rows = gone.slice(0, REMOVED_LINES).map(text => (
      <Box>
        <Text color="red">{`-${' '.repeat(gutter)} `}</Text>
        <Text color="#f48771" backgroundColor={REMOVED_BACKGROUND} wrap="truncate-end">
          {text === '' ? ' ' : text}
        </Text>
      </Box>
    ))

    return gone.length > REMOVED_LINES
      ? [
          ...rows,
          <Text color="red" dimColor>
            {' '.repeat(gutter + 2)}… {gone.length - REMOVED_LINES} more removed lines
          </Text>,
        ]
      : rows
  }

  // The window stops once the file's last line reaches its bottom row:
  // walking up from the end, `maxTop` is the first line of the last full
  // window, counting the rows each line and its diagnostics really take.
  maxTop = Math.max(1, lastLine)

  // In the changes-only view, a row stands for the unchanged lines left out
  // above a line (`before` is that line, or one past the file's last).
  const gapRows = (before: number) => {
    const hidden = shown === undefined ? 0 : Math.min(before, lineCount + 1) - prevLine(before) - 1

    // A rule across the code's width, so one change is set apart from the
    // next: it says how many lines it stands for.
    const label = ` ${hidden} unchanged ${hidden === 1 ? 'line' : 'lines'} `
    const lead = '─'.repeat(gutter + 2)
    const width = codeColumns + blameWidth

    return hidden <= 0
      ? []
      : [
          <Text color={COMMIT_BOX} dimColor wrap="truncate-end">
            {lead}
            {label}
            {'─'.repeat(Math.max(0, width - lead.length - label.length))}
          </Text>,
        ]
  }
  // What follows the last line that shows: the unchanged lines left out
  // after it, one row.
  const tailGap = shown === undefined || lastLine >= lineCount ? [] : gapRows(lineCount + 1)

  if (lines !== undefined) {
    const rowsOf = (n: number): number =>
      codeLine(lines[n - 1] ?? [], n).rows + removedRows(n).length + gapRows(n).length
    // The last line always shows, with what was removed after it.
    let filled = removedRows(lineCount + 1).length + tailGap.length + rowsOf(maxTop)

    while (maxTop > firstLine && filled + rowsOf(prevLine(maxTop)) <= room) {
      maxTop = prevLine(maxTop)
      filled += rowsOf(maxTop)
    }
  }

  // A top on a line left out moves to the next that shows.
  top = Math.min(shown === undefined ? top : stepShown(shown, top, 0), maxTop)
  last = top - 1

  for (let at = top; lines !== undefined && at <= lastLine && used < room; at = nextLine(at)) {
    const above = [...gapRows(at), ...removedRows(at)]
    const drawn = codeLine(lines[at - 1] ?? [], at, used + above.length)
    used += above.length + drawn.rows
    windowRows.push(...above, ...drawn.elements)
    last = at

    if (drawn.overlay !== undefined) {
      overlays.push(drawn.overlay)
    }
  }

  // Lines removed from the end of the file come before a line it no longer has.
  if (lines !== undefined && last === lineCount) {
    windowRows.push(...removedRows(lineCount + 1))
  }

  if (lines !== undefined && last === lastLine) {
    windowRows.push(...tailGap)
  }

  // The next place the file differs from the base, below the window's top.
  const nextChange = (): number | undefined =>
    [...changed.map(range => range[0]), ...Object.keys(removed).map(Number)]
      .sort((a, b) => a - b)
      .find(line => line > top + 2)

  const minimap =
    hasMinimap && lines !== undefined
      ? minimapCells(
          lines.map((spans, at): MiniLine => {
            const text = spans.map(span => span[1]).join('')
            const here = byLine.get(at + 1) ?? []

            return {
              indent: text.length - text.trimStart().length,
              length: text.trimEnd().length,
              mark:
                here.length === 0 ? 0 : here.some(({ diag }) => diag.severity === 'error') ? 2 : 1,
              isChanged: changed.some(range => at + 1 >= range[0] && at + 1 <= range[1]),
              isTalked: talkByLine.has(at + 1),
              isSettled: (talkByLine.get(at + 1) ?? []).some(one => one.isResolved === true),
              head: heads.get(at + 1) ?? 0,
            }
          }),
          MINIMAP_COLUMNS,
          Math.min(room, MINIMAP_ROWS),
          top,
          last - top + 1,
        )
      : undefined

  // The breadcrumb: the file's path, a folder at a time, then the class and
  // function around the top of the window. Pressing a part opens a list
  // under it: a folder's own entries, or the names beside that one.
  const pathParts = file.startsWith('/') ? [file] : file.split('/')
  const around = info === undefined ? [] : enclosing(info.items, top)
  let crumbOffset = 0
  // Each part wears its icon in its colour (a folder's, a file type's, a
  // name's kind); the label is the Button, which takes no colour itself.
  const crumbPart = (
    glyph: string,
    color: string,
    label: string,
    key: string,
    press: (left: number) => void,
  ) => {
    const left = crumbOffset

    crumbOffset += label.length + 5

    // One box per part, which does not shrink: a part stays whole, and
    // wraps to the next line as a whole.
    return (
      <Box flexShrink={0}>
        <Text color={color === '' ? undefined : color}>{glyph} </Text>
        <Button plain key={key} label={label} onPress={() => press(left % columns)} />
        <Text dimColor> › </Text>
      </Box>
    )
  }
  const trail = [
    ...pathParts.flatMap((part, at) => {
      const isFile = at === pathParts.length - 1
      const icon = iconOf(file)

      return crumbPart(
        isFile ? icon.glyph : '\u{f07b}',
        isFile ? icon.color : '#dcb67a',
        part,
        `crumb:${at}`,
        left => actions.toggleFolder(pathParts.slice(0, at).join('/'), left),
      )
    }),
    ...around.flatMap((item, at) =>
      crumbPart(
        outlineRows([item])[0]?.label.trimStart().charAt(0) ?? '·',
        kindColor(item.kind),
        item.name,
        `crumb-in:${at}`,
        left => actions.toggleNames(at, left),
      ),
    ),
    info !== undefined && (
      <Button
        plain
        dimColor
        key="crumb-more"
        label="…"
        onPress={() => actions.toggleNames(around.length, crumbOffset)}
      />
    ),
  ]

  // What the open part lists. A folder lists what it holds, folders first,
  // with a way up; a name lists the names beside it in the outline.
  type Entry = { label: string; glyph: string; color: string; isHere: boolean; press: () => void }
  let entries: Entry[] = []

  if (crumb.kind === 'dir' && model.folder !== undefined && model.folder.dir === crumb.dir) {
    const within = crumb.dir === '' ? '' : `${crumb.dir}/`

    entries = [
      ...(crumb.dir === ''
        ? []
        : [
            {
              label: '..',
              glyph: '\u{f07c}',
              color: '#dcb67a',
              isHere: false,
              press: () =>
                actions.listFolder(
                  crumb.dir.includes('/') ? crumb.dir.slice(0, crumb.dir.lastIndexOf('/')) : '',
                  crumb.left,
                ),
            },
          ]),
      ...model.folder.entries.map((name): Entry => {
        const isFolder = name.endsWith('/')
        const full = `${within}${name.replace(/\/$/, '')}`
        const icon = iconOf(full)

        return {
          label: name,
          glyph: isFolder ? '\u{f07b}' : icon.glyph,
          color: isFolder ? '#dcb67a' : icon.color,
          isHere: file === full || file.startsWith(`${full}/`),
          press: () => (isFolder ? actions.listFolder(full, crumb.left) : actions.openFile(full, 1)),
        }
      }),
    ]
  } else if (crumb.kind === 'symbol' && info !== undefined) {
    const parent = crumb.level === 0 ? undefined : around[crumb.level - 1]

    entries = outlineRows(
      info.items.filter(item =>
        parent === undefined
          ? item.depth === 0
          : item.depth === parent.depth + 1 && item.line >= parent.line && item.line <= parent.endLine,
      ),
    ).map(({ item, label }) => ({
      label: item.name,
      glyph: label.trimStart().charAt(0),
      color: kindColor(item.kind),
      isHere: around[crumb.level] === item,
      press: () => actions.jumpTo(clamp(item.line, 1, maxTop)),
    }))
  }

  // The list takes the room there is: as wide as its longest entry needs,
  // up to the pane's width, and as tall as the window under it allows.
  const crumbRows = clamp(room - 3, 6, 30)
  const crumbWidth = clamp(
    Math.max(CRUMB_WIDTH, ...entries.map(entry => entry.label.length + 14)),
    CRUMB_WIDTH,
    columns - 2,
  )
  // It opens on the entry the file is at, and the wheel moves it.
  const hereAt = entries.findIndex(entry => entry.isHere)
  const crumbTop = clamp(
    crumb.top < 0 ? hereAt - Math.floor(crumbRows / 2) : crumb.top,
    0,
    entries.length - crumbRows,
  )

  return {
    window: {
      maxTop,
      shown,
      // Where the popover sits among the pane's rows: under the status and
      // the breadcrumb, inside the comparison border if any.
      crumbBox:
        entries.length === 0
          ? undefined
          : {
              from: shell.inset / 2 + 1 + crumbLines,
              to: shell.inset / 2 + 2 + crumbLines + Math.min(entries.length, crumbRows) + 1,
              top: crumbTop,
              max: Math.max(0, entries.length - crumbRows),
            },
    },
    tree: (
      <Box flexDirection="column">
        {statusLine(kit, shell)}
        {/* The breadcrumb takes the lines its path needs, up to three: a part
            is never squeezed, and what does not fit on a line goes to the next. */}
        <Box height={crumbLines} overflow="hidden" flexWrap="wrap">
          {trail}
        </Box>
        {/* The keys used all the time stay on one row; the rest open in a box
            under it (a), so the header is not a wall of them. A key works
            while its button is drawn, so the box is where the others live. */}
        <Box columnGap={2} flexWrap="wrap">
          <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
          <Button plain key="next" hotkey="n" label="next issue" onPress={() => stepIssue(1)} />
          <Button plain key="prev" hotkey="p" label="prev issue" onPress={() => stepIssue(-1)} />
          <Button
            plain
            key="down"
            hotkey="d"
            label="down"
            onPress={() => moveBy(Math.floor(room / 2))}
          />
          <Button
            plain
            key="up"
            hotkey="u"
            label="up"
            onPress={() => moveBy(-Math.floor(room / 2))}
          />
          <Button
            plain
            key="diff"
            hotkey="v"
            // The key goes round: the file, its diff, the diff cut down to
            // what differs.
            label={!isDiff ? 'diff view' : model.isChanges ? 'file view' : 'changes only'}
            onPress={actions.toggleDiff}
          />
          <Button plain key="find" hotkey="f" label="find" onPress={actions.find} />
          {/* A markdown file's way back to how it reads is always at hand. */}
          {isMarkdownFile(file) && (
            <Button plain key="rendered" hotkey="m" label="rendered" onPress={actions.showRendered} />
          )}
          <Button
            plain
            key="more"
            hotkey="a"
            label={isMore ? 'less' : 'more…'}
            onPress={actions.toggleMore}
          />
          {helpButton(kit, actions.help)}
        </Box>
        {/* Folded, the box is still drawn, at no height: a key works while
            its button is in the drawing, so the less-used keys answer
            whether or not the box is open. */}
        {(
          <Box
            columnGap={2}
            flexWrap="wrap"
            {...(isMore
              ? { borderStyle: 'round' as const, borderDimColor: true, paddingX: 1 }
              : { height: 0, overflow: 'hidden' as const })}
          >
            <Button plain key="top" hotkey="g" label="top" onPress={() => moveTo(1)} />
            <Button
              plain
              key="expand"
              hotkey="e"
              label={model.isExpanded ? 'collapse' : 'expand'}
              onPress={actions.toggleExpanded}
            />
            <Button
              plain
              key="change"
              hotkey="c"
              label="next change"
              onPress={() => {
                const line = nextChange()

                actions.nextChange(line === undefined ? undefined : clamp(line - 2, 1, maxTop))
              }}
            />
            <Button
              plain
              key="blame"
              hotkey="l"
              label={blame === undefined ? 'blame' : 'hide blame'}
              onPress={actions.toggleBlame}
            />
            {commit === '' && (
              <Button
                plain
                key="inspect"
                hotkey="t"
                label="look up selection"
                onPress={() => actions.lookUpSelection(top, last)}
              />
            )}
            {commit === '' && (
              <Button
                plain
                key="hints"
                hotkey="i"
                label={model.isHinting ? 'hide hints' : 'inlay hints'}
                onPress={actions.toggleHints}
              />
            )}
            <Button
              plain
              key="selection"
              hotkey="s"
              label="selection to prompt"
              onPress={actions.sendSelection}
            />
            {model.canComment && (
              <Button
                plain
                key="comment"
                hotkey="o"
                label={isCommenting ? 'stop commenting' : 'comment'}
                onPress={actions.toggleCommenting}
              />
            )}
            {model.canComment && (
              <Button plain key="talk-next" hotkey="w" label="next comment" onPress={() => stepTalk(1)} />
            )}
            {model.canComment && (
              <Button plain key="talk-prev" hotkey="q" label="prev comment" onPress={() => stepTalk(-1)} />
            )}
            {model.canComment && (
              <Button
                plain
                key="talk-resolved"
                hotkey="z"
                label={model.hidesResolved ? 'show resolved' : 'hide resolved'}
                onPress={actions.toggleResolved}
              />
            )}
            {model.canComment && (
              <Button plain key="talk-all" hotkey="y" label="all threads" onPress={actions.listThreads} />
            )}
            <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
          </Box>
        )}
        {notesOf(kit, shell.notes)}
        {model.note !== '' && (
          <Text color="yellow" wrap="truncate-end">
            ! {model.note}
          </Text>
        )}
        <Text bold wrap="truncate-end">
          {model.isChecked ? countLabel(diags) || '✓' : ''}
          {lineCount > 0 ? `  ${top}–${last} of ${lineCount}` : ''}
          {commit === '' ? '' : `  @ ${commit}`}
          {!isDiff
            ? ''
            : shown !== undefined
              ? '  · changes only'
              : model.isChanges && !isNewFile
                ? '  · diff (nothing differs here)'
                : '  · diff'}
        </Text>
        {/* The looked-up name: what it is, and a way to where it is defined. */}
        {symbol !== undefined && (
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan" wrap="truncate-end">
              {symbol.name}
            </Text>
            {symbolLines.map(text => (
              <Box height={1} overflow="hidden">
                <Text>{text === '' ? ' ' : text}</Text>
              </Box>
            ))}
            {/* The call the name sits in, the argument being given in brackets. */}
            {symbol.signature !== '' && (
              <Box height={1} overflow="hidden">
                <Text dimColor>in a call: {symbol.signature}</Text>
              </Box>
            )}
            {/* Where it is declared, and where its type is. */}
            <Box columnGap={2} height={1} overflow="hidden">
              {symbol.path !== '' && (
                <Button
                  key="symbol-go"
                  variant="primary"
                  label={`definition: ${symbol.path.split('/').slice(-2).join('/')}:${symbol.line}`}
                  onPress={() => actions.openFile(symbol.path, symbol.line)}
                />
              )}
              {symbol.typePath !== '' && (
                <Button
                  key="symbol-type"
                  label={`its type: ${symbol.typePath.split('/').slice(-2).join('/')}:${symbol.typeLine}`}
                  onPress={() => actions.openFile(symbol.typePath, symbol.typeLine)}
                />
              )}
              {symbol.path === '' && symbol.typePath === '' && (
                <Text dimColor>The server does not say where it is defined.</Text>
              )}
            </Box>
            {/* Where it reaches: each of these opens a list to jump from. */}
            <Box columnGap={2} height={1} overflow="hidden">
              <Button key="symbol-uses" label="uses" onPress={actions.listUses} />
              <Button key="symbol-callers" label="callers" onPress={actions.listCallers} />
              <Button key="symbol-callees" label="what it calls" onPress={actions.listCallees} />
              {symbol.hasImplementations && (
                <Button
                  key="symbol-implementations"
                  label="implementations"
                  onPress={actions.listImplementations}
                />
              )}
              <Button key="symbol-close" label="close" onPress={actions.closeLookup} />
            </Box>
          </Box>
        )}
        {/* The comment row: a line number picks the line, and only Enter or
            the post button sends anything to the forge. */}
        {/* Commenting is told by the frame's colour (see the hooks module),
            not by a row of words here. */}
        {/* The file as a whole can be commented on too, on no line: its
            button has the row under the hint to itself. */}
        {isCommenting && Input !== undefined && (
          <Box height={1} overflow="hidden" columnGap={2}>
            <Button
              plain
              key="comment-file"
              label={commentLine === FILE_COMMENT ? '[whole file ✓]' : '[whole file]'}
              onPress={actions.commentOnFile}
            />
            {/* A comment stretched over several lines says so here, and
                pressed goes back to the one line. */}
            {model.commentFrom > 0 && commentLine > model.commentFrom && (
              <Button
                plain
                key="comment-range"
                label={`[lines ${model.commentFrom}–${commentLine}: back to one line]`}
                onPress={actions.commentOnOneLine}
              />
            )}
          </Box>
        )}
        {isCommenting && Input !== undefined && commentLine === FILE_COMMENT && (
          <Box
            height={4}
            flexDirection="column"
            borderStyle="round"
            borderColor={COMMENT_COLOR}
            paddingX={1}
            overflow="hidden"
          >
            <Box height={1} overflow="hidden">
              <Input
                key={`comment-file-text:${model.commentRound}`}
                label="comment on this file"
                placeholder="what to say of the file as a whole, then Enter"
                submitLabel="post"
                autoFocus
                onInput={actions.typeComment}
                onSubmit={value => actions.postComment(value)}
              />
            </Box>
            <Box height={1} overflow="hidden" columnGap={2}>
              <Button key="comment-file-post" variant="primary" label="post" onPress={() => actions.postComment()} />
              <Button key="comment-file-cancel" label="cancel" onPress={actions.cancelComment} />
            </Box>
          </Box>
        )}
        {/* The find row: typing narrows the matches, Enter goes to the next. */}
        {/* The field keeps its own text: what is typed is not drawn back into
            it, which would race the typing and drop keys. While it has the
            keyboard every key is text, so Enter also hands the keyboard to
            the buttons beside it, where the pane's keys work again. */}
        {isFinding && Input !== undefined && (
          <Box
            columnGap={2}
            height={3}
            overflow="hidden"
            borderStyle="round"
            borderColor={COMMIT_BOX}
            paddingX={1}
          >
            <Input
              key="find-text"
              label="find"
              placeholder="text in this file, then Enter"
              submitLabel="go"
              autoFocus
              onInput={actions.typeFind}
              onSubmit={() => {
                stepMatch(1)
                actions.leaveFindField()
              }}
            />
            <Text dimColor>
              {model.find === ''
                ? ''
                : matches.length === 0
                  ? 'no matches'
                  : `${matchAt + 1} of ${matches.length}`}
            </Text>
            <Button plain key="find-next" hotkey="j" label="next" onPress={() => stepMatch(1)} />
            <Button plain key="find-prev" hotkey="k" label="prev" onPress={() => stepMatch(-1)} />
            <Button plain key="find-close" hotkey="x" label="close find" onPress={actions.closeFind} />
          </Box>
        )}
        {/* The diff's key: which side each mark belongs to. */}
        {isDiff && (
          <Box columnGap={2}>
            <Text color="red">
              − removed ·{' '}
              {!model.isChecked
                ? `${shortRef(commit)}^`
                : model.diffAgainst !== ''
                  ? model.diffAgainst
                  : shell.isComparing
                    ? shell.against
                    : 'your last commit'}
            </Text>
            <Text color="green">+ added · {commit !== '' ? shortRef(commit) : shell.headName}</Text>
          </Box>
        )}
        {lines === undefined && <Text dimColor>Loading…</Text>}
        <Box height={room} overflow="hidden">
          <Box flexDirection="column" width={codeColumns + blameWidth} overflow="hidden">
            {windowRows}
            {overlays}
          </Box>
          {Raster !== undefined && minimap !== undefined && (
            <Box marginLeft={1}>
              <Raster key="minimap" columns={MINIMAP_COLUMNS} rows={Math.min(room, MINIMAP_ROWS)} cells={minimap} />
            </Box>
          )}
        </Box>
        {/* The breadcrumb's popover: drawn last, so it paints over the rows
            under the breadcrumb and moves none of them. */}
        {entries.length > 0 && (
          <Box
            position="absolute"
            top={1 + crumbLines}
            left={clamp(crumb.left, 0, columns - crumbWidth)}
            width={crumbWidth}
            flexDirection="column"
            borderStyle="round"
            borderColor={COMMIT_BOX}
            backgroundColor={CARD_BACKGROUND}
          >
            {entries.slice(crumbTop, crumbTop + crumbRows).map((entry, at) => (
              <Box height={1} overflow="hidden" backgroundColor={CARD_BACKGROUND}>
                <Text color={entry.color === '' ? undefined : entry.color}>
                  {' '}
                  {entry.glyph}{' '}
                </Text>
                <Button
                  plain
                  key={`crumb-row:${crumbTop + at}`}
                  label={entry.label.slice(0, crumbWidth - 12)}
                  onPress={entry.press}
                />
                {entry.isHere && <Text color={COMMIT_BOX}> ◂ here</Text>}
              </Box>
            ))}
            <Box columnGap={2} height={1} overflow="hidden" backgroundColor={CARD_BACKGROUND}>
              <Text dimColor>
                {' '}
                {crumbTop + 1}–{Math.min(entries.length, crumbTop + crumbRows)} of {entries.length}
              </Text>
              {entries.length > crumbRows && <Text dimColor>wheel to scroll</Text>}
              <Button plain key="crumb-close" label="close" onPress={actions.closeCrumb} />
            </Box>
          </Box>
        )}
      </Box>
    ),
  }
}
