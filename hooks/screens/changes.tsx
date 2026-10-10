// The changes screen: every change of the comparison on one page, file after
// file, each hunk with a few lines round it and the review comments under
// the lines they are on.
//
// The page is laid out as rows, each one row of the pane tall, and only the
// rows the window has room for are drawn: a tree the engine draws is bounded
// (in its nodes and in its text), and a long comparison would pass that
// bound many times over. What the scroll hook needs to move the window is
// handed back with the tree, as the file screen does.

import type { RenderChildren } from 'claude-code'

import type { Span } from '../../types'
import { isFinding } from '../ledger'
import type { PatchFile, PatchLine } from '../patch'
import { hunkMark } from '../patch'
import type { Comment } from '../review'
import { clamp, wrapText } from '../text'
import { iconOf } from '../tree'
import type { Stretch } from '../words'
import { changedWords } from '../words'
import type { Kit, Shell } from './frame'
import {
  COMMENT_COLOR,
  COMMENT_ICON,
  COMMIT_BOX,
  LEDGER_COLOR,
  LEDGER_ICON,
  RESOLVED_COLOR,
  STATUS_WORD,
  talkColor,
  talkIcon,
  helpButton,
  notesOf,
  statusLine,
  FILES_ICON,
} from './frame'

// The most lines of one comment shown.
const COMMENT_LINES = 8
// How many of the conversation's latest comments are shown.
const CONVERSATION = 15
const ADDED_BACKGROUND = '#1f3a24'
const REMOVED_BACKGROUND = '#4b1d1d'
// The words that differ within a rewritten line, lit over the line's own.
const ADDED_WORD = '#2f7d43'
const REMOVED_WORD = '#9b2f2f'
// How wide the row of keys is when it is all on one line, and how many rows
// are left above a row a jump key goes to.
const KEYS_WIDTH = 260
const LEAD = 2
// The narrowest pane the two sides are drawn beside each other in.
export const SPLIT_WIDTH = 90

export type ChangesModel = {
  shell: Shell
  // What the page is of, in a few words ("PR #12", "Uncommitted changes").
  title: string
  // The comparison's files, or undefined while git is being asked; and git's
  // reason when it could not be read.
  files: readonly PatchFile[] | undefined
  refusal: string
  // Each file's status letter as git gives it (M, A, D, ...), by path.
  statusOf: ReadonlyMap<string, string>
  // The comments of the request under review, and the ledger's findings.
  comments: readonly Comment[]
  // Whether files can be ticked as reviewed (a request is under review), and
  // those that are: a ticked file is folded to its name.
  canMark: boolean
  reviewed: readonly string[]
  // How many new files git does not track yet, which its diff leaves out.
  untracked: number
  // Each file's lines as the highlighter coloured them, by path, for those
  // read so far: a file not here yet is drawn plain.
  colors: ReadonlyMap<string, readonly (readonly Span[])[]>
  // The first row of the page the window shows, 0-based.
  top: number
  // How many unchanged lines show round each change, and whether lines that
  // differ only in their spaces are left out.
  context: number
  ignoresSpace: boolean
  // Whether the two sides are drawn beside each other, where the pane is
  // wide enough; else one under the other.
  isSplit: boolean
  // The search: whether its field is open, and what is looked for ('' for
  // nothing). A number that changes when the field is to start empty.
  isFinding: boolean
  find: string
  // Whether a change can be staged, taken back or undone a hunk at a time:
  // the comparison is of the working tree with what is checked out. The
  // marks (see `hunkMark`) of the hunks the index holds; the hunk whose
  // undoing is being asked about (`path` and its place among the file's
  // hunks, '' for none); and whether the field for a commit's message shows.
  canStage: boolean
  staged: ReadonlySet<string>
  asking: string
  isCommitting: boolean
}

