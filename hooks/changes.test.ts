import { expect, test } from 'claude-code/testing'

import { changeLines, selectedLines, stepShown } from './changes'

test('the changes-only view keeps each change, removal and comment with the lines around it', async () => {
  // Lines 10 and 11 changed; lines were removed before line 30; line 50 has a comment.
  expect(changeLines(100, [[10, 11]], [30], [50], 2)).toEqual([
    8, 9, 10, 11, 12, 13, 28, 29, 30, 31, 48, 49, 50, 51, 52,
  ])
  // The context stops at the file's ends, and overlapping stretches join.
  expect(changeLines(6, [[1, 1], [4, 4]], [], [], 2)).toEqual([1, 2, 3, 4, 5, 6])
  // Lines removed from the end of the file show the last lines before them.
  expect(changeLines(20, [], [21], [], 3)).toEqual([18, 19, 20])
  // A comment on the request as a whole (line 0) is on no line.
  expect(changeLines(20, [], [], [0])).toEqual([])
})

test('a mouse selection is read back as the lines it covers', async () => {
  const texts = ['import a from "a"', '', 'export const one = () => {', '  return a + 1', '}', '', 'export const two = 2']

  // Whole rows, gutter and all; a blank line of the file is gutter alone.
  expect(selectedLines('  3 export const one = () => {\n  4   return a + 1\n  5 }', texts, 1, 7)).toEqual([3, 5])
  expect(selectedLines('1 import a from "a"\n2\n3 export const one = () => {\n', texts, 1, 7)).toEqual([1, 3])
  // Started and ended mid-line.
  expect(selectedLines('one = () => {\n  4   return a + 1\n  5 }\n  6\n  7 export const', texts, 1, 7)).toEqual([3, 7])
  // One line, and one part of a line.
  expect(selectedLines('return a', texts, 1, 7)).toEqual([4, 4])
  // Only the window is looked in, and what is not there is not guessed at.
  expect(selectedLines('  3 export const one = () => {', texts, 4, 7)).toBe(undefined)
  expect(selectedLines('something else\nentirely', texts, 1, 7)).toBe(undefined)
  expect(selectedLines('  \n', texts, 1, 7)).toBe(undefined)
})

test('the window steps among the lines that show, and stops at their ends', async () => {
  const shown = [8, 9, 10, 28, 29, 30]

  expect(stepShown(shown, 10, 1)).toBe(28)
  expect(stepShown(shown, 28, -1)).toBe(10)
  // A top on a hidden line counts from the next line that shows.
  expect(stepShown(shown, 15, 0)).toBe(28)
  expect(stepShown(shown, 8, -5)).toBe(8)
  expect(stepShown(shown, 29, 9)).toBe(30)
  expect(stepShown([], 4, 2)).toBe(4)
})
