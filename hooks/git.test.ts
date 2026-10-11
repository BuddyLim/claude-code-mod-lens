import { expect, test } from 'claude-code/testing'

import {
  ageOf,
  layoutGraph,
  parseBlame,
  parseChangedLines,
  parseCommits,
  parseLineCounts,
  parseNameStatus,
  parseNumstat,
  parseRemoved,
  parseRemovedAt,
  parseWorktrees,
  sumStats,
} from './git'
import * as git from './git'
import type { Ran, Run } from './run'

// A `run` that answers each command from a table keyed by a word of it, and
// keeps what it was asked.
const fakeRun = (answers: Record<string, Partial<Ran>>): { run: Run; asked: string[][] } => {
  const asked: string[][] = []

  return {
    asked,
    run: async argv => {
      asked.push(argv)

      const hit = Object.keys(answers).find(word => argv.includes(word))

      return { exitCode: 0, stdout: '', stderr: '', ...(hit === undefined ? {} : answers[hit]) }
    },
  }
}

test('name-status keeps the new path of a rename', async () => {
  expect(parseNameStatus('M\tapp/a.py\nR100\told.py\tnew.py\n')).toEqual([
    { path: 'app/a.py', status: 'M' },
    { path: 'new.py', status: 'R' },
  ])
})

test('changed lines come from the added side of each hunk', async () => {
  const out = [
    'diff --git a.py a.py',
    '--- a.py',
    '+++ a.py',
    '@@ -3 +3,2 @@',
    '+x',
    '+y',
    '@@ -10,2 +11,0 @@',
    '@@ -20 +19 @@',
  ].join('\n')

  expect(parseChangedLines(out)).toEqual({
    'a.py': [
      [3, 4],
      [19, 19],
    ],
  })
})

test('line counts and the commit graph parse', async () => {
  expect(parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png\n')).toEqual({
    'src/a.ts': [12, 3],
    'logo.png': [0, 0],
  })
  expect(parseLineCounts('      40 new.py\n       2 b.py\n      42 total\n')).toEqual({
    'new.py': [40, 0],
    'b.py': [2, 0],
  })
  expect(sumStats([[12, 3], [40, 0]])).toEqual([52, 3])
  expect(parseCommits('abc\u0001d1 d2\u0001HEAD -> main, tag: v1\u0001add graph\u00012 hours ago\u0001Tar\n')).toEqual([
    {
      hash: 'abc',
      parents: ['d1', 'd2'],
      refs: ['HEAD -> main', 'tag: v1'],
      subject: 'add graph',
      when: '2 hours ago',
      author: 'Tar',
    },
  ])
})

test('a merge opens a lane and the shared parent closes it', async () => {
  const commit = (hash: string, parents: string[]) => ({
    hash,
    parents,
    refs: [],
    subject: '',
    when: '',
    author: '',
  })
  const rows = layoutGraph([
    commit('m', ['a', 'b']),
    commit('b', ['c']),
    commit('a', ['c']),
    commit('c', []),
  ])

  expect(rows.map(row => row.cells.map(cell => cell[1]).join(''))).toEqual([
    '●─╮ ',
    '│ ● ',
    '● │ ',
    '●─╯ ',
  ])
  expect(rows.map(row => row.lane)).toEqual([0, 1, 0, 0])
  expect(rows.map(row => row.below.map(cell => cell[1]).join(''))).toEqual([
    '│ │ ',
    '│ │ ',
    '│ │ ',
    '',
  ])
})

test('removed lines sit before the new line they came before', async () => {
  const out = [
    '--- a.py',
    '+++ a.py',
    '@@ -3,2 +3 @@',
    '-old three',
    '-old four',
    '+new three',
    '@@ -10 +8,0 @@',
    '-dropped',
  ].join('\n')

  expect(parseRemoved(out)).toEqual({ 3: ['old three', 'old four'], 9: ['dropped'] })
  // And where the first of each run was in the base: the rest follow it.
  expect(parseRemovedAt(out)).toEqual({ 3: 3, 9: 10 })
  // A hunk that only adds has no old lines to number.
  expect(parseRemovedAt('@@ -5,0 +6,2 @@\n+a\n+b')).toEqual({})
})

