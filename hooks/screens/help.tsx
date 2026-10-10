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
        ['e', 'the request under review at a glance: description, checks, reviews, commits'],
        ['p', 'list the open pull or merge requests, yours first, to review one'],
        ['filter files', 'in the box of more keys: list only files whose path holds what you type'],
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
        ['a removed line', 'while commenting, in the diff: press its number (the other side\'s) to comment on it'],
        ['\\n', 'typed in a comment: starts a new line'],
        ['suggest as change', 'offers what you typed as a replacement for the lines the comment is on'],
        ['✎ edit / ✕ delete', 'on a thread you started: change what it says, or remove it (asked first)'],
        ['+1', 'on a thread: add a thumbs-up to its first comment'],
        ['add to review', 'keeps a comment waiting (✎) until you submit the review from the file tree; post now sends it at once'],
        ['several lines', 'while commenting: press the first line number, then one further down; the stretch is marked ┃'],
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
        ['press a request', 'its number or its title: see what it is (title, description, checks), then f for its files or d for every change'],
        ['Yours / Others', 'the requests you opened come first'],
        ['n reviewed', 'how many of its files you have ticked'],
        ['r', 'ask the forge again'],
        ['b', 'back to the file tree'],
      ],
    ],
  ],
  overview: [
    [
      'Overview',
      [
        ['Where it stands', 'whether it can be merged, what its reviews come to, and its checks'],
        ['Description', 'what the request says it does, rendered'],
        ['Pictures, videos and files', 'what the description links to: each opens in the browser'],
        ['f / d', 'on to its code: the files it changes, or every change on one page'],
        ['s', 'compare the request with the commit you last reviewed it at'],
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
        ['n / p', 'the next file, or the one before'],
        ['j / k', 'the next change, or the one before'],
        ['c / x', 'the next comment, or the one before'],
        ['e', 'more unchanged lines round each change: 3, 10, 30, and back'],
        ['w', 'leave out lines that differ only in their spaces, or show them again'],
        ['v', 'the two sides beside each other, where the pane is wide enough, or one column again'],
        ['f', 'look for text in the changes; Enter goes to the next line that holds it'],
        ['⇕ more', 'on a change: show more of that one file round its changes'],
        ['stage / unstage', 'on a change of your working tree: put it in the index, or take it back out'],
        ['discard', 'on a change of your working tree: undo it in the file (asked first)'],
        ['commit what is staged', 'appears once something is staged: commits the index with a message'],
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
