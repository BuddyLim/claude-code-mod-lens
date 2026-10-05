import { expect, test } from 'claude-code/testing'

import { DEFAULTS, settingsOf } from './settings'

test('no options are the defaults', () => {
  expect(settingsOf({})).toEqual(DEFAULTS)
})

test('a checker switched off stays off and the rest stay on', () => {
  const { checkers } = settingsOf({ eslint: false, languageServers: false })

  expect(checkers.eslint).toBe(false)
  expect(checkers.servers).toBe(false)
  expect(checkers.ruff).toBe(true)
})

test('a padding out of range or of the wrong kind is brought back', () => {
  expect(settingsOf({ sidePadding: 40 }).sidePadding).toBe(8)
  expect(settingsOf({ sidePadding: -3 }).sidePadding).toBe(0)
  expect(settingsOf({ sidePadding: 'wide' }).sidePadding).toBe(2)
})

test('the keys setting opens the box of less-used keys for good', () => {
  expect(settingsOf({ keys: 'all shown' }).showsAllKeys).toBe(true)
  expect(settingsOf({ keys: 'main row + more…' }).showsAllKeys).toBe(false)
})
