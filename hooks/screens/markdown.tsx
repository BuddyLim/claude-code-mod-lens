// A markdown file as it reads, not as it is written: headings, lists, tables
// and code blocks drawn as a reply's are, with a request's review threads
// set under the blocks they were made on. The rendered page is as tall as it
// comes out, so the pane scrolls it, not the mod; the diff view and `m` show
// the source, on the file screen.

import type { Comment } from '../review'
import type { TableCell } from '../text'
import { chunkMarkdown, splitMarkdown, tableWidths, wrapText } from '../text'
import type { Kit, Shell } from './frame'
import { COMMENT_COLOR, COMMENT_ICON, RESOLVED_COLOR, helpButton, statusLine } from './frame'

const MARKDOWN = /\.(md|mdx|markdown)$/i
// A Markdown element takes so much text at once, and a pane's tree so much in
// all: a file is rendered in pieces, and a very long one only so far.
const MARKDOWN_CHUNK = 9000
const MARKDOWN_CHUNKS = 9
// A table cell written as code, in the colour code has in a reply.
const TABLE_CODE = '#9cdcfe'
// The most cells across a review thread's card.
const TALK_WIDTH = 100

export const isMarkdownFile = (path: string): boolean => MARKDOWN.test(path)

export type MarkdownModel = {
  shell: Shell
  file: string
  // The commit the file is shown at; '' for the working tree's.
  commit: string
  text: string
  // The review threads on the file's lines, replies after the comment they
  // answer; none where no request is under review.
  talk: readonly Comment[]
}

export type MarkdownActions = {
  // Returns to where the file was opened from.
  back: () => void
  help: () => void
  showSource: () => void
  showDiff: () => void
  // Puts what was dragged over into the prompt.
  sendSelection: () => void
  // Puts the thread on a line, with the lines it is about, into the prompt.
  sendTalk: (line: number) => void
  // Shows the source at a line, where a thread is answered and resolved.
  openSource: (line: number) => void
}

// What the page is made of, top to bottom: stretches of markdown, and the
// threads set between them.
type Segment = { kind: 'text'; text: string } | { kind: 'talk'; line: number; thread: Comment[] }

