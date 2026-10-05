import { expect, test } from 'claude-code/testing'

import { markSpans } from './parts'
import { findMatches } from './text'

test('a diagnostic range splits the spans it crosses', async () => {
  const parts = markSpans(
    [
      ['#C586C0', 'return '],
      ['#9CDCFE', 'json.load'],
      ['', '(path)'],
    ],
    [[13, 19]],
  )

  expect(parts.map(part => [part.text, part.isMarked])).toEqual([
    ['return ', false],
    ['json.', false],
    ['load', true],
    ['(p', true],
    ['ath)', false],
  ])
})

test('a search finds every match whatever its case, and lights its columns', async () => {
  const matches = findMatches(['const Load = load()', 'none'], 'load')

  expect(matches).toEqual([
    { line: 1, from: 7, to: 11 },
    { line: 1, from: 14, to: 18 },
  ])
  expect(
    markSpans([['', 'const Load = load()']], [], [[7, 11]]).map(part => [part.text, part.isFound]),
  ).toEqual([
    ['const ', false],
    ['Load', true],
    [' = load()', false],
  ])
  expect(findMatches(['abc'], '')).toEqual([])
})
