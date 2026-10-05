import { expect, test } from 'claude-code/testing'

import {
  fetchComments,
  forgeOf,
  parseRequest,
  postComment,
  remoteParts,
  repoPrefix,
  resolveRequest,
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
  '{pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}' +
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
  expect(await postComment(fake({}).run, '12', { ...AT, line: 0 }, 'x')).toEqual({
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
