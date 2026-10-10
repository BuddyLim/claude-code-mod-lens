import { expect, test } from 'claude-code/testing'

import {
  fetchComments,
  listRequests,
  forgeOf,
  isOnWholeFile,
  parseRequest,
  postComment,
  postGeneral,
  quoteOf,
  remoteParts,
  repoPrefix,
  resolveRequest,
  submitDrafted,
  changeComment,
  gitlabLineCode,
  readOverview,
  markViewed,
  readViewed,
  fold,
  suggestedLines,
  suggestionOf,
  unfold,
} from './review'
import type { Run } from './review'

type Ran = { exitCode: number; stdout: string; stderr: string }

const ok = (stdout = ''): Ran => ({ exitCode: 0, stdout, stderr: '' })
const failed = (stderr = '', exitCode = 1): Ran => ({ exitCode, stdout: '', stderr })

// A run that answers from a table keyed by the command line, and remembers what it was asked.
// Anything not in the table fails, so a test names every command it expects to succeed.
const fake = (answers: Record<string, Ran>) => {
  const asked: string[] = []

  const run: Run = async argv => {
    const line = argv.join(' ')

    asked.push(line)

    return answers[line] ?? failed(`unexpected: ${line}`)
  }

  return { run, asked }
}

const GITHUB = 'git remote get-url origin'
const GH_VIEW = 'gh pr view 12 --repo github.com/acme/app --json number,title,baseRefName,headRefName,baseRefOid'
const FETCH_PR = 'git fetch --no-tags origin +refs/pull/12/head:refs/lens/pr-12'
const FETCH_MR = 'git fetch --no-tags origin +refs/merge-requests/34/head:refs/lens/mr-34'

const fetchBase = (branch: string, ref: string) => `git fetch --no-tags origin +refs/heads/${branch}:${ref}`

test('a request is read from numbers, words and links', async () => {
  expect(parseRequest('12')).toEqual({ host: 'unknown', number: 12 })
  expect(parseRequest(' #12 ')).toEqual({ host: 'unknown', number: 12 })
  expect(parseRequest('!34')).toEqual({ host: 'gitlab', number: 34 })
  expect(parseRequest('pr 12')).toEqual({ host: 'github', number: 12 })
  expect(parseRequest('PR #12')).toEqual({ host: 'github', number: 12 })
  expect(parseRequest('mr 34')).toEqual({ host: 'gitlab', number: 34 })
  expect(parseRequest('MR!34')).toEqual({ host: 'gitlab', number: 34 })
  expect(parseRequest('https://github.com/acme/app/pull/12')).toEqual({ host: 'github', number: 12, repo: 'acme/app' })
  expect(parseRequest('github.com/acme/app/pull/12/files#diff-1')).toEqual({
    host: 'github',
    number: 12,
    repo: 'acme/app',
  })
  expect(parseRequest('https://gitlab.com/group/sub/app/-/merge_requests/34/diffs')).toEqual({
    host: 'gitlab',
    number: 34,
    repo: 'group/sub/app',
  })
  expect(parseRequest('https://git.acme.io/team/app/-/merge_requests/34')).toEqual({
    host: 'gitlab',
    number: 34,
    repo: 'team/app',
  })
})

test('text that names no request is refused', async () => {
  expect(parseRequest('')).toBe(undefined)
  expect(parseRequest('main')).toBe(undefined)
  expect(parseRequest('0')).toBe(undefined)
  expect(parseRequest('12 13')).toBe(undefined)
  expect(parseRequest('v12')).toBe(undefined)
  expect(parseRequest('https://github.com/acme/app/issues/12')).toBe(undefined)
  expect(parseRequest('99999999999999999999')).toBe(undefined)
})

test('the forge is read from the remote host', async () => {
  expect(forgeOf('https://github.com/acme/app.git\n')).toBe('github')
  expect(forgeOf('git@github.com:acme/app.git')).toBe('github')
  expect(forgeOf('ssh://git@gitlab.acme.io:2222/team/app.git')).toBe('gitlab')
  expect(forgeOf('git@gitlab.com:group/sub/app.git')).toBe('gitlab')
  expect(forgeOf('https://bitbucket.org/acme/github-tools.git')).toBe('unknown')
  expect(forgeOf('/srv/git/app.git')).toBe('unknown')
  expect(remoteParts('git@gitlab.com:group/sub/app.git')).toEqual({ host: 'gitlab.com', repo: 'group/sub/app' })
  expect(remoteParts('https://user@GitHub.com/acme/app/')).toEqual({ host: 'github.com', repo: 'acme/app' })
})

test('a GitHub request compares its head against where it forked from the target', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    [GH_VIEW]: ok(JSON.stringify({ number: 12, title: 'Add login', baseRefName: 'develop', baseRefOid: 'b'.repeat(40) })),
    [fetchBase('develop', 'refs/lens/pr-12-base')]: ok(),
    [`git cat-file -e ${'b'.repeat(40)}^{commit}`]: ok(),
    [`git merge-base refs/lens/pr-12 ${'b'.repeat(40)}`]: ok('abc123\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  expect(await resolveRequest(run, '#12')).toEqual({
    side: 'refs/lens/pr-12',
    against: 'abc123',
    title: 'Add login',
    label: 'PR #12',
    target: 'develop',
    isTargetGuessed: false,
  })
  // Only commands that leave the work tree and local branches alone.
  expect([...new Set(asked.map(line => line.split(' ').slice(0, 2).join(' ')))].sort()).toEqual([
    'gh pr',
    'git cat-file',
    'git fetch',
    'git merge-base',
    'git remote',
    'git rev-parse',
  ])
  expect(asked.filter(line => line.startsWith('git fetch'))).toEqual([
    FETCH_PR,
    fetchBase('develop', 'refs/lens/pr-12-base'),
  ])
})

