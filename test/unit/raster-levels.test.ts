/**
 * A large block drawn level by level (`render/levels.ts`), held to the
 * whole-image pipeline it stands in for.
 *
 * Two claims, both of the kind a screenshot cannot check: that the colour range
 * read from the raw values is the number the pooled raster gave, to the bit —
 * §7.1 ties it to numpy and the goldens compare it — and that a level is the
 * colours `colorize` would have drawn, averaged the way the halvings averaged
 * them. Each is asserted against the pipeline itself, on blocks salted with
 * every value that has a rule of its own: zeros of both signs, NaN, both
 * infinities, negatives, subnormals, values either side of one, and integers.
 */

import { describe, expect, it } from 'vitest'

import { COLORMAP_NAMES } from '@/render/colormaps'
import { autoRangeOfPooled, colorize, poolDisplay } from '@/render/heatmap'
import { LevelPainter, autoRangeOfValues, levelFor, levelSize } from '@/render/levels'
import type { ColorScale, DenseMatrix, Transform } from '@/types'

/** Deterministic, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** A block with a share of every awkward value, and counts, and fractions. */
function field(nrows: number, ncols: number, seed: number, kind: 'mixed' | 'counts' | 'fractions' = 'mixed'): DenseMatrix {
  const random = rng(seed)
  const values = new Float32Array(nrows * ncols)
  for (let i = 0; i < values.length; i++) {
    const u = random()
    if (kind === 'counts') values[i] = u < 0.6 ? 0 : Math.floor(random() ** 4 * 300) + 1
    else if (kind === 'fractions') values[i] = u < 0.05 ? Number.NaN : u < 0.5 ? 0 : random() ** 3 * 0.2
    else
      values[i] =
        u < 0.03 ? Number.NaN
        : u < 0.3 ? 0
        : u < 0.31 ? -0
        : u < 0.32 ? Number.POSITIVE_INFINITY
        : u < 0.33 ? Number.NEGATIVE_INFINITY
        : u < 0.35 ? -random() * 3
        : u < 0.36 ? 1e-42 * random()
        : u < 0.4 ? 1
        : u < 0.45 ? 1 + random() * 1e-6
        : u < 0.6 ? random()
        : u < 0.8 ? Math.floor(random() * 50)
        : random() ** 3 * 5000
  }
  return { nrows, ncols, values, rowExtent: [0, nrows], colExtent: [0, ncols] }
}

const TRANSFORMS: Transform[] = ['log1p', 'log10', 'log2', 'none']

/** Exactly what the whole-image pipeline measures, over the block drawn a cell to a pixel. */
function classicRange(block: DenseMatrix, transform: Transform, balanced: boolean): { vmin: number; vmax: number } {
  const scale: ColorScale = { vmin: Number.NaN, vmax: Number.NaN, transform, colormap: 'default', balanced }
  return autoRangeOfPooled(poolDisplay(block, scale))
}

describe('the colour range, read from the raw values', () => {
  it('is the pooled raster’s, to the bit, under every transform and balancing', () => {
    for (const [seed, kind] of [
      [1, 'mixed'],
      [2, 'mixed'],
      [3, 'counts'],
      [4, 'fractions'],
    ] as const) {
      const block = field(61, 47, seed, kind)
      for (const transform of TRANSFORMS) {
        for (const balanced of [false, true]) {
          const expected = classicRange(block, transform, balanced)
          const got = autoRangeOfValues(block.values, transform, balanced)
          expect(Object.is(got.vmin, expected.vmin) && Object.is(got.vmax, expected.vmax), `${kind} ${transform} ${balanced}`).toBe(true)
        }
      }
    }
  })

  it('agrees at every length that moves the interpolation, and on blocks with nothing to keep', () => {
    const random = rng(9)
    const blocks: DenseMatrix[] = []
    for (const n of [1, 2, 3, 5, 17, 100, 101, 999]) {
      const values = Float32Array.from({ length: n }, () => (random() < 0.3 ? 0 : random() * 1000))
      blocks.push({ nrows: 1, ncols: n, values, rowExtent: [0, 1], colExtent: [0, n] })
    }
    for (const fill of [0, Number.NaN, -1, 1, 0.5, 7]) {
      const values = new Float32Array(64).fill(fill)
      blocks.push({ nrows: 8, ncols: 8, values, rowExtent: [0, 8], colExtent: [0, 8] })
    }
    for (const block of blocks) {
      for (const transform of TRANSFORMS) {
        for (const balanced of [false, true]) {
          const expected = classicRange(block, transform, balanced)
          const got = autoRangeOfValues(block.values, transform, balanced)
          expect(Object.is(got.vmin, expected.vmin) && Object.is(got.vmax, expected.vmax)).toBe(true)
        }
      }
    }
  })

  it('finds both order statistics when the percentile falls inside one crowded bin', () => {
    // Every value in one top-sixteen-bit bin, so both ranks are selected from
    // the same gathered set.
    const random = rng(11)
    const values = Float32Array.from({ length: 5000 }, () => 3 + random() * 0.01)
    const block: DenseMatrix = { nrows: 50, ncols: 100, values, rowExtent: [0, 50], colExtent: [0, 100] }
    for (const transform of TRANSFORMS) {
      const expected = classicRange(block, transform, false)
      expect(autoRangeOfValues(values, transform, false)).toEqual(expected)
    }
  })
})

