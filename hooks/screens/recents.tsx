// The recents screen: what /lens shows when it is run outside any repo and
// was given no folder. The repos reviewed lately, each a press away, with
// the comparison it was left in; the worktrees of one repo sit together
// under it.

import type { Recent } from '../../types'
import { agoOf, comparisonLabel, groupRecents } from '../recents'
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
  const nameOf = (path: string): string => path.split('/').pop() ?? path

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

  // The first nine reviews, in the order drawn, answer to their number.
  let drawn = 0
  const row = (one: Recent, label: string, indent: number) => {
    const at = drawn

    drawn += 1

    return (
      <Box key={`recent:${one.repo}`} columnGap={1} height={1} overflow="hidden">
        <Text dimColor>
          {' '.repeat(indent)}
          {at < 9 ? String(at + 1) : ' '}
        </Text>
        <Button
          plain
          key={`open:${one.repo}`}
          {...(at < 9 ? { hotkey: String(at + 1) } : {})}
          label={label}
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
      {groupRecents(model.recents).flatMap(({ home, reviews }) =>
        // A repo reviewed in one place is one row; one with worktrees is a
        // heading and a row for each, the main checkout named as such.
        reviews.length === 1 && reviews[0]?.repo === home
          ? reviews.map(one => row(one, nameOf(one.repo), 0))
          : [
              <Text bold wrap="truncate-end">
                {nameOf(home)} <Text dimColor>{short(home)}</Text>
              </Text>,
              ...reviews.map(one =>
                row(one, one.repo === home ? 'main checkout' : `worktree ${nameOf(one.repo)}`, 2),
              ),
            ],
      )}
    </Box>
  )
}