test('the target tip is used when the forge names no fork point that exists here', async () => {
  const { run } = fake({
    [GITHUB]: ok('git@github.com:acme/app.git\n'),
    [FETCH_PR]: ok(),
    [GH_VIEW]: ok(JSON.stringify({ title: 'Add login', baseRefName: 'main', baseRefOid: 'b'.repeat(40) })),
    [fetchBase('main', 'refs/lens/pr-12-base')]: ok(),
    'git merge-base refs/lens/pr-12 refs/lens/pr-12-base': ok('abc123\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  expect(await resolveRequest(run, 'https://github.com/Acme/App/pull/12')).toEqual({
    side: 'refs/lens/pr-12',
    against: 'abc123',
    title: 'Add login',
    label: 'PR #12',
    target: 'main',
    isTargetGuessed: false,
  })
})

test('a GitLab request reads the target and fork point from glab', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('git@gitlab.com:group/app.git\n'),
    [FETCH_MR]: ok(),
    'glab mr view 34 --output json': ok(
      JSON.stringify({ iid: 34, title: 'Fix cache', target_branch: 'main', diff_refs: { base_sha: 'c0ffee' } }),
    ),
    [fetchBase('main', 'refs/lens/mr-34-base')]: ok(),
    'git cat-file -e c0ffee^{commit}': ok(),
    'git merge-base refs/lens/mr-34 c0ffee': ok('c0ffee\n'),
    'git rev-parse refs/lens/mr-34': ok('def456\n'),
  })

  // A bare number takes the forge of origin.
  expect(await resolveRequest(run, '34')).toEqual({
    side: 'refs/lens/mr-34',
    against: 'c0ffee',
    title: 'Fix cache',
    label: 'MR !34',
    target: 'main',
    isTargetGuessed: false,
  })
  expect(asked.some(line => line.startsWith('gh '))).toBe(false)
})

test('without the CLI the default branch is the target and the title says it was guessed', async () => {
  const { run } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    [GH_VIEW]: failed('Error: ENOENT: gh', -1),
    'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/trunk\n'),
    [fetchBase('trunk', 'refs/lens/pr-12-base')]: ok(),
    'git merge-base refs/lens/pr-12 refs/lens/pr-12-base': ok('abc123\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  expect(await resolveRequest(run, '12')).toEqual({
    side: 'refs/lens/pr-12',
    against: 'abc123',
    title: '(target guessed as trunk: gh is not installed)',
    label: 'PR #12',
    target: 'trunk',
    isTargetGuessed: true,
  })
})

test('a run that throws for a missing CLI is treated as a missing CLI', async () => {
  const base = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
    [fetchBase('main', 'refs/lens/pr-12-base')]: ok(),
    'git merge-base refs/lens/pr-12 refs/lens/pr-12-base': ok('abc123\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  const run: Run = async (argv, timeoutMs) => {
    if (argv[0] === 'gh') {
      throw new Error('spawn gh ENOENT')
    }

    return base.run(argv, timeoutMs)
  }

  const got = await resolveRequest(run, '12')

  expect('error' in got ? got.error : got.title).toBe('(target guessed as main: gh is not installed)')
})

test('signed out, with no origin/HEAD, main then master are tried', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    [GH_VIEW]: failed('To get started with GitHub CLI, please run:  gh auth login'),
    [fetchBase('master', 'refs/lens/pr-12-base')]: ok(),
    'git merge-base refs/lens/pr-12 refs/lens/pr-12-base': ok('abc123\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  const got = await resolveRequest(run, '12')

  expect('error' in got ? got.error : [got.target, got.title]).toEqual([
    'master',
    '(target guessed as master: gh is not signed in, run gh auth login)',
  ])
  expect(asked.filter(line => line.includes('refs/heads/'))).toEqual([
    fetchBase('main', 'refs/lens/pr-12-base'),
    fetchBase('master', 'refs/lens/pr-12-base'),
  ])
})

test('a guessed target that already holds the head says there is nothing to compare', async () => {
  const { run } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
    [fetchBase('main', 'refs/lens/pr-12-base')]: ok(),
    'git merge-base refs/lens/pr-12 refs/lens/pr-12-base': ok('def456\n'),
    'git rev-parse refs/lens/pr-12': ok('def456\n'),
  })

  const got = await resolveRequest(run, '12')

  expect('error' in got ? got.error : got.title).toBe(
    '(target guessed as main: gh could not read it; already merged into main, nothing left to compare)',
  )
})

test('errors say what went wrong in one sentence', async () => {
  const notFound = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: failed("fatal: couldn't find remote ref refs/pull/12/head", 128),
  })
  const offline = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: failed('warning: x\nfatal: unable to access: Could not resolve host: github.com\n', 128),
  })
  const noTarget = fake({ [GITHUB]: ok('https://github.com/acme/app.git\n'), [FETCH_PR]: ok() })
  const unrelated = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [FETCH_PR]: ok(),
    [GH_VIEW]: ok(JSON.stringify({ title: 'Add login', baseRefName: 'main' })),
    [fetchBase('main', 'refs/lens/pr-12-base')]: ok(),
  })
  const other = fake({ [GITHUB]: ok('https://example.org/acme/app.git\n') })

  expect(await resolveRequest(notFound.run, '12')).toEqual({ error: 'PR #12 was not found on origin' })
  expect(await resolveRequest(offline.run, '12')).toEqual({
    error: 'PR #12 could not be fetched from origin: fatal: unable to access: Could not resolve host: github.com',
  })
  expect(await resolveRequest(noTarget.run, '12')).toEqual({
    error: 'No target branch for PR #12 could be found on origin (gh could not read it)',
  })
  expect(await resolveRequest(unrelated.run, '12')).toEqual({
    error: 'PR #12 and main share no history here; if this is a shallow clone, run git fetch --unshallow',
  })
  expect(await resolveRequest(other.run, '12')).toEqual({
    error: 'This repo\'s origin is not GitHub or GitLab; type "pr 12" or "mr 12" to say which it is',
  })
  expect(await resolveRequest(fake({}).run, '12')).toEqual({
    error: 'This repo has no remote named origin to fetch a PR or MR from',
  })
  expect(await resolveRequest(fake({}).run, 'main')).toEqual({
    error: '"main" is not a PR or MR: type a number like 12, or paste its URL',
  })
  expect(await resolveRequest(notFound.run, 'https://github.com/other/thing/pull/12')).toEqual({
    error: "That link is for other/thing, but this repo's origin is acme/app; open that repo instead",
  })
  // Nothing was fetched for a link to another repo.
  expect(notFound.asked.filter(line => line.startsWith('git fetch')).length).toBe(1)
})

test('a hint decides the forge when origin is a host that names neither', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('git@code.acme.io:team/app.git\n'),
    [FETCH_MR]: failed("fatal: couldn't find remote ref refs/merge-requests/34/head", 128),
  })

  expect(await resolveRequest(run, '!34')).toEqual({ error: 'MR !34 was not found on origin' })
  expect(asked).toEqual([GITHUB, FETCH_MR, 'glab mr view 34 --output json'])
})

// ---- Review comments ----

