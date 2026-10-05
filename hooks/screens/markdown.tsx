// A markdown file as it reads, not as it is written: headings, lists, tables
// and code blocks drawn as a reply's are. The rendered page is as tall as it
// comes out, so the pane scrolls it, not the mod; the diff view and `m` show
// the source, on the file screen.

import { chunkMarkdown } from '../text'
import type { Kit, Shell } from './frame'
import { helpButton, statusLine } from './frame'

const MARKDOWN = /\.(md|mdx|markdown)$/i
// A Markdown element takes so much text at once, and a pane's tree so much in
// all: a file is rendered in pieces, and a very long one only so far.
const MARKDOWN_CHUNK = 9000
const MARKDOWN_CHUNKS = 9

export const isMarkdownFile = (path: string): boolean => MARKDOWN.test(path)

export type MarkdownModel = {
  shell: Shell
  file: string
  // The commit the file is shown at; '' for the working tree's.
  commit: string
  text: string
}

export type MarkdownActions = {
  // Returns to where the file was opened from.
  back: () => void
  help: () => void
  showSource: () => void
  showDiff: () => void
  // Puts what was dragged over into the prompt.
  sendSelection: () => void
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

  const pages = chunkMarkdown(model.text, MARKDOWN_CHUNK)
  const fits = pages.slice(0, MARKDOWN_CHUNKS)

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
      </Text>
      <Text> </Text>
      {fits.map(page => (
        <Markdown text={page} />
      ))}
      {pages.length > fits.length && (
        <Text dimColor>The rest is too long to render here; press m for the source.</Text>
      )}
    </Box>
  )
}
