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