const GH = 'gh api --hostname github.com'
const GH_LINES = `${GH} repos/acme/app/pulls/12/comments?per_page=100 --paginate`
const GH_TALK = `${GH} repos/acme/app/issues/12/comments?per_page=100 --paginate`
const GH_REVIEWS = `${GH} repos/acme/app/pulls/12/reviews?per_page=100 --paginate`
const GH_THREADS =
  `${GH} graphql --paginate -f query=query($owner:String!,$name:String!,$number:Int!,$endCursor:String)` +
  '{repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor)' +
  '{pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}' +
  ' -f owner=acme -f name=app -F number=12'

const GL = 'glab api --hostname gitlab.com'
const GL_MR = `${GL} projects/group%2Fsub%2Fapp/merge_requests/34`
const GL_TALK = `${GL_MR}/discussions?per_page=100 --paginate`

const ghLine = (id: number, more: Record<string, unknown>) => ({
  id,
  path: 'src/a.ts',
  line: 40,
  side: 'RIGHT',
  subject_type: 'line',
  user: { login: 'ann' },
  body: `body ${id}`,
  created_at: `2026-01-0${id}T10:00:00Z`,
  ...more,
})

const threads = (nodes: { id: number; isResolved: boolean; isOutdated: boolean }[]) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: 'x' },
            nodes: nodes.map(({ id, ...state }) => ({ ...state, comments: { nodes: [{ databaseId: id }] } })),
          },
        },
      },
    },
  })

test('GitHub comments come back on their lines, in threads, with the conversation', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('git@github.com:acme/app.git\n'),
    [GH_LINES]: ok(
      JSON.stringify([
        ghLine(1, {}),
        ghLine(2, { in_reply_to_id: 1 }),
        // Outdated: GitHub keeps only original_line.
        ghLine(3, { line: null, original_line: 7, path: 'src/b.ts' }),
        // On a removed line: the number is a line of the target's version.
        ghLine(4, { side: 'LEFT', line: 9 }),
        ghLine(5, { subject_type: 'file', line: null, user: null }),
      ]),
    ),
    [GH_TALK]: ok(
      JSON.stringify([{ id: 70, user: { login: 'bob' }, body: 'Looks close', created_at: '2026-01-02T12:00:00Z' }]),
    ),
    [GH_REVIEWS]: ok(
      JSON.stringify([
        { id: 80, user: { login: 'ann' }, body: '', state: 'COMMENTED', submitted_at: '2026-01-01T10:00:00Z' },
        { id: 81, user: { login: 'ann' }, body: 'Two questions', state: 'COMMENTED', submitted_at: '2026-01-06T10:00:00Z' },
      ]),
    ),
    [GH_THREADS]: ok(
      threads([
        { id: 1, isResolved: true, isOutdated: false },
        { id: 3, isResolved: false, isOutdated: true },
      ]),
    ),
  })

  expect(await fetchComments(run, '#12')).toEqual({
    comments: [
      {
        id: '1',
        path: 'src/a.ts',
        line: 40,
        author: 'ann',
        body: 'body 1',
        when: '2026-01-01T10:00:00Z',
        isResolved: true,
        isOutdated: false,
      },
      {
        id: '2',
        path: 'src/a.ts',
        line: 40,
        author: 'ann',
        body: 'body 2',
        when: '2026-01-02T10:00:00Z',
        replyTo: '1',
        isResolved: true,
        isOutdated: false,
      },
      { id: 'issue-70', path: '', line: 0, author: 'bob', body: 'Looks close', when: '2026-01-02T12:00:00Z' },
      {
        id: '3',
        path: 'src/b.ts',
        line: 0,
        author: 'ann',
        body: 'body 3',
        when: '2026-01-03T10:00:00Z',
        isResolved: false,
        isOutdated: true,
      },
      {
        id: '4',
        path: 'src/a.ts',
        line: 0,
        author: 'ann',
        body: 'body 4',
        when: '2026-01-04T10:00:00Z',
        isOutdated: false,
        oldLine: 9,
      },
      { id: '5', path: 'src/a.ts', line: 0, author: 'ghost', body: 'body 5', when: '2026-01-05T10:00:00Z', isOutdated: false },
      { id: 'review-81', path: '', line: 0, author: 'ann', body: 'Two questions', when: '2026-01-06T10:00:00Z' },
    ],
  })
  // Only reads: nothing is fetched, and nothing is sent.
  expect(asked).toEqual([GITHUB, GH_LINES, GH_TALK, GH_REVIEWS, GH_THREADS])
})

test('comments are still listed when threads cannot be asked, and pages may come back to back', async () => {
  const { run } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    // Two pages printed one after the other, with brackets inside a body.
    [GH_LINES]: ok(`${JSON.stringify([ghLine(1, { body: 'a ][ "b" }{' })])}\n${JSON.stringify([ghLine(2, {})])}`),
    [GH_TALK]: ok('[]'),
    [GH_REVIEWS]: ok(''),
    [GH_THREADS]: failed('gh: Something went wrong (HTTP 502)'),
  })

  const got = await fetchComments(run, 'https://github.com/acme/app/pull/12/files')

  expect('error' in got ? got.error : got.comments.map(one => [one.id, one.body, one.isResolved])).toEqual([
    ['1', 'a ][ "b" }{', undefined],
    ['2', 'body 2', undefined],
  ])
})

const note = (id: number, more: Record<string, unknown>) => ({
  id,
  type: 'DiffNote',
  body: `note ${id}`,
  author: { username: 'cat', name: 'Cat' },
  created_at: `2026-02-0${id}T09:00:00.000Z`,
  system: false,
  resolvable: true,
  resolved: false,
  ...more,
})

const place = (headSha: string, more: Record<string, unknown>) => ({
  base_sha: 'base',
  start_sha: 'start',
  head_sha: headSha,
  old_path: 'lib/x.rb',
  new_path: 'lib/x.rb',
  position_type: 'text',
  old_line: null,
  new_line: 27,
  ...more,
})

