// The file tree: what differs, grouped by where the difference lives, with
// each file's problems counted beside it; the box that commits, stashes or
// discards the ticked files; and the stashes made earlier. It is as long as
// its lists, so the pane scrolls it.

import type { ChangedFile, Diag, LineStat, Picked } from '../../types'
import { isAwaited, isCheckable } from '../check'
import { countLabel, diagsOf } from '../diags'
import type { Stash } from '../git'
import { isFinding } from '../ledger'
import { hostOf, mediaOf } from '../media'
import type { Comment } from '../review'
import { isDraft, isOnWholeFile } from '../review'
import { clamp, fitStash, wrapText } from '../text'
import type { TreeRow } from '../tree'
import { buildTree, iconOf, visibleTree } from '../tree'
import type { Kit, Shell } from './frame'
import {
  BODY_ROWS,
  COMMENT_COLOR,
  COMMENT_ICON,
  COMMIT_BOX,
  COMMIT_FILES,
  GITHUB_ICON,
  GITLAB_COLOR,
  GITLAB_ICON,
  LEDGER_COLOR,
  LEDGER_ICON,
  LINK_ICON,
  PENDING_COLOR,
  RESOLVED_COLOR,
  STASH_COLOR,
  STASH_ICON,
  STATUS_WORD,
  helpButton,
  notesOf,
  said,
  statusLine,
  talkColor,
  talkIcon,
} from './frame'

const OTHER_FILES = 100
// More rows than this are not drawn in one list.
const LIST_LIMIT = 300
// How many of the conversation's latest comments are listed.
const CONVERSATION_ROWS = 15
// The most lines of one of them shown when it is opened; as markdown, the
// most characters (an element's text is bounded); and the most pictures,
// videos and files listed under it.
const TALK_LINES = 40
const TALK_SHOWN = 8000
const TALK_MEDIA = 12
// How far an arrow moves an opened stash's body.
const BODY_STEP = 8

// What keeps the rows and folders of a request's files apart from the same
// files and folders listed above them.
const REQUEST_SPACE = 'pr:'

export type TreeModel = {
  shell: Shell
  // What differs, with each file's line counts; the files with uncommitted
  // edits among them; and every diagnostic the last scan found.
  files: readonly ChangedFile[]
  stats: Readonly<Record<string, LineStat>>
  dirty: readonly string[]
  diags: readonly Diag[]
  // Whether a scan has finished, so that nothing listed means nothing differs.
  isScanned: boolean
  // Whether a file is still waiting for its batch of the scan under way.
  isQueued: (path: string) => boolean
  layout: 'tree' | 'list'
  // Folders flipped from their default of open or closed; one in the tree of
  // every file is held as `all:` and its path.
  toggled: readonly string[]
  // The files ticked for a commit or a stash, and whether discarding them is
  // being confirmed.
  checked: readonly string[]
  isDiscarding: boolean
  // Whether the box of less-used keys is open.
  isMore: boolean
  // What the lists are narrowed by ('' for nothing): only files whose path
  // holds it are in them.
  filter: string
  // The files of the request under review ticked as reviewed; `canMark` is
  // whether a request is under review, so there is something to tick.
  canMark: boolean
  reviewed: readonly string[]
  // Whether the folder is in no git repository: there is no change to list,
  // and the tree of every file is all there is.
  isPlain: boolean
  // The tree of every tracked file: whether it shows, and the files.
  isBrowsing: boolean
  allFiles: readonly string[]
  isTelling: boolean
  // How many issues "send to prompt" would send.
  issuesToSend: number
  // The comments of the request under review, on files of this folder.
  comments: readonly Comment[]
  stashes: readonly Stash[]
  // The open request of the branch checked out, where it has one and no
  // comparison is on: what to call it, and what it changes.
  request:
    | {
        // Which forge it is on, what it is typed as ("#12", "!34"), its page
        // there ('' when the forge gave none) and what it is called.
        isGitlab: boolean
        typed: string
        url: string
        title: string
        files: readonly ChangedFile[]
        stats: Readonly<Record<string, LineStat>>
      }
    | undefined
  // The review box: whether it is open, and a number that changes with each
  // review sent or dropped, so its field starts empty.
  isReviewing: boolean
  reviewRound: number
  // How many comments are written for the review and not sent yet.
  pending: number
  // The conversation: the comment opened in full ('' for none); what is
  // being typed ('' nothing, 'new' a comment of its own, else the id of the
  // comment an answer quotes); and a number that changes with each comment
  // sent or dropped, so the field starts empty.
  talkOpen: string
  talkReply: string
  talkRound: number
  // The stash opened ('' for none), what it holds once that is read, and the
  // first line of its body in view.
  selected: string
  picked: Picked
  bodyTop: number
}

