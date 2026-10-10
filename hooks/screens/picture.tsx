// The code view of a picture: the picture itself, drawn where the terminal
// can draw one, and beside or above it what it was before where it changed.

import { cellsOf } from '../pictures'
import type { Picture } from '../pictures'
import type { Kit, Shell } from './frame'
import { helpButton, notesOf, statusLine } from './frame'

export type PictureModel = {
  shell: Shell
  file: string
  // The commit the picture is shown at; '' for the file as it stands.
  commit: string
  // Whether the pictures have been asked for and have come.
  isLoaded: boolean
  // The picture as shown, and as the other side had it; undefined for one
  // that is not there or could not be made a picture to draw.
  now: Picture | undefined
  before: Picture | undefined
  // What the other side is, in a word or two ("main", "the commit before").
  against: string
}

export type PictureActions = {
  back: () => void
  help: () => void
  refresh: () => void
}

export const pictureScreen = (kit: Kit, model: PictureModel, actions: PictureActions) => {
  const { Box, Button, Text, Image } = kit
  const { shell, file, commit } = model
  // Two pictures share the pane: side by side where it is wide enough for
  // both, one above the other where it is not.
  const both = model.now !== undefined && model.before !== undefined
  const isBeside = both && shell.columns >= 80
  const columns = Math.max(4, isBeside ? Math.floor((shell.columns - 4) / 2) : shell.columns - 2)
  const rows = Math.max(3, Math.floor((shell.rows - 8) / (both && !isBeside ? 2 : 1)) - 2)

  const one = (label: string, picture: Picture, color: string) => {
    const cells = cellsOf(picture, columns, rows)

    return (
      <Box flexDirection="column" marginRight={2} marginBottom={1}>
        <Text color={color} wrap="truncate-end">
          {label} · {picture.width}×{picture.height}
        </Text>
        {Image !== undefined && (
          <Image source={{ file: picture.file, format: 'png' }} columns={cells.columns} rows={cells.rows} alt={file} />
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Text bold wrap="truncate-end">
        {file}
        {commit === '' ? '' : `  @ ${commit}`}
      </Text>
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {helpButton(kit, actions.help)}
      </Box>
      {notesOf(kit, shell.notes)}
      <Text> </Text>
      {!model.isLoaded && <Text dimColor>Reading the picture…</Text>}
      {model.isLoaded && Image === undefined && <Text dimColor>This surface cannot draw a picture.</Text>}
      {model.isLoaded && model.now === undefined && model.before === undefined && (
        <Text dimColor wrap="truncate-end">
          This picture cannot be drawn here: it is too large, a link, or a kind no tool on this machine reads.
        </Text>
      )}
      {model.isLoaded && model.now === undefined && model.before !== undefined && (
        <Text color="red">Deleted: this is what it was.</Text>
      )}
      <Box flexDirection={isBeside ? 'row' : 'column'}>
        {model.before !== undefined && one(`before (${model.against})`, model.before, 'red')}
        {model.now !== undefined && one(model.before === undefined ? 'picture' : 'now', model.now, 'green')}
      </Box>
    </Box>
  )
}
