/**
 * Summing a band of a dense block — the arithmetic under the 4C task.
 *
 * One property carries it and it fails quietly: the sum has to **skip** the
 * `NaN` a balancer leaves behind rather than propagate it, or one filtered row
 * inside an anchor turns every column into "touches nothing", which is the
 * opposite claim from the one the data supports.
 *
 * The lane that used to draw these sums beside the map is gone (§18.9) and the
 * projection onto canvas pixels went with it; what is left is the number, which
 * the task reads from a dense square when it has one on hand.
 */

import { describe, expect, it } from 'vitest'

import { bandSums } from '@/analysis/viewpoint'
import type { DenseMatrix } from '@/types'

/** A block whose cell (r, c) is a distinct, checkable number. */
function block(nrows: number, ncols: number, at: (row: number, col: number) => number): DenseMatrix {
  const values = new Float32Array(nrows * ncols)
  for (let row = 0; row < nrows; row++) {
    for (let col = 0; col < ncols; col++) values[row * ncols + col] = at(row, col)
  }
  return { nrows, ncols, values, rowExtent: [0, nrows], colExtent: [0, ncols] }
}

describe('summing a band of rows', () => {
  it('adds the rows the anchor names, and no others', () => {
    // Cell (r, c) = c + 1, so a band of k rows sums to k * (c + 1).
    const sums = bandSums(block(6, 4, (_row, col) => col + 1), [2, 5])
    expect([...sums]).toEqual([3, 6, 9, 12])
  })

  it('is half-open, and clamps an anchor that runs off the block', () => {
    const matrix = block(4, 3, () => 1)
    expect([...bandSums(matrix, [0, 1])]).toEqual([1, 1, 1])
    expect([...bandSums(matrix, [3, 400])]).toEqual([1, 1, 1])
    expect([...bandSums(matrix, [2, 2])]).toEqual([0, 0, 0])
  })

  // The balancer drops low-coverage bins and leaves `NaN` behind (§6.4). One of
  // those inside the anchor must not take the column with it: "this row was
  // filtered" and "this column touches nothing" are opposite claims.
  it('skips a filtered bin rather than propagating it', () => {
    const matrix = block(3, 2, (row, col) => (row === 1 ? Number.NaN : col + 1))
    expect([...bandSums(matrix, [0, 3])]).toEqual([2, 4])
  })
})

/**
 * The other way round: the same anchor, summed over a band of columns, answered
 * per row.
 *
 * A separate description rather than a parameterised copy of the one above,
 * because the failure it guards against is a transposed index — a bug that
 * produces a plausible profile of the wrong axis, and that a test sharing the
 * loop under test could not see.
 */
describe('summing a band of columns', () => {
  it('answers per row, over the columns the anchor names', () => {
    // Cell (r, c) = r + 1, so a band of k columns sums to k * (r + 1).
    const sums = bandSums(block(4, 6, (row) => row + 1), [2, 5], 'rows')
    expect([...sums]).toEqual([3, 6, 9, 12])
  })

  it('is the transpose of the row band, on a block that is not square', () => {
    // Rows and columns carry different numbers, so an axis mix-up cannot
    // coincide: reading (r, c) = 10r + c one way must not answer the other.
    const matrix = block(3, 5, (row, col) => 10 * row + col)
    expect([...bandSums(matrix, [0, 3], 'cols')]).toEqual([30, 33, 36, 39, 42])
    expect([...bandSums(matrix, [0, 5], 'rows')]).toEqual([10, 60, 110])
  })

  it('clamps to the column count rather than to the row count', () => {
    const matrix = block(2, 3, () => 1)
    expect([...bandSums(matrix, [0, 400], 'rows')]).toEqual([3, 3])
  })

  it('skips a filtered bin rather than propagating it', () => {
    const matrix = block(2, 3, (row, col) => (col === 1 ? Number.NaN : row + 1))
    expect([...bandSums(matrix, [0, 3], 'rows')]).toEqual([2, 4])
  })
})