test('blame gives each line its commit, and ages read short', async () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const out = [
    `${a} 1 1 2`,
    'author Tar',
    'author-time 1700000000',
    'summary first',
    'filename x.py',
    '\tline one',
    `${a} 2 2`,
    '\tline two',
    `${b} 3 3 1`,
    'author Kay',
    'author-time 1800000000',
    'summary second',
    '\tline three',
  ].join('\n')

  expect(parseBlame(out).map(line => [line.hash.slice(0, 1), line.author, line.summary])).toEqual([
    ['a', 'Tar', 'first'],
    ['a', 'Tar', 'first'],
    ['b', 'Kay', 'second'],
  ])
  expect([30, 300, 7200, 259_200, 5_184_000, 63_072_000].map(ageOf)).toEqual([
    'now',
    '5m',
    '2h',
    '3d',
    '2mo',
    '2y',
  ])
})

test('the history starts with the uncommitted row, grey down to the commit checked out', async () => {
  const rows = git.layoutHistory(
    [
      { hash: 'b', parents: ['a'], refs: [], subject: 'two', when: '', author: '' },
      { hash: 'a', parents: [], refs: [], subject: 'one', when: '', author: '' },
    ],
    'b',
  )

  expect(rows.map(row => row.hash)).toEqual([git.UNCOMMITTED, 'b', 'a'])
  expect(rows[0]?.cells[0]?.[0]).toBe('#8b949e')
  expect(rows[1]?.cells[0]?.[0]).toBe(git.laneColor(0))
})

test('a comparison of two commits leaves the working tree out', async () => {
  const { run, asked } = fakeRun({
    '--name-status': { stdout: 'M\ta.py\n' },
    '--others': { stdout: 'new.py\n' },
    '--name-only': { stdout: 'a.py\n' },
    '--abbrev-ref': { stdout: 'main\n' },
  })
  const tree = await git.readChanges(run, '/repo', 'HEAD', '')
  const pair = await git.readChanges(run, '/repo', 'main', 'topic')

  expect(tree.files).toEqual([
    { path: 'a.py', status: 'M' },
    { path: 'new.py', status: '?' },
  ])
  expect(tree.dirty).toEqual(['a.py'])
  expect(tree.head).toBe('main')
  expect(tree.refusal).toBe(undefined)
  expect(pair.files).toEqual([{ path: 'a.py', status: 'M' }])
  expect(pair.dirty).toEqual([])
  expect(asked).toContainEqual(['git', 'diff', '--name-status', '--relative', 'main', 'topic'])
})

test('a comparison git cannot read says why', async () => {
  const { run } = fakeRun({ '--name-status': { exitCode: 128, stderr: 'fatal: bad revision\n' } })

  expect((await git.readChanges(run, '/repo', 'nope', '')).refusal).toBe('fatal: bad revision')
})

test('a commit adds its files first, and stops where git refuses', async () => {
  const fine = fakeRun({})
  const refused = fakeRun({ add: { exitCode: 1, stderr: 'fatal: pathspec\n' } })

  expect(await git.commit(fine.run, '/repo', ['a.py'], ' subject ', 'why')).toBe('')
  expect(fine.asked).toEqual([
    ['git', 'add', '--', 'a.py'],
    ['git', 'commit', '-m', 'subject', '-m', 'why', '--', 'a.py'],
  ])
  expect(await git.commit(refused.run, '/repo', ['a.py'], 'subject', '')).toBe(
    'git add did not go through: fatal: pathspec',
  )
  expect(refused.asked).toHaveLength(1)
})

test('an export that fails has no folder, and a file never committed has no blame', async () => {
  const { run } = fakeRun({
    sh: { exitCode: 1, stderr: 'tar: broken\n' },
    blame: { exitCode: 128, stderr: 'fatal: no such path a.py in HEAD' },
  })

  expect(await git.exportCommit(run, '/repo', 'main', 'abc', 'abc')).toEqual({
    dir: '',
    refusal: 'tar: broken',
  })
  expect(await git.blame(run, '/repo', 'a.py', '', async () => 0)).toEqual({ lines: [] })
})

test('worktrees are read with the branch each has checked out', () => {
  expect(
    parseWorktrees(
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt/fix\nHEAD def\nbranch refs/heads/fix/a-b\n\nworktree /repo/wt/old\nHEAD 123\ndetached\n',
    ),
  ).toEqual([
    { path: '/repo', branch: 'main', head: 'abc' },
    { path: '/repo/wt/fix', branch: 'fix/a-b', head: 'def' },
    { path: '/repo/wt/old', branch: '', head: '123' },
  ])
})
