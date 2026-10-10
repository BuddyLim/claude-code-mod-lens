import { expect, test } from 'claude-code/testing'

import { cellsOf, fetchPicture, isFetched, isPictureFile, localPicture } from './pictures'

test('a picture of the folder is asked for by a fixed script, and only a plain path inside it', async () => {
  const asked: string[][] = []
  const file = `/Users/x/.cache/lens-pictures/${'c'.repeat(64)}.png`
  const run = async (argv: string[]) => {
    asked.push(argv)

    return { exitCode: 0, stdout: `${file}\n32 16\n`, stderr: '' }
  }

  expect(isPictureFile('docs/Shot.PNG') && isPictureFile('a.jpeg') && isPictureFile('a.webp')).toBe(true)
  expect(isPictureFile('logo.svg') || isPictureFile('a.png.ts')).toBe(false)

  expect(await localPicture(run, '/repo', 'docs/a.png')).toEqual({ file, width: 32, height: 16 })
  expect(asked[0]?.slice(3, 7)).toEqual(['sh', '/repo', 'docs/a.png', '-'])
  await localPicture(run, '/repo', 'docs/a.png', 'main')
  expect(asked[1]?.[6]).toBe('main')
  // Its size is read from its header, and held to a bound, before a tool opens it.
  const script = asked[0]?.[2] ?? ''

  expect(script.indexOf('fits "$raw"') > 0 && script.indexOf('fits "$raw"') < script.indexOf('sips -s format png')).toBe(true)
  expect(script.includes('ulimit -t 30')).toBe(true)
  // A link is not followed, and the working tree's file is told from a link.
  expect(asked[0]?.[2]?.includes('[ ! -L "$src" ]')).toBe(true)

  // A path that leaves the folder, a commit that reads as an option, or a file that is no picture: not asked.
  asked.length = 0
  expect(await localPicture(run, '/repo', '../a.png')).toBe(undefined)
  expect(await localPicture(run, '/repo', '/etc/a.png')).toBe(undefined)
  expect(await localPicture(run, '/repo', 'a.png', '--output=x')).toBe(undefined)
  expect(await localPicture(run, '/repo', 'a.ts')).toBe(undefined)
  expect(asked).toEqual([])
})

test('only pictures the forge itself serves are fetched, and only over https', async () => {
  expect(isFetched('https://github.com/user-attachments/assets/1111-aaaa', 'github.com')).toBe(true)
  expect(isFetched('https://raw.githubusercontent.com/acme/app/main/docs/shot.png', 'github.com')).toBe(true)
  expect(isFetched('https://gitlab.example.com/group/app/uploads/abc/shot.png', 'gitlab.example.com')).toBe(true)
  // Another site, another scheme, a name and password, a port of its own, a
  // host that only ends like the forge's, or a forge that is not known.
  expect(isFetched('https://example.com/shot.png', 'github.com')).toBe(false)
  expect(isFetched('http://github.com/a.png', 'github.com')).toBe(false)
  expect(isFetched('https://user:pass@github.com/a.png', 'github.com')).toBe(false)
  expect(isFetched('https://github.com:8443/a.png', 'github.com')).toBe(false)
  expect(isFetched('https://github.com.evil.example/a.png', 'github.com')).toBe(false)
  expect(isFetched('https://raw.githubusercontent.com/a.png', 'gitlab.com')).toBe(false)
  expect(isFetched('https://github.com/a b.png', 'github.com')).toBe(false)
  expect(isFetched('https://github.com/a.png', '')).toBe(false)
})

test('a picture keeps its shape in cells, within the room it is given', async () => {
  // 640 by 320 pixels is 80 cells wide; a cell is twice as tall as wide.
  expect(cellsOf({ width: 640, height: 320 }, 100, 30)).toEqual({ columns: 80, rows: 20 })
  // Narrower room: it shrinks, keeping its shape.
  expect(cellsOf({ width: 640, height: 320 }, 40, 30)).toEqual({ columns: 40, rows: 10 })
  // A tall one is held to the rows it has.
  expect(cellsOf({ width: 400, height: 2000 }, 100, 20)).toEqual({ columns: 8, rows: 20 })
  expect(cellsOf({ width: 4, height: 4 }, 100, 20)).toEqual({ columns: 1, rows: 1 })
})

test('a fetched picture is what the command said, and nothing is fetched that should not be', async () => {
  const asked: string[][] = []
  const run = (stdout: string, exitCode = 0) => async (argv: string[]) => {
    asked.push(argv)

    return { exitCode, stdout, stderr: '' }
  }
  const url = 'https://github.com/user-attachments/assets/1111-aaaa'

  expect(await fetchPicture(run('/home/x/.cache/lens-pictures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png\n640 320\n'), url, 'github.com')).toEqual({
    file: '/home/x/.cache/lens-pictures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    width: 640,
    height: 320,
  })
  // The address rides as an argument of a fixed script, with the size it may be.
  expect(asked[0]?.slice(0, 2)).toEqual(['sh', '-c'])
  expect(asked[0]?.slice(3)).toEqual(['sh', url, String(2 * 1024 * 1024), url])
  // The script follows no redirect itself, and spreads no braces.
  expect(asked[0]?.[2]?.includes('--max-redirs 0') && asked[0]?.[2]?.includes('--globoff') && !/curl[^\n]* -\w*L/.test(asked[0]?.[2] ?? '')).toBe(true)

  // A redirect to one of the forge's own hosts is asked next, under the first address's name.
  asked.length = 0
  const hops = ['to https://private-user-images.githubusercontent.com/1/2.png?jwt=x\n', '/Users/x/.cache/lens-pictures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png\n10 10\n']
  const hopping = async (argv: string[]) => {
    asked.push(argv)

    return { exitCode: 0, stdout: hops[asked.length - 1] ?? '', stderr: '' }
  }

  expect((await fetchPicture(hopping, url, 'github.com'))?.width).toBe(10)
  expect(asked.map(argv => argv.slice(4))).toEqual([
    [url, String(2 * 1024 * 1024), url],
    ['https://private-user-images.githubusercontent.com/1/2.png?jwt=x', String(2 * 1024 * 1024), url],
  ])

  // A redirect anywhere else is not followed: nothing more is asked.
  asked.length = 0
  expect(await fetchPicture(run('to https://169.254.169.254.example.net/latest\n'), url, 'github.com')).toBe(undefined)
  expect(await fetchPicture(run('to https://internal.corp/a.png\n'), url, 'github.com')).toBe(undefined)
  expect(asked.length).toBe(2)

  // A failed fetch, a file somewhere else, or a size no picture has, is no picture.
  expect(await fetchPicture(run('', 1), url, 'github.com')).toBe(undefined)
  expect(await fetchPicture(run('/etc/passwd\n640 320\n'), url, 'github.com')).toBe(undefined)
  expect(await fetchPicture(run('/home/x/.cache/lens-pictures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png\n99999 320\n'), url, 'github.com')).toBe(undefined)

  // Another site's picture is not asked for at all.
  asked.length = 0
  expect(await fetchPicture(run('x'), 'https://example.com/a.png', 'github.com')).toBe(undefined)
  expect(asked).toEqual([])
})
