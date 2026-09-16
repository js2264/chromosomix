/**
 * The HiC score, checked against the definition it is an optimisation of.
 *
 * The kernel walks one diagonal at a time with a running prefix, which is the
 * same addition in a different order — so the test that matters is that it *is*
 * the same addition. `bruteForce` below is the obvious double loop, written out
 * so slowly that it is obviously right, and the properties are checked against
 * it on a square with no symmetry in it at all: a uniform square would agree
 * with almost any wrong implementation.
 *
 * What is being pinned beyond equality:
 *
 * - it is the **mean of the upper triangle**, each contact counted once — which
 *   is not the sum of the whole square divided by anything, because the square
 *   holds every off-diagonal cell twice and the main diagonal once;
 * - `N` is the triangle's real cell count, `(2h + 1)(h + 1)`, and the test for
 *   it is that a **uniform** map scores its own value: a mean that is not one
 *   comes back as some other number, which no amount of staring at a track would
 *   reveal;
 * - a bin without a **whole** square around it scores nothing rather than a
 *   short sum divided by a full `N`, which would fade both ends of a chromosome
 *   towards zero;
 * - a bin whose window is mostly dropped scores `NaN`;
 * - and on a circular sequence the window wraps, so the ends score rather than
 *   fading out — which is a different track and not a cosmetic difference.
 */

import { describe, expect, it } from 'vitest'

import { squareBand } from '@/analysis/band'
import { hicScore, triangleCells } from '@/analysis/hicscore'
import { DEFAULT_HIC_SCORE_WINDOW_BINS, halfWidthAt, windowBinsOf } from '@/analysis/tasks/hicscore'

/** A symmetric square with no structure that could hide an indexing mistake. */
function noisySquare(n: number): Float32Array {
  const values = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      // Deterministic, asymmetric in magnitude across the matrix, and never
      // repeating — a mistake of one bin in either direction changes the answer.
      const value = ((i * 7919 + j * 104729) % 97) + 1
      values[i * n + j] = value
      values[j * n + i] = value
    }
  }
  return values
}

/** The definition, written as the double loop nobody would ship. */
function bruteForce(
  values: Float32Array,
  n: number,
  bin: number,
  h: number,
  options: { circular?: boolean; ignoreDiags?: number } = {},
): number {
  const ignore = options.ignoreDiags ?? 0
  let sum = 0
  // `k − x ≤ i ≤ j ≤ k + x`: the upper triangle of the window, main diagonal
  // included, every contact once.
  for (let i = bin - h; i <= bin + h; i++) {
    for (let j = i; j <= bin + h; j++) {
      if (j - i < ignore) continue
      let row = i
      let col = j
      if (options.circular === true) {
        row = ((i % n) + n) % n
        col = ((j % n) + n) % n
      } else if (row < 0 || row >= n || col < 0 || col >= n) {
        continue
      }
      const value = values[row * n + col]
      if (Number.isFinite(value)) sum += value
    }
  }
  return sum / triangleCells(h, ignore)
}

/** The whole square, for the identity the two readings are related by. */
function squareSum(values: Float32Array, n: number, bin: number, h: number): number {
  let sum = 0
  for (let r = bin - h; r <= bin + h; r++) {
    for (let c = bin - h; c <= bin + h; c++) {
      if (r < 0 || r >= n || c < 0 || c >= n) continue
      const value = values[r * n + c]
      if (Number.isFinite(value)) sum += value
    }
  }
  return sum
}

describe('triangleCells', () => {
  it('is the triangular number, not half the square', () => {
    for (let h = 0; h <= 8; h++) {
      const side = 2 * h + 1
      expect(triangleCells(h)).toBe((side * (side + 1)) / 2)
      // The form the method is usually written with, which is never a whole
      // number and is short by half a diagonal.
      expect(triangleCells(h)).toBeGreaterThan((side * side) / 2)
    }
    // The bacterial default: three diagonals, six cells.
    expect(triangleCells(1)).toBe(6)
  })

  it('drops a diagonal at a time, and empties past the window', () => {
    // A 5-bin square: 5 + 4 + 3 + 2 + 1 cells on separations 0 … 4.
    expect(triangleCells(2)).toBe(15)
    expect(triangleCells(2, 1)).toBe(10)
    expect(triangleCells(2, 2)).toBe(6)
    expect(triangleCells(2, 5)).toBe(0)
    expect(triangleCells(2, 99)).toBe(0)
  })
})

