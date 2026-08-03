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
 * The mirror covers raw counts, which is everything the CLI can draw: `show()`
 * reads `matrix(balance=False)`. Balanced values are the viewer's own, they are
 * fractions rather than counts, and both the zero clamp and the anchored `vmin`
 * are wrong for them — see {@link displayValue} and {@link autoRangeOf}, the two
 * places where this file deliberately stops mirroring.
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
 * The value a **pixel** is coloured by, which is {@link transformValue} plus one
 * exception.
 *
 * `log10`'s "non-positive becomes `0`" is numpy's rule and it is right for raw
 * counts, where every stored value is at least `1` and `0` is therefore the
 * bottom of the picture. It is exactly backwards for a *balanced* matrix, whose
 * values are fractions: `log10` of those is negative, so the clamp puts the
 * empty background *above* every contact in the file and paints it black.
 *
 * Balancing is a viewer feature — `metacooler show` reads `matrix(balance=False)`
 * and has no `--balance` — so there is no parity to keep here. Zero becomes
 * `-Infinity`, which {@link rasterize} draws at the low end of the colormap:
 * matplotlib's `LogNorm` "under" colour, and byte-identical to the numpy rule
 * for a count matrix, where `0` *is* the low end.
 */
export function displayValue(x: number, transform: Transform, balanced = false): number {
  if (balanced && transform === 'log10') {
    // NaN is not zero: an unbalanced bin has no value, and the raster leaves it
    // transparent rather than drawing it at either end of the scale.
    return Number.isNaN(x) ? Number.NaN : x > 0 ? Math.log10(x) : Number.NEGATIVE_INFINITY
  }
  return transformValue(x, transform)
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

/**
 * The `k`-th smallest element, in place, in expected linear time.
 *
 * Quickselect with a median-of-three pivot and a Hoare partition. On return the
 * array is *partially* ordered around `k`: everything before it is no greater,
 * everything after no smaller. That is the whole invariant {@link percentileOf}
 * needs, and it is what a full sort spends `log n` extra passes establishing
 * for every element nobody is going to look at.
 *
 * `values` is permuted. Every caller here owns a scratch copy built one line
 * earlier, so that is free rather than rude.
 *
 * Assumes no `NaN`: the collectors above filter on predicates that exclude it,
 * and a `NaN` pivot would make the partition loops run off the ends.
 */
export function selectNth(values: Float32Array, k: number): number {
  let lo = 0
  let hi = values.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const a = values[lo]
    const b = values[mid]
    const c = values[hi]
    // Median of three, by value: any of the three is a member of the range, so
    // the partition below is guaranteed to make progress.
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b
    let i = lo - 1
    let j = hi + 1
    for (;;) {
      do i++
      while (values[i] < pivot)
      do j--
      while (values[j] > pivot)
      if (i >= j) break
      const swap = values[i]
      values[i] = values[j]
      values[j] = swap
    }
    if (k <= j) hi = j
    else lo = j + 1
  }
  return values[k]
}

/**
 * {@link percentileLinear} without the sort — the same number, from an unsorted
 * array, in O(n).
 *
 * The two straddling order statistics are all the interpolation reads, and
 * selection finds them exactly: `selectNth` places the lower one and leaves
 * every larger element after it, so the upper one is the minimum of the tail.
 * The lerp that follows is byte-for-byte the one above, so this is a change of
 * *cost* and not of value — which matters, because the number it produces sets
 * the brightness of every pixel and is compared against numpy in the goldens.
 *
 * @param values Scratch array, permuted in place.
 */
export function percentileOf(values: Float32Array, q: number): number {
  const n = values.length
  if (n === 0) return Number.NaN
  if (n === 1) return values[0]
  const pos = ((n - 1) * q) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = selectNth(values, lo)
  if (lo === hi) return a
  let b = values[lo + 1]
  for (let i = lo + 2; i < n; i++) {
    if (values[i] < b) b = values[i]
  }
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
  return autoVmaxImpl(transformed)
}

