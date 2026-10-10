import { expect, test } from 'claude-code/testing'

import { findingComments, isFinding } from './ledger'

const finding = (id: number, path: string, line?: number, status: 'open' | 'fixed' = 'open') => ({
  id,
  path,
  severity: 'warning' as const,
  summary: `problem ${id}`,
  task: 'T1',
  at: 0,
  status,
  ...(line !== undefined ? { line } : {}),
})

test('with no ledger run there are no findings', () => {
  expect(findingComments(undefined, '/repo', '/repo', [])).toEqual([])
  expect(findingComments(null, '/repo', '/repo', [])).toEqual([])
})

test('a finding becomes a comment on its line, a fixed one a resolved thread', () => {
  const [open, fixed, whole] = findingComments(
    { findings: [finding(1, 'src/a.ts', 12), finding(2, 'src/a.ts', 30, 'fixed'), finding(3, 'README.md')] },
    '/repo',
    '/repo',
    [],
  )

  expect(open).toEqual({
    id: 'ledger-1',
    path: 'src/a.ts',
    line: 12,
    author: 'ledger warning · T1',
    body: 'problem 1',
    when: '1970-01-01T00:00:00.000Z',
  })
  expect(fixed?.isResolved).toBe(true)
  // No line: a comment on the file as a whole.
  expect(whole?.line).toBe(0)
  expect(open !== undefined && isFinding(open)).toBe(true)
  expect(isFinding({ id: '4109147516', path: '', line: 0, author: 'a', body: 'b', when: '' })).toBe(false)
})

test('a finding’s path is read from the session’s folder, wherever that is against the one reviewed', () => {
  const paths = (path: string, repo: string, root: string, files: string[] = []) =>
    findingComments({ findings: [finding(1, path, 1)] }, repo, root, files).map(one => one.path)

  // The session is in the folder under review, above it, or inside it.
  expect(paths('src/a.ts', '/repo', '/repo')).toEqual(['src/a.ts'])
  expect(paths('repo/src/a.ts', '/repo', '/')).toEqual(['src/a.ts'])
  expect(paths('../src/a.ts', '/repo', '/repo/docs')).toEqual(['src/a.ts'])
  expect(paths('/repo/src/a.ts', '/repo', '/elsewhere')).toEqual(['src/a.ts'])
  // Written from a folder above, by a session that has since moved into the
  // folder under review: the path's own first parts say where it starts.
  expect(paths('.claude/skills/lens/hooks/a.ts', '/home/.claude/skills/lens', '/home/.claude/skills/lens')).toEqual([
    'hooks/a.ts',
  ])
  // Written from somewhere else: a changed file that ends the same is meant.
  expect(paths('mod/src/a.ts', '/repo', '/home', ['src/a.ts'])).toEqual(['src/a.ts'])
  expect(paths('a.ts', '/repo', '/home', ['src/a.ts'])).toEqual(['src/a.ts'])
  // A file of another project is left out.
  expect(paths('other/b.ts', '/repo', '/home', ['src/a.ts'])).toEqual([])
})
