// The changes screen: every change of the comparison on one page, file after
// file, each hunk with a few lines round it and the review comments under
// the lines they are on. It is as long as the changes, so the pane scrolls
// it; a very long comparison is drawn up to a limit, and the rest by name.

import type { Span } from '../../types'
import type { PatchFile, PatchLine } from '../patch'
import type { Comment } from '../review'
import { wrapText } from '../text'
import { iconOf } from '../tree'
import type { Kit, Shell } from './frame'
import {
  COMMENT_COLOR,
  COMMENT_ICON,
  COMMIT_BOX,
  RESOLVED_COLOR,
  STATUS_WORD,
  helpButton,
  notesOf,
  statusLine,
} from './frame'

// How many rows of code the page draws at first, and how many more each time
// the person nears its end: a long comparison loads as it is read.
export const PAGE_STEP = 400
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
  // How many rows of code are drawn: the page stops at the first file they
  // have no room for.
  limit: number
}

export type ChangesActions = {
  back: () => void
  refresh: () => void
  // Opens a file at a line, in the code view.
  open: (path: string, line: number) => void
  toggleReviewed: (path: string) => void
  // Draws the next stretch of the page.
  more: () => void
  help: () => void
}

export const changesScreen = (kit: Kit, model: ChangesModel, actions: ChangesActions) => {
  const { Box, Button, Text } = kit
  const { shell, files, comments } = model
  const reviewed = new Set(model.reviewed)
  const width = Math.max(20, shell.columns)
  const clean = (text: string): string =>
    text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, ' ')
  const rule = (label: string) => (
    <Text color={COMMIT_BOX} dimColor wrap="truncate-end">
      {'──'}
      {label === '' ? '' : ` ${label} `}
      {'─'.repeat(Math.max(0, width - 2 - (label === '' ? 0 : label.length + 2)))}
    </Text>
  )

  // One comment under the line it is on (or in the conversation), its text
  // wrapped to the page; an answer is set in a little.
  const commentRows = (one: Comment, lead: string) => {
    const color = one.isResolved === true ? RESOLVED_COLOR : COMMENT_COLOR
    const indent = `${lead}${one.replyTo === undefined ? '' : '  '}`
    const body = wrapText(one.body.trim(), Math.max(20, width - indent.length - 4))

    return [
      <Text color={color} bold wrap="truncate-end">
        {indent}
        {one.replyTo === undefined ? COMMENT_ICON : '↳'} {one.author}
        {one.isResolved === true ? '  ✓ resolved' : ''}
        {one.isOutdated === true ? '  (outdated)' : ''}
      </Text>,
      ...body.slice(0, COMMENT_LINES).map(text => (
        <Text color={color} wrap="truncate-end">
          {indent}┃ {text === '' ? ' ' : text}
        </Text>
      )),
      body.length > COMMENT_LINES && (
        <Text color={color} dimColor>
          {indent}┃ … {body.length - COMMENT_LINES} more lines
        </Text>
      ),
    ]
  }
  // A thread reads first comment first, each answer after what it answers.
  const threaded = (list: readonly Comment[]): Comment[] =>
    list
      .filter(one => one.replyTo === undefined)
      .flatMap(root => [root, ...list.filter(one => one.replyTo === root.id)])

  let budget = model.limit
  let hidden = 0
  // The files whose code is drawn, for the hooks module to have highlighted.
  const shownPaths: string[] = []
  // About how many rows the page takes as drawn, for telling when the
  // person has scrolled near its end.
  let rows = 8 + shell.notes.length

  const fileRows = (file: PatchFile) => {
    const icon = iconOf(file.path)
    const change = STATUS_WORD[model.statusOf.get(file.path) ?? '']
    const here = comments.filter(one => one.path === file.path)
    const isDone = reviewed.has(file.path)
    const gutter = String(
      Math.max(1, ...file.hunks.flatMap(hunk => hunk.lines.map(line => line.line))),
    ).length
    const drawn = new Set(file.hunks.flatMap(hunk => hunk.lines.map(line => line.line)))
    const size = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)
    const isCut = hidden > 0 || (!isDone && budget < Math.min(size, 40))
    // A line in the colours the code view gives it, once the file has been
    // highlighted: the file as the comparison's new side has it, so a
    // removed line, which that side lacks, stays in the one colour. A line
    // whose text is not what the highlighter read is left plain.
    const spans = model.colors.get(file.path)
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

    // The page stops at the first file its rows have no room for: the rest
    // come as the person scrolls on.
    if (isCut) {
      hidden += 1

      return []
    }

    if (!isDone) {
      budget -= size
    }

    if (!isDone && !file.isBinary) {
      shownPaths.push(file.path)
    }

    // A comment takes about three rows: who, and a line or two of what.
    rows += 2 + (isDone ? 0 : size + here.length * 3)

    return [
      <Text> </Text>,
      <Box height={1} overflow="hidden">
        {model.canMark && (
          <Button
            plain
            key={`seen:${file.path}`}
            label={isDone ? '☑' : '☐'}
            onPress={() => actions.toggleReviewed(file.path)}
          />
        )}
        {model.canMark && <Text> </Text>}
        <Text color={icon.color}>{icon.glyph} </Text>
        <Button
          plain
          key={`page-file:${file.path}`}
          label={file.path}
          onPress={() => actions.open(file.path, 1)}
        />
        {change !== undefined && <Text color={change[1]}>  {change[0]}</Text>}
        <Text color="green">  +{file.added}</Text>
        <Text color="red"> −{file.deleted}</Text>
        {here.length > 0 && (
          <Text color={COMMENT_COLOR}>
            {'  '}
            {COMMENT_ICON} {here.filter(one => one.replyTo === undefined).length}
          </Text>
        )}
        {isDone && <Text dimColor>  reviewed, folded</Text>}
      </Box>,
      ...(isDone
        ? []
        : [
            // What is said of the file as a whole comes before its code.
            ...threaded(here.filter(one => one.line === 0)).flatMap(one => commentRows(one, '  ')),
            file.isBinary && <Text dimColor>  A binary file: nothing to show.</Text>,
            ...(isCut
              ? []
              : file.hunks.flatMap(hunk => [
                  rule(hunk.header),
                  ...hunk.lines.flatMap(line => [
                    lineRow(line),
                    ...(line.line === 0
                      ? []
                      : threaded(here.filter(one => one.line === line.line)).flatMap(one =>
                          commentRows(one, ' '.repeat(gutter + 2)),
                        )),
                  ]),
                ])),
            // A comment on a line the diff does not show is still said, with
            // a way to its line.
            ...threaded(here.filter(one => one.line > 0 && (isCut || !drawn.has(one.line)))).flatMap(
              one => [
                one.replyTo === undefined && (
                  <Box height={1} overflow="hidden">
                    <Text dimColor>  on </Text>
                    <Button
                      plain
                      key={`page-line:${one.id}`}
                      label={`line ${one.line}`}
                      onPress={() => actions.open(file.path, one.line)}
                    />
                    <Text dimColor>, outside the changes shown</Text>
                  </Box>
                ),
                ...commentRows(one, '  '),
              ],
            ),
          ]),
    ]
  }

  const general = comments.filter(one => one.path === '')
  const added = (files ?? []).reduce((sum, file) => sum + file.added, 0)
  const deleted = (files ?? []).reduce((sum, file) => sum + file.deleted, 0)
  const done = (files ?? []).filter(file => reviewed.has(file.path)).length
  const pages = (files ?? []).map(fileRows)

  const tree = (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2}>
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {helpButton(kit, actions.help)}
      </Box>
      {notesOf(kit, shell.notes)}
      <Box>
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
      </Box>
      {model.canMark && (
        <Text dimColor>Tick a file (☐) once you have read it: it folds, and stays ticked.</Text>
      )}
      {files === undefined && <Text dimColor>Reading the changes…</Text>}
      {model.refusal !== '' && <Text color="yellow">! git could not read the changes: {model.refusal}</Text>}
      {files !== undefined && files.length === 0 && model.refusal === '' && (
        <Text dimColor>Nothing differs.</Text>
      )}
      {model.untracked > 0 && (
        <Text dimColor>
          {model.untracked} new {model.untracked === 1 ? 'file is' : 'files are'} not here (git diffs
          only what it tracks): open {model.untracked === 1 ? 'it' : 'them'} from the file tree.
        </Text>
      )}
      {general.length > 0 && <Text> </Text>}
      {general.length > 0 && <Text bold>Conversation ({general.length})</Text>}
      {general.slice(-CONVERSATION).flatMap(one => commentRows(one, ''))}
      {pages}
      {hidden > 0 && <Text> </Text>}
      {hidden > 0 && (
        <Box columnGap={2}>
          <Button plain key="more" hotkey="m" label="load more" onPress={actions.more} />
          <Text dimColor>
            {hidden} more {hidden === 1 ? 'file' : 'files'} below: they load as you scroll on
          </Text>
        </Box>
      )}
    </Box>
  )

  return {
    tree,
    rows: rows + general.slice(-CONVERSATION).length * 3,
    isCut: hidden > 0,
    shown: shownPaths,
  }
}
