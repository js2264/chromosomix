/**
 * The paint of a block the reader came back to (§7.2, §12).
 *
 * The reader's cache hands a returning block back as the very object drawn
 * before (`worker/answers.ts`), and two things follow from that here. Its
 * pooled display — the transform, the pooling and the colour range measured
 * over it — is kept beside it and found again by the next view to draw it
 * (`pooledOf`), so the only pass left is the colouring; and the colouring writes
 * a pixel as one word rather than four bytes, which must not move a byte of
 * what it writes. That last is checked against the four-byte loop it replaced,
 * kept below as the reference.
 */

import { describe, expect, it } from 'vitest'

import { COLORMAP_NAMES, applyColormap, colormapIndex } from '@/render/colormaps'
import { colorize, poolDisplay, pooledOf, type PooledDisplay } from '@/render/heatmap'
import type { ColorScale, DenseMatrix, Transform } from '@/types'

function field(n: number, seed: number): DenseMatrix {
  let state = seed >>> 0
  const random = (): number => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const values = new Float32Array(n * n)
  for (let i = 0; i < values.length; i++) {
    const u = random()
    values[i] =
      u < 0.05 ? Number.NaN
      : u < 0.08 ? 0
      : u < 0.09 ? Number.POSITIVE_INFINITY
      : u < 0.1 ? Number.NEGATIVE_INFINITY
      : u < 0.2 ? random() * 1e-3
      : random() ** 3 * 5000
  }
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

/** The colouring as it was written before, a byte at a time. */
function reference(pooled: PooledDisplay, vmin: number, vmax: number, colormap: string): Uint8ClampedArray {
  const span = vmax - vmin
  const lut = applyColormap(colormap)
  const data = new Uint8ClampedArray(pooled.width * pooled.height * 4)
  for (let i = 0; i < pooled.values.length; i++) {
    const best = pooled.values[i]
    const o = i * 4
    if (Number.isNaN(best)) continue
    const t = span > 0 ? (best - vmin) / span : 0
    const k = colormapIndex(Number.isFinite(t) ? t : t > 0 ? 1 : 0)
    if (k < 0) continue
    for (let c = 0; c < 4; c++) data[o + c] = lut[k * 4 + c]
  }
  return data
}

const SCALE: ColorScale = { vmin: Number.NaN, vmax: Number.NaN, transform: 'log1p', colormap: 'default', balanced: false }

describe('a returning block’s pooled display', () => {
  it('is the one made for it before, range and all', () => {
    const block = field(64, 1)
    const first = pooledOf(block, SCALE, false)
    colorize(first, SCALE)
    expect(first.autoRange).toBeDefined()
    // Another view of the same block — a navigation away and back.
    const again = pooledOf({ ...block }, SCALE, false)
    expect(again).toBe(first)
  })

  it('is made again for another transform, balancing, neutral or turn', () => {
    const block = field(64, 2)
    const first = pooledOf(block, SCALE, false)
    const others: Array<[ColorScale, boolean]> = [
      [{ ...SCALE, transform: 'log10' }, false],
      [{ ...SCALE, balanced: true }, false],
      [{ ...SCALE, neutral: 1 }, false],
      [SCALE, true],
    ]
    for (const [scale, isotropic] of others) {
      expect(pooledOf(block, scale, isotropic)).not.toBe(first)
      expect(pooledOf(block, scale, isotropic).values).toEqual(poolDisplay(block, scale, { isotropic }).values)
    }
  })

  it('is not found for another block, nor for the same values cut to another shape', () => {
    const block = field(64, 3)
    const first = pooledOf(block, SCALE, false)
    expect(pooledOf({ ...block, values: block.values.slice() }, SCALE, false)).not.toBe(first)
    expect(pooledOf({ ...block, nrows: 32, rowExtent: [0, 32] }, SCALE, false)).not.toBe(first)
  })
})

describe('the colouring', () => {
  const transforms: Transform[] = ['log1p', 'log10', 'log2', 'none']

  it('writes exactly the bytes the four-byte loop wrote, at every scale', () => {
    const block = field(97, 7)
    for (const colormap of COLORMAP_NAMES) {
      for (const transform of transforms) {
        for (const balanced of [false, true]) {
          for (const [vmin, vmax] of [[Number.NaN, Number.NaN], [0, 3], [1, 1], [-2, 8]]) {
            const scale: ColorScale = { vmin, vmax, transform, colormap, balanced }
            for (const maxDim of [4096, 40]) {
              const pooled = poolDisplay(block, scale, { maxDim })
              const raster = colorize(pooled, scale)
              const expected = reference(pooled, raster.scale.vmin, raster.scale.vmax, colormap)
              expect(Buffer.from(raster.data).equals(Buffer.from(expected))).toBe(true)
            }
          }
        }
      }
    }
  })

  it('puts every edge of the table where the four-byte loop put it', () => {
    // On a scale of 0–256 a value is its own position in the table, so these
    // are the ends, the boundaries between colours, and everything off either end.
    const edges = [
      Number.NEGATIVE_INFINITY, -1e300, -1, -0.5, -0, 0, 0.5, 1, 127.999, 128, 255, 255.5, 255.999,
      256, 256.5, 257, 1e300, Number.POSITIVE_INFINITY, Number.NaN,
    ]
    const values = Float32Array.from(edges)
    const block: DenseMatrix = { nrows: 1, ncols: values.length, values, rowExtent: [0, 1], colExtent: [0, values.length] }
    for (const colormap of COLORMAP_NAMES) {
      const scale: ColorScale = { vmin: 0, vmax: 256, transform: 'none', colormap, balanced: false }
      const pooled = poolDisplay(block, scale)
      const raster = colorize(pooled, scale)
      expect(Buffer.from(raster.data).equals(Buffer.from(reference(pooled, 0, 256, colormap)))).toBe(true)
    }
  })

  it('overwrites every pixel of a buffer it is handed again', () => {
    const block = field(50, 9)
    const pooled = poolDisplay(block, SCALE)
    const reused = new Uint8ClampedArray(pooled.width * pooled.height * 4).fill(77)
    const raster = colorize(pooled, SCALE, reused)
    expect(raster.data).toBe(reused)
    expect(Buffer.from(raster.data).equals(Buffer.from(colorize(pooled, SCALE).data))).toBe(true)
  })
})
