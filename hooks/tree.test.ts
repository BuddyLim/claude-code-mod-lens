import { expect, test } from 'claude-code/testing'

import { buildTree, iconOf, visibleTree } from './tree'

test('the tree folds single-folder chains and hides what a closed folder holds', async () => {
  const rows = buildTree(['frontend/src/ui/a.tsx', 'frontend/src/ui/b.tsx', 'frontend/src/App.tsx', 'README.md'])

  expect(rows.map(row => [row.kind, row.name, row.depth])).toEqual([
    ['dir', 'frontend/src', 0],
    ['dir', 'ui', 1],
    ['file', 'a.tsx', 2],
    ['file', 'b.tsx', 2],
    ['file', 'App.tsx', 1],
    ['file', 'README.md', 0],
  ])
  expect(visibleTree(rows, ['frontend/src/ui']).map(({ row }) => row.name)).toEqual([
    'frontend/src',
    'ui',
    'App.tsx',
    'README.md',
  ])
})

test('icons follow the file type', async () => {
  expect(['app/a.py', 'src/App.tsx', 'src/a.ts', 'LICENSE'].map(path => iconOf(path).glyph)).toEqual([
    '\u{e73c}',
    '\u{e7ba}',
    '\u{e628}',
    '\u{f15b}',
  ])
})
