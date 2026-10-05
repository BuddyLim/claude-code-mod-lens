// What the pane hands the prompt, as text: a list of issues, a block of
// code with its place, a line's diagnostics with the line.

import type { Diag } from '../types'

// How many issues, or places, one press sends to the prompt.
export const ISSUES_SENT = 40

// Diagnostics as one list for the prompt, a line each, the worst first.
export const issueList = (diags: readonly Diag[], limit: number): string => {
  const ranked = [...diags].sort(
    (a, b) =>
      Number(b.severity === 'error') - Number(a.severity === 'error') ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  )
  const lines = ranked
    .slice(0, limit)
    .map(
      diag =>
        `- ${diag.path}:${diag.line}:${diag.col} ${diag.severity} ${diag.tool}${diag.rule === '' ? '' : ` ${diag.rule}`}: ${diag.message.replace(/\s+/g, ' ')}`,
    )

  return [...lines, ...(ranked.length > limit ? [`- … and ${ranked.length - limit} more`] : [])].join(
    '\n',
  )
}

const FENCES: [pattern: RegExp, language: string][] = [
  [/\.pyi?$/, 'python'],
  [/\.[cm]?tsx$/, 'tsx'],
  [/\.[cm]?ts$/, 'ts'],
  [/\.[cm]?jsx$/, 'jsx'],
  [/\.[cm]?js$/, 'js'],
]

const fence = (path: string, body: string): string =>
  `\`\`\`${FENCES.find(([pattern]) => pattern.test(path))?.[1] ?? ''}\n${body}\n\`\`\``

// Lines `from` to `to` of a file as the prompt takes them: where they are,
// then the code.
export const codeBlock = (
  path: string,
  from: number,
  to: number,
  texts: readonly string[],
): string =>
  `${path}:${from === to ? from : `${from}-${to}`}\n${fence(path, texts.slice(from - 1, to).join('\n'))}`

export const quoteBlock = (path: string, text: string): string =>
  `From ${path}:\n${fence(path, text.replace(/\s+$/, ''))}`

// A review thread as the prompt takes it: who said what on which line (the
// replies under the comment they answer), then the code it is about, lines
// `from` to `to`. `request` names the pull or merge request it is on ("PR #12",
// "MR !34"), '' when that is not known.
export const talkBlock = (
  request: string,
  path: string,
  line: number,
  thread: readonly { author: string; body: string; isResolved?: boolean }[],
  from: number,
  to: number,
  texts: readonly string[],
): string =>
  [
    `Review comment${request === '' ? '' : ` in ${request}`} on ${path}:${line}${thread.some(one => one.isResolved === true) ? ' (resolved)' : ''}:`,
    ...thread.map(
      (one, at) => `${at === 0 ? '-' : '  -'} ${one.author}: ${one.body.trim().replace(/\s*\n\s*/g, ' ')}`,
    ),
    codeBlock(path, from, to, texts),
  ].join('\n')

// A line's diagnostics as the prompt takes them: each message with its tool
// and rule, then the line they point at.
export const diagBlock = (
  path: string,
  line: number,
  diags: readonly Diag[],
  texts: readonly string[],
): string =>
  [
    ...diags.map(
      diag =>
        `${path}:${line}:${diag.col} ${diag.isNew === undefined ? '' : diag.isNew ? 'new ' : 'pre-existing '}${diag.severity} ${diag.tool}${diag.rule === '' ? '' : ` ${diag.rule}`}: ${diag.message.replace(/\s+/g, ' ')}`,
    ),
    fence(path, texts[line - 1] ?? ''),
  ].join('\n')
