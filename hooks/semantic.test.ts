import { expect, test } from 'claude-code/testing'

import type { Span } from '../types'
import type { InlayHint, OutlineItem, PlaceLine, SemanticToken } from './lsp-types'
import {
  INLAY_COLOR,
  applyInlays,
  applySemantic,
  enclosing,
  foldOf,
  groupPlaces,
  outlineRows,
  placesList,
  semanticColor,
} from './semantic'

const token = (col: number, length: number, type: string, modifiers: string[] = []): SemanticToken => ({
  line: 1,
  col,
  length,
  type,
  modifiers,
})

const hint = (col: number, label: string, kind: InlayHint['kind'] = 'type'): InlayHint => ({
  line: 1,
  col,
  label,
  kind,
})

const item = (name: string, kind: string, line: number, endLine: number, depth: number): OutlineItem => ({
  name,
  kind,
  line,
  endLine,
  col: 1,
  depth,
})

const place = (path: string, line: number, text = 'x', isInRepo = true, col = 1): PlaceLine => ({
  path,
  line,
  col,
  isInRepo,
  text,
})

const joined = (spans: readonly Span[]): string => spans.map(span => span[1]).join('')

test('semantic colours follow Dark Modern', async () => {
  expect(semanticColor('parameter', [])).toBe('#9CDCFE')
  expect(semanticColor('property', ['declaration'])).toBe('#9CDCFE')
  expect(semanticColor('class', [])).toBe('#4EC9B0')
  expect(semanticColor('typeParameter', [])).toBe('#4EC9B0')
  expect(semanticColor('namespace', [])).toBe('#4EC9B0')
  expect(semanticColor('method', ['async'])).toBe('#DCDCAA')
  expect(semanticColor('decorator', [])).toBe('#DCDCAA')
  expect(semanticColor('enumMember', [])).toBe('#4FC1FF')
})

test('a readonly variable or property is a constant, a readonly anything else is not', async () => {
  expect(semanticColor('variable', [])).toBe('#9CDCFE')
  expect(semanticColor('variable', ['declaration', 'readonly'])).toBe('#4FC1FF')
  expect(semanticColor('property', ['readonly'])).toBe('#4FC1FF')
  expect(semanticColor('parameter', ['readonly'])).toBe('#9CDCFE')
})

test('types the tokenizer colours better, and unknown ones, have no colour', async () => {
  expect(semanticColor('keyword', [])).toBe('')
  expect(semanticColor('string', [])).toBe('')
  expect(semanticColor('somethingNew', [])).toBe('')
  expect(semanticColor('constructor', [])).toBe('')
  expect(semanticColor('toString', [])).toBe('')
})

test('a token recolours the span it covers exactly', async () => {
  const spans: Span[] = [
    ['#C586C0', 'def'],
    ['', ' '],
    ['#DCDCAA', 'pay'],
    ['', '('],
    ['#9CDCFE', 'amount'],
    ['', '):'],
  ]
  const out = applySemantic(spans, [token(9, 6, 'parameter'), token(5, 3, 'class')])

  expect(out).toEqual([
    ['#C586C0', 'def'],
    ['', ' '],
    ['#4EC9B0', 'pay'],
    ['', '('],
    ['#9CDCFE', 'amount'],
    ['', '):'],
  ])
})

test('a span partly covered is split in three', async () => {
  expect(applySemantic([['', 'a = total + 1']], [token(5, 5, 'function')])).toEqual([
    ['', 'a = '],
    ['#DCDCAA', 'total'],
    ['', ' + 1'],
  ])
})

test('a token cuts across span boundaries', async () => {
  const out = applySemantic(
    [
      ['#9CDCFE', 'self.re'],
      ['#DCDCAA', 'ceipt'],
      ['', '()'],
    ],
    [token(6, 7, 'method')],
  )

  expect(out).toEqual([
    ['#9CDCFE', 'self.'],
    ['#DCDCAA', 're'],
    ['#DCDCAA', 'ceipt'],
    ['', '()'],
  ])
})

