import { expect, test } from 'claude-code/testing'

import type { Scan } from '../types'
import type { Ports } from './scan'
import { allFilesOf, historyOf, isQueued, scanRepo } from './scan'
import { ALL_CHECKERS } from './settings'
import { LSP_BRIDGE_PY } from './lsp-bridge'
import { NO_SCAN } from './state'

// Ports over a world where every command succeeds and prints nothing but
// what `answers` gives for a word of it.
const world = (answers: Record<string, string>, open = '') => {
  let scan: Scan = NO_SCAN
  const said: string[] = []
  const ports: Ports = {
    run: async argv => ({
      exitCode: 0,
      stdout: answers[Object.keys(answers).find(word => argv.includes(word)) ?? ''] ?? '',
      stderr: '',
    }),
    servers: async () => ({ exitCode: 1, stdout: '', stderr: 'no servers here' }),
    readFile: async () => '',
    readScan: async () => scan,
    writeScan: async change => {
      scan = change(scan)
    },
    onListed: async () => {
      said.push(`listed ${scan.files.length} while ${scan.status}`)
    },
    readComments: async () => '',
    showStatus: text => {
      said.push(text)
    },
    tellClaude: async text => {
      said.push(text)
    },
    openFile: async () => open,
    isOvertaken: () => false,
  }

  return { ports, said, scan: () => scan }
}
const subject = { repo: '/repo', base: 'HEAD', target: '', extra: [], isBrowsing: false, isTelling: false, requestTyped: '', use: ALL_CHECKERS, marksNew: true }

test('a scan of nothing under review does nothing', async () => {
  const { ports, scan } = world({})

  await scanRepo(ports, { ...subject, repo: '' }, { isProject: false })
  expect(scan()).toBe(NO_SCAN)
})

test('a scan lists what differs before the checkers run, then says the count', async () => {
  const { ports, said, scan } = world({
    '--name-status': 'M\tREADME.md\n',
    '--abbrev-ref': 'main\n',
    '--short': 'abc1234\n',
    // Nothing is untracked; the plain list of tracked files is asked for after.
    '--others': '',
    'ls-files': 'README.md\nLICENSE\n',
  })

  await scanRepo(ports, { ...subject, isBrowsing: true }, { isProject: false })

  expect(said).toEqual(['listed 1 while running', 'lens ✓'])
  expect(scan()).toMatchObject({
    status: 'done',
    files: [{ path: 'README.md', status: 'M' }],
    head: 'main',
    headHash: 'abc1234',
    diags: [],
    pending: [],
    notes: [],
    isProjectChecked: false,
  })
  // The history and the list of every file are the module's, by repo.
  expect(historyOf('/repo')).toHaveLength(scan().graphCount)
  expect(historyOf('/elsewhere')).toEqual([])
  expect(allFilesOf('/repo')).toEqual(['README.md', 'LICENSE'])
})

test('many files are checked a batch at a time, the open file first', async () => {
  const names = Array.from({ length: 650 }, (_, at) => `src/f${at}.py`)
  const { ports, scan } = world(
    {
      '--name-status': names.map(name => `M\t${name}`).join('\n'),
      '--abbrev-ref': 'main\n',
      '--short': 'abc1234\n',
    },
    'src/f640.py',
  )
  // Each run of ruff is one batch: its files are the command's last words.
  const batches: string[][] = []
  const run = ports.run

  ports.run = async (argv, init) => {
    if (argv.includes('ruff')) {
      batches.push(argv.filter(word => word.endsWith('.py')))

      return { exitCode: 0, stdout: '[]', stderr: '' }
    }

    return run(argv, init)
  }

  await scanRepo(ports, subject, { isProject: false })

  expect(batches.map(batch => batch.length)).toEqual([100, 100, 100, 100, 100, 100, 50])
  expect(batches[0]?.[0]).toBe('src/f640.py')
  expect(scan()).toMatchObject({ status: 'done', checked: 650, toCheck: 650 })
})

test('a long scan gives way to one asked for meanwhile', async () => {
  const names = Array.from({ length: 650 }, (_, at) => `src/f${at}.py`)
  const { ports, scan } = world({
    '--name-status': names.map(name => `M\t${name}`).join('\n'),
    '--abbrev-ref': 'main\n',
    '--short': 'abc1234\n',
  })

  ports.isOvertaken = () => true
  await scanRepo(ports, subject, { isProject: false })

  // It stopped after its first batch, and left the rest marked as waiting.
  expect(scan()).toMatchObject({ status: 'running', checked: 100, toCheck: 650 })
  expect(isQueued('/repo', 'src/f649.py')).toBe(true)
  expect(isQueued('/repo', 'src/f0.py')).toBe(false)
})

test('another language is checked by its server alone, and a missing server is named', async () => {
  const { ports, scan } = world({
    '--name-status': 'A\tcmd/main.go\nA\tapp/Program.cs\nM\tREADME.md\n',
    '--abbrev-ref': 'main\n',
    '--short': 'abc1234\n',
  })
  const table = {
    ok: true,
    servers: [
      { name: 'gopls', language: 'Go', extensions: ['.go'], filenames: [], isInstalled: true, install: '' },
      { name: 'csharp-ls', language: 'C#', extensions: ['.cs'], filenames: [], isInstalled: false, install: 'dotnet tool install --global csharp-ls' },
    ],
    notes: [],
  }
  const queried: string[][] = []
  const commands: string[] = []
  const run = ports.run

  ports.run = async (argv, init) => {
    commands.push(argv.join(' '))

    return run(argv, init)
  }
  ports.servers = async (argv, init) => {
    if (init?.stdin === LSP_BRIDGE_PY) {
      return { exitCode: 0, stdout: '/tmp/lens-lsp-501/bridge.py', stderr: '' }
    }

    if (argv.at(-1) === 'served') {
      return { exitCode: 0, stdout: JSON.stringify(table), stderr: '' }
    }

    if (argv.at(-1) === 'query') {
      queried.push((JSON.parse(init?.stdin ?? '{}') as { files: string[] }).files)

      const diagnostics = [{ range: { start: { line: 4, character: 1 } }, severity: 1, message: 'undefined: missing' }]

      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, files: { 'cmd/main.go': { tool: 'gopls', diagnostics } }, notes: [] }),
        stderr: '',
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await scanRepo(ports, subject, { isProject: false })

  expect(queried).toEqual([['cmd/main.go']])
  expect(scan()).toMatchObject({
    status: 'done',
    checked: 1,
    toCheck: 1,
    diags: [{ path: 'cmd/main.go', line: 5, col: 2, tool: 'gopls', message: 'undefined: missing', isNew: true }],
    notes: ['C# is not checked: csharp-ls is not installed (dotnet tool install --global csharp-ls)'],
  })
  // No command-line checker has anything to read.
  expect(commands.filter(command => /\b(ruff|pyright|tsc|eslint|terraform)\b/.test(command))).toEqual([])

  // With the servers switched off, nothing is asked and nothing is said.
  queried.length = 0
  await scanRepo(ports, { ...subject, use: { ...ALL_CHECKERS, servers: false } }, { isProject: false })
  expect(queried).toEqual([])
  expect(scan()).toMatchObject({ status: 'done', toCheck: 0, diags: [], notes: [] })

  // The table is the module's: left as the other tests expect it.
  table.servers = []
  await scanRepo(ports, subject, { isProject: false })
  expect(scan()).toMatchObject({ toCheck: 0, notes: [] })
})
