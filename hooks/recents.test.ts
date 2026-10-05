import { expect, test } from 'claude-code/testing'

import type { Recent } from '../types'
import {
  RECENTS,
  agoOf,
  cleanUp,
  comparisonLabel,
  groupRecents,
  recentOf,
  remember,
  settledRecents,
} from './recents'
import { NO_VIEW } from './state'

const one = (repo: string, at = 1): Recent => ({
  repo,
  base: 'HEAD',
  target: '',
  request: '',
  requestTyped: '',
  layout: 'tree',
  isBrowsing: false,
  at,
  home: '',
})

test('a review is kept with its comparison and layout', () => {
  expect(recentOf({ ...NO_VIEW, repo: '/a', base: 'main', layout: 'list' }, 7)).toEqual({
    ...one('/a', 7),
    base: 'main',
    layout: 'list',
  })
})

test('a request is only kept while its comparison is on', () => {
  const kept = recentOf({ ...NO_VIEW, repo: '/a', request: 'PR #12', requestTyped: '#12' }, 1)

  expect(kept.request).toBe('')
  expect(kept.requestTyped).toBe('')
})

test('the latest review of a repo replaces the one before and goes first', () => {
  expect(remember([one('/a'), one('/b')], one('/b', 5)).map(each => [each.repo, each.at])).toEqual([
    ['/b', 5],
    ['/a', 1],
  ])
})

test('the list is capped', () => {
  const many = Array.from({ length: RECENTS + 5 }, (_, at) => one(`/r${at}`))

  expect(remember(many, one('/new'))).toHaveLength(RECENTS)
})

test('a store that holds something else reads as what of it is a review', () => {
  expect(settledRecents('nonsense')).toEqual([])
  expect(settledRecents([null, 3, { repo: 'relative' }, { repo: '/a', layout: 'grid' }])).toEqual([
    { ...one('/a', 0) },
  ])
})

test('a review says what it was comparing', () => {
  expect(comparisonLabel(one('/a'))).toBe('uncommitted changes')
  expect(comparisonLabel({ ...one('/a'), base: 'main' })).toBe('working tree vs main')
  expect(comparisonLabel({ ...one('/a'), base: 'main', target: 'dev' })).toBe('dev vs main')
  expect(comparisonLabel({ ...one('/a'), target: 'x', request: 'PR #12 → main' })).toBe(
    'PR #12 → main',
  )
})

test('how long ago reads in minutes, hours and days', () => {
  const now = 10 * 24 * 3_600_000

  expect(agoOf(now - 20_000, now)).toBe('just now')
  expect(agoOf(now - 5 * 60_000, now)).toBe('5 min ago')
  expect(agoOf(now - 3 * 3_600_000, now)).toBe('3 h ago')
  expect(agoOf(now - 2 * 24 * 3_600_000, now)).toBe('2 d ago')
})

test('cleaning up is one command, given each repo once', async () => {
  const ran: string[][] = []

  await cleanUp(
    async argv => {
      ran.push(argv)

      return { exitCode: 0, stdout: '', stderr: '' }
    },
    ['/a', '/b', '/a', ''],
  )

  expect(ran).toHaveLength(1)
  expect(ran[0]?.slice(3)).toEqual(['sh', '/a', '/b'])
})

test('the worktrees of one repo are listed together, under it', () => {
  const list = [
    { ...one('/code/app/wt/fix', 9), home: '/code/app' },
    one('/code/other', 8),
    { ...one('/code/app', 7), home: '/code/app' },
  ]

  expect(groupRecents(list).map(group => [group.home, group.reviews.map(each => each.repo)])).toEqual([
    ['/code/app', ['/code/app/wt/fix', '/code/app']],
    ['/code/other', ['/code/other']],
  ])
})

test('a comparison with a worktree is not kept: its snapshot does not last', () => {
  expect(recentOf({ ...NO_VIEW, repo: '/a', base: 'abc123', baseWorktree: '/a/wt/x' }, 1).base).toBe('HEAD')
})
