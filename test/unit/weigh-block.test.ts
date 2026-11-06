/**
 * Balancing a dense block without visiting the zeros it cannot change
 * (`metacooler/matrix.ts`, `weighBlock`), held to the cell-by-cell loop it
 * replaced — bit for bit, so a zero keeps its sign and an unbalanced bin's row
 * and column stay NaN through and through.
 */

import { describe, expect, it } from 'vitest'

import { weighBlock } from '@/metacooler/matrix'

/** Deterministic, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** The loop as it was: every cell, `v · w_r · w_c`. */
function reference(values: Float32Array, rowWeights: Float64Array, colWeights: Float64Array): Float32Array {
  const out = values.slice()
  const nCols = colWeights.length
  for (let r = 0; r < rowWeights.length; r++) {
    for (let c = 0; c < nCols; c++) out[r * nCols + c] = out[r * nCols + c] * rowWeights[r] * colWeights[c]
  }
  return out
}

function weights(n: number, random: () => number): Float64Array {
  return Float64Array.from({ length: n }, () => {
    const u = random()
    return u < 0.05 ? Number.NaN
      : u < 0.07 ? 0
      : u < 0.08 ? Number.POSITIVE_INFINITY
      : u < 0.09 ? -random()
      : random() * 3
  })
}

describe('weighBlock', () => {
  it('is the cell-by-cell product, bit for bit, whatever the cells and the weights', () => {
    for (const [nRows, nCols, seed] of [
      [37, 53, 1],
      [64, 64, 2],
      [1, 200, 3],
      [200, 1, 4],
    ] as const) {
      const random = rng(seed)
      const values = Float32Array.from({ length: nRows * nCols }, () => {
        const u = random()
        return u < 0.6 ? 0
          : u < 0.65 ? -0
          : u < 0.68 ? Number.NaN
          : u < 0.7 ? Number.POSITIVE_INFINITY
          : u < 0.72 ? -random()
          : Math.floor(random() * 50) + 1
      })
      const rowWeights = weights(nRows, random)
      const colWeights = weights(nCols, random)
      const expected = reference(values, rowWeights, colWeights)
      const got = values.slice()
      weighBlock(got, rowWeights, colWeights)
      expect(Buffer.from(got.buffer).equals(Buffer.from(expected.buffer)), `${nRows}x${nCols}`).toBe(true)
    }
  })

  it('weighs a rectangular block by its own column weights', () => {
    const values = Float32Array.from([1, 0, 2, 0, 3, 0])
    weighBlock(values, Float64Array.from([2, Number.NaN]), Float64Array.from([1, 10, 100]))
    expect(Array.from(values)).toEqual([2, 0, 400, Number.NaN, Number.NaN, Number.NaN])
  })
})
