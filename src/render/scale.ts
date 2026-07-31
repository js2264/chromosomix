/**
 * Value transforms, the auto-`vmax` rule, and the one coordinate scale.
 *
 * The transform and `vmax` halves of this module are a line-by-line mirror of
 * `metacooler/ops/show.py` — `_transform_matrix` and the four lines of `show()`
 * that pick `vmax`. Spec §7.1 makes that parity a requirement rather than a
 * nicety: a figure in the paper and the same view in the browser have to be the
 * same picture, and `vmax` is the single number that decides how a contact map
 * looks.
 *
 * The {@link Scale} half is the coordinate model. Spec §8: heatmap and tracks
 * share *one* `Scale`, owned by the view state, so a bigWig track and the
 * matrix column under it can never drift apart by a pixel.
 */

import type { Extent, Transform } from '../types'

// ---------------------------------------------------------------------------
// Value transform (mirrors `_transform_matrix`, ops/show.py:617)
// ---------------------------------------------------------------------------

/**
 * Apply the display transform, exactly as `_transform_matrix` does.
 *
 * Two details are load-bearing and easy to "improve" into a divergence:
 *
 * - **`log10` maps non-positive values to `0`, not `-Infinity`.** Python is
 *   `np.where(arr > 0, np.log10(arr), 0.0)`. Zero is by far the most common
 *   value in a sparse contact map, so getting this wrong changes the whole
 *   background of the image.
 * - **`NaN > 0` is false**, so under `log10` a NaN becomes `0` — in both
 *   languages. It survives `log1p` and `none` untouched. That asymmetry is
 *   inherited from numpy on purpose: an unbalanced row shows as blank under
 *   `log1p` and as background under `log10` in the CLI too.
 *
 * The input is copied, never mutated: the caller keeps the raw counts for
 * tooltips and for recomputing after a transform change.
 *
 * @throws RangeError on an unknown transform, with the same wording as the
 * Python `ValueError`.
 */
export function transformValues(v: Float32Array, transform: Transform): Float32Array
export function transformValues(v: Float64Array, transform: Transform): Float64Array
export function transformValues(
  v: Float32Array | Float64Array,
  transform: Transform
): Float32Array | Float64Array {
  const n = v.length
  const out = v instanceof Float64Array ? new Float64Array(n) : new Float32Array(n)
  switch (transform) {
    case 'log1p':
      for (let i = 0; i < n; i++) out[i] = Math.log1p(v[i])
      return out
    case 'log10':
      for (let i = 0; i < n; i++) {
        const x = v[i]
        out[i] = x > 0 ? Math.log10(x) : 0
      }
      return out
    case 'none':
      // A loop rather than `out.set(v)`: `out` is a union of two typed arrays
      // and TypeScript refuses to resolve `set` across the union.
      for (let i = 0; i < n; i++) out[i] = v[i]
      return out
    default:
      throw new RangeError(`Unknown transform: '${String(transform)}'`)
  }
}

/**
 * The scalar form of {@link transformValues}, for the handful of single values
 * that need it (colourbar tick placement, a tooltip's position on the bar).
 *
 * Kept as a separate three-line switch rather than being called from the array
 * loop: the loop hoists its branch out of a million iterations, and that matters
 * more than the duplication. The two must stay in step — the `log10` zero clamp
 * is the line that would silently diverge.
 */
export function transformValue(x: number, transform: Transform): number {
  switch (transform) {
    case 'log1p':
      return Math.log1p(x)
    case 'log10':
      return x > 0 ? Math.log10(x) : 0
    case 'none':
      return x
    default:
      throw new RangeError(`Unknown transform: '${String(transform)}'`)
  }
}

/**
 * Undo {@link transformValues} for a single value — what a colourbar tick label
 * needs, because a reader reads counts, not log counts.
 *
 * `log10` is only a left inverse above zero: everything at or below `1` was
 * clamped to `0` on the way out, so `inverseTransform(0, 'log10')` returns `1`
 * and cannot distinguish that from a true count of `1`. Label the bottom of a
 * `log10` colourbar as "≤ 1" rather than pretending otherwise.
 */
