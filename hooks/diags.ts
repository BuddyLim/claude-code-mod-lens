// Lists of diagnostics, read the ways the screens need: one file's, counted,
// by the line they show under.

import type { Diag } from '../types'

export const diagsOf = (diags: readonly Diag[], path: string): Diag[] =>
  diags
    .filter(diag => diag.path === path)
    .sort((a, b) => a.line - b.line || a.col - b.col)

export const countLabel = (diags: readonly Diag[]): string => {
  const errors = diags.filter(diag => diag.severity === 'error').length
  const others = diags.length - errors

  return [errors > 0 ? `${errors}✖` : '', others > 0 ? `${others}⚠` : '']
    .filter(part => part !== '')
    .join(' ')
}

// The file's diagnostics by the line they show under; one past the end of
// the file shows under its last line. `diags` is the file's, sorted.
export const diagsByLine = (
  diags: readonly Diag[],
  lineCount: number,
): Map<number, { diag: Diag; index: number }[]> => {
  const byLine = new Map<number, { diag: Diag; index: number }[]>()

  diags.forEach((diag, index) => {
    const line = Math.min(Math.max(1, diag.line), Math.max(1, lineCount))
    byLine.set(line, [...(byLine.get(line) ?? []), { diag, index }])
  })

  return byLine
}

// Whether a diagnostic only says code is never used, at the level of a hint:
// it fades that code and is no problem to count or list, as in an editor.
export const isFadeOnly = (diag: Diag): boolean => diag.isUnused === true && diag.severity === 'info'