test('columns count a tab as one character, the spans as four', async () => {
  // Real column 3 after two tabs is index 8 of the span text.
  const spans: Span[] = [['', '        x = y']]
  const out = applySemantic(spans, [token(3, 1, 'class'), token(7, 1, 'function')], '\t\tx = y')

  expect(out).toEqual([
    ['', '        '],
    ['#4EC9B0', 'x'],
    ['', ' = '],
    ['#DCDCAA', 'y'],
  ])
})

test('a tab in the middle of the line shifts only what follows it', async () => {
  const out = applySemantic([['', 'a    b']], [token(1, 1, 'class'), token(3, 1, 'function')], 'a\tb')

  expect(out).toEqual([
    ['#4EC9B0', 'a'],
    ['', '    '],
    ['#DCDCAA', 'b'],
  ])
})

test('a control character the highlighter dropped takes no room', async () => {
  expect(applySemantic([['', 'ab']], [token(3, 1, 'class')], 'a\u0001b')).toEqual([
    ['', 'a'],
    ['#4EC9B0', 'b'],
  ])
})

test('without the raw line no tabs are assumed', async () => {
  expect(applySemantic([['', '    x']], [token(5, 1, 'class')])).toEqual([
    ['', '    '],
    ['#4EC9B0', 'x'],
  ])
})

test('a token with no colour leaves the tokenizer colour and makes no cut', async () => {
  const spans: Span[] = [['#C586C0', 'return'], ['', ' x']]

  expect(applySemantic(spans, [token(1, 6, 'keyword'), token(8, 1, 'mystery')])).toEqual(spans)
})

test('comments and strings no token covers keep their colour', async () => {
  const spans: Span[] = [
    ['#9CDCFE', 'name'],
    ['', ' = '],
    ['#CE9178', "'name'"],
    ['', '  '],
    ['#6A9955', '# name'],
  ]
  const out = applySemantic(spans, [token(1, 4, 'variable', ['readonly'])])

  expect(out).toEqual([['#4FC1FF', 'name'], ...spans.slice(1)])
})

test('odd tokens do not throw and never change the text', async () => {
  const spans: Span[] = [['#9CDCFE', 'abc'], ['', ''], ['', ' = 1']]
  const odd = [
    token(0, 2, 'class'),
    token(2, 0, 'function'),
    token(6, 99, 'function'),
    token(50, 3, 'class'),
    token(-4, 2, 'class'),
    token(Number.NaN, 2, 'enumMember'),
    token(3, -5, 'class'),
  ]
  const out = applySemantic(spans, odd, 'abc = 1')

  expect(joined(out)).toBe('abc = 1')
  expect(applySemantic([], odd)).toEqual([])
  expect(applySemantic([['', '']], odd)).toEqual([['', '']])
  expect(applySemantic(spans, [])).toEqual(spans)
})

test('a column of 0 is taken as the start of the line', async () => {
  expect(applySemantic([['', 'abcd']], [token(0, 3, 'class')])).toEqual([
    ['#4EC9B0', 'ab'],
    ['', 'cd'],
  ])
})

test('the input spans are not changed', async () => {
  const spans: Span[] = [['', 'total']]
  const out = applySemantic(spans, [])

  out[0]![1] = 'changed'
  expect(spans).toEqual([['', 'total']])
})

test('a type hint goes after the name, a parameter hint before the argument', async () => {
  const spans: Span[] = [
    ['#9CDCFE', 'total'],
    ['', ' = '],
    ['#DCDCAA', 'pay'],
    ['', '('],
    ['#B5CEA8', '10'],
    ['', ')'],
  ]
  const out = applyInlays(spans, [hint(13, 'amount=', 'parameter'), hint(6, ': int')])

  expect(out.spans).toEqual([
    ['#9CDCFE', 'total'],
    [INLAY_COLOR, ': int'],
    ['', ' = '],
    ['#DCDCAA', 'pay'],
    ['', '('],
    [INLAY_COLOR, 'amount='],
    ['#B5CEA8', '10'],
    ['', ')'],
  ])
  expect(out.isHint).toEqual([false, true, false, false, false, true, false, false])
})

