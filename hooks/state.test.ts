import { expect, test } from 'claude-code/testing'

import type { Diag, GraphRow, Scan, View } from '../types'
import { NO_SCAN, NO_VIEW, changedDiags, comparisonOf, settledView, totalsOf } from './state'

const row = (hash: string, refs: string[]): GraphRow => ({
  hash,
  parents: [],
  refs,
  subject: '',
  when: '',
  author: '',
  cells: [],
  below: [],
  width: 2,
  lane: 0,
})
const diag = (path: string, severity: Diag['severity'], isNew?: boolean): Diag => ({
  path,
  line: 1,
  col: 1,
  endCol: 0,
  severity,
  tool: 't',
  rule: '',
  message: 'm',
  ...(isNew === undefined ? {} : { isNew }),
})

test('state kept from an older version reads with every field', async () => {
  // What a session held before `isMore` and `crumb` existed.
  const old = JSON.parse(JSON.stringify({ ...NO_VIEW, repo: '/repo', isMore: undefined, crumb: undefined })) as View
  const now = settledView(old)

  expect(now.repo).toBe('/repo')
  expect(now.isMore).toBe(false)
  expect(now.crumb.kind).toBe('none')
})

test('a base on the commit checked out is no comparison; a target always is', async () => {
  const found: Scan = { ...NO_SCAN, head: 'main', headHash: 'abc', branches: ['main', 'dev'] }
  const history = [row('abc', ['HEAD -> main']), row('def', ['dev', 'tag: v1'])]

  expect(comparisonOf({ ...NO_VIEW, base: 'HEAD' }, found, history).isComparing).toBe(false)
  expect(comparisonOf({ ...NO_VIEW, base: 'main' }, found, history).isComparing).toBe(false)
  expect(comparisonOf({ ...NO_VIEW, base: 'def' }, found, history)).toEqual({
    headName: 'main',
    side: 'main',
    against: 'dev',
    isComparing: true,
    request: '',
    requestTyped: '',
  })
  expect(
    comparisonOf({ ...NO_VIEW, base: 'v1', target: 'topic', request: 'PR #1', requestTyped: '#1' }, found, history),
  ).toEqual({
    headName: 'main',
    side: 'topic',
    against: 'dev',
    isComparing: true,
    request: 'PR #1',
    requestTyped: '#1',
  })
  expect(comparisonOf(NO_VIEW, { ...NO_SCAN, head: 'HEAD', headHash: 'abc' }, []).headName).toBe('abc')
})

test('the totals count the changed files only, and what is new where that is known', async () => {
  const found: Scan = {
    ...NO_SCAN,
    files: [
      { path: 'a.py', status: 'M' },
      { path: 'b.py', status: '?' },
    ],
    stats: { 'a.py': [3, 1], 'b.py': [10, 0] },
    diags: [diag('a.py', 'error', false), diag('b.py', 'warning', true), diag('other.py', 'error')],
  }
  const inChanged = changedDiags(found)

  expect(inChanged.map(one => one.path)).toEqual(['a.py', 'b.py'])
  expect(totalsOf(found, inChanged)).toEqual({ files: 2, added: 13, deleted: 1, errors: 1, others: 1, fresh: 1 })
  expect(totalsOf(NO_SCAN, []).fresh).toBe(undefined)
})
