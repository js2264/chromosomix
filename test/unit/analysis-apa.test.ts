/**
 * The APA kernel: averaging, resampling, the corner statistic and the control.
 *
 * What is worth pinning here is not that a mean is a mean. It is the four
 * places a pileup can be plausible and wrong:
 *
 * - a window with gaps averaged **per window** instead of per cell, which makes
 *   the picture depend on how ragged its inputs were;
 * - a scaled window resampled nearest-neighbour, which blurs a set of
 *   differently-sized domains into something that looks like biology;
 * - a P2LL taken against the whole border rather than the lower-left corner,
 *   which makes a stripe read as a dot;
 * - a distance-matched control drawn at the wrong separation, which puts the
 *   distance decay back into the answer it was supposed to remove.
 */

import { describe, expect, it } from 'vitest'

import {
  PileupAccumulator,
  p2ll,
  ratioOf,
  resampleWindow,
  shiftedControls,
} from '@/analysis/apa'
import { makeRandom } from '@/analysis/random'

describe('PileupAccumulator', () => {
  it('averages cell by cell, not window by window', () => {
    const acc = new PileupAccumulator(1, 2)
    acc.add([2, Number.NaN])
    acc.add([4, 10])
    const { values, n } = acc.finish()
    // The first cell saw two windows, the second only one. Averaging per window
    // would divide both by two and halve the second.
    expect(values[0]).toBe(3)
    expect(values[1]).toBe(10)
    expect(n).toBe(2)
  })

  it('leaves a cell no window reached as a gap', () => {
    const acc = new PileupAccumulator(1, 2)
    acc.add([1, Number.NaN])
    expect(acc.finish().values[1]).toBeNaN()
  })

  it('does not count a window that contributed nothing', () => {
    const acc = new PileupAccumulator(1, 2)
    acc.add([1, 1])
    acc.add([Number.NaN, Number.NaN])
    expect(acc.finish().n).toBe(1)
  })
})