export function inverseTransform(x: number, transform: Transform): number {
  switch (transform) {
    case 'log1p':
      return Math.expm1(x)
    case 'log10':
      return 10 ** x
    case 'none':
      return x
    default:
      throw new RangeError(`Unknown transform: '${String(transform)}'`)
  }
}

// ---------------------------------------------------------------------------
// Auto vmax (mirrors show(), ops/show.py:826-828)
// ---------------------------------------------------------------------------

/**
 * Linear-interpolated percentile, reproducing `np.percentile(a, q)` with its
 * default `method="linear"` (Hyndman & Fan type 7).
 *
 * The virtual index is `(n - 1) * q / 100` and the result interpolates between
 * the two neighbouring order statistics. A nearest-rank shortcut agrees only
 * when the index lands on an integer, which for the 99th percentile happens
 * only when `n - 1` is a multiple of 100 — i.e. almost never, and the
 * disagreement is a visible change in image brightness.
 *
 * The two-sided lerp is numpy's `_lerp`, not plain `a + t * (b - a)`: above
 * `t = 0.5` numpy anchors on `b` instead, which keeps the last ulp when `a` and
 * `b` are far apart. Copied so the two implementations agree to the bit.
 *
 * @param sorted Values in ascending order. Not copied, not modified.
 * @param q Percentile in `[0, 100]`.
 */
export function percentileLinear(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  if (n === 1) return sorted[0]
  const pos = ((n - 1) * q) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const a = sorted[lo]
  const b = sorted[hi]
  const t = pos - lo
  const diff = b - a
  return t < 0.5 ? a + diff * t : b - diff * (1 - t)
}

/** The percentile `metacooler show` uses when `--vmax` is not given. */
export const AUTO_VMAX_PERCENTILE = 99

/**
 * `vmax` for a matrix that has already been through {@link transformValues}:
 * the 99th percentile of its **non-zero** values.
 *
 * ```python
 * nonzero = mat[mat > 0]
 * vmax = float(np.percentile(nonzero, 99)) if nonzero.size > 0 else 1.0
 * ```
 *
 * `mat > 0` is a strict comparison, so it drops zeros *and* NaNs — matching
 * `v > 0` here, since `NaN > 0` is false in JavaScript too. Without the
 * non-zero filter a sparse MAG matrix, which is mostly zero, would put its 99th
 * percentile at or near zero and the image would be uniformly saturated.
 *
 * `vmin` is always 0; there is no `autoVmin`.
 *
 * @returns `1.0` when nothing is positive, exactly as Python's fallback.
 */
export function autoVmax(transformed: ArrayLike<number>): number {
  const n = transformed.length
  let count = 0
  for (let i = 0; i < n; i++) if (transformed[i] > 0) count++
  if (count === 0) return 1.0

  // Float64 for the sort and the interpolation even when the input is Float32:
  // the percentile is a single number that sets the whole image's brightness,
  // so it is worth carrying at double precision once the values are extracted.
  const nz = new Float64Array(count)
  let k = 0
  for (let i = 0; i < n; i++) {
    const x = transformed[i]
    if (x > 0) nz[k++] = x
  }
  nz.sort()
  return percentileLinear(nz, AUTO_VMAX_PERCENTILE)
}

// ---------------------------------------------------------------------------
// Coordinate scale (spec §8)
// ---------------------------------------------------------------------------

/**
 * A base-pair position on one contig, as {@link Scale}'s genomic layer reports
 * it. `contig` is an index into `/contigs`, not a name — names are the UI's
 * business and the reader already holds the table.
 */
export interface GenomicPosition {
  contig: number
  /** 0-based base-pair offset within that contig. */
  position: number
}

/** A bin's contig and its base-pair span, as `metacooler/coords.ts` computes it. */
export interface BinLocus {
  contig: number
  /** 0-based, inclusive. */
  start: number
  /** Exclusive. Short for the last bin of a contig — cooler's own rule. */
  end: number
}

