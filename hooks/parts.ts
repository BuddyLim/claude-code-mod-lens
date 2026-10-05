// A line of code as it is drawn: the highlighter's spans cut where a
// diagnostic, a search match or unused code starts and ends, with the
// language server's inlay hints set among them.

import type { Span } from '../types'
import type { InlayHint } from './lsp-types'
import { applyInlays, INLAY_COLOR } from './semantic'

// A stretch of a line as it is drawn: its colour, and whether it is under a
// diagnostic, a search match, code that is never used, or is an inlay hint
// (text the server adds, which is not in the file).
export type Part = {
  color: string
  text: string
  isMarked: boolean
  isFound: boolean
  isFaded: boolean
  isHint: boolean
}

// A line's parts with the server's inlay hints set among them. The hints are
// placed by a helper that knows spans only, so each part's marks ride through
// it in the span's colour and are read back after.
export const withInlays = (
  parts: readonly Part[],
  hints: readonly InlayHint[],
  rawLine: string | undefined,
): Part[] => {
  if (hints.length === 0) {
    return [...parts]
  }

  const placed = applyInlays(
    parts.map((part): Span => [
      `${part.color}\u0001${Number(part.isMarked)}${Number(part.isFound)}${Number(part.isFaded)}`,
      part.text,
    ]),
    hints,
    rawLine,
  )

  return placed.spans.map(([color, text], at) => {
    const [own = '', marks = '000'] = color.split('\u0001')

    return placed.isHint[at] === true
      ? { color: INLAY_COLOR, text, isMarked: false, isFound: false, isFaded: false, isHint: true }
      : {
          color: own,
          text,
          isMarked: marks[0] === '1',
          isFound: marks[1] === '1',
          isFaded: marks[2] === '1',
          isHint: false,
        }
  })
}

// Splits a line's spans where a diagnostic's columns start and end, so the
// range can be underlined, and where a search's matches do (`found`), so they
// can be lit. Columns are 1-based, `to` exclusive.
export const markSpans = (
  spans: readonly Span[],
  ranges: readonly (readonly [from: number, to: number])[],
  found: readonly (readonly [from: number, to: number])[] = [],
  // Code the checkers say is never used, which is drawn faded.
  faded: readonly (readonly [from: number, to: number])[] = [],
): Part[] => {
  const parts: Part[] = []
  let col = 1

  for (const [color, text] of spans) {
    const cuts = new Set([0, text.length])

    for (const range of [...ranges, ...found, ...faded]) {
      for (const edge of [range[0] - col, range[1] - col]) {
        if (edge > 0 && edge < text.length) {
          cuts.add(edge)
        }
      }
    }

    const edges = [...cuts].sort((a, b) => a - b)

    edges.slice(0, -1).forEach((from, at) => {
      const start = col + from

      parts.push({
        color,
        text: text.slice(from, edges[at + 1]),
        isMarked: ranges.some(range => start >= range[0] && start < range[1]),
        isFound: found.some(range => start >= range[0] && start < range[1]),
        isFaded: faded.some(range => start >= range[0] && start < range[1]),
        isHint: false,
      })
    })
    col += text.length
  }

  return parts
}
