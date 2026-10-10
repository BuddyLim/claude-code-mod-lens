export type Severity = 'error' | 'warning' | 'info'

export type Diag = {
  path: string
  line: number
  col: number
  // The column the range ends before, on the same line; 0 when unknown.
  endCol: number
  severity: Severity
  tool: string
  rule: string
  message: string
  // Whether the change brought it: true when the base's version of the file
  // had no such diagnostic, false when it did; absent where the base was not
  // checked (a file the change does not touch).
  isNew?: boolean
  // Whether it marks code that is never used (an unread import or variable),
  // which an editor fades instead of underlining.
  isUnused?: boolean
}

export type ChangedFile = { path: string; status: string }

// A name looked up in a file: where it was asked about (`at`, `col`), what the
// language server said (`text`, and `signature` for the call it sits in),
// where it is defined and where its type is (`path`/`typePath` '' when the
// server could not say; a path outside the folder under review is absolute),
// and whether anything implements it.
export type Lookup = {
  file: string
  name: string
  at: number
  col: number
  text: string
  path: string
  line: number
  typePath: string
  typeLine: number
  hasImplementations: boolean
  signature: string
}

// The breadcrumb's open list: a folder's entries (`dir`, '' for the folder
// under review itself) or the names at a level of the file's outline
// (`level`, 0 the top). `left` is the column it opens under; `top` the first
// entry it shows, or -1 to open on the entry the file is at.
export type Crumb = {
  kind: 'none' | 'dir' | 'symbol'
  dir: string
  level: number
  left: number
  top: number
}

// The list screen: places to jump to (uses of a name, callers, an outline,
// search results). A row with no path is a heading. `prompt` is the list as
// text for the prompt, '' when there is no such form.
// A row that names something (an outline entry, a search hit) also has a
// mark for its kind, drawn in that kind's colour, and a `tail` drawn dim
// after the name.
export type ListRow = {
  label: string
  path: string
  line: number
  mark?: string
  color?: string
  tail?: string
}
// `commit` is the commit the rows' files are opened at, when it is not the
// working tree's: a request's review threads sit on its head.
export type Listing = { title: string; rows: ListRow[]; prompt: string; commit?: string }

export type LineRange = [from: number, to: number]

export type View = {
  repo: string
  base: string
  // `requests` lists the repo's open pull or merge requests; `changes` is the
  // whole comparison on one page.
  screen: 'tree' | 'file' | 'graph' | 'list' | 'requests' | 'changes' | 'overview'
  file: string
  // The first line the file screen's window shows, 1-based.
  top: number
  cursor: number
  isExpanded: boolean
  layout: 'tree' | 'list'
  // Folders whose open or closed state the person flipped from its default.
  toggled: string[]
  // The commit whose actions the graph screen shows; '' for none.
  selected: string
  // Whether the file screen interleaves what the base had (a diff) or shows
  // the file as it is.
  isDiff: boolean
  // Whether the diff is cut down to what differs: each change and each
  // commented line, with a few lines around it.
  isChanges: boolean
  // The commit the file screen shows the file at; '' for the working tree.
  commit: string
  // The uncommitted and untracked files ticked for a commit or a stash.
  checked: string[]
  // The screen a commit's or stash's file was opened from, where back returns.
  origin: 'tree' | 'graph' | 'changes'
  // The files of each request ticked as reviewed, by the folder under review
  // and what the request is typed as ("/repo\n#12"): kept between sessions.
  reviewed: Record<string, string[]>
  // The comments written for each request's review and not sent yet, by the
  // same name as `reviewed`: they go to the forge with the verdict. `line`
  // is 0 for a file as a whole; `startLine` makes it a comment on several.
  drafts: Record<string, { id: string; path: string; line: number; startLine?: number; body: string }[]>
  // The first row the page of every change shows in its window, 0-based;
  // how many unchanged lines it shows round each change; and whether lines
  // that differ only in their spaces are left out of it.
  pageTop: number
  pageContext: number
  pageSpace: boolean
  // How many times the hooks module has asked for the pane to be drawn again
  // because something it holds outside the state changed.
  redraws: number
  // The first line the picked commit's body box shows, 0-based.
  bodyTop: number
  // The first line the graph screen's window shows, 0-based.
  graphTop: number
  // The commit compared against the base in place of the working tree; ''
  // while it is the working tree that is compared.
  target: string
  // The worktree whose files, as they stand, the working tree is compared
  // with ('' for none): `base` is then a snapshot of them, taken again with
  // every scan.
  baseWorktree: string
  // The pull or merge request the target is the head of, as a label for the
  // header ("PR #12 → main · its title"); '' when the target is not one.
  request: string
  // What was typed to open that request ("#12", its link), by which the
  // forge is asked for its comments; whether a line number now picks a line
  // to comment on; and the line picked (0 for none yet).
  requestTyped: string
  isCommenting: boolean
  commentLine: number
  // The first line of the comment being typed when it is on several lines
  // (`commentLine` is then the last); 0 when it is on one.
  commentFrom: number
  // A working-tree file whose diff is read against a commit other than
  // `base`: a file of the checked-out branch's request, against where the
  // request forked from its target. `path` '' is none.
  diffBase: { path: string; base: string; name: string }
  // Whether threads that are resolved are left out of the file screen, and
  // whether the file tree's box for submitting a review is open.
  hidesResolved: boolean
  isReviewing: boolean
  // The conversation in the file tree: the comment opened in full ('' for
  // none), and what is being typed ('' nothing, 'new' a comment of its own,
  // else the id of the comment an answer quotes).
  talkOpen: string
  talkReply: string
  // The first comment of the thread being answered, by its id; '' while the
  // comment being typed starts a thread of its own.
  replyTo: string
  // Whether a markdown file is drawn rendered (the default) or as its source.
  isPreview: boolean
  // The file screen's search: whether its field shows, what is typed in it,
  // and which of the matches the person is on.
  isFinding: boolean
  find: string
  findAt: number
  // Whether the commit box is asking to confirm a discard.
  isDiscarding: boolean
  // Whether the list of keys is showing in place of the screen.
  isHelp: boolean
  // The name last looked up in a file: what the language server said of it,
  // and where it is defined (`path` '' when the server could not say; a path
  // outside the folder under review is absolute). `file` '' is none.
  symbol: Lookup
  // Whether the file screen draws the server's inlay hints inside the code.
  isHinting: boolean
  // The screen the list screen was opened from, where its back returns.
  listBack: 'tree' | 'file'
  // Whether the box of less-used keys is open under the main row of buttons.
  isMore: boolean
  // The breadcrumb part whose list is open.
  crumb: Crumb
  // Whether the graph is asking to confirm undoing the last commit, and what
  // it found out about that commit being pushed.
  isUndoing: boolean
  undoNote: string
  // Whether the file screen shows who last changed each line.
  isBlame: boolean
  // The file the graph was opened from by pressing a line's blame, the commit
  // it was shown at, and its first line then: where the graph's back button
  // returns to. `backFile` is '' when the graph was opened from the file tree.
  backFile: string
  backCommit: string
  backTop: number
  // Whether the file tree also lists every tracked file, and the unchanged
  // files opened from that list, which are checked along with the changed.
  isBrowsing: boolean
  extra: string[]
  // Whether Claude is told, after its own edits, what new problems they brought.
  isTelling: boolean
  // The graph's compare panel: whether it is open, what each of its two
  // fields holds, and which field the suggestions are for.
  isPicking: boolean
  pickA: string
  pickB: string
  pickField: 'a' | 'b'
}