// The file cut where its threads go. A thread belongs under the block its
// line is in (a paragraph, a list, a table, a fenced block), so the text is
// cut at that block's end: the next blank line outside a fence, a fence's
// closing line, or the file's end.
const segmentsOf = (text: string, talk: readonly Comment[]): Segment[] => {
  const byLine = new Map<number, Comment[]>()

  for (const one of talk) {
    byLine.set(one.line, [...(byLine.get(one.line) ?? []), one])
  }

  const segments: Segment[] = []
  const lines = text.split('\n')
  let held: string[] = []
  let due: number[] = []
  let isFenced = false

  lines.forEach((line, at) => {
    const isFence = /^\s*(```|~~~)/.test(line)

    if (isFence) {
      isFenced = !isFenced
    }

    held.push(line)

    if (byLine.has(at + 1)) {
      due.push(at + 1)
    }

    const isBlockEnd = !isFenced && (isFence || line.trim() === '' || at === lines.length - 1)

    if (due.length > 0 && isBlockEnd) {
      segments.push({ kind: 'text', text: held.join('\n') })
      segments.push(...due.map(n => ({ kind: 'talk' as const, line: n, thread: byLine.get(n) ?? [] })))
      held = []
      due = []
    }
  })

  if (held.some(line => line.trim() !== '')) {
    segments.push({ kind: 'text', text: held.join('\n') })
  }

  // A thread on a line the file no longer reaches still shows, at the end.
  for (const [n, thread] of byLine) {
    if (n > lines.length || due.includes(n)) {
      segments.push({ kind: 'talk', line: n, thread })
    }
  }

  return segments
}

// Only a surface that has a Markdown element can draw this: the caller shows
// the source where there is none.
export const markdownScreen = (
  kit: Kit & { Markdown: NonNullable<Kit['Markdown']> },
  model: MarkdownModel,
  actions: MarkdownActions,
) => {
  const { Box, Button, Text, Markdown } = kit
  const { shell, file, commit } = model

  // Tables are drawn here, to the room the pane has: the Markdown element
  // lays one out wider than a narrow pane and it wraps into a tangle. The
  // text between them is the element's to render, a piece at a time.
  let budget = MARKDOWN_CHUNKS
  let isCut = false
  const gap = 3
  const table = (header: readonly TableCell[], rows: readonly (readonly TableCell[])[]) => {
    const widths = tableWidths([header, ...rows], shell.columns - 2, gap)
    // A row is as tall as its tallest cell once each is wrapped to its column.
    const drawn = (cells: readonly TableCell[], isHeader: boolean) => {
      const wrapped = widths.map((width, column) => wrapText(cells[column]?.text ?? '', width))
      const height = Math.max(1, ...wrapped.map(lines => lines.length))

      return Array.from({ length: height }, (_, line) => (
        <Box>
          {widths.map((width, column) => [
            column > 0 && <Text dimColor> │ </Text>,
            <Box width={width} height={1} overflow="hidden">
              <Text
                bold={isHeader}
                color={!isHeader && cells[column]?.isCode === true ? TABLE_CODE : undefined}
              >
                {wrapped[column]?.[line] ?? ''}
              </Text>
            </Box>,
          ])}
        </Box>
      ))
    }
    const rule = (mark: string, cross: string) => (
      <Text dimColor wrap="truncate-end">
        {widths.map(width => mark.repeat(width)).join(`${mark}${cross}${mark}`)}
      </Text>
    )

    return (
      <Box flexDirection="column" marginY={1} paddingX={1}>
        {drawn(header, true)}
        {rule('─', '┼')}
        {rows.flatMap((row, at) => [at > 0 && rule('┄', '┼'), ...drawn(row, false)])}
      </Box>
    )
  }
  const rendered = (text: string) =>
    splitMarkdown(text).flatMap(piece => {
      if (piece.kind === 'table') {
        return [table(piece.header, piece.rows)]
      }

      const pages = chunkMarkdown(piece.text, MARKDOWN_CHUNK)
      const fits = pages.slice(0, Math.max(0, budget))

      budget -= pages.length
      isCut ||= fits.length < pages.length

      return fits.map(page => <Markdown text={page} />)
    })
  // A thread as a card, as the file screen draws one: who and when, what
  // was said, replies indented. Answering and resolving are done on the
  // source, which its last row opens at the thread's line.
  const width = Math.max(24, Math.min(TALK_WIDTH, shell.columns - 2))
  const card = (line: number, thread: readonly Comment[]) => {
    const isSettled = thread.some(one => one.isResolved === true)
    const color = isSettled ? RESOLVED_COLOR : COMMENT_COLOR

    return (
      <Box
        width={width}
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        marginBottom={1}
      >
        {thread.flatMap((one, at) => {
          const indent = at === 0 ? '' : '  '

          return [
            <Text bold color={color} wrap="truncate-end">
              {indent}
              {at === 0 ? COMMENT_ICON : '↳'} {one.author} · {one.when.slice(0, 10)}
              {at === 0 ? ` · line ${line}` : ''}
              {at === 0 && isSettled ? ' · ✓ resolved' : ''}
            </Text>,
            ...wrapText(one.body.trim(), width - 4 - indent.length).map(text => (
              <Text>
                {indent}
                {text}
              </Text>
            )),
          ]
        })}
        <Box columnGap={3}>
          <Button
            plain
            key={`page-talk-source:${line}`}
            label="↩ reply or resolve in source"
            onPress={() => actions.openSource(line)}
          />
          <Button
            plain
            key={`page-talk-send:${line}`}
            label="↗ to prompt"
            onPress={() => actions.sendTalk(line)}
          />
        </Box>
      </Box>
    )
  }
  const body = segmentsOf(model.text, model.talk).flatMap(segment =>
    segment.kind === 'text' ? rendered(segment.text) : [card(segment.line, segment.thread)],
  )

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        {helpButton(kit, actions.help)}
        <Button plain key="source" hotkey="m" label="source" onPress={actions.showSource} />
        <Button plain key="diff" hotkey="v" label="diff view" onPress={actions.showDiff} />
        <Button
          plain
          key="selection"
          hotkey="s"
          label="selection to prompt"
          onPress={actions.sendSelection}
        />
      </Box>
      <Text bold wrap="truncate-end">
        {file}
        {commit === '' ? '' : `  @ ${commit}`} · rendered
        {model.talk.length === 0
          ? ''
          : ` · ${new Set(model.talk.map(one => one.line)).size} review threads`}
      </Text>
      <Text> </Text>
      {body}
      {isCut && (
        <Text dimColor>The rest is too long to render here; press m for the source.</Text>
      )}
    </Box>
  )
}