test('a hint inside a span splits it', async () => {
  const out = applyInlays([['', 'x = f(1)']], [hint(7, 'n=', 'parameter')])

  expect(out.spans).toEqual([
    ['', 'x = f('],
    [INLAY_COLOR, 'n='],
    ['', '1)'],
  ])
  expect(out.isHint).toEqual([false, true, false])
})

test('a bare label gets the usual padding, a padded one is left alone', async () => {
  const text = (label: string, kind: InlayHint['kind']): string =>
    applyInlays([], [hint(1, label, kind)]).spans[0]?.[1] ?? ''

  expect(text('int', 'type')).toBe(': int')
  expect(text(': int', 'type')).toBe(': int')
  expect(text(' int', 'type')).toBe(' int')
  expect(text('-> int', 'type')).toBe(' -> int')
  expect(text('amount', 'parameter')).toBe('amount=')
  expect(text('amount=', 'parameter')).toBe('amount=')
  expect(text('amount:', 'parameter')).toBe('amount: ')
  expect(text('amount: ', 'parameter')).toBe('amount: ')
  expect(text('<T>', 'other')).toBe('<T>')
})

test('hint columns are mapped through tabs', async () => {
  const out = applyInlays([['', '    x = 1']], [hint(3, 'int')], '\tx = 1')

  expect(out.spans).toEqual([
    ['', '    x'],
    [INLAY_COLOR, ': int'],
    ['', ' = 1'],
  ])
})

test('hints at one column keep their order, and one past the end goes last', async () => {
  const out = applyInlays([['', 'f(a)']], [hint(99, 'int'), hint(3, 'x', 'parameter'), hint(3, '&', 'other'), hint(0, '!', 'other')])

  expect(out.spans).toEqual([
    [INLAY_COLOR, '!'],
    ['', 'f('],
    [INLAY_COLOR, 'x='],
    [INLAY_COLOR, '&'],
    ['', 'a)'],
    [INLAY_COLOR, ': int'],
  ])
  expect(out.isHint).toEqual([true, false, true, true, false, true])
})

test('hints leave the text of the file whole', async () => {
  const spans: Span[] = [['#9CDCFE', 'ab'], ['', ''], ['', 'cd']]
  const out = applyInlays(spans, [hint(3, 'int'), hint(5, 'str'), hint(2, '', 'other'), hint(Number.NaN, 'q', 'other')])

  expect(joined(out.spans.filter((_, at) => !out.isHint[at]))).toBe('abcd')
  expect(out.spans.length).toBe(out.isHint.length)
  expect(out.spans.filter((_, at) => out.isHint[at]).map(span => span[1])).toEqual(['q', ': int', ': str'])
})

test('no hints, or an empty line, is no trouble', async () => {
  expect(applyInlays([], [])).toEqual({ spans: [], isHint: [] })
  expect(applyInlays([['', 'a']], [])).toEqual({ spans: [['', 'a']], isHint: [false] })
  expect(applyInlays([], [hint(1, 'int')])).toEqual({ spans: [[INLAY_COLOR, ': int']], isHint: [true] })
})

const outline: OutlineItem[] = [
  item('TAX', 'constant', 1, 1, 0),
  item('Receipt', 'class', 3, 20, 0),
  item('total', 'property', 4, 4, 1),
  item('describe', 'method', 6, 12, 1),
  item('line', 'variable', 7, 7, 2),
  item('pay', 'method', 14, 20, 1),
  item('main', 'function', 22, 30, 0),
]

test('a fold is the item that starts on the line', async () => {
  expect(foldOf(outline, 3)).toEqual({ from: 3, to: 20 })
  expect(foldOf(outline, 6)).toEqual({ from: 6, to: 12 })
  expect(foldOf(outline, 7)).toEqual({ from: 7, to: 7 })
  expect(foldOf(outline, 8)).toBe(undefined)
  expect(foldOf([], 1)).toBe(undefined)
})

