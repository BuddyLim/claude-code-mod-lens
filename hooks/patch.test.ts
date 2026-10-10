import { expect, test } from 'claude-code/testing'

import { applyHunk, hunkPatch, isApplicable, parsePatch } from './patch'

const DIFF = [
  'diff --git src/a.ts src/a.ts',
  'index 1111111..2222222 100644',
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -10,4 +10,5 @@ export const a = () => {',
  ' const one = 1',
  '-const two = 3',
  '+const two = 2',
  '+const three = 3',
  ' return one',
  'diff --git old.md new.md',
  'similarity index 90%',
  'rename from old.md',
  'rename to new.md',
  '--- old.md',
  '+++ new.md',
  '@@ -1 +1 @@',
  '-# Old',
  '+# New',
  'diff --git gone.txt gone.txt',
  'deleted file mode 100644',
  '--- gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  'diff --git logo.png logo.png',
  'Binary files logo.png and logo.png differ',
  'diff --git latest latest',
  'new file mode 120000',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ latest',
  '@@ -0,0 +1 @@',
  '+/dev/zero',
  '\\ No newline at end of file',
  '',
].join('\n')

test('a diff is read into files, hunks and lines numbered on the new side', async () => {
  const [changed, renamed, gone, binary, link] = parsePatch(DIFF)

  // A symbolic link is known for one, so it is never read through.
  expect(link).toMatchObject({ path: 'latest', isLink: true, added: 1 })
  expect(changed?.isLink).toBe(false)

  expect(changed).toMatchObject({ path: 'src/a.ts', added: 2, deleted: 1, isBinary: false })
  expect(changed?.hunks[0]?.header).toBe('export const a = () => {')
  expect(changed?.hunks[0]?.lines).toEqual([
    { kind: ' ', text: 'const one = 1', line: 10, old: 10 },
    { kind: '-', text: 'const two = 3', line: 0, old: 11 },
    { kind: '+', text: 'const two = 2', line: 11, old: 0 },
    { kind: '+', text: 'const three = 3', line: 12, old: 0 },
    { kind: ' ', text: 'return one', line: 13, old: 12 },
  ])
  // A hunk is handed back to git as it wrote it, under the file's two names.
  expect(changed === undefined ? '' : hunkPatch(changed, changed.hunks[0]!)).toBe(
    [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@ export const a = () => {',
      ' const one = 1',
      '-const two = 3',
      '+const two = 2',
      '+const three = 3',
      ' return one',
      '',
    ].join('\n'),
  )
  // Only a whole hunk of a file with a plain name inside the folder is
  // handed back to git: not one whose name climbs out, is quoted, or is git's
  // own; not a link's; and not text that is no hunk.
  const hunk = changed!.hunks[0]!

  expect(isApplicable(changed!, hunk)).toBe(true)

  for (const path of ['../outside.ts', '/etc/hosts', '.git/config', '"odd\\tname.ts"', 'a\nb.ts', '-flag']) {
    expect(isApplicable({ ...changed!, path, oldPath: path, newPath: path }, hunk)).toBe(false)
  }

  expect(isApplicable({ ...changed!, isLink: true }, hunk)).toBe(false)
  expect(isApplicable(changed!, { ...hunk, raw: [...hunk.raw, 'diff --git x y'] })).toBe(false)
  expect(isApplicable(changed!, { ...hunk, raw: hunk.raw.slice(1) })).toBe(false)
  expect(await applyHunk(async () => ({ exitCode: 0, stdout: '', stderr: '' }), '/repo', { ...changed!, path: '../x' }, hunk, 'discard')).toBe(
    'that change is not one lens hands back to git: its file has a name it does not take, or the hunk is not whole',
  )
  // A renamed file is under its new name; a deleted one keeps its old.
  expect(renamed).toMatchObject({ path: 'new.md', added: 1, deleted: 1 })
  expect(gone).toMatchObject({ path: 'gone.txt', added: 0, deleted: 2 })
  expect(binary).toMatchObject({ path: 'logo.png', hunks: [], isBinary: true })
  expect(parsePatch('')).toEqual([])
})