/**
 * The same percentile, from the **raw** values, applying `transform` as it
 * goes — so no `n`-cell transformed array has to exist to hold them.
 *
 * Only the positive values are collected, and a contact map is sparse: for a
 * whole yeast genome at 1 kb that is the difference between 585 MB and the
 * size of the pixel list. Float32 because the values are Float32 either way —
 * they come from a Float32 matrix and `transformValues` rounded them to Float32
 * before, so the order and the two straddling values are identical.
 *
 * Pass raw counts, never transformed ones: transforming twice is silent and
 * darkens the whole image.
 */
export function autoVmaxOf(values: ArrayLike<number>, transform: Transform): number {
  const nz = collectDisplay(values, transform, false, (_raw, x) => x > 0)
  return nz.length === 0 ? 1.0 : percentileOf(nz, AUTO_VMAX_PERCENTILE)
}

/** The low percentile of the fallback rule in {@link autoRangeOf}. */
export const AUTO_VMIN_PERCENTILE = 1

/** A resolved pair of colour-scale bounds, in transformed units. */
export interface ValueRange {
  vmin: number
  vmax: number
}

/**
 * Both bounds at once — the auto rule the panel uses when neither has been set
 * by hand.
 *
 * **Raw counts** get `show()`'s rule, unchanged and to the bit: `vmin = 0` and
 * `vmax` at the 99th percentile of the positive transformed values. Zero is a
 * true floor there — a count cannot go below it — so anchoring the scale to it
 * is what makes two views of the same file comparable.
 *
 * **Balanced values** cannot use it. They are fractions, so `log10` of them is
 * negative almost everywhere: on a real 10 kb E. coli map, 0.4% of the cells
 * transform positive (the diagonal, which balances above 1) and the other 99.6%
 * land below a `vmin` of zero — one white panel with a dark diagonal, which is
 * the bug this branch exists to fix. Zero is not a floor for these values but an
 * arbitrary point in the middle of nothing, so the range becomes the 1st to 99th
 * percentile of the cells that carry a contact at all.
 *
 * Empty cells are excluded from that percentile on purpose. A metagenomic block
 * is mostly zeros; including them would put both percentiles on the background
 * and produce the same blank panel by a different route.
 *
 * @param balanced Whether the values are balanced fractions rather than counts.
 * It decides both the branch here and how `log10` treats zero
 * ({@link displayValue}).
 */
export function autoRangeOf(
  values: ArrayLike<number>,
  transform: Transform,
  balanced = false,
): ValueRange {
  if (!balanced) {
    const positive = collectDisplay(values, transform, false, (_raw, x) => x > 0)
    if (positive.length > 0) {
      return { vmin: 0, vmax: percentileOf(positive, AUTO_VMAX_PERCENTILE) }
    }
  }
  const contacts = collectDisplay(
    values,
    transform,
    balanced,
    (raw, x) => raw > 0 && Number.isFinite(x),
  )
  if (contacts.length === 0) return { vmin: 0, vmax: 1.0 }
  const vmin = percentileOf(contacts, AUTO_VMIN_PERCENTILE)
  const vmax = percentileOf(contacts, AUTO_VMAX_PERCENTILE)
  // A constant matrix has no range to speak of; matplotlib collapses one to the
  // colormap's low end, and `vmin + 1` is the span that reproduces that.
  return vmax > vmin ? { vmin, vmax } : { vmin, vmax: vmin + 1 }
}

/**
 * {@link autoRangeOf} over values that have **already** been through
 * {@link displayValue} — the pooled raster, rather than the matrix behind it.
 *
 * The two agree cell for cell when nothing was pooled, because the predicates
 * below are the display-space spelling of the raw-space ones:
 *
 * - `display > 0` is `raw > 0` under `log1p` and `none`, and under `log10` it
 *   is `raw > 1`, which is what the raw-space rule selects too (`log10` clamps
 *   everything at or below 1 to `0`);
 * - "carries a contact" is `raw > 0 && isFinite(display)`; every transform is
 *   monotone in `raw`, so that is `isFinite(display) && display > display(0)`
 *   — and `display(0)` is `-Infinity` exactly in the balanced `log10` case the
 *   fallback exists for.
 *
 * Where pooling *has* happened the two deliberately differ, and that is the
 * point: the percentile has to describe the pixels being drawn. Scaling
 * 146 million cells and then drawing the maximum of every 3 × 3 block put
 * ~8.6% of the picture above the 99th percentile instead of 1%, so a whole
 * yeast genome came out visibly hotter in the browser than the same file does
 * from `metacooler show` (spec §7.1).
 */
