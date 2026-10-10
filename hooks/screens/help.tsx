// The list of keys: what `h` shows in place of a screen.

import type { View } from '../../types'
import type { Kit, Shell } from './frame'
import { statusLine } from './frame'

// What `h` lists on each screen: the keys that work there, in groups.
const HELP: Record<View['screen'], [heading: string, rows: [key: string, what: string][]][]> = {
  tree: [
    [
      'File tree',
      [
        ['r', 'scan again'],
        ['a', 'check the whole project with the command-line checkers'],
        ['t', 'switch between the folder tree and a flat list'],
        ['w', 'also list every tracked file, to open one the change does not touch'],
        ['g', 'open the git graph'],
        ['c', 'list the threads of the request under review'],
        ['v', 'submit a review of it: approve, request changes or comment'],
        ['x', 'stop comparing (while a comparison is on)'],
        ['o', 'write a comment on the request as a whole'],
        ['press a name', 'in Conversation: read that comment in full, and quote-reply to it'],
        ['p', 'list the open pull or merge requests, yours first, to review one'],
        ['d', 'every change on one page, to scroll through'],
        ['☐ on a request', 'tick a file as reviewed; it stays ticked between sessions'],
        ['press a file', 'open it'],
        ['press a folder', 'open or close it'],
        ['m a d r t n', 'beside a file: modified, added, deleted, renamed, type changed, new (untracked)'],
      ],
    ],
    [
      'Commit, stash, discard',
      [
        ['☐', 'tick a file, or a folder for everything under it'],
        ['s', 'tick or untick everything'],
        ['Enter', 'in a message field: commit the ticked files'],
        ['apply / pop', 'on a stash: bring it back, keeping or removing the stash'],
      ],
    ],
    [
      'Claude',
      [
        ['n', 'put the new issues in your changes into the prompt'],
        ['i', 'tell Claude automatically what its own edits broke'],
      ],
    ],
  ],
  file: [
    [
      'Moving',
      [
        ['wheel', 'scroll the file'],
        ['d / u', 'half a screen down or up'],
        ['g', 'top of the file'],
        ['n / p', 'next or previous issue, opening its card'],
        ['c', 'next change'],
        ['f', 'find text; Enter or j for the next match, k for the previous'],
        ['b', 'back'],
      ],
    ],
    [
      'Views',
      [
        ['v', 'diff view: − removed lines in red, + added lines in green'],
        ['v again', 'changes only: each change and comment, with three lines around it'],
        ['whole file', 'while commenting: write on the file as a whole, on no line'],
        ['selected lines', 'while commenting: drag over several lines, then press it to comment on them together'],
        ['m', 'markdown: rendered or source'],
        ['l', 'blame: who last changed each line; press one to open its commit'],
        ['e', 'expand or collapse every diagnostic and comment thread'],
        ['t', 'drag over a name first: its type and docs, where it is defined and used'],
        ['breadcrumb', 'press a folder, the file or a name: what is beside it, to jump to'],
        ['i', 'inlay hints: inferred types and parameter names inside the code'],
        ['o', 'on a pull request: comment mode, where a line number picks the line'],
        ['hover', 'a line with a diagnostic: its full message'],
      ],
    ],
    [
      'To the prompt',
      [
        ['line number', 'the block that starts on that line'],
        ['↗', 'that line’s diagnostics and its code'],
        ['s', 'the text you dragged over with the mouse'],
      ],
    ],
    [
      'Marks',
      [
        ['▎', 'a line your change touched'],
        ['NEW', 'a diagnostic your change brought; dim ones were already there'],
        ['✖ ⚠ ℹ', 'error, warning, information'],
      ],
    ],
  ],
  graph: [
    [
      'Git graph',
      [
        ['wheel', 'scroll the history; over an opened commit’s body, scroll the body'],
        ['d / u', 'half a screen down or up'],
        ['g', 'top'],
        ['press a title', 'open a commit: its message, its actions, its files'],
        ['press a stash', 'open what it holds'],
        ['press a file', 'see what that commit changed in it'],
        ['c', 'compare any two branches or commits, or open a pull request (#12)'],
        ['r', 'scan again'],
        ['b', 'back to the file tree'],
      ],
    ],
    [
      'On an opened commit',
      [
        ['compare', 'your files against that commit'],
        ['check out', 'switch to its branch, or to the commit itself'],
        ['undo', 'on the commit you are on: take it back, keeping its changes'],
      ],
    ],
    [
      'Marks',
      [
        ['○', 'what is not committed yet'],
        ['●', 'a commit, in its branch’s lane'],
        ['badges', 'the branches and tags on a commit'],
      ],
    ],
  ],
  list: [
    [
      'List',
      [
        ['press a row', 'open that file at that line'],
        ['n', 'put the list into the prompt (for uses of a name)'],
        ['b', 'back to the file'],
      ],
    ],
  ],
  requests: [
    [
      'Pull and merge requests',
      [
        ['press a number', 'review that request: its head against where it forked; nothing is checked out'],
        ['press a title', 'the same, opened on the page of every change'],
        ['Yours / Others', 'the requests you opened come first'],
        ['n reviewed', 'how many of its files you have ticked'],
        ['r', 'ask the forge again'],
        ['b', 'back to the file tree'],
      ],
    ],
  ],
  changes: [
    [
      'All changes',
      [
        ['scroll', 'every changed file on one page, each change with three lines round it'],
        ['☐', 'tick a file as reviewed (a request under review): it folds, and stays ticked'],
        ['press a file', 'open it in the code view'],
        ['press a line', 'open the file at a comment outside the changes shown'],
        ['d / u', 'half a page down or up'],
        ['g', 'back to the top'],
        ['r', 'read the changes again'],
        ['b', 'back to the file tree'],
      ],
    ],
    [
      'Marks',
      [
        ['+ / −', 'a line added, a line removed'],
        ['┃', 'a review comment or a ledger finding, under the line it is on'],
      ],
    ],
  ],
}

export type HelpActions = {
  close: () => void
}

// The keys of the screen the person was on; as long as its list, so the pane
// scrolls it.
export const helpScreen = (kit: Kit, shell: Shell, screen: View['screen'], actions: HelpActions) => {
  const { Box, Button, Text } = kit

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box>
        <Button plain key="help" hotkey="h" label="close" onPress={actions.close} />
      </Box>
      {HELP[screen].flatMap(([heading, rows]) => [
        <Text> </Text>,
        <Text bold>{heading}</Text>,
        ...rows.map(([key, what]) => (
          <Box>
            <Box flexShrink={0} width={12}>
              <Text color="cyan">{key}</Text>
            </Box>
            <Text>{what}</Text>
          </Box>
        )),
      ])}
    </Box>
  )
}
