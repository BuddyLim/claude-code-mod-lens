// A whole file as coloured lines, for the file screen.

import type { Span } from '../types'
import { HIGHLIGHT_PY } from './highlight'
import type { Run } from './run'
import { tail } from './run'

// Reads a whole file through the highlighter; when that cannot run the lines
// are the file's plain text, and `note` says why.
//
// `committed` is the file's text as a commit left it, which the highlighter
// then reads from stdin; without it the highlighter (or, failing that,
// `readFile`, which answers '' for a file it cannot read) reads the working
// tree's file.
export const readSource = async (
  run: Run,
  readFile: (path: string) => Promise<string>,
  repo: string,
  path: string,
  committed: string | undefined,
): Promise<{ lines: Span[][]; note: string }> => {
  const ran = await run(
    [
      'uv',
      'run',
      '--no-project',
      '--with',
      'pygments',
      'python',
      '-c',
      HIGHLIGHT_PY,
      path,
      '1',
      '10000000',
      // A last argument has the highlighter read the text from stdin.
      ...(committed === undefined ? [] : ['-']),
    ],
    { cwd: repo, timeoutMs: 30_000, ...(committed === undefined ? {} : { stdin: committed }) },
  )

  try {
    return { lines: (JSON.parse(ran.stdout) as { lines: Span[][] }).lines, note: '' }
  } catch {
    const text = committed ?? (await readFile(`${repo}/${path}`))

    return {
      lines: text
        .split('\n')
        .map((line): Span[] => [['', line.replace(/[\u0000-\u001f\u007f]/g, ' ')]]),
      note: `highlighting did not run: ${tail(ran.stderr) || 'no output'}`,
    }
  }
}
