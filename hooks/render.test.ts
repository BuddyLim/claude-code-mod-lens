// The pane as the engine draws it: the mod driven the way a person drives it
// (the command, then its buttons), with git and the forge answered from a
// table. `ui.drawn()` rejects with the engine's refusal when a tree does not
// validate or passes a tree's bounds, so a screen that reads it has been
// drawn within them.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Ran } from './run'

const REPO = '/repo'

// A diff of `files` files, each with one hunk of `lines` added lines.
const bigDiff = (files: number, lines: number): string =>
  Array.from({ length: files }, (_, at) => {
    const path = `src/file${at}.ts`

    return [
      `diff --git ${path} ${path}`,
      'index 1111111..2222222 100644',
      `--- ${path}`,
      `+++ ${path}`,
      `@@ -1,0 +1,${lines} @@ export const main = () => {`,
      ...Array.from({ length: lines }, (_, line) => `+  const value${line} = compute(${line}, 'a string of some length')`),
    ].join('\n')
  }).join('\n')

// What a call on `$` resolves to, as the hook beneath the plugins answers it.
// The test stands in for the host, whose answers it does not need in full:
// the cast says so once, here.
const answer = (value: unknown) => ({ value }) as never

// The command as a person types it.
const lens = (args: string) =>
  ({ command: 'lens', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true } }) as never

// The host beneath the mod: a clock, a store, and commands answered from a
// table by a word of their line. A git command no key matches prints nothing
// and succeeds, as in a quiet repo; any other command fails, as one that is
// not installed.
const host = (
  on: On,
  answers: Record<string, string>,
): { asked: string[]; advance: (ms: number) => Promise<void> } => {
  const asked: string[] = []
  const clock = mock.clock(on)

  mock.store(on)
  // What the mod asks of the session beside commands: nothing to draw into,
  // nothing to read, nobody to tell.
  on('command.register', async () => answer(undefined))
  on('session.start', async () => ({ cwd: REPO }))
  on('ui.open', async () => answer(undefined))
  on('ui.toast', async () => answer(undefined))
  on('ui.status', async () => answer(undefined))
  on('ui.focus', async () => ({}))
  on('ui.panes', async () => answer([]))
  on('session.cwd', async () => answer(REPO))
  on('fs.read', async () => answer(answers['fs.read'] ?? ''))
  on('process.run', async (_, e) => {
    const line = e.argv.join(' ')
    const hit = Object.keys(answers).find(word => line.includes(word))

    asked.push(line)

    const ran: Ran = hit !== undefined
      ? { exitCode: 0, stdout: (answers[hit] ?? '').replace('{argv5}', e.argv[5] ?? ''), stderr: '' }
      : e.argv[0] === 'git'
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'not answered' }

    return answer(ran)
  })

  return { asked, advance: ms => clock.advance(ms) }
}

const PANE = {
  plugin: 'lens',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'lens',
  props: {
    title: 'Lens',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 1, bodyRows: 40 },
    view: {},
  },
} as const

// What the folder resolves to: `findRepo` asks a shell for its real path.
const IN_REPO = { 'pwd -P': `${REPO}\n` }

test('the file tree opens on a repo, and its keys answer', async ($, on) => {
  host(on, IN_REPO)
  await $.command.run(lens(REPO))

  const ui = await $.ui.mount(PANE)

  await ui.drawn()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ key: 'requests' })).toBeDefined()
  // The less-used keys are in the drawing while their box is folded.
  expect(await ui.find({ key: 'project' })).toBeDefined()
  await ui.unmount()
})

test('the file tree stays within a tree’s bounds on a very large change', async ($, on) => {
  const many = Array.from({ length: 3000 }, (_, at) => `M\tpackages/pkg${at % 60}/src/module${at}.ts`).join('\n')
  const fresh = Array.from({ length: 3000 }, (_, at) => `notes/draft${at}.md`).join('\n')
  const tracked = Array.from({ length: 3000 }, (_, at) => `lib/part${at % 40}/unit${at}.py`).join('\n')
  const clock = host(on, { ...IN_REPO, '--name-status': many, '--others': fresh, 'ls-files': tracked })

  await $.session.start({ cwd: REPO } as never)
  await $.command.run(lens(REPO))
  // The scan the command asked for is picked up by the mod's timer.
  await clock.advance(2000)

  const ui = await $.ui.mount(PANE)

  await ui.drawn()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  // Every file is counted, though not every one is drawn.
  expect(await ui.find({ type: 'Text', text: /\(3000\)/ })).toBeDefined()

  // In the flat list, where no folder hides its files, it is within bounds too.
  await ui.press({ key: 'layout' })
  await ui.drawn()
  // And with every list long at once: what is new, and every tracked file.
  await ui.press({ key: 'browse' })
  await clock.advance(2000)
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /Untracked \(3000\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /All files \(3000\)/ })).toBeDefined()
  await ui.unmount()
})

