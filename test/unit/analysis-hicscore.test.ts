/**
 * The HiC score, checked against the loop it is an optimisation of.
 *
 * The kernel walks one diagonal at a time with a running prefix, which is the
 * same addition in a different order — so the test that matters is that it *is*
 * the same addition. `bruteForce` below is the obvious double loop, written out
 * so slowly that it is obviously right, and the properties are checked against
 * it on a square with no symmetry in it at all: a uniform square would agree
 * with almost any wrong implementation.
 *
 * The three that are not equality:
 *
 * - the square includes its **corners**, which is what separates this reading
 *   from a band and needs a band read `2h` deep to have;
 * - a bin whose window is mostly gone scores `NaN` rather than a small number;
 * - and on a circular sequence the window wraps, so the ends score rather than
 *   fading out — which is a different track and not a cosmetic difference.
 */

import { describe, expect, it } from 'vitest'

import { squareBand } from '@/analysis/band'
import { hicScore } from '@/analysis/hicscore'

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
  for (let r = bin - h; r <= bin + h; r++) {
    for (let c = bin - h; c <= bin + h; c++) {
      let row = r
      let col = c
      if (options.circular === true) {
        row = ((r % n) + n) % n
        col = ((c % n) + n) % n
      } else if (row < 0 || row >= n || col < 0 || col >= n) {
        continue
      }
      if (Math.abs(col - row) < ignore) continue
      const value = values[row * n + col]
      if (Number.isFinite(value)) sum += value
    }
  }
  return sum
}

describe('hicScore', () => {
  it('is the sum of the whole square, corners included', () => {
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

  it('leaves the ends of a linear sequence as gaps', () => {
    const n = 60
    const h = 4
    const score = hicScore(squareBand(noisySquare(n), n, { hi: 2 * h }), {
      halfWidth: h,
      minValid: 1,
    })
    expect(score[0]).toBeNaN()
    expect(score[n - 1]).toBeNaN()
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
})
