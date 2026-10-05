// Everything that knows a git command line, or how git prints things: what
// differs and where, the history and its lanes, blame, stashes, and the
// commands that change the repo. Callers pass the `run` they hold and get
// the pane's own values back; the parsers are exported for their tests.

import type {
  ChangedFile,
  Commit,
  GraphRow,
  LineRange,
  LineStat,
  Picked,
  Scan,
  Span,
} from '../types'
import type { Run } from './run'
import { FILE_LIMIT, tail } from './run'

// `git diff --name-status`: "M\tpath", a rename "R100\told\tnew".
export const parseNameStatus = (out: string): ChangedFile[] =>
  out
    .split('\n')
    .filter(line => line.includes('\t'))
    .map(line => {
      const parts = line.split('\t')

      return { path: parts[parts.length - 1] ?? '', status: line.charAt(0) }
    })

export const parseUntracked =(out: string): ChangedFile[] =>
  out
    .split('\n')
    .filter(line => line !== '')
    .map(path => ({ path, status: '?' }))

// `git diff -U0 --no-prefix`: the added side of each hunk, per file.
export const parseChangedLines = (out: string): Record<string, LineRange[]> => {
  const changed: Record<string, LineRange[]> = {}
  let path = ''

  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      path = line.slice(4).trim()
      continue
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    const count = hunk?.[2] === undefined ? 1 : Number(hunk[2])

    if (hunk === null || path === '' || path === '/dev/null' || count === 0) {
      continue
    }

    const from = Number(hunk[1])
    changed[path] = [...(changed[path] ?? []), [from, from + count - 1]]
  }

  return changed
}

// One file's `git diff -U0`: the lines the base had and the working tree
// dropped, keyed by the new file's line they come before. A hunk that only
// removes names the line it follows, so its lines come before the next one.
export const parseRemoved = (out: string): Record<number, string[]> => {
  const removed: Record<number, string[]> = {}
  let before = 0

  for (const line of out.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)

    if (hunk !== null) {
      before = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0)
    } else if (before > 0 && line.startsWith('-') && !line.startsWith('---')) {
      removed[before] = [
        ...(removed[before] ?? []),
        line.slice(1).replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f]/g, ''),
      ]
    }
  }

  return removed
}

export type BlameLine = { hash: string; author: string; time: number; summary: string }

// `git blame --porcelain`: who last changed each line, in the file's order.
// A commit's details are printed with its first line only, so they are kept
// by hash for its later ones. A line not committed yet has an all-zero hash.
export const parseBlame = (out: string): BlameLine[] => {
  const known = new Map<string, BlameLine>()
  const lines: BlameLine[] = []
  let current: BlameLine | undefined

  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line)

    if (head !== null) {
      const hash = head[1] ?? ''

      current = known.get(hash) ?? { hash, author: '', time: 0, summary: '' }
      known.set(hash, current)
    } else if (current === undefined) {
      continue
    } else if (line.startsWith('\t')) {
      lines.push(current)
    } else if (line.startsWith('author ')) {
      current.author = line.slice(7)
    } else if (line.startsWith('author-time ')) {
      current.time = Number(line.slice(12))
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice(8)
    }
  }

  return lines
}

// How long ago, in the shortest form that still reads: 5m, 3h, 12d, 4mo, 2y.
export const ageOf = (seconds: number): string => {
  const steps: [size: number, unit: string][] = [
    [31_536_000, 'y'],
    [2_592_000, 'mo'],
    [86_400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ]
  const step = steps.find(([size]) => seconds >= size)

  return step === undefined ? 'now' : `${Math.floor(seconds / step[0])}${step[1]}`
}

// `git diff --numstat`: "added<tab>deleted<tab>path"; a binary file has "-".
export const parseNumstat = (out: string): Record<string, LineStat> => {
  const stats: Record<string, LineStat> = {}

  for (const line of out.split('\n')) {
    const [added, deleted, path] = line.split('\t')

    if (path !== undefined && path !== '') {
      stats[path] = [Number(added) || 0, Number(deleted) || 0]
    }
  }

  return stats
}

// `wc -l` over untracked files: every line of a new file counts as added.
export const parseLineCounts = (out: string): Record<string, LineStat> => {
  const stats: Record<string, LineStat> = {}

  for (const line of out.split('\n')) {
    const hit = /^\s*(\d+)\s+(.+)$/.exec(line)

    if (hit !== null && hit[2] !== 'total') {
      stats[hit[2] ?? ''] = [Number(hit[1]), 0]
    }
  }

  return stats
}

// `git log` with each commit's fields set off by \x01: hash, parents, refs,
// subject, relative date, author.
export const parseCommits = (out: string): Commit[] =>
  out
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [hash = '', parents = '', refs = '', subject = '', when = '', author = ''] =
        line.split('\u0001')

      return {
        hash,
        parents: parents.split(' ').filter(parent => parent !== ''),
        refs: refs.split(', ').filter(ref => ref !== ''),
        subject,
        when,
        author,
      }
    })