export type ChangesActions = {
  back: () => void
  refresh: () => void
  // Opens a file at a line, in the code view.
  open: (path: string, line: number) => void
  toggleReviewed: (path: string) => void
  // Moves the window so `row` is its first.
  scrollTo: (row: number) => void
  // Tells the person something in passing (a toast).
  say: (text: string) => void
  // Shows more unchanged lines round each change (it goes round), and
  // leaves out, or shows again, lines that differ only in their spaces.
  moreContext: () => void
  toggleSpace: () => void
  // Draws the two sides beside each other, or one under the other again.
  toggleSplit: () => void
  // Shows more of one file round its changes, where the rest keep theirs.
  expand: (path: string) => void
  // The search: opens or closes its field, and looks for a text.
  toggleFind: () => void
  setFind: (text: string) => void
  // One hunk of a file, by its place among the file's: staged, taken back
  // out of the index, or undone in the working tree. Undoing is asked about
  // first (`ask`, with the hunk's mark; '' takes the question away). `mark`
  // is what the hunk was when its button was drawn: one that has changed
  // since is left alone.
  hunk: (path: string, index: number, how: 'stage' | 'unstage' | 'discard', mark: string) => void
  ask: (name: string) => void
  // Opens or closes the field for a commit's message, and commits what is
  // staged with one.
  toggleCommit: () => void
  commitStaged: (message: string) => void
  help: () => void
}

// The window as drawn, for the scroll hook: the furthest its first row may go.
export type ChangesWindow = { maxTop: number }

// One row of the page: what draws it, and the file it belongs to ('' for a
// row of the page's own).
type Row = { path: string; draw: () => RenderChildren }

