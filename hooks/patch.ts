// A whole comparison as one page: git's unified diff read into files, hunks
// and lines, for the screen that shows every change one after another.

import type { Run } from './run'

// A line of a hunk: unchanged, added or removed, with its number in the new
// side of the file (0 for a removed line, which that side does not have).
// `old` is its number in the old side (0 for an added line).
export type PatchLine = { kind: ' ' | '+' | '-'; text: string; line: number; old: number }

// A hunk: the words git puts after its `@@` (the function it is in), its
// lines, and the hunk as git wrote it (`raw`: its `@@` line and every line
// under it, the "no newline" marks among them), which is what git takes
// back to stage it or undo it.
export type PatchHunk = { header: string; lines: PatchLine[]; raw: string[] }

// A file of the diff by its path on the new side (the old one for a deleted
// file). A binary file has no hunks.
export type PatchFile = {
  path: string
  // Its path on the old side: the same, another for a renamed file, and
  // '/dev/null' for a new one. '/dev/null' as `newPath` is a deleted file.
  oldPath: string
  newPath: string
  hunks: PatchHunk[]
  added: number
  deleted: number
  isBinary: boolean
  // Whether it is a symbolic link on either side: its "text" is the path it
  // points at, and the file itself is not to be read through.
  isLink: boolean
}

// How many lines of unchanged code git shows round each change.
export const CONTEXT = 3
// The steps the page's key for more context goes through, and back round.
export const CONTEXTS = [3, 10, 30] as const

// Reads `git diff --no-prefix` output. A path is taken from the `+++` line
// (the `---` line for a deleted file), so a renamed file is under its new name.
export const parsePatch = (diff: string): PatchFile[] => {
  const files: PatchFile[] = []
  let file: PatchFile | undefined
  let hunk: PatchHunk | undefined
  let line = 0
  let old = 0
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
        oldPath: '',
        newPath: '',
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
      file.oldPath = oldPath
    } else if (hunk === undefined && raw.startsWith('+++ ')) {
      const path = raw.slice(4).split('\t')[0] ?? ''

      file.newPath = path
      file.path = path === '/dev/null' ? oldPath : path
    } else if (raw.startsWith('@@ ')) {
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw)

      old = Number(at?.[1] ?? 1)
      line = Number(at?.[2] ?? 1)
      hunk = { header: at?.[3] ?? '', lines: [], raw: [raw] }
      file.hunks.push(hunk)
    } else if (hunk !== undefined && (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
      const kind = raw[0] as PatchLine['kind']

      hunk.raw.push(raw)
      hunk.lines.push({
        kind,
        text: raw.slice(1),
        line: kind === '-' ? 0 : line,
        old: kind === '+' ? 0 : old,
      })

      if (kind === '+') {
        file.added += 1
      } else if (kind === '-') {
        file.deleted += 1
      }

      if (kind !== '-') {
        line += 1
      }

      if (kind !== '+') {
        old += 1
      }
    } else if (hunk !== undefined && raw.startsWith('\\')) {
      // "\ No newline at end of file": part of the hunk as git takes it back.
      hunk.raw.push(raw)
    }
  }

  return files
}

// One hunk of a file as a patch git can apply by itself: the file's two
// names, then the hunk as git wrote it. The names carry the `a/` and `b/`
// git expects; a new or deleted file keeps its `/dev/null`.
export const hunkPatch = (file: PatchFile, hunk: PatchHunk): string => {
  const name = (side: 'a' | 'b', path: string): string => (path === '/dev/null' ? path : `${side}/${path}`)

  return [
    `--- ${name('a', file.oldPath || file.path)}`,
    `+++ ${name('b', file.newPath || file.path)}`,
    ...hunk.raw,
    '',
  ].join('\n')
}

// What tells one hunk from another whichever comparison it was read in: its
// file and its lines, without the numbers of its `@@` line (which shift when
// a hunk above it is staged or not). A hunk of the working tree whose mark
// is among the index's own is staged.
export const hunkMark = (file: PatchFile, hunk: PatchHunk): string => `${file.path}\n${hunk.raw.slice(1).join('\n')}`

// Applies one hunk to the index (`stage`), takes it back out of the index
// (`unstage`), or undoes it in the working tree (`discard`). Answers '' when
// git did it, else its reason. Run in the folder the diff was read in, whose
// paths the patch's are from.
export const applyHunk = async (
  run: Run,
  repo: string,
  file: PatchFile,
  hunk: PatchHunk,
  how: 'stage' | 'unstage' | 'discard',
): Promise<string> => {
  const ran = await run(
    [
      'git',
      'apply',
      ...(how === 'discard' ? ['--reverse'] : how === 'unstage' ? ['--cached', '--reverse'] : ['--cached']),
      '--whitespace=nowarn',
      '-',
    ],
    { cwd: repo, timeoutMs: 30_000, stdin: hunkPatch(file, hunk) },
  )

  return ran.exitCode === 0 ? '' : (ran.stderr.trim().split('\n').pop() ?? 'git could not apply it')
}

// The whole comparison as git diffs it: `base` with the working tree, or,
// when `target` names a commit, the two commits with each other. `refusal`
// is git's reason when it could not be read.
export const readPatch = async (
  run: Run,
  repo: string,
  base: string,
  target: string,
  // How many unchanged lines show round each change, and whether a line
  // that differs only in its spaces is left out.
  // `isStaged` reads what the index holds against `base` in place of the
  // working tree; `paths` reads those files alone.
  {
    context = CONTEXT,
    ignoresSpace = false,
    isStaged = false,
    paths = [],
  }: { context?: number; ignoresSpace?: boolean; isStaged?: boolean; paths?: readonly string[] } = {},
): Promise<{ files: PatchFile[]; refusal: string }> => {
  const ran = await run(
    [
      'git',
      'diff',
      '--no-color',
      '--no-ext-diff',
      `-U${Math.max(0, Math.floor(context))}`,
      ...(ignoresSpace ? ['-w'] : []),
      ...(isStaged ? ['--cached'] : []),
      '--no-prefix',
      '--relative',
      ...(target === '' ? [base] : [base, target]),
      ...(paths.length === 0 ? [] : ['--', ...paths]),
    ],
    { cwd: repo, timeoutMs: 60_000 },
  )

  return ran.exitCode === 0
    ? { files: parsePatch(ran.stdout), refusal: '' }
    : { files: [], refusal: ran.stderr.trim().split('\n').pop() ?? 'git could not diff' }
}