// The lane colours of VS Code's Git Graph, in its order.
const LANE_COLORS = [
  '#0085d9',
  '#d9008f',
  '#00d90a',
  '#d98500',
  '#a300d9',
  '#ff0000',
  '#00d9cc',
  '#e138e8',
  '#85d900',
  '#dc5b23',
  '#6f24d6',
  '#ffcc00',
]

export const laneColor = (lane: number): string =>
  LANE_COLORS[lane % LANE_COLORS.length] ?? '#0085d9'

// Lays commits (newest first, children before parents) out in lanes, one row
// each. A lane holds the hash it waits for; a commit takes the lane waiting
// for it, closes the other lanes waiting for it (branches that started from
// it), hands its lane to its first parent and opens or joins a lane for each
// other parent (a merge).
export const layoutGraph = (commits: readonly Commit[]): GraphRow[] => {
  const lanes: (string | undefined)[] = []

  return commits.map(commit => {
    const before = [...lanes]
    const waiting = before.indexOf(commit.hash)
    const free = lanes.findIndex(held => held === undefined)
    const lane = waiting !== -1 ? waiting : free !== -1 ? free : lanes.length
    const closing = before.flatMap((held, at) => (held === commit.hash && at !== lane ? [at] : []))

    for (const at of closing) {
      lanes[at] = undefined
    }

    lanes[lane] = commit.parents[0]

    const opening: number[] = []
    const joining: number[] = []

    for (const parent of commit.parents.slice(1)) {
      const held = lanes.findIndex((one, at) => one === parent && at !== lane)

      if (held !== -1) {
        joining.push(held)
        continue
      }

      const spare = lanes.findIndex((one, at) => one === undefined && at !== lane)
      const at = spare !== -1 ? spare : lanes.length
      lanes[at] = parent
      opening.push(at)
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) {
      lanes.pop()
    }

    const width = Math.max(before.length, lanes.length, lane + 1)
    const reached = [...closing, ...opening, ...joining]
    const cells: Span[] = []

    const push = (color: string, text: string): void => {
      const last = cells[cells.length - 1]

      if (last !== undefined && last[0] === color) {
        last[1] += text
      } else {
        cells.push([color, text])
      }
    }

    for (let at = 0; at < width; at += 1) {
      // A connector runs along the row from the commit's lane to each lane it reaches.
      const crossing = reached.find(to => at > Math.min(lane, to) && at < Math.max(lane, to))
      const filling = reached.find(to => at >= Math.min(lane, to) && at < Math.max(lane, to))
      const glyph =
        at === lane
          ? '●'
          : closing.includes(at)
            ? at > lane
              ? '╯'
              : '╰'
            : opening.includes(at)
              ? at > lane
                ? '╮'
                : '╭'
              : joining.includes(at)
                ? at > lane
                  ? '┤'
                  : '├'
                : before[at] !== undefined
                  ? '│'
                  : crossing !== undefined
                    ? '─'
                    : ' '

      push(
        glyph === ' ' ? '' : glyph === '─' && crossing !== undefined ? laneColor(crossing) : laneColor(at),
        glyph,
      )
      push(filling === undefined ? '' : laneColor(filling), filling === undefined ? ' ' : '─')
    }

    // The lanes still open under this commit, drawn on a row of their own so
    // each dot is joined to the next one down its lane.
    const below: Span[] = []

    lanes.forEach((held, at) => {
      const color = held === undefined ? '' : laneColor(at)
      const last = below[below.length - 1]

      if (last !== undefined && last[0] === color) {
        last[1] += held === undefined ? '  ' : '│ '
      } else {
        below.push([color, held === undefined ? '  ' : '│ '])
      }
    })

    return { ...commit, cells, below, width: width * 2, lane }
  })
}

