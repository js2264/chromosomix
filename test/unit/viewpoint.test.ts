/**
 * The virtual 4C profile, as arithmetic.
 *
 * Two properties carry it and both fail quietly. The **sum** has to skip the
 * `NaN` a balancer leaves behind rather than propagate it, or one filtered row
 * inside an anchor turns every column into "touches nothing" — a claim the
 * picture above the lane visibly contradicts, but only if you look. And the
 * **projection** onto canvas pixels has to average rather than total, or the
 * height of the line depends on the zoom and the value axis is meaningless.
 */

import { describe, expect, it } from 'vitest'

import { columnSums, profileFromSums } from '@/render/viewpoint'
import type { LaneFrame } from '@/render/lane'
import type { DenseMatrix } from '@/types'

/** A block whose cell (r, c) is a distinct, checkable number. */
function block(nrows: number, ncols: number, at: (row: number, col: number) => number): DenseMatrix {
  const values = new Float32Array(nrows * ncols)
  for (let row = 0; row < nrows; row++) {
    for (let col = 0; col < ncols; col++) values[row * ncols + col] = at(row, col)
  }
  return { nrows, ncols, values, rowExtent: [0, nrows], colExtent: [0, ncols] }
}

/**
 * A lane over `pixels` canvas pixels showing `units` matrix columns.
 *
 * Only the four members the profile reads are real; the rest of `LaneFrame` is
 * the drawing code's, and nothing here draws.
 */
function frame(pixels: number, units: number): LaneFrame {
  return {
    orientation: 'bottom',
    toPixel: (unit) => (unit * pixels) / units,
    toUnit: (pixel) => (pixel * units) / pixels,
    domain: [0, units],
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 0,
    thickness: 40,
  }
}

describe('summing a band of rows', () => {
  it('adds the rows the anchor names, and no others', () => {
    // Cell (r, c) = c + 1, so a band of k rows sums to k * (c + 1).
    const sums = columnSums(block(6, 4, (_row, col) => col + 1), [2, 5])
    expect([...sums]).toEqual([3, 6, 9, 12])
  })

  it('is half-open, and clamps an anchor that runs off the block', () => {
    const matrix = block(4, 3, () => 1)
    expect([...columnSums(matrix, [0, 1])]).toEqual([1, 1, 1])
    expect([...columnSums(matrix, [3, 400])]).toEqual([1, 1, 1])
    expect([...columnSums(matrix, [2, 2])]).toEqual([0, 0, 0])
  })

  // The balancer drops low-coverage bins and leaves `NaN` behind (§6.4). One of
  // those inside the anchor must not take the column with it: "this row was
  // filtered" and "this column touches nothing" are opposite claims.
  it('skips a filtered bin rather than propagating it', () => {
    const matrix = block(3, 2, (row, col) => (row === 1 ? Number.NaN : col + 1))
    expect([...columnSums(matrix, [0, 3])]).toEqual([2, 4])
  })
})

describe('projecting the sums onto the lane', () => {
  // The property that keeps the value axis meaningful: the same data at two
  // zooms must put the line at the same height.
  it('averages the columns in a pixel rather than totalling them', () => {
    const sums = Float64Array.from([10, 10, 10, 10, 10, 10, 10, 10])
    const coarse = profileFromSums(sums, frame(4, 8))
    const fine = profileFromSums(sums, frame(8, 8))
    expect([...coarse.mean]).toEqual([10, 10, 10, 10])
    expect([...fine.mean]).toEqual([10, 10, 10, 10, 10, 10, 10, 10])
  })

  it('puts a peak under the column it came from', () => {
    const sums = new Float64Array(8)
    sums[5] = 100
    const profile = profileFromSums(sums, frame(8, 8))
    expect(profile.mean[5]).toBe(100)
    expect(profile.mean[4]).toBe(0)
    expect(profile.mean[6]).toBe(0)
  })

  // Zero is a reading — "nothing touches here" — and a floor at the minimum
  // would draw the emptiest column in view sitting on the axis.
  it('scales from zero, and gives an empty window a readable ceiling', () => {
    const peaky = profileFromSums(Float64Array.from([3, 9, 3, 3]), frame(4, 4))
    expect(peaky.extent).toEqual({ min: 0, max: 9 })
    const empty = profileFromSums(new Float64Array(4), frame(4, 4))
    expect(empty.extent).toEqual({ min: 0, max: 1 })
  })

  it('reports an envelope only where a pixel really covered several columns', () => {
    expect(profileFromSums(new Float64Array(64), frame(8, 64)).envelope).toBe(true)
    expect(profileFromSums(new Float64Array(8), frame(8, 8)).envelope).toBe(false)
  })
})
