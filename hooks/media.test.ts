import { expect, test } from 'claude-code/testing'

import { mediaOf } from './media'

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

test('plain links, and what is no link at all, are left out', async () => {
  expect(mediaOf('See [the docs](https://example.com/docs) and https://example.com/issues/4.')).toEqual([])
  expect(mediaOf('![local](./shot.png) and `![code](x.png)` text')).toEqual([])
  expect(mediaOf('')).toEqual([])
})