test('the page of every change draws a long comparison a window at a time', async ($, on) => {
  host(on, { ...IN_REPO, 'diff --no-color': bigDiff(40, 120) })
  await $.command.run(lens(REPO))

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'changes' })
  // The tree is within the engine's bounds, though the comparison is of
  // nearly five thousand lines.
  await ui.drawn()
  expect(await ui.find({ key: 'page-file:src/file0.ts' })).toBeDefined()
  // Only the window's rows are in the tree: a file far down the page is not.
  expect(await ui.find({ key: 'page-file:src/file39.ts' })).toBe(undefined)

  // Half a page down moves the window, and the tree is still within bounds.
  await ui.press({ key: 'down' })
  await ui.drawn()
  expect(await ui.find({ key: 'page-file:src/file0.ts' })).toBe(undefined)
  await ui.unmount()
})

test('the page of every change lights rewritten words, and its jump keys move the window', async ($, on) => {
  const rewritten = [
    'diff --git src/a.ts src/a.ts',
    '--- src/a.ts',
    '+++ src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const first = 1',
    '-const limit = 300',
    '+const limit = 3000',
    ' const last = 2',
  ].join('\n')

  host(on, { ...IN_REPO, 'diff --no-color': `${rewritten}\n${bigDiff(6, 60)}` })
  await $.command.run(lens(REPO))

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'changes' })
  await ui.drawn()
  // The one word that differs is a piece of its own in each of the two lines.
  expect(await ui.find({ type: 'Text', text: '300' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3000' })).toBeDefined()

  // The next file but one is brought into the window; the first leaves it.
  await ui.press({ key: 'next-file' })
  await ui.press({ key: 'next-file' })
  await ui.drawn()
  expect(await ui.find({ key: 'page-file:src/file1.ts' })).toBeDefined()
  expect(await ui.find({ key: 'page-file:src/a.ts' })).toBe(undefined)
  await ui.press({ key: 'prev-change' })
  await ui.press({ key: 'next-talk' })
  await ui.drawn()
  await ui.unmount()
})

test('the overview draws what a request says, where it stands and what it links to', async ($, on) => {
  const seen = {
    title: 'Add the thing',
    body: '## What\n\nIt adds **the thing**.\n\n![a shot](https://github.com/user-attachments/assets/1111-aaaa)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    author: { login: 'ann' },
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/acme/app/pull/12',
    baseRefName: 'main',
    headRefName: 'feature',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example.com/1' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example.com/2' },
      { context: 'deploy', state: 'PENDING', targetUrl: '' },
    ],
    latestReviews: [{ author: { login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-09T00:00:00Z', commit: { oid: 'c'.repeat(40) } }],
    commits: [{ oid: 'd'.repeat(40), messageHeadline: 'Add it', authors: [{ login: 'ann' }] }],
    labels: [{ name: 'feature' }],
    additions: 10,
    deletions: 2,
    changedFiles: 3,
  }
  const clock = host(on, {
    ...IN_REPO,
    'remote get-url origin': 'https://github.com/acme/app.git\n',
    '--abbrev-ref': 'feature\n',
    'pulls?state=open&head=': JSON.stringify([{ number: 12, title: 'Add the thing', base: { ref: 'main' }, html_url: 'https://github.com/acme/app/pull/12' }]),
    'gh pr view 12': JSON.stringify(seen),
    'gh api': '[]',
    // A picture of the description, fetched: where it was put, and its size.
    'lens-pictures': '/tmp/t/lens-pictures/{argv5}.png\n640 320\n',
  })

  await $.session.start({ cwd: REPO } as never)
  await $.command.run(lens(REPO))
  await clock.advance(2000)

  const ui = await $.ui.mount(PANE)

  // The file tree says what the request is and the first lines of what it
  // says of itself, each on a row of its own.
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /^PR #12: Add the thing$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^It adds the thing\.$/ })).toBeDefined()

  await ui.press({ key: 'overview' })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /PR #12: Add the thing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 passed, 1 failed, 1 still going/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changes requested/ })).toBeDefined()
  // The description is handed to the surface as markdown, and its picture is listed as a link.
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pictures, videos and files \(1\)/ })).toBeDefined()
  // The picture is the forge's own, so it was fetched, and it is drawn in
  // place: a file the terminal reads, in cells that keep its shape.
  await ui.drawn()
  expect(await ui.find({ type: 'Image' })).toBeDefined()

  // Merging is asked about first, and saying no does nothing.
  await ui.press({ key: 'act-merge' })
  expect(await ui.find({ type: 'Text', text: /Merge PR #12 into main\?/ })).toBeDefined()
  await ui.press({ key: 'act-no' })
  expect(await ui.find({ key: 'act-yes' })).toBe(undefined)
  expect(clock.asked.some(line => line.startsWith('gh pr merge'))).toBe(false)

  // Yes does the one thing asked about, through the forge's own command.
  await ui.press({ key: 'act-close' })
  await ui.press({ key: 'act-yes' })
  expect(clock.asked.filter(line => line.startsWith('gh pr ')).pop()).toBe('gh pr view 12 --repo github.com/acme/app --json title,body,author,state,isDraft,url,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews,commits,labels,additions,deletions,changedFiles')
  expect(clock.asked.includes('gh pr close 12 --repo github.com/acme/app')).toBe(true)
  expect(clock.asked.some(line => line.startsWith('gh pr merge'))).toBe(false)

  // From what it says, on to its code: every change on one page, or its files.
  await ui.press({ key: 'changes' })
  await ui.drawn()
  expect(await ui.find({ key: 'next-file' })).toBeDefined()
  // Back from the code is back to what the request is, from either.
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Where it stands/ })).toBeDefined()
  await ui.press({ key: 'files' })
  await ui.drawn()
  expect(await ui.find({ key: 'requests' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Where it stands/ })).toBeDefined()
  // And back from there is the file tree it was opened from, with nothing
  // behind it to go back to.
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'requests' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBe(undefined)
  await ui.unmount()
})

