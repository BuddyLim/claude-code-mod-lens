// A whole comparison as one page: git's unified diff read into files, hunks
// and lines, for the screen that shows every change one after another.

import type { Run } from './run'

// A line of a hunk: unchanged, added or removed, with its number in the new
// side of the file (0 for a removed line, which that side does not have).
export type PatchLine = { kind: ' ' | '+' | '-'; text: string; line: number }

export type PatchHunk = { header: string; lines: PatchLine[] }

// A file of the diff by its path on the new side (the old one for a deleted
// file). A binary file has no hunks.
export type PatchFile = {
  path: string
  hunks: PatchHunk[]
  added: number
  deleted: number
  isBinary: boolean
  // Whether it is a symbolic link on either side: its "text" is the path it
  // points at, and the file itself is not to be read through.
  isLink: boolean
}

// How many lines of unchanged code git shows round each change.
const CONTEXT = 3

// Reads `git diff --no-prefix` output. A path is taken from the `+++` line
// (the `---` line for a deleted file), so a renamed file is under its new name.
export const parsePatch = (diff: string): PatchFile[] => {
  const files: PatchFile[] = []
  let file: PatchFile | undefined
  let hunk: PatchHunk | undefined
  let line = 0
  let oldPath = ''

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // The path is settled by the lines that follow; until then it is what
      // the heading names last, which is right for a file with no hunks (a
      // rename with nothing changed, a mode change).
      const named = raw.slice('diff --git '.length)
      const half = named.length >> 1

      file = {
        path: named.slice(half + 1) === named.slice(0, half) ? named.slice(half + 1) : named,
        hunks: [],
        added: 0,
        deleted: 0,
        isBinary: false,
        isLink: false,
      }
      files.push(file)
      hunk = undefined
      oldPath = ''
    } else if (file === undefined) {
      continue
    } else if (
      hunk === undefined &&
      /^(?:(?:new|deleted) file mode|new mode|old mode) 120000$|^index \S+ 120000$/.test(raw)
    ) {
      file.isLink = true
    } else if (hunk === undefined && raw.startsWith('rename to ')) {
      file.path = raw.slice('rename to '.length)
    } else if (hunk === undefined && raw.startsWith('Binary files ')) {
      file.isBinary = true
    } else if (hunk === undefined && raw.startsWith('--- ')) {
      oldPath = raw.slice(4).split('\t')[0] ?? ''
    } else if (hunk === undefined && raw.startsWith('+++ ')) {
      const path = raw.slice(4).split('\t')[0] ?? ''

      file.path = path === '/dev/null' ? oldPath : path
    } else if (raw.startsWith('@@ ')) {
      const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw)

      line = Number(at?.[1] ?? 1)
      hunk = { header: at?.[2] ?? '', lines: [] }
      file.hunks.push(hunk)
    } else if (hunk !== undefined && (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
      const kind = raw[0] as PatchLine['kind']

      hunk.lines.push({ kind, text: raw.slice(1), line: kind === '-' ? 0 : line })

      if (kind === '+') {
        file.added += 1
      } else if (kind === '-') {
        file.deleted += 1
      }

      if (kind !== '-') {
        line += 1
      }
    }
  }

  return files
}

// The whole comparison as git diffs it: `base` with the working tree, or,
// when `target` names a commit, the two commits with each other. `refusal`
// is git's reason when it could not be read.
export const readPatch = async (
  run: Run,
  repo: string,
  base: string,
  target: string,
): Promise<{ files: PatchFile[]; refusal: string }> => {
  const ran = await run(
    [
      'git',
      'diff',
      '--no-color',
      '--no-ext-diff',
      `-U${CONTEXT}`,
      '--no-prefix',
      '--relative',
      ...(target === '' ? [base] : [base, target]),
    ],
    { cwd: repo, timeoutMs: 60_000 },
  )

  return ran.exitCode === 0
    ? { files: parsePatch(ran.stdout), refusal: '' }
    : { files: [], refusal: ran.stderr.trim().split('\n').pop() ?? 'git could not diff' }
}
