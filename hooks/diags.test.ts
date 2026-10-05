import { expect, test } from 'claude-code/testing'

import type { Diag } from '../types'
import { countLabel } from './diags'

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

test('counts split errors from the rest', async () => {
  expect(countLabel([diag(1), diag(2, 'warning'), diag(3, 'info')])).toBe('1✖ 2⚠')
  expect(countLabel([])).toBe('')
})
