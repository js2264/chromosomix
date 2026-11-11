/**
 * The counted fields of a file's info (§3.2), read as metacooler's
 * `MetaCooler.info` reads them: Python's `int()`, kept only where it equals the
 * value. A float-count map's `sum` is fractional, and metacooler stopped
 * flooring it (`c3d91ce`); the reader follows, and a whole number still reads
 * as an integer.
 */

import { describe, expect, it } from 'vitest'
import { normaliseInfo } from '../../src/metacooler/detect'

describe('the counted fields of a file’s info', () => {
  it('keeps a float-count map’s fractional sum rather than its floor', () => {
    const info = normaliseInfo({ sum: 60816.5, nnz: 21633, nbins: 400 } as never)
    expect(info.sum).toBe(60816.5)
    expect(info.nnz).toBe(21633)
    expect(info.nbins).toBe(400)
  })

  it('reads a whole number, a whole float and an integer literal as integers', () => {
    const info = normaliseInfo({ sum: 60816, nnz: '21633', 'bin-size': 1000.0, nchroms: 44 } as never)
    expect(info.sum).toBe(60816)
    expect(info.nnz).toBe(21633)
    expect(info['bin-size']).toBe(1000)
    expect(info.ncontigs).toBe(44)
  })

  it('keeps a negative fractional value as it is, as `int()` would not equal it', () => {
    expect(normaliseInfo({ sum: -2.5 } as never).sum).toBe(-2.5)
  })
})