export const sumStats = (stats: readonly LineStat[]): LineStat =>
  stats.reduce<LineStat>((sum, one) => [sum[0] + one[0], sum[1] + one[1]], [0, 0])

// ---------------------------------------------------------------------------
// The commands. Each takes the `run` its caller holds and the folder under
// review, and answers in the pane's own terms; none rejects.
// ---------------------------------------------------------------------------

// The most commits the graph reads. Only the rows in view are drawn, so the
// limit is on what git prints and the module holds, not on the pane.
export const GRAPH_COMMITS = 5000

// The row that stands for what is not committed yet: a commit of the graph's
// own making whose parent is the commit checked out, so it is laid out in a
// lane that runs down to that commit like any other child of it.
export const UNCOMMITTED = '*'
const UNCOMMITTED_COLOR = '#8b949e'

export type Stash = Scan['stashes'][number]

// `git worktree list --porcelain`: a block per worktree, its folder first,
// then its commit and the branch it has checked out (none when detached).
export const parseWorktrees = (out: string): { path: string; branch: string; head: string }[] =>
  out
    .split(/\n\s*\n/)
    .map(block => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '',
      head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? '',
    }))
    .filter(one => one.path !== '')

// Exports a commit ($1, its short hash $2) of the folder it runs in to a
// temporary folder and prints that folder's real path. A repo folder keeps
// this export and the one named by $3 (the comparison's other side, when it
// is a commit too); older ones are removed. Nothing in the repo or its .git
// changes, which a `git worktree` would.
const EXPORT_BASE = [
  'root="${TMPDIR:-/tmp}/lens-base"',
  'name=$(basename "$PWD")',
  'dir="$root/$name-$2"',
  'if [ ! -d "$dir" ]; then',
  '  mkdir -p "$root" || exit 1',
  // Only what is inside the folder: `find` would otherwise offer the folder
  // itself, whose name a repo's can match (a repo called "lens", "lens-base").
  '  find "$root" -mindepth 1 -maxdepth 1 -name "$name-*" ! -name "$name-$2" ! -name "$name-${3:-$2}" -exec rm -rf {} +',
  '  mkdir "$dir.partial" && git archive "$1" | tar -x -C "$dir.partial" && mv "$dir.partial" "$dir" || exit 1',
  'fi',
  'cd "$dir" && pwd -P',
].join('\n')

const lines = (out: string): string[] => out.split('\n').filter(line => line !== '')

// The real path of the folder a person named (`~` and all), when it is inside
// a git repository; '' when it is not. A shell resolves it, and the folder
// rides as an argument.
export const findRepo = async (run: Run, folder: string): Promise<string> => {
  const resolved = await run([
    'sh',
    '-c',
    'case "$1" in "~"*) set -- "$HOME${1#\\~}";; esac; cd "$1" && git rev-parse --git-dir >/dev/null && pwd -P',
    'sh',
    folder,
  ])

  return resolved.exitCode !== 0 ? '' : resolved.stdout.trim()
}

// The history as the graph draws it: the uncommitted row first, then the
// commits, laid out in lanes. The uncommitted row's lane is drawn grey down
// to the commit checked out, where the branch's own colour takes over: its
// cell is the first of each row until then.
export const layoutHistory = (commits: readonly Commit[], checkedOut: string): GraphRow[] => {
  const laidOut = layoutGraph([
    {
      hash: UNCOMMITTED,
      parents: checkedOut === '' ? [] : [checkedOut],
      refs: [],
      subject: '',
      when: '',
      author: '',
    },
    ...commits,
  ])
  const headAt = laidOut.findIndex(row => row.hash === checkedOut)
  const pendingColor = laneColor(laidOut[0]?.lane ?? 0)
  const grey = (cells: Span[]): Span[] =>
    cells.map((cell, at): Span =>
      at === 0 && cell[0] === pendingColor ? [UNCOMMITTED_COLOR, cell[1]] : cell,
    )

  return laidOut.map((row, at) =>
    at < headAt || (headAt === -1 && at === 0)
      ? { ...row, cells: grey(row.cells), below: grey(row.below) }
      : row,
  )
}