/** The whole-image pipeline's colours for the block, a cell to a pixel. */
function classicColours(block: DenseMatrix, scale: ColorScale): { data: Uint8ClampedArray; scale: ColorScale } {
  const raster = colorize(poolDisplay(block, scale), scale)
  return { data: raster.data, scale: raster.scale }
}

/** Level `level` of `colours`, as the halvings would make it: a straightforward box average. */
function boxAverage(colours: Uint8ClampedArray, nrows: number, ncols: number, level: number): Uint8ClampedArray {
  const factor = 2 ** level
  const { width, height } = levelSize(level, ncols, nrows)
  const out = new Uint8ClampedArray(width * height * 4)
  for (let ry = 0; ry < height; ry++) {
    for (let rx = 0; rx < width; rx++) {
      let r = 0
      let g = 0
      let b = 0
      let opaque = 0
      let covered = 0
      for (let y = ry * factor; y < Math.min(ry * factor + factor, nrows); y++) {
        for (let x = rx * factor; x < Math.min(rx * factor + factor, ncols); x++) {
          const i = (y * ncols + x) * 4
          covered++
          if (colours[i + 3] === 0) continue
          r += colours[i]
          g += colours[i + 1]
          b += colours[i + 2]
          opaque++
        }
      }
      const o = (ry * width + rx) * 4
      if (opaque === 0) continue
      out[o] = Math.round(r / opaque)
      out[o + 1] = Math.round(g / opaque)
      out[o + 2] = Math.round(b / opaque)
      out[o + 3] = Math.round((255 * opaque) / covered)
    }
  }
  return out
}

function paint(painter: LevelPainter, level: number, from = 0, to?: number): Uint8ClampedArray {
  const { width, height } = painter.size(level)
  const end = to ?? height
  const out = new Uint8ClampedArray(width * (end - from) * 4)
  painter.paintRows(level, from, end, out)
  return out
}

describe('a level painted from the values', () => {
  const scales: Array<Omit<ColorScale, 'colormap'>> = []
  for (const transform of TRANSFORMS) {
    for (const balanced of [false, true]) {
      for (const [vmin, vmax] of [
        [Number.NaN, Number.NaN],
        [0, 3],
        [1, 1],
        [-2, 8],
        [0.25, 0.75],
      ]) {
        scales.push({ vmin, vmax, transform, balanced })
      }
    }
  }

  it('is colorize’s colouring, byte for byte, a cell to a pixel', () => {
    const block = field(37, 53, 21)
    for (const colormap of COLORMAP_NAMES) {
      for (const base of scales) {
        for (const missing of ['paper', 'middle'] as const) {
          const scale: ColorScale = { ...base, colormap, missing }
          const classic = classicColours(block, scale)
          const painter = new LevelPainter(block.values, block.nrows, block.ncols, classic.scale)
          const got = paint(painter, 0)
          expect(Buffer.from(got).equals(Buffer.from(classic.data)), `${colormap} ${JSON.stringify(scale)}`).toBe(true)
        }
      }
    }
  })

  it('is the average of those colours over every level, edges and transparency included', () => {
    // Sizes that are not powers of two, so every level has a partial last row and column.
    for (const [nrows, ncols, seed] of [
      [37, 53, 31],
      [64, 64, 32],
      [5, 300, 33],
    ] as const) {
      const block = field(nrows, ncols, seed)
      for (const missing of ['paper', 'middle'] as const) {
        const scale: ColorScale = { vmin: Number.NaN, vmax: Number.NaN, transform: 'log1p', colormap: 'default', missing }
        const classic = classicColours(block, scale)
        const painter = new LevelPainter(block.values, nrows, ncols, classic.scale)
        for (let level = 1; level <= 5; level++) {
          const got = paint(painter, level)
          const expected = boxAverage(classic.data, nrows, ncols, level)
          expect(Buffer.from(got).equals(Buffer.from(expected)), `${nrows}x${ncols} level ${level} ${missing}`).toBe(true)
        }
      }
    }
  })

  it('paints the same rows in slices as in one call', () => {
    const block = field(70, 90, 41, 'counts')
    const scale: ColorScale = { vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'default' }
    const classic = classicColours(block, scale)
    const painter = new LevelPainter(block.values, block.nrows, block.ncols, classic.scale)
    for (const level of [0, 1, 3]) {
      const whole = paint(painter, level)
      const { width, height } = painter.size(level)
      const pieces = new Uint8ClampedArray(whole.length)
      for (let from = 0; from < height; from += 3) {
        const to = Math.min(height, from + 3)
        pieces.set(paint(painter, level, from, to), from * width * 4)
      }
      expect(Buffer.from(pieces).equals(Buffer.from(whole))).toBe(true)
    }
  })
})

describe('which level a draw wants', () => {
  it('is the raster itself while magnified, and a level within a halving of the screen below that', () => {
    expect(levelFor(1, 4000, 4000)).toBe(0)
    expect(levelFor(2, 4000, 4000)).toBe(0)
    expect(levelFor(0.67, 4000, 4000)).toBe(0)
    // A tenfold reduction: three halvings, then a residual between a half and one.
    expect(levelFor(0.1, 4000, 4000)).toBe(3)
    // No deeper than four, and never below eight pixels a side.
    expect(levelFor(0.001, 100000, 100000)).toBe(4)
    expect(levelFor(0.001, 20, 20)).toBe(2)
  })
})
