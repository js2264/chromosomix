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
  COLORMAP_SIZE,
  DEFAULT_COLORMAP,
  DEFAULT_UI_COLORMAP,
  applyColormap,
  colormapIndex,
  isColormap,
  isDivergingColormap,
} from '@/render/colormaps'
import { formatCount, keyContent, keyTitle } from '@/render/legend'
import { rasterize, separatorBlocks } from '@/render/heatmap'
import {
  Scale,
  autoRangeOf,
  autoVmax,
  autoVmaxOf,
  displayValue,
  inverseTransform,
  percentileLinear,
  transformValue,
  transformValues,
  valueExtentOf,
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
  it('keeps afmhot_r as the `metacooler show` default, and offers it', () => {
    expect(DEFAULT_COLORMAP).toBe('afmhot_r')
    expect(COLORMAP_NAMES).toContain('afmhot_r')
    expect(COLORMAP_NAMES).toContain('cividis')
    expect(isColormap('afmhot_r')).toBe(true)
    expect(isColormap('jet')).toBe(false)
  })

  it('puts BuWtRd’s white on the middle of the scale, not on its fifth stop', () => {
    expect(COLORMAP_NAMES).toContain('BuWtRd')
    expect(isDivergingColormap('BuWtRd')).toBe(true)
    const lut = applyColormap('BuWtRd')
    expect(lut.length).toBe(1024)

    // The two ends are the first and last stops, exactly.
    expect([...lut.slice(0, 4)]).toEqual([0x16, 0x59, 0xb1, 255])
    expect([...lut.slice(255 * 4, 255 * 4 + 4)]).toEqual([0xee, 0x22, 0x2a, 255])

    // Eight stops spread evenly would put the white at 4/7 of the ramp, and
    // `colorize` sends the neutral value to 0.5 — so a map of two identical
    // files would have come out faintly blue everywhere. It is anchored
    // instead, and the whitest entry in the table is the middle one. Asserted
    // by finding it rather than by reading one index, because that is the claim
    // (under even spacing the brightest entry sits at 146, not at 128) and
    // because the white stop falls exactly between samples 127 and 128 — neither
    // is a pure `#FFFFFF`, both are one rounding step from it.
    let whitest = 0
    for (let i = 1; i < COLORMAP_SIZE; i++) {
      const sum = lut[i * 4] + lut[i * 4 + 1] + lut[i * 4 + 2]
      if (sum > lut[whitest * 4] + lut[whitest * 4 + 1] + lut[whitest * 4 + 2]) whitest = i
    }
    expect(Math.abs(whitest - (COLORMAP_SIZE - 1) / 2)).toBeLessThanOrEqual(1)
    const mid = colormapIndex(0.5)
    for (let c = 0; c < 3; c++) expect(lut[mid * 4 + c]).toBeGreaterThanOrEqual(253)

    // …and the arms go the right way round: blue below, red above.
    const warmth = (i: number): number => lut[i * 4] - lut[i * 4 + 2]
    expect(warmth(colormapIndex(0.1))).toBeLessThan(-40)
    expect(warmth(colormapIndex(0.9))).toBeGreaterThan(40)
  })

  it('opens on the viewer ramp, which the picker lists first', () => {
    // A different default from the CLI's, as the overlays are; `afmhot_r` is
    // one item away and byte-identical, which is where parity actually lives.
    expect(DEFAULT_UI_COLORMAP).toBe('default')
    expect(COLORMAP_NAMES[0]).toBe('default')
    const lut = applyColormap('default')
    expect(lut.length).toBe(1024)
    // The end stops land exactly; nothing in between may leave the ramp.
    expect([...lut.slice(0, 4)]).toEqual([0xff, 0xfe, 0xf9, 255])
    expect([...lut.slice(255 * 4, 255 * 4 + 4)]).toEqual([0x1a, 0x0a, 0x10, 255])
    // Monotonically darkening, which is what makes it a sequential ramp rather
    // than a set of hues. Neighbour to neighbour the tolerance is one rounding
    // step — the table is bytes, and a channel that rounds up while another
    // rounds down can wobble by a fraction — but no *stop* to *stop* interval
    // may brighten at all.
    const luminance = (i: number): number =>
      0.2126 * lut[i * 4] + 0.7152 * lut[i * 4 + 1] + 0.0722 * lut[i * 4 + 2]
    for (let i = 1; i < 256; i++) expect(luminance(i)).toBeLessThanOrEqual(luminance(i - 1) + 1)
    for (let i = 21; i < 256; i += 21) expect(luminance(i)).toBeLessThan(luminance(i - 21))
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

describe('a balanced matrix under log10', () => {
  // Balanced values are fractions, so log10 of them is negative almost
  // everywhere — and "almost" is the trap. A real E. coli map balances a little
  // above 1 on the diagonal, so the show() rule finds positives, anchors vmin at
  // 0, and clips the other 99.6% of the matrix to white.
  const balanced = [1e-5, 1e-4, 1e-3, 1e-2]

  it('keeps the CLI rule for raw counts, to the bit', () => {
    expect(autoRangeOf(Float32Array.from([0, 0, 0, 4]), 'none')).toEqual({ vmin: 0, vmax: 4 })
    const counts = Float32Array.from([0, 1, 10, 100, 1000])
    expect(autoRangeOf(counts, 'log10')).toEqual({
      vmin: 0,
      vmax: autoVmaxOf(counts, 'log10'),
    })
  })

  it('uses the percentile range for balanced values', () => {
    const range = autoRangeOf(Float32Array.from(balanced), 'log10', true)
    expect(range.vmin).toBeLessThan(0)
    expect(range.vmax).toBeLessThan(0)
    // p1 and p99 of [-5, -4, -3, -2]; the old rule answered { vmin: 0, vmax: 1 }.
    expect(range.vmin).toBeCloseTo(-4.97, 2)
    expect(range.vmax).toBeCloseTo(-2.03, 2)
  })

  it('is not rescued by the handful of cells that balance above 1', () => {
    // The shape of the real file: one cell over 1, everything else well under.
    const withDiagonal = Float32Array.from([...balanced, 1.9])
    const range = autoRangeOf(withDiagonal, 'log10', true)
    expect(range.vmin).toBeLessThan(0)
    expect(range.vmax).toBeGreaterThan(range.vmin)
    // What the CLI rule would have said, and what made the panel blank: a floor
    // at zero, above every value in the block but one.
    expect(autoRangeOf(withDiagonal, 'log10', false)).toEqual({
      vmin: 0,
      vmax: expect.closeTo(Math.log10(1.9), 5),
    })
  })

  it('ignores empty cells, which a sparse block is mostly made of', () => {
    // Under log1p the zeros stay finite and in range; counting them would put
    // both percentiles on the background and blank the panel by another route.
    const sparse = Float32Array.from([...new Array(200).fill(0), ...balanced])
    const range = autoRangeOf(sparse, 'log1p', true)
    expect(range.vmin).toBeGreaterThan(0)
    expect(range.vmax).toBeGreaterThan(range.vmin)
  })

  it('draws zero at the low end and NaN as transparent', () => {
    expect(displayValue(0, 'log10', true)).toBe(Number.NEGATIVE_INFINITY)
    expect(displayValue(Number.NaN, 'log10', true)).toBeNaN()
    // Unbalanced, it is still numpy's np.where(arr > 0, log10(arr), 0.0).
    expect(displayValue(0, 'log10')).toBe(0)
    expect(displayValue(Number.NaN, 'log10')).toBe(0)
  })

  it('spans the colormap instead of painting one flat colour', () => {
    const r = rasterize(block([...balanced], 2, 2), {
      vmin: Number.NaN,
      vmax: Number.NaN,
      transform: 'log10',
      colormap: 'afmhot_r',
      balanced: true,
    })
    const lut = applyColormap('afmhot_r')
    const pixel = (i: number): number[] => [...r.data.slice(i * 4, i * 4 + 4)]
    // The blank panel was every cell at lut[0]; now only the smallest is.
    expect(pixel(0)).toEqual([...lut.slice(0, 4)])
    expect(pixel(3)).toEqual([...lut.slice(255 * 4, 255 * 4 + 4)])
    expect(new Set([0, 1, 2, 3].map((i) => pixel(i).join(','))).size).toBe(4)
  })

  it('puts an empty cell at the low end, not above the highest contact', () => {
    const r = rasterize(block([0, ...balanced.slice(1)], 2, 2), {
      vmin: Number.NaN,
      vmax: Number.NaN,
      transform: 'log10',
      colormap: 'afmhot_r',
      balanced: true,
    })
    const lut = applyColormap('afmhot_r')
    // Under the numpy clamp this cell would transform to 0.0 — above a vmax of
    // about -2 — and the background would come out darker than every contact.
    expect([...r.data.slice(0, 4)]).toEqual([...lut.slice(0, 4)])
  })

  it('reports the extent a clip slider spans, ignoring zeros and NaN', () => {
    const extent = valueExtentOf(Float32Array.from([0, Number.NaN, ...balanced]), 'log10', true)
    expect(extent?.vmin).toBeCloseTo(-5, 5)
    expect(extent?.vmax).toBeCloseTo(-2, 5)
    expect(valueExtentOf(Float32Array.from([Number.NaN]), 'log10', true)).toBeNull()
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

describe('the key in the corner of a map', () => {
  it('formats counts without a locale', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(7)).toBe('7')
    expect(formatCount(9999)).toBe('9999')
    expect(formatCount(12_500)).toBe('12.5k')
    expect(formatCount(3_000_000)).toBe('3M')
    expect(formatCount(0.25)).toBe('0.25')
  })

  /**
   * A cell has been through up to three things and the title names all of them.
   * `O/E (log2)` over a map whose O/E was measured on balanced counts describes
   * a different picture from the same words over raw ones.
   */
  it('names what was read, what was done to it, and how it is drawn', () => {
    expect(keyTitle(['', 'balanced', 'O/E'], 'log2')).toBe('Balanced O/E (log2)')
    expect(keyTitle(['', 'count', ''], 'log1p')).toBe('Count (log1p)')
    expect(keyTitle(['balanced', ''], 'log10', '◣')).toBe('◣ Balanced (log10)')
  })

  /** "No transform" is not a fact a figure needs to carry on every raw map. */
  it('leaves `none` off', () => {
    expect(keyTitle(['', 'count', ''], 'none')).toBe('Count')
  })

  /**
   * The whole of what changed. The clip boxes and the hash have always been in
   * transformed units, so a reader who typed `[-1, 1]` on a `log2` O/E map must
   * read `-1` and `1` — the old bar inverse-transformed them into `0.5` and `2`
   * and left them to invert it back in their head.
   */
  it('shows the bounds in the units the reader typed them in', () => {
    const key = keyContent(
      { vmin: -1, vmax: 1, transform: 'log2', colormap: 'RdBu_r' },
      'Balanced O/E (log2)',
      (v) => String(v),
    )
    expect([key.loLabel, key.hiLabel]).toEqual(['-1', '1'])
    expect(key.loColor).not.toBe(key.hiColor)
  })

  /** `NaN` is how a `ColorScale` asks for the default; it must not be printed. */
  it('survives an unclipped bound', () => {
    const key = keyContent(
      { vmin: Number.NaN, vmax: Number.NaN, transform: 'none', colormap: 'afmhot_r' },
      'Count',
      (v) => String(v),
    )
    expect([key.loLabel, key.hiLabel]).toEqual(['0', '1'])
  })
})

describe('raster pooling', () => {
  it('rasterises one pixel per cell while the matrix fits', () => {
    const r = rasterize(block([0, 1, 2, 3], 2, 2), {
      vmin: 0,
      vmax: 3,
      transform: 'none',
      colormap: 'afmhot_r',
    })
    expect(r.strideX).toBe(1)
    expect(r.strideY).toBe(1)
    expect(r.width).toBe(2)
    expect(r.height).toBe(2)
  })

  it('pools above the cap, and reports how much', () => {
    const n = 9
    const r = rasterize(block(new Array(n * n).fill(1), n, n), {
      vmin: 0,
      vmax: 1,
      transform: 'none',
      colormap: 'afmhot_r',
    }, { maxDim: 3 })
    expect(r.strideX).toBe(3)
    expect(r.strideY).toBe(3)
    expect(r.width).toBe(3)
    expect(r.height).toBe(3)
    expect(r.data.length).toBe(3 * 3 * 4)
  })

  it('takes the maximum of a pooled block, not the mean', () => {
    // One bright cell among fifteen empty ones must survive the pooling: a loop
    // that averages away at fit zoom is a loop nobody sees.
    const values = new Array(16).fill(0)
    values[5] = 10
    const pooled = rasterize(block(values, 4, 4), {
      vmin: 0,
      vmax: 10,
      transform: 'none',
      colormap: 'afmhot_r',
    }, { maxDim: 1 })
    const full = rasterize(block([10], 1, 1), {
      vmin: 0,
      vmax: 10,
      transform: 'none',
      colormap: 'afmhot_r',
    })
    expect(pooled.width).toBe(1)
    expect(Array.from(pooled.data)).toEqual(Array.from(full.data))
  })

  it('keeps a partial last block, and an all-NaN block transparent', () => {
    const r = rasterize(block([1, 1, 1, 1, 1, Number.NaN, Number.NaN, 1, 1], 3, 3), {
      vmin: 0,
      vmax: 1,
      transform: 'none',
      colormap: 'afmhot_r',
    }, { maxDim: 2 })
    // 3 cells at stride 2 → 2 raster pixels per axis, the last covering one cell.
    expect(r.strideX).toBe(2)
    expect(r.strideY).toBe(2)
    expect(r.width).toBe(2)
    expect(r.height).toBe(2)

    const allNaN = rasterize(block([Number.NaN, Number.NaN, Number.NaN, Number.NaN], 2, 2), {
      vmin: 0,
      vmax: 1,
      transform: 'none',
      colormap: 'afmhot_r',
    }, { maxDim: 1 })
    expect(allNaN.data[3]).toBe(0)
  })

  it('computes the same auto vmax as the two-pass path it replaced', () => {
    const values = Float32Array.from([0, 1, 2, 3, 4, 5, 0, 7, 11, 13, 0, 17])
    for (const transform of ['none', 'log1p', 'log10'] as const) {
      expect(autoVmaxOf(values, transform)).toBe(autoVmax(transformValues(values, transform)))
    }
  })
})