describe('resampleWindow', () => {
  it('copies a window that is already the right shape', () => {
    const out = resampleWindow([1, 2, 3, 4], 2, 2, 2, 2)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('area-weights when it shrinks, rather than picking a corner', () => {
    // A 2x2 of distinct values into 1x1 is their mean; nearest-neighbour would
    // answer with whichever cell it happened to land on.
    const out = resampleWindow([1, 2, 3, 4], 2, 2, 1, 1)
    expect(out[0]).toBeCloseTo(2.5, 12)
  })

  it('spreads a small window over a larger grid without inventing structure', () => {
    const out = resampleWindow([5], 1, 1, 2, 2)
    expect(Array.from(out)).toEqual([5, 5, 5, 5])
  })

  it('skips gaps rather than averaging them in as zero', () => {
    const out = resampleWindow([1, Number.NaN, 3, 5], 2, 2, 1, 1)
    // Mean of the three finite cells, not of four with a zero.
    expect(out[0]).toBeCloseTo(3, 12)
  })
})

describe('p2ll', () => {
  /** A square with a bright centre on a flat background. */
  function dot(side: number, background: number, peak: number): Float64Array {
    const values = new Float64Array(side * side).fill(background)
    const centre = Math.floor(side / 2)
    values[centre * side + centre] = peak
    return values
  }

  it('is above one for a dot and about one for a flat square', () => {
    expect(p2ll(dot(15, 1, 10), 15, 15)).toBeGreaterThan(1)
    expect(p2ll(new Float64Array(15 * 15).fill(3), 15, 15)).toBeCloseTo(1, 12)
  })

  it('takes its denominator from the lower-left corner and nowhere else', () => {
    // The corner choice is the whole statistic. Here every *other* edge of the
    // square is bright — which is what a pair of stripes through the anchors
    // looks like — and only the lower-left quadrant is at background. A P2LL
    // taken against the border, or against the mean of the square, would divide
    // by that brightness and under-report the centre; against the corner it
    // reports the centre over a background the stripes never reach.
    const side = 15
    const quadrant = Math.floor(side / 5)
    const values = new Float64Array(side * side).fill(20)
    // The lower-left quadrant, held at 2.
    for (let r = side - quadrant; r < side; r++) {
      for (let c = 0; c < quadrant; c++) values[r * side + c] = 2
    }
    // The peak is the centre *block*, not a single cell: the statistic averages
    // a small square about the middle so that one bright bin cannot carry it.
    const centre = Math.floor(side / 2)
    const half = Math.floor(quadrant / 2)
    for (let r = centre - half; r <= centre + half; r++) {
      for (let c = centre - half; c <= centre + half; c++) values[r * side + c] = 8
    }
    // Centre 8 over corner 2, so the answer is 4 — a number that comes from the
    // corner and from nothing else in the square.
    expect(p2ll(values, side, side)).toBeCloseTo(4, 12)
  })

  it('answers NaN rather than infinity when the corner is empty', () => {
    const side = 11
    const values = new Float64Array(side * side).fill(Number.NaN)
    const centre = Math.floor(side / 2)
    values[centre * side + centre] = 5
    expect(p2ll(values, side, side)).toBeNaN()
  })
})

describe('ratioOf', () => {
  it('gives no ratio against a zero rather than an infinity', () => {
    // An infinity cannot be drawn on a diverging scale and would take the colour
    // range of the whole picture with it (S16.7).
    const out = ratioOf([4, 4], [2, 0])
    expect(out[0]).toBe(2)
    expect(out[1]).toBeNaN()
  })
})

describe('shiftedControls', () => {
  const bounds = { from: 0, to: 1000 }

  it('preserves the separation exactly', () => {
    const controls = shiftedControls({ row: 400, col: 450, separation: 50 }, bounds, {
      perPair: 20,
      minShift: 10,
      maxShift: 100,
      rng: makeRandom(4),
    })
    expect(controls.length).toBeGreaterThan(0)
    // The whole point: a control at a different distance controls for the wrong
    // thing and lets the distance decay back in as signal.
    for (const control of controls) {
      expect(control.col - control.row).toBe(50)
      expect(control.separation).toBe(50)
    }
  })

  it('keeps a control inside its own sequence', () => {
    const controls = shiftedControls({ row: 10, col: 20, separation: 10 }, bounds, {
      perPair: 40,
      minShift: 1,
      maxShift: 500,
      rng: makeRandom(9),
    })
    for (const control of controls) {
      expect(control.row).toBeGreaterThanOrEqual(bounds.from)
      expect(control.col).toBeLessThan(bounds.to)
    }
  })

  it('drops a control it cannot place rather than clamping it', () => {
    // An anchor near the start of a sequence, with shifts large enough that
    // half of every draw falls off the front. Clamping would pile those onto
    // bin 0 and give the denominator a structure of its own; dropping them
    // simply yields fewer controls, all of them real.
    const controls = shiftedControls({ row: 5, col: 10, separation: 5 }, bounds, {
      perPair: 30,
      minShift: 900,
      maxShift: 990,
      rng: makeRandom(2),
    })
    expect(controls.length).toBeLessThan(30)
    for (const control of controls) {
      expect(control.row).toBeGreaterThanOrEqual(bounds.from)
      expect(control.col).toBeLessThan(bounds.to)
    }
    // Nothing piled onto the boundary itself, which is what clamping looks like.
    expect(controls.filter((control) => control.row === bounds.from)).toHaveLength(0)
  })

  it('draws the same controls twice for the same seed', () => {
    const draw = (seed: number): string =>
      shiftedControls({ row: 400, col: 450, separation: 50 }, bounds, {
        perPair: 10,
        minShift: 10,
        maxShift: 100,
        rng: makeRandom(seed),
      })
        .map((control) => control.row)
        .join()
    expect(draw(11)).toBe(draw(11))
    expect(draw(11)).not.toBe(draw(12))
  })
})
