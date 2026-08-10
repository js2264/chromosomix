/**
 * Contact probability against genomic separation, and the *expected* curve.
 *
 * P(s) is the first thing anybody plots from a contact map and the last thing
 * anybody should skip: two loci a kilobase apart touch constantly and two loci a
 * megabase apart touch rarely, the decay is close to a power law over three or
 * four decades, and almost every interesting feature of a Hi-C map is a
 * departure from it. §18.8 puts it first in the catalogue for that reason, and
 * gives it a second job — *producing the **expected** curve three later tasks
 * consume*. Observed/expected, the Pearson correlation the compartment chain is
 * built on, and the saddle are all downstream of exactly the numbers here, so a
 * mistake in this module is a mistake in four results rather than one, and it is
 * a mistake that looks plausible in every one of them.
 *
 * The accumulator is separate from the curve on purpose. A P(s) over a genome is
 * a streaming sum: blocks arrive one at a time, from different contigs and
 * possibly from different workers' passes, and the only thing that has to be
 * shared between them is a pair of arrays indexed by offset. {@link
 * ExpectedAccumulator} is therefore mergeable, and {@link ExpectedCurve} — what
 * comes out of it — is an immutable record that a later task can hold on to
 * without worrying about who else is still adding to it.
 *
 * Everything here is in **bins**, because that is what an offset is. Base pairs
 * appear exactly once, in {@link logBinCurve}, which is the function whose output
 * gets an axis drawn on it.
 */

import { logSpacedEdges } from './stats'

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

/**
 * A per-offset average, and the evidence behind it.
 *
 * All three arrays are `maxOffset + 1` long and indexed by offset in bins, so
 * offset `0` is the diagonal and `maxOffset` is the longest separation the
 * accumulator was built to reach. `mean[k]` is `NaN` where `count[k]` is zero —
 * *no value here*, never zero contacts, since an offset nothing was read at and
 * an offset that was read and found empty are different claims and only the
 * second one is data.
 *
 * `sum` and `count` survive alongside `mean` because merging two curves means
 * adding sums and counts; a curve that carried only its means could not be
 * combined with another without weighting them, and the weights are what was
 * thrown away.
 */
export interface ExpectedCurve {
  maxOffset: number
  sum: Float64Array
  count: Float64Array
  mean: Float64Array
}

/**
 * A running P(s), fed a cell or a block at a time.
 *
 * Sums accumulate in `Float64Array` even though the pixels arrive as
 * `Float32Array`, for the reason `analysis/viewpoint.ts`'s `bandSums` gives: the
 * diagonal of a deep map is millions of cells, and float32 stops adding small
 * numbers to a large total long before that. `count` is a `Float64Array` rather
 * than an integer array for the plainest possible reason — a whole-genome scan
 * runs past 2³¹ cells on a large assembly, and an `Int32Array` counter wraps
 * negative and takes the mean with it.
 */
export class ExpectedAccumulator {
  readonly maxOffset: number
  private readonly sum: Float64Array
  private readonly count: Float64Array

  constructor(maxOffset: number) {
    this.maxOffset = Math.max(0, Math.trunc(maxOffset))
    this.sum = new Float64Array(this.maxOffset + 1)
    this.count = new Float64Array(this.maxOffset + 1)
  }

  /**
   * One cell, at separation `offset` bins.
   *
   * `NaN` is skipped and does **not** raise the count: `count` is the number of
   * cells that had a value, so the mean is over what was observed. Counting a
   * balancer-dropped bin as a zero-valued observation would pull P(s) down by
   * whatever fraction of the map is filtered, and that fraction is largest at
   * exactly the short separations where the curve is steepest.
   */
  add(offset: number, value: number): void {
    if (offset < 0 || offset > this.maxOffset || Number.isNaN(value)) return
    const k = offset | 0
    this.sum[k] += value
    this.count[k] += 1
  }

  /**
   * Every cell of a dense block, at the offset its **absolute** bins imply.
   *
   * The offset is `|(colExtent[0] + c) − (rowExtent[0] + r)|` and never `|c − r|`.
   * A block's local indices only agree with its absolute ones when it starts at
   * the origin of both axes, so an off-diagonal block — a trans block, the
   * second half of a chromosome, anything the view scrolled to — would otherwise
   * have its whole content filed under separations near zero, producing a P(s)
   * that is smooth, monotonic and entirely fictional.
   *
   * **Each cell is counted once, and a mirrored square is fine.** A dense square
   * read back from an upper-triangular store holds every off-diagonal pair twice,
   * once at (i, j) and once at (j, i). Both copies are added, so `sum[k]` and
   * `count[k]` are each exactly twice what a triangular pass would give — and the
   * mean, which is the only thing anybody reads, is unchanged. This is the one
   * place a reimplementation goes wrong by a factor of two: halving the count to
   * "correct" for the mirror doubles every expected value, and the resulting O/E
   * map is uniformly half what it should be, which looks like a normalisation
   * choice rather than like a bug.
   */
  addBlock(block: {
    nrows: number
    ncols: number
    values: Float32Array
    rowExtent: [number, number]
    colExtent: [number, number]
  }): void {
    const { nrows, ncols, values } = block
    const rowFrom = block.rowExtent[0]
    const colFrom = block.colExtent[0]
    for (let r = 0; r < nrows; r++) {
      const row = rowFrom + r
      const base = r * ncols
      for (let c = 0; c < ncols; c++) {
        const value = values[base + c]
        if (Number.isNaN(value)) continue
        const offset = Math.abs(colFrom + c - row)
        if (offset > this.maxOffset) continue
        this.sum[offset] += value
        this.count[offset] += 1
      }
    }
  }

