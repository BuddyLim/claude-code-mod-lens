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
import type { Comment } from '../review'
import { clamp, wrapText } from '../text'
import { iconOf } from '../tree'
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
} from './frame'

// The most lines of one comment shown.
const COMMENT_LINES = 8
// How many of the conversation's latest comments are shown.
const CONVERSATION = 15
const ADDED_BACKGROUND = '#1f3a24'
const REMOVED_BACKGROUND = '#4b1d1d'

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
}

export type ChangesActions = {
  back: () => void
  refresh: () => void
  // Opens a file at a line, in the code view.
  open: (path: string, line: number) => void
  toggleReviewed: (path: string) => void
  // Moves the window so `row` is its first.
  scrollTo: (row: number) => void
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
  const { Box, Button, Text } = kit
  const { shell, files, comments } = model
  const reviewed = new Set(model.reviewed)
  const width = Math.max(20, shell.columns)
  const clean = (text: string): string =>
    text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, ' ')
  const rows: Row[] = []
  const add = (path: string, draw: () => RenderChildren) => rows.push({ path, draw })
  const blank = (path = '') => add(path, () => <Text> </Text>)

  // One comment under the line it is on (or in the conversation), its text
  // wrapped to the page, a row each; an answer is set in a little.
  const addComment = (path: string, one: Comment, lead: string) => {
    const color = one.isResolved === true ? RESOLVED_COLOR : talkColor(one)
    const indent = `${lead}${one.replyTo === undefined ? '' : '  '}`
    const body = wrapText(one.body.trim(), Math.max(20, width - indent.length - 4))

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
      Math.max(1, ...file.hunks.flatMap(hunk => hunk.lines.map(line => line.line))),
    ).length
    const drawn = new Set(file.hunks.flatMap(hunk => hunk.lines.map(line => line.line)))
    // A line in the colours the code view gives it, once the file has been
    // highlighted: the file as the comparison's new side has it, so a
    // removed line, which that side lacks, stays in the one colour. A line
    // whose text is not what the highlighter read is left plain.
    const spans = model.colors.get(path)
    const colored = (line: PatchLine) => {
      const found = line.line === 0 ? undefined : spans?.[line.line - 1]

      return found === undefined ||
        found.length === 0 ||
        clean(found.map(span => span[1]).join('')) !== clean(line.text)
        ? undefined
        : found.map(span => (span[0] === '' ? clean(span[1]) : <Text color={span[0]}>{clean(span[1])}</Text>))
    }
    const lineRow = (line: PatchLine) => (
      <Text wrap="truncate-end">
        <Text
          color={line.kind === '+' ? 'green' : line.kind === '-' ? 'red' : undefined}
          dimColor={line.kind === ' '}
        >
          {line.kind === ' ' ? ' ' : line.kind}
          {(line.line === 0 ? '' : String(line.line)).padStart(gutter)}{' '}
        </Text>
        <Text
          color={line.kind === '-' ? '#f48771' : undefined}
          backgroundColor={
            line.kind === '+' ? ADDED_BACKGROUND : line.kind === '-' ? REMOVED_BACKGROUND : undefined
          }
        >
          {colored(line) ?? (clean(line.text) || ' ')}
        </Text>
      </Text>
    )

    blank(path)
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

    for (const hunk of file.hunks) {
      const label = hunk.header === '' ? '' : ` ${hunk.header} `

      add(path, () => (
        <Text color={COMMIT_BOX} dimColor wrap="truncate-end">
          {'──'}
          {label}
          {'─'.repeat(Math.max(0, width - 2 - label.length))}
        </Text>
      ))

      for (const line of hunk.lines) {
        add(path, () => lineRow(line))

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
  const room = clamp(shell.rows - (3 + shell.notes.length), 5, 256)
  const maxTop = Math.max(0, rows.length - room)
  const top = clamp(model.top, 0, maxTop)
  const windowed = rows.slice(top, top + room)
  const moveTo = (row: number) => actions.scrollTo(clamp(row, 0, maxTop))

  const tree = (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} height={1} overflow="hidden">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="down" hotkey="d" label="down" onPress={() => moveTo(top + Math.floor(room / 2))} />
        <Button plain key="up" hotkey="u" label="up" onPress={() => moveTo(top - Math.floor(room / 2))} />
        <Button plain key="top" hotkey="g" label="top" onPress={() => moveTo(0)} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {helpButton(kit, actions.help)}
      </Box>
      {notesOf(kit, shell.notes)}
      <Box height={1} overflow="hidden">
        <Text bold>{model.title} </Text>
        {files !== undefined && (
          <Text dimColor>
            {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
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
