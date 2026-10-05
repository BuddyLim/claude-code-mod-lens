// The file tree: what differs, grouped by where the difference lives, with
// each file's problems counted beside it; the box that commits, stashes or
// discards the ticked files; and the stashes made earlier. It is as long as
// its lists, so the pane scrolls it.

import type { ChangedFile, Diag, LineStat, Picked } from '../../types'
import { isAwaited, isCheckable } from '../check'
import { countLabel, diagsOf } from '../diags'
import type { Stash } from '../git'
import type { Comment } from '../review'
import { clamp, wrapText } from '../text'
import type { TreeRow } from '../tree'
import { buildTree, iconOf, visibleTree } from '../tree'
import type { Kit, Shell } from './frame'
import {
  BODY_ROWS,
  COMMENT_COLOR,
  COMMENT_ICON,
  COMMIT_BOX,
  COMMIT_FILES,
  STASH_COLOR,
  STASH_ICON,
  STATUS_WORD,
  helpButton,
  notesOf,
  said,
  statusLine,
} from './frame'

const OTHER_FILES = 100
// More rows than this are not drawn in one list.
const LIST_LIMIT = 300
// How many of the conversation's latest comments are listed.
const CONVERSATION_ROWS = 15
// How far an arrow moves an opened stash's body.
const BODY_STEP = 8

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
  // The tree of every tracked file: whether it shows, and the files.
  isBrowsing: boolean
  allFiles: readonly string[]
  isTelling: boolean
  // How many issues "send to prompt" would send.
  issuesToSend: number
  // The comments of the request under review, on files of this folder.
  comments: readonly Comment[]
  stashes: readonly Stash[]
  // The stash opened ('' for none), what it holds once that is read, and the
  // first line of its body in view.
  selected: string
  picked: Picked
  bodyTop: number
}

export type TreeActions = {
  refresh: () => void
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
}

export const treeScreen = (kit: Kit, model: TreeModel, actions: TreeActions) => {
  const { Box, Button, Text, Input } = kit
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
  const summary = (
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
  const tick = (key: string, paths: readonly string[]) => (
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
    const isChecked = isCheckable(path)
    const icon = iconOf(path)
    // What happened to the file, in a word and git's usual colour for it.
    const change = STATUS_WORD[mark]
    const lead = [
      <Text>{'  '.repeat(depth)}</Text>,
      isPickable && tick(`check:${path}`, [path]),
      isPickable && <Text> </Text>,
    ]

    if (mark === 'D') {
      return (
        <Box>
          {lead}
          <Text dimColor>
            {icon.glyph} {name}
          </Text>
          <Text color="#f14c4c">  deleted</Text>
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
          onPress={() => actions.open(path)}
        />
        {change !== undefined && <Text color={change[1]}>  {change[0]}</Text>}
        {comments.some(one => one.path === path) && (
          <Text color={COMMENT_COLOR}>
            {'  '}
            {COMMENT_ICON} {comments.filter(one => one.path === path).length}
          </Text>
        )}
        {stats[path] !== undefined && (
          <Text color="green">  +{stats[path]?.[0] ?? 0}</Text>
        )}
        {stats[path] !== undefined && <Text color="red"> −{stats[path]?.[1] ?? 0}</Text>}
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
  const stashRow = (one: Stash) => [
    <Box>
      <Text backgroundColor={STASH_COLOR} color="#000000">
        {' '}
        {STASH_ICON}{' '}
      </Text>
      <Text> </Text>
      <Button plain key={`stash:${one.ref}`} label={one.ref} onPress={() => actions.openStash(one.ref)} />
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {' '}
          {one.subject}
        </Text>
      </Box>
      <Box flexShrink={0} columnGap={1} marginLeft={1}>
        <Text dimColor>
          {one.base ? `on ${one.base} · ` : ''}
          {(one.when ?? '').replace(' ago', '')}
        </Text>
        <Button
          plain
          key={`apply:${one.ref}`}
          label="apply"
          onPress={() => actions.applyStash(one.ref)}
        />
        <Button plain key={`pop:${one.ref}`} label="pop" onPress={() => actions.popStash(one.ref)} />
      </Box>
    </Box>,
    filesOf(one.ref, 2),
  ]

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box gap={2}>
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        <Button
          plain
          key="layout"
          hotkey="t"
          label={layout === 'tree' ? 'list view' : 'tree view'}
          onPress={actions.switchLayout}
        />
        <Button plain key="graph" hotkey="g" label="git graph" onPress={actions.openGraph} />
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
      {model.isMore && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box columnGap={2} flexWrap="wrap">
            <Button
              plain
              key="project"
              hotkey="a"
              label="check whole project"
              onPress={actions.checkProject}
            />
            <Button
              plain
              key="browse"
              hotkey="w"
              label={isBrowsing ? 'changed files only' : 'all files'}
              onPress={actions.toggleAllFiles}
            />
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
          {Input !== undefined && (
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
      {summary}
      {gitBar}
      {files.length === 0 && model.isScanned && (
        <Text dimColor>
          {shell.isComparing ? `Nothing differs from ${shell.against}.` : 'Nothing is modified.'}
        </Text>
      )}
      {groups.flatMap((group, at) => {
        const rows = rowsFor(group, at)

        return [
          <Text bold>
            {group.title} ({group.files.length})
          </Text>,
          ...rows.slice(0, LIST_LIMIT),
          rows.length > LIST_LIMIT && (
            <Text dimColor>… {rows.length - LIST_LIMIT} more rows not shown</Text>
          ),
        ]
      })}
      {/* What was said on the request as a whole, and the comments that
          no longer sit on a line (the code under them has changed). */}
      {comments.some(one => one.line === 0) && (
        <Text bold>Conversation ({comments.filter(one => one.line === 0).length})</Text>
      )}
      {comments
        .filter(one => one.line === 0)
        .slice(-CONVERSATION_ROWS)
        .map(one => (
          <Text color={one.path === '' ? undefined : COMMENT_COLOR} wrap="truncate-end">
            {COMMENT_ICON} {one.path === '' ? '' : `${one.path} (outdated) · `}
            {said(one)}
          </Text>
        ))}
      {others.length > 0 && <Text bold>Other files with issues ({others.length})</Text>}
      {others.slice(0, OTHER_FILES).map(path => fileRow(path, ' '))}
      {isBrowsing && <Text bold>All files ({everything.length})</Text>}
      {isBrowsing && everything.length === 0 && <Text dimColor>Reading the file list…</Text>}
      {everyRow.slice(0, LIST_LIMIT)}
      {everyRow.length > LIST_LIMIT && (
        <Text dimColor>… {everyRow.length - LIST_LIMIT} more rows; open a folder to narrow</Text>
      )}
      {/* What was stashed earlier: apply keeps the stash, pop removes it
          once its changes are back. */}
      {stashes.length > 0 && <Text bold>Stashes ({stashes.length})</Text>}
      {stashes.flatMap(one => stashRow(one))}
    </Box>
  )
}