/**
 * The fixed-bin coordinate arithmetic, injected rather than imported.
 *
 * Implemented by `metacooler/coords.ts` over `indexes/chrom_offset` and
 * `contigs/length` alone — `/bins` is never read (spec §3.3). Declaring it as
 * an interface here keeps `render/` free of any dependency on the reader, so
 * the heatmap can be unit-tested with three lines of stub arithmetic and so
 * neither module can grow a second, subtly different copy of the mapping.
 */
export interface GenomicMapper {
  /** Uniform bin width in base pairs. */
  readonly binsize: number
  /** Absolute bin index → its contig and base-pair span. */
  binToLocus(bin: number): BinLocus
  /** Contig index and base-pair position → absolute bin index. */
  locusToBin(contig: number, position: number): number
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * The single mapping between matrix coordinates and screen pixels.
 *
 * "Matrix coordinates" are **fractional bin indices along one axis of the
 * rendered block**: `0` is the left (or top) edge of the block's first cell,
 * `1` the boundary between its first and second cells. Integers therefore fall
 * on cell boundaries, which is what separator lines are drawn at, and
 * `Math.floor` of a coordinate is the cell containing it.
 *
 * Pixels are **plot-area-relative CSS pixels**, not canvas pixels: the heatmap
 * owns a margin for tick labels and a track sits underneath the same plot area,
 * so anchoring the scale to the plot rather than the canvas is what lets both
 * consume the same object unmodified.
 *
 * One `Scale` per axis. The view state owns them and hands them to the heatmap
 * (`HeatmapView.setScales`) and to every track; nobody else constructs one
 * (spec §8).
 */
export class Scale {
  private full0: number
  private full1: number
  private d0: number
  private d1: number
  private px: number
  private mapper: GenomicMapper | null = null

  /**
   * @param full The block's whole extent in matrix coordinates, normally
   * `[0, nbins]`. Also the domain a `reset()` returns to.
   * @param pixels Length of the plot area along this axis, in CSS pixels.
   */
  constructor(full: Extent, pixels: number) {
    this.full0 = full[0]
    this.full1 = full[1]
    this.d0 = full[0]
    this.d1 = full[1]
    this.px = pixels
  }

  /** The whole block, independent of the current zoom. */
  get full(): Extent {
    return [this.full0, this.full1]
  }

  /** The currently visible sub-range, in matrix coordinates. */
  get domain(): Extent {
    return [this.d0, this.d1]
  }

  /** Width of the visible range in matrix coordinates. Always `> 0`. */
  get span(): number {
    return this.d1 - this.d0
  }

  /** Plot-area length along this axis, in CSS pixels. */
  get pixels(): number {
    return this.px
  }

  /** CSS pixels per matrix cell — the heatmap's zoom factor. */
  get pixelsPerUnit(): number {
    return this.px / (this.d1 - this.d0)
  }

  /** Matrix cells per CSS pixel. */
  get unitsPerPixel(): number {
    return (this.d1 - this.d0) / this.px
  }

  /** The genomic layer, if one was attached. */
  get genomic(): GenomicMapper | null {
    return this.mapper
  }

  /**
   * Replace the block extent, resetting the visible domain to all of it. Called
   * when the view switches to a different genome or aggregation level.
   */
  setFull(full: Extent): void {
    if (!(full[1] > full[0])) {
      throw new RangeError(`Scale extent must be non-empty, got [${full[0]}, ${full[1]}]`)
    }
    this.full0 = full[0]
    this.full1 = full[1]
    this.reset()
  }

  /** Resize the plot area. The visible domain is preserved, so zoom changes. */
  setPixels(pixels: number): void {
    this.px = pixels
  }

  /** Set the visible sub-range directly. */
  setDomain(domain: Extent): void {
    if (!(domain[1] > domain[0])) {
      throw new RangeError(
        `Scale domain must be non-empty, got [${domain[0]}, ${domain[1]}]`
      )
    }
    this.d0 = domain[0]
    this.d1 = domain[1]
  }

  /** Show the whole block again. */
  reset(): void {
    this.d0 = this.full0
    this.d1 = this.full1
  }

