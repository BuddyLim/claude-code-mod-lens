import { expect, test } from 'claude-code/testing'

import type { Diag } from '../types'
import { codeBlock, diagBlock, issueList } from './prompt'

const diag = (line: number, severity: Diag['severity'] = 'error'): Diag => ({
  path: 'a.py',
  line,
  col: 1,
  endCol: 0,
  severity,
  tool: 'pyright',
  rule: 'r',
  message: 'm',
})

test('code and diagnostics are written for the prompt with their place', async () => {
  const texts = ['import os', 'x = 1']

  expect(codeBlock('app/a.py', 1, 2, texts)).toBe('app/a.py:1-2\n```python\nimport os\nx = 1\n```')
  expect(diagBlock('app/a.py', 1, [diag(1)], texts)).toBe(
    'app/a.py:1:1 error pyright r: m\n```python\nimport os\n```',
  )
})

test('an issue list puts errors first and says what it left out', async () => {
  const list = issueList([diag(3, 'warning'), diag(9), diag(1, 'info')], 2)

  expect(list.split('\n')).toEqual([
    '- a.py:9:1 error pyright r: m',
    '- a.py:1:1 info pyright r: m',
    '- … and 1 more',
  ])
})
