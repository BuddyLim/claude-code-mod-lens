// Pull request / merge request lookup: turns what the user typed into two refs that exist locally.
// Handle-free on purpose: every command goes through the `run` the caller passes in.

import { plain, plainBlock, sampleOf } from './media'

// `stdin` is what the command reads, where it is given one (a JSON body).
export type Run = (
  argv: string[],
  timeoutMs?: number,
  stdin?: string,
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
  startLine?: number // for a comment on several lines: the first of them (`line` is the last)
  // What the forge calls the thread it is in, by which the thread is resolved (and, on GitLab,
  // replied to): GitHub's node id of the review thread, GitLab's discussion id. Absent where the
  // forge did not say, and on general comments.
  thread?: string
}

// A comment written and not yet sent: it waits to go with the review. `path`
// is from the folder under review; `line` is 0 for the file as a whole, and
// `startLine`, where it is before `line`, makes it a comment on those lines.
// `oldLine` puts it on a removed line, by its number in the target's version
// of the file (`line` is then 0, as on a comment the forge sends back).
export type Draft = { id: string; path: string; line: number; startLine?: number; oldLine?: number; body: string }

const DRAFT = 'draft-'

// A draft as the comment it will be, so the screens draw it where it will
// sit: its id says it is one (see `isDraft`).
export const draftComment = (draft: Draft): Comment => ({
  id: `${DRAFT}${draft.id}`,
  path: draft.path,
  line: draft.line,
  author: 'you · pending, not sent yet',
  body: draft.body,
  when: '',
  isOutdated: false,
  ...(draft.startLine !== undefined && draft.startLine > 0 && draft.startLine < draft.line
    ? { startLine: draft.startLine }
    : {}),
  ...(draft.oldLine !== undefined && draft.oldLine > 0 ? { oldLine: draft.oldLine } : {}),
})

export const isDraft = (one: Pick<Comment, 'id'>): boolean => one.id.startsWith(DRAFT)

// The id of the draft a comment made by `draftComment` stands for.
export const draftId = (one: Pick<Comment, 'id'>): string => one.id.slice(DRAFT.length)

// Whether a comment is on its file as a whole: it names a file and no line,
// and is neither one that lost its line to an edit nor one on a removed line.
export const isOnWholeFile = (one: Comment): boolean =>
  one.path !== '' && one.line === 0 && one.isOutdated !== true && one.oldLine === undefined

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
    ...(!isOnOld && whole(one.start_line) > 0 && whole(one.start_line) < line
      ? { startLine: whole(one.start_line) }
      : {}),
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

  // A comment on the file as a whole is placed by its path alone.
  if (at.line === 0) {
    const whole = await call(
      run,
      glab(
        place,
        '-X',
        'POST',
        `${gitlabRequest(place)}/discussions`,
        '-f',
        `body=${body}`,
        '-F',
        `position=${JSON.stringify({
          position_type: 'file',
          base_sha: baseSha,
          start_sha: startSha,
          head_sha: headSha,
          old_path: at.path,
          new_path: at.path,
        })}`,
      ),
    )

    if (whole.exitCode !== 0) {
      return { error: whyFailed(place, whole, 'comment on') }
    }

    try {
      const comment = fromGitlabDiscussion(JSON.parse(whole.stdout), headSha)[0]

      if (!comment) {
        throw new Error('no note')
      }

      return { comment: { ...comment, path: comment.path || at.path, line: 0 } }
    } catch {
      return { error: `The comment may have been posted on ${place.label}, but glab's answer could not be read: reload to check` }
    }
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
  // The first line or two of what its description says, as plain text; ''
  // for a request that says nothing.
  summary: string
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
              // What people wrote is made plain before it is handed on.
              title: plain(text(one.title)).slice(0, 300),
              author: plain(author).slice(0, 100),
              isMine: me !== '' && author === me,
              isDraft: (isGitlab ? (one.draft ?? one.work_in_progress) : one.draft) === true,
              branch: plain(text(isGitlab ? one.source_branch : record(one.head).ref)).slice(0, 200),
              when: text(one.updated_at),
              summary:
                sampleOf(
                  typeof (isGitlab ? one.description : one.body) === 'string'
                    ? ((isGitlab ? one.description : one.body) as string)
                    : '',
                  2,
                  240,
                ).join(' · '),
            },
          ]
    })
  } catch {
    return []
  }
}

