import type { Span } from '../types'
import type { InlayHint, OutlineItem, PlaceLine, SemanticToken } from './lsp-types'

// What VS Code's Dark Modern (Dark+) theme gives each semantic token type, by
// way of the TextMate scope VS Code maps the type to. The types the tokenizer
// already colours well (keyword, comment, string, number, operator, regexp) are
// left out on purpose: it tells the two keyword colours apart and a server
// does not.
const TYPE_COLORS: Record<string, string> = {
  namespace: '#4EC9B0',
  type: '#4EC9B0',
  class: '#4EC9B0',
  struct: '#4EC9B0',
  interface: '#4EC9B0',
  enum: '#4EC9B0',
  typeParameter: '#4EC9B0',
  function: '#DCDCAA',
  method: '#DCDCAA',
  macro: '#DCDCAA',
  decorator: '#DCDCAA',
  variable: '#9CDCFE',
  parameter: '#9CDCFE',
  property: '#9CDCFE',
  event: '#9CDCFE',
  enumMember: '#4FC1FF',
  label: '#C8C8C8',
  // Pylance's own names for `self` and `cls`.
  selfParameter: '#9CDCFE',
  clsParameter: '#9CDCFE',
}

const CONSTANT_COLOR = '#4FC1FF'

// The colour VS Code's Dark Modern theme gives a semantic token, or '' to leave
// the tokenizer's colour as it is. A readonly variable or property is a
// constant; no other modifier changes a colour in this theme. Own keys only:
// a type named 'constructor' must not find something on Object.prototype.
export const semanticColor = (type: string, modifiers: readonly string[]): string =>
  (type === 'variable' || type === 'property') && modifiers.includes('readonly')
    ? CONSTANT_COLOR
    : Object.hasOwn(TYPE_COLORS, type)
      ? (TYPE_COLORS[type] ?? '')
      : ''

// How many characters of span text a character of the file's own text became:
// the highlighter draws a tab as four spaces and drops other control characters.
const widthOf = (char: string): number =>
  char === '\t' ? 4 : char < ' ' || char === '\u007f' ? 0 : 1

// Maps a 1-based column of the file's text to a 0-based index into the line's
// span text. Without the raw line, or past its end, a character is one wide.
const indexer = (rawLine: string | undefined): ((col: number) => number) => {
  const starts = [0]

  for (const char of rawLine ?? '') {
    for (let unit = 0; unit < char.length; unit += 1) {
      starts.push((starts[starts.length - 1] ?? 0) + (unit === 0 ? widthOf(char) : 1))
    }
  }

  const end = starts[starts.length - 1] ?? 0

  return col => {
    const at = Number.isFinite(col) ? Math.max(0, Math.floor(col) - 1) : 0

    return starts[at] ?? end + (at - (starts.length - 1))
  }
}

// One line's spans recoloured by the semantic tokens on that line. A span is
// split where a token starts or ends; only colours change, never text, and
// text no token covers (or whose token has no colour) keeps the tokenizer's.
export const applySemantic = (
  spans: readonly Span[],
  tokens: readonly SemanticToken[],
  rawLine?: string,
): Span[] => {
  const indexOf = indexer(rawLine)
  const ranges = tokens.flatMap(token => {
    const color = semanticColor(token.type, token.modifiers ?? [])
    const from = indexOf(token.col)
    const to = indexOf(token.col + Math.max(0, token.length))

    return color !== '' && to > from ? [{ from, to, color }] : []
  })

  if (ranges.length === 0) {
    return spans.map(([color, text]) => [color, text])
  }

  const out: Span[] = []
  let offset = 0

  for (const [color, text] of spans) {
    const cuts = new Set([0, text.length])

    for (const range of ranges) {
      for (const edge of [range.from - offset, range.to - offset]) {
        if (edge > 0 && edge < text.length) {
          cuts.add(edge)
        }
      }
    }

    const edges = [...cuts].sort((a, b) => a - b)

    if (text === '') {
      out.push([color, text])
    }

    edges.slice(0, -1).forEach((from, at) => {
      const start = offset + from
      const hit = ranges.find(range => start >= range.from && start < range.to)

      out.push([hit?.color ?? color, text.slice(from, edges[at + 1])])
    })
    offset += text.length
  }

  return out
}

// VS Code Dark Modern's editorInlayHint.foreground.
export const INLAY_COLOR = '#969696'