test('of two items starting on a line the fold is the inner one', async () => {
  const nested = [item('Box', 'class', 5, 9, 0), item('open', 'method', 5, 6, 1)]

  expect(foldOf(nested, 5)).toEqual({ from: 5, to: 6 })
  expect(foldOf([...nested].reverse(), 5)).toEqual({ from: 5, to: 6 })
  // An end before the start is not a fold going backwards.
  expect(foldOf([item('odd', 'function', 5, 2, 0)], 5)).toEqual({ from: 5, to: 5 })
})

test('the breadcrumb is the chain around a line, outermost first', async () => {
  expect(enclosing(outline, 8).map(one => one.name)).toEqual(['Receipt', 'describe'])
  expect(enclosing(outline, 7).map(one => one.name)).toEqual(['Receipt', 'describe', 'line'])
  expect(enclosing(outline, 13).map(one => one.name)).toEqual(['Receipt'])
  expect(enclosing(outline, 20).map(one => one.name)).toEqual(['Receipt', 'pay'])
  expect(enclosing(outline, 2)).toEqual([])
  expect(enclosing(outline, 99)).toEqual([])
  expect(enclosing([], 1)).toEqual([])
})

test('outline rows are indented, marked and ranged', async () => {
  expect(outlineRows(outline).map(row => row.label)).toEqual([
    'c TAX 1',
    'C Receipt 3-20',
    '  v total 4',
    '  ƒ describe 6-12',
    '    v line 7',
    '  ƒ pay 14-20',
    'ƒ main 22-30',
  ])
  expect(outlineRows(outline)[1]?.item).toBe(outline[1])
})

test('every kind has a mark', async () => {
  const mark = (kind: string): string => outlineRows([item('n', kind, 1, 1, 0)])[0]?.label.charAt(0) ?? ''

  expect(['interface', 'enum', 'constructor', 'field', 'module', 'toString', ''].map(mark)).toEqual([
    'I',
    'E',
    'ƒ',
    'v',
    '·',
    '·',
    '·',
  ])
})

test('places are grouped by file, the one under review first', async () => {
  const places = [
    place('/usr/lib/python/typing.py', 9, 'x', false),
    place('b.py', 30),
    place('a.py', 5),
    place('src/pay.py', 12),
    place('b.py', 2),
    place('src/pay.py', 3, 'x', true, 9),
    place('src/pay.py', 3, 'x', true, 2),
  ]
  const grouped = groupPlaces(places, 'src/pay.py')

  expect(grouped.total).toBe(7)
  expect(grouped.files.map(file => [file.path, file.isInRepo, file.places.map(one => one.line)])).toEqual([
    ['src/pay.py', true, [3, 3, 12]],
    ['a.py', true, [5]],
    ['b.py', true, [2, 30]],
    ['/usr/lib/python/typing.py', false, [9]],
  ])
  expect(grouped.files[0]?.places.map(one => one.col)).toEqual([2, 9, 1])
  expect(places[1]?.line).toBe(30)
})

test('no places, or none in the file under review, still groups', async () => {
  expect(groupPlaces([], 'a.py')).toEqual({ total: 0, files: [] })
  expect(groupPlaces([place('b.py', 1)], 'a.py').files.map(file => file.path)).toEqual(['b.py'])
})

test('the list for the prompt is a line a place, capped', async () => {
  const places = [place('a.py', 3, '  total =\tpay(1)  ', true, 5), place('b.py', 7, 'pay(2)'), place('b.py', 9, 'pay(3)')]

  expect(placesList('pay', places, 2)).toBe(
    ['`pay` is used in 3 places:', '- a.py:3:5 total = pay(1)', '- b.py:7:1 pay(2)', '- … and 1 more'].join('\n'),
  )
  expect(placesList('pay', places, 3).split('\n').length).toBe(4)
  expect(placesList('pay', places.slice(0, 1), 5)).toBe('`pay` is used in 1 place:\n- a.py:3:5 total = pay(1)')
  expect(placesList('pay', places, 0)).toBe('`pay` is used in 3 places:\n- … and 3 more')
  expect(placesList('pay', [], 5)).toBe('No uses of `pay` found.')
})
