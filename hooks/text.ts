// Plain text made to fit: wrapped to a width, cut into pieces that render
// alone, folded by indentation, and searched.

// A ref as a person reads it: a full commit hash cut to git's usual seven
// characters, and a request's own ref (refs/lens/pr-12) to its last part.
export const shortRef = (ref: string): string =>
  /^[0-9a-f]{8,40}$/.test(ref) ? ref.slice(0, 7) : ref.replace(/^refs\/lens\//, '')

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(low, value), Math.max(low, high))

// Where `query` occurs in a file's lines, whatever its case: each match's
// line and the columns it spans (1-based, `to` exclusive), in reading order.
export const findMatches = (
  texts: readonly string[],
  query: string,
): { line: number; from: number; to: number }[] => {
  const wanted = query.toLowerCase()
  const matches: { line: number; from: number; to: number }[] = []

  if (wanted === '') {
    return matches
  }

  texts.forEach((text, at) => {
    const lower = text.toLowerCase()
    let from = lower.indexOf(wanted)

    while (from !== -1) {
      matches.push({ line: at + 1, from: from + 1, to: from + 1 + wanted.length })
      from = lower.indexOf(wanted, from + wanted.length)
    }
  })

  return matches
}

// Text as lines no wider than `width`, broken between words; a word wider
// than a line is cut. A blank line of the text stays a blank line.
export const wrapText = (text: string, width: number): string[] => {
  if (text.trim() === '') {
    return []
  }

  const room = Math.max(1, width)

  return text.split('\n').flatMap(paragraph => {
    const lines: string[] = []
    let line = ''

    for (const word of paragraph.replace(/[\u0000-\u001f\u007f]/g, ' ').split(' ')) {
      let rest = word

      if (line !== '' && line.length + 1 + rest.length > room) {
        lines.push(line)
        line = ''
      }

      while (rest.length > room) {
        lines.push(rest.slice(0, room))
        rest = rest.slice(room)
      }

      line = line === '' ? rest : `${line} ${rest}`
    }

    return [...lines, line]
  })
}

// Markdown cut into pieces of at most `limit` characters, each one able to
// be rendered alone: a piece ends at a blank line where it can, and one that
// has to end inside a code fence closes the fence and the next reopens it.
export const chunkMarkdown = (text: string, limit: number): string[] => {
  const chunks: string[] = []
  let lines: string[] = []
  let size = 0
  // The line that opened the fence the text is inside, if it is inside one.
  let fence: string | undefined
  // Where the chunk could end cleanly: after its last blank line outside a fence.
  let breakAt = -1

  const cut = (at: number): void => {
    const rest = lines.slice(at)

    chunks.push([...lines.slice(0, at), ...(at === lines.length && fence ? ['```'] : [])].join('\n'))
    lines = at === lines.length && fence ? [fence, ...rest] : rest
    size = lines.reduce((sum, line) => sum + line.length + 1, 0)
    breakAt = -1
  }

  for (const raw of text.split('\n')) {
    // No line may be longer than a piece.
    const line = raw.slice(0, limit - 8)

    if (size + line.length + 1 > limit && lines.length > 0) {
      cut(breakAt > 0 ? breakAt : lines.length)
    }

    lines.push(line)
    size += line.length + 1

    if (/^\s*(```|~~~)/.test(line)) {
      fence = fence === undefined ? line : undefined
    } else if (fence === undefined && line.trim() === '') {
      breakAt = lines.length
    }
  }

  if (lines.some(line => line.trim() !== '')) {
    chunks.push(lines.join('\n'))
  }

  return chunks
}

// The longest fold handed to the prompt in one press.
const FOLD_LINES = 200

const indentOf = (text: string): number => text.length - text.trimStart().length

// The last line of the fold that starts at line `n` (1-based): the lines
// under it that are indented deeper, plus the closing bracket that ends the
// block at the same depth. A line that opens nothing is a fold of itself.
export const foldEnd = (texts: readonly string[], n: number): number => {
  const base = indentOf(texts[n - 1] ?? '')
  let end = n

  for (let at = n; at < texts.length && at < n + FOLD_LINES; at += 1) {
    const text = texts[at] ?? ''

    if (text.trim() === '') {
      continue
    }

    if (indentOf(text) > base) {
      end = at + 1
      continue
    }

    if (end > n && indentOf(text) === base && /^[\])}]/.test(text.trim())) {
      end = at + 1
    }

    break
  }

  return end
}

// A markdown table as its cells: the header's, then each row's. A cell keeps
// its text without the marks of emphasis; `isCode` says it was written as
// code, to be coloured as such.
export type TableCell = { text: string; isCode: boolean }
export type MarkdownPiece =
  | { kind: 'text'; text: string }
  | { kind: 'table'; header: TableCell[]; rows: TableCell[][] }

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const cellsOf = (line: string): TableCell[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    // A bar written as \| is part of a cell, not its end.
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))
    .map(cell => ({
      text: cell
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
      isCode: cell.includes('`'),
    }))

// Markdown cut where its tables are: a table is a row of cells with a rule
// of dashes under it, outside any code fence. The rest stays as text, to be
// rendered as markdown; the tables are drawn by the pane, to the room it has.
export const splitMarkdown = (text: string): MarkdownPiece[] => {
  const pieces: MarkdownPiece[] = []
  const lines = text.split('\n')
  let held: string[] = []
  let isFenced = false
  const flush = (): void => {
    if (held.some(line => line.trim() !== '')) {
      pieces.push({ kind: 'text', text: held.join('\n') })
    }

    held = []
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''

    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced
    }

    if (!isFenced && line.includes('|') && TABLE_RULE.test(lines[at + 1] ?? '')) {
      const rows: TableCell[][] = []
      let next = at + 2

      while (next < lines.length && (lines[next] ?? '').includes('|') && (lines[next] ?? '').trim() !== '') {
        rows.push(cellsOf(lines[next] ?? ''))
        next += 1
      }

      flush()
      pieces.push({ kind: 'table', header: cellsOf(line), rows })
      at = next - 1
    } else {
      held.push(line)
    }
  }

  flush()

  return pieces
}

// How wide each column of a table is drawn in `room` cells, with `gap`
// between columns: as wide as its longest cell where there is room for all,
// else the widest columns give way first, down to a floor a word still fits.
export const tableWidths = (
  rows: readonly (readonly TableCell[])[],
  room: number,
  gap: number,
): number[] => {
  const count = Math.max(0, ...rows.map(row => row.length))
  const widths = Array.from({ length: count }, (_, column) =>
    Math.max(3, ...rows.map(row => (row[column]?.text ?? '').length)),
  )
  const floor = 8
  let over = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1) - room

  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths))

    if ((widths[widest] ?? 0) <= floor) {
      break
    }

    widths[widest] = (widths[widest] ?? 0) - 1
    over -= 1
  }

  return widths
}