export type TreeActions = {
  refresh: () => void
  // While a request is under review: lists its threads, opens or closes the
  // box a review is submitted from, and submits one. Only the box's buttons
  // (or Enter in its field, as a comment) send anything to the forge.
  listThreads: () => void
  // Opens a file of the branch's request on what the request changes in it.
  openRequestFile: (path: string) => void
  toggleReviewing: () => void
  // The conversation: opens a comment in full (or closes it, with ''),
  // opens the box to write one (see `TreeModel.talkReply`), and posts it.
  openTalk: (id: string) => void
  writeTalk: (id: string) => void
  typeTalk: (text: string) => void
  postTalk: (entered?: string) => void
  typeReview: (text: string) => void
  submitReview: (verdict: 'approve' | 'request-changes' | 'comment', entered?: string) => void
  // Checks every file of every project, changed or not.
  checkProject: () => void
  switchLayout: () => void
  openGraph: () => void
  stopComparing: () => void
  toggleMore: () => void
  help: () => void
  // Shows or hides the tree of every tracked file.
  toggleAllFiles: () => void
  sendIssues: () => void
  toggleTelling: () => void
  // Lists the project's names that match what was typed.
  searchNames: (query: string) => void
  // Narrows the lists to the files whose path holds the text; '' lifts it.
  setFilter: (text: string) => void
  open: (path: string) => void
  // Opens or closes a folder, by the key it is held under in `toggled`.
  toggleFolder: (key: string) => void
  // Ticks the paths, or unticks them when all are ticked already.
  tick: (paths: readonly string[]) => void
  // Ticks these and nothing else.
  tickOnly: (paths: readonly string[]) => void
  typeMessage: (text: string) => void
  typeDetails: (text: string) => void
  // Commits the files with the message and details typed so far; Enter in a
  // field passes that field's text as `entered`. With no files, says so.
  commit: (paths: readonly string[], entered?: { message?: string; details?: string }) => void
  stash: (paths: readonly string[]) => void
  // Discarding: asked for, confirmed, or called off.
  askDiscard: (paths: readonly string[]) => void
  discard: (paths: readonly string[]) => void
  keepChanges: () => void
  // Opens a stash under its row, or closes the one that is open.
  openStash: (ref: string) => void
  openStashFile: (ref: string, path: string) => void
  // Moves an opened stash's body so `line` is its first.
  scrollBody: (line: number) => void
  applyStash: (ref: string) => void
  popStash: (ref: string) => void
  // Opens the list of open requests, and the page of every change.
  openRequests: () => void
  openChanges: () => void
  // Opens what the request under review is: its description, checks, reviews.
  openOverview: () => void
  // Ticks or unticks a file of the request under review as reviewed.
  toggleReviewed: (path: string) => void
}

