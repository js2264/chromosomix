/**
 * Rendering parity with `metacooler show` (spec §7.1).
 *
 * Every golden number here came out of the Python side, not out of a previous
 * run of this code:
 *
 * - LUT entries: `matplotlib.colormaps[name](np.arange(256), bytes=True)`
 * - `vmax`: `np.percentile(mat[mat > 0], 99)` on the same values
 * - the raster bytes: `ScalarMappable(Normalize(0, vmax), cmap).to_rgba(m, bytes=True)`,
 *   which is exactly what `imshow` hands to Agg
 *
 * The full check — 40×40 and 603×603 matrices, five colormaps, three
 * transforms, compared byte for byte — agreed on **0 differing bytes out of
 * 1.46 M**. This file keeps the cheap, hand-checkable core of it in CI.
 */

import { describe, expect, it } from 'vitest'

import {
  COLORMAP_NAMES,
  DEFAULT_COLORMAP,
  applyColormap,
  colormapIndex,
  isColormap,
} from '@/render/colormaps'
import { colorbarTicks, formatCount } from '@/render/colorbar'
import { rasterize, separatorBlocks } from '@/render/heatmap'
import {
  Scale,
  autoVmax,
  inverseTransform,
  percentileLinear,
  transformValue,
  transformValues,
} from '@/render/scale'
import type { DenseMatrix } from '@/types'

function block(values: number[], nrows: number, ncols: number): DenseMatrix {
  return {
    nrows,
    ncols,
    values: Float32Array.from(values),
    rowExtent: [0, nrows],
    colExtent: [0, ncols],
  }
}

describe('colormaps', () => {
  it('defaults to afmhot_r, the `metacooler show` default', () => {
    expect(DEFAULT_COLORMAP).toBe('afmhot_r')
    expect(COLORMAP_NAMES[0]).toBe('afmhot_r')
    expect(COLORMAP_NAMES).toContain('cividis')
    expect(isColormap('afmhot_r')).toBe(true)
    expect(isColormap('jet')).toBe(false)
  })

  it('reproduces matplotlib LUT entries exactly', () => {
    // matplotlib.colormaps['afmhot_r'](np.arange(256), bytes=True)
    const lut = applyColormap('afmhot_r')
    expect(lut.length).toBe(1024)
    expect([...lut.slice(0, 4)]).toEqual([255, 255, 255, 255])
    expect([...lut.slice(64 * 4, 64 * 4 + 3)]).toEqual([255, 254, 127])
    expect([...lut.slice(128 * 4, 128 * 4 + 3)]).toEqual([254, 126, 0])
    expect([...lut.slice(255 * 4, 255 * 4 + 4)]).toEqual([0, 0, 0, 255])

    const cividis = applyColormap('cividis')
    expect([...cividis.slice(0, 3)]).toEqual([0, 34, 77])
    expect([...cividis.slice(128 * 4, 128 * 4 + 3)]).toEqual([124, 123, 120])
    expect([...cividis.slice(255 * 4, 255 * 4 + 3)]).toEqual([253, 231, 55])

    const viridis = applyColormap('viridis')
    expect([...viridis.slice(0, 3)]).toEqual([68, 1, 84])
    expect([...viridis.slice(64 * 4, 64 * 4 + 3)]).toEqual([58, 82, 139])
  })

  it('indexes the LUT the way Colormap.__call__ does', () => {
    expect(colormapIndex(0)).toBe(0)
    expect(colormapIndex(0.5)).toBe(128) // floor(0.5 * 256), not round(0.5 * 255)
    expect(colormapIndex(1)).toBe(255) // xa[xa == N] = N - 1
    expect(colormapIndex(-0.3)).toBe(0) // under -> lut[0]
    expect(colormapIndex(4)).toBe(255) // over -> lut[N - 1]
    expect(colormapIndex(Number.NaN)).toBe(-1) // bad -> transparent
  })

  it('refuses an unknown name rather than silently substituting', () => {
    expect(() => applyColormap('jet')).toThrow(/Unknown colormap: 'jet'/)
  })
})