// What git alone can say of a comparison: the files that differ and where,
// their line counts, what is checked out, what is not committed, the stashes
// and the whole history. `refusal` is git's reason when the comparison itself
// could not be read, and absent when it was.
export type Changes = {
  files: ChangedFile[]
  changed: Record<string, LineRange[]>
  stats: Record<string, LineStat>
  branches: string[]
  head: string
  headHash: string
  dirty: string[]
  stashes: Stash[]
  worktrees: Scan['worktrees']
  history: GraphRow[]
  refusal?: string
}

// Reads the comparison of `base` with the working tree, or, when `target`
// names a commit, of the two commits with each other: git then diffs the
// pair, and nothing of the working tree (its untracked files, its edits)
// counts.
export const readChanges = async (
  run: Run,
  repo: string,
  base: string,
  target: string,
): Promise<Changes> => {
  const sides = target === '' ? [base] : [base, target]
  const git = (argv: string[]) => run(['git', ...argv], { cwd: repo, timeoutMs: 60_000 })
  const [named, untracked, hunks, numstat, log, branches, head, headHash, dirty, stashes, trees, top, prefix] =
    await Promise.all([
      git(['diff', '--name-status', '--relative', ...sides]),
      git(['ls-files', '--others', '--exclude-standard']),
      git(['diff', '-U0', '--no-prefix', '--relative', ...sides]),
      git(['diff', '--numstat', '--no-renames', '--relative', ...sides]),
      // Children before parents, which the lane layout relies on.
      git([
        'log',
        '--branches',
        'HEAD',
        '--topo-order',
        '-n',
        String(GRAPH_COMMITS),
        '--pretty=format:%h%x01%p%x01%D%x01%s%x01%ar%x01%an',
      ]),
      git(['branch', '--format=%(refname:short)']),
      // The branch checked out, or "HEAD" when detached; and its commit.
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['rev-parse', '--short', 'HEAD']),
      // What is edited but not committed, whatever the base is.
      git(['diff', '--name-only', '--relative', 'HEAD']),
      // Each stash with its parents (the first is the commit it was made on)
      // and how long ago.
      git(['stash', 'list', '--format=%gd%x01%gs%x01%p%x01%ar']),
      // The repo's worktrees, and where the folder under review sits in its own.
      git(['worktree', 'list', '--porcelain']),
      git(['rev-parse', '--show-toplevel']),
      git(['rev-parse', '--show-prefix']),
    ])
  // Each worktree is reviewed at the same folder of it as this one is.
  const inside = prefix.stdout.trim().replace(/\/$/, '')
  const worktrees = parseWorktrees(trees.stdout).map(one => ({
    path: inside === '' ? one.path : `${one.path}/${inside}`,
    branch: one.branch,
    head: one.head,
    isCurrent: one.path === top.stdout.trim(),
  }))
  // A worktree kept inside the repo is a checkout of its own, not new files
  // of this one: git lists its folder as untracked, and it is left out.
  const nested = parseWorktrees(trees.stdout)
    .map(one => one.path)
    .filter(path => path !== top.stdout.trim())
  const newFiles = parseUntracked(target === '' ? untracked.stdout : '').filter(one => {
    const whole = `${repo}/${one.path}`.replace(/\/$/, '')

    return !nested.some(path => whole === path || whole.startsWith(`${path}/`))
  })
  // git counts lines only for files it tracks; a new file's are all added.
  const counted =
    newFiles.length === 0
      ? { stdout: '' }
      : await run(
          [
            'sh',
            '-c',
            'wc -l -- "$@" 2>/dev/null',
            'sh',
            ...newFiles.map(one => one.path).slice(0, FILE_LIMIT),
          ],
          { cwd: repo, timeoutMs: 60_000 },
        )

  return {
    files: [...parseNameStatus(named.stdout), ...newFiles],
    changed: parseChangedLines(hunks.stdout),
    stats: { ...parseLineCounts(counted.stdout), ...parseNumstat(numstat.stdout) },
    branches: branches.stdout.split('\n').filter(name => name !== '' && !name.startsWith('(')),
    head: head.stdout.trim(),
    headHash: headHash.stdout.trim(),
    dirty: target === '' ? lines(dirty.stdout) : [],
    stashes: lines(stashes.stdout).map(line => {
      const [ref = '', subject = '', parents = '', when = ''] = line.split('\u0001')

      return { ref, subject, base: parents.split(' ')[0] ?? '', when }
    }),
    worktrees,
    history: layoutHistory(parseCommits(log.stdout), headHash.stdout.trim()),
    ...(named.exitCode !== 0 ? { refusal: tail(named.stderr) } : {}),
  }
}

