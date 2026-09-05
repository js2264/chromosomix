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
 * The module therefore has two readers and produces two things, and keeping them
 * apart is the whole of §18.8's P(s) entry. {@link expectedAt} serves the three
 * downstream tasks: the mean contact per pair of bins at a separation, which is
 * the denominator of an observed/expected and is cooltools' `expected-cis`.
 * {@link densityCurve} serves the reader: the share of all cis contacts that
 * fall at a separation, per base pair, which is what `HiContacts::distanceLaw()`
 * plots and what the panel draws. Both are called P(s) and they are not the same
 * curve — the pair count runs out as a separation approaches the length of a
 * sequence and the contact total does not — so nothing here converts one into
 * the other or treats a difference between them as an error.
 *
 * Everything is in **bins**, because that is what an offset is. Base pairs appear
 * exactly once, in {@link densityCurve}, which is the function whose output gets
 * an axis drawn on it.
 */

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

// ---------------------------------------------------------------------------
// The HiContacts convention
// ---------------------------------------------------------------------------

/**
 * `unique(round(factor^n))`, with the width of each bin beside it.
 *
 * This is HiContacts' `PsBreaks()` table, generated rather than tabulated. That
 * package ships 205 hard-coded break positions from 1 bp to 1.16 Gb and the 205
 * widths beside them; the positions are exactly `unique(round(1.1^(0:219)))` and
 * the widths exactly the differences between successive ones, which
 * `test/unit/analysis-golden.test.ts` asserts against the shipped numbers one by
 * one. Generating them means the file's own reach decides how far the
 * table goes and {@link densityCurve}'s `factor` still means what it says, rather
 * than a genome larger than 1.16 Gb quietly piling its longest separations into
 * a final bin.
 *
 * `pos` is one longer than `width`, because the width of the last usable bin is
 * the distance to the break after it. The generator therefore runs one step past
 * `maxDistance` — a table that stopped exactly at the data would have nothing to
 * measure its own last bin with.
 *
 * The rounding is `Math.round`, which differs from R's `round` on an exact `.5`;
 * no power of 1.1 lands there, and the test compares every entry against R's own
 * output rather than trusting that.
 */
export function logRoundedBreaks(
  factor: number,
  maxDistance: number,
): { pos: Float64Array; width: Float64Array } {
  const step = Number.isFinite(factor) && factor > 1 ? factor : 1.1
  const reach = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : 0
  const pos: number[] = []
  let last = -1
  for (let n = 0; pos.length < 4096; n++) {
    const value = Math.round(Math.pow(step, n))
    if (value === last) continue
    pos.push(value)
    last = value
    if (value > reach && pos.length >= 2) break
  }
  const width = new Float64Array(pos.length - 1)
  for (let i = 0; i + 1 < pos.length; i++) width[i] = pos[i + 1] - pos[i]
  return { pos: Float64Array.from(pos), width }
}

/**
 * R's `findInterval(x, vec, all.inside = TRUE)`, for a sorted `pos`.
 *
 * The largest `i` with `pos[i] <= distance`, clamped into the bins that have a
 * width — so a separation below the first break falls in the first bin rather
 * than off the table, which is what puts the diagonal and the first off-diagonal
 * of a binned map into the same 1 bp bin in HiContacts.
 */
function breakIndex(pos: Float64Array, distance: number): number {
  const last = pos.length - 2
  if (last < 0) return 0
  if (distance < pos[0]) return 0
  let lo = 0
  let hi = last
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pos[mid] <= distance) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * P(s) as HiContacts reports it, and as the panel draws it: a probability
 * density over separation.
 *
 * The contacts at a separation, over **the contacts in the whole map**, over the
 * **width of the separation bin in base pairs** — the share of all cis contacts
 * that fall at this distance, per base pair. `HiContacts::distanceLaw()`'s
 * `norm_p`, and the only curve this task plots.
 *
 * It is not {@link expectedAt}'s quantity rebinned. That one divides instead by
 * **the number of bin pairs that could have held a contact**, which is what an
 * observed/expected is taken against and what cooltools' `expected-cis` reports;
 * the two agree in shape at short range and diverge as the separation approaches
 * the length of the sequence, where the pair count is heading for zero and the
 * contact total is not. Both live in this module on purpose and neither is
 * derived from the other.
 *
 * Three further details are HiContacts' and are reproduced exactly, because a
 * curve that is off by one bin or by a factor of two is worse than one that is
 * openly a different convention:
 *
 * - **The separation is the gap, not the offset.** `InteractionSet::pairdist(…,
 *   type = 'gap')` is `max(start) − min(end) − 1` over the two anchors, and
 *   HiCExperiment builds cooler bins as `IRanges(start + 1, end)`, so two bins
 *   `k` apart are `(k − 1) · binsize` apart by that measure. Offset 1 lands at
 *   0 bp and the diagonal at −binsize; both fall in the first break.
 * - **Each unordered pair counts once.** The accumulator is fed dense squares
 *   read back from an upper-triangular store, so every off-diagonal cell arrives
 *   twice — harmless for a mean, fatal for a share of a total, since it would
 *   halve the diagonal's weight against everything else. `mirrored` folds them.
 * - **Empty bins are dropped**, as a `group_by` drops them, rather than drawn as
 *   a gap.
 *
 * `minOffset` is in bins and floors the curve, and it does **not** silently
 * floor at 1: the diagonal belongs to the first break here, and dropping it
 * would change the total that everything else is a share of.
 */
export function densityCurve(
  curve: ExpectedCurve,
  binsize: number,
  factor: number,
  minOffset: number,
  mirrored: boolean,
): { x: Float64Array; y: Float64Array; n: Float64Array } {
  const bp = binsize > 0 ? binsize : 1
  const floorOffset = Math.max(0, Math.ceil(Number.isFinite(minOffset) ? minOffset : 0))
  const fold = mirrored ? 2 : 1
  const breaks = logRoundedBreaks(factor, Math.max(0, curve.maxOffset - 1) * bp)
  const bins = breaks.width.length
  const contacts = new Float64Array(bins)
  const cells = new Float64Array(bins)

  let total = 0
  for (let k = floorOffset; k <= curve.maxOffset; k++) {
    const count = curve.count[k]
    if (!(count > 0)) continue
    const share = k === 0 ? 1 : fold
    const value = curve.sum[k] / share
    if (Number.isNaN(value)) continue
    const at = breakIndex(breaks.pos, (k - 1) * bp)
    contacts[at] += value
    cells[at] += count / share
    total += value
  }
  if (!(total > 0)) {
    return { x: new Float64Array(0), y: new Float64Array(0), n: new Float64Array(0) }
  }

  const xs: number[] = []
  const ys: number[] = []
  const ns: number[] = []
  for (let i = 0; i < bins; i++) {
    if (cells[i] <= 0) continue
    xs.push(breaks.pos[i])
    ys.push(contacts[i] / total / breaks.width[i])
    ns.push(cells[i])
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: Float64Array.from(ns) }
}