  /**
   * Fold another accumulator's totals into this one.
   *
   * Sums and counts are additive, which is what makes a P(s) splittable across
   * contigs and across passes at all. Where the two reaches differ only the
   * overlap is merged — the runner builds both from the same `maxOffset`, so a
   * mismatch is a bug, and truncating keeps the offsets that *are* shared
   * correct rather than writing past the end of an array.
   */
  merge(other: ExpectedAccumulator): void {
    const n = Math.min(this.sum.length, other.sum.length)
    for (let k = 0; k < n; k++) {
      this.sum[k] += other.sum[k]
      this.count[k] += other.count[k]
    }
  }

  /**
   * The curve as a record.
   *
   * The arrays are copies, so the accumulator can keep running — a task that
   * shows a partial curve while a scan continues is the obvious use, and one
   * that hands the live buffers out is a task whose finished result changes
   * under it.
   */
  finish(): ExpectedCurve {
    const mean = new Float64Array(this.sum.length)
    for (let k = 0; k < mean.length; k++) {
      mean[k] = this.count[k] > 0 ? this.sum[k] / this.count[k] : Number.NaN
    }
    return {
      maxOffset: this.maxOffset,
      sum: this.sum.slice(),
      count: this.count.slice(),
      mean,
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the curve
// ---------------------------------------------------------------------------

/**
 * The curve rebinned onto logarithmic separations, ready to plot.
 *
 * `x` is in **base pairs** — the only place in this module that leaves bins,
 * because it is the axis a reader reads, and §18.2's rule that a length is a
 * property of the question rather than of the file applies to an axis as much as
 * to a parameter. `y` is the count-weighted mean of the per-offset means inside
 * the bin, which is the same number as the bin's total divided by its total
 * count, and is *not* the unweighted mean of the means: a log bin at long range
 * spans hundreds of offsets whose evidence differs by orders of magnitude, and
 * averaging their means as equals would let the emptiest offset in the bin count
 * as much as the fullest. `n` is the cells behind the point, which is what the
 * drawer prints when somebody asks why the tail is noisy.
 *
 * `minOffset` floors the first bin, **in bins of this file**. The near-diagonal
 * offsets are dominated by unligated fragments and self-ligation rather than by
 * polymer contact, so a P(s) plotted from offset zero has a false shoulder at
 * its left edge that has misled people into reading a structural feature off it.
 * A floor of at least one bin is enforced regardless, since offset zero is the
 * diagonal and has no place on a log axis at all.
 *
 * Bins rather than base pairs, which is a change from what the form used to ask
 * for: the near-diagonal is a fact about the grid, not about the genome, and a
 * number typed in base pairs meant three bins at one resolution and one at the
 * next. It is also the unit the accumulator counts in, so the conversion — and
 * the rounding it did — is gone rather than moved.
 *
 * **Empty log bins are dropped, not emitted as `NaN`.** With a factor near one
 * the bins at short range are narrower than a bin of the file, so many of them
 * contain no integer offset at all — and a log-log plot punched full of holes is
 * unreadable in a way that has nothing to do with the data. The abscissa is the
 * count-weighted mean offset of the cells in the bin rather than the geometric
 * centre of its edges, so a point sits where its evidence is: a bin spanning
 * 1.0–1.1 bins holds only offset 1, and drawing it at 1.05 would place the point
 * at a separation nothing in it has.
 */
export function logBinCurve(
  curve: ExpectedCurve,
  binsize: number,
  factor: number,
  minOffset: number,
): { x: Float64Array; y: Float64Array; n: Float64Array } {
  const bp = binsize > 0 ? binsize : 1
  const floor = Number.isFinite(minOffset) ? minOffset : 0
  const floorOffset = Math.max(1, Math.ceil(floor))
  const edges = logSpacedEdges(floorOffset, curve.maxOffset + 1, factor)
  const xs: number[] = []
  const ys: number[] = []
  const ns: number[] = []

  for (let e = 0; e + 1 < edges.length; e++) {
    const from = Math.max(floorOffset, Math.ceil(edges[e]))
    const to = Math.min(curve.maxOffset + 1, Math.ceil(edges[e + 1]))
    let total = 0
    let cells = 0
    let offsetWeight = 0
    for (let k = from; k < to; k++) {
      const count = curve.count[k]
      if (count <= 0) continue
      total += curve.sum[k]
      cells += count
      offsetWeight += count * k
    }
    if (cells <= 0) continue
    xs.push((offsetWeight / cells) * bp)
    ys.push(total / cells)
    ns.push(cells)
  }

  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: Float64Array.from(ns) }
}

/**
 * The local slope of `log y` against `log x`, by central differences.
 *
 * **This is usually where the biology is.** P(s) itself is a near-straight line
 * on log-log paper over three decades and the eye is very bad at seeing a change
 * of slope in one; the derivative turns it into a shape. The scaling exponent of
 * a fractal globule against an equilibrium one, the shoulder that marks the
 * average loop size in a condensin-extruded chromosome, the plateau of a
 * bacterial chromosome — none of these are visible on the curve and all of them
 * are obvious on its derivative, which is why §18.8 asks for the log-log
 * derivative in the same breath as the curve.
 *
 * Central differences over the neighbouring points rather than a fitted window:
 * the input is already log-binned, so the points are evenly spaced in `log x`
 * and adjacent ones are as far apart as any local fit's support would be. The
 * result is two points shorter than the input — a one-sided difference at the
 * ends would be a different estimator drawn on the same line, and the place it
 * would be drawn is exactly where a reader is most tempted to read an exponent
 * off the tail.
 *
 * `x` of the result is the centre point's own abscissa, so the derivative panel
 * lines up under the curve. A slope that cannot be formed — a non-positive or
 * missing neighbour — is `NaN` and is drawn as a gap, since the alternative is
 * to close it with a line through data that is not there.
 */
export function logLogSlope(
  x: Float64Array,
  y: Float64Array,
): { x: Float64Array; y: Float64Array } {
  const n = Math.min(x.length, y.length)
  const width = Math.max(0, n - 2)
  const outX = new Float64Array(width)
  const outY = new Float64Array(width)
  for (let i = 1; i + 1 < n; i++) {
    outX[i - 1] = x[i]
    const x0 = x[i - 1]
    const x1 = x[i + 1]
    const y0 = y[i - 1]
    const y1 = y[i + 1]
    const dx = Math.log(x1) - Math.log(x0)
    // A zero or negative value has no logarithm, and a P(s) bin can legitimately
    // be zero where a sparse map has no contacts at that separation at all.
    const usable = x0 > 0 && x1 > 0 && y0 > 0 && y1 > 0 && dx !== 0
    outY[i - 1] = usable ? (Math.log(y1) - Math.log(y0)) / dx : Number.NaN
  }
  return { x: outX, y: outY }
}

/**
 * The expected value at `offsetBins`, interpolating over gaps.
 *
 * The function the three downstream tasks call once per cell, so it is written
 * to be cheap and to be right at the edges rather than to be general.
 *
 * A gap in the curve — an offset no cell was read at — is bridged by linear
 * interpolation between the nearest offsets on either side that do have a mean.
 * Past the end it returns `NaN` and **does not clamp**, and that is the whole
 * reason this is a function rather than an array index. A clamp would hand back
 * the last populated offset's expected value for every separation beyond it, so
 * a far-cis O/E would be computed against a number belonging to a much shorter
 * separation, come out several-fold too large, and look like a compartment. `NaN`
 * propagates into a transparent cell instead, which says what is true: this
 * separation was outside what the expected curve covers.
 *
 * Interpolation is linear in the mean rather than in its logarithm. Over the one
 * or two offsets a real gap spans, the two agree to well under the noise, and
 * the linear form is the one that still works when a neighbouring mean is
 * exactly zero.
 */
export function expectedAt(curve: ExpectedCurve, offsetBins: number): number {
  if (!Number.isFinite(offsetBins) || offsetBins < 0 || offsetBins > curve.maxOffset) {
    return Number.NaN
  }
  const { mean } = curve
  const lower = Math.floor(offsetBins)
  if (lower === offsetBins && !Number.isNaN(mean[lower])) return mean[lower]

  let left = lower
  while (left >= 0 && Number.isNaN(mean[left])) left--
  let right = Math.ceil(offsetBins)
  while (right <= curve.maxOffset && Number.isNaN(mean[right])) right++
  // Both sides are required, at both ends. Falling back to whichever side exists
  // is the clamp this function refuses to do, wearing a different name.
  if (left < 0 || right > curve.maxOffset) return Number.NaN
  const fraction = (offsetBins - left) / (right - left)
  return mean[left] + fraction * (mean[right] - mean[left])
}