test('GitLab discussions become comments, skipping system notes', async () => {
  const { run, asked } = fake({
    [GITHUB]: ok('git@gitlab.com:group/sub/app.git\n'),
    [GL_MR]: ok(JSON.stringify({ iid: 34, diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'head2' } })),
    [GL_TALK]: ok(
      JSON.stringify([
        {
          id: 'd1',
          individual_note: false,
          notes: [
            note(1, { position: place('head2', {}), resolved: true }),
            note(2, { position: place('head2', {}), resolved: true }),
          ],
        },
        { id: 'd2', individual_note: true, notes: [note(3, { type: null, system: true, resolvable: false })] },
        { id: 'd3', individual_note: true, notes: [note(4, { type: null, resolvable: false })] },
        // Made on an earlier head and never moved along: its line has changed since.
        { id: 'd4', individual_note: false, notes: [note(5, { position: place('head1', {}) })] },
        // On a removed line.
        { id: 'd5', individual_note: false, notes: [note(6, { position: place('head2', { old_line: 8, new_line: null }) })] },
      ]),
    ),
  })

  expect(await fetchComments(run, '!34')).toEqual({
    comments: [
      {
        id: '1',
        path: 'lib/x.rb',
        line: 27,
        author: 'cat',
        body: 'note 1',
        when: '2026-02-01T09:00:00.000Z',
        isResolved: true,
        thread: 'd1',
        isOutdated: false,
      },
      {
        id: '2',
        path: 'lib/x.rb',
        line: 27,
        author: 'cat',
        body: 'note 2',
        when: '2026-02-02T09:00:00.000Z',
        replyTo: '1',
        isResolved: true,
        thread: 'd1',
        isOutdated: false,
      },
      { id: '4', path: '', line: 0, author: 'cat', body: 'note 4', when: '2026-02-04T09:00:00.000Z' },
      {
        id: '5',
        path: 'lib/x.rb',
        line: 0,
        author: 'cat',
        body: 'note 5',
        when: '2026-02-05T09:00:00.000Z',
        isResolved: false,
        thread: 'd4',
        isOutdated: true,
      },
      {
        id: '6',
        path: 'lib/x.rb',
        line: 0,
        author: 'cat',
        body: 'note 6',
        when: '2026-02-06T09:00:00.000Z',
        isResolved: false,
        thread: 'd5',
        isOutdated: false,
        oldLine: 8,
      },
    ],
  })
  expect(asked).toEqual([GITHUB, GL_TALK, GL_MR])
})

const AT = { path: 'src/a.ts', line: 40, commit: 'f'.repeat(40) }

const GH_POST = [
  'gh',
  'api',
  '--hostname',
  'github.com',
  '-X',
  'POST',
  'repos/acme/app/pulls/12/comments',
  '-f',
  'body=@ann is this true?\nsecond line',
  '-f',
  `commit_id=${'f'.repeat(40)}`,
  '-f',
  'path=src/a.ts',
  '-F',
  'line=40',
  '-f',
  'side=RIGHT',
]

test('a GitHub comment is posted on the right side of the head commit', async () => {
  const sent: string[][] = []

  const run: Run = async argv => {
    sent.push(argv)

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : ok(JSON.stringify(ghLine(9, { body: '@ann is this true?\nsecond line', user: { login: 'me' } })))
  }

  expect(await postComment(run, '12', AT, '@ann is this true?\nsecond line')).toEqual({
    comment: {
      id: '9',
      path: 'src/a.ts',
      line: 40,
      author: 'me',
      body: '@ann is this true?\nsecond line',
      when: '2026-01-09T10:00:00Z',
      isOutdated: false,
    },
  })
  expect(sent).toEqual([['git', 'remote', 'get-url', 'origin'], GH_POST])
})

test('a review goes to GitHub with the comments written for it, as one call', async () => {
  const sent: { argv: string[]; stdin: string | undefined }[] = []
  const run: Run = async (argv, _timeout, stdin) => {
    sent.push({ argv, stdin })

    return argv[0] === 'git' ? ok('https://github.com/acme/app.git\n') : ok('{}')
  }
  const drafts = [
    { id: 'a', path: 'a.ts', line: 40, body: 'why?' },
    { id: 'b', path: 'a.ts', line: 12, startLine: 9, body: 'these four' },
  ]

  expect(
    await submitDrafted(run, '12', 'request-changes', 'see inline', { drafts, commit: 'f'.repeat(40), prefix: 'src/' }),
  ).toEqual({ refusal: '', sent: ['a', 'b'] })

  const review = sent[sent.length - 1]

  expect(review?.argv.slice(-3)).toEqual(['repos/acme/app/pulls/12/reviews', '--input', '-'])
  expect(JSON.parse(review?.stdin ?? '{}')).toEqual({
    event: 'REQUEST_CHANGES',
    body: 'see inline',
    commit_id: 'f'.repeat(40),
    comments: [
      { path: 'src/a.ts', line: 40, side: 'RIGHT', body: 'why?' },
      { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'these four', start_line: 9, start_side: 'RIGHT' },
    ],
  })

  // With comments waiting, a comment-only review needs no summary; with
  // none, it still does.
  expect((await submitDrafted(run, '12', 'comment', '', { drafts, commit: 'f'.repeat(40), prefix: '' })).refusal).toBe('')
  expect(await submitDrafted(run, '12', 'comment', '', { drafts: [], commit: '', prefix: '' })).toEqual({
    refusal: 'Write a summary first: it is what the review says',
    sent: [],
  })

  // A review the forge refuses leaves its comments waiting.
  const refusing: Run = async argv => (argv[0] === 'git' ? ok('https://github.com/acme/app.git\n') : failed('HTTP 422'))

  expect((await submitDrafted(refusing, '12', 'comment', 'x', { drafts, commit: 'f'.repeat(40), prefix: '' })).sent).toEqual([])
})

test('a comment typed on one line is sent on several, and a suggestion is read back', async () => {
  expect(unfold('first\\nsecond')).toBe('first\nsecond')
  expect(fold('first\r\nsecond\nthird')).toBe('first\\nsecond\\nthird')
  expect(unfold(fold('a\nb'))).toBe('a\nb')
  expect(suggestionOf('const limit = 12\\nconst more = 1')).toBe('```suggestion\nconst limit = 12\nconst more = 1\n```')
  expect(suggestedLines('Try this:\n```suggestion\nconst limit = 12\n  const more = 1\n```\nthanks')).toEqual([
    'const limit = 12',
    '  const more = 1',
  ])
  // A block that suggests removing its lines is no lines at all.
  expect(suggestedLines('```suggestion\n```')).toEqual([''])
  expect(suggestedLines('no block here')).toBe(undefined)
})

