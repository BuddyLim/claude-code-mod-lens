// Pull request / merge request lookup: turns what the user typed into two refs that exist locally.
// Handle-free on purpose: every command goes through the `run` the caller passes in.

export type Run = (
  argv: string[],
  timeoutMs?: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Forge = 'github' | 'gitlab' | 'unknown'

export type Request = {
  host: Forge
  number: number
  // "owner/repo" (or "group/sub/repo") when the text was a URL, so a link to another repo can be refused.
  repo?: string
}

export type Resolved = {
  side: string // the private ref holding the request's head, e.g. refs/lens/pr-12
  against: string // commit hash the head is compared with: where the branch forked from its target
  title: string // the request's title, or a note that the target was guessed
  label: string // "PR #12" or "MR !34"
  target: string // the target branch name, e.g. "main"
  isTargetGuessed: boolean // true when the forge CLI could not be asked
}

const FETCH_MS = 120_000
const CLI_MS = 30_000
const LOCAL_MS = 10_000

const REF_ROOT = 'refs/lens'

const asNumber = (digits: string | undefined): number | undefined => {
  const value = Number(digits)

  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const trimRepo = (path: string): string => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')

export const parseRequest = (text: string): Request | undefined => {
  const typed = text.trim()

  const mergeRequest = /^(?:https?:\/\/)?[^/\s]+\/(\S+?)\/(?:-\/)?merge_requests\/(\d+)(?:[/?#]\S*)?$/i.exec(typed)
  const pull = /^(?:https?:\/\/)?[^/\s]+\/(\S+?)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(typed)
  const linked = mergeRequest ?? pull

  if (linked) {
    const number = asNumber(linked[2])

    return number === undefined
      ? undefined
      : { host: mergeRequest ? 'gitlab' : 'github', number, repo: trimRepo(linked[1] ?? '') }
  }

  const short = /^(pr|pull|mr)?\s*([#!])?\s*(\d+)$/i.exec(typed)

  if (!short) {
    return undefined
  }

  const number = asNumber(short[3])
  const word = short[1]?.toLowerCase()

  if (number === undefined) {
    return undefined
  }

  if (word !== undefined) {
    return { host: word === 'mr' ? 'gitlab' : 'github', number }
  }

  // "!34" is GitLab's own notation. "#12" is used loosely for both, so it is not a hint.
  return { host: short[2] === '!' ? 'gitlab' : 'unknown', number }
}

// Host and "owner/repo" path of a git remote URL, in its https, ssh:// or scp-like (git@host:path) form.
export const remoteParts = (remoteUrl: string): { host: string; repo: string } | undefined => {
  const url = remoteUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(\S+)$/i.exec(url)
  const scpLike = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(\S+)$/.exec(url)
  const found = withScheme ?? scpLike

  if (!found) {
    return undefined
  }

  return { host: (found[1] ?? '').toLowerCase(), repo: trimRepo(found[2] ?? '') }
}

export const forgeOf = (remoteUrl: string): Forge => {
  const host = remoteParts(remoteUrl)?.host ?? ''

  if (host.includes('github')) {
    return 'github'
  }

  return host.includes('gitlab') ? 'gitlab' : 'unknown'
}

const lastLine = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .at(-1) ?? ''

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

type Viewed = { title: string; target: string; forkPoint: string } | { why: string }

// Why the forge CLI gave nothing, in words that fit after "target guessed as main: ".
const whyNot = (cli: string, ran: { exitCode: number; stderr: string }): string => {
  if (/timed? ?out/i.test(ran.stderr)) {
    return `${cli} did not answer`
  }

  if (
    ran.exitCode === -1 ||
    ran.exitCode === 127 ||
    /ENOENT|command not found|no such file|not found in \$?PATH/i.test(ran.stderr)
  ) {
    return `${cli} is not installed`
  }

  if (/auth login|logged in|authenticat|unauthorized|401|token/i.test(ran.stderr)) {
    return `${cli} is not signed in, run ${cli} auth login`
  }

  return `${cli} could not read it`
}

const view = async (run: Run, forge: 'github' | 'gitlab', number: number, slug: string | undefined): Promise<Viewed> => {
  const cli = forge === 'github' ? 'gh' : 'glab'

  // gh is pointed at origin explicitly: on its own it may pick another remote (a fork's upstream).
  const argv =
    forge === 'github'
      ? [
          'gh',
          'pr',
          'view',
          String(number),
          ...(slug === undefined ? [] : ['--repo', slug]),
          '--json',
          'number,title,baseRefName,headRefName,baseRefOid',
        ]
      : ['glab', 'mr', 'view', String(number), '--output', 'json']

  const ran = await run(argv, CLI_MS).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

  if (ran.exitCode !== 0) {
    return { why: whyNot(cli, ran) }
  }

  try {
    const parsed = JSON.parse(ran.stdout) as Record<string, unknown>
    const refs = (parsed.diff_refs ?? {}) as Record<string, unknown>
    const target = text(forge === 'github' ? parsed.baseRefName : parsed.target_branch)

    if (target === '') {
      return { why: `${cli} did not name a target branch` }
    }

    return {
      title: text(parsed.title),
      target,
      forkPoint: text(forge === 'github' ? parsed.baseRefOid : refs.base_sha),
    }
  } catch {
    return { why: `${cli} gave an answer that could not be read` }
  }
}

export const resolveRequest = async (run: Run, typed: string): Promise<Resolved | { error: string }> => {
  const request = parseRequest(typed)

  if (!request) {
    return { error: `"${typed.trim()}" is not a PR or MR: type a number like 12, or paste its URL` }
  }

  const remote = await run(['git', 'remote', 'get-url', 'origin'], LOCAL_MS)

  if (remote.exitCode !== 0 || remote.stdout.trim() === '') {
    return { error: 'This repo has no remote named origin to fetch a PR or MR from' }
  }

  const origin = remoteParts(remote.stdout)
  const known = forgeOf(remote.stdout)
  const forge = known === 'unknown' ? request.host : known

  if (forge === 'unknown') {
    return {
      error: `This repo's origin is not GitHub or GitLab; type "pr ${request.number}" or "mr ${request.number}" to say which it is`,
    }
  }

  const label = forge === 'github' ? `PR #${request.number}` : `MR !${request.number}`

  if (request.repo !== undefined && origin && request.repo.toLowerCase() !== origin.repo.toLowerCase()) {
    return { error: `That link is for ${request.repo}, but this repo's origin is ${origin.repo}; open that repo instead` }
  }

  const side = `${REF_ROOT}/${forge === 'github' ? 'pr' : 'mr'}-${request.number}`
  const tip = `${side}-base`
  const remoteHead = `refs/${forge === 'github' ? 'pull' : 'merge-requests'}/${request.number}/head`

  // The leading + lets a later fetch move the private ref after a force-push. No local branch is touched.
  const [fetched, viewed] = await Promise.all([
    run(['git', 'fetch', '--no-tags', 'origin', `+${remoteHead}:${side}`], FETCH_MS),
    view(run, forge, request.number, origin ? `${origin.host}/${origin.repo}` : undefined),
  ])

  if (fetched.exitCode !== 0) {
    return {
      error: /couldn't find remote ref/i.test(fetched.stderr)
        ? `${label} was not found on origin`
        : `${label} could not be fetched from origin: ${lastLine(fetched.stderr) || 'git fetch failed'}`,
    }
  }

  const fetchTarget = async (branch: string) =>
    run(['git', 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${tip}`], FETCH_MS)

  let target = ''

  if ('why' in viewed) {
    const pointed = await run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], LOCAL_MS)
    const named = pointed.exitCode === 0 ? pointed.stdout.trim().replace(/^origin\//, '') : ''

    for (const branch of [...new Set([named, 'main', 'master'])].filter(one => one !== '')) {
      if ((await fetchTarget(branch)).exitCode === 0) {
        target = branch
        break
      }
    }

    if (target === '') {
      return { error: `No target branch for ${label} could be found on origin (${viewed.why})` }
    }
  } else {
    const got = await fetchTarget(viewed.target)

    if (got.exitCode !== 0) {
      return {
        error: `The target branch ${viewed.target} of ${label} could not be fetched from origin: ${lastLine(got.stderr) || 'git fetch failed'}`,
      }
    }

    target = viewed.target
  }

  // The forge records the target's commit the request is measured from. Once a request is merged, its
  // head is inside the target, so the target's tip alone would give an empty comparison.
  const forkPoint = 'why' in viewed ? '' : viewed.forkPoint
  const hasForkPoint =
    forkPoint !== '' && (await run(['git', 'cat-file', '-e', `${forkPoint}^{commit}`], LOCAL_MS)).exitCode === 0

  const merged = await run(['git', 'merge-base', side, hasForkPoint ? forkPoint : tip], LOCAL_MS)
  const against = merged.stdout.trim()

  if (merged.exitCode !== 0 || against === '') {
    return {
      error: `${label} and ${target} share no history here; if this is a shallow clone, run git fetch --unshallow`,
    }
  }

  const head = await run(['git', 'rev-parse', side], LOCAL_MS)
  const isEmpty = head.stdout.trim() === against

  const notes = [
    ...('why' in viewed ? [`target guessed as ${target}: ${viewed.why}`] : []),
    ...(isEmpty ? [`already merged into ${target}, nothing left to compare`] : []),
  ]

  const name = 'why' in viewed ? '' : viewed.title

  return {
    side,
    against,
    title: [name, notes.length > 0 ? `(${notes.join('; ')})` : ''].filter(part => part !== '').join(' ') || label,
    label,
    target,
    isTargetGuessed: 'why' in viewed,
  }
}

// ---------------------------------------------------------------------------------------------
// Review comments: reading every comment on a request, and posting one on a line.
// ---------------------------------------------------------------------------------------------

export type Comment = {
  // Line comments carry the forge's own number ("4109147516"). On GitHub the general ones are
  // prefixed ("issue-5917169258", "review-5393240365"), because the three kinds are numbered apart.
  id: string
  // Where it is attached: a path relative to the REPO ROOT and a 1-based line in the request's
  // head version of the file. `line` is 0 for a comment on the file as a whole, one on a removed
  // line (see oldLine), or one whose line no longer exists (outdated). `path` is '' for a general
  // comment on the request.
  path: string
  line: number
  author: string
  body: string
  when: string // ISO time as the forge gives it
  replyTo?: string // the id of the comment it answers: always the first comment of its thread
  isResolved?: boolean // where the forge says
  isOutdated?: boolean // attached to a version of the file that has since changed
  oldLine?: number // for a comment on a removed line: its line in the target's version of the file
  // What the forge calls the thread it is in, by which the thread is resolved (and, on GitLab,
  // replied to): GitHub's node id of the review thread, GitLab's discussion id. Absent where the
  // forge did not say, and on general comments.
  thread?: string
}

type Json = Record<string, unknown>

type Place = {
  forge: 'github' | 'gitlab'
  cli: 'gh' | 'glab'
  number: number
  host: string
  repo: string // "owner/repo", or "group/sub/repo"
  label: string // "PR #12" or "MR !34"
  noun: string // "pull request" or "merge request"
}

const COMMENTS_MS = 60_000

const record = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})

const whole = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)

const named = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

// Every JSON value in a CLI's output, with arrays flattened: a paginated call may print one merged
// array, or one value per page back to back.
const values = (stdout: string): unknown[] => {
  const found: unknown[] = []
  const take = (slice: string) => {
    const parsed: unknown = JSON.parse(slice)

    found.push(...(Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]))
  }

  try {
    take(stdout)

    return found
  } catch {
    found.length = 0
  }

  let depth = 0
  let start = -1
  let isInString = false
  let isEscaped = false

  for (let at = 0; at < stdout.length; at++) {
    const char = stdout[at]

    if (isInString) {
      if (isEscaped) {
        isEscaped = false
      } else if (char === '\\') {
        isEscaped = true
      } else if (char === '"') {
        isInString = false
      }
    } else if (char === '"') {
      isInString = true
    } else if (char === '{' || char === '[') {
      if (depth === 0) {
        start = at
      }

      depth++
    } else if (char === '}' || char === ']') {
      depth--

      if (depth === 0 && start >= 0) {
        take(stdout.slice(start, at + 1))
        start = -1
      }
    }
  }

  if (depth !== 0) {
    throw new Error('cut short')
  }

  return found
}

const call = async (run: Run, argv: string[], timeoutMs = COMMENTS_MS) =>
  run(argv, timeoutMs).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

// What the forge itself said went wrong: the "message" of its JSON answer, else the CLI's last line.
const forgeSaid = (ran: { stdout: string; stderr: string }): string => {
  try {
    const answer = record(JSON.parse(ran.stdout))
    const said = answer.message ?? answer.error

    return [
      typeof said === 'string' ? said : said === undefined ? '' : JSON.stringify(said),
      answer.errors === undefined ? '' : JSON.stringify(answer.errors),
    ].join(' ')
  } catch {
    return lastLine(ran.stderr)
  }
}

// One sentence for a forge call that failed. `doing` is "read" or "comment on".
const whyFailed = (
  place: Place,
  ran: { exitCode: number; stdout: string; stderr: string },
  doing: 'read' | 'comment on',
  at?: { path: string; line: number },
): string => {
  const { cli, label, noun } = place
  const all = `${ran.stderr}\n${ran.stdout}`
  const status = /HTTP (\d{3})/.exec(ran.stderr)?.[1] ?? ''

  if (status === '') {
    if (/timed? ?out/i.test(ran.stderr)) {
      return `${cli} did not answer`
    }

    if (
      ran.exitCode === -1 ||
      ran.exitCode === 127 ||
      /ENOENT|command not found|no such file|not found in \$?PATH/i.test(ran.stderr)
    ) {
      return `${cli} is not installed`
    }
  }

  if (status === '401' || (status === '' && /auth login|not logged in|authenticat|unauthorized|bad credentials/i.test(all))) {
    return `${cli} is not signed in: run ${cli} auth login`
  }

  if (/rate limit/i.test(all) || status === '429') {
    return `${place.forge === 'github' ? 'GitHub' : 'GitLab'} is refusing more calls for now (rate limit): try again in a few minutes`
  }

  if (status === '403') {
    return `You do not have permission to ${doing} this ${noun}`
  }

  if (status === '404' || /could not resolve to a/i.test(all)) {
    return `${label} was not found in ${place.repo}, or you may not see it`
  }

  if (at && (status === '422' || status === '400')) {
    if (/commit_id|head_sha|base_sha|start_sha/i.test(all)) {
      return `This ${noun} has changed since it was opened here: reopen it, then comment again`
    }

    if (/line|diff_hunk|position|path/i.test(all)) {
      return `Line ${at.line} of ${at.path} is not part of this ${noun}'s diff`
    }
  }

  const said = forgeSaid(ran).replace(/\s+/g, ' ').trim().slice(0, 160)

  return doing === 'read'
    ? `The comments of ${label} could not be read: ${said || `${cli} failed`}`
    : `The comment could not be posted on ${label}: ${said || `${cli} failed`}`
}

// Which request `typed` names, on which forge and repo: the same reading of it as resolveRequest.
const locate = async (run: Run, typed: string): Promise<Place | { error: string }> => {
  const request = parseRequest(typed)

  if (!request) {
    return { error: `"${typed.trim()}" is not a PR or MR: type a number like 12, or paste its URL` }
  }

  const remote = await call(run, ['git', 'remote', 'get-url', 'origin'], LOCAL_MS)
  const origin = remote.exitCode === 0 ? remoteParts(remote.stdout) : undefined

  if (!origin || origin.repo === '') {
    return { error: 'This repo has no remote named origin to read a PR or MR from' }
  }

  const known = forgeOf(remote.stdout)
  const forge = known === 'unknown' ? request.host : known

  if (forge === 'unknown') {
    return {
      error: `This repo's origin is not GitHub or GitLab; type "pr ${request.number}" or "mr ${request.number}" to say which it is`,
    }
  }

  if (request.repo !== undefined && request.repo.toLowerCase() !== origin.repo.toLowerCase()) {
    return { error: `That link is for ${request.repo}, but this repo's origin is ${origin.repo}; open that repo instead` }
  }

  return {
    forge,
    cli: forge === 'github' ? 'gh' : 'glab',
    number: request.number,
    host: origin.host,
    repo: origin.repo,
    label: forge === 'github' ? `PR #${request.number}` : `MR !${request.number}`,
    noun: forge === 'github' ? 'pull request' : 'merge request',
  }
}

const byTime = (comments: Comment[]): Comment[] =>
  comments
    .map((comment, index) => ({ comment, index }))
    .sort((one, other) =>
      one.comment.when === other.comment.when
        ? one.index - other.index
        : one.comment.when < other.comment.when
          ? -1
          : 1,
    )
    .map(({ comment }) => comment)

// ---- GitHub ----

type ThreadState = { isResolved: boolean; isOutdated: boolean; id: string }

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}' +
  'nodes{id isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}'

const gh = (place: Place, ...rest: string[]): string[] => ['gh', 'api', '--hostname', place.host, ...rest]

// One review comment as GitHub's REST API gives it. `threads` is keyed by the id of a thread's first comment.
const fromGithubLine = (raw: unknown, threads: Map<string, ThreadState>): Comment => {
  const one = record(raw)
  const id = named(one.id)
  const replyTo = named(one.in_reply_to_id)
  const thread = threads.get(replyTo || id)
  const isOnFile = one.subject_type === 'file'
  const line = whole(one.line)
  // A comment whose line has since changed keeps only its original_line: `line` comes back null.
  const isOutdated = !isOnFile && line === 0
  const isOnOld = one.side === 'LEFT'

  return {
    id,
    path: text(one.path),
    line: isOnOld ? 0 : line,
    author: text(record(one.user).login) || 'ghost',
    body: typeof one.body === 'string' ? one.body : '',
    when: text(one.created_at),
    ...(replyTo === '' ? {} : { replyTo }),
    ...(thread ? { isResolved: thread.isResolved } : {}),
    ...(thread && thread.id !== '' ? { thread: thread.id } : {}),
    isOutdated,
    ...(isOnOld && line > 0 ? { oldLine: line } : {}),
  }
}

const fromGithubGeneral = (raw: unknown, kind: 'issue' | 'review'): Comment => {
  const one = record(raw)

  return {
    id: `${kind}-${named(one.id)}`,
    path: '',
    line: 0,
    author: text(record(one.user).login) || 'ghost',
    body: typeof one.body === 'string' ? one.body : '',
    when: text(kind === 'issue' ? one.created_at : one.submitted_at),
  }
}

const githubComments = async (run: Run, place: Place): Promise<{ comments: Comment[] } | { error: string }> => {
  const [owner = '', name = ''] = place.repo.split('/')
  const base = `repos/${place.repo}`

  const [lines, talk, reviews, threadPages] = await Promise.all([
    call(run, gh(place, `${base}/pulls/${place.number}/comments?per_page=100`, '--paginate')),
    call(run, gh(place, `${base}/issues/${place.number}/comments?per_page=100`, '--paginate')),
    call(run, gh(place, `${base}/pulls/${place.number}/reviews?per_page=100`, '--paginate')),
    call(
      run,
      gh(
        place,
        'graphql',
        '--paginate',
        '-f',
        `query=${THREADS_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${place.number}`,
      ),
    ),
  ])

  for (const ran of [lines, talk, reviews]) {
    if (ran.exitCode !== 0) {
      return { error: whyFailed(place, ran, 'read') }
    }
  }

  // Resolved state only exists on threads, which only GraphQL lists. Without it the comments
  // are still worth showing, so a failure here is not an error: isResolved is just left out.
  const threads = new Map<string, ThreadState>()

  if (threadPages.exitCode === 0) {
    try {
      for (const page of values(threadPages.stdout)) {
        const listed = record(record(record(record(record(page).data).repository).pullRequest).reviewThreads).nodes

        for (const node of Array.isArray(listed) ? (listed as unknown[]) : []) {
          const thread = record(node)
          const first = (record(thread.comments).nodes as unknown[] | undefined)?.[0]
          const id = named(record(first).databaseId)

          if (id !== '') {
            threads.set(id, {
              isResolved: thread.isResolved === true,
              isOutdated: thread.isOutdated === true,
              id: named(thread.id),
            })
          }
        }
      }
    } catch {
      threads.clear()
    }
  }

  try {
    return {
      comments: byTime([
        ...values(lines.stdout).map(raw => fromGithubLine(raw, threads)),
        ...values(talk.stdout).map(raw => fromGithubGeneral(raw, 'issue')),
        // A review is listed even when it only carried line comments: then its own body is empty.
        ...values(reviews.stdout)
          .map(raw => fromGithubGeneral(raw, 'review'))
          .filter(comment => comment.body.trim() !== '' && comment.when !== ''),
      ]),
    }
  } catch {
    return { error: `The comments of ${place.label} could not be read: gh gave an answer that could not be read` }
  }
}

// ---- GitLab ----

const glab = (place: Place, ...rest: string[]): string[] => ['glab', 'api', '--hostname', place.host, ...rest]

// "group/sub/app" goes in as one encoded path segment, which is how GitLab takes a project by its path.
const gitlabRequest = (place: Place): string =>
  `projects/${encodeURIComponent(place.repo)}/merge_requests/${place.number}`

// One note of a discussion. `headSha` is the request's current head, '' when it is not known.
const fromGitlabNote = (raw: unknown, rootId: string, headSha: string, thread = ''): Comment => {
  const one = record(raw)
  const id = named(one.id)
  const hasPlace = typeof one.position === 'object' && one.position !== null
  const position = record(one.position)
  const madeOn = text(position.head_sha)
  // GitLab moves a note's position along with new commits while its line survives, so a position
  // still naming an older head is one whose line has changed since.
  const isOutdated = hasPlace && headSha !== '' && madeOn !== '' ? madeOn !== headSha : undefined
  const isOnFile = position.position_type !== undefined && position.position_type !== 'text'
  const newLine = whole(position.new_line)
  const oldLine = whole(position.old_line)

  return {
    id,
    path: hasPlace ? text(position.new_path) || text(position.old_path) : '',
    line: isOutdated === true || isOnFile ? 0 : newLine,
    author: text(record(one.author).username) || text(record(one.author).name) || 'ghost',
    body: typeof one.body === 'string' ? one.body : '',
    when: text(one.created_at),
    ...(rootId === id ? {} : { replyTo: rootId }),
    ...(one.resolvable === true ? { isResolved: one.resolved === true } : {}),
    ...(isOutdated === undefined ? {} : { isOutdated }),
    ...(hasPlace && !isOnFile && newLine === 0 && oldLine > 0 ? { oldLine } : {}),
    // Only a thread that can be resolved is kept by its discussion: a general note has none.
    ...(thread === '' || one.resolvable !== true ? {} : { thread }),
  }
}

const fromGitlabDiscussion = (raw: unknown, headSha: string): Comment[] => {
  const listed = record(raw).notes
  const notes = (Array.isArray(listed) ? (listed as unknown[]) : []).filter(note => record(note).system !== true)
  const rootId = named(record(notes[0]).id)

  const thread = named(record(raw).id)

  return notes.map(note => fromGitlabNote(note, rootId, headSha, thread))
}

const gitlabComments = async (run: Run, place: Place): Promise<{ comments: Comment[] } | { error: string }> => {
  const [discussions, request] = await Promise.all([
    call(run, glab(place, `${gitlabRequest(place)}/discussions?per_page=100`, '--paginate')),
    call(run, glab(place, gitlabRequest(place))),
  ])

  if (discussions.exitCode !== 0) {
    return { error: whyFailed(place, discussions, 'read') }
  }

  let headSha = ''

  try {
    headSha = request.exitCode === 0 ? text(record(record(JSON.parse(request.stdout)).diff_refs).head_sha) : ''
  } catch {
    headSha = ''
  }

  try {
    return { comments: byTime(values(discussions.stdout).flatMap(raw => fromGitlabDiscussion(raw, headSha))) }
  } catch {
    return { error: `The comments of ${place.label} could not be read: glab gave an answer that could not be read` }
  }
}

// Where a line of the head version sits in the base version, read from `git diff -U0` output:
// `added` when the line is new, else the line it was. GitLab wants both lines for an unchanged one.
const oldLineOf = (diff: string, line: number): { isAdded: true } | { isAdded: false; oldLine: number } => {
  let shift = 0

  for (const hunk of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const removed = hunk[2] === undefined ? 1 : Number(hunk[2])
    const start = Number(hunk[3])
    const added = hunk[4] === undefined ? 1 : Number(hunk[4])

    if (added > 0 && line >= start && line < start + added) {
      return { isAdded: true }
    }

    // With nothing added, `start` is the line the removal follows.
    if (added > 0 ? start + added - 1 < line : start < line) {
      shift += added - removed
    }
  }

  return { isAdded: false, oldLine: line - shift }
}

const gitlabPost = async (
  run: Run,
  place: Place,
  at: { path: string; line: number; commit: string },
  body: string,
): Promise<{ comment: Comment } | { error: string }> => {
  const request = await call(run, glab(place, gitlabRequest(place)))

  if (request.exitCode !== 0) {
    return { error: whyFailed(place, request, 'comment on') }
  }

  let refs: Json = {}

  try {
    refs = record(record(JSON.parse(request.stdout)).diff_refs)
  } catch {
    refs = {}
  }

  const baseSha = text(refs.base_sha)
  const startSha = text(refs.start_sha)
  const headSha = text(refs.head_sha)

  if (baseSha === '' || startSha === '' || headSha === '') {
    return { error: `The comment could not be posted on ${place.label}: glab did not say which commits it compares` }
  }

  if (headSha !== at.commit) {
    return { error: 'This merge request has changed since it was opened here: reopen it, then comment again' }
  }

  // GitLab places a note by old and new line together. Git knows both when the commits are here;
  // when they are not, the new line alone is sent, which GitLab accepts for added lines.
  const outside = { error: `Line ${at.line} of ${at.path} is not part of this merge request's diff` }
  let oldPath = at.path
  let oldLine = 0

  const changed = await call(run, ['git', 'diff', '--name-status', '-M', '-z', baseSha, headSha, '--'], LOCAL_MS)

  if (changed.exitCode === 0) {
    const fields = changed.stdout.split('\0')
    let status = ''

    for (let index = 0; index < fields.length - 1; ) {
      const kind = fields[index] ?? ''
      const isMoved = /^[RC]/.test(kind)
      const from = fields[index + 1] ?? ''
      const to = isMoved ? (fields[index + 2] ?? '') : from

      if (to === at.path) {
        status = kind
        oldPath = from
      }

      index += isMoved ? 3 : 2
    }

    if (status === '' || status.startsWith('D')) {
      return outside
    }

    if (!status.startsWith('A')) {
      const diff = await call(
        run,
        ['git', 'diff', '--no-color', '--no-ext-diff', '-U0', '-M', baseSha, headSha, '--', ...new Set([oldPath, at.path])],
        LOCAL_MS,
      )
      const where = diff.exitCode === 0 ? oldLineOf(diff.stdout, at.line) : { isAdded: true as const }

      oldLine = where.isAdded ? 0 : where.oldLine
    }
  }

  // glab sends fields as a JSON body, where a name like position[new_line] would be one literal key
  // that GitLab ignores; -F parses a JSON object, so the position travels as one.
  const position = {
    position_type: 'text',
    base_sha: baseSha,
    start_sha: startSha,
    head_sha: headSha,
    old_path: oldPath,
    new_path: at.path,
    new_line: at.line,
    ...(oldLine > 0 ? { old_line: oldLine } : {}),
  }

  const posted = await call(
    run,
    glab(
      place,
      '-X',
      'POST',
      `${gitlabRequest(place)}/discussions`,
      '-f',
      `body=${body}`,
      '-F',
      `position=${JSON.stringify(position)}`,
    ),
  )

  if (posted.exitCode !== 0) {
    return { error: whyFailed(place, posted, 'comment on', at) }
  }

  try {
    const comment = fromGitlabDiscussion(JSON.parse(posted.stdout), headSha)[0]

    if (!comment) {
      throw new Error('no note')
    }

    // An older glab that does not send the position would post a general comment instead.
    return comment.path === ''
      ? { error: `The comment was posted on ${place.label}, but not on the line: update glab, and move it on GitLab` }
      : { comment }
  } catch {
    return { error: `The comment may have been posted on ${place.label}, but glab's answer could not be read: reload to check` }
  }
}

// ---- The three entry points ----

// Every comment on the request, oldest first: review comments on lines, and the general conversation.
// `typed` is what the person typed to open the request ("#12", a URL, ...), as resolveRequest takes.
// The open pull or merge request whose head is a branch of this repo, by
// what a person would type to open it ("#12") and how it is spoken of
// ("PR #12"); undefined when there is none, or no forge to ask.
export const requestOfBranch = async (
  run: Run,
  branch: string,
): Promise<
  { typed: string; label: string; title: string; baseRef: string; url: string } | undefined
> => {
  if (branch === '' || branch === 'HEAD') {
    return undefined
  }

  const place = await locate(run, '1')

  if ('error' in place) {
    return undefined
  }

  const isGitlab = place.forge === 'gitlab'
  const asked = await call(
    run,
    isGitlab
      ? glab(
          place,
          `projects/${encodeURIComponent(place.repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
        )
      : gh(
          place,
          `repos/${place.repo}/pulls?state=open&head=${encodeURIComponent(`${place.repo.split('/')[0] ?? ''}:${branch}`)}`,
        ),
    20_000,
  )

  if (asked.exitCode !== 0) {
    return undefined
  }

  try {
    const first = record(values(asked.stdout)[0])
    const number = whole(isGitlab ? first.iid : first.number)

    // What it is called, and the branch it asks to be merged into.
    const title = text(first.title)
    const baseRef = isGitlab ? text(first.target_branch) : text(record(first.base).ref)
    // Its page on the forge.
    const url = isGitlab ? text(first.web_url) : text(first.html_url)

    return number === 0
      ? undefined
      : isGitlab
        ? { typed: `!${number}`, label: `MR !${number}`, title, baseRef, url }
        : { typed: `#${number}`, label: `PR #${number}`, title, baseRef, url }
  } catch {
    return undefined
  }
}

// The repo's open pull or merge requests, newest first, each by what a person
// would type to open it ("#12", "!34") and its title. None where there is no
// forge to ask, or it does not answer: a list to offer, never an error.
//
// Each also says who opened it, whether that is the person signed in to the
// forge's CLI (`isMine`), whether it is a draft, the branch it is from, and
// when it last changed (an ISO time, '' where the forge did not say).
export type Listed = {
  typed: string
  title: string
  author: string
  isMine: boolean
  isDraft: boolean
  branch: string
  when: string
}

export const listRequests = async (run: Run): Promise<Listed[]> => {
  const place = await locate(run, '1')

  if ('error' in place) {
    return []
  }

  const isGitlab = place.forge === 'gitlab'
  const [listed, signedIn] = await Promise.all([
    call(
      run,
      isGitlab
        ? glab(place, `projects/${encodeURIComponent(place.repo)}/merge_requests?state=opened&per_page=50`)
        : gh(place, `repos/${place.repo}/pulls?state=open&per_page=50`),
      20_000,
    ),
    // Who is asking, to tell their own requests from the rest.
    call(run, isGitlab ? glab(place, 'user') : gh(place, 'user'), 20_000),
  ])

  if (listed.exitCode !== 0) {
    return []
  }

  let me = ''

  try {
    const user = record(JSON.parse(signedIn.stdout))

    me = signedIn.exitCode === 0 ? text(isGitlab ? user.username : user.login) : ''
  } catch {
    me = ''
  }

  try {
    return values(listed.stdout).flatMap(raw => {
      const one = record(raw)
      const number = whole(isGitlab ? one.iid : one.number)
      const by = record(isGitlab ? one.author : one.user)
      const author = text(isGitlab ? by.username : by.login)

      return number === 0
        ? []
        : [
            {
              typed: `${isGitlab ? '!' : '#'}${number}`,
              title: text(one.title),
              author,
              isMine: me !== '' && author === me,
              isDraft: (isGitlab ? (one.draft ?? one.work_in_progress) : one.draft) === true,
              branch: text(isGitlab ? one.source_branch : record(one.head).ref),
              when: text(one.updated_at),
            },
          ]
    })
  } catch {
    return []
  }
}

export const fetchComments = async (run: Run, typed: string): Promise<{ comments: Comment[] } | { error: string }> => {
  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  return place.forge === 'github' ? githubComments(run, place) : gitlabComments(run, place)
}

// Posts one review comment on a line of the request's head version of a file. `at.commit` is the
// full hash of the head commit the comment is anchored to; `at.path` is relative to the repo root.
export const postComment = async (
  run: Run,
  typed: string,
  at: { path: string; line: number; commit: string },
  body: string,
): Promise<{ comment: Comment } | { error: string }> => {
  if (body.trim() === '') {
    return { error: 'Write something before posting the comment' }
  }

  if (at.path === '' || !Number.isInteger(at.line) || at.line < 1 || at.commit === '') {
    return { error: 'Pick a line of a file in the request to comment on' }
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  if (place.forge === 'gitlab') {
    return gitlabPost(run, place, at, body)
  }

  // -f keeps the body as typed (-F would read "@file" and turn "true" into a boolean); the line must be a number.
  const posted = await call(
    run,
    gh(
      place,
      '-X',
      'POST',
      `repos/${place.repo}/pulls/${place.number}/comments`,
      '-f',
      `body=${body}`,
      '-f',
      `commit_id=${at.commit}`,
      '-f',
      `path=${at.path}`,
      '-F',
      `line=${at.line}`,
      '-f',
      'side=RIGHT',
    ),
  )

  if (posted.exitCode !== 0) {
    return { error: whyFailed(place, posted, 'comment on', at) }
  }

  try {
    return { comment: fromGithubLine(JSON.parse(posted.stdout), new Map()) }
  } catch {
    return { error: `The comment may have been posted on ${place.label}, but gh's answer could not be read: reload to check` }
  }
}

// Answers a review thread. `root` is the thread's first comment: GitHub replies to that comment
// by its id, GitLab adds a note to the discussion (`root.thread`).
export const replyComment = async (
  run: Run,
  typed: string,
  root: Pick<Comment, 'id' | 'thread'>,
  body: string,
): Promise<{ comment: Comment } | { error: string }> => {
  if (body.trim() === '') {
    return { error: 'Write something before posting the reply' }
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  if (place.forge === 'gitlab' && (root.thread ?? '') === '') {
    return { error: 'GitLab did not say which discussion that comment is in: refresh (r) and try again' }
  }

  const posted = await call(
    run,
    place.forge === 'gitlab'
      ? glab(
          place,
          '-X',
          'POST',
          `${gitlabRequest(place)}/discussions/${root.thread ?? ''}/notes`,
          '-f',
          `body=${body}`,
        )
      : gh(
          place,
          '-X',
          'POST',
          `repos/${place.repo}/pulls/${place.number}/comments/${root.id}/replies`,
          '-f',
          `body=${body}`,
        ),
  )

  if (posted.exitCode !== 0) {
    return { error: whyFailed(place, posted, 'comment on') }
  }

  try {
    const made =
      place.forge === 'gitlab'
        ? fromGitlabNote(JSON.parse(posted.stdout), root.id, '', root.thread ?? '')
        : fromGithubLine(JSON.parse(posted.stdout), new Map())

    return { comment: { ...made, replyTo: root.id } }
  } catch {
    return { error: `The reply may have been posted on ${place.label}, but the answer could not be read: refresh to check` }
  }
}

// Marks a review thread resolved, or open again. Answers '' when the forge took it, else why not.
export const resolveThread = async (
  run: Run,
  typed: string,
  thread: string,
  isResolved: boolean,
): Promise<string> => {
  const place = await locate(run, typed)

  if ('error' in place) {
    return place.error
  }

  if (thread === '') {
    return `${place.label} did not say which thread that comment is in: refresh (r) and try again`
  }

  const verb = isResolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  const ran = await call(
    run,
    place.forge === 'gitlab'
      ? glab(
          place,
          '-X',
          'PUT',
          `${gitlabRequest(place)}/discussions/${thread}?resolved=${isResolved ? 'true' : 'false'}`,
        )
      : gh(
          place,
          'graphql',
          '-f',
          `query=mutation($id:ID!){${verb}(input:{threadId:$id}){thread{isResolved}}}`,
          '-f',
          `id=${thread}`,
        ),
  )

  return ran.exitCode === 0 ? '' : whyFailed(place, ran, 'comment on')
}

// Submits a review of the request: an approval, a request for changes, or a
// comment, with a summary. Answers '' when the forge took it, else why not.
export const submitReview = async (
  run: Run,
  typed: string,
  verdict: 'approve' | 'request-changes' | 'comment',
  summary: string,
): Promise<string> => {
  const body = summary.trim()

  if (verdict !== 'approve' && body === '') {
    return 'Write a summary first: it is what the review says'
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place.error
  }

  if (place.forge === 'gitlab') {
    if (verdict === 'request-changes') {
      return 'GitLab has no call for requesting changes here: submit a comment saying what to change'
    }

    if (verdict === 'approve') {
      const approved = await call(run, glab(place, '-X', 'POST', `${gitlabRequest(place)}/approve`))

      if (approved.exitCode !== 0) {
        return whyFailed(place, approved, 'comment on')
      }
    }

    if (body === '') {
      return ''
    }

    const noted = await call(
      run,
      glab(place, '-X', 'POST', `${gitlabRequest(place)}/notes`, '-f', `body=${body}`),
    )

    return noted.exitCode === 0 ? '' : whyFailed(place, noted, 'comment on')
  }

  const event = verdict === 'approve' ? 'APPROVE' : verdict === 'comment' ? 'COMMENT' : 'REQUEST_CHANGES'
  const sent = await call(
    run,
    gh(
      place,
      '-X',
      'POST',
      `repos/${place.repo}/pulls/${place.number}/reviews`,
      '-f',
      `event=${event}`,
      ...(body === '' ? [] : ['-f', `body=${body}`]),
    ),
  )

  return sent.exitCode === 0 ? '' : whyFailed(place, sent, 'comment on')
}

// The sub-folder of the repo that `run` executes in, as a prefix ('' at the root, 'frontend/' in a
// sub-folder): the pane may be reviewing a sub-folder, and forge paths are relative to the root.
export const repoPrefix = async (run: Run): Promise<string> => {
  const ran = await call(run, ['git', 'rev-parse', '--show-prefix'], LOCAL_MS)

  return ran.exitCode === 0 ? ran.stdout.trim() : ''
}