test('the page of every change asks git again for more context, and without spaces', async ($, on) => {
  const git = host(on, { ...IN_REPO, 'diff --no-color': bigDiff(2, 5) })

  await $.command.run(lens(REPO))

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'changes' })
  await ui.drawn()
  await ui.press({ key: 'context' })
  await ui.press({ key: 'space' })
  await ui.drawn()

  const diffs = git.asked.filter(line => line.startsWith('git diff --no-color'))

  expect(diffs[0]?.includes('-U3 --no-prefix')).toBe(true)
  expect(diffs.some(line => line.includes('-U10 --no-prefix'))).toBe(true)
  expect(diffs[diffs.length - 1]?.includes('-U10 -w')).toBe(true)
  await ui.unmount()
})

test('the file tree lists only the files a filter names, and says so', async ($, on) => {
  const clock = host(on, { ...IN_REPO, '--name-status': 'M\tsrc/app.ts\nM\tsrc/util.ts\nM\tdocs/guide.md\n' })

  await $.session.start({ cwd: REPO } as never)
  await $.command.run(lens(REPO))
  await clock.advance(2000)

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'layout' })
  expect(await ui.find({ key: 'file:docs/guide.md' })).toBeDefined()
  await ui.press({ key: 'more' })
  await ui.input({ key: 'file-filter', text: 'SRC/' })
  await ui.drawn()
  expect(await ui.find({ key: 'file:src/app.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file:docs/guide.md' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Only files with/ })).toBeDefined()
  await ui.press({ key: 'filter-clear' })
  expect(await ui.find({ key: 'file:docs/guide.md' })).toBeDefined()
  await ui.unmount()
})

