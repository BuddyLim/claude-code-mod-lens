import { expect, test } from 'claude-code/testing'

import { chunkMarkdown, foldEnd, wrapText, splitMarkdown, tableWidths } from './text'

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

test('markdown is cut at its tables, which become cells', () => {
  const pieces = splitMarkdown(
    ['# Title', '', '| Language | Server |', '| --- | --- |', '| Go | `gopls` |', '', 'After.'].join('\n'),
  )

  expect(pieces).toEqual([
    { kind: 'text', text: '# Title\n' },
    {
      kind: 'table',
      header: [
        { text: 'Language', isCode: false },
        { text: 'Server', isCode: false },
      ],
      rows: [
        [
          { text: 'Go', isCode: false },
          { text: 'gopls', isCode: true },
        ],
      ],
    },
    { kind: 'text', text: '\nAfter.' },
  ])
})

test('a table inside a code fence stays text', () => {
  const fenced = ['```', '| a | b |', '| --- | --- |', '```'].join('\n')

  expect(splitMarkdown(fenced)).toEqual([{ kind: 'text', text: fenced }])
})

test('a table too wide for its room takes it from the widest columns', () => {
  const cell = (text: string) => ({ text, isCode: false })
  const rows = [[cell('Go'), cell('x'.repeat(60)), cell('y'.repeat(30))]]

  expect(tableWidths(rows, 200, 3)).toEqual([3, 60, 30])
  expect(tableWidths(rows, 60, 3).reduce((sum, width) => sum + width, 0)).toBe(54)
  expect(tableWidths(rows, 60, 3)[0]).toBe(3)
})