// A hint as it reads in the code. Servers send the label bare and say "pad
// this side" apart from it, so the padding is put back: ': int' after a name,
// ' -> int' after a signature, 'amount=' before an argument.
const hintText = (hint: InlayHint): string => {
  const label = String(hint.label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')

  if (label.trim() === '') {
    return ''
  }

  if (hint.kind === 'type') {
    return /^[\s:]/.test(label) ? label : label.startsWith('->') ? ` ${label}` : `: ${label}`
  }

  if (hint.kind === 'parameter') {
    return /[\s=]$/.test(label) ? label : label.endsWith(':') ? `${label} ` : `${label}=`
  }

  return label
}

// One line's spans with the server's inlay hints put in where they sit, each a
// span of its own in INLAY_COLOR. `isHint` runs alongside `spans`, one flag a
// span: true for a hint, which is not text of the file.
export const applyInlays = (
  spans: readonly Span[],
  hints: readonly InlayHint[],
  rawLine?: string,
): { spans: Span[]; isHint: boolean[] } => {
  const indexOf = indexer(rawLine)
  // Sorting is stable, so hints at one column keep the server's order.
  const placed = hints
    .map(hint => ({ at: indexOf(hint.col), text: hintText(hint) }))
    .filter(hint => hint.text !== '')
    .sort((a, b) => a.at - b.at)
  const out: Span[] = []
  const isHint: boolean[] = []
  let next = 0
  let offset = 0

  const push = (color: string, text: string, hinted: boolean): void => {
    out.push([color, text])
    isHint.push(hinted)
  }

  for (const [color, text] of spans) {
    let done = 0

    for (let hint = placed[next]; hint !== undefined && hint.at < offset + text.length; hint = placed[next]) {
      const cut = Math.max(done, hint.at - offset)

      if (cut > done) {
        push(color, text.slice(done, cut), false)
      }

      push(INLAY_COLOR, hint.text, true)
      done = cut
      next += 1
    }

    if (done < text.length || text === '') {
      push(color, text.slice(done), false)
    }

    offset += text.length
  }

  // A hint at or past the end of the line goes after its last character.
  for (const hint of placed.slice(next)) {
    push(INLAY_COLOR, hint.text, true)
  }

  return { spans: out, isHint }
}

// The innermost outline item that starts on `line`, as the fold a press on
// that line means: its first and last line.
export const foldOf = (
  items: readonly OutlineItem[],
  line: number,
): { from: number; to: number } | undefined => {
  const inner = items
    .filter(item => item.line === line)
    .reduce<OutlineItem | undefined>(
      (best, item) => (best === undefined || item.depth > best.depth ? item : best),
      undefined,
    )

  return inner === undefined ? undefined : { from: line, to: Math.max(line, inner.endLine) }
}

// The chain of outline items that contain `line`, outermost first, for a
// breadcrumb. Items come parent before child, so each one deeper than the
// chain's last extends it; of two items side by side on a line the first wins.
export const enclosing = (items: readonly OutlineItem[], line: number): OutlineItem[] => {
  const chain: OutlineItem[] = []

  for (const item of items) {
    if (line >= item.line && line <= item.endLine && item.depth > (chain[chain.length - 1]?.depth ?? -1)) {
      chain.push(item)
    }
  }

  return chain
}

const KIND_MARKS: Record<string, string> = {
  function: 'ƒ',
  method: 'ƒ',
  constructor: 'ƒ',
  class: 'C',
  interface: 'I',
  enum: 'E',
  variable: 'v',
  property: 'v',
  field: 'v',
  constant: 'c',
}

// Own keys only: a kind named 'constructor' or 'toString' must not find
// something on Object.prototype.
const markOf = (kind: string): string => (Object.hasOwn(KIND_MARKS, kind) ? (KIND_MARKS[kind] ?? '·') : '·')

// The outline as rows to list: indent, a mark for the kind, the name and the
// lines it spans.
export const outlineRows = (items: readonly OutlineItem[]): { item: OutlineItem; label: string }[] =>
  items.map(item => ({
    item,
    label: `${'  '.repeat(Math.max(0, item.depth))}${markOf(item.kind)} ${item.name} ${
      item.endLine > item.line ? `${item.line}-${item.endLine}` : item.line
    }`,
  }))

// Places grouped by file for a list: the file under review first, then the
// repo's other files, then files outside it, each group by path; a file's
// places by line.
export const groupPlaces = (
  places: readonly PlaceLine[],
  current: string,
): { total: number; files: { path: string; isInRepo: boolean; places: PlaceLine[] }[] } => {
  const byPath = new Map<string, { path: string; isInRepo: boolean; places: PlaceLine[] }>()

  for (const place of places) {
    const file = byPath.get(place.path) ?? { path: place.path, isInRepo: place.isInRepo, places: [] }
    byPath.set(place.path, file)
    file.places.push(place)
  }

  const files = [...byPath.values()].sort(
    (a, b) =>
      Number(b.path === current) - Number(a.path === current) ||
      Number(b.isInRepo) - Number(a.isInRepo) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )

  for (const file of files) {
    file.places.sort((a, b) => a.line - b.line || a.col - b.col)
  }

  return { total: places.length, files }
}

// Where a name is used, as the prompt takes it: a line each, in the order
// given, and a count of those past `limit`.
export const placesList = (name: string, places: readonly PlaceLine[], limit: number): string => {
  if (places.length === 0) {
    return `No uses of \`${name}\` found.`
  }

  const shown = places.slice(0, Math.max(0, limit))
  const rest = places.length - shown.length

  return [
    `\`${name}\` is used in ${places.length} ${places.length === 1 ? 'place' : 'places'}:`,
    ...shown.map(
      place => `- ${place.path}:${place.line}:${place.col} ${place.text.replace(/\s+/g, ' ').trim()}`,
    ),
    ...(rest > 0 ? [`- … and ${rest} more`] : []),
  ].join('\n')
}
