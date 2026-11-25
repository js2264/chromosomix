// @dev-feature curate
/** metaTOR's grades of a MAG (`validation.py::bin_quality`), on the weighted pair. */

import { describe, expect, it } from 'vitest'
import { grade } from '../../src/curate/ui/grade'

describe('a MAG’s grade', () => {
  it('is metaTOR’s: none under half complete, contaminated past 1.10 only from there', () => {
    expect(grade(0.95, 1.04)).toBe('high')
    expect(grade(0.95, 1.06)).toBe('medium')
    expect(grade(0.72, 1.1)).toBe('medium')
    expect(grade(0.5, 1.0)).toBe('low')
    expect(grade(0.6, 1.11)).toBe('contaminated')
    expect(grade(0.4, 1.5)).toBeNull()
    expect(grade(Number.NaN, 1)).toBeNull()
  })
})
