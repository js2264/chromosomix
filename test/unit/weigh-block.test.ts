/**
 * Balancing a dense block without visiting the zeros it cannot change
 * (`metacooler/matrix.ts`, `weighBlock`), held to the cell-by-cell loop it
 * replaced — bit for bit wherever the loop makes a number, so a zero keeps its
 * sign, and NaN wherever it makes NaN, so an unbalanced bin's row and column
 * stay NaN through and through.
 *
 * Not the same NaN. ECMAScript lets a Float32Array hold whichever NaN encoding
 * an engine writes, and the encoding a product comes out with — of a NaN and a
 * NaN, or of 0 and ∞, which x86 makes with its sign bit set — depends on the
 * order the compiled code puts the two operands in, which the language leaves
 * to the engine. The 64 × 64 case below has 124 NaNs with the sign bit set and
 * 375 without; compared byte for byte, it passed under Node 22 and failed under
 * Node 24, the same arithmetic in both.
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

/**
 * Where two blocks disagree, or `null`: the same bits wherever either holds a
 * number — a zero's sign included — and NaN against NaN, whichever NaN.
 */
function disagreement(got: Float32Array, expected: Float32Array): string | null {
  if (got.length !== expected.length) return `${got.length} cells against ${expected.length}`
  const gotBits = new Uint32Array(got.buffer, got.byteOffset, got.length)
  const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length)
  for (let i = 0; i < got.length; i++) {
    if (Number.isNaN(got[i]) && Number.isNaN(expected[i])) continue
    if (gotBits[i] !== expectedBits[i]) {
      return `cell ${i}: ${Object.is(got[i], -0) ? '-0' : got[i]} where the loop makes ${Object.is(expected[i], -0) ? '-0' : expected[i]}`
    }
  }
  return null
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
  it('is the cell-by-cell product, a zero’s sign and every NaN included, whatever the cells and the weights', () => {
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
      expect(disagreement(got, expected), `${nRows}x${nCols}`).toBeNull()
    }
  })

  it('weighs a rectangular block by its own column weights', () => {
    const values = Float32Array.from([1, 0, 2, 0, 3, 0])
    weighBlock(values, Float64Array.from([2, Number.NaN]), Float64Array.from([1, 10, 100]))
    expect(Array.from(values)).toEqual([2, 0, 400, Number.NaN, Number.NaN, Number.NaN])
  })
})