// Prints a commit holding a worktree's files as they stand: what it has
// checked out, with its uncommitted edits and its untracked files. The
// commit is built through an index of its own and belongs to no branch, so
// nothing of the worktree changes: not its files, its index or its HEAD.
// Worktrees kept inside it are left out, being checkouts of their own.
const SNAPSHOT = [
  'top=$(git rev-parse --show-toplevel) && cd "$top" || exit 1',
  'head=$(git rev-parse HEAD) || exit 1',
  'index=$(mktemp) || exit 1',
  'git worktree list --porcelain | sed -n "s/^worktree //p" > "$index.trees"',
  'set -- .',
  'while IFS= read -r tree; do',
  '  case "$tree" in "$top"/*) set -- "$@" ":(exclude)${tree#"$top"/}";; esac',
  'done < "$index.trees"',
  'rm -f "$index" "$index.trees"',
  'export GIT_INDEX_FILE="$index"',
  'git read-tree HEAD && git add -A -- "$@" && tree=$(git write-tree)',
  'status=$?',
  'rm -f "$index"',
  'unset GIT_INDEX_FILE',
  '[ "$status" -eq 0 ] || exit 1',
  'git -c user.name=lens -c user.email=lens@localhost commit-tree "$tree" -p "$head" -m "lens: a worktree as it stands"',
].join('\n')

// A commit of a worktree's files as they stand (see SNAPSHOT), by its hash;
// '' with git's reason where it could not be made.
export const snapshotWorktree = async (
  run: Run,
  path: string,
): Promise<{ hash: string; refusal: string }> => {
  const made = await run(['sh', '-c', SNAPSHOT], { cwd: path, timeoutMs: 120_000 })
  const hash = made.stdout.trim()

  return made.exitCode === 0 && /^[0-9a-f]{40,}$/.test(hash)
    ? { hash, refusal: '' }
    : { hash: '', refusal: tail(made.stderr) || 'git made no snapshot' }
}

// The repo a folder's worktree belongs to, by the path of its main
// checkout; the folder's own repo root when it is that one. '' outside a repo.
export const mainRepoOf = async (run: Run, repo: string): Promise<string> => {
  const asked = await run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo,
    timeoutMs: 20_000,
  })

  return asked.exitCode === 0 ? asked.stdout.trim().replace(/\/\.git\/?$/, '') : ''
}

// The files git tracks in the repo, or only those matching the patterns.
export const trackedFiles = async (
  run: Run,
  repo: string,
  patterns: readonly string[] = [],
): Promise<string[]> =>
  lines(
    (
      await run(['git', 'ls-files', ...(patterns.length === 0 ? [] : ['--', ...patterns])], {
        cwd: repo,
        timeoutMs: 60_000,
      })
    ).stdout,
  )

// A ref's commit by its short hash, and in full; '' for a ref git does not know.
export const shortHash = async (run: Run, repo: string, ref: string): Promise<string> =>
  (await run(['git', 'rev-parse', '--short', ref], { cwd: repo, timeoutMs: 60_000 })).stdout.trim()

export const fullHash = async (run: Run, repo: string, ref: string): Promise<string> =>
  (await run(['git', 'rev-parse', ref], { cwd: repo, timeoutMs: 60_000 })).stdout.trim()

