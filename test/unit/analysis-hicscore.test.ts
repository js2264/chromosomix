/**
 * The HiC score, checked against the script it reproduces.
 *
 * The kernel walks one bin's line across the near-diagonal and averages it, and
 * the reading it has to agree with is not a paraphrase: it is the R the score
 * comes from, whose accumulation loop is transcribed below index for index —
 * including the part that is easy to get wrong, which is that a positive offset
 * lands the cell on the *column* it ends at and a negative one on the column it
 * starts from. Both are the same contact under the symmetry, and a
 * transcription that quietly counted one of them twice would still look like a
 * plausible track.
 *
 * What is being pinned beyond that equality:
 *
 * - the score is `rle2 / N` exactly, where `N = 2D − 1` — the shape is the same
 *   set of cells, and the only difference is the division;
 * - it is **half a crosshair**: one arm-pair through the diagonal, so a contact
 *   is counted once and not once per arm;
 * - `N` is fixed by the test that a **uniform** map scores its own value, which
 *   a wrong denominator fails by a number no amount of staring at a track would
 *   reveal;
 * - a bin without a **whole** line through it scores nothing rather than a short
 *   sum divided by a full `N`, which would fade both ends of a chromosome;
 * - a bin whose line is mostly dropped scores `NaN`;
 * - and on a circular sequence the line wraps, so the ends score rather than
 *   fading out — which is a different track and not a cosmetic difference.
 */

import { describe, expect, it } from 'vitest'

import { squareBand } from '@/analysis/band'
import { hicScore, lineCells } from '@/analysis/hicscore'
import { DEFAULT_HIC_SCORE_DIAGONALS, diagonalsOf, reachOf } from '@/analysis/tasks/hicscore'

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

/**
 * The R script's own loop, transcribed.
 *
 * `for (offset in -num_diagonals:num_diagonals)`, with its two index cases and
 * the two ranges it adds them to. `num_diagonals` is `D − 1` here: it counts the
 * diagonals *beside* the main one where this task counts them including it.
 */
function rleScript(values: Float32Array, n: number, beside: number): Float64Array {
  const sum = new Float64Array(n)
  for (let offset = -beside; offset <= beside; offset++) {
    if (offset === 0) {
      for (let i = 0; i < n; i++) sum[i] += values[i * n + i]
    } else if (offset > 0) {
      // `diagonal_sum[(1 + offset):n] <- … + contact_map[cbind(1:(n-offset), (1+offset):n)]`
      for (let i = 0; i + offset < n; i++) sum[i + offset] += values[i * n + (i + offset)]
    } else {
      // `diagonal_sum[1:(n + offset)] <- … + contact_map[cbind((1-offset):n, 1:(n+offset))]`
      const back = -offset
      for (let i = 0; i + back < n; i++) sum[i] += values[(i + back) * n + i]
    }
  }
  return sum
}

/** The whole crosshair — row and column both — for the identity below. */
function crosshair(values: Float32Array, n: number, bin: number, far: number): number {
  let sum = 0
  for (let d = -far; d <= far; d++) {
    if (bin + d < 0 || bin + d >= n) continue
    sum += values[bin * n + (bin + d)]
    if (d !== 0) sum += values[(bin + d) * n + bin]
  }
  return sum
}

describe('lineCells', () => {
  it('is one cell on the main diagonal and two on every other', () => {
    for (let d = 1; d <= 9; d++) expect(lineCells(d)).toBe(2 * d - 1)
    // The bacterial default: three diagonals, five cells.
    expect(lineCells(3)).toBe(5)
  })

  it('drops a diagonal at a time, and empties past the line', () => {
    expect(lineCells(3, 1)).toBe(4) // the main one goes, its two arms stay
    expect(lineCells(3, 2)).toBe(2) // only separation 2 is left, both sides
    expect(lineCells(3, 3)).toBe(0)
    expect(lineCells(3, 99)).toBe(0)
  })
})

