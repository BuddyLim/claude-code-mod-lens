// The git graph: the whole history in lanes, with what an opened commit or
// stash holds under its row, and the panel that starts a comparison.
//
// The graph draws its own window over the history, as the file screen does
// over a file: every line is exactly one row tall, so the window knows which
// line sits on which row, the pane's own scroll stays put, and only the
// lines in view are ever drawn.

import type { RenderChildren } from 'claude-code'

import type { GraphRow, Picked, Span } from '../../types'
import type { Stash } from '../git'
import { GRAPH_COMMITS, UNCOMMITTED, laneColor } from '../git'
import { clamp, wrapText } from '../text'
import { iconOf } from '../tree'
import type { Kit, Shell } from './frame'
import {
  BODY_ROWS,
  COMMIT_BOX,
  COMMIT_FILES,
  STASH_COLOR,
  STASH_ICON,
  STATUS_WORD,
  helpButton,
  statusLine,
} from './frame'

// Nerd Font glyphs for the graph's badges, and the ground a name is set on.
const BRANCH_ICON = '\u{e725}'
const TAG_ICON = '\u{f02b}'
const BADGE_GROUND = '#2d333b'
// The longest a branch's name is drawn on a graph row before it is cut.
const BADGE_NAME = 18
// The compare panel: how many names it offers under its fields, and the rows
// it takes in all (its border, two fields, a caption, the offers, a gap, the
// buttons), fixed so the graph's window knows what is left.
const PICK_OFFERS = 6
const PICK_ROWS = PICK_OFFERS + 7

export type GraphModel = {
  shell: Shell
  // The history, the uncommitted row first; and the stashes, each hung under
  // the commit it was made on.
  rows: readonly GraphRow[]
  stashes: readonly Stash[]
  // The local branches, the one checked out ("HEAD" when detached) and its
  // commit's short hash.
  branches: readonly string[]
  head: string
  headHash: string
  // What the comparison is against, and whether it is between two commits
  // (what is checked out then plays no part, and cannot be undone from here).
  base: string
  hasTarget: boolean
  // The commit or stash opened ('' for none), what it holds once that is
  // read, and the first line of its body in view.
  selected: string
  picked: Picked
  bodyTop: number
  // The first line of the window, 0-based.
  top: number
  // Whether undoing the last commit is being confirmed, and what is known
  // about that commit being pushed.
  isUndoing: boolean
  undoNote: string
  // The compare panel: whether it is open, what its two fields hold, and
  // which of them the offers are for.
  isPicking: boolean
  pickA: string
  pickB: string
  pickField: 'a' | 'b'
}

export type GraphActions = {
  // Returns to where the graph was opened from.
  back: () => void
  help: () => void
  refresh: () => void
  // Moves the window so `line` is its first.
  scrollTo: (line: number) => void
  // Opens a commit or a stash under its row, or closes the one that is open.
  open: (id: string) => void
  // Opens a file as that commit or stash left it.
  openFile: (id: string, path: string) => void
  applyStash: (ref: string) => void
  popStash: (ref: string) => void
  // Compares what is checked out with a commit.
  compareWith: (hash: string) => void
  checkOutBranch: (name: string) => void
  checkOutCommit: (hash: string) => void
  // Undoing the last commit: asked for, confirmed, or called off.
  askUndo: () => void
  undo: () => void
  keepCommit: () => void
  // The compare panel: opened (on the comparison in force) or closed, called
  // off, typed in, an offer taken in place of typing, and the comparison of
  // what the two fields name started.
  toggleCompare: () => void
  cancelCompare: () => void
  typeCompare: (field: 'a' | 'b', text: string) => void
  takeOffer: (value: string) => void
  compare: (side: string, against: string) => void
}

// The window as drawn, for the scroll hook: how many rows the header takes,
// the kind of line on each row under it, the furthest the first line may go
// (where the last line sits on the bottom row), and how far the opened
// commit's body can scroll.
export type GraphWindow = {
  header: number
  kinds: ('row' | 'body')[]
  maxTop: number
  bodyMax: number
}

