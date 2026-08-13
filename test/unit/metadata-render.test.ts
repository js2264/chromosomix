/**
 * What a metadata lane draws (§8.12), asserted as numbers rather than pixels.
 *
 * Two claims, and both are about *alignment*: a metadata lane is indexed by the
 * map's own cells, so a MAG's bar has to stand over the MAG's own column and a
 * category boundary has to fall where the data says it does. Off by half a cell
 * is a picture that looks right and is not, which is exactly the class of
 * failure §8.4 makes one coordinate model to prevent.
 *
 * The third claim is about the turn: a turned map is drawn on a half-bin
 * lattice, so the cells of the block are two of its columns each, counted from
 * the rotation's origin. That is one pair of numbers ({@link CellScale}) and it
 * is the only place a turn is visible to this renderer.
 */

import { describe, expect, it } from 'vitest'

import { categoryRuns, profileFromCells } from '../../src/render/meta'
import type { LaneFrame } from '../../src/render/lane'

/** A bottom lane 10 pixels per cell wide, over 8 cells of data. */
function frameOf(scale = 10, from = 0): LaneFrame {
  return {
    orientation: 'bottom',
    toPixel: (unit) => from + unit * scale,
    toUnit: (pixel) => (pixel - from) / scale,
    domain: [0, 8],
    alongFrom: from,
    alongTo: from + 8 * scale,
    acrossFrom: 0,
    thickness: 40,
  }
}

describe('a quantitative column’s profile', () => {
  it('fills exactly the pixels its own cell covers', () => {
    const profile = profileFromCells(frameOf(), Float64Array.from([5, 9, 1]))
    // Cell 0 is pixels 0–9, cell 1 is 10–19, cell 2 is 20–29, and nothing
    // beyond that: three cells of a lane with room for eight.
    expect(profile.mean[0]).toBe(5)
    expect(profile.mean[9]).toBe(5)
    expect(profile.mean[10]).toBe(9)
    expect(profile.mean[19]).toBe(9)
    expect(profile.mean[20]).toBe(1)
    expect(Number.isNaN(profile.mean[30])).toBe(true)
    expect(profile.extent).toEqual({ min: 1, max: 9 })
  })

  it('averages the cells a pixel covers when there are more cells than pixels', () => {
    // A tenth of a pixel per cell: ten cells share pixel 0, and the number that
    // belongs there is the mean over them rather than whichever was sampled.
    const cells = Float64Array.from({ length: 10 }, (_, i) => i)
    const profile = profileFromCells(frameOf(0.1), cells)
    expect(profile.mean[0]).toBeCloseTo(4.5, 6)
  })

  it('leaves a cell with no value as a gap rather than as a zero', () => {
    const profile = profileFromCells(frameOf(), Float64Array.from([2, Number.NaN, 4]))
    expect(profile.mean[0]).toBe(2)
    expect(Number.isNaN(profile.mean[10])).toBe(true)
    expect(profile.mean[20]).toBe(4)
    // …and the gap takes no part in the range the axis is drawn against.
    expect(profile.extent).toEqual({ min: 2, max: 4 })
  })

  it('reads the cells through the scale a turned map imposes', () => {
    // Half-bin columns: one cell is two of them, and the block opens two bins
    // past the rotation's origin, so cell 0 begins at column 4.
    const scale = { origin: 4, per: 2 }
    const profile = profileFromCells(frameOf(10), Float64Array.from([7]), scale)
    expect(Number.isNaN(profile.mean[39])).toBe(true)
    expect(profile.mean[40]).toBe(7)
    expect(profile.mean[59]).toBe(7)
    expect(Number.isNaN(profile.mean[60])).toBe(true)
  })
})

describe('a qualitative column’s runs', () => {
  it('joins consecutive cells of one category into the block a reader sees', () => {
    expect(categoryRuns(Int32Array.from([0, 0, 0, 1, 1, 2]))).toEqual([
      { code: 0, from: 0, to: 3 },
      { code: 1, from: 3, to: 5 },
      { code: 2, from: 5, to: 6 },
    ])
  })

  it('breaks a run at a gap, and never makes a run of one', () => {
    // `-1` is *no value here* — a cell the table has no row for — and drawing it
    // as a category would give the gaps a colour and a legend entry.
    expect(categoryRuns(Int32Array.from([1, -1, -1, 1]))).toEqual([
      { code: 1, from: 0, to: 1 },
      { code: 1, from: 3, to: 4 },
    ])
    expect(categoryRuns(Int32Array.from([-1, -1]))).toEqual([])
    expect(categoryRuns(new Int32Array(0))).toEqual([])
  })

  it('runs to the end of the axis without a trailing gap to close it', () => {
    expect(categoryRuns(Int32Array.from([3, 3]))).toEqual([{ code: 3, from: 0, to: 2 }])
  })
})