test('a comment of your own is changed, removed and liked where the forge keeps it', async () => {
  const asked: string[] = []
  const run: Run = async argv => {
    asked.push(argv.join(' '))

    return argv[0] === 'git' ? ok('https://github.com/acme/app.git\n') : ok('{}')
  }
  const sent = () => asked.filter(line => line.startsWith('gh ')).pop()

  expect(await changeComment(run, '12', { id: '77' }, { edit: 'better' })).toBe('')
  expect(sent()).toBe(`${GH} -X PATCH repos/acme/app/pulls/comments/77 -f body=better`)
  expect(await changeComment(run, '12', { id: 'issue-88' }, 'delete')).toBe('')
  expect(sent()).toBe(`${GH} -X DELETE repos/acme/app/issues/comments/88`)
  expect(await changeComment(run, '12', { id: '77' }, 'like')).toBe('')
  expect(sent()).toBe(`${GH} -X POST repos/acme/app/pulls/comments/77/reactions -f content=+1`)
  // A review's summary, a ledger finding and an empty edit are not sent at all.
  asked.length = 0
  expect(await changeComment(run, '12', { id: 'review-5' }, 'delete')).toBe(
    'That is not a comment the forge lets be changed from here',
  )
  expect(await changeComment(run, '12', { id: '77' }, { edit: '  ' })).toBe(
    'A comment cannot be left empty: delete it instead',
  )
  expect(asked.filter(line => line.startsWith('gh '))).toEqual([])
})

test('the files marked as viewed on GitHub are read, and a tick is made there too', async () => {
  const asked: string[] = []
  const page = (files: [string, string][], id = 'PR_1') =>
    JSON.stringify({
      data: { repository: { pullRequest: { id, files: { nodes: files.map(([path, state]) => ({ path, viewerViewedState: state })) } } } },
    })
  const run: Run = async argv => {
    asked.push(argv.join(' '))

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : // Two pages, as a paginated call prints them: back to back.
        ok(`${page([['src/a.ts', 'VIEWED'], ['src/b.ts', 'UNVIEWED']])}${page([['docs/c.md', 'VIEWED'], ['d.ts', 'DISMISSED']])}`)
  }

  expect(await readViewed(run, '12')).toEqual({ id: 'PR_1', viewed: ['src/a.ts', 'docs/c.md'] })
  expect(await markViewed(run, '12', 'PR_1', 'src/b.ts', true)).toBe('')
  expect(asked[asked.length - 1]?.includes('markFileAsViewed(input:{pullRequestId:$id,path:$path})')).toBe(true)
  expect(asked[asked.length - 1]?.endsWith('-f id=PR_1 -f path=src/b.ts')).toBe(true)
  await markViewed(run, '12', 'PR_1', 'src/a.ts', false)
  expect(asked[asked.length - 1]?.includes('unmarkFileAsViewed')).toBe(true)

  // GitLab keeps no such mark: nothing is read, and nothing is asked of it.
  const gitlab: Run = async argv => (argv[0] === 'git' ? ok('https://gitlab.com/acme/app.git\n') : failed('no'))

  expect(await readViewed(gitlab, '!34')).toBe(undefined)
  expect(await markViewed(gitlab, '!34', '', 'a.ts', true)).toBe('')
})

test('a GitHub comment on several lines names the first of them too', async () => {
  const sent: string[][] = []

  const run: Run = async argv => {
    sent.push(argv)

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : ok(JSON.stringify(ghLine(9, { body: 'x', user: { login: 'me' }, start_line: 31 })))
  }

  expect(await postComment(run, '12', { ...AT, startLine: 31 }, 'x')).toMatchObject({
    comment: { line: 40, startLine: 31 },
  })
  expect(sent[1]?.slice(-4)).toEqual(['-F', 'start_line=31', '-f', 'start_side=RIGHT'])
  // A first line that is not before the last is no range.
  sent.length = 0
  await postComment(run, '12', { ...AT, startLine: 40 }, 'x')
  expect(sent[1]?.includes('start_side=RIGHT')).toBe(false)
})

test('a comment on a removed line goes on the left of the forge’s diff, by its old number', async () => {
  const sent: { argv: string[]; stdin: string | undefined }[] = []
  const run: Run = async (argv, _timeout, stdin) => {
    sent.push({ argv, stdin })

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : ok(JSON.stringify(ghLine(9, { body: 'why gone?', user: { login: 'me' }, line: 17, side: 'LEFT' })))
  }

  // Posted at once: its line is the old side's, and it comes back as one.
  expect(await postComment(run, '12', { ...AT, line: 0, oldLine: 17 }, 'why gone?')).toMatchObject({
    comment: { path: 'src/a.ts', line: 0, oldLine: 17 },
  })
  expect(sent[1]?.argv.slice(-4)).toEqual(['-F', 'line=17', '-f', 'side=LEFT'])

  // Waiting for the review: it goes with the comments on lines, not alone.
  sent.length = 0
  await submitDrafted(run, '12', 'comment', '', {
    drafts: [{ id: 'a', path: 'a.ts', line: 0, oldLine: 17, body: 'why gone?' }],
    commit: 'f'.repeat(40),
    prefix: 'src/',
  })
  expect(sent.filter(one => one.argv[0] === 'gh').length).toBe(1)
  expect(JSON.parse(sent[sent.length - 1]?.stdin ?? '{}').comments).toEqual([
    { path: 'src/a.ts', line: 17, side: 'LEFT', body: 'why gone?' },
  ])
})

test('a GitHub comment on line 0 is posted on the file as a whole', async () => {
  const sent: string[][] = []

  const run: Run = async argv => {
    sent.push(argv)

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : ok(JSON.stringify(ghLine(9, { body: 'needs a test', user: { login: 'me' }, line: null, subject_type: 'file' })))
  }
  const posted = await postComment(run, '12', { ...AT, line: 0 }, 'needs a test')

  // It names the file and no line, and is not taken for one that lost its line.
  expect(posted).toMatchObject({ comment: { path: 'src/a.ts', line: 0, isOutdated: false } })
  expect('comment' in posted && isOnWholeFile(posted.comment)).toBe(true)
  expect(sent[1]).toEqual([...GH_POST.slice(0, 8), 'body=needs a test', ...GH_POST.slice(9, 13), '-f', 'subject_type=file'])
})

const glPosted = (position: Record<string, unknown> | undefined) =>
  ok(JSON.stringify({ id: 'd9', individual_note: false, notes: [note(9, position ? { position } : { type: null })] }))

const glPost = (position: Record<string, unknown>) => [
  'glab',
  'api',
  '--hostname',
  'gitlab.com',
  '-X',
  'POST',
  'projects/group%2Fsub%2Fapp/merge_requests/34/discussions',
  '-f',
  'body=Why?',
  '-F',
  `position=${JSON.stringify(position)}`,
]

const glRun = (git: Record<string, Ran>, posted: Ran) => {
  const sent: string[][] = []

  const run: Run = async argv => {
    const line = argv.join(' ')

    sent.push(argv)

    if (line === GITHUB) {
      return ok('git@gitlab.com:group/sub/app.git\n')
    }

    if (line === GL_MR) {
      return ok(JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'f'.repeat(40) } }))
    }

    return argv[0] === 'git' ? (git[line] ?? failed('fatal: bad object')) : posted
  }

  return { run, sent }
}

