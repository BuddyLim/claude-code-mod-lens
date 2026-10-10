import { expect, test } from 'claude-code/testing'

import { cellsOf, fetchPicture, isFetched } from './pictures'

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

  expect(await fetchPicture(run('/tmp/x/lens-pictures/p1.png\n640 320\n'), url, 'github.com', 'p1')).toEqual({
    file: '/tmp/x/lens-pictures/p1.png',
    width: 640,
    height: 320,
  })
  // The address rides as an argument of a fixed script, with the size it may be.
  expect(asked[0]?.slice(0, 2)).toEqual(['sh', '-c'])
  expect(asked[0]?.slice(3)).toEqual(['sh', url, 'p1', String(2 * 1024 * 1024)])

  // A failed fetch, a file somewhere else, or a size no picture has, is no picture.
  expect(await fetchPicture(run('', 1), url, 'github.com', 'p1')).toBe(undefined)
  expect(await fetchPicture(run('/etc/passwd\n640 320\n'), url, 'github.com', 'p1')).toBe(undefined)
  expect(await fetchPicture(run('/tmp/x/lens-pictures/p1.png\n99999 320\n'), url, 'github.com', 'p1')).toBe(undefined)

  // Another site's picture, or a name that is not a plain one, is not asked for at all.
  asked.length = 0
  expect(await fetchPicture(run('x'), 'https://example.com/a.png', 'github.com', 'p1')).toBe(undefined)
  expect(await fetchPicture(run('x'), url, 'github.com', '../p1')).toBe(undefined)
  expect(asked).toEqual([])
})