  /** Matrix coordinate → plot-area CSS pixel. */
  toPixel(unit: number): number {
    return ((unit - this.d0) * this.px) / (this.d1 - this.d0)
  }

  /** Plot-area CSS pixel → matrix coordinate. */
  toUnit(pixel: number): number {
    return this.d0 + (pixel * (this.d1 - this.d0)) / this.px
  }

  /**
   * Cell index under a pixel, or `-1` when the pixel falls outside the block.
   * `full` is half-open, so a pixel exactly on the trailing edge is outside.
   */
  cellAt(pixel: number): number {
    const u = Math.floor(this.toUnit(pixel))
    return u >= this.full0 && u < this.full1 ? u : -1
  }

  /** Scroll by a screen distance. Positive `dx` drags the content rightwards. */
  panByPixels(dx: number): void {
    this.panByUnits(-dx * this.unitsPerPixel)
  }

  /** Scroll by a distance in matrix coordinates. */
  panByUnits(du: number): void {
    this.d0 += du
    this.d1 += du
  }

  /**
   * Zoom about a fixed screen point: the matrix coordinate under `pixel` stays
   * under `pixel`. `factor > 1` zooms in.
   */
  zoomAt(pixel: number, factor: number): void {
    if (!(factor > 0)) throw new RangeError(`Zoom factor must be positive, got ${factor}`)
    const anchor = this.toUnit(pixel)
    const span = (this.d1 - this.d0) / factor
    const frac = this.px === 0 ? 0 : pixel / this.px
    this.d0 = anchor - frac * span
    this.d1 = this.d0 + span
  }

  /**
   * Attach the fixed-bin arithmetic so this axis can also speak base pairs.
   * Only meaningful for a bin-level axis: at contig or genome level a "cell" is
   * a whole contig or genome and has no single coordinate.
   */
  attachGenomic(mapper: GenomicMapper | null): void {
    this.mapper = mapper
  }

  /**
   * Matrix coordinate → contig and base pair, interpolating inside the bin so a
   * track can be drawn at sub-bin precision.
   *
   * @returns `null` when no {@link GenomicMapper} is attached or the coordinate
   * is outside the block.
   */
  unitToLocus(unit: number): GenomicPosition | null {
    if (this.mapper === null) return null
    const bin = Math.floor(unit)
    if (bin < this.full0 || bin >= this.full1) return null
    const locus = this.mapper.binToLocus(bin)
    const width = locus.end - locus.start
    const frac = clamp(unit - bin, 0, 1)
    return { contig: locus.contig, position: locus.start + frac * width }
  }

  /** Plot-area CSS pixel → contig and base pair. */
  pixelToLocus(pixel: number): GenomicPosition | null {
    return this.unitToLocus(this.toUnit(pixel))
  }

  /**
   * Contig and base pair → matrix coordinate, again with sub-bin precision so a
   * bigWig interval does not snap to the bin grid.
   *
   * @returns `null` when no {@link GenomicMapper} is attached.
   */
  locusToUnit(contig: number, position: number): number | null {
    if (this.mapper === null) return null
    const bin = this.mapper.locusToBin(contig, position)
    const locus = this.mapper.binToLocus(bin)
    const width = locus.end - locus.start
    const frac = width > 0 ? clamp((position - locus.start) / width, 0, 1) : 0
    return bin + frac
  }

  /** Contig and base pair → plot-area CSS pixel. */
  locusToPixel(contig: number, position: number): number | null {
    const unit = this.locusToUnit(contig, position)
    return unit === null ? null : this.toPixel(unit)
  }

  /** An independent copy, sharing the genomic mapper. */
  clone(): Scale {
    const copy = new Scale([this.full0, this.full1], this.px)
    copy.setDomain([this.d0, this.d1])
    copy.attachGenomic(this.mapper)
    return copy
  }

  /** Structural equality of extent, domain and viewport — for change detection. */
  equals(other: Scale): boolean {
    return (
      this.full0 === other.full0 &&
      this.full1 === other.full1 &&
      this.d0 === other.d0 &&
      this.d1 === other.d1 &&
      this.px === other.px
    )
  }
}
