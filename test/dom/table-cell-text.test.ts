// @vitest-environment jsdom
/**
 * What a table cell says for a number smaller than its digits (§18.13).
 *
 * A P-value column at four decimals printed 10⁻²¹ as `0.0000`, which reads as a
 * certainty rather than as a very small number. A column that says it may hold
 * such values writes them in scientific notation instead; every other column is
 * as it was.
 */

import { describe, expect, it } from 'vitest'

import type { TableColumn } from '@/analysis/types'
import { cellText } from '@/figures/tableFigure'

const P: TableColumn = { key: 'p', label: 'P', kind: 'number', digits: 4, scientific: true }

describe('a number too small for its digits', () => {
  it('is written in scientific notation where the column allows it', () => {
    expect(cellText(P, 1.2e-21)).toBe('1.20e-21')
    expect(cellText(P, 0.05)).toBe('0.0500')
    expect(cellText(P, 0)).toBe('0.0000')
    expect(cellText(P, Number.NaN)).toBe('—')
  })

  it('stays fixed where the column does not', () => {
    expect(cellText({ ...P, scientific: undefined }, 1.2e-21)).toBe('0.0000')
  })
})
