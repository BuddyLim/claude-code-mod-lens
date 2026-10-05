// The minimap: the whole file squeezed into a small block of cells, drawn as
// one Raster. Each cell is a braille glyph, two dots wide and four tall, so a
// dot row stands for one or more lines and a dot for a few characters.

export type MiniLine = {
  indent: number
  length: number
  // 0 none, 1 warning or info, 2 error.
  mark: 0 | 1 | 2
  isChanged: boolean
  // What the language server says starts on the line, when it has said:
  // 0 nothing, 1 a function or method, 2 a class or type. Absent is nothing.
  head?: 0 | 1 | 2
  // Whether a review comment sits on the line, and whether every thread
  // there has been resolved.
  isTalked?: boolean
  isSettled?: boolean
}

// How many characters of a line one dot stands for.
const CHARS_PER_DOT = 7
const DEFAULT = 0x01000000
const CODE = 0x8b949e
const CHANGED = 0x73c991
const WARNING = 0xcca700
const ERROR = 0xf14c4c
const COMMENT = 0xc586c0
const RESOLVED = 0x9a8444
const WINDOW = 0x3a3d41
const BRAILLE = 0x2800
const SPACE = 0x20
// A braille cell's dots as bits, by dot row then dot column.
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

// Where a function or a class starts, in the colours they have in the code,
// so the file's shape reads as its outline.
const FUNCTION = 0xdcdcaa
const CLASS = 0x4ec9b0

type DotRow = {
  indent: number
  length: number
  mark: number
  head: number
  isTalked: boolean
  isSettled: boolean
  isChanged: boolean
  isInWindow: boolean
}

// `top` is the first line the code window shows (1-based) and `shown` how
// many lines it holds: those rows get the lighter background. A file shorter
// than the block fills only its top.
export const minimapCells = (
  lines: readonly MiniLine[],
  columns: number,
  rows: number,
  top: number,
  shown: number,
): string => {
  const dotRows = rows * 4
  const perDot = Math.max(1, lines.length / dotRows)

  const summary: DotRow[] = Array.from({ length: dotRows }, (_, row) => {
    const from = Math.floor(row * perDot)
    const to = Math.max(from + 1, Math.floor((row + 1) * perDot))
    const held = lines.slice(from, to).filter(line => line.length > 0)

    return {
      indent: Math.min(...held.map(line => line.indent)),
      length: Math.max(0, ...held.map(line => line.length)),
      mark: Math.max(0, ...held.map(line => line.mark)),
      head: Math.max(0, ...held.map(line => line.head ?? 0)),
      // An open thread among them keeps the rows the colour of one.
      isTalked: held.some(line => line.isTalked === true && line.isSettled !== true),
      isSettled: held.some(line => line.isTalked === true && line.isSettled === true),
      isChanged: held.some(line => line.isChanged),
      isInWindow: from < lines.length && from < top - 1 + shown && to > top - 1,
    }
  })

  const words = new Uint32Array(columns * rows * 3)

  for (let row = 0; row < rows; row += 1) {
    const held = summary.slice(row * 4, row * 4 + 4)
    const mark = Math.max(...held.map(one => one.mark))
    const head = Math.max(...held.map(one => one.head))
    // A problem outranks a comment, which outranks a change, which outranks
    // the outline.
    const color =
      mark === 2
        ? ERROR
        : mark === 1
          ? WARNING
          : held.some(one => one.isTalked)
            ? COMMENT
          : held.some(one => one.isSettled)
            ? RESOLVED
          : held.some(one => one.isChanged)
            ? CHANGED
            : head === 2
              ? CLASS
              : head === 1
                ? FUNCTION
                : CODE
    const background = held.some(one => one.isInWindow) ? WINDOW : DEFAULT

    for (let column = 0; column < columns; column += 1) {
      let bits = 0

      held.forEach((one, y) => {
        for (const x of [0, 1] as const) {
          const start = (column * 2 + x) * CHARS_PER_DOT

          if (start < one.length && start + CHARS_PER_DOT > one.indent) {
            bits |= DOT[y]?.[x] ?? 0
          }
        }
      })

      const at = (row * columns + column) * 3

      words[at] = bits === 0 ? SPACE : BRAILLE + bits
      words[at + 1] = color
      words[at + 2] = background
    }
  }

  // The mod's environment has Uint8Array's toBase64; the es2023 typings do not.
  return (new Uint8Array(words.buffer) as unknown as { toBase64: () => string }).toBase64()
}
