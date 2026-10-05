// The recents screen: what /lens shows when it is run outside any repo and
// was given no folder. The repos reviewed lately, each a press away, with
// the comparison it was left in.

import type { Recent } from '../../types'
import { agoOf, comparisonLabel } from '../recents'
import type { Kit } from './frame'

export type RecentsActions = {
  // Picks a review up where it was left.
  open: (one: Recent) => void
  // Takes a repo off the list.
  forget: (one: Recent) => void
}

export const recentsScreen = (
  { Box, Button, Text }: Kit,
  model: { recents: readonly Recent[]; now: number },
  actions: RecentsActions,
) => {
  // A path under the person's home folder reads from `~`.
  const short = (repo: string): string => repo.replace(/^\/(Users|home)\/[^/]+\//, '~/')

  if (model.recents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Nothing to review here</Text>
        <Text dimColor>
          This folder is not inside a git repository, and no repo has been reviewed yet.
        </Text>
        <Text dimColor>Name one: /lens ~/Code/my-repo [base branch or commit]</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Recently reviewed</Text>
      <Text dimColor wrap="truncate-end">
        This folder is not in a git repository. Pick a repo (its number), or name one: /lens
        ~/Code/my-repo
      </Text>
      <Text> </Text>
      {model.recents.map((one, at) => (
        <Box key={`recent:${one.repo}`} columnGap={1} height={1} overflow="hidden">
          <Text dimColor>{at < 9 ? String(at + 1) : ' '}</Text>
          <Button
            plain
            key={`open:${one.repo}`}
            {...(at < 9 ? { hotkey: String(at + 1) } : {})}
            label={one.repo.split('/').pop() ?? one.repo}
            onPress={() => actions.open(one)}
          />
          <Text color="#ffab40" wrap="truncate-end">
            {comparisonLabel(one)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {short(one.repo)} · {agoOf(one.at, model.now)}
          </Text>
          <Box display="none" hover={{ display: 'flex' }}>
            <Button plain key={`forget:${one.repo}`} label="✕ forget" onPress={() => actions.forget(one)} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