describe('transformValues', () => {
  it('mirrors _transform_matrix', () => {
    const v = Float32Array.from([0, 1, 2, 3])
    expect([...transformValues(v, 'none')]).toEqual([0, 1, 2, 3])
    // Six digits, not twelve: the result is stored in a Float32Array, so it
    // carries ~7 significant digits where Python's float64 carries ~16. That
    // rounding is the whole gap between the two implementations — measured at a
    // worst-case relative 4.2e-8 over a 64x64 sparse block.
    expect(transformValues(v, 'log1p')[1]).toBeCloseTo(Math.LN2, 6)
    expect(transformValues(v, 'log10')[2]).toBeCloseTo(Math.log10(2), 6)
  })

  it('clamps non-positive values to 0 under log10, not -Infinity', () => {
    // np.where(arr > 0, np.log10(arr), 0.0)
    const out = transformValues(Float32Array.from([0, -5, 1]), 'log10')
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
    expect(out[2]).toBe(0)
  })

  it('carries NaN through log1p but folds it to 0 under log10', () => {
    // NaN > 0 is false in numpy and in JS, so np.where picks the 0.0 branch.
    expect(transformValues(Float32Array.from([Number.NaN]), 'log1p')[0]).toBeNaN()
    expect(transformValues(Float32Array.from([Number.NaN]), 'none')[0]).toBeNaN()
    expect(transformValues(Float32Array.from([Number.NaN]), 'log10')[0]).toBe(0)
  })

  it('does not mutate its input', () => {
    const v = Float32Array.from([1, 2, 3])
    transformValues(v, 'log1p')
    expect([...v]).toEqual([1, 2, 3])
  })

  it('agrees with its scalar twin', () => {
    for (const t of ['log1p', 'log10', 'none'] as const) {
      const arr = transformValues(Float32Array.from([0, 0.5, 7, 1000]), t)
      ;[0, 0.5, 7, 1000].forEach((x, i) => {
        expect(arr[i]).toBeCloseTo(transformValue(x, t), 6)
      })
    }
  })

  it('round-trips through inverseTransform above the clamp', () => {
    for (const t of ['log1p', 'log10', 'none'] as const) {
      expect(inverseTransform(transformValue(42, t), t)).toBeCloseTo(42, 9)
    }
  })

  it('rejects an unknown transform with the Python wording', () => {
    // ValueError(f"Unknown transform: {transform!r}") in show()
    expect(() =>
      transformValues(Float32Array.from([1]), 'sqrt' as never)
    ).toThrow("Unknown transform: 'sqrt'")
  })
})

describe('autoVmax', () => {
  it('interpolates linearly between order statistics, as numpy does', () => {
    // np.percentile(np.arange(1, 102), 99) -> 100.0   (index 100 * 0.99 == 99)
    const a = Float32Array.from(Array.from({ length: 101 }, (_, i) => i + 1))
    expect(autoVmax(a)).toBeCloseTo(100, 12)

    // np.percentile(np.arange(1, 103), 99) -> 100.99  (index 101 * 0.99 == 99.99)
    // A nearest-rank shortcut would answer 101 here.
    const b = Float32Array.from(Array.from({ length: 102 }, (_, i) => i + 1))
    expect(autoVmax(b)).toBeCloseTo(100.99, 10)
  })

  it('drops zeros and NaNs, matching mat[mat > 0]', () => {
    const v = Float32Array.from([0, 0, Number.NaN, 5, 5, 5, 5])
    expect(autoVmax(v)).toBeCloseTo(5, 12)
  })

  it('falls back to 1.0 when nothing is positive', () => {
    expect(autoVmax(Float32Array.from([0, 0, 0]))).toBe(1)
    expect(autoVmax(new Float32Array(0))).toBe(1)
  })

  it('percentileLinear handles the degenerate lengths', () => {
    expect(percentileLinear([7], 99)).toBe(7)
    expect(percentileLinear([1, 2], 0)).toBe(1)
    expect(percentileLinear([1, 2], 100)).toBe(2)
    expect(percentileLinear([1, 2], 50)).toBeCloseTo(1.5, 12)
  })
})