export const graphScreen = (
  kit: Kit,
  model: GraphModel,
  actions: GraphActions,
): { tree: RenderChildren; window: GraphWindow } => {
  const { Box, Button, Text, Input } = kit
  const { shell, rows: graphRows, stashes, branches, head, headHash, base, selected } = model
  const { picked: chosen, isPicking, pickA, pickB, pickField } = model
  const { totals } = shell
  const graphWidth = Math.max(2, ...graphRows.slice(0, 400).map(row => row.width))
  const inGraph = new Set(graphRows.map(row => row.hash))
  const columns = shell.columns
  // What is left of a row beside the lanes, for text that must not wrap.
  const textRoom = Math.max(12, columns - (graphWidth + 1) - 2)
  const cut = (text: string, room: number): string =>
    text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text

  const lanesOf = (cells: readonly Span[]) => (
    <Box flexShrink={0} width={graphWidth + 1}>
      <Text>
        {cells.map(cell => (cell[0] === '' ? cell[1] : <Text color={cell[0]}>{cell[1]}</Text>))}
      </Text>
    </Box>
  )
  // One row of the window: the lanes, then what the row says, clipped to
  // a single row whatever its width.
  const rowOf = (cells: readonly Span[], rest: RenderChildren) => (
    <Box height={1} overflow="hidden">
      {lanesOf(cells)}
      {rest}
    </Box>
  )
  const lines: { kind: 'row' | 'body'; draw: () => ReturnType<typeof rowOf> }[] = []
  const add = (
    cells: readonly Span[],
    rest: () => RenderChildren,
    kind: 'row' | 'body' = 'row',
  ) =>
    lines.push({ kind, draw: () => rowOf(cells, rest()) })

  const detailText = wrapText(chosen.subject, textRoom)
  const detailBody = wrapText(chosen.body, textRoom - 2)
  const detailTop = clamp(model.bodyTop, 0, detailBody.length - BODY_ROWS)

  // What an opened commit or stash holds, a line each, with the lanes
  // still running down beside it: its whole subject, its body in a window
  // of its own, what can be done with it, and the files it changed.
  const details = (id: string, cells: readonly Span[], offered: (() => RenderChildren)[]) => {
    if (selected !== id) {
      return
    }

    if (chosen.hash !== id) {
      add(cells, () => <Text dimColor>Loading…</Text>)

      return
    }

    for (const text of detailText) {
      add(cells, () => <Text bold>{text}</Text>)
    }

    for (const text of detailBody.slice(detailTop, detailTop + BODY_ROWS)) {
      add(
        cells,
        () => (
          <Text italic dimColor>
            ▏ {text}
          </Text>
        ),
        'body',
      )
    }

    if (detailBody.length > BODY_ROWS) {
      add(
        cells,
        () => (
          <Text dimColor>
            ▏ lines {detailTop + 1}–{Math.min(detailBody.length, detailTop + BODY_ROWS)} of{' '}
            {detailBody.length} · scroll here for the rest
          </Text>
        ),
        'body',
      )
    }

    for (const offer of offered) {
      add(cells, offer)
    }

    if (chosen.files.length === 0) {
      add(cells, () => <Text dimColor>No files changed here.</Text>)
    }

    for (const one of chosen.files.slice(0, COMMIT_FILES)) {
      const icon = iconOf(one.path)
      const stat = chosen.stats[one.path]
      const change = STATUS_WORD[one.status]

      add(cells, () => [
        <Text color={icon.color}>{icon.glyph} </Text>,
        <Button
          plain
          key={`changed:${id}:${one.path}`}
          label={cut(one.path, textRoom - 26)}
          onPress={() => actions.openFile(id, one.path)}
        />,
        change !== undefined && <Text color={change[1]}>  {change[0]}</Text>,
        stat !== undefined && <Text color="green">  +{stat[0]}</Text>,
        stat !== undefined && <Text color="red"> −{stat[1]}</Text>,
      ])
    }

    if (chosen.files.length > COMMIT_FILES) {
      add(cells, () => (
        <Text dimColor>… {chosen.files.length - COMMIT_FILES} more files</Text>
      ))
    }
  }

  const stashLines = (one: Stash, cells: readonly Span[], isAdrift: boolean) => {
    const trail = `${isAdrift && one.base ? `on ${one.base} · ` : ''}${(one.when ?? '').replace(' ago', '')}`

    add(cells, () => [
      <Text backgroundColor={STASH_COLOR} color="#000000">
        {' '}
        {STASH_ICON}{' '}
      </Text>,
      <Text> </Text>,
      <Button plain key={`stash:${one.ref}`} label={one.ref} onPress={() => actions.open(one.ref)} />,
      <Text dimColor>
        {' '}
        {cut(one.subject, textRoom - one.ref.length - trail.length - 20)} {trail}{' '}
      </Text>,
      <Button
        plain
        key={`apply:${one.ref}`}
        label="apply"
        onPress={() => actions.applyStash(one.ref)}
      />,
      <Text> </Text>,
      <Button plain key={`pop:${one.ref}`} label="pop" onPress={() => actions.popStash(one.ref)} />,
    ])
    details(one.ref, cells, [])
  }

  for (const row of graphRows) {
    const below = row.below ?? []

    // What is not committed yet sits in its own lane, joined to the
    // commit checked out; its dot is hollow, there being no commit there.
    if (row.hash === UNCOMMITTED) {
      add(
        row.cells.map((cell): Span => [cell[0], cell[1].replace('●', '○')]),
        () => [
          <Text dimColor>Uncommitted changes ({totals.files}) </Text>,
          <Text color="green">+{totals.added} </Text>,
          <Text color="red">−{totals.deleted} </Text>,
          <Text color="red">{totals.errors}✖ </Text>,
          <Text color="yellow">{totals.others}⚠</Text>,
        ],
      )

      if (below.some(cell => cell[0] !== '')) {
        add(below, () => undefined)
      }

      continue
    }

    const trail = `${row.when.replace(' ago', '')} · ${row.author.split(' ')[0] ?? ''} ${row.hash}`
    const names = row.refs.map(ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    // The badges may take under half the row, so the title always has room
    // to be read and pressed: a long name is cut, and the badges that do
    // not fit are counted in one last badge. Each costs three cells of
    // icon, the name with a space each side, and a gap. The opened commit
    // lists every name in full.
    let badgeRoom = Math.floor(textRoom * 0.45)
    const worn: { ref: string; name: string }[] = []
    // A branch and a remote's copy of it on the same commit share one badge,
    // the remote named after it ("main | origin"): the copy has no badge of
    // its own. A name is a remote's copy when it is no local branch and what
    // follows its first slash is one on this row.
    const onRow = new Set(names)
    const isCopy = (name: string): boolean =>
      name.includes('/') &&
      !model.branches.includes(name) &&
      onRow.has(name.slice(name.indexOf('/') + 1))
    const merged = row.refs.flatMap((ref, at) => {
      const name = names[at] ?? ''

      if (!ref.startsWith('tag: ') && isCopy(name)) {
        return []
      }

      const remotes = ref.startsWith('tag: ')
        ? []
        : names
            .filter(other => isCopy(other) && other.slice(other.indexOf('/') + 1) === name)
            .map(other => ` | ${other.slice(0, other.indexOf('/'))}`)

      return [{ ref, name, tail: remotes.join('') }]
    })

    for (const { ref, name, tail } of merged) {
      const label = `${cut(name, BADGE_NAME)}${tail}`

      if (label.length + 6 > badgeRoom) {
        break
      }

      badgeRoom -= label.length + 6
      worn.push({ ref, name: label })
    }

    const unworn = merged.length - worn.length
    const badges =
      worn.reduce((sum, one) => sum + one.name.length + 6, 0) +
      (unworn > 0 ? String(unworn).length + 4 : 0)
    const isCrowded =
      unworn > 0 || worn.some((one, at) => one.name !== `${merged[at]?.name}${merged[at]?.tail}`)
    const subject = row.subject === '' ? '(no message)' : row.subject

    // The title is the row's handle: pressing it opens what the commit holds.
    add(row.cells, () => [
      // A branch or tag is a badge in two parts: its icon on the lane's
      // colour, then its name on a neutral ground.
      ...worn.map(({ ref, name }) => (
        <Box flexShrink={0} marginRight={1}>
          <Text backgroundColor={laneColor(row.lane)} color="#000000">
            {' '}
            {ref.startsWith('tag: ') ? TAG_ICON : BRANCH_ICON}{' '}
          </Text>
          <Text backgroundColor={BADGE_GROUND} color="#e6e6e6" bold={ref.startsWith('HEAD')}>
            {' '}
            {name}{' '}
          </Text>
        </Box>
      )),
      unworn > 0 && (
        <Box flexShrink={0} marginRight={1}>
          <Text backgroundColor={BADGE_GROUND} color="#e6e6e6">
            {' '}
            +{unworn}{' '}
          </Text>
        </Box>
      ),
      <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        <Button
          plain
          key={`commit:${row.hash}`}
          // An opened commit shows its whole subject just under the row,
          // so the row itself draws a rule there, still the handle to
          // press to close it.
          label={
            selected === row.hash
              ? '─'.repeat(Math.max(8, textRoom - badges - trail.length - 1))
              : cut(subject, Math.max(8, textRoom - badges - trail.length - 1))
          }
          onPress={() => actions.open(row.hash)}
        />
      </Box>,
      <Box flexShrink={0} marginLeft={1}>
        <Text dimColor>{trail}</Text>
      </Box>,
    ])

    // The commit checked out is what everything is compared from, so it
    // offers neither a comparison nor a checkout of itself.
    details(row.hash, below, [
      // Every branch and tag on the commit, where the row had to cut them.
      ...(isCrowded
        ? wrapText(names.join(', '), textRoom - 2).map(text => () => (
            <Text color={laneColor(row.lane)}>
              {BRANCH_ICON} {text}
            </Text>
          ))
        : []),
      ...(row.hash === headHash ? [() => <Text dimColor>You are here.</Text>] : []),
      // The commit checked out can be taken back, its changes kept: asked
      // first, and then told whether it has been pushed, before it is done.
      ...(row.hash === headHash && !model.hasTarget && !model.isUndoing
        ? [
            () => (
              <Button
                key="undo"
                label="undo this commit (keep its changes)"
                onPress={actions.askUndo}
              />
            ),
          ]
        : []),
      ...(row.hash === headHash && model.isUndoing
        ? [
            () => (
              <Text color="red" bold>
                Undo this commit? {model.undoNote}
              </Text>
            ),
            () => [
              <Button key="undo-yes" label="yes, undo it" onPress={actions.undo} />,
              <Text>  </Text>,
              <Button key="undo-no" variant="primary" label="keep it" onPress={actions.keepCommit} />,
            ],
          ]
        : []),
      ...(row.hash === base ? [() => <Text dimColor>Comparing against this.</Text>] : []),
      ...(row.hash !== headHash && row.hash !== base
        ? [
            () => (
              <Button
                key={`compare:${row.hash}`}
                label={`compare ${shell.headName} with this`}
                onPress={() => actions.compareWith(row.hash)}
              />
            ),
          ]
        : []),
      ...names
        .filter(name => branches.includes(name) && name !== head)
        .map(branch => () => (
          <Button
            key={`switch:${branch}`}
            label={`check out ${branch}`}
            onPress={() => actions.checkOutBranch(branch)}
          />
        )),
      ...(row.hash !== headHash
        ? [
            () => (
              <Button
                key={`detach:${row.hash}`}
                label={`check out ${row.hash} (detached)`}
                onPress={() => actions.checkOutCommit(row.hash)}
              />
            ),
          ]
        : []),
    ])

    // The stashes made on this commit, hung under it.
    for (const one of stashes) {
      if (one.base === row.hash) {
        stashLines(one, below, false)
      }
    }

    if (below.some(cell => cell[0] !== '')) {
      add(below, () => undefined)
    }
  }

  if (graphRows.length === 0) {
    add([], () => <Text dimColor>No commits to show yet.</Text>)
  } else if (graphRows.length < GRAPH_COMMITS) {
    add([], () => <Text dimColor>The first commit: history starts here.</Text>)
  } else {
    add([], () => (
      <Text dimColor>Only the newest {GRAPH_COMMITS} commits are read.</Text>
    ))
  }

  // A stash made on a commit the graph does not reach has no row to hang
  // under, so it comes after the history.
  for (const one of stashes) {
    if (!inGraph.has(one.base ?? '')) {
      stashLines(one, [], true)
    }
  }

  // The compare panel: two fields, each taking a branch name or a commit
  // hash as typed, and under them what the field being typed in could
  // mean, to press in place of typing the rest.
  const asked = (pickField === 'a' ? pickA : pickB).toLowerCase()
  const offers = isPicking
    ? [
        ...(pickField === 'a' ? [{ value: '', label: 'working tree (your files as they are)' }] : []),
        ...branches.map(name => ({ value: name, label: name })),
        ...graphRows
          .filter(row => row.hash !== UNCOMMITTED)
          .map(row => ({ value: row.hash, label: `${row.hash}  ${row.subject}` })),
      ]
        .filter(offer => asked === '' || offer.label.toLowerCase().includes(asked))
        .slice(0, PICK_OFFERS)
    : []
  const panel = isPicking && Input !== undefined && (
    <Box
      flexDirection="column"
      height={PICK_ROWS}
      overflow="hidden"
      borderStyle="round"
      borderColor={COMMIT_BOX}
      paddingX={1}
    >
      <Input
        key="pick-a"
        label="compare"
        placeholder="working tree, a branch or commit, or a request: #12"
        value={pickA}
        submitLabel="compare"
        onInput={value => actions.typeCompare('a', value)}
        onSubmit={value => actions.compare(value, pickB)}
      />
      <Input
        key="pick-b"
        label="with   "
        placeholder="a branch, a commit, or a request: #12, !34 or its link"
        value={pickB}
        submitLabel="compare"
        onInput={value => actions.typeCompare('b', value)}
        onSubmit={value => actions.compare(pickA, value)}
      />
      <Text dimColor>
        {offers.length === 0
          ? 'Nothing here matches; a full hash or ref still works.'
          : `For "${pickField === 'a' ? 'compare' : 'with'}":`}
      </Text>
      {offers.map(offer => (
        <Box height={1} overflow="hidden">
          <Button
            plain
            key={`offer:${offer.value}`}
            label={cut(offer.label, columns - 8)}
            onPress={() => actions.takeOffer(offer.value)}
          />
        </Box>
      ))}
      <Box flexGrow={1} />
      <Box columnGap={2}>
        <Button
          key="pick-go"
          variant="primary"
          label="compare"
          onPress={() => actions.compare(pickA, pickB)}
        />
        <Button key="pick-cancel" label="cancel" onPress={actions.cancelCompare} />
      </Box>
    </Box>
  )

  const HEADER_ROWS = 3 + (panel ? PICK_ROWS : 0)
  const room = clamp(shell.rows - HEADER_ROWS, 5, 400)
  // The window stops once the last line reaches its bottom row.
  const maxTop = Math.max(0, lines.length - room)
  const top = clamp(model.top, 0, maxTop)
  const shown = lines.slice(top, top + room)
  const moveTo = (line: number) => actions.scrollTo(clamp(line, 0, maxTop))

  return {
    // What the scroll hook needs to tell a tick over a body from one over
    // the graph: the kind of line on each row of the window just drawn.
    window: {
      // The comparison border's top edge is a row above the header too.
      header: HEADER_ROWS + shell.inset / 2,
      kinds: shown.map(line => line.kind),
      maxTop,
      bodyMax: Math.max(0, detailBody.length - BODY_ROWS),
    },
    tree: (
      <Box flexDirection="column">
        {statusLine(kit, shell)}
        <Box columnGap={2} height={1} overflow="hidden">
          <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
          <Button
            plain
            key="down"
            hotkey="d"
            label="down"
            onPress={() => moveTo(top + Math.floor(room / 2))}
          />
          <Button
            plain
            key="up"
            hotkey="u"
            label="up"
            onPress={() => moveTo(top - Math.floor(room / 2))}
          />
          <Button plain key="top" hotkey="g" label="top" onPress={() => moveTo(0)} />
          {helpButton(kit, actions.help)}
          <Button
            plain
            key="pick"
            hotkey="c"
            label={isPicking ? 'close compare' : 'compare…'}
            onPress={actions.toggleCompare}
          />
          <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {Math.max(0, graphRows.length - 1)} commits · press a title or a stash's name to open
          it
        </Text>
        {panel}
        <Box flexDirection="column" height={room} overflow="hidden">
          {shown.map(line => line.draw())}
        </Box>
      </Box>
    ),
  }
}