export const changesScreen = (
  kit: Kit,
  model: ChangesModel,
  actions: ChangesActions,
): { tree: RenderChildren; window: ChangesWindow; shown: string[] } => {
  const { Box, Button, Text, Input } = kit
  const { shell, files, comments } = model
  const reviewed = new Set(model.reviewed)
  const width = Math.max(20, shell.columns)
  const clean = (text: string): string =>
    text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, ' ')
  const rows: Row[] = []
  // The rows the jump keys go to: where each file, each change and each
  // thread starts.
  const fileRows: number[] = []
  const changeRows: number[] = []
  const talkRows: number[] = []
  // And the rows that hold what is being looked for, whatever its case.
  const findRows: number[] = []
  const sought = model.find.trim().toLowerCase()
  // The two sides are drawn beside each other only where each has room to
  // be read: a narrow pane keeps one under the other.
  const isSplit = model.isSplit && width >= SPLIT_WIDTH
  const half = Math.floor((width - 1) / 2)
  const add = (path: string, draw: () => RenderChildren) => rows.push({ path, draw })
  const blank = (path = '') => add(path, () => <Text> </Text>)

  // One comment under the line it is on (or in the conversation), its text
  // wrapped to the page, a row each; an answer is set in a little.
  const addComment = (path: string, one: Comment, lead: string) => {
    const color = one.isResolved === true ? RESOLVED_COLOR : talkColor(one)
    const indent = `${lead}${one.replyTo === undefined ? '' : '  '}`
    const body = wrapText(one.body.trim(), Math.max(20, width - indent.length - 4))

    if (one.replyTo === undefined) {
      talkRows.push(rows.length)
    }

    add(path, () => (
      <Text color={color} bold wrap="truncate-end">
        {indent}
        {one.replyTo === undefined ? talkIcon(one) : '↳'} {one.author}
        {one.isResolved === true ? '  ✓ resolved' : ''}
        {one.isOutdated === true ? '  (outdated)' : ''}
      </Text>
    ))

    for (const text of body.slice(0, COMMENT_LINES)) {
      add(path, () => (
        <Text color={color} wrap="truncate-end">
          {indent}┃ {text === '' ? ' ' : text}
        </Text>
      ))
    }

    if (body.length > COMMENT_LINES) {
      add(path, () => (
        <Text color={color} dimColor>
          {indent}┃ … {body.length - COMMENT_LINES} more lines
        </Text>
      ))
    }
  }
  // A thread reads first comment first, each answer after what it answers.
  const threaded = (list: readonly Comment[]): Comment[] =>
    list
      .filter(one => one.replyTo === undefined)
      .flatMap(root => [root, ...list.filter(one => one.replyTo === root.id)])

  const addFile = (file: PatchFile) => {
    const { path } = file
    const icon = iconOf(path)
    const change = STATUS_WORD[model.statusOf.get(path) ?? '']
    const here = comments.filter(one => one.path === path)
    const isDone = reviewed.has(path)
    const gutter = String(
      Math.max(1, ...file.hunks.flatMap(hunk => hunk.lines.map(line => Math.max(line.line, line.old)))),
    ).length
    const drawn = new Set(file.hunks.flatMap(hunk => hunk.lines.map(line => line.line)))
    // A line in the colours the code view gives it, once the file has been
    // highlighted: the file as the comparison's new side has it, so a
    // removed line, which that side lacks, stays in the one colour. A line
    // whose text is not what the highlighter read is left plain.
    const spans = model.colors.get(path)
    // A line's text as pieces, each in its colour, with the words that
    // differ from the line it replaced (or that replaced it) lit: `lit` is
    // those words' stretches of the line.
    const pieces = (line: PatchLine, lit: readonly Stretch[]) => {
      const found = line.line === 0 ? undefined : spans?.[line.line - 1]
      const text = clean(line.text)
      const parts: [color: string, text: string][] =
        found === undefined || found.length === 0 || clean(found.map(span => span[1]).join('')) !== text
          ? [['', text]]
          : found.map(span => [span[0], clean(span[1])])
      const strong = line.kind === '+' ? ADDED_WORD : REMOVED_WORD
      let at = 0

      return parts.flatMap(([color, part]) => {
        // The part is cut where a lit stretch starts or ends inside it.
        const cuts = [
          ...new Set(
            [0, part.length, ...lit.flatMap(([from, to]) => [from - at, to - at])].filter(
              cut => cut >= 0 && cut <= part.length,
            ),
          ),
        ].sort((one, other) => one - other)
        const start = at

        at += part.length

        return cuts.slice(0, -1).flatMap((cut, index) => {
          const piece = part.slice(cut, cuts[index + 1])
          const isLit = lit.some(([from, to]) => start + cut >= from && start + cut < to)

          return piece === ''
            ? []
            : [
                color === '' && !isLit ? (
                  piece
                ) : (
                  <Text
                    {...(color === '' ? {} : { color })}
                    {...(isLit ? { backgroundColor: strong, bold: true } : {})}
                  >
                    {piece}
                  </Text>
                ),
              ]
        })
      })
    }
    // `isOld` numbers the line by the old side (the left of the two, where
    // they are drawn beside each other); `isFound` marks a line the search
    // found.
    const lineRow = (line: PatchLine, lit: readonly Stretch[], isOld = false, isFound = false) => (
      <Text wrap="truncate-end">
        <Text
          color={isFound ? 'yellow' : line.kind === '+' ? 'green' : line.kind === '-' ? 'red' : undefined}
          dimColor={line.kind === ' ' && !isFound}
          bold={isFound}
        >
          {isFound ? '▶' : line.kind === ' ' ? ' ' : line.kind}
          {((isOld ? line.old : line.line) === 0 ? '' : String(isOld ? line.old : line.line)).padStart(gutter)}{' '}
        </Text>
        <Text
          color={line.kind === '-' ? '#f48771' : undefined}
          backgroundColor={
            line.kind === '+' ? ADDED_BACKGROUND : line.kind === '-' ? REMOVED_BACKGROUND : undefined
          }
        >
          {clean(line.text) === '' ? ' ' : pieces(line, lit)}
        </Text>
      </Text>
    )

    blank(path)
    fileRows.push(rows.length)
    add(path, () => [
      model.canMark && (
        <Button
          plain
          key={`seen:${path}`}
          label={isDone ? '☑' : '☐'}
          onPress={() => actions.toggleReviewed(path)}
        />
      ),
      model.canMark && <Text> </Text>,
      <Text color={icon.color}>{icon.glyph} </Text>,
      <Button plain key={`page-file:${path}`} label={path} onPress={() => actions.open(path, 1)} />,
      change !== undefined && <Text color={change[1]}>  {change[0]}</Text>,
      <Text color="green">  +{file.added}</Text>,
      <Text color="red"> −{file.deleted}</Text>,
      // The file's threads, a request's comments and the ledger's findings
      // counted apart, each in its colour.
      ...[false, true].map(isLedger => {
        const count = here.filter(one => one.replyTo === undefined && isFinding(one) === isLedger).length

        return (
          count > 0 && (
            <Text color={isLedger ? LEDGER_COLOR : COMMENT_COLOR}>
              {'  '}
              {isLedger ? LEDGER_ICON : COMMENT_ICON} {count}
            </Text>
          )
        )
      }),
      isDone && <Text dimColor>  reviewed, folded</Text>,
    ])

    if (isDone) {
      return
    }

    // What is said of the file as a whole comes before its code.
    for (const one of threaded(here.filter(one => one.line === 0))) {
      addComment(path, one, '  ')
    }

    if (file.isBinary) {
      add(path, () => <Text dimColor>  A binary file: nothing to show.</Text>)
    }

    for (const [index, hunk] of file.hunks.entries()) {
      const label = hunk.header === '' ? '' : ` ${hunk.header} `
      const name = `${path}:${index}`
      // What the hunk is, whichever way the page is next read: what is asked
      // about and acted on is this hunk, not whatever comes to hold its place.
      const mark = hunkMark(file, hunk)
      const isStaged = model.canStage && model.staged.has(mark)

      // The hunk's rule carries what can be done with it: more of the file
      // round it, and, where the change is the working tree's, staging it
      // or undoing it. Undoing cannot be taken back, so it is asked about.
      add(path, () => [
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={COMMIT_BOX} dimColor wrap="truncate-end">
            {'──'}
            {label}
            {'─'.repeat(Math.max(0, width - 2 - label.length))}
          </Text>
        </Box>,
        <Box flexShrink={0} columnGap={2} marginLeft={1}>
          {model.asking === mark ? (
            [
              <Text color="red" bold>
                undo this change in your file?
              </Text>,
              <Button plain key={`hunk-yes:${name}`} label="yes" onPress={() => actions.hunk(path, index, 'discard', mark)} />,
              <Button plain key={`hunk-no:${name}`} label="no" onPress={() => actions.ask('')} />,
            ]
          ) : (
            [
              <Button plain key={`hunk-more:${name}`} label="⇕ more" onPress={() => actions.expand(path)} />,
              model.canStage && isStaged && <Text color="green">staged ✓</Text>,
              model.canStage && isStaged && (
                <Button plain key={`hunk-unstage:${name}`} label="unstage" onPress={() => actions.hunk(path, index, 'unstage', mark)} />
              ),
              model.canStage && !isStaged && (
                <Button plain key={`hunk-stage:${name}`} label="stage" onPress={() => actions.hunk(path, index, 'stage', mark)} />
              ),
              model.canStage && !isStaged && (
                <Button plain key={`hunk-discard:${name}`} label="discard" onPress={() => actions.ask(mark)} />
              ),
            ]
          )}
        </Box>,
      ])

      // A run of removed lines followed by a run of added ones is taken as
      // those lines rewritten, one for one in order: the words that differ
      // between each pair are lit in both. Worked out when a row is drawn,
      // and once for its pair.
      const partner = new Map<PatchLine, PatchLine>()

      for (let at = 0; at < hunk.lines.length; at += 1) {
        if (hunk.lines[at]?.kind !== '-') {
          continue
        }

        let end = at

        while (hunk.lines[end]?.kind === '-') {
          end += 1
        }

        for (let k = 0; at + k < end && hunk.lines[end + k]?.kind === '+'; k += 1) {
          const [gone, come] = [hunk.lines[at + k], hunk.lines[end + k]]

          if (gone !== undefined && come !== undefined) {
            partner.set(gone, come)
            partner.set(come, gone)
          }
        }

        at = end - 1
      }

      const litOf = (line: PatchLine): readonly Stretch[] => {
        const other = partner.get(line)

        if (other === undefined) {
          return []
        }

        const [gone, come] = line.kind === '-' ? [line, other] : [other, line]
        const found = changedWords(clean(gone.text), clean(come.text))

        return line.kind === '-' ? found.before : found.after
      }

      // Whether a line holds what is being looked for.
      const isHit = (line: PatchLine | undefined): boolean =>
        line !== undefined && sought !== '' && clean(line.text).toLowerCase().includes(sought)

      if (isSplit) {
        // The two sides beside each other: an unchanged line on both, a
        // removed line on the left of the added line that replaced it, and
        // what was only removed or only added with nothing across from it.
        const pairs: [PatchLine | undefined, PatchLine | undefined][] = []

        for (let at = 0; at < hunk.lines.length; ) {
          const line = hunk.lines[at]

          if (line === undefined) {
            break
          }

          if (line.kind === ' ') {
            pairs.push([line, line])
            at += 1
            continue
          }

          const gone: PatchLine[] = []
          const come: PatchLine[] = []

          while (hunk.lines[at]?.kind === '-') {
            gone.push(hunk.lines[at] as PatchLine)
            at += 1
          }

          while (hunk.lines[at]?.kind === '+') {
            come.push(hunk.lines[at] as PatchLine)
            at += 1
          }

          for (let k = 0; k < Math.max(gone.length, come.length); k += 1) {
            pairs.push([gone[k], come[k]])
          }
        }

        for (const [at, [left, right]] of pairs.entries()) {
          const isChange = left?.kind === '-' || right?.kind === '+'
          const before = pairs[at - 1]

          if (isChange && (before === undefined || (before[0]?.kind !== '-' && before[1]?.kind !== '+'))) {
            changeRows.push(rows.length)
          }

          if (isHit(left) || isHit(right)) {
            findRows.push(rows.length)
          }

          add(path, () => [
            <Box width={half} flexShrink={0} overflow="hidden">
              {left === undefined ? <Text> </Text> : lineRow(left, litOf(left), true, isHit(left))}
            </Box>,
            <Text color={COMMIT_BOX} dimColor>
              │
            </Text>,
            <Box width={half} flexShrink={0} overflow="hidden">
              {right === undefined ? <Text> </Text> : lineRow(right, litOf(right), false, isHit(right))}
            </Box>,
          ])

          if (right !== undefined && right.line !== 0) {
            for (const one of threaded(here.filter(one => one.line === right.line))) {
              addComment(path, one, ' '.repeat(half + gutter + 3))
            }
          }
        }

        continue
      }

      for (const [at, line] of hunk.lines.entries()) {
        // A change starts where a changed line follows an unchanged one.
        if (line.kind !== ' ' && (hunk.lines[at - 1]?.kind ?? ' ') === ' ') {
          changeRows.push(rows.length)
        }

        if (isHit(line)) {
          findRows.push(rows.length)
        }

        add(path, () => lineRow(line, litOf(line), false, isHit(line)))

        if (line.line !== 0) {
          for (const one of threaded(here.filter(one => one.line === line.line))) {
            addComment(path, one, ' '.repeat(gutter + 2))
          }
        }
      }
    }

    // A comment on a line the diff does not show is still said, with a way
    // to its line.
    for (const one of threaded(here.filter(one => one.line > 0 && !drawn.has(one.line)))) {
      if (one.replyTo === undefined) {
        add(path, () => [
          <Text dimColor>  on </Text>,
          <Button
            plain
            key={`page-line:${one.id}`}
            label={`line ${one.line}`}
            onPress={() => actions.open(path, one.line)}
          />,
          <Text dimColor>, outside the changes shown</Text>,
        ])
      }

      addComment(path, one, '  ')
    }
  }

  const general = comments.filter(one => one.path === '')
  const added = (files ?? []).reduce((sum, file) => sum + file.added, 0)
  const deleted = (files ?? []).reduce((sum, file) => sum + file.deleted, 0)
  const done = (files ?? []).filter(file => reviewed.has(file.path)).length

  // What the page says before its files: how to tick, what is left out, why
  // nothing shows, and the conversation.
  if (model.canMark) {
    add('', () => (
      <Text dimColor wrap="truncate-end">
        Tick a file (☐) once you have read it: it folds, and stays ticked.
      </Text>
    ))
  }

  if (files === undefined) {
    add('', () => <Text dimColor>Reading the changes…</Text>)
  }

  if (model.refusal !== '') {
    add('', () => (
      <Text color="yellow" wrap="truncate-end">
        ! git could not read the changes: {model.refusal}
      </Text>
    ))
  }

  if (files !== undefined && files.length === 0 && model.refusal === '') {
    add('', () => <Text dimColor>Nothing differs.</Text>)
  }

  if (model.untracked > 0) {
    add('', () => (
      <Text dimColor wrap="truncate-end">
        {model.untracked} new {model.untracked === 1 ? 'file is' : 'files are'} not here (git diffs
        only what it tracks): open {model.untracked === 1 ? 'it' : 'them'} from the file tree.
      </Text>
    ))
  }

  if (general.length > 0) {
    blank()
    add('', () => <Text bold>Conversation ({general.length})</Text>)

    for (const one of general.slice(-CONVERSATION)) {
      addComment('', one, '')
    }
  }

  for (const file of files ?? []) {
    addFile(file)
  }

  // The status line, the keys, the notes and the title; the window gets
  // what is left of the pane.
  // The keys wrap onto as many rows as the pane's width makes of them.
  const keyRows = Math.ceil(KEYS_WIDTH / Math.max(20, shell.columns))
  // The search's row and the commit's, while each is open, and the row that
  // says what is staged.
  const stagedCount = model.canStage ? model.staged.size : 0
  const extraRows =
    (model.isFinding && Input !== undefined ? 1 : 0) +
    (stagedCount > 0 ? 1 : 0) +
    (model.isCommitting && Input !== undefined ? 1 : 0)
  const room = clamp(shell.rows - (2 + keyRows + extraRows + shell.notes.length), 5, 256)
  const maxTop = Math.max(0, rows.length - room)
  const top = clamp(model.top, 0, maxTop)
  const windowed = rows.slice(top, top + room)
  const moveTo = (row: number) => actions.scrollTo(clamp(row, 0, maxTop))
  // The next of a kind below the window's first row, or the one above it;
  // from the last it goes round to the first. A row is brought a little
  // under the top, so what leads up to it shows.
  const jump = (list: readonly number[], way: 1 | -1, what: string) => {
    const here = top + LEAD
    const next =
      way === 1
        ? (list.find(row => row > here) ?? list[0])
        : ([...list].reverse().find(row => row < here) ?? list[list.length - 1])

    if (next === undefined) {
      actions.say(`No ${what} on this page`)
    } else {
      moveTo(next - LEAD)
    }
  }

  const tree = (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} height={keyRows} overflow="hidden" flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="down" hotkey="d" label="down" onPress={() => moveTo(top + Math.floor(room / 2))} />
        <Button plain key="up" hotkey="u" label="up" onPress={() => moveTo(top - Math.floor(room / 2))} />
        <Button plain key="top" hotkey="g" label="top" onPress={() => moveTo(0)} />
        <Button plain key="next-file" hotkey="n" label="next file" onPress={() => jump(fileRows, 1, 'file')} />
        <Button plain key="prev-file" hotkey="p" label="prev file" onPress={() => jump(fileRows, -1, 'file')} />
        <Button plain key="next-change" hotkey="j" label="next change" onPress={() => jump(changeRows, 1, 'change')} />
        <Button plain key="prev-change" hotkey="k" label="prev change" onPress={() => jump(changeRows, -1, 'change')} />
        <Button plain key="next-talk" hotkey="c" label="next comment" onPress={() => jump(talkRows, 1, 'comment')} />
        <Button plain key="prev-talk" hotkey="x" label="prev comment" onPress={() => jump(talkRows, -1, 'comment')} />
        <Button plain key="context" hotkey="e" label={`context: ${model.context}`} onPress={actions.moreContext} />
        <Button
          plain
          key="space"
          hotkey="w"
          label={`spaces: ${model.ignoresSpace ? 'ignored' : 'shown'}`}
          onPress={actions.toggleSpace}
        />
        <Button
          plain
          key="split"
          hotkey="v"
          label={model.isSplit ? 'one column' : 'side by side'}
          onPress={() =>
            !model.isSplit && width < SPLIT_WIDTH
              ? actions.say(`The pane is too narrow to draw the two sides beside each other (it needs ${SPLIT_WIDTH} columns)`)
              : actions.toggleSplit()
          }
        />
        <Button plain key="find" hotkey="f" label={model.isFinding ? 'close find' : 'find'} onPress={actions.toggleFind} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {helpButton(kit, actions.help)}
      </Box>
      {/* The search: Enter goes to the next line that holds the text. */}
      {model.isFinding && Input !== undefined && (
        <Box height={1} overflow="hidden" columnGap={2}>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Input
              key="page-find"
              label="find"
              placeholder="text to look for in the changes, then Enter for the next"
              submitLabel="next"
              autoFocus
              {...(model.find === '' ? {} : { value: model.find })}
              onSubmit={value => {
                // The same text again goes on to its next line; a new one
                // is looked for from where the window is.
                if (value.trim().toLowerCase() === sought && sought !== '') {
                  jump(findRows, 1, 'more lines with that')
                } else {
                  actions.setFind(value)
                }
              }}
            />
          </Box>
          <Box flexShrink={0} columnGap={2}>
            <Text dimColor>
              {sought === '' ? '' : `${findRows.length} ${findRows.length === 1 ? 'line' : 'lines'}`}
            </Text>
            <Button plain key="find-prev" label="prev" onPress={() => jump(findRows, -1, 'line with that')} />
            <Button plain key="find-next" label="next" onPress={() => jump(findRows, 1, 'line with that')} />
          </Box>
        </Box>
      )}
      {/* What is staged, and the way to commit it: the message's field
          opens on its own row. */}
      {stagedCount > 0 && (
        <Box height={1} overflow="hidden" columnGap={2}>
          <Text color="green">
            {stagedCount} {stagedCount === 1 ? 'change' : 'changes'} staged
          </Text>
          <Button
            plain
            key="commit-staged"
            label={model.isCommitting ? 'cancel' : 'commit what is staged'}
            onPress={actions.toggleCommit}
          />
        </Box>
      )}
      {model.isCommitting && Input !== undefined && (
        <Box height={1} overflow="hidden">
          <Input
            key="page-commit"
            label="message"
            placeholder="what changed, then Enter to commit what is staged"
            submitLabel="commit"
            autoFocus
            onSubmit={actions.commitStaged}
          />
        </Box>
      )}
      {notesOf(kit, shell.notes)}
      <Box height={1} overflow="hidden">
        <Text bold>{model.title} </Text>
        {files !== undefined && (
          <Text dimColor>
            {FILES_ICON} {files.length} ·{' '}
          </Text>
        )}
        {files !== undefined && <Text color="green">+{added} </Text>}
        {files !== undefined && <Text color="red">−{deleted}</Text>}
        {files !== undefined && model.canMark && (
          <Text bold={done === files.length && done > 0} dimColor={done < files.length}>
            {' '}
            · {done} of {files.length} reviewed
          </Text>
        )}
        {rows.length > room && (
          <Text dimColor>
            {' '}
            · rows {top + 1}–{Math.min(rows.length, top + room)} of {rows.length}
          </Text>
        )}
      </Box>
      <Box flexDirection="column" height={room} overflow="hidden">
        {windowed.map(row => (
          <Box height={1} overflow="hidden">
            {row.draw()}
          </Box>
        ))}
      </Box>
    </Box>
  )

  return {
    tree,
    window: { maxTop },
    // The files in the window, and in the next one, are those to highlight.
    shown: [
      ...new Set(
        rows
          .slice(top, top + 2 * room)
          .map(row => row.path)
          .filter(path => {
            const file = path === '' ? undefined : (files ?? []).find(one => one.path === path)

            // A symbolic link is not read: what it points at is no file of
            // the change.
            return file !== undefined && !file.isBinary && !file.isLink && !reviewed.has(path)
          }),
      ),
    ],
  }
}
