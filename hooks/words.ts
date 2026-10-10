// What changed inside a changed line: a removed line and the added line that
// replaced it are compared word by word, so the screens can light the words
// that differ and leave the rest of the two lines as they are.

// A stretch of a line by its columns, 0-based, `to` exclusive.
export type Stretch = [from: number, to: number]

// Lines with more words than this are not compared: the table the comparison
// fills grows with the product of the two lines' words.
const WORDS = 400

// A line as its words: runs of letters and digits, runs of spaces, and every
// other character by itself.
const wordsOf = (text: string): string[] => text.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? []

// The words of `before` and of `after` that the other does not have, as
// stretches of each line. Lines that share nothing, or are too long to
// compare, come back with no stretches: the whole line is the change then,
// which its own colour already says.
export const changedWords = (before: string, after: string): { before: Stretch[]; after: Stretch[] } => {
  const old = wordsOf(before)
  const now = wordsOf(after)

  if (old.length === 0 || now.length === 0 || old.length > WORDS || now.length > WORDS) {
    return { before: [], after: [] }
  }

  // The longest run of words the two have in common, in order: `held[i][j]`
  // is its length over the words from `i` of one and `j` of the other.
  const held: number[][] = Array.from({ length: old.length + 1 }, () =>
    new Array<number>(now.length + 1).fill(0),
  )

  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = now.length - 1; j >= 0; j -= 1) {
      held[i]![j] =
        old[i] === now[j] ? (held[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(held[i + 1]?.[j] ?? 0, held[i]?.[j + 1] ?? 0)
    }
  }

  // Words that are only spaces do not make two lines alike.
  if (!old.some(word => word.trim() !== '' && now.includes(word))) {
    return { before: [], after: [] }
  }

  const gone: Stretch[] = []
  const come: Stretch[] = []
  // A stretch is added to the last where it touches it, so a run of changed
  // words is one stretch.
  const mark = (list: Stretch[], from: number, to: number) => {
    const last = list[list.length - 1]

    if (last !== undefined && last[1] === from) {
      last[1] = to
    } else {
      list.push([from, to])
    }
  }
  let [i, j, at, to] = [0, 0, 0, 0]

  while (i < old.length || j < now.length) {
    const [left, right] = [old[i], now[j]]

    if (left !== undefined && right !== undefined && left === right) {
      at += left.length
      to += right.length
      i += 1
      j += 1
    } else if (right !== undefined && (left === undefined || (held[i]?.[j + 1] ?? 0) >= (held[i + 1]?.[j] ?? 0))) {
      mark(come, to, to + right.length)
      to += right.length
      j += 1
    } else if (left !== undefined) {
      mark(gone, at, at + left.length)
      at += left.length
      i += 1
    }
  }

  // Two lines with most of what they say changed read better as two whole
  // lines: the share is of their letters and marks, spaces aside.
  const inked = (text: string): number => text.replace(/\s/g, '').length
  const changed = (list: Stretch[], text: string): number =>
    inked(text) === 0 ? 0 : list.reduce((sum, [from, end]) => sum + inked(text.slice(from, end)), 0) / inked(text)

  return changed(gone, before) > 0.6 && changed(come, after) > 0.6
    ? { before: [], after: [] }
    : { before: gone, after: come }
}
