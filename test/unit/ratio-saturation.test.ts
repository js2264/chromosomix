/**
 * The two ends of a ratio map, and the numbers a reader checks them against.
 *
 * A ratio field has three answers no ordinary contact map produces, and every
 * one of them lands outside the colour scale: `x / 0` is `Infinity`, `0 / x` is
 * zero and therefore `-Infinity` once it is drawn on `log2`, and `0 / 0` is
 * `NaN`. Nothing in the raster complains about any of them, so getting one wrong
 * is silent — it draws a real cell in the wrong colour and the map still looks
 * like a map.
 *
 * That is what happened: `colorize` tested the pooled value with
 * `Number.isFinite` and sent *everything* that failed to the bottom of the ramp.
 * The low end is right for `-Infinity` and is the opposite of right for
 * `+Infinity`, which on a diverging ramp means the cells where the first file
 * has contacts and the second has none were painted in the colour reserved for
 * the second file. On a bacterial pair at 5 kb the two arms are the same size —
 * a little under 8% of cells each — so half the saturated cells of the picture
 * carried the wrong sign, and the ones that were wrong were the findings.
 *
 * The readout is the other half of the same failure. A balanced cell is a
 * fraction of order `1e-4`, and `fmt.num` rounded to three decimal places: the
 * pair under the pointer printed as `0.001 · 0`, which is not a pair that can
 * produce the ratio beside it. A reader checking the colour against the counts
 * was shown two numbers that made the colour look like a bug.
 */

import { describe, expect, it } from 'vitest'

import { colorize, poolDisplay } from '@/render/heatmap'
import { applyColormap } from '@/render/colormaps'
import { combine } from '@/render/compare'
import { fmt } from '@/ui/dom'
import type { ColorScale, DenseMatrix } from '@/types'

/** A ratio map's scale: `log2`, diverging, symmetric about `1`. */
const RATIO: ColorScale = {
  vmin: -1,
  vmax: 1,
  transform: 'log2',
  colormap: 'RdBu_r',
  balanced: true,
  neutral: 1,
}

function matrix(values: number[]): DenseMatrix {
  const n = values.length
  return {
    nrows: 1,
    ncols: n,
    values: Float32Array.from(values),
    rowExtent: [0, 1],
    colExtent: [0, n],
  }
}

/** The RGBA of one raster pixel. */
function pixel(data: Uint8ClampedArray, i: number): [number, number, number, number] {
  return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]
}

/**
 * Which side of a diverging ramp a pixel is on: red minus blue.
 *
 * Not the red channel on its own, which cannot tell the two apart at all. Both
 * ends of `RdBu_r` are *dark* — `(103, 0, 31)` and `(5, 48, 97)` — and the
 * middle is white, so red rises from the low end to neutral and then falls
 * again. The difference of the two channels is monotone across the whole ramp,
 * which is the property an assertion about "warmer than" needs.
 */
function warmth(data: Uint8ClampedArray, i: number): number {
  return data[i * 4] - data[i * 4 + 2]
}

describe('a ratio at the ends of its scale', () => {
  // `x / 0`, `0 / x`, `1 / 1`, `0 / 0` — the four answers, in that order.
  const field = matrix([Number.POSITIVE_INFINITY, 0, 1, Number.NaN])

  it('paints an absent denominator at the top of the ramp and an absent numerator at the bottom', () => {
    const { data } = colorize(poolDisplay(field, RATIO), RATIO)
    const lut = applyColormap(RATIO.colormap)
    const top = lut.length / 4 - 1

    expect(pixel(data, 0)).toEqual([lut[top * 4], lut[top * 4 + 1], lut[top * 4 + 2], lut[top * 4 + 3]])
    expect(pixel(data, 1)).toEqual([lut[0], lut[1], lut[2], lut[3]])
    // The regression itself: the two ends were the same colour.
    expect(pixel(data, 0)).not.toEqual(pixel(data, 1))
  })

  it('puts the two ends on opposite sides of neutral', () => {
    const { data } = colorize(poolDisplay(field, RATIO), RATIO)

    // An ordering rather than three literal colours, so a change of ramp does
    // not rewrite the test: an absent denominator is warmer than agreement, and
    // an absent numerator is cooler than it.
    expect(warmth(data, 0)).toBeGreaterThan(warmth(data, 2))
    expect(warmth(data, 1)).toBeLessThan(warmth(data, 2))
    // `1 / 1` is agreement, and agreement has no colour to speak of. Not exactly
    // zero: `colormapIndex` floors, so the middle of the scale lands one of 256
    // samples below the ramp's own centre.
    expect(Math.abs(warmth(data, 2))).toBeLessThan(4)
  })

  it('leaves a ratio that could not be formed transparent', () => {
    const { data } = colorize(poolDisplay(field, RATIO), RATIO)
    expect(pixel(data, 3)).toEqual([0, 0, 0, 0])
  })

  it('still collapses a degenerate range to the low end, as Normalize does', () => {
    const flat: ColorScale = { ...RATIO, vmin: 2, vmax: 2 }
    const { data } = colorize(poolDisplay(matrix([1, 4, 16]), flat), flat)
    const lut = applyColormap(flat.colormap)
    for (let i = 0; i < 3; i++) expect(pixel(data, i)).toEqual([lut[0], lut[1], lut[2], lut[3]])
  })

  it('carries the sign through from the arithmetic that produced it', () => {
    // What `derive` hands the raster: two blocks, one cell each way.
    const nap5 = matrix([0.000591, 0.000401])
    const wt = matrix([0, 0.000556])
    const { values } = combine(nap5, wt, { op: 'ratio' })

    expect(values[0]).toBe(Number.POSITIVE_INFINITY)
    expect(values[1]).toBeCloseTo(0.721, 3)

    const { data } = colorize(poolDisplay({ ...nap5, values }, RATIO), RATIO)
    // Present in the first file and absent in the second is the strongest
    // possible statement in the numerator's favour, and it is drawn as one.
    // Before the fix both of these cells came out on the blue side, and the
    // pair was indistinguishable on screen.
    expect(warmth(data, 0)).toBeGreaterThan(0)
    expect(warmth(data, 1)).toBeLessThan(0)
  })
})

describe('fmt.num on the values a balanced map actually holds', () => {
  it('keeps three significant digits below three decimal places', () => {
    expect(fmt.num(0.000591)).toBe('0.000591')
    expect(fmt.num(0.000401)).toBe('0.000401')
    // The regression: both of these printed as `0.001` and `0`, a pair that
    // cannot produce the 0.72 ratio the map was drawing from them.
    expect(fmt.num(0.000591)).not.toBe(fmt.num(0.000401))
  })

  it('leaves everything at or above a thousandth on three decimal places', () => {
    expect(fmt.num(0.001)).toBe('0.001')
    expect(fmt.num(1.23456)).toBe('1.235')
    expect(fmt.num(37)).toBe('37')
    expect(fmt.num(4573673)).toBe('4,573,673')
  })

  it('goes to an exponent rather than to a run of zeros', () => {
    expect(fmt.num(5.91e-8)).toBe('5.91e-8')
    expect(fmt.num(-5.91e-8)).toBe('-5.91e-8')
  })

  it('keeps the sign and the em dash', () => {
    expect(fmt.num(-0.000591)).toBe('-0.000591')
    expect(fmt.num(Number.NaN)).toBe('—')
    expect(fmt.num(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