describe('rasterize', () => {
  it('produces matplotlib bytes for a hand-checked block', () => {
    // vmax is forced, so the expected colours are lut[floor(t * 256)].
    const m = block([0, 1, 1, 3], 2, 2)
    const r = rasterize(m, { vmin: 0, vmax: 3, transform: 'none', colormap: 'afmhot_r' })
    const lut = applyColormap('afmhot_r')
    expect(r.width).toBe(2)
    expect(r.height).toBe(2)
    expect([...r.data.slice(0, 4)]).toEqual([...lut.slice(0, 4)])
    // 1/3 * 256 = 85.33 -> 85
    expect([...r.data.slice(4, 8)]).toEqual([...lut.slice(85 * 4, 85 * 4 + 4)])
    // 3/3 == 1 folds down to index 255
    expect([...r.data.slice(12, 16)]).toEqual([...lut.slice(255 * 4, 255 * 4 + 4)])
  })

  it('renders NaN as fully transparent, not as a colour (spec §6.4)', () => {
    const r = rasterize(block([Number.NaN, 1, 1, 1], 2, 2), {
      vmin: 0,
      vmax: 1,
      transform: 'log1p',
      colormap: 'afmhot_r',
    })
    expect([...r.data.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect(r.data[7]).toBe(255)
  })

  it('resolves a NaN vmax to the show() default', () => {
    const r = rasterize(block([0, 0, 0, 4], 2, 2), {
      vmin: 0,
      vmax: Number.NaN,
      transform: 'none',
      colormap: 'afmhot_r',
    })
    expect(r.scale.vmax).toBe(4)
    expect(r.scale.vmin).toBe(0)
  })

  it('collapses a degenerate range to the low end, as Normalize does', () => {
    const r = rasterize(block([2, 2, 2, 2], 2, 2), {
      vmin: 2,
      vmax: 2,
      transform: 'none',
      colormap: 'afmhot_r',
    })
    const lut = applyColormap('afmhot_r')
    expect([...r.data.slice(0, 4)]).toEqual([...lut.slice(0, 4)])
  })
})

describe('separatorBlocks', () => {
  it('treats `at` as the first cell of the block it labels', () => {
    expect(separatorBlocks([{ at: 0, label: 'a' }, { at: 3, label: 'b' }], 5)).toEqual([
      { start: 0, end: 3, label: 'a' },
      { start: 3, end: 5, label: 'b' },
    ])
  })

  it('drops out-of-range separators and sorts', () => {
    expect(
      separatorBlocks(
        [{ at: 9, label: 'x' }, { at: 2, label: 'b' }, { at: 0, label: 'a' }],
        5
      )
    ).toEqual([
      { start: 0, end: 2, label: 'a' },
      { start: 2, end: 5, label: 'b' },
    ])
  })
})

describe('Scale', () => {
  it('maps matrix coordinates to plot-area pixels and back', () => {
    const s = new Scale([0, 100], 400)
    expect(s.toPixel(0)).toBe(0)
    expect(s.toPixel(100)).toBe(400)
    expect(s.toUnit(200)).toBe(50)
    expect(s.pixelsPerUnit).toBe(4)
    expect(s.unitsPerPixel).toBe(0.25)
  })

  it('keeps the anchor fixed while zooming', () => {
    const s = new Scale([0, 100], 400)
    const before = s.toUnit(137)
    s.zoomAt(137, 3.7)
    expect(s.toUnit(137)).toBeCloseTo(before, 10)
    expect(s.span).toBeCloseTo(100 / 3.7, 10)
  })

  it('pans in screen units', () => {
    const s = new Scale([0, 100], 400)
    s.panByPixels(-40) // drag content left by 40 px == 10 cells
    expect(s.domain[0]).toBeCloseTo(10, 10)
    expect(s.domain[1]).toBeCloseTo(110, 10)
  })

  it('reports -1 for a pixel outside the block', () => {
    const s = new Scale([0, 10], 100)
    expect(s.cellAt(0)).toBe(0)
    expect(s.cellAt(99.9)).toBe(9)
    s.panByUnits(-20)
    expect(s.cellAt(0)).toBe(-1)
  })

  it('speaks base pairs through an injected mapper, never through /bins', () => {
    // A two-contig toy: contig 0 has bins 0-2 (1000 bp each), contig 1 bins 3-4
    // with a short last bin, exactly what coords.ts derives from chrom_offset.
    const binsize = 1000
    const offsets = [0, 3, 5]
    const lengths = [3000, 1500]
    const s = new Scale([0, 5], 500)
    s.attachGenomic({
      binsize,
      binToLocus(bin) {
        const contig = bin < 3 ? 0 : 1
        const start = (bin - offsets[contig]) * binsize
        return { contig, start, end: Math.min(start + binsize, lengths[contig]) }
      },
      locusToBin(contig, position) {
        return offsets[contig] + Math.floor(position / binsize)
      },
    })
    expect(s.unitToLocus(3.5)).toEqual({ contig: 1, position: 500 })
    expect(s.locusToUnit(1, 1250)).toBeCloseTo(4.5, 10) // short 500 bp last bin
    expect(s.locusToPixel(0, 0)).toBe(0)
    expect(s.pixelToLocus(-1)).toBeNull()
  })

  it('clones without sharing mutable state', () => {
    const s = new Scale([0, 10], 100)
    const c = s.clone()
    c.panByUnits(3)
    expect(s.domain).toEqual([0, 10])
    expect(c.domain).toEqual([3, 13])
    expect(s.equals(c)).toBe(false)
  })
})

describe('colorbar', () => {
  it('labels ticks in untransformed units', () => {
    const ticks = colorbarTicks({
      vmin: 0,
      vmax: Math.log1p(3000),
      transform: 'log1p',
      colormap: 'afmhot_r',
    })
    expect(ticks[0].value).toBeCloseTo(0, 9)
    expect(ticks[ticks.length - 1].value).toBeCloseTo(3000, 6)
    expect(ticks.map((t) => t.label)).toContain('100')
    // Positions are the transform made visible: not evenly spaced.
    expect(ticks[0].position).toBe(0)
    expect(ticks[ticks.length - 1].position).toBeCloseTo(1, 12)
  })

  it('marks the log10 floor as clamped', () => {
    const ticks = colorbarTicks({
      vmin: 0,
      vmax: 3,
      transform: 'log10',
      colormap: 'afmhot_r',
    })
    expect(ticks[0].label).toBe('≤ 1')
  })

  it('uses round steps for an untransformed scale', () => {
    const ticks = colorbarTicks({
      vmin: 0,
      vmax: 3000,
      transform: 'none',
      colormap: 'afmhot_r',
    })
    expect(ticks.map((t) => t.label)).toEqual(['0', '1000', '2000', '3000'])
  })

  it('formats counts without a locale', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(7)).toBe('7')
    expect(formatCount(9999)).toBe('9999')
    expect(formatCount(12_500)).toBe('12.5k')
    expect(formatCount(3_000_000)).toBe('3M')
    expect(formatCount(0.25)).toBe('0.25')
  })
})