// The commit picked on the graph screen and the files it changed.
export type Picked = {
  hash: string
  files: ChangedFile[]
  stats: Record<string, LineStat>
  // The commit message: its first line, and what follows it ('' for none).
  subject: string
  body: string
}

export type Scan = {
  status: 'idle' | 'running' | 'done'
  files: ChangedFile[]
  diags: Diag[]
  changed: Record<string, LineRange[]>
  notes: string[]
  isProjectChecked: boolean
  // Lines added and deleted per changed file, against the base.
  stats: Record<string, LineStat>
  // The graph's rows live in the module; `graph` stays empty and the count
  // changing is what redraws the graph.
  graph: GraphRow[]
  graphCount: number
  // The repo's local branches: the refs a press may check out by name.
  branches: string[]
  // The branch checked out ("HEAD" when detached) and its commit's short hash.
  head: string
  headHash: string
  // The tracked files edited since the last commit, whatever the base is.
  dirty: string[]
  // `git stash list`: each stash's name (stash@{0}) and what it says it holds.
  // `base` is the short hash of the commit it was made on, `when` how long ago.
  stashes: { ref: string; subject: string; base: string; when: string }[]
  // The repo's worktrees (`git worktree list`): the folder each is reviewed
  // at, the branch it has checked out ('' when detached), and whether it is
  // the one under review.
  worktrees: Worktree[]
  // The tools a scan under way is still waiting on, by name and project.
  pending: string[]
  // Hints that code is never used: they fade that code, and are not counted
  // or listed among the problems.
  faded: Diag[]
  // How many of the files a scan has to check it has checked: they go a
  // batch at a time, the file the person has open first.
  checked: number
  toCheck: number
  // Whether the folder is in no git repository: its files are listed as they
  // stand, and nothing is compared.
  isPlain: boolean
}

export type LineStat = [added: number, deleted: number]

// `head` is the full hash of the commit it has checked out.
export type Worktree = { path: string; branch: string; head: string; isCurrent: boolean }

// A repo reviewed before, as the store keeps it between sessions: where it
// is, what was being compared (`requestTyped` when that was a pull or merge
// request, which is fetched again), how the file tree was laid out, and when.
export type Recent = {
  repo: string
  base: string
  target: string
  request: string
  requestTyped: string
  layout: 'tree' | 'list'
  isBrowsing: boolean
  at: number
  // The repo it is a worktree of (its own path when it is the main one):
  // what the list groups by. '' where that was never asked.
  home: string
}

export type Commit = {
  hash: string
  parents: string[]
  refs: string[]
  subject: string
  when: string
  author: string
}

// One commit as the graph draws it: its row of lane cells as coloured spans
// (two characters per lane), and the lane the commit's own dot sits in.
export type GraphRow = Commit & {
  cells: Span[]
  // The row under the commit: a line down each lane still open after it.
  below: Span[]
  width: number
  lane: number
}

export type Span = [color: string, text: string]

// Which file the module holds coloured lines for. The lines themselves stay
// in the module (a whole file is too much to keep as state); `stamp` changes
// when they are loaded again, which redraws the readers.
export type Source = {
  path: string
  lineCount: number
  note: string
  stamp: number
}

declare module 'claude-code' {
  interface PluginState {
    'lens': {
      recents: Recent[]
      view: View
      scan: Scan
      source: Source
      picked: Picked
      spin: number
      listing: Listing
    }
  }
}
