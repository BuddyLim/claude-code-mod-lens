import { expect, test } from 'claude-code/testing'

import { callsList, lookupOf, namesList, usesList } from './lists'

const place = (path: string, line: number) => ({ path, line, col: 1, isInRepo: true })

test('uses are listed under their file, with a form for the prompt', async () => {
  const list = usesList('total', 'a.py', [
    { ...place('a.py', 3), text: 'def total():' },
    { ...place('b.py', 12), text: 'total()' },
  ])

  expect(list.title).toBe('2 uses of total')
  expect(list.rows.filter(row => row.path === '').map(row => row.label)).toEqual(['a.py  (1)', 'b.py  (1)'])
  expect(list.rows.find(row => row.path === 'b.py')).toEqual({
    label: '    12: total()',
    path: 'b.py',
    line: 12,
  })
  expect(list.prompt).toContain('total')
})

test('callers, callees and matching names are rows to jump from', async () => {
  const call = { name: 'main', kind: 'function', place: place('src/app/run.py', 7), detail: 'run.py' }

  expect(callsList('total', 'incoming', [call])).toEqual({
    title: 'What calls total',
    rows: [{ label: 'main  app/run.py:7  run.py', path: 'src/app/run.py', line: 7 }],
    prompt: '',
  })
  expect(callsList('total', 'outgoing', []).title).toBe('What total calls')
  expect(
    namesList('tot', [{ name: 'total', kind: 'function', container: 'math', place: place('src/m.py', 2) }]).rows[0],
  ).toMatchObject({ label: 'total', mark: '›', tail: 'function in math · src/m.py', line: 2 })
})

test('a looked-up name keeps where it is defined and marks the argument being given', async () => {
  const symbol = lookupOf('a.py', 'total', 4, 9, {
    text: 'def total(items)\u0007',
    notes: [],
    definition: place('a.py', 1),
    signature: { label: 'total(items, start)', parameters: ['items', 'start'], active: 1, docs: '' },
  })

  expect(symbol).toMatchObject({
    file: 'a.py',
    at: 4,
    col: 9,
    text: 'def total(items)',
    path: 'a.py',
    line: 1,
    typePath: '',
    hasImplementations: false,
    signature: '(items, [start])',
  })
})
