// The requests screen: the repo's open pull or merge requests, the person's
// own first and then everyone else's, each opening as a review of it. It is
// as long as its list, so the pane scrolls it.

import { ageOf } from '../git'
import type { Listed } from '../review'
import type { Kit, Shell } from './frame'
import { GITHUB_ICON, GITLAB_COLOR, GITLAB_ICON, helpButton, statusLine } from './frame'

export type RequestsModel = {
  shell: Shell
  // The open requests, or undefined while the forge is being asked.
  list: readonly Listed[] | undefined
  // The request under review now, as it is typed ("#12"); '' for none.
  current: string
  // How many of each request's files are ticked as reviewed, by what it is
  // typed as.
  reviewed: Readonly<Record<string, number>>
  // The time now, in milliseconds, for how long ago each last changed.
  now: number
}

export type RequestsActions = {
  back: () => void
  refresh: () => void
  // Starts a review of a request: its head against where it forked.
  open: (typed: string) => void
  // The same, opened on the page of every change of it.
  openChanges: (typed: string) => void
  help: () => void
}

export const requestsScreen = (kit: Kit, model: RequestsModel, actions: RequestsActions) => {
  const { Box, Button, Text } = kit
  const { shell, list } = model
  const mine = (list ?? []).filter(one => one.isMine)
  const others = (list ?? []).filter(one => !one.isMine)
  const isGitlab = (list ?? []).some(one => one.typed.startsWith('!'))

  // One request on one row: its number is what is pressed; the title is cut
  // to the room left once who, which branch and how long ago are said.
  const row = (one: Listed) => {
    const seconds = one.when === '' ? NaN : (model.now - Date.parse(one.when)) / 1000
    const ticked = model.reviewed[one.typed] ?? 0
    const trail = [
      one.author === '' ? '' : `@${one.author}`,
      Number.isFinite(seconds) ? ageOf(Math.max(0, seconds)) : '',
      ticked === 0 ? '' : `${ticked} reviewed`,
    ]
      .filter(part => part !== '')
      .join(' · ')
    const marks = `${one.isDraft ? ' draft' : ''}${one.typed === model.current ? ' ◀ open' : ''}`
    const room = shell.columns - one.typed.length - trail.length - marks.length - 5
    const title = one.title.length > room ? `${one.title.slice(0, Math.max(1, room - 1))}…` : one.title

    return (
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={isGitlab ? GITLAB_COLOR : undefined}>{isGitlab ? GITLAB_ICON : GITHUB_ICON} </Text>
          <Button plain key={`request:${one.typed}`} label={one.typed} onPress={() => actions.open(one.typed)} />
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text> </Text>
          {room >= 4 && (
            <Button
              plain
              key={`request-changes:${one.typed}`}
              label={title}
              onPress={() => actions.openChanges(one.typed)}
            />
          )}
          {one.isDraft && <Text color="yellow"> draft</Text>}
          {one.typed === model.current && <Text color="green"> ◀ open</Text>}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{trail}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {helpButton(kit, actions.help)}
      </Box>
      <Text bold>
        Open {isGitlab ? 'merge' : 'pull'} requests{list === undefined ? '' : ` (${list.length})`}
      </Text>
      <Text dimColor wrap="truncate-end">
        Press a number for its files, or a title for every change on one page: nothing is checked out.
      </Text>
      {list === undefined && <Text dimColor>Asking the forge…</Text>}
      {list !== undefined && list.length === 0 && (
        <Text dimColor>
          None are open, or the forge could not be asked (gh or glab installed and signed in?).
        </Text>
      )}
      {mine.length > 0 && <Text> </Text>}
      {mine.length > 0 && <Text bold>Yours ({mine.length})</Text>}
      {mine.map(row)}
      {others.length > 0 && <Text> </Text>}
      {others.length > 0 && (
        <Text bold>
          {mine.length > 0 ? 'Others' : 'Open'} ({others.length})
        </Text>
      )}
      {others.map(row)}
    </Box>
  )
}
