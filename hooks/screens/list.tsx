// The list screen: places to jump to (uses of a name, callers, names that
// match). It is as long as its list, so the pane scrolls it.

import type { Listing } from '../../types'
import { LIST_ROWS } from '../lists'
import type { Kit, Shell } from './frame'
import { helpButton, statusLine } from './frame'

export type ListActions = {
  // Returns to the screen the list was asked for on.
  back: () => void
  // Puts the list, as text, into the prompt.
  sendList: () => void
  // Opens a file of the working tree at a line.
  open: (path: string, line: number) => void
  help: () => void
}

export const listScreen = (kit: Kit, shell: Shell, shown: Listing, actions: ListActions) => {
  const { Box, Button, Text } = kit

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2}>
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        {shown.prompt !== '' && (
          <Button
            plain
            key="list-send"
            hotkey="n"
            label="send list to prompt"
            onPress={actions.sendList}
          />
        )}
        {helpButton(kit, actions.help)}
      </Box>
      <Text bold wrap="truncate-end">
        {shown.title}
      </Text>
      {shown.rows.map((row, at) =>
        row.path === '' ? (
          <Text color="cyan" wrap="truncate-end">
            {row.label}
          </Text>
        ) : row.tail !== undefined ? (
          // A name to jump to. The name itself is what is pressed; a Button
          // takes no colour, so its kind's colour is on the mark before it
          // (ƒ, C, v), with any indent kept ahead of that.
          <Box height={1} overflow="hidden">
            <Text color={(row.color ?? '') === '' ? undefined : row.color}>
              {row.label.slice(0, row.label.length - row.label.trimStart().length)}
              {row.mark ?? ''}{' '}
            </Text>
            <Button
              plain
              key={`row:${at}`}
              label={row.label.trimStart()}
              onPress={() => actions.open(row.path, row.line)}
            />
            <Text dimColor>
              {'  '}
              line {row.line}
              {row.tail === '' ? '' : ` · ${row.tail}`}
            </Text>
          </Box>
        ) : (
          <Box height={1} overflow="hidden">
            <Button
              plain
              key={`row:${at}`}
              label={row.label.slice(0, Math.max(20, shell.columns - 2))}
              onPress={() => actions.open(row.path, row.line)}
            />
          </Box>
        ),
      )}
      {shown.rows.length >= LIST_ROWS && (
        <Text dimColor>Only the first {LIST_ROWS} are listed.</Text>
      )}
    </Box>
  )
}
