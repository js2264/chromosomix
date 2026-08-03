/**
 * The two "this is only cheaper, not different" claims, checked against the
 * implementations they replaced.
 *
 * Both optimisations are invisible in a screenshot when they are right and
 * invisible in a screenshot when they are subtly wrong, which is exactly the
 * shape of change that needs a test rather than an eye. Neither can be covered
 * by `render.test.ts`'s matplotlib goldens, because those exercise one small
 * unpooled block and these only differ above that.
 */

import { describe, expect, it } from 'vitest'

import { poolDisplay, RASTER_MAX_DIM } from '@/render/heatmap'
import { displayValue, percentileLinear, percentileOf, selectNth } from '@/render/scale'
import type { ColorScale, DenseMatrix, Transform } from '@/types'

/** Deterministic, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

describe('percentileOf reproduces percentileLinear exactly', () => {
  const QS = [0, 1, 25, 50, 99, 100]

  it('agrees bit for bit on random data, at every length that changes the lerp', () => {
    const random = rng(7)
    for (const n of [1, 2, 3, 5, 17, 100, 101, 999, 4096]) {
      const values = Float32Array.from({ length: n }, () => random() * 1000)
      const sorted = Float32Array.from(values).sort()
      for (const q of QS) {
        // `percentileOf` permutes its input, so it gets a fresh copy each time.
        expect(percentileOf(Float32Array.from(values), q)).toBe(percentileLinear(sorted, q))
      }
    }
  })

  it('agrees on heavily repeated values, which is what a sparse map produces', () => {
    const random = rng(11)
    const values = Float32Array.from({ length: 5000 }, () => Math.floor(random() * 4))
    const sorted = Float32Array.from(values).sort()
    for (const q of QS) {
      expect(percentileOf(Float32Array.from(values), q)).toBe(percentileLinear(sorted, q))
    }
  })

  it('agrees on a constant array, and on the degenerate lengths', () => {
    expect(percentileOf(new Float32Array(0), 99)).toBeNaN()
    expect(percentileOf(Float32Array.from([42]), 99)).toBe(42)
    const flat = new Float32Array(1000).fill(3)
    expect(percentileOf(flat, 99)).toBe(percentileLinear(new Float32Array(1000).fill(3), 99))
  })

  it('leaves the k-th element in place with everything larger after it', () => {
    const random = rng(13)
    const values = Float32Array.from({ length: 500 }, () => random() * 100)
    const sorted = Float32Array.from(values).sort()
    const k = 123
    const nth = selectNth(values, k)
    expect(nth).toBe(sorted[k])
    for (let i = 0; i < k; i++) expect(values[i]).toBeLessThanOrEqual(nth)
    for (let i = k + 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(nth)
  })
})

describe('pooling the raw maximum equals pooling the display maximum', () => {
  /** The pass this replaced: transform every cell, then take the maximum. */
  function perCell(m: DenseMatrix, transform: Transform, balanced: boolean, maxDim: number): Float32Array {
    const stride = (n: number): number => (n <= maxDim ? 1 : Math.ceil(n / maxDim))
    const strideY = stride(m.nrows)
    const strideX = stride(m.ncols)
    const width = Math.ceil(m.ncols / strideX)
    const height = Math.ceil(m.nrows / strideY)
    const out = new Float32Array(width * height)
    for (let ry = 0; ry < height; ry++) {
      for (let rx = 0; rx < width; rx++) {
        let best = Number.NaN
        for (let y = ry * strideY; y < Math.min((ry + 1) * strideY, m.nrows); y++) {
          for (let x = rx * strideX; x < Math.min((rx + 1) * strideX, m.ncols); x++) {
            const raw = m.values[y * m.ncols + x]
            if (Number.isNaN(raw)) continue
            const t = displayValue(raw, transform, balanced)
            if (Number.isNaN(best) || t > best) best = t
          }
        }
        out[ry * width + rx] = best
      }
    }
    return out
  }

  function matrix(n: number, fill: (i: number) => number): DenseMatrix {
    return {
      nrows: n,
      ncols: n,
      values: Float32Array.from({ length: n * n }, (_, i) => fill(i)),
      rowExtent: [0, n],
      colExtent: [0, n],
    }
  }

  const CASES: Array<{ name: string; fill: (i: number) => number }> = [
    { name: 'sparse integer counts', fill: (i) => (i % 7 === 0 ? (i % 500) + 1 : 0) },
    { name: 'with unbalanced holes', fill: (i) => (i % 11 === 0 ? Number.NaN : i % 40) },
    { name: 'every cell unbalanced', fill: () => Number.NaN },
    { name: 'constant', fill: () => 5 },
    { name: 'sub-unit float counts', fill: (i) => (i % 5 === 0 ? 0 : (i % 97) / 96) },
    { name: 'balanced fractions', fill: (i) => (i % 3 === 0 ? 0 : (i % 89) / 900) },
  ]

  for (const { name, fill } of CASES) {
    for (const transform of ['log1p', 'log10', 'none'] as Transform[]) {
      for (const balanced of [false, true]) {
        it(`${name} · ${transform} · ${balanced ? 'balanced' : 'raw'}`, () => {
          const m = matrix(64, fill)
          const scale: ColorScale = {
            vmin: Number.NaN,
            vmax: Number.NaN,
            transform,
            colormap: 'afmhot_r',
            balanced,
          }
          // maxDim well under the block, so every pixel pools a 5 x 5 group.
          const pooled = poolDisplay(m, scale, { maxDim: 13 })
          const reference = perCell(m, transform, balanced, 13)
          expect(pooled.values.length).toBe(reference.length)
          for (let i = 0; i < reference.length; i++) {
            const a = pooled.values[i]
            const b = reference[i]
            if (Number.isNaN(b)) expect(Number.isNaN(a)).toBe(true)
            else expect(a).toBe(b)
          }
        })
      }
    }
  }

  it('takes the unpooled fast path below the cap, cell for cell', () => {
    const m = matrix(32, (i) => (i % 3 === 0 ? Number.NaN : i % 17))
    for (const transform of ['log1p', 'log10', 'none'] as Transform[]) {
      for (const balanced of [false, true]) {
        const scale: ColorScale = {
          vmin: Number.NaN,
          vmax: Number.NaN,
          transform,
          colormap: 'afmhot_r',
          balanced,
        }
        const pooled = poolDisplay(m, scale)
        expect(pooled.strideX).toBe(1)
        expect(pooled.strideY).toBe(1)
        expect(pooled.width).toBe(32)
        for (let i = 0; i < m.values.length; i++) {
          // `Math.fround` because the pooled buffer is Float32 and always was:
          // the comparison is against what the old loop stored, not against the
          // double `displayValue` returns.
          const expected = Math.fround(displayValue(m.values[i], transform, balanced))
          if (Number.isNaN(expected)) expect(Number.isNaN(pooled.values[i])).toBe(true)
          else expect(pooled.values[i]).toBe(expected)
        }
      }
    }
  })

  it('still pools nothing at exactly the cap, and pools at one cell past it', () => {
    const at = poolDisplay(
      { nrows: RASTER_MAX_DIM, ncols: 4, values: new Float32Array(RASTER_MAX_DIM * 4), rowExtent: [0, RASTER_MAX_DIM], colExtent: [0, 4] },
      { vmin: Number.NaN, vmax: Number.NaN, transform: 'log1p', colormap: 'afmhot_r' },
    )
    expect(at.strideY).toBe(1)
  })
})