test('the page of every change stages and undoes a hunk, finds text, and draws the two sides beside each other', async ($, on) => {
  const rewritten = [
    'diff --git src/a.ts src/a.ts',
    '--- src/a.ts',
    '+++ src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const first = 1',
    '-const limit = 300',
    '+const limit = 3000',
    ' const last = 2',
  ].join('\n')
  const git = host(on, { ...IN_REPO, '--cached': '', 'diff --no-color': rewritten })

  await $.command.run(lens(REPO))

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'changes' })
  await ui.drawn()

  // Staging hands the hunk to git as git wrote it, into the index.
  await ui.press({ key: 'hunk-stage:src/a.ts:0' })
  expect(git.asked.includes('git apply --cached --whitespace=nowarn -')).toBe(true)

  // Undoing is asked about first, and no is no.
  await ui.press({ key: 'hunk-discard:src/a.ts:0' })
  expect(await ui.find({ key: 'hunk-yes:src/a.ts:0' })).toBeDefined()
  await ui.press({ key: 'hunk-no:src/a.ts:0' })
  expect(git.asked.some(line => line.startsWith('git apply --reverse'))).toBe(false)
  await ui.press({ key: 'hunk-discard:src/a.ts:0' })
  await ui.press({ key: 'hunk-yes:src/a.ts:0' })
  expect(git.asked.includes('git apply --reverse --whitespace=nowarn -')).toBe(true)

  // More of one file is read for that file alone.
  await ui.press({ key: 'hunk-more:src/a.ts:0' })
  expect(git.asked.some(line => line.includes('-U20') && line.endsWith('-- src/a.ts'))).toBe(true)

  // The search counts the lines that hold the text, whatever its case.
  await ui.press({ key: 'find' })
  await ui.input({ key: 'page-find', text: 'LIMIT' })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /^2 lines$/ })).toBeDefined()

  // Beside each other, the removed line and its replacement share a row.
  await ui.press({ key: 'split' })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /^1 line$/ })).toBeDefined()
  await ui.unmount()
})

test('the code view opens a changed file on its diff, with the rewritten words lit', async ($, on) => {
  const clock = host(on, {
    ...IN_REPO,
    '--name-status': 'M\tsrc/a.ts\n',
    '-U0': ['diff --git src/a.ts src/a.ts', '--- src/a.ts', '+++ src/a.ts', '@@ -2 +2 @@', '-const limit = 300', '+const limit = 3000', ''].join('\n'),
    'fs.read': 'const first = 1\nconst limit = 3000\nconst last = 2\n',
  })

  await $.session.start({ cwd: REPO } as never)
  await $.command.run(lens(REPO))
  await clock.advance(2000)

  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'layout' })
  await ui.press({ key: 'file:src/a.ts' })
  await ui.drawn()
  expect(await ui.find({ key: 'ln:2' })).toBeDefined()
  await ui.press({ key: 'diff' })
  await ui.drawn()
  // The removed line is drawn above the one that replaced it, and the word
  // that differs is a piece of its own in each.
  expect(await ui.find({ type: 'Text', text: '300' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3000' })).toBeDefined()
  // And cut down to the changes, the file still draws.
  await ui.press({ key: 'diff' })
  await ui.drawn()
  await ui.unmount()
})

test('the requests list gives a title and a description sample rows of their own, cut to a narrow pane', async ($, on) => {
  const title = 'A very long title that goes on well past what a narrow pane can show on one row'

  host(on, {
    ...IN_REPO,
    'remote get-url origin': 'https://github.com/acme/app.git\n',
    'pulls?state=open&per_page': JSON.stringify([
      {
        number: 7,
        title,
        user: { login: 'ann' },
        draft: true,
        head: { ref: 'topic' },
        updated_at: '',
        body: '## Why\n\nBecause the old way was **slow**.\n',
      },
    ]),
    'github.com user': JSON.stringify({ login: 'ann' }),
  })
  await $.command.run(lens(REPO))

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } })

  await ui.press({ key: 'requests' })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /Yours \(1\)/ })).toBeDefined()

  const shown = (await ui.find({ key: 'request-changes:#7' }))?.text ?? ''

  // The title is its own button, cut to the pane with a mark that it goes on.
  expect(shown.length <= 36 && shown.endsWith('…') && title.startsWith(shown.slice(0, -1))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Why · Because the old way was .*…$/ })).toBeDefined()
  await ui.unmount()
})
