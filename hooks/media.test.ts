import { expect, test } from 'claude-code/testing'

import { MEDIA_KEPT, SCANNED, hostOf, mediaOf } from './media'

test('the pictures, videos and documents of a description are listed in order, each once', async () => {
  const body = [
    'Before and after:',
    '![before the change](https://example.com/shots/before.png)',
    '<img width="400" alt="after" src="https://github.com/user-attachments/assets/1111-aaaa">',
    '',
    'A recording:',
    'https://github.com/user-attachments/assets/2222-bbbb',
    '<video src="https://example.com/demo.mp4" controls></video>',
    '',
    'The [design doc](https://example.com/files/123/Design%20notes.pdf) and [the plan](https://example.com/plan).',
    'Again: ![before](https://example.com/shots/before.png)',
  ].join('\n')

  expect(mediaOf(body)).toEqual([
    { kind: 'image', url: 'https://example.com/shots/before.png', label: 'before the change' },
    { kind: 'image', url: 'https://github.com/user-attachments/assets/1111-aaaa', label: 'after' },
    // A bare link to an upload: how a dropped video is written.
    { kind: 'file', url: 'https://github.com/user-attachments/assets/2222-bbbb', label: '2222-bbbb' },
    { kind: 'video', url: 'https://example.com/demo.mp4', label: 'demo.mp4' },
    { kind: 'file', url: 'https://example.com/files/123/Design%20notes.pdf', label: 'design doc' },
  ])
})

test('a description is read as untrusted: bounded, and with nothing a terminal would act on', async () => {
  // A label cannot carry an escape sequence or a way to reverse the text.
  const [sly] = mediaOf('![\u001b[2Jclick\u202ehere](https://example.com/a.png)')

  expect(sly?.label).toBe('[2Jclick here')
  // Nor a link a space, a control character or another scheme.
  expect(mediaOf('![x](javascript:alert(1).png) ![y](https://example.com/a\u001b.png)')).toEqual([])
  // What a name calls itself is not where it goes: the site is read off the link.
  expect(hostOf('https://Evil.example.com/github.com/login.pdf')).toBe('evil.example.com')

  // Text made to be slow to read is still read at once, and no further than its bound.
  const started = Date.now()
  const hostile = `${'![a]('.repeat(20_000)}${'<img '.repeat(20_000)}${'[x]('.repeat(20_000)}`

  expect(mediaOf(hostile)).toEqual([])
  expect(mediaOf(`${' '.repeat(SCANNED)}![late](https://example.com/late.png)`)).toEqual([])
  expect(mediaOf(Array.from({ length: 500 }, (_, at) => `![p](https://example.com/${at}.png)`).join('\n')).length).toBe(MEDIA_KEPT)
  expect(Date.now() - started < 1500).toBe(true)
})

test('plain links, and what is no link at all, are left out', async () => {
  expect(mediaOf('See [the docs](https://example.com/docs) and https://example.com/issues/4.')).toEqual([])
  expect(mediaOf('![local](./shot.png) and `![code](x.png)` text')).toEqual([])
  expect(mediaOf('')).toEqual([])
})
