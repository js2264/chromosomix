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
import { cellText, viewRows } from '@/figures/tableFigure'

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

// A coordinate is printed as every coordinate on the screen is (§26.1, §18.7):
// a start, held 0-based as the BED-shaped TSV it is saved to holds it, as the
// first base it names; a start and an end alike grouped as en-US.
describe('a coordinate column', () => {
  const START: TableColumn = { key: 'start', label: 'Start', kind: 'number', coordinate: 'start' }
  const END: TableColumn = { key: 'end', label: 'End', kind: 'number', coordinate: 'end' }

  it('prints a start as the first base it names, and an end as it is, both grouped', () => {
    expect(cellText(START, 1_000_000)).toBe('1,000,001')
    expect(cellText(START, 0)).toBe('1')
    expect(cellText(END, 1_000_500)).toBe('1,000,500')
    expect(cellText(START, Number.NaN)).toBe('—')
  })

  it('groups as en-US in any locale', () => {
    const original = Number.prototype.toLocaleString
    // A German browser groups with dots; a coordinate does not.
    Number.prototype.toLocaleString = function (this: number, locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return original.call(this, locale ?? 'de-DE', options)
    } as typeof original
    try {
      expect(cellText(START, 1_161_999)).toBe('1,162,000')
      expect(cellText(END, 1_162_000)).toBe('1,162,000')
    } finally {
      Number.prototype.toLocaleString = original
    }
  })

  it('is found by the base it prints, and sorted by the one it holds', () => {
    const spec = {
      columns: [START],
      rows: [{ start: 1_000_000 }, { start: 5 }],
    } as unknown as Parameters<typeof viewRows>[0]
    const style = { filter: '1,000,001', sortKey: null, sortDown: false, columns: null } as unknown as Parameters<typeof viewRows>[1]
    expect(viewRows(spec, style)).toEqual([{ start: 1_000_000 }])
    const sorted = viewRows(spec, { ...style, filter: '', sortKey: 'start' } as typeof style)
    expect(sorted.map((row) => row.start)).toEqual([5, 1_000_000])
  })
})
