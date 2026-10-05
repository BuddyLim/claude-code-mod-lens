import { expect, test } from 'claude-code/testing'

import { chunkMarkdown, foldEnd, wrapText } from './text'

test('a fold runs to the end of its block, and a plain line is its own fold', async () => {
  const texts = ['function total(list) {', '  const sum = 0', '', '  return sum', '}', 'total([])']

  expect(foldEnd(texts, 1)).toBe(5)
  expect(foldEnd(texts, 2)).toBe(2)
  expect(foldEnd(['def a():', '    return 1', '', 'def b():'], 1)).toBe(2)
})

test('text wraps between words and keeps its blank lines', async () => {
  expect(wrapText('the body is where the why goes\n\nsecond', 12)).toEqual([
    'the body is',
    'where the',
    'why goes',
    '',
    'second',
  ])
  expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrapText('  \n', 10)).toEqual([])
})

test('markdown is cut at blank lines, and a cut fence is closed and reopened', async () => {
  expect(chunkMarkdown('# One\n\nfirst paragraph\n\nsecond paragraph', 30)).toEqual([
    '# One\n\nfirst paragraph\n',
    'second paragraph',
  ])
  expect(chunkMarkdown('```py\naaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n```', 30)).toEqual([
    '```py\naaaaaaaaaa\nbbbbbbbbbb\n```',
    '```py\ncccccccccc\n```',
  ])
  expect(chunkMarkdown('short', 100)).toEqual(['short'])
})
