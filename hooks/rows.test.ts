import { expect, test } from 'claude-code/testing'

import { rowsBelow, rowsOf } from './rows'

const el = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props, children })

test('a tree’s rows are counted by how it is laid out', () => {
  const tree = el(
    'Box',
    { flexDirection: 'column' },
    el('Text', { wrap: 'truncate-end' }, 'x'.repeat(500)),
    // Text that wraps fills as many rows as it needs.
    el('Text', null, 'y'.repeat(45)),
    false,
    // A row is as tall as its tallest, and a fixed height is what it says.
    el('Box', null, el('Text', null, 'a'), el('Button', { label: 'go' })),
    el('Box', { height: 4, flexDirection: 'column' }, el('Text', null, 'a'), el('Text', null, 'b')),
    // A border is a row above and below; a margin is its own rows.
    el('Box', { flexDirection: 'column', borderStyle: 'round', marginY: 1 }, el('Text', null, 'in')),
    [el('Text', null, 'one'), el('Text', null, 'two')],
    el('Image', { rows: 6, columns: 10 }),
    // What is laid over the rest takes none.
    el('Box', { position: 'absolute', top: 3 }, el('Text', null, 'over')),
  )

  expect(rowsOf(tree, 20)).toBe(1 + 3 + 1 + 4 + 5 + 2 + 6)
  // A row that wraps is as many rows as its buttons fill.
  expect(rowsOf(el('Box', { flexWrap: 'wrap', columnGap: 2 }, ...Array.from({ length: 6 }, () => el('Button', { plain: true, label: 'refresh' }))), 20)).toBe(3)
})

test('what is below the window is the estimate until the engine has counted the same drawing', () => {
  expect(rowsBelow(100, { offset: 0, rows: 30 }, undefined)).toEqual({ below: 70, isExact: false })
  expect(rowsBelow(100, { offset: 10, rows: 30 }, { content: 96, estimate: 100 })).toEqual({ below: 56, isExact: true })
  // The drawing changed since it was counted: back to the estimate.
  expect(rowsBelow(120, { offset: 10, rows: 30 }, { content: 96, estimate: 100 })).toEqual({ below: 80, isExact: false })
  // At the end, or where everything fits, there is nothing below.
  expect(rowsBelow(20, { offset: 0, rows: 30 }, undefined).below).toBe(0)
  expect(rowsBelow(100, { offset: 66, rows: 30 }, { content: 96, estimate: 100 }).below).toBe(0)
})