describe('hicScore', () => {
  it('is the R script’s own sum, divided by N', () => {
    const n = 60
    const values = noisySquare(n)
    for (const diagonals of [1, 2, 3, 6]) {
      const far = diagonals - 1
      const score = hicScore(squareBand(values, n, { hi: far }), { diagonals, minValid: 1 })
      const reference = rleScript(values, n, far)
      for (let bin = far; bin < n - far; bin++) {
        expect(score[bin] * lineCells(diagonals)).toBeCloseTo(reference[bin], 5)
      }
    }
  })

  it('scores a uniform map at its own value, which is what fixes N', () => {
    const n = 40
    const values = new Float32Array(n * n).fill(3)
    for (const diagonals of [1, 3, 7]) {
      const score = hicScore(squareBand(values, n, { hi: diagonals - 1 }), { diagonals, minValid: 1 })
      for (let bin = diagonals; bin < n - diagonals; bin++) expect(score[bin]).toBeCloseTo(3, 10)
    }
  })

  it('is half a crosshair: each contact once, not once per arm', () => {
    // `cross = 2 × line − diagonal` on a symmetric matrix, which is what makes
    // the line the honest half of the figure rather than an arbitrary one.
    const n = 50
    const diagonals = 4
    const far = diagonals - 1
    const values = noisySquare(n)
    const cells = lineCells(diagonals)
    const score = hicScore(squareBand(values, n, { hi: far }), { diagonals, minValid: 1 })
    for (let bin = far; bin < n - far; bin++) {
      expect(2 * score[bin] * cells - values[bin * n + bin]).toBeCloseTo(
        crosshair(values, n, bin, far),
        4,
      )
    }
  })

  it('cuts diagonals off the near end, N with them', () => {
    const n = 60
    const diagonals = 6
    const values = noisySquare(n)
    const score = hicScore(squareBand(values, n, { hi: diagonals - 1 }), {
      diagonals,
      minValid: 1,
      ignoreDiags: 2,
    })
    for (let bin = diagonals; bin < n - diagonals; bin++) {
      let sum = 0
      for (let sep = 2; sep <= diagonals - 1; sep++) {
        sum += values[bin * n + (bin + sep)] + values[bin * n + (bin - sep)]
      }
      expect(score[bin]).toBeCloseTo(sum / lineCells(diagonals, 2), 5)
    }
  })

  it('scores nothing where the line is not wholly on the sequence', () => {
    const n = 60
    const diagonals = 5
    const far = diagonals - 1
    // `minValid: 0` would score anything with one countable cell in it, so this
    // is the case that separates *a line off the end* from *a line with gaps in
    // it*: the ends are refused whatever the coverage threshold says.
    const score = hicScore(squareBand(noisySquare(n), n, { hi: far }), { diagonals, minValid: 0 })
    for (let bin = 0; bin < far; bin++) {
      expect(score[bin]).toBeNaN()
      expect(score[n - 1 - bin]).toBeNaN()
    }
    expect(score[far]).not.toBeNaN()
    expect(score[n - 1 - far]).not.toBeNaN()
  })

  it('has nothing to say about a sequence shorter than the line', () => {
    const n = 5
    const diagonals = 9
    const score = hicScore(squareBand(noisySquare(n), n, { hi: 8 }), { diagonals, minValid: 0 })
    for (let bin = 0; bin < n; bin++) expect(score[bin]).toBeNaN()
  })

  it('needs 2D − 1 bins before any bin has a whole line', () => {
    // The boundary the runner's own length filter mirrors: one bin fewer than
    // the line spans and the whole sequence is a gap; exactly as many, and the
    // middle bin alone scores.
    const diagonals = 3
    const far = diagonals - 1
    for (const n of [2 * far, 2 * far + 1]) {
      const score = hicScore(squareBand(noisySquare(n), n, { hi: far }), { diagonals, minValid: 0 })
      const scored = Array.from(score).filter((v) => Number.isFinite(v)).length
      expect(scored).toBe(n === 2 * far ? 0 : 1)
    }
  })

  it('wraps the line round a circular sequence, so every bin scores', () => {
    const n = 60
    const diagonals = 3
    const far = diagonals - 1
    const values = noisySquare(n)
    const score = hicScore(squareBand(values, n, { circular: true, hi: far }), {
      diagonals,
      minValid: 1,
    })
    for (let bin = 0; bin < n; bin++) {
      let sum = 0
      for (let d = -far; d <= far; d++) sum += values[bin * n + (((bin + d) % n) + n) % n]
      expect(score[bin]).toBeCloseTo(sum / lineCells(diagonals), 5)
    }
  })

  it('drops a bin whose line is mostly missing', () => {
    const n = 60
    const diagonals = 4
    const values = noisySquare(n)
    // A dropped stretch, as the balancer leaves one: whole rows and their
    // mirrored columns.
    for (let dead = 28; dead < 34; dead++) {
      for (let k = 0; k < n; k++) {
        values[dead * n + k] = Number.NaN
        values[k * n + dead] = Number.NaN
      }
    }
    const score = hicScore(squareBand(values, n, { hi: diagonals - 1 }), {
      diagonals,
      minValid: 0.5,
    })
    expect(score[30]).toBeNaN()
    // And a bin far from it is untouched, rather than the whole track going.
    expect(score[10] * lineCells(diagonals)).toBeCloseTo(rleScript(values, n, diagonals - 1)[10], 5)
  })

  it('divides a line with gaps by the whole of N, rather than scaling it up', () => {
    const n = 40
    const diagonals = 3
    const values = new Float32Array(n * n).fill(4)
    // One dropped row inside bin 20's line: it takes 1 of the 5 cells, so the
    // mean is 4 × 4/5 rather than 4.
    for (let k = 0; k < n; k++) {
      values[19 * n + k] = Number.NaN
      values[k * n + 19] = Number.NaN
    }
    const score = hicScore(squareBand(values, n, { hi: diagonals - 1 }), {
      diagonals,
      minValid: 0.5,
    })
    expect(score[20]).toBeCloseTo((4 * 4) / 5, 6)
  })
})

/**
 * The number a reader types, and the line it becomes.
 *
 * Diagonals counting the main one — so the reach each way, and the depth the
 * band is read to, is one less. The R script's `num_diagonals` is that reach:
 * its 2 is this task's 3.
 */
describe('the diagonal count', () => {
  it('defaults to three diagonals, which is five cells reaching two bins', () => {
    expect(DEFAULT_HIC_SCORE_DIAGONALS).toBe(3)
    expect(diagonalsOf({})).toBe(3)
    expect(reachOf({})).toBe(2)
    expect(lineCells(diagonalsOf({}))).toBe(5)
  })

  it('reaches one bin fewer than it counts', () => {
    expect(reachOf({ diagonals: 1 })).toBe(0)
    expect(reachOf({ diagonals: 5 })).toBe(4)
    expect(reachOf({ diagonals: 25 })).toBe(24)
  })

  it('floors at the main diagonal alone', () => {
    expect(diagonalsOf({ diagonals: 0 })).toBe(1)
    expect(diagonalsOf({ diagonals: -4 })).toBe(1)
    expect(reachOf({ diagonals: 0 })).toBe(0)
  })
})