const GL_NAMES = `git diff --name-status -M -z base ${'f'.repeat(40)} --`

test('a GitLab comment carries the three commits, and the old line of an unchanged line', async () => {
  const position = {
    position_type: 'text',
    base_sha: 'base',
    start_sha: 'start',
    head_sha: 'f'.repeat(40),
    old_path: 'src/old.ts',
    new_path: 'src/a.ts',
    new_line: 40,
  }

  // A renamed file with 3 lines added at 10 and 2 removed after 50: line 40 was line 37, line 11 is new.
  const renamed = glRun(
    {
      [GL_NAMES]: ok('M\0README.md\0R090\0src/old.ts\0src/a.ts\0'),
      [`git diff --no-color --no-ext-diff -U0 -M base ${'f'.repeat(40)} -- src/old.ts src/a.ts`]: ok(
        'diff --git a/src/old.ts b/src/a.ts\n@@ -9,0 +10,3 @@ x\n+a\n+b\n+c\n@@ -48,2 +50,0 @@ y\n-d\n-e\n',
      ),
    },
    glPosted({ ...position, old_line: 37 }),
  )

  const got = await postComment(renamed.run, '!34', AT, 'Why?')

  expect('error' in got ? got.error : [got.comment.id, got.comment.path, got.comment.line]).toEqual(['9', 'src/a.ts', 40])
  expect(renamed.sent.at(-1)).toEqual(glPost({ ...position, old_line: 37 }))
  expect(renamed.sent.filter(argv => argv.includes('POST')).length).toBe(1)

  await postComment(renamed.run, '!34', { ...AT, line: 11 }, 'Why?')
  expect(renamed.sent.at(-1)).toEqual(glPost({ ...position, new_line: 11 }))

  await postComment(renamed.run, '!34', { ...AT, line: 60 }, 'Why?')
  expect(renamed.sent.at(-1)).toEqual(glPost({ ...position, new_line: 60, old_line: 59 }))

  // Without the commits here, the new line alone is sent and GitLab decides.
  const bare = glRun({}, glPosted({ ...position, old_path: 'src/a.ts' }))

  await postComment(bare.run, '!34', AT, 'Why?')
  expect(bare.sent.at(-1)).toEqual(glPost({ ...position, old_path: 'src/a.ts' }))
})

test('GitLab takes a comment on several lines, on a removed line, and a request for changes', async () => {
  const position = {
    position_type: 'text',
    base_sha: 'base',
    start_sha: 'start',
    head_sha: 'f'.repeat(40),
    old_path: 'src/old.ts',
    new_path: 'src/a.ts',
  }
  const git = {
    [GL_NAMES]: ok('M\0README.md\0R090\0src/old.ts\0src/a.ts\0'),
    [`git diff --no-color --no-ext-diff -U0 -M base ${'f'.repeat(40)} -- src/old.ts src/a.ts`]: ok(
      'diff --git a/src/old.ts b/src/a.ts\n@@ -9,0 +10,3 @@ x\n+a\n+b\n+c\n@@ -48,2 +50,0 @@ y\n-d\n-e\n',
    ),
  }
  const where = (argv: string[] | undefined) =>
    JSON.parse((argv?.find(part => part.startsWith('position=')) ?? 'position={}').slice('position='.length)) as Record<string, unknown>

  // The name of a line is the SHA-1 of its file's path, then the two counters.
  expect(await gitlabLineCode('README.md', 1, 1)).toBe('8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_1_1')

  // Several lines: the first and the last are named GitLab's way. Lines 11
  // and 12 were added before the base's line 10; line 40 was line 37.
  const ranged = glRun(git, glPosted({ ...position, new_line: 40, old_line: 37 }))

  await postComment(ranged.run, '!34', { ...AT, startLine: 11 }, 'Why?')
  expect(where(ranged.sent.at(-1))).toEqual({
    ...position,
    new_line: 40,
    old_line: 37,
    line_range: {
      start: { line_code: await gitlabLineCode('src/a.ts', 10, 11), type: 'new' },
      end: { line_code: await gitlabLineCode('src/a.ts', 37, 40), type: 'new' },
    },
  })
  expect(ranged.sent.filter(argv => argv.includes('POST')).length).toBe(1)

  // Where GitLab does not take the range, the comment still goes: on the
  // last line, saying which lines it is about.
  const posts: string[][] = []
  const refusing: Run = async argv => {
    const line = argv.join(' ')

    if (argv.includes('POST')) {
      posts.push(argv)

      return posts.length === 1 ? failed('HTTP 400') : glPosted({ ...position, new_line: 40, old_line: 37 })
    }

    return line === GITHUB
      ? ok('git@gitlab.com:group/sub/app.git\n')
      : line === GL_MR
        ? ok(JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'f'.repeat(40) } }))
        : (git[line] ?? failed('fatal: bad object'))
  }

  expect('comment' in (await postComment(refusing, '!34', { ...AT, startLine: 11 }, 'Why?'))).toBe(true)
  expect(posts.length).toBe(2)
  expect('line_range' in where(posts[1])).toBe(false)
  expect(posts[1]?.includes('body=Lines 11–40: Why?')).toBe(true)

  // A removed line is placed by its line in the base, under the name the
  // file had there.
  const gone = glRun(git, glPosted({ ...position, old_line: 48 }))
  const removed = await postComment(gone.run, '!34', { ...AT, line: 0, oldLine: 48 }, 'Why?')

  expect(where(gone.sent.at(-1))).toEqual({ ...position, old_line: 48 })
  expect(removed).toMatchObject({ comment: { path: 'src/a.ts', line: 0, oldLine: 48 } })

  // Changes are requested with the quick action GitLab acts on.
  const asked = glRun({}, ok('{}'))

  expect((await submitDrafted(asked.run, '!34', 'request-changes', 'Needs a test', { drafts: [], commit: '', prefix: '' })).refusal).toBe('')
  expect(asked.sent.at(-1)?.slice(-2)).toEqual(['-f', 'body=Needs a test\n\n/request_changes'])
})

