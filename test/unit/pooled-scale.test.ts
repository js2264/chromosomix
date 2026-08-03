/**
 * The colour scale is resolved from the pixels that are actually drawn.
 *
 * `rasterize` pools a block above `RASTER_MAX_DIM` per axis, taking the maximum
 * of each pooled group. The auto range used to be computed from every *cell* of
 * the matrix instead, so on a pooled block the scale described a population no
 * pixel on screen belonged to. It is now taken from the pooled values.
 *
 * Two properties matter and both are pinned here:
 *
 * 1. **Nothing pooled, nothing changed.** At stride 1 the pooled values are the
 *    display values of every cell, so the resolved bounds are bit-identical to
 *    the old rule — which is what keeps §7.1 parity with `metacooler show`, and
 *    what `render.test.ts`'s byte-for-byte matplotlib comparison rests on.
 * 2. **Pooled, and the scale follows.** Above the cap the bounds are the
 *    percentile of the drawn pixels, not of the cells behind them.
 */

import { describe, expect, it } from 'vitest'

import { colorize, poolDisplay, rasterStride } from '@/render/heatmap'
import { autoRangeOf, autoRangeOfDisplay } from '@/render/scale'
import type { ColorScale, DenseMatrix, Transform } from '@/types'

function block(n: number, seed = 7): DenseMatrix {
  const values = new Float32Array(n * n)
  let state = seed
  const next = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const d = j - i
      if (next() < 0.4 / (1 + d * 0.1)) {
        const c = Math.max(1, Math.round(40 / (1 + d)))
        values[i * n + j] = c
        values[j * n + i] = c
      }
    }
  }
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

const auto = (transform: Transform, balanced = false): ColorScale => ({
  vmin: Number.NaN,
  vmax: Number.NaN,
  transform,
  colormap: 'afmhot_r',
  balanced,
})

describe('the auto range on an unpooled block', () => {
  for (const transform of ['log1p', 'log10', 'none'] as Transform[]) {
    it(`matches the raw-value rule exactly under ${transform}`, () => {
      const m = block(64)
      const scale = auto(transform)
      expect(rasterStride(m.nrows)).toBe(1)
      const pooled = poolDisplay(m, scale)
      const resolved = colorize(pooled, scale).scale
      const expected = autoRangeOf(m.values, transform, false)
      expect(resolved.vmin).toBe(expected.vmin)
      expect(resolved.vmax).toBe(expected.vmax)
    })
  }

  it('matches for a balanced block too, where the fallback rule applies', () => {
    const m = block(48)
    // Fractions, as balancing produces, with a dropped bin for good measure.
    for (let i = 0; i < m.values.length; i++) m.values[i] = m.values[i] * 0.004
    m.values[5] = Number.NaN
    const scale = auto('log10', true)
    const resolved = colorize(poolDisplay(m, scale), scale).scale
    const expected = autoRangeOf(m.values, 'log10', true)
    expect(resolved.vmin).toBe(expected.vmin)
    expect(resolved.vmax).toBe(expected.vmax)
  })
})

describe('the auto range on a pooled block', () => {
  it('is the percentile of the pooled pixels', () => {
    const m = block(200)
    const scale = auto('log1p')
    // Force pooling at a size a test can hold: 200 bins into a 50 px raster.
    const pooled = poolDisplay(m, scale, { maxDim: 50 })
    expect(pooled.strideX).toBe(4)
    expect(pooled.values.length).toBe(50 * 50)
    expect(colorize(pooled, scale).scale.vmax).toBe(
      autoRangeOfDisplay(pooled.values, 'log1p', false).vmax,
    )
  })

  it('differs from the percentile of the cells behind it', () => {
    // 1..16 in a 4x4, pooled 2x2 -> the maxima 6, 8, 14, 16 are what is drawn.
    // np.percentile(1..16, 99)      = 15.85
    // np.percentile([6,8,14,16], 99) = 15.94
    // Two populations, two answers, and only the second one is on screen.
    const values = Float32Array.from({ length: 16 }, (_, i) => i + 1)
    const m: DenseMatrix = { nrows: 4, ncols: 4, values, rowExtent: [0, 4], colExtent: [0, 4] }
    const scale = auto('none')
    const pooled = poolDisplay(m, scale, { maxDim: 2 })
    expect(Array.from(pooled.values)).toEqual([6, 8, 14, 16])
    expect(colorize(pooled, scale).scale.vmax).toBeCloseTo(15.94, 6)
    expect(autoRangeOf(values, 'none', false).vmax).toBeCloseTo(15.85, 6)
  })

  it('keeps `vmin` at zero for raw counts, as `show` does', () => {
    const m = block(200)
    const scale = auto('log1p')
    expect(colorize(poolDisplay(m, scale, { maxDim: 50 }), scale).scale.vmin).toBe(0)
  })
})

describe('pooling', () => {
  it('resolves the auto range once and memoises it on the pooled block', () => {
    const m = block(64)
    const scale = auto('log1p')
    const pooled = poolDisplay(m, scale)
    // Not computed until something asks to be coloured.
    expect(pooled.autoRange).toBeUndefined()

    const first = colorize(pooled, scale).scale
    expect(pooled.autoRange).toEqual({ vmin: first.vmin, vmax: first.vmax })

    // A colormap change cannot move it, and must not recompute it: the same
    // object comes back, which is what makes the recolour cheap.
    const cached = pooled.autoRange
    const second = colorize(pooled, { ...scale, colormap: 'viridis' }).scale
    expect(pooled.autoRange).toBe(cached)
    expect(second.vmin).toBe(first.vmin)
    expect(second.vmax).toBe(first.vmax)
  })

  it('leaves an all-unbalanced block transparent, with the fallback bounds', () => {
    const values = new Float32Array(16).fill(Number.NaN)
    const m: DenseMatrix = { nrows: 4, ncols: 4, values, rowExtent: [0, 4], colExtent: [0, 4] }
    const scale = auto('log1p')
    const pooled = poolDisplay(m, scale)
    expect(Array.from(pooled.values).every(Number.isNaN)).toBe(true)
    const raster = colorize(pooled, scale)
    expect(raster.scale.vmin).toBe(0)
    expect(raster.scale.vmax).toBe(1)
    for (let i = 3; i < raster.data.length; i += 4) expect(raster.data[i]).toBe(0)
  })

  it('takes the maximum of a pooled group, so a lone contact survives', () => {
    const values = new Float32Array(16)
    values[5] = 99
    const m: DenseMatrix = { nrows: 4, ncols: 4, values, rowExtent: [0, 4], colExtent: [0, 4] }
    const pooled = poolDisplay(m, auto('none'), { maxDim: 2 })
    expect(pooled.strideX).toBe(2)
    // Cell (1,1) sits in the top-left 2x2 group; the maximum reaches the pixel.
    expect(pooled.values[0]).toBe(99)
  })
})
