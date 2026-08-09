/**
 * Diamond insulation, against squares whose answer is worked out by hand.
 *
 * Three properties are checked rather than a golden, because all three are
 * places a reimplementation goes wrong while still producing a plausible track,
 * and none of them needs cooltools to state:
 *
 * - the diamond is the rectangle *crossing* a bin, not a square centred on the
 *   diagonal — the difference between a dip and a smear;
 * - the ends of a contig get `NaN` and not a small number, since a partial
 *   window sums fewer cells and reads as strong insulation;
 * - a prominence is a climb on *both* sides, so one ragged trough is one call.
 */

import { describe, expect, it } from 'vitest'

import {
  callBoundaries,
  diamondSums,
  insulationScore,
  type ContigSquare,
} from '@/analysis/insulation'

/** A square of ones, so every diamond sum is its own cell count. */
function ones(size: number): ContigSquare {
  return { size, values: new Float32Array(size * size).fill(1) }
}

/** A square of ones with a cross of zeros through `at` — a perfect boundary. */
function withBoundary(size: number, at: number): ContigSquare {
  const square = ones(size)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      // Everything that crosses `at` is empty; everything on one side of it is
      // full. That is what a domain boundary is, in the limit.
      const crosses = (i < at && j >= at) || (j < at && i >= at)
      if (crosses) square.values[i * size + j] = 0
    }
  }
  return square
}

describe('diamondSums', () => {
  it('sums the window crossing the bin, and nothing else', () => {
    // On a square of ones, a diamond of half-width 2 covers 2 x 2 = 4 cells.
    const sums = diamondSums(ones(10), { window: 2, minValid: 0.5 })
    expect(sums[5]).toBe(4)
    expect(sums[2]).toBe(4)
  })

  it('gives the ends of a contig no score at all', () => {
    const sums = diamondSums(ones(10), { window: 2, minValid: 0.5 })
    // The diamond at `i` reads rows [i-2, i) and columns [i, i+2), so it fits
    // exactly for 2 <= i <= 8 on a ten-bin contig. Bins 0, 1 and 9 have no whole
    // window: a partial one would sum fewer cells and read as strong
    // insulation, which is the artefact this test exists to pin.
    expect(sums[0]).toBeNaN()
    expect(sums[1]).toBeNaN()
    expect(sums[9]).toBeNaN()
    expect(sums[2]).not.toBeNaN()
    expect(sums[8]).not.toBeNaN()
  })

  it('refuses a bin whose diamond is mostly missing', () => {
    const square = ones(10)
    // Blank three of the four cells of the diamond at bin 5.
    square.values[3 * 10 + 5] = Number.NaN
    square.values[3 * 10 + 6] = Number.NaN
    square.values[4 * 10 + 5] = Number.NaN
    const strict = diamondSums(square, { window: 2, minValid: 0.5 })
    expect(strict[5]).toBeNaN()
    // The same square with no requirement answers from the one cell left, which
    // is why the requirement exists rather than being a matter of taste.
    const loose = diamondSums(square, { window: 2, minValid: 0 })
    expect(loose[5]).toBe(1)
  })

  it('finds a boundary where one was built', () => {
    const sums = diamondSums(withBoundary(20, 10), { window: 3, minValid: 0.5 })
    expect(sums[10]).toBe(0)
    // And the bins away from it are full, so the trough is a trough.
    expect(sums[5]).toBe(9)
    expect(sums[15]).toBe(9)
  })
})

describe('insulationScore', () => {
  it('is zero at the mean and negative where contact is suppressed', () => {
    const score = insulationScore(Float64Array.from([4, 4, 2, 4, 4]))
    // Mean is 3.6; a bin at 4 is just above it and the bin at 2 well below.
    expect(score[0]).toBeGreaterThan(0)
    expect(score[2]).toBeLessThan(0)
    expect(score[2]).toBeCloseTo(Math.log2(2 / 3.6), 12)
  })

  it('answers NaN for a bin with no contact rather than minus infinity', () => {
    // A -Infinity would take the value axis of the whole lane with it, and
    // could not be written to a bigWig at all (S16.7).
    const score = insulationScore(Float64Array.from([4, 0, 4]))
    expect(score[1]).toBeNaN()
    expect(Number.isFinite(score[0])).toBe(true)
  })

  it('carries NaN straight through', () => {
    const score = insulationScore(Float64Array.from([4, Number.NaN, 4]))
    expect(score[1]).toBeNaN()
  })

  it('answers all NaN when nothing is finite, rather than throwing', () => {
    const score = insulationScore(Float64Array.from([Number.NaN, Number.NaN]))
    expect(Array.from(score).every(Number.isNaN)).toBe(true)
  })
})

describe('callBoundaries', () => {
  it('calls one boundary per trough, not one per bin of it', () => {
    // A ragged trough: two equal minima with a shallow bump between them, all
    // well below the flanks. A depth threshold would call three; prominence
    // calls the two real floors and skips the bump.
    const score = Float64Array.from([0, 0, -2, -1.9, -2, 0, 0])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([2, 4])
  })

  it('reports a flat plateau once, at its first bin', () => {
    const score = Float64Array.from([0, -2, -2, -2, 0])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([1])
  })

  it('measures prominence as the climb on both sides', () => {
    // Deep on the left, shallow on the right: the prominence is the smaller
    // climb, so a minimum on the flank of a bigger one is not a boundary.
    const score = Float64Array.from([5, -1, 0.5, -3, 5])
    const calls = callBoundaries(score, { prominence: 0, spacing: 1 })
    const shallow = calls.find((call) => call.bin === 1)
    expect(shallow?.prominence).toBeCloseTo(1.5, 12)
  })

  it('keeps the stronger of two calls that are too close together', () => {
    const score = Float64Array.from([0, -1, 0, -3, 0])
    const calls = callBoundaries(score, { prominence: 0, spacing: 4 })
    expect(calls.map((call) => call.bin)).toEqual([3])
  })

  it('is not fooled by the NaN ends of a real score', () => {
    const score = Float64Array.from([Number.NaN, Number.NaN, 0, -2, 0, Number.NaN])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([3])
  })
})