test('a GitLab overview has the pipeline’s jobs, the commits, who reviewed, and where you last looked', async () => {
  const answers: Record<string, unknown> = {
    [GL_MR]: {
      title: 'Add it',
      description: 'Why it is added.',
      author: { username: 'cat' },
      state: 'opened',
      draft: true,
      web_url: 'https://gitlab.com/group/sub/app/-/merge_requests/34',
      target_branch: 'main',
      source_branch: 'topic',
      detailed_merge_status: 'mergeable',
      head_pipeline: { id: 77, status: 'failed', web_url: 'https://gitlab.com/p/77' },
      reviewers: [{ username: 'dog' }, { username: 'owl' }],
      labels: ['feature'],
      changes_count: '4',
    },
    [`${GL_MR}/approvals`]: { approved: false, approvals_left: 1, approved_by: [{ user: { username: 'dog' } }] },
    [`${GL_MR}/commits?per_page=100`]: [
      { short_id: 'bbbbbbb', title: 'Second', author_name: 'Cat' },
      { short_id: 'aaaaaaa', title: 'First', author_name: 'Cat' },
    ],
    [`${GL} user`]: { username: 'me' },
    [`${GL} projects/group%2Fsub%2Fapp/pipelines/77/jobs?per_page=100`]: [
      { stage: 'test', name: 'unit', status: 'success', web_url: 'https://gitlab.com/j/1' },
      { stage: 'test', name: 'lint', status: 'failed', web_url: 'https://gitlab.com/j/2' },
    ],
    [`${GL_MR}/notes?sort=desc&order_by=created_at&per_page=100`]: [
      { author: { username: 'cat' }, created_at: '2026-02-09T00:00:00Z', system: false },
      { author: { username: 'me' }, created_at: '2026-02-05T00:00:00Z', system: false },
    ],
    [`${GL_MR}/versions`]: [
      { head_commit_sha: 'c'.repeat(40), created_at: '2026-02-08T00:00:00Z' },
      { head_commit_sha: 'b'.repeat(40), created_at: '2026-02-04T00:00:00Z' },
      { head_commit_sha: 'a'.repeat(40), created_at: '2026-02-01T00:00:00Z' },
    ],
  }
  const run: Run = async argv => {
    const line = argv.join(' ')

    return line === GITHUB
      ? ok('git@gitlab.com:group/sub/app.git\n')
      : line in answers
        ? ok(JSON.stringify(answers[line]))
        : failed(`unexpected: ${line}`)
  }
  const got = await readOverview(run, '!34')

  expect('overview' in got ? got.overview : got.error).toMatchObject({
    title: 'Add it',
    body: 'Why it is added.',
    author: 'cat',
    isDraft: true,
    base: 'main',
    head: 'topic',
    mergeable: 'mergeable',
    decision: 'REVIEW_REQUIRED',
    checks: [
      { name: 'test: unit', state: 'success', url: 'https://gitlab.com/j/1' },
      { name: 'test: lint', state: 'failed', url: 'https://gitlab.com/j/2' },
    ],
    reviews: [
      { author: 'dog', state: 'APPROVED' },
      { author: 'owl', state: 'REVIEW_REQUESTED' },
    ],
    // Oldest first, as GitHub lists them.
    commits: [
      { hash: 'aaaaaaa', subject: 'First', author: 'Cat' },
      { hash: 'bbbbbbb', subject: 'Second', author: 'Cat' },
    ],
    labels: ['feature'],
    files: 4,
    // The head the request had when you last wrote on it.
    lastReviewed: 'b'.repeat(40),
  })
})

test('posting says in one sentence why it did not happen', async () => {
  const github = (answer: Ran) => fake({ [GITHUB]: ok('https://github.com/acme/app.git\n'), [GH_POST.join(' ')]: answer })
  const body = '@ann is this true?\nsecond line'

  const outside = github({
    exitCode: 1,
    stdout: JSON.stringify({
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequestReviewComment', code: 'custom', field: 'pull_request_review_thread.line' }],
      status: '422',
    }),
    stderr: 'gh: Validation Failed (HTTP 422)',
  })

  expect(await postComment(outside.run, '12', AT, body)).toEqual({
    error: "Line 40 of src/a.ts is not part of this pull request's diff",
  })
  expect(await postComment(github(failed('gh: Resource not accessible (HTTP 403)')).run, '12', AT, body)).toEqual({
    error: 'You do not have permission to comment on this pull request',
  })
  expect(await postComment(github(failed('gh: Bad credentials (HTTP 401)')).run, '12', AT, body)).toEqual({
    error: 'gh is not signed in: run gh auth login',
  })
  expect(await postComment(github(failed('gh: Not Found (HTTP 404)')).run, '12', AT, body)).toEqual({
    error: 'PR #12 was not found in acme/app, or you may not see it',
  })
  expect(await postComment(fake({}).run, '12', AT, '  ')).toEqual({ error: 'Write something before posting the comment' })
  expect(await postComment(fake({}).run, '12', { ...AT, line: -1 }, 'x')).toEqual({
    error: 'Pick a line of a file in the request to comment on',
  })

  // GitLab: a head that has moved, a file outside the diff, a line GitLab refuses, an old glab.
  const moved = glRun({}, ok('{}'))

  expect(await postComment(moved.run, '!34', { ...AT, commit: 'e'.repeat(40) }, 'Why?')).toEqual({
    error: 'This merge request has changed since it was opened here: reopen it, then comment again',
  })

  const untouched = glRun({ [GL_NAMES]: ok('M\0README.md\0') }, ok('{}'))

  expect(await postComment(untouched.run, '!34', AT, 'Why?')).toEqual({
    error: "Line 40 of src/a.ts is not part of this merge request's diff",
  })
  // Neither of those sent anything.
  expect([...moved.sent, ...untouched.sent].some(argv => argv.includes('POST'))).toBe(false)

  const refused = glRun(
    {},
    {
      exitCode: 1,
      stdout: JSON.stringify({ message: '400 Bad request - Note {:line_code=>["can\'t be blank", "must be a valid line code"]}' }),
      stderr: 'glab: 400 Bad request (HTTP 400)',
    },
  )

  expect(await postComment(refused.run, '!34', AT, 'Why?')).toEqual({
    error: "Line 40 of src/a.ts is not part of this merge request's diff",
  })
  expect(await postComment(glRun({}, glPosted(undefined)).run, '!34', AT, 'Why?')).toEqual({
    error: 'The comment was posted on MR !34, but not on the line: update glab, and move it on GitLab',
  })
})

