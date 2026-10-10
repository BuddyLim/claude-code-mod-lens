// The requests screen: the repo's open pull or merge requests, the person's
// own first and then everyone else's, each opening as a review of it. It is
// as long as its list, so the pane scrolls it.

import { ageOf } from '../git'
import type { Listed } from '../review'
import type { Kit, Shell } from './frame'
import { GITHUB_ICON, GITLAB_COLOR, GITLAB_ICON, checksMark, checksWord, helpButton, skeleton, stateOf, statusLine } from './frame'

export type RequestsModel = {
  shell: Shell
  // The open requests, or undefined while the forge is being asked.
  list: readonly Listed[] | undefined
  // The request under review now, as it is typed ("#12"); '' for none.
  current: string
  // Which requests are listed: the open ones, or those merged or closed.
  isPast: boolean
  // How many of each request's files are ticked as reviewed, by what it is
  // typed as.
  reviewed: Readonly<Record<string, number>>
  // The time now, in milliseconds, for how long ago each last changed.
  now: number
}

export type RequestsActions = {
  back: () => void
  refresh: () => void
  // Starts a review of a request (its head against where it forked) and
  // shows what it is first: its overview, from which its code is a key away.
  open: (typed: string) => void
  // Between the open requests and those merged or closed.
  togglePast: () => void
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
    // A request takes rows of its own whatever the pane's width: its number
    // with who and when; its title, cut to the pane; and the first words of
    // its description. Nothing shares a row with the title, so a narrow
    // pane cuts it short and no more.
    const room = Math.max(8, shell.columns - 4)
    const cut = (text: string): string => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box height={1} overflow="hidden">
          <Box flexShrink={0}>
            <Text color={isGitlab ? GITLAB_COLOR : undefined}>{isGitlab ? GITLAB_ICON : GITHUB_ICON} </Text>
            <Button plain key={`request:${one.typed}`} label={one.typed} onPress={() => actions.open(one.typed)} />
            {/* Whether its checks pass, and whether it is approved or has
                changes asked for: a mark each, in the colour of how it stands. */}
            {one.checks !== '' && (
              <Text color={checksMark(one.checks)[1]}>
                {' '}
                {checksMark(one.checks)[0]} {checksWord(one.checks)}
              </Text>
            )}
            {/^(APPROVED|CHANGES_REQUESTED)$/.test(one.decision) && (
              <Text color={stateOf(one.decision)[1]}>
                {' '}
                {stateOf(one.decision)[0]} {one.decision === 'APPROVED' ? 'approved' : 'changes asked'}
              </Text>
            )}
            {one.decision === 'REVIEW_REQUIRED' && <Text color="yellow"> ● review required</Text>}
            {/* How one that is over ended: merged in the forges' own purple,
                closed without it in red. */}
            {one.state === 'merged' && <Text color="#a371f7"> ⇄ merged</Text>}
            {one.state === 'closed' && <Text color="red"> ✖ closed</Text>}
            {one.isDraft && one.state === 'open' && <Text color="yellow"> draft</Text>}
            {one.typed === model.current && <Text color="green"> ◀ open</Text>}
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {trail}
          </Text>
        </Box>
        <Box height={1} overflow="hidden" marginLeft={2}>
          <Button
            plain
            key={`request-changes:${one.typed}`}
            label={cut(one.title === '' ? '(no title)' : one.title)}
            onPress={() => actions.open(one.typed)}
          />
        </Box>
        {one.summary !== '' && (
          <Box height={1} overflow="hidden" marginLeft={2}>
            <Text dimColor italic wrap="truncate-end">
              {cut(one.summary)}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        <Button
          plain
          key="past"
          hotkey="p"
          label={model.isPast ? 'open requests' : 'merged and closed'}
          onPress={actions.togglePast}
        />
        {helpButton(kit, actions.help)}
      </Box>
      <Text bold>
        {model.isPast ? 'Merged and closed' : 'Open'} {isGitlab ? 'merge' : 'pull'} requests
        {list === undefined ? '' : ` (${list.length})`}
      </Text>
      <Text dimColor wrap="truncate-end">
        Press a request to see what it is, then its code: nothing is checked out.
      </Text>
      {/* While the forge is asked, a few requests' worth of bars: a number
          row, a title and a line of description each. */}
      {list === undefined &&
        skeleton(kit, [0, 0.35, 0.7, 0.55, 0, 0.3, 0.6, 0.45, 0, 0.4, 0.75, 0.5], shell.columns - 2, 'Asking the forge…')}
      {list !== undefined && list.length === 0 && (
        <Text dimColor>
          {model.isPast ? 'None are merged or closed' : 'None are open'}, or the forge could not be asked (gh or glab
          installed and signed in?).
        </Text>
      )}
      {mine.length > 0 && <Text> </Text>}
      {mine.length > 0 && <Text bold>Yours ({mine.length})</Text>}
      {mine.map(row)}
      {others.length > 0 && <Text> </Text>}
      {others.length > 0 && (
        <Text bold>
          {mine.length > 0 ? 'Others' : model.isPast ? 'Merged and closed' : 'Open'} ({others.length})
        </Text>
      )}
      {others.map(row)}
    </Box>
  )
}