// What a request is, beyond its code: what it says it does, whether its
// checks pass, who has reviewed it, whether it can be merged, and its
// commits. `lastReviewed` is the commit the person signed in to the forge's
// CLI last reviewed it at ('' when they have not, or the forge did not say).
export type Overview = {
  title: string
  body: string
  author: string
  state: string
  isDraft: boolean
  url: string
  base: string
  head: string
  // What the forge says of merging it ("MERGEABLE", "CONFLICTING", ...) and
  // of its reviews as a whole ("APPROVED", "CHANGES_REQUESTED", ...), in its
  // own words; '' where it did not say.
  mergeable: string
  decision: string
  checks: { name: string; state: string; url: string }[]
  reviews: { author: string; state: string; when: string }[]
  commits: { hash: string; subject: string; author: string }[]
  labels: string[]
  additions: number
  deletions: number
  files: number
  lastReviewed: string
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// An overview as it is handed on to be drawn. All of it is what people on
// the forge wrote (a title, a branch's name, a check's, a label), so every
// word is made plain text first and held to a length, the description keeps
// its lines but nothing a terminal would act on, and the lists are bounded.
const LISTED = 200
const WORD = 300
const tidyOverview = (seen: Overview): Overview => {
  const word = (value: string): string => plain(value).slice(0, WORD)
  const link = (value: string): string => (/^https?:\/\/[\x21-\x7e]{1,2000}$/.test(value) ? value : '')

  return {
    title: word(seen.title),
    body: plainBlock(seen.body).slice(0, 200_000),
    author: word(seen.author),
    state: word(seen.state),
    isDraft: seen.isDraft,
    url: link(seen.url),
    base: word(seen.base),
    head: word(seen.head),
    mergeable: word(seen.mergeable),
    decision: word(seen.decision),
    checks: seen.checks.slice(0, LISTED).map(one => ({ name: word(one.name), state: word(one.state), url: link(one.url) })),
    reviews: seen.reviews.slice(0, LISTED).map(one => ({ author: word(one.author), state: word(one.state), when: word(one.when) })),
    commits: seen.commits.slice(-LISTED).map(one => ({ hash: word(one.hash), subject: word(one.subject), author: word(one.author) })),
    labels: seen.labels.slice(0, LISTED).map(word),
    additions: seen.additions,
    deletions: seen.deletions,
    files: seen.files,
    // A commit's hash, or nothing: it is handed to git.
    lastReviewed: /^[0-9a-f]{7,64}$/.test(seen.lastReviewed) ? seen.lastReviewed : '',
  }
}

// Reads a request's overview from the forge. `typed` is what the person
// typed to open it.
export const readOverview = async (run: Run, typed: string): Promise<{ overview: Overview } | { error: string }> => {
  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  if (place.forge === 'gitlab') {
    const [seen, approvals] = await Promise.all([
      call(run, glab(place, gitlabRequest(place))),
      call(run, glab(place, `${gitlabRequest(place)}/approvals`)),
    ])

    if (seen.exitCode !== 0) {
      return { error: whyFailed(place, seen, 'read') }
    }

    try {
      const one = record(JSON.parse(seen.stdout))
      const pipeline = record(one.head_pipeline)
      let approved: unknown[] = []

      try {
        approved = values(JSON.stringify(record(JSON.parse(approvals.stdout)).approved_by ?? []))
      } catch {
        approved = []
      }

      return {
        overview: tidyOverview({
          title: text(one.title),
          body: typeof one.description === 'string' ? one.description : '',
          author: text(record(one.author).username),
          state: text(one.state),
          isDraft: (one.draft ?? one.work_in_progress) === true,
          url: text(one.web_url),
          base: text(one.target_branch),
          head: text(one.source_branch),
          mergeable: text(one.detailed_merge_status) || text(one.merge_status),
          decision: approved.length > 0 ? 'APPROVED' : '',
          checks:
            text(pipeline.status) === ''
              ? []
              : [{ name: 'pipeline', state: text(pipeline.status), url: text(pipeline.web_url) }],
          reviews: approved.map(raw => ({
            author: text(record(record(raw).user).username),
            state: 'APPROVED',
            when: '',
          })),
          commits: [],
          labels: (Array.isArray(one.labels) ? one.labels : []).map(named).filter(label => label !== ''),
          additions: 0,
          deletions: 0,
          files: Number.parseInt(text(one.changes_count), 10) || 0,
          lastReviewed: '',
        }),
      }
    } catch {
      return { error: `glab's answer about ${place.label} could not be read` }
    }
  }

  const [seen, signedIn] = await Promise.all([
    call(run, [
      'gh',
      'pr',
      'view',
      String(place.number),
      '--repo',
      `${place.host}/${place.repo}`,
      '--json',
      'title,body,author,state,isDraft,url,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews,commits,labels,additions,deletions,changedFiles',
    ]),
    call(run, gh(place, 'user'), 20_000),
  ])

  if (seen.exitCode !== 0) {
    return { error: whyFailed(place, seen, 'read') }
  }

  try {
    const one = record(JSON.parse(seen.stdout))
    let me = ''

    try {
      me = signedIn.exitCode === 0 ? text(record(JSON.parse(signedIn.stdout)).login) : ''
    } catch {
      me = ''
    }

    const reviews = (Array.isArray(one.latestReviews) ? one.latestReviews : []).map(raw => {
      const review = record(raw)

      return {
        author: text(record(review.author).login),
        state: text(review.state),
        when: text(review.submittedAt),
        commit: text(record(review.commit).oid),
      }
    })

    return {
      overview: tidyOverview({
        title: text(one.title),
        body: typeof one.body === 'string' ? one.body : '',
        author: text(record(one.author).login),
        state: text(one.state),
        isDraft: one.isDraft === true,
        url: text(one.url),
        base: text(one.baseRefName),
        head: text(one.headRefName),
        mergeable: [text(one.mergeable), text(one.mergeStateStatus)].filter(part => part !== '').join(' · '),
        decision: text(one.reviewDecision),
        checks: (Array.isArray(one.statusCheckRollup) ? one.statusCheckRollup : []).map(raw => {
          const check = record(raw)

          return {
            name: text(check.name) || text(check.context),
            // A run still going has no conclusion yet: its status says so.
            state: text(check.conclusion) || text(check.state) || text(check.status),
            url: text(check.detailsUrl) || text(check.targetUrl),
          }
        }),
        reviews: reviews.map(({ author, state, when }) => ({ author, state, when })),
        commits: (Array.isArray(one.commits) ? one.commits : []).map(raw => {
          const commit = record(raw)
          const by = record((Array.isArray(commit.authors) ? commit.authors : [])[0])

          return {
            hash: text(commit.oid).slice(0, 7),
            subject: text(commit.messageHeadline),
            author: text(by.login) || text(by.name),
          }
        }),
        labels: (Array.isArray(one.labels) ? one.labels : []).map(raw => text(record(raw).name)).filter(label => label !== ''),
        additions: count(one.additions),
        deletions: count(one.deletions),
        files: count(one.changedFiles),
        lastReviewed: me === '' ? '' : (reviews.find(review => review.author === me)?.commit ?? ''),
      }),
    }
  } catch {
    return { error: `gh's answer about ${place.label} could not be read` }
  }
}

// A comment's text as it is sent, from a field that holds one line: the two
// characters `\n` typed there start a new line. And the other way, to put a
// comment back in the field to be edited.
export const unfold = (typed: string): string => typed.replace(/\\n/g, '\n')
export const fold = (body: string): string => body.replace(/\r?\n/g, '\\n')

// What was typed as a suggested replacement for the lines a comment is on,
// in the form the forges read as one: a block they offer to apply.
export const suggestionOf = (typed: string): string => `\`\`\`suggestion\n${unfold(typed)}\n\`\`\``

// The replacement a comment suggests for its lines, when it suggests one:
// the lines of its first `suggestion` block.
export const suggestedLines = (body: string): string[] | undefined => {
  const block = /```suggestion[^\n]*\n([\s\S]*?)\n?```/.exec(body.replace(/\r\n/g, '\n'))

  return block === null ? undefined : (block[1] ?? '').split('\n')
}

// Who is signed in to the forge's CLI, by the name comments carry; '' where
// the forge cannot be asked.
export const whoAmI = async (run: Run): Promise<string> => {
  const place = await locate(run, '1')

  if ('error' in place) {
    return ''
  }

  const seen = await call(run, place.forge === 'gitlab' ? glab(place, 'user') : gh(place, 'user'), 20_000)

  try {
    const user = record(JSON.parse(seen.stdout))

    return seen.exitCode === 0 ? text(place.forge === 'gitlab' ? user.username : user.login) : ''
  } catch {
    return ''
  }
}

// Where the forge keeps a comment, to change it, remove it or react to it:
// a comment on a line, one on the request as a whole (GitHub numbers the
// two apart, and prefixes the second kind here), or a GitLab note.
const commentAt = (place: Place, one: Pick<Comment, 'id' | 'thread'>): string | undefined => {
  if (place.forge === 'gitlab') {
    return /^\d+$/.test(one.id)
      ? (one.thread ?? '') !== ''
        ? `${gitlabRequest(place)}/discussions/${one.thread}/notes/${one.id}`
        : `${gitlabRequest(place)}/notes/${one.id}`
      : undefined
  }

  const general = /^issue-(\d+)$/.exec(one.id)?.[1]

  return general !== undefined
    ? `repos/${place.repo}/issues/comments/${general}`
    : /^\d+$/.test(one.id)
      ? `repos/${place.repo}/pulls/comments/${one.id}`
      : undefined
}

// Changes what a comment of the person's own says, removes it, or adds a
// thumbs-up to it. Answers '' when the forge took it, else why not.
export const changeComment = async (
  run: Run,
  typed: string,
  one: Pick<Comment, 'id' | 'thread'>,
  change: { edit: string } | 'delete' | 'like',
): Promise<string> => {
  if (typeof change === 'object' && change.edit.trim() === '') {
    return 'A comment cannot be left empty: delete it instead'
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place.error
  }

  const at = commentAt(place, one)

  if (at === undefined) {
    return 'That is not a comment the forge lets be changed from here'
  }

  const api = (...rest: string[]) => (place.forge === 'gitlab' ? glab(place, ...rest) : gh(place, ...rest))
  const done = await call(
    run,
    change === 'delete'
      ? api('-X', 'DELETE', at)
      : change === 'like'
        ? place.forge === 'gitlab'
          ? api('-X', 'POST', `${at}/award_emoji`, '-f', 'name=thumbsup')
          : api('-X', 'POST', `${at}/reactions`, '-f', 'content=+1')
        : api('-X', place.forge === 'gitlab' ? 'PUT' : 'PATCH', at, '-f', `body=${change.edit}`),
  )

  return done.exitCode === 0 ? '' : whyFailed(place, done, 'comment on')
}

// What can be done to a request as a whole, from the pane.
export type RequestAct = 'merge' | 'squash' | 'rebase' | 'close' | 'ready' | 'checkout'

// Does it, through the forge's CLI: merges the request (as a merge commit,
// squashed, or rebased), closes it, marks a draft ready for review, or
// checks its branch out here. Answers '' when it was done, else why not.
export const actOnRequest = async (run: Run, typed: string, act: RequestAct): Promise<string> => {
  const place = await locate(run, typed)

  if ('error' in place) {
    return place.error
  }

  const number = String(place.number)
  const where = place.forge === 'gitlab' ? ['-R', `${place.host}/${place.repo}`] : ['--repo', `${place.host}/${place.repo}`]
  const argv =
    place.forge === 'gitlab'
      ? act === 'close'
        ? ['glab', 'mr', 'close', number, ...where]
        : act === 'ready'
          ? ['glab', 'mr', 'update', number, '--ready', ...where]
          : act === 'checkout'
            ? ['glab', 'mr', 'checkout', number, ...where]
            : ['glab', 'mr', 'merge', number, '--yes', ...(act === 'squash' ? ['--squash'] : act === 'rebase' ? ['--rebase'] : []), ...where]
      : act === 'close'
        ? ['gh', 'pr', 'close', number, ...where]
        : act === 'ready'
          ? ['gh', 'pr', 'ready', number, ...where]
          : act === 'checkout'
            ? ['gh', 'pr', 'checkout', number, ...where]
            : ['gh', 'pr', 'merge', number, `--${act}`, ...where]
  const done = await call(run, argv, 120_000)

  if (done.exitCode === 0) {
    return ''
  }

  // The CLI's own last words say why best (a failing check, a conflict, a
  // dirty working tree); the general reasons cover its not running at all.
  const said = lastLine(done.stderr) || lastLine(done.stdout)

  return said !== '' && done.exitCode !== -1 && done.exitCode !== 127
    ? `${place.label} was not ${act === 'checkout' ? 'checked out' : act === 'ready' ? 'marked ready' : act === 'close' ? 'closed' : 'merged'}: ${said.slice(0, 200)}`
    : whyFailed(place, done, 'read')
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
  // `startLine`, where it is before `line`, makes it a comment on those lines
  // together. GitHub takes the range; on GitLab the comment goes on the last
  // line and says which lines it is about.
  // `oldLine` puts the comment on a removed line, by its number in the
  // target's version of the file: the left side of the forge's own diff.
  at: { path: string; line: number; commit: string; startLine?: number; oldLine?: number },
  body: string,
): Promise<{ comment: Comment } | { error: string }> => {
  if (body.trim() === '') {
    return { error: 'Write something before posting the comment' }
  }

  const oldLine = at.oldLine !== undefined && Number.isInteger(at.oldLine) && at.oldLine > 0 ? at.oldLine : 0

  const startLine = at.startLine !== undefined && at.startLine > 0 && at.startLine < at.line ? at.startLine : 0

  // Line 0 is the file as a whole, which both forges take a comment on.
  if (at.path === '' || !Number.isInteger(at.line) || at.line < 0 || at.commit === '') {
    return { error: 'Pick a line of a file in the request to comment on' }
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  if (place.forge === 'gitlab') {
    // GitLab places a note on a removed line by a key of its own making,
    // which is not worked out here.
    if (oldLine > 0) {
      return { error: 'Commenting on a removed line is not done for GitLab from here yet: comment on a line beside it' }
    }

    return gitlabPost(
      run,
      place,
      at,
      startLine === 0 ? body : `Lines ${startLine}–${at.line}: ${body}`,
    )
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
      ...(oldLine > 0
        ? ['-F', `line=${oldLine}`, '-f', 'side=LEFT']
        : at.line === 0
          ? ['-f', 'subject_type=file']
          : ['-F', `line=${at.line}`, '-f', 'side=RIGHT']),
      ...(startLine === 0 || oldLine > 0 ? [] : ['-F', `start_line=${startLine}`, '-f', 'start_side=RIGHT']),
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

// The files of a request the person has marked as viewed on the forge
// itself, and the request's own id there, by which one is marked. GitHub
// keeps these; GitLab has no such mark to read, and answers undefined, as
// does a forge that cannot be asked. Paths are from the repo's root.
const VIEWED_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id files(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}'

export const readViewed = async (run: Run, typed: string): Promise<{ id: string; viewed: string[] } | undefined> => {
  const place = await locate(run, typed)

  if ('error' in place || place.forge !== 'github') {
    return undefined
  }

  const [owner = '', name = ''] = place.repo.split('/')
  const seen = await call(
    run,
    gh(place, 'graphql', '--paginate', '-f', `query=${VIEWED_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${place.number}`),
  )

  if (seen.exitCode !== 0) {
    return undefined
  }

  try {
    let id = ''
    const viewed: string[] = []

    // A paginated call prints one answer for each page, back to back.
    for (const page of values(seen.stdout)) {
      const request = record(record(record(record(page).data).repository).pullRequest)

      id ||= text(request.id)

      for (const raw of Array.isArray(record(request.files).nodes) ? (record(request.files).nodes as unknown[]) : []) {
        const file = record(raw)

        if (file.viewerViewedState === 'VIEWED' && text(file.path) !== '') {
          viewed.push(text(file.path))
        }
      }
    }

    return id === '' ? undefined : { id, viewed: viewed.slice(0, 5000) }
  } catch {
    return undefined
  }
}

// Marks a file of a request as viewed on the forge, or takes the mark off.
// `id` is the request's own, as `readViewed` gave it; `path` is from the
// repo's root. Answers '' when the forge took it, else why not.
export const markViewed = async (
  run: Run,
  typed: string,
  id: string,
  path: string,
  isViewed: boolean,
): Promise<string> => {
  const place = await locate(run, typed)

  if ('error' in place) {
    return place.error
  }

  if (place.forge !== 'github' || id === '') {
    return ''
  }

  const verb = isViewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const ran = await call(
    run,
    gh(
      place,
      'graphql',
      '-f',
      `query=mutation($id:ID!,$path:String!){${verb}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
      '-f',
      `id=${id}`,
      '-f',
      `path=${path}`,
    ),
  )

  return ran.exitCode === 0 ? '' : whyFailed(place, ran, 'read')
}

// A comment as a quotation, the way a forge's own "quote reply" starts an
// answer: each of its lines after a ">", then a clear line for what follows.
export const quoteOf = (one: Pick<Comment, 'body'>): string =>
  `${one.body
    .trim()
    .split('\n')
    .map(line => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')}\n\n`

// Adds a comment to the request's conversation: one on the request as a
// whole, on no line. Neither forge threads these on a pull request's own
// page (GitHub not at all), so an answer to one is a new comment that quotes
// it (see `quoteOf`).
export const postGeneral = async (
  run: Run,
  typed: string,
  body: string,
): Promise<{ comment: Comment } | { error: string }> => {
  if (body.trim() === '') {
    return { error: 'Write something before posting the comment' }
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return place
  }

  const posted = await call(
    run,
    place.forge === 'gitlab'
      ? glab(place, '-X', 'POST', `${gitlabRequest(place)}/notes`, '-f', `body=${body}`)
      : gh(place, '-X', 'POST', `repos/${place.repo}/issues/${place.number}/comments`, '-f', `body=${body}`),
  )

  if (posted.exitCode !== 0) {
    return { error: whyFailed(place, posted, 'comment on') }
  }

  try {
    const one = record(JSON.parse(posted.stdout))

    return {
      comment:
        place.forge === 'gitlab'
          ? {
              id: named(one.id),
              path: '',
              line: 0,
              author: text(record(one.author).username) || 'ghost',
              body: typeof one.body === 'string' ? one.body : body,
              when: text(one.created_at),
            }
          : fromGithubGeneral(one, 'issue'),
    }
  } catch {
    return { error: `The comment may have been posted on ${place.label}, but its answer could not be read: reload to check` }
  }
}

// Submits a review of the request: an approval, a request for changes, or a
// comment, with a summary. Answers '' when the forge took it, else why not.
export const submitReview = async (
  run: Run,
  typed: string,
  verdict: 'approve' | 'request-changes' | 'comment',
  summary: string,
): Promise<string> => (await submitDrafted(run, typed, verdict, summary, { drafts: [], commit: '', prefix: '' })).refusal

// Submits a review with the comments written for it (`drafts`), which go to
// the forge with the verdict. `commit` is the request's head, which the
// comments are placed on, and `prefix` the folder under review's place in
// the repo. Answers why it was not taken ('' when it was) and which drafts
// did reach the forge (`sent`, by id), so those are not sent twice.
//
// GitHub takes the comments on lines and the verdict as one review. A
// comment on a file as a whole is no part of that call there, and GitLab
// has no such call at all: those are posted one at a time, before the
// verdict.
export const submitDrafted = async (
  run: Run,
  typed: string,
  verdict: 'approve' | 'request-changes' | 'comment',
  summary: string,
  pending: { drafts: readonly Draft[]; commit: string; prefix: string },
): Promise<{ refusal: string; sent: string[] }> => {
  const body = summary.trim()
  const sent: string[] = []
  const { drafts, commit, prefix } = pending

  if (verdict !== 'approve' && body === '' && drafts.length === 0) {
    return { refusal: 'Write a summary first: it is what the review says', sent }
  }

  const place = await locate(run, typed)

  if ('error' in place) {
    return { refusal: place.error, sent }
  }

  // The comments posted one at a time: all of them on GitLab, those on a
  // whole file on GitHub.
  // A comment on a removed line is on a line too (of the other side), and
  // goes with the review.
  const isOnLine = (one: Draft): boolean => one.line > 0 || (one.oldLine ?? 0) > 0

  for (const draft of drafts.filter(one => place.forge === 'gitlab' || !isOnLine(one))) {
    const posted = await postComment(
      run,
      typed,
      {
        path: `${prefix}${draft.path}`,
        line: draft.line,
        commit,
        ...(draft.startLine === undefined ? {} : { startLine: draft.startLine }),
        ...(draft.oldLine === undefined ? {} : { oldLine: draft.oldLine }),
      },
      draft.body,
    )

    if ('error' in posted) {
      return { refusal: posted.error, sent }
    }

    sent.push(draft.id)
  }

  const refusal = await submitVerdict(
    run,
    place,
    verdict,
    body,
    place.forge === 'gitlab' ? [] : drafts.filter(isOnLine),
    commit,
    prefix,
  )

  return refusal === ''
    ? { refusal, sent: drafts.map(one => one.id) }
    : { refusal, sent }
}

const submitVerdict = async (
  run: Run,
  place: Place,
  verdict: 'approve' | 'request-changes' | 'comment',
  body: string,
  onLines: readonly Draft[],
  commit: string,
  prefix: string,
): Promise<string> => {
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

  // With comments, the review is one JSON body: a list does not fit the
  // CLI's fields.
  if (onLines.length > 0) {
    const whole = await run(
      gh(place, '-X', 'POST', `repos/${place.repo}/pulls/${place.number}/reviews`, '--input', '-'),
      COMMENTS_MS,
      JSON.stringify({
        event,
        ...(body === '' ? {} : { body }),
        ...(commit === '' ? {} : { commit_id: commit }),
        comments: onLines.map(one =>
          (one.oldLine ?? 0) > 0
            ? // A removed line is on the left of the forge's diff, by its
              // number in the target's version of the file.
              { path: `${prefix}${one.path}`, line: one.oldLine, side: 'LEFT', body: one.body }
            : {
                path: `${prefix}${one.path}`,
                line: one.line,
                side: 'RIGHT',
                body: one.body,
                ...(one.startLine !== undefined && one.startLine > 0 && one.startLine < one.line
                  ? { start_line: one.startLine, start_side: 'RIGHT' }
                  : {}),
              },
        ),
      }),
    ).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

    return whole.exitCode === 0 ? '' : whyFailed(place, whole, 'comment on')
  }

  // GitHub refuses a comment-only review that says nothing: with its
  // comments all posted already, there is nothing left to send.
  if (verdict === 'comment' && body === '') {
    return ''
  }

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