describe('hicScore', () => {
  it('is the mean of the window’s upper triangle', () => {
    const n = 60
    const h = 4
    const values = noisySquare(n)
    const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 1,
    })
    for (let bin = h; bin < n - h; bin++) {
      expect(score[bin]).toBeCloseTo(bruteForce(values, n, bin, h), 5)
    }
  })

  it('scores a uniform map at its own value, which is what fixes N', () => {
    const n = 40
    const values = new Float32Array(n * n).fill(3)
    for (const h of [1, 2, 5]) {
      const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
        halfWidth: h,
        minValid: 1,
      })
      for (let bin = h; bin < n - h; bin++) expect(score[bin]).toBeCloseTo(3, 10)
    }
  })

  it('counts each contact once, where the square counts most of them twice', () => {
    // `square = 2 × triangle − diagonal` on a symmetric matrix: the identity the
    // two readings differ by, and the reason the old sum was a different track
    // rather than this one rescaled.
    const n = 50
    const h = 3
    const values = noisySquare(n)
    const cells = triangleCells(h)
    const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 1,
    })
    for (let bin = h; bin < n - h; bin++) {
      let diagonal = 0
      for (let i = bin - h; i <= bin + h; i++) diagonal += values[i * n + i]
      expect(2 * score[bin] * cells - diagonal).toBeCloseTo(squareSum(values, n, bin, h), 4)
    }
  })

  it('agrees with the double loop when diagonals are cut', () => {
    const n = 60
    const h = 5
    const values = noisySquare(n)
    const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 1,
      ignoreDiags: 3,
    })
    for (let bin = h; bin < n - h; bin++) {
      expect(score[bin]).toBeCloseTo(bruteForce(values, n, bin, h, { ignoreDiags: 3 }), 5)
    }
  })

  it('scores nothing where the window is not wholly on the sequence', () => {
    const n = 60
    const h = 4
    // `minValid: 0` would score anything with one countable cell in it, so this
    // is the case that separates *a window off the end* from *a window with gaps
    // in it*: the ends are refused whatever the coverage threshold says.
    const score = hicScore(squareBand(noisySquare(n), n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 0,
    })
    for (let bin = 0; bin < h; bin++) {
      expect(score[bin]).toBeNaN()
      expect(score[n - 1 - bin]).toBeNaN()
    }
    expect(score[h]).not.toBeNaN()
    expect(score[n - 1 - h]).not.toBeNaN()
  })

  it('has nothing to say about a sequence shorter than the window', () => {
    const n = 5
    const h = 4
    const score = hicScore(squareBand(noisySquare(n), n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 0,
    })
    for (let bin = 0; bin < n; bin++) expect(score[bin]).toBeNaN()
  })

  it('wraps the window round a circular sequence, so every bin scores', () => {
    const n = 60
    const h = 4
    const values = noisySquare(n)
    const band = squareBand(values, n, { circular: true, hi: 2 * h })
    const score = hicScore(band, { halfWidth: h, minValid: 1 })
    for (let bin = 0; bin < n; bin++) {
      expect(score[bin]).toBeCloseTo(bruteForce(values, n, bin, h, { circular: true }), 5)
    }
  })

  it('drops a bin whose window is mostly missing', () => {
    const n = 60
    const h = 3
    const values = noisySquare(n)
    // A dropped stretch, as the balancer leaves one: whole rows and their
    // mirrored columns.
    for (let dead = 28; dead < 34; dead++) {
      for (let k = 0; k < n; k++) {
        values[dead * n + k] = Number.NaN
        values[k * n + dead] = Number.NaN
      }
    }
    const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 0.5,
    })
    expect(score[30]).toBeNaN()
    // And a bin far from it is untouched, rather than the whole track going.
    expect(score[10]).toBeCloseTo(bruteForce(values, n, 10, h), 5)
  })

  it('divides a window with gaps by the whole of N, rather than scaling it up', () => {
    const n = 40
    const h = 2
    const values = new Float32Array(n * n).fill(4)
    // One dropped row inside bin 20's window: 5 of its 15 cells go, so the mean
    // is 4 × 10/15 rather than 4.
    for (let k = 0; k < n; k++) {
      values[19 * n + k] = Number.NaN
      values[k * n + 19] = Number.NaN
    }
    const score = hicScore(squareBand(values, n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 0.5,
    })
    expect(score[20]).toBeCloseTo((4 * 10) / 15, 6)
  })
})

/**
 * The window a reader types, and the square it becomes.
 *
 * The number is the **side** of the square in bins, which on a window centred on
 * the diagonal is also how many diagonals it spans — and a square centred on a
 * bin has an odd number of bins on a side, so the even case has to round one way
 * or the other. Down, because a 4-bin window answered with a 5-bin square is a
 * window wider than the one on the label.
 */
describe('the window', () => {
  it('defaults to three diagonals, which is six cells', () => {
    expect(DEFAULT_HIC_SCORE_WINDOW_BINS).toBe(3)
    const half = halfWidthAt({})
    expect(half).toBe(1)
    expect(2 * half + 1).toBe(3)
    expect(triangleCells(half)).toBe(6)
  })

  it('is the largest odd square that fits, never the next one up', () => {
    expect(halfWidthAt({ window: 3 })).toBe(1)
    expect(halfWidthAt({ window: 4 })).toBe(1)
    expect(halfWidthAt({ window: 5 })).toBe(2)
    expect(halfWidthAt({ window: 25 })).toBe(12)
    expect(halfWidthAt({ window: 50 })).toBe(24)
  })

  it('floors at the smallest square there is', () => {
    expect(windowBinsOf({ window: 0 })).toBe(1)
    expect(halfWidthAt({ window: 1 })).toBe(1)
    expect(halfWidthAt({ window: 2 })).toBe(1)
  })
})
