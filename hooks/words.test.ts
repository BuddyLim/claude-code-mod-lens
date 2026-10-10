import { expect, test } from 'claude-code/testing'

import { changedWords } from './words'

const cut = (text: string, stretches: readonly [number, number][]): string[] =>
  stretches.map(([from, to]) => text.slice(from, to))

test('the words that differ between a removed line and its replacement are found', async () => {
  const before = '  const limit = 300'
  const after = '  const limit = 3000 // rows'
  const found = changedWords(before, after)

  expect(cut(before, found.before)).toEqual(['300'])
  expect(cut(after, found.after)).toEqual(['3000 // rows'])

  // A word put in, with nothing taken out.
  const more = changedWords('call(a, b)', 'call(a, b, c)')

  expect(more.before).toEqual([])
  expect(cut('call(a, b, c)', more.after)).toEqual([', c'])

  // A name changed in two places is two stretches.
  const renamed = changedWords('if (item) use(item)', 'if (entry) use(entry)')

  expect(cut('if (item) use(item)', renamed.before)).toEqual(['item', 'item'])
  expect(cut('if (entry) use(entry)', renamed.after)).toEqual(['entry', 'entry'])
})

test('lines that share too little are left as two whole lines', async () => {
  expect(changedWords('return one', 'throw new Error("no")')).toEqual({ before: [], after: [] })
  // Nearly every word changed: lighting all of it says nothing more.
  expect(changedWords('a = b + c', 'x = y - z')).toEqual({ before: [], after: [] })
  expect(changedWords('', 'anything')).toEqual({ before: [], after: [] })
  // The same line has nothing to light.
  expect(changedWords('same(line)', 'same(line)')).toEqual({ before: [], after: [] })
})