// Whether a name is a branch, tag or commit here.
export const isCommit = async (run: Run, repo: string, name: string): Promise<boolean> =>
  (await run(['git', 'rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: repo }))
    .exitCode === 0

// A commit's files as a folder of their own, outside the repo: `dir` is its
// real path, or '' with the reason in `refusal`. `short` names the folder;
// the export of `keep` (the comparison's other side) is left in place, older
// ones are removed.
export const exportCommit = async (
  run: Run,
  repo: string,
  ref: string,
  short: string,
  keep: string,
): Promise<{ dir: string; refusal: string }> => {
  const exported = await run(['sh', '-c', EXPORT_BASE, 'sh', ref, short, keep], {
    cwd: repo,
    timeoutMs: 120_000,
  })
  const dir = exported.stdout.trim()

  return exported.exitCode !== 0 || dir === ''
    ? { dir: '', refusal: tail(exported.stderr) || 'no export' }
    : { dir, refusal: '' }
}

// A file as a commit left it; empty when the commit deleted it. A stash's
// untracked files live in its third parent, so that is tried next.
export const fileAt = async (
  run: Run,
  repo: string,
  path: string,
  commit: string,
): Promise<string> => {
  const shownAt = async (at: string): Promise<string | undefined> => {
    const shown = await run(['git', 'show', `${at}:./${path}`], { cwd: repo })

    return shown.exitCode === 0 ? shown.stdout : undefined
  }

  return (
    (await shownAt(commit)) ??
    (commit.startsWith('stash@') ? await shownAt(`${commit}^3`) : undefined) ??
    ''
  )
}

// What the diff view interleaves for one file: the lines the other side had
// (`removed`), and, for a file read at a commit, the lines that commit's side
// changed (the working tree's come with `readChanges`).
//
// The working tree's file (`commit` '') and a file read at the comparison's
// own `target` are diffed against the base; at any other commit, against its
// parent.
export const fileDiff = async (
  run: Run,
  repo: string,
  path: string,
  commit: string,
  base: string,
  target: string,
): Promise<{ removed: Record<number, string[]>; changed: LineRange[] | undefined }> => {
  const diff = await run(
    commit === ''
      ? ['git', 'diff', '-U0', '--no-prefix', '--relative', base, '--', path]
      : commit === target
        ? ['git', 'diff', '-U0', '--no-prefix', '--relative', base, commit, '--', path]
        : [
            'git',
            'show',
            '--format=',
            '-U0',
            '--no-prefix',
            '--relative',
            '--diff-merges=first-parent',
            commit,
            '--',
            path,
          ],
    { cwd: repo },
  )

  return {
    removed: parseRemoved(diff.stdout),
    changed: commit === '' ? undefined : (parseChangedLines(diff.stdout)[path] ?? []),
  }
}

// What a commit or a stash (`stash@{0}`) holds: its message and the files it
// changed, with their line counts.
export const commitDetails = async (run: Run, repo: string, hash: string): Promise<Picked> => {
  // A stash keeps its untracked files in a commit of their own, which only
  // `git stash show` knows to include.
  const show = (format: string) =>
    run(
      hash.startsWith('stash@')
        ? ['git', 'stash', 'show', '--include-untracked', '--no-renames', '--relative', format, hash]
        : [
            'git',
            'show',
            '--format=',
            '--no-renames',
            '--relative',
            '--diff-merges=first-parent',
            format,
            hash,
          ],
      { cwd: repo },
    )
  // The graph's row has room for the subject alone; the rest of the message
  // is read here and shown when the commit is opened.
  const [named, counted, message] = await Promise.all([
    show('--name-status'),
    show('--numstat'),
    run(['git', 'log', '-1', '--format=%s%n%b', hash], { cwd: repo }),
  ])
  const [subject = '', ...rest] = message.stdout.split('\n')

  return {
    hash,
    files: parseNameStatus(named.stdout),
    stats: parseNumstat(counted.stdout),
    subject: subject.trim(),
    body: rest.join('\n').trim(),
  }
}

// Who last changed a line: the commit's short hash ('' for a line not
// committed yet), its author, how long ago, and its subject.
export type Blamed = { hash: string; author: string; age: string; summary: string }

// Who last changed each line of a file, as a commit left it or (`commit` '')
// as the working tree has it. A file git has never had committed has no
// history to blame: every line of it is new, which an empty list stands for.
// `now` is asked for the time, in milliseconds, once git has answered.
export const blame = async (
  run: Run,
  repo: string,
  path: string,
  commit: string,
  now: () => Promise<number>,
): Promise<{ lines: Blamed[] } | { refusal: string }> => {
  const ran = await run(
    ['git', 'blame', '--porcelain', ...(commit === '' ? [] : [commit]), '--', path],
    { cwd: repo, timeoutMs: 60_000 },
  )

  if (ran.exitCode !== 0) {
    return /no such path/i.test(ran.stderr) ? { lines: [] } : { refusal: tail(ran.stderr) }
  }

  const seconds = (await now()) / 1000

  return {
    lines: parseBlame(ran.stdout).map(line => ({
      hash: /^0+$/.test(line.hash) ? '' : line.hash.slice(0, 7),
      author: line.author,
      age: ageOf(Math.max(0, seconds - line.time)),
      summary: line.summary,
    })),
  }
}

// The remote branches that already hold the commit checked out: none when it
// has not been pushed.
export const remotesWithHead = async (run: Run, repo: string): Promise<string[]> =>
  (await run(['git', 'branch', '-r', '--contains', 'HEAD'], { cwd: repo })).stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')

// The commands that change the repo answer '' when git did it, and otherwise
// why not, in words fit to show: git's own last ones.
const act = async (run: Run, repo: string, argv: string[]): Promise<string> => {
  const ran = await run(['git', ...argv], { cwd: repo, timeoutMs: 120_000 })

  return ran.exitCode !== 0
    ? `git ${argv[0] ?? ''} did not go through: ${tail(ran.stderr || ran.stdout)}`
    : ''
}

// Commits the given files and nothing else: each is added first, so a new or
// deleted file is taken too, and the commit names them, so anything staged
// beside them stays staged and uncommitted.
export const commit = async (
  run: Run,
  repo: string,
  paths: readonly string[],
  message: string,
  body: string,
): Promise<string> => {
  const added = await run(['git', 'add', '--', ...paths], { cwd: repo })

  if (added.exitCode !== 0) {
    return `git add did not go through: ${tail(added.stderr)}`
  }

  // A second -m is the commit's body, set off from the subject by a blank line.
  return act(run, repo, [
    'commit',
    '-m',
    message.trim(),
    ...(body.trim() === '' ? [] : ['-m', body.trim()]),
    '--',
    ...paths,
  ])
}

// Stashes the given files, the untracked ones among them included.
export const stash = (
  run: Run,
  repo: string,
  paths: readonly string[],
  label: string,
): Promise<string> =>
  act(run, repo, ['stash', 'push', '--include-untracked', '-m', label, '--', ...paths])

// Brings a stash back, keeping it (apply) or removing it (pop).
export const restoreStash = (run: Run, repo: string, ref: string, isPop: boolean): Promise<string> =>
  act(run, repo, ['stash', isPop ? 'pop' : 'apply', ref])

// Takes the last commit back and keeps what it changed, as uncommitted edits.
export const undoLastCommit = (run: Run, repo: string): Promise<string> =>
  act(run, repo, ['reset', '--soft', 'HEAD~1'])

// Throws away the uncommitted changes in the given files, which cannot be
// undone: `tracked` go back to the last commit, `staged` (added but never
// committed) and `untracked` are deleted. It stops at the first step git
// refuses.
export const discard = async (
  run: Run,
  repo: string,
  tracked: readonly string[],
  staged: readonly string[],
  untracked: readonly string[],
): Promise<string> => {
  const steps = [
    tracked.length > 0
      ? ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]
      : undefined,
    staged.length > 0 ? ['rm', '-f', '--quiet', '--', ...staged] : undefined,
    untracked.length > 0 ? ['clean', '-f', '--quiet', '--', ...untracked] : undefined,
  ]
  let refusal = ''

  for (const argv of steps) {
    if (argv === undefined || refusal !== '') {
      continue
    }

    const ran = await run(['git', ...argv], { cwd: repo })

    if (ran.exitCode !== 0) {
      refusal = `git ${argv[0] ?? ''} did not go through: ${tail(ran.stderr || ran.stdout)}`
    }
  }

  return refusal
}

// Switches the repo to a branch, or to a commit with HEAD detached. Never
// forced: where git refuses (local changes it would overwrite), the working
// tree is left as it was and the answer is git's own reason.
export const checkOut = async (
  run: Run,
  repo: string,
  target: string,
  isBranch: boolean,
): Promise<string> => {
  const ran = await run(['git', 'switch', ...(isBranch ? [] : ['--detach']), target], { cwd: repo })

  return ran.exitCode !== 0 ? tail(ran.stderr) || 'git refused' : ''
}
