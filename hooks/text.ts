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