test('reading says in one sentence why it did not happen', async () => {
  const origin = { [GITHUB]: ok('https://github.com/acme/app.git\n') }
  const reads = (answer: Ran) => fake({ ...origin, [GH_LINES]: answer, [GH_TALK]: answer, [GH_REVIEWS]: answer })
  const missing = { exitCode: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)' }
  const limited = {
    exitCode: 1,
    stdout: '{"message":"API rate limit exceeded for user ID 1.","status":"403"}',
    stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  }

  expect(await fetchComments(reads(missing).run, '12')).toEqual({
    error: 'PR #12 was not found in acme/app, or you may not see it',
  })
  expect(await fetchComments(reads(failed('gh: Bad credentials (HTTP 401)')).run, '12')).toEqual({
    error: 'gh is not signed in: run gh auth login',
  })
  expect(await fetchComments(reads(failed('To get started with GitHub CLI, please run:  gh auth login', 4)).run, '12')).toEqual({
    error: 'gh is not signed in: run gh auth login',
  })
  expect(await fetchComments(reads(limited).run, '12')).toEqual({
    error: 'GitHub is refusing more calls for now (rate limit): try again in a few minutes',
  })
  expect(await fetchComments(reads(failed('gh: Server Error (HTTP 500)')).run, '12')).toEqual({
    error: 'The comments of PR #12 could not be read: gh: Server Error (HTTP 500)',
  })
  expect(await fetchComments(reads(ok('[{"id":1,')).run, '12')).toEqual({
    error: 'The comments of PR #12 could not be read: gh gave an answer that could not be read',
  })

  const noCli: Run = async argv => {
    if (argv[0] !== 'git') {
      throw new Error(`spawn ${argv[0]} ENOENT`)
    }

    return ok(argv[1] === 'remote' ? 'git@gitlab.com:group/sub/app.git\n' : '')
  }

  expect(await fetchComments(noCli, '34')).toEqual({ error: 'glab is not installed' })
  expect(await postComment(noCli, '34', AT, 'Why?')).toEqual({ error: 'glab is not installed' })
  expect(await fetchComments(fake({}).run, '12')).toEqual({
    error: 'This repo has no remote named origin to read a PR or MR from',
  })
  expect(await fetchComments(fake(origin).run, 'https://github.com/other/thing/pull/12')).toEqual({
    error: "That link is for other/thing, but this repo's origin is acme/app; open that repo instead",
  })
  expect(await fetchComments(fake({}).run, 'main')).toEqual({
    error: '"main" is not a PR or MR: type a number like 12, or paste its URL',
  })
})

test('the prefix is the sub-folder the commands run in', async () => {
  expect(await repoPrefix(fake({ 'git rev-parse --show-prefix': ok('frontend/src/\n') }).run)).toBe('frontend/src/')
  expect(await repoPrefix(fake({ 'git rev-parse --show-prefix': ok('\n') }).run)).toBe('')
  expect(await repoPrefix(fake({}).run)).toBe('')
})

test('an answer in the conversation quotes what it answers, and is posted as a comment of its own', async () => {
  expect(quoteOf({ body: 'first line\n\nsecond line\n' })).toBe('> first line\n>\n> second line\n\n')

  const body = `${quoteOf({ body: 'why 12?' })}it is the least a subject needs`
  const { run, asked } = fake({
    [GITHUB]: ok('https://github.com/acme/app.git\n'),
    [`${GH} -X POST repos/acme/app/issues/12/comments -f body=${body}`]: ok(
      JSON.stringify({ id: 77, user: { login: 'me' }, body, created_at: '2026-10-10T00:00:00Z' }),
    ),
  })

  expect(await postGeneral(run, '#12', body)).toEqual({
    comment: { id: 'issue-77', path: '', line: 0, author: 'me', body, when: '2026-10-10T00:00:00Z' },
  })
  expect(asked.length).toBe(2)
  // Nothing is asked of the forge for an empty comment.
  expect(await postGeneral(fake({}).run, '#12', '  ')).toEqual({
    error: 'Write something before posting the comment',
  })
})

test('the open requests say whether their checks pass and how their reviews stand, on both forges', async () => {
  const github: Run = async argv => {
    const line = argv.join(' ')

    return argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : line.includes('graphql')
        ? ok(
            JSON.stringify({
              data: {
                repository: {
                  pullRequests: {
                    nodes: [
                      { number: 12, reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
                      { number: 13, reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
                    ],
                  },
                },
              },
            }),
          )
        : line.includes('pulls?state=open')
          ? ok(JSON.stringify([{ number: 12, title: 'One', user: { login: 'ann' } }, { number: 13, title: 'Two', user: { login: 'bob' } }, { number: 14, title: 'Three', user: { login: 'bob' } }]))
          : ok(JSON.stringify({ login: 'ann' }))
  }
  const listed = await listRequests(github)

  expect(listed.map(one => [one.typed, one.checks, one.decision, one.isMine])).toEqual([
    ['#12', 'FAILURE', 'CHANGES_REQUESTED', true],
    // No checks and no review: nothing is said of either.
    ['#13', '', '', false],
    // One the standing did not name is still listed.
    ['#14', '', '', false],
  ])

  const gitlab: Run = async argv => {
    const line = argv.join(' ')

    return argv[0] === 'git'
      ? ok('https://gitlab.com/acme/app.git\n')
      : line.includes('graphql')
        ? ok(JSON.stringify({ data: { project: { mergeRequests: { nodes: [{ iid: '34', approved: true, approvedBy: { nodes: [{ username: 'bob' }] }, headPipeline: { status: 'RUNNING' } }, { iid: '35', approved: true, approvedBy: { nodes: [] }, headPipeline: { status: 'SKIPPED' } }] } } } }))
        : line.includes('merge_requests?state=opened')
          ? ok(JSON.stringify([{ iid: 34, title: 'One', author: { username: 'ann' } }, { iid: 35, title: 'Two', author: { username: 'ann' } }]))
          : ok(JSON.stringify({ username: 'zed' }))
  }

  expect((await listRequests(gitlab)).map(one => [one.typed, one.checks, one.decision])).toEqual([
    ['!34', 'RUNNING', 'APPROVED'],
    // Approved by nobody, because nobody had to: not said to be approved.
    ['!35', 'SKIPPED', ''],
  ])

  // A forge that will not say how they stand still lists them.
  const silent: Run = async argv =>
    argv[0] === 'git'
      ? ok('https://github.com/acme/app.git\n')
      : argv.join(' ').includes('graphql')
        ? failed('no')
        : argv.join(' ').includes('pulls?state=open')
          ? ok(JSON.stringify([{ number: 12, title: 'One', user: { login: 'ann' } }]))
          : failed('no')

  expect((await listRequests(silent)).map(one => [one.typed, one.checks])).toEqual([['#12', '']])
})