export const treeScreen = (kit: Kit, model: TreeModel, actions: TreeActions) => {
  const { Box, Button, Text, Input, Link, Markdown } = kit
  const { shell, files, stats, diags, layout, toggled, comments, stashes, isBrowsing } = model
  const { picked: chosen } = model
  const { totals } = shell
  const statusOf = new Map(files.map(one => [one.path, one.status]))
  const changedPaths = new Set(files.map(one => one.path))
  const others = [...new Set(diags.map(diag => diag.path))]
    .filter(path => !changedPaths.has(path))
    .sort()

  // The working tree against the base in one row: lines added and deleted
  // across the changed files, and the errors and warnings found in them.
  const summary = model.isPlain ? (
    <Box>
      <Text bold>Folder </Text>
      <Text dimColor>not a git repository, so nothing is compared · </Text>
      <Text color="red">{totals.errors}✖ </Text>
      <Text color="yellow">{totals.others}⚠</Text>
    </Box>
  ) : (
    <Box>
      <Text bold>{shell.isComparing ? `Against ${shell.against} ` : 'Uncommitted '}</Text>
      <Text color="green">+{totals.added} </Text>
      <Text color="red">−{totals.deleted} </Text>
      <Text dimColor>in {totals.files} files · </Text>
      <Text color="red">{totals.errors}✖ </Text>
      <Text color="yellow">{totals.others}⚠</Text>
      {totals.fresh !== undefined && <Text bold> {totals.fresh} new</Text>}
    </Box>
  )

  // The files ticked for a commit or a stash. A tick box ticks or unticks
  // all its paths together: one file's, or every file under a folder.
  const checked = new Set(model.checked)
  const seen = new Set(model.reviewed)
  const tick =(key: string, paths: readonly string[]) => (
    <Button
      plain
      key={key}
      label={
        paths.every(path => checked.has(path))
          ? '☑'
          : paths.some(path => checked.has(path))
            ? '◪'
            : '☐'
      }
      onPress={() => actions.tick(paths)}
    />
  )

  // `scope` tells apart the rows of a file that is listed twice: among the
  // changed files, and again in the tree of every file (`all:`).
  const fileRow = (
    path: string,
    mark: string,
    name = path,
    depth = 0,
    isPickable = false,
    scope = '',
  ) => {
    const counts = countLabel(diagsOf(diags, path))
    // A request's file is counted by what the request changes in it.
    const counted = scope === REQUEST_SPACE ? (model.request?.stats ?? {}) : stats
    // What is written and not sent is counted apart, in its own colour.
    const waiting = comments.filter(one => one.path === path && isDraft(one)).length
    const threads = comments.filter(
      one => one.path === path && one.replyTo === undefined && !isDraft(one),
    )
    const settled = threads.filter(one => one.isResolved === true).length
    const open = threads.length - settled
    const found = threads.filter(one => one.isResolved !== true && isFinding(one)).length
    const isChecked = isCheckable(path)
    const icon = iconOf(path)
    // What happened to the file, in a word and git's usual colour for it.
    const change = STATUS_WORD[mark]
    // A file of the request under review has a box of its own kind: ticked
    // once it has been read. One being committed keeps the commit's box.
    const isMarkable =
      model.canMark && !isPickable && scope !== 'all:' && (scope === REQUEST_SPACE || changedPaths.has(path))
    const lead = [
      <Text>{'  '.repeat(depth)}</Text>,
      isPickable && tick(`check:${path}`, [path]),
      isPickable && <Text> </Text>,
      isMarkable && (
        <Button
          plain
          key={`seen:${scope}${path}`}
          label={seen.has(path) ? '☑' : '☐'}
          onPress={() => actions.toggleReviewed(path)}
        />
      ),
      isMarkable && <Text> </Text>,
    ]

    if (mark === 'D') {
      return (
        <Box>
          {lead}
          <Text dimColor>
            {icon.glyph} {name}
          </Text>
          <Text color="#f14c4c">  d</Text>
        </Box>
      )
    }

    return (
      <Box>
        {lead}
        <Text color={icon.color}>{icon.glyph} </Text>
        <Button
          plain
          key={`file:${scope}${path}`}
          // A file still being checked shows the busy mark beside what
          // has been found in it so far; its tick waits for the last tool.
          label={`${name}  ${[counts, !shell.isScanning ? '' : model.isQueued(path) ? '⋯ queued' : isAwaited(path, shell.pending) ? shell.busyMark : ''].filter(part => part !== '').join(' ') || (isChecked ? '✓' : '·')}`}
          onPress={() => (scope === REQUEST_SPACE ? actions.openRequestFile(path) : actions.open(path))}
        />
        {change !== undefined && <Text color={change[1]}>  {change[0]}</Text>}
        {/* The file's review threads (a thread is its first comment): those
            still open in the comments' colour, those resolved in gold. */}
        {open - found > 0 && (
          <Text color={COMMENT_COLOR}>
            {'  '}
            {COMMENT_ICON} {open - found}
          </Text>
        )}
        {waiting > 0 && <Text color={PENDING_COLOR}>  ✎ {waiting}</Text>}
        {/* The ledger's open findings are counted apart, in their colour. */}
        {found > 0 && (
          <Text color={LEDGER_COLOR}>
            {'  '}
            {LEDGER_ICON} {found}
          </Text>
        )}
        {settled > 0 && <Text color={RESOLVED_COLOR}>  ✓ {settled}</Text>}
        {counted[path] !== undefined && (
          <Text color="green">  +{counted[path]?.[0] ?? 0}</Text>
        )}
        {counted[path] !== undefined && <Text color="red"> −{counted[path]?.[1] ?? 0}</Text>}
      </Box>
    )
  }

  // `group` keeps a folder's key apart when it shows in two groups; `under`
  // is the files a tick on the folder takes, none where files are not ticked.
  // `space` keeps apart the open-or-closed state of the same folder in
  // the tree of every file, where folders start closed.
  const folderRow = (
    row: TreeRow,
    isClosed: boolean,
    group: number,
    under: readonly string[],
    space = '',
  ) => {
    const held = `${space}${row.path}`
    const counts = countLabel(diags.filter(diag => diag.path.startsWith(`${row.path}/`)))

    return (
      <Box>
        <Text dimColor>{'  '.repeat(row.depth)}</Text>
        {under.length > 0 && tick(`checkdir:${group}:${row.path}`, under)}
        {under.length > 0 && <Text> </Text>}
        <Text color="#dcb67a">{isClosed ? '\u{f07b}' : '\u{f07c}'} </Text>
        <Button
          plain
          dimColor
          key={`dir:${group}:${row.path}`}
          label={`${row.name}/${isClosed ? `  ${row.size} files` : ''}${counts === '' ? '' : `  ${counts}`}`}
          onPress={() => actions.toggleFolder(held)}
        />
      </Box>
    )
  }

  // The files are grouped by where their difference lives. Against a base
  // that is another commit there are three kinds: what the commits since
  // changed, what is edited but not committed, and what git does not
  // track at all. With no comparison only the last two exist. Only what
  // is not committed yet can be ticked for a commit or a stash.
  const dirty = new Set(model.dirty)
  const tracked = files.filter(one => one.status !== '?')
  const groups = (
    shell.isComparing
      ? [
          {
            title: shell.request === '' ? `Commits: ${shell.side} vs ${shell.against}` : shell.request,
            files: tracked.filter(one => !dirty.has(one.path)),
            isPickable: false,
          },
          {
            title: 'Uncommitted: edited since your last commit',
            files: tracked.filter(one => dirty.has(one.path)),
            isPickable: true,
          },
        ]
      : [
          {
            title: 'Uncommitted: edited since your last commit',
            files: tracked,
            isPickable: true,
          },
        ]
  )
    .concat({
      title: 'Untracked',
      files: files.filter(one => one.status === '?'),
      isPickable: true,
    })
    .filter(group => group.files.length > 0)

  const rowsFor = (group: (typeof groups)[number], at: number) =>
    layout === 'tree'
      ? visibleTree(buildTree(group.files.map(one => one.path)), toggled).map(
          ({ row, isClosed }) =>
            row.kind === 'dir'
              ? folderRow(
                  row,
                  isClosed,
                  at,
                  group.isPickable
                    ? group.files
                        .map(one => one.path)
                        .filter(path => path.startsWith(`${row.path}/`))
                    : [],
                )
              : fileRow(
                  row.path,
                  statusOf.get(row.path) ?? ' ',
                  row.name,
                  row.depth,
                  group.isPickable,
                ),
        )
      : group.files.map(one => fileRow(one.path, one.status, one.path, 0, group.isPickable))

  // The request's own files, in the layout the rest are in. Its folders keep
  // their open-or-closed state apart from the same folders above.
  const asked = model.request
  const requested = asked?.files ?? []
  // Whether there is a request to say something on, and the comment an
  // answer being typed quotes.
  const canTalk = shell.reviewing !== ''
  const quoted = comments.find(one => one.id === model.talkReply && one.path === '')
  // Whether the conversation is drawn as part of the request's section.
  const isInSection = asked !== undefined && requested.length > 0
  const requestStatus = new Map(requested.map(one => [one.path, one.status]))
  const requestRows =
    layout === 'tree'
      ? visibleTree(
          buildTree(requested.map(one => one.path)),
          toggled
            .filter(path => path.startsWith(REQUEST_SPACE))
            .map(path => path.slice(REQUEST_SPACE.length)),
        ).map(({ row, isClosed }) =>
          row.kind === 'dir'
            ? folderRow(row, isClosed, 98, [], REQUEST_SPACE)
            : fileRow(row.path, requestStatus.get(row.path) ?? ' ', row.name, row.depth, false, REQUEST_SPACE),
        )
      : requested.map(one => fileRow(one.path, one.status, one.path, 0, false, REQUEST_SPACE))

  // What a commit or a stash would take: the ticked files still listed.
  const pickable = groups
    .filter(group => group.isPickable)
    .flatMap(group => group.files.map(one => one.path))
  const ticked = pickable.filter(path => checked.has(path))
  const isAllTicked = pickable.length > 0 && ticked.length === pickable.length
  // The commit box is there whenever something could be committed, ticked
  // or not, and is always the same height: ticking a file changes what it
  // says, never where the lists under it sit. The discard question takes
  // the buttons' own row for the same reason.
  const isDiscarding = model.isDiscarding && ticked.length > 0
  const gitBar = pickable.length > 0 && (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COMMIT_BOX}
      borderDimColor={ticked.length === 0}
      paddingX={1}
      marginY={1}
    >
      <Box columnGap={2} height={1} overflow="hidden">
        <Button
          plain
          key="tick-all"
          hotkey="s"
          label={isAllTicked ? 'select none' : 'select all'}
          onPress={() => actions.tickOnly(isAllTicked ? [] : pickable)}
        />
        {ticked.length === 0 ? (
          <Text dimColor>Tick files (☐) below to commit, stash or discard them.</Text>
        ) : (
          <Text bold color={COMMIT_BOX}>
            {ticked.length} {ticked.length === 1 ? 'file' : 'files'} selected
          </Text>
        )}
      </Box>
      {/* Each field has a row to itself, so a long message has the box's
          whole width. A field is one line, so a longer message goes in the
          second, which becomes the commit's body. */}
      {Input !== undefined && (
        <Input
          key="message"
          label="message"
          placeholder="what changed"
          submitLabel="commit"
          onInput={actions.typeMessage}
          onSubmit={value => actions.commit(ticked, { message: value })}
        />
      )}
      {Input !== undefined && (
        <Input
          key="body"
          label="details"
          placeholder="optional: why, and anything worth knowing"
          submitLabel="commit"
          onInput={actions.typeDetails}
          onSubmit={value => actions.commit(ticked, { details: value })}
        />
      )}
      {isDiscarding ? (
        // Discarding cannot be undone, so it takes a second press that
        // says what will be lost.
        <Box columnGap={2} marginTop={1} height={1} overflow="hidden">
          <Text color="red" bold>
            Throw away the changes in {ticked.length}{' '}
            {ticked.length === 1 ? 'file' : 'files'}? It cannot be undone.
          </Text>
          <Button key="discard-yes" label="yes, discard" onPress={() => actions.discard(ticked)} />
          <Button
            key="discard-no"
            variant="primary"
            label="keep them"
            onPress={actions.keepChanges}
          />
        </Box>
      ) : (
        <Box columnGap={2} marginTop={1} height={1} overflow="hidden">
          <Button
            key="commit"
            variant={ticked.length === 0 ? 'secondary' : 'primary'}
            dimColor={ticked.length === 0}
            label={`\u{f417} commit ${ticked.length}`}
            onPress={() => actions.commit(ticked)}
          />
          <Button
            key="stash"
            dimColor={ticked.length === 0}
            label={`\u{f187} stash ${ticked.length}`}
            onPress={() => actions.stash(ticked)}
          />
          <Button
            key="discard"
            dimColor={ticked.length === 0}
            label={`\u{f1f8} discard ${ticked.length}`}
            onPress={() => actions.askDiscard(ticked)}
          />
        </Box>
      )}
    </Box>
  )

  // Every file git tracks, for reading one the change does not touch.
  // Folders start closed here, and keep their own open-or-closed state.
  const everything = model.allFiles
  const everyRow = visibleTree(
    buildTree(everything),
    toggled.filter(path => path.startsWith('all:')).map(path => path.slice(4)),
    true,
  ).map(({ row, isClosed }) =>
    row.kind === 'dir'
      ? folderRow(row, isClosed, 99, [], 'all:')
      : fileRow(row.path, statusOf.get(row.path) ?? ' ', row.name, row.depth, false, 'all:'),
  )

  // The picked stash's message is wrapped here, to the width its box has,
  // so the box can show a fixed number of its lines.
  const messageWidth = clamp(shell.columns - 16, 24, 100)
  const bodyLines = wrapText(chosen.body, messageWidth - 4)
  const bodyTop = clamp(model.bodyTop, 0, bodyLines.length - BODY_ROWS)
  // The files of the picked stash; pressing one opens it as the stash left
  // it, in the diff view.
  const filesOf = (id: string, indent: number) =>
    model.selected === id &&
    chosen.hash === id && (
      <Box flexDirection="column" marginLeft={indent}>
        {/* The subject in full: the graph's row cuts it short in a narrow pane. */}
        {chosen.subject !== '' && (
          <Box width={messageWidth}>
            <Text bold>{chosen.subject}</Text>
          </Box>
        )}
        {/* The body in a box of a fixed height, so a long one cannot push
            the lists away; the arrows move its window a few lines at a time. */}
        {bodyLines.length > 0 && (
          <Box
            flexDirection="column"
            width={messageWidth}
            borderStyle="round"
            borderDimColor
            paddingX={1}
          >
            {bodyLines.slice(bodyTop, bodyTop + BODY_ROWS).map(line => (
              <Text italic dimColor>
                {line === '' ? ' ' : line}
              </Text>
            ))}
            {bodyLines.length > BODY_ROWS && (
              <Box columnGap={2}>
                <Button
                  plain
                  key={`body-up:${id}`}
                  label="▲"
                  onPress={() => actions.scrollBody(Math.max(0, bodyTop - BODY_STEP))}
                />
                <Button
                  plain
                  key={`body-down:${id}`}
                  label="▼"
                  onPress={() =>
                    actions.scrollBody(Math.min(bodyLines.length - BODY_ROWS, bodyTop + BODY_STEP))
                  }
                />
                <Text dimColor>
                  lines {bodyTop + 1}–{Math.min(bodyLines.length, bodyTop + BODY_ROWS)} of{' '}
                  {bodyLines.length}
                </Text>
              </Box>
            )}
          </Box>
        )}
        {chosen.files.length === 0 && <Text dimColor>No files changed here.</Text>}
        {chosen.files.slice(0, COMMIT_FILES).map(one => {
          const icon = iconOf(one.path)
          const stat = chosen.stats[one.path]
          const change = STATUS_WORD[one.status]

          return (
            <Box>
              <Text color={icon.color}>{icon.glyph} </Text>
              <Button
                plain
                key={`changed:${id}:${one.path}`}
                label={one.path}
                onPress={() => actions.openStashFile(id, one.path)}
              />
              {change !== undefined && <Text color={change[1]}>  {change[0]}</Text>}
              {stat !== undefined && <Text color="green">  +{stat[0]}</Text>}
              {stat !== undefined && <Text color="red"> −{stat[1]}</Text>}
            </Box>
          )
        })}
        {chosen.files.length > COMMIT_FILES && (
          <Text dimColor>… {chosen.files.length - COMMIT_FILES} more files</Text>
        )}
      </Box>
    )
  // A stash's row, and under it what the stash holds when it is opened.
  // The row is fitted to the pane's width here and never left to wrap: a
  // narrow pane would otherwise break the mark's badge across lines.
  const stashRow = (one: Stash) => {
    const fit = fitStash(
      { ref: one.ref, subject: one.subject, base: one.base ?? '', when: one.when ?? '' },
      shell.columns,
    )
    const buttons = (
      <Box flexShrink={0} columnGap={1} marginLeft={fit.isStacked ? 5 : 1}>
        <Button
          plain
          key={`apply:${one.ref}`}
          label="apply"
          onPress={() => actions.applyStash(one.ref)}
        />
        <Button plain key={`pop:${one.ref}`} label="pop" onPress={() => actions.popStash(one.ref)} />
      </Box>
    )

    return [
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text backgroundColor={STASH_COLOR} color="#000000">
            {' '}
            {STASH_ICON}{' '}
          </Text>
          <Text> </Text>
          <Button
            plain
            key={`stash:${one.ref}`}
            label={one.ref}
            onPress={() => actions.openStash(one.ref)}
          />
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {fit.subject !== '' && (
            <Text dimColor wrap="truncate-end">
              {' '}
              {fit.subject}
            </Text>
          )}
        </Box>
        {fit.trail !== '' && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{fit.trail}</Text>
          </Box>
        )}
        {!fit.isStacked && buttons}
      </Box>,
      fit.isStacked && (
        <Box height={1} overflow="hidden">
          {buttons}
        </Box>
      ),
      filesOf(one.ref, 2),
    ]
  }

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      {/* The row wraps in a narrow pane, so no key is pushed off its edge. */}
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        <Button
          plain
          key="layout"
          hotkey="t"
          label={layout === 'tree' ? 'list view' : 'tree view'}
          onPress={actions.switchLayout}
        />
        {!model.isPlain && (
          <Button plain key="graph" hotkey="g" label="git graph" onPress={actions.openGraph} />
        )}
        {!model.isPlain && (
          <Button plain key="changes" hotkey="d" label="all changes" onPress={actions.openChanges} />
        )}
        {!model.isPlain && (
          <Button plain key="requests" hotkey="p" label="requests" onPress={actions.openRequests} />
        )}
        {shell.reviewing !== '' && (
          <Button plain key="overview" hotkey="e" label="overview" onPress={actions.openOverview} />
        )}
        {shell.reviewing !== '' && (
          <Button
            plain
            key="threads"
            hotkey="c"
            label={`threads (${comments.filter(one => one.replyTo === undefined && one.path !== '').length})`}
            onPress={actions.listThreads}
          />
        )}
        {shell.reviewing !== '' && (
          <Button
            plain
            key="review"
            hotkey="v"
            label={
              model.isReviewing
                ? 'close review'
                : `submit review${model.pending === 0 ? '' : ` (${model.pending} waiting)`}`
            }
            onPress={actions.toggleReviewing}
          />
        )}
        {shell.isComparing && (
          <Button
            plain
            key="uncompare"
            hotkey="x"
            label="stop comparing"
            onPress={actions.stopComparing}
          />
        )}
        <Button
          plain
          key="more"
          hotkey="m"
          label={model.isMore ? 'less' : 'more…'}
          onPress={actions.toggleMore}
        />
        {helpButton(kit, actions.help)}
      </Box>
      {/* The less-used keys open in a box of their own (m): a key works
          while its button is drawn, so the box is where these live. */}
      {/* Folded, the box is still drawn, at no height, so its keys answer
          whether or not it is open. */}
      {(
        <Box
          flexDirection="column"
          {...(model.isMore
            ? { borderStyle: 'round' as const, borderDimColor: true, paddingX: 1 }
            : { height: 0, overflow: 'hidden' as const })}
        >
          <Box columnGap={2} flexWrap="wrap">
            <Button
              plain
              key="project"
              hotkey="a"
              label="check whole project"
              onPress={actions.checkProject}
            />
            {!model.isPlain && (
              <Button
                plain
                key="browse"
                hotkey="w"
                label={isBrowsing ? 'changed files only' : 'all files'}
                onPress={actions.toggleAllFiles}
              />
            )}
            <Button
              plain
              key="send-issues"
              hotkey="n"
              label={`send ${model.issuesToSend} ${model.issuesToSend === 1 ? 'issue' : 'issues'} to prompt`}
              onPress={actions.sendIssues}
            />
            <Button
              plain
              key="tell"
              hotkey="i"
              label={`tell Claude about new errors: ${model.isTelling ? 'on' : 'off'}`}
              onPress={actions.toggleTelling}
            />
          </Box>
          {/* A name anywhere in the project, by typing part of it: the
              language server of the first changed file it can read searches. */}
          {/* The lists narrowed to the files whose path holds what is typed. */}
          {model.isMore && Input !== undefined && (
            <Box height={1} overflow="hidden">
              <Input
                key="file-filter"
                label="filter files"
                placeholder="part of a path, then Enter; empty shows them all"
                submitLabel="filter"
                {...(model.filter === '' ? {} : { value: model.filter })}
                onSubmit={actions.setFilter}
              />
            </Box>
          )}
          {model.isMore && Input !== undefined && (
            <Box height={1} overflow="hidden">
              <Input
                key="symbol-search"
                label="go to name"
                placeholder="part of a function, class or type name, then Enter"
                submitLabel="search"
                onSubmit={actions.searchNames}
              />
            </Box>
          )}
        </Box>
      )}
      {notesOf(kit, shell.notes)}
      {/* The review box: a summary, then what the review says of the
          request. Nothing is sent until one of its buttons is pressed. */}
      {model.isReviewing && Input !== undefined && shell.reviewing !== '' && (
        <Box flexDirection="column" borderStyle="round" borderColor={COMMIT_BOX} paddingX={1}>
          {/* The comments written in the code view and left waiting go to
              the forge with whichever button is pressed here. */}
          {model.pending > 0 && (
            <Text color={PENDING_COLOR} wrap="truncate-end">
              ✎ {model.pending} {model.pending === 1 ? 'comment is' : 'comments are'} waiting, and will be
              sent with this review.
            </Text>
          )}
          <Input
            key={`review-text:${model.reviewRound}`}
            label="review"
            placeholder={
              model.pending > 0
                ? 'a summary of your review (optional with comments waiting)'
                : 'a summary of your review (needed to comment or request changes)'
            }
            submitLabel="comment"
            autoFocus
            onInput={actions.typeReview}
            onSubmit={value => actions.submitReview('comment', value)}
          />
          <Box columnGap={2}>
            <Button key="review-approve" variant="primary" label="✓ approve" onPress={() => actions.submitReview('approve')} />
            <Button key="review-changes" label="✎ request changes" onPress={() => actions.submitReview('request-changes')} />
            <Button key="review-comment" label="comment only" onPress={() => actions.submitReview('comment')} />
            <Button key="review-cancel" label="cancel" onPress={actions.toggleReviewing} />
          </Box>
        </Box>
      )}
      {/* A filter in force says so wherever the box it was typed in is, with
          a way to lift it: lists that look short for no reason mislead. */}
      {model.filter !== '' && (
        <Box columnGap={2}>
          <Text color="yellow" wrap="truncate-end">
            Only files with “{model.filter}” in their path are listed.
          </Text>
          <Button plain key="filter-clear" label="show all" onPress={() => actions.setFilter('')} />
        </Box>
      )}
      {summary}
      {gitBar}
      {files.length === 0 && model.isScanned && !model.isPlain && (
        <Text dimColor>
          {shell.isComparing ? `Nothing differs from ${shell.against}.` : 'Nothing is modified.'}
        </Text>
      )}
      {groups.flatMap((group, at) => {
        const rows = rowsFor(group, at)

        return [
          // A clear row sets each group apart from the one above it.
          at > 0 && <Text> </Text>,
          <Text bold>
            {group.title} ({group.files.length})
            {model.canMark && !group.isPickable
              ? ` · ${group.files.filter(one => seen.has(one.path)).length} reviewed`
              : ''}
          </Text>,
          ...rows.slice(0, LIST_LIMIT),
          rows.length > LIST_LIMIT && (
            <Text dimColor>… {rows.length - LIST_LIMIT} more rows not shown</Text>
          ),
        ]
      })}
      {/* The request of the branch checked out: every file it changes, with
          the threads on each, whether or not the file is edited here. */}
      {/* A clear row sets the request apart from the working tree's files. */}
      {asked !== undefined && requestRows.length > 0 && <Text> </Text>}
      {asked !== undefined && requestRows.length > 0 && (
        // The forge's mark, then the request: its number is a link to its
        // page there, where the surface draws links.
        <Text bold wrap="truncate-end">
          <Text color={asked.isGitlab ? GITLAB_COLOR : undefined}>
            {asked.isGitlab ? GITLAB_ICON : GITHUB_ICON}
          </Text>{' '}
          {asked.isGitlab ? 'MR' : 'PR'}{' '}
          {Link !== undefined && asked.url.startsWith('https://') ? (
            // In a link's colour, underlined, with the mark of a page that
            // opens elsewhere: a number alone does not look pressable.
            <Text color={COMMIT_BOX} underline>
              <Link href={asked.url}>
                {asked.typed} {LINK_ICON}
              </Link>
            </Text>
          ) : (
            asked.typed
          )}
          {asked.title === '' ? '' : `: ${asked.title}`} ({asked.files.length})
          {model.canMark ? ` · ${asked.files.filter(one => seen.has(one.path)).length} reviewed` : ''}
        </Text>
      )}
      {requestRows.slice(0, LIST_LIMIT)}
      {/* What was said on the request as a whole, and the comments that
          no longer sit on a line (the code under them has changed). Under
          the request's own heading it is part of that section. */}
      {/* Standing alone, it has a clear row above it and below it. */}
      {comments.some(one => one.line === 0) && !isInSection && <Text> </Text>}
      {comments.some(one => one.line === 0) && (
        <Box columnGap={2}>
          <Text bold={!isInSection} dimColor={isInSection}>
            {isInSection ? '  ' : ''}Conversation ({comments.filter(one => one.line === 0).length})
          </Text>
          {canTalk && (
            <Button
              plain
              key="talk-new"
              hotkey="o"
              label={model.talkReply === 'new' ? 'close' : 'comment'}
              onPress={() => actions.writeTalk(model.talkReply === 'new' ? '' : 'new')}
            />
          )}
          <Text dimColor>press a name to read it all</Text>
        </Box>
      )}
      {/* The box a comment on the request as a whole is typed in: a new one,
          or an answer that starts by quoting the comment it answers. Nothing
          is sent until Enter or its button. */}
      {canTalk && Input !== undefined && model.talkReply !== '' && (
        <Box flexDirection="column" borderStyle="round" borderColor={COMMENT_COLOR} paddingX={1}>
          {quoted !== undefined && (
            <Text dimColor wrap="truncate-end">
              &gt; {quoted.author}: {quoted.body.replace(/\s+/g, ' ')}
            </Text>
          )}
          <Input
            key={`talk-text:${model.talkRound}:${model.talkReply}`}
            label={quoted === undefined ? 'comment' : 'reply'}
            placeholder={
              quoted === undefined
                ? 'a comment on the request as a whole'
                : `your answer to ${quoted.author}; their comment is quoted above it`
            }
            submitLabel="post"
            autoFocus
            onInput={actions.typeTalk}
            onSubmit={value => actions.postTalk(value)}
          />
          <Box columnGap={2}>
            <Button key="talk-post" variant="primary" label="post" onPress={() => actions.postTalk()} />
            <Button key="talk-cancel" label="cancel" onPress={() => actions.writeTalk('')} />
          </Box>
        </Box>
      )}
      {comments
        .filter(one => one.line === 0)
        .slice(-CONVERSATION_ROWS)
        .map(one =>
          one.path === '' ? (
            // A comment on the request as a whole: its mark in the comments'
            // colour, and its author's name opens it in full, with a way to
            // answer it.
            <Box flexDirection="column">
              <Box height={1} overflow="hidden">
                <Box flexShrink={0}>
                  <Text color={COMMENT_COLOR}>
                    {isInSection ? '  ' : ''}
                    {talkIcon(one)}{' '}
                  </Text>
                  <Button
                    plain
                    key={`talk-open:${one.id}`}
                    label={one.author}
                    onPress={() => actions.openTalk(model.talkOpen === one.id ? '' : one.id)}
                  />
                </Box>
                <Text dimColor={model.talkOpen === one.id} wrap="truncate-end">
                  {' '}
                  {model.talkOpen === one.id
                    ? `· ${one.when.slice(0, 10)}`
                    : `: ${one.body.replace(/\s+/g, ' ')}`}
                </Text>
              </Box>
              {/* Opened, the comment reads as it was written: the surface
                  renders its markdown where it can, and what it links to
                  that a terminal cannot show (a picture, a video, a file)
                  is listed under it, each with the site it goes to. */}
              {model.talkOpen === one.id &&
                (Markdown !== undefined ? (
                  <Box marginLeft={isInSection ? 4 : 2} flexDirection="column">
                    <Markdown text={one.body.trim().slice(0, TALK_SHOWN)} />
                  </Box>
                ) : (
                  wrapText(one.body.trim(), Math.max(20, shell.columns - 6))
                    .slice(0, TALK_LINES)
                    .map(line => (
                      <Text wrap="truncate-end">
                        {isInSection ? '  ' : ''}
                        <Text color={COMMENT_COLOR}>┃</Text> {line === '' ? ' ' : line}
                      </Text>
                    ))
                ))}
              {model.talkOpen === one.id &&
                mediaOf(one.body)
                  .slice(0, TALK_MEDIA)
                  .map(media => (
                    <Box height={1} overflow="hidden" marginLeft={isInSection ? 4 : 2}>
                      <Text dimColor>{media.kind === 'image' ? 'picture ' : `${media.kind} `}</Text>
                      {/* `mediaOf` keeps http and https links alone; the test
                          is made here too, as the overview makes it, so the
                          link does not rest on that one place. */}
                      {Link !== undefined && /^https?:\/\//i.test(media.url) ? (
                        <Text color={COMMIT_BOX} underline>
                          <Link href={media.url}>
                            {media.label} {LINK_ICON}
                          </Link>
                        </Text>
                      ) : (
                        <Text>{media.label}</Text>
                      )}
                      <Text dimColor> → {hostOf(media.url)}</Text>
                    </Box>
                  ))}
              {model.talkOpen === one.id && canTalk && (
                <Box columnGap={2} marginLeft={isInSection ? 4 : 2}>
                  <Button
                    plain
                    key={`talk-quote:${one.id}`}
                    label="quote reply"
                    onPress={() => actions.writeTalk(one.id)}
                  />
                  <Button plain key={`talk-close:${one.id}`} label="close" onPress={() => actions.openTalk('')} />
                </Box>
              )}
            </Box>
          ) : (
            // A comment on a file names it, and the name opens the file.
            <Box height={1} overflow="hidden">
              <Box flexShrink={0}>
                <Text color={talkColor(one)}>
                  {isInSection ? '  ' : ''}
                  {talkIcon(one)}{' '}
                </Text>
                <Button
                  plain
                  key={`talk-file:${one.id}`}
                  label={one.path}
                  onPress={() => actions.open(one.path)}
                />
              </Box>
              {/* A ledger finding with no line is on its file as a whole; a
                  request's comment with none has lost its line to an edit. */}
              <Text color={talkColor(one)} wrap="truncate-end">
                {' '}
                ({isOnWholeFile(one) ? 'whole file' : one.oldLine !== undefined ? 'removed line' : 'outdated'}) · {said(one)}
              </Text>
            </Box>
          ),
        )}
      {comments.some(one => one.line === 0) && <Text> </Text>}
      {others.length > 0 && (
        <Text bold>
          {model.isPlain ? 'Files' : 'Other files'} with issues ({others.length})
        </Text>
      )}
      {others.slice(0, OTHER_FILES).map(path => fileRow(path, ' '))}
      {isBrowsing && <Text bold>All files ({everything.length})</Text>}
      {isBrowsing && everything.length === 0 && (
        <Text dimColor>
          {model.isPlain && model.isScanned ? 'This folder holds no files.' : 'Reading the file list…'}
        </Text>
      )}
      {everyRow.slice(0, LIST_LIMIT)}
      {everyRow.length > LIST_LIMIT && (
        <Text dimColor>… {everyRow.length - LIST_LIMIT} more rows; open a folder to narrow</Text>
      )}
      {/* What was stashed earlier: apply keeps the stash, pop removes it
          once its changes are back. */}
      {/* A clear row sets the stashes apart from the files above them. */}
      {stashes.length > 0 && <Text> </Text>}
      {stashes.length > 0 && <Text bold>Stashes ({stashes.length})</Text>}
      {stashes.flatMap(one => stashRow(one))}
    </Box>
  )
}
