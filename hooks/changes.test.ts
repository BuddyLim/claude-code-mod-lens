import { expect, test } from 'claude-code/testing'

import { changeLines, stepShown } from './changes'

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