export function autoRangeOfDisplay(
  display: ArrayLike<number>,
  transform: Transform,
  balanced = false,
): ValueRange {
  if (!balanced) {
    const positive = collectWhere(display, (x) => x > 0)
    if (positive.length > 0) {
      return { vmin: 0, vmax: percentileOf(positive, AUTO_VMAX_PERCENTILE) }
    }
  }
  const floor = displayValue(0, transform, balanced)
  const contacts = collectWhere(display, (x) => Number.isFinite(x) && x > floor)
  if (contacts.length === 0) return { vmin: 0, vmax: 1.0 }
  // Two selections rather than two lookups into one sorted array: each is O(n)
  // and the second runs over an array the first already partitioned, which is
  // still cheaper than the `n log n` a sort costs to answer both.
  const vmin = percentileOf(contacts, AUTO_VMIN_PERCENTILE)
  const vmax = percentileOf(contacts, AUTO_VMAX_PERCENTILE)
  return vmax > vmin ? { vmin, vmax } : { vmin, vmax: vmin + 1 }
}

/**
 * The kept values, unordered. Two passes so the array is sized once.
 *
 * Deliberately *not* sorted. A 4,096² pooled raster of a dense overview keeps
 * ~15 M values, and sorting them to read two order statistics measured at
 * 1.8 s — a two-second freeze per colormap change, for a pair of numbers
 * {@link percentileOf} extracts in a linear pass.
 */
function collectWhere(
  values: ArrayLike<number>,
  keep: (x: number) => boolean,
): Float32Array {
  const n = values.length
  let count = 0
  for (let i = 0; i < n; i++) if (keep(values[i])) count++
  const out = new Float32Array(count)
  let k = 0
  for (let i = 0; i < n; i++) {
    const x = values[i]
    if (keep(x)) out[k++] = x
  }
  return out
}

/**
 * The full extent of the drawable values, which is what a clip *slider* spans —
 * as opposed to {@link autoRangeOf}, which is where its two handles start.
 *
 * `null` when nothing is drawable: an all-NaN block, or an all-zero one under
 * `log10` of a balanced matrix.
 */
export function valueExtentOf(
  values: ArrayLike<number>,
  transform: Transform,
  balanced = false,
): ValueRange | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const x = displayValue(values[i], transform, balanced)
    if (!Number.isFinite(x)) continue
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return lo <= hi ? { vmin: lo, vmax: hi } : null
}

/**
 * The display values whose `(raw, display)` pair passes `keep`, unordered.
 *
 * Float32 because the values are Float32 either way — they come from a Float32
 * matrix — so the order and the two straddling values are identical to what a
 * Float64 copy would give.
 */
function collectDisplay(
  values: ArrayLike<number>,
  transform: Transform,
  balanced: boolean,
  keep: (raw: number, display: number) => boolean,
): Float32Array {
  const n = values.length
  let count = 0
  for (let i = 0; i < n; i++) {
    if (keep(values[i], displayValue(values[i], transform, balanced))) count++
  }
  const out = new Float32Array(count)
  let k = 0
  for (let i = 0; i < n; i++) {
    const x = displayValue(values[i], transform, balanced)
    if (keep(values[i], x)) out[k++] = x
  }
  return out
}

function autoVmaxImpl(transformed: ArrayLike<number>): number {
  const n = transformed.length
  let count = 0
  for (let i = 0; i < n; i++) if (transformed[i] > 0) count++
  if (count === 0) return 1.0

  // Float64 for the sort and the interpolation even when the input is Float32:
  // the percentile is a single number that sets the whole image's brightness,
  // so it is worth carrying at double precision once the values are extracted.
  // Float32 rather than Float64, matching its two siblings: the input is a
  // Float32 matrix either way, so the order and the two straddling values are
  // identical, and the buffer is half the size against the same budget.
  const nz = new Float32Array(count)
  let k = 0
  for (let i = 0; i < n; i++) {
    const x = transformed[i]
    if (x > 0) nz[k++] = x
  }
  return percentileOf(nz, AUTO_VMAX_PERCENTILE)
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
