// The changes-only view of a file: which of its lines show when the file is
// cut down to what differs, and how the window moves among them.

import type { LineRange } from '../types'

// How many unchanged lines show above and below each change.
export const CONTEXT = 3

// The lines that show, in order: each changed line, each place lines were
// removed (`removedBefore`: the line they came before, which may be one past
// the file's last) and each commented line, with `context` lines around it.
export const changeLines = (
  lineCount: number,
  changed: readonly LineRange[],
  removedBefore: readonly number[],
  talked: readonly number[],
  context = CONTEXT,
): number[] => {
  const shown = new Set<number>()
  const show = (from: number, to: number) => {
    for (let line = Math.max(1, from); line <= Math.min(lineCount, to); line += 1) {
      shown.add(line)
    }
  }

  for (const range of changed) {
    show(range[0] - context, range[1] + context)
  }

  // What was removed sits between two lines: the context is counted from
  // each side of the gap.
  for (const before of removedBefore) {
    show(before - context, before + context - 1)
  }

  for (const line of talked) {
    if (line >= 1) {
      show(line - context, line + context)
    }
  }

  return [...shown].sort((one, other) => one - other)
}

// The lines of a file a mouse selection covers, first and last (1-based), or
// undefined when it cannot be told. `selected` is the text as a copy would
// take it, which holds each row's gutter too and may start or end mid-line;
// `texts` is the file's lines as drawn, and only those from `from` to `to`
// (the window) are looked among. A row matches a line when the row holds the
// line's text (a whole row was taken), or the line holds the row's (a part
// of one was); the selection is where every one of its rows matches in turn.
export const selectedLines = (
  selected: string,
  texts: readonly string[],
  from: number,
  to: number,
): [first: number, last: number] | undefined => {
  const picked = selected.split('\n').map(row => row.trimEnd())

  while (picked.length > 0 && (picked[0] ?? '').trim() === '') {
    picked.shift()
  }

  while (picked.length > 0 && (picked[picked.length - 1] ?? '').trim() === '') {
    picked.pop()
  }

  if (picked.length === 0) {
    return undefined
  }

  const matches = (row: string, line: string): boolean => {
    const code = line.trim()
    // The row without its gutter: a part of a line taken from its start.
    const bare = row.replace(/^[^A-Za-z0-9_]*\d+\s?/, '').trim()

    // An empty line of the file is a row of gutter alone, which has no
    // letters of its own to tell it by.
    return code === ''
      ? !/[A-Za-z_]/.test(row)
      : row.includes(code) || code.includes(row.trim()) || (bare !== '' && code.includes(bare))
  }

  for (let first = Math.max(1, from); first + picked.length - 1 <= Math.min(to, texts.length); first += 1) {
    if (picked.every((row, at) => matches(row, texts[first - 1 + at] ?? ''))) {
      return [first, first + picked.length - 1]
    }
  }

  return undefined
}

// Where the window's first line goes when it moves `by` of the lines that
// show, from `top` (or from the first shown line at or after it).
export const stepShown = (shown: readonly number[], top: number, by: number): number => {
  if (shown.length === 0) {
    return top
  }

  const found = shown.findIndex(line => line >= top)
  const at = found === -1 ? shown.length - 1 : found

  return shown[Math.min(shown.length - 1, Math.max(0, at + by))] ?? top
}
