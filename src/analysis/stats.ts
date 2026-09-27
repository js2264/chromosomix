/**
 * The descriptive statistics every analysis task ends in, with one rule.
 *
 * The rule is the one this whole codebase keeps: **`NaN` means *no value here***
 * — a bin the balancer dropped (§6.4), a feature that fell off the end of a
 * contig, a window with no reads under it. It is skipped, it never enters a
 * total, and it is never quietly read as zero. `analysis/viewpoint.ts` makes the
 * same point about band sums and gives the same reason: turning "this row was
 * filtered" into "this row touches nothing" is not a rounding error, it is the
 * opposite claim, and it is the claim that ends up in the figure.
 *
 * Two consequences run through everything below.
 *
 * The first is that **every function here also has to say when it has nothing to
 * say.** A mean of no observations is `NaN`, an extent of no observations is
 * `null`, a correlation over two surviving pairs is `NaN`. Returning `0` for any
 * of these is the failure §18.8's compartment phasing is most exposed to: an
 * eigenvector phased against a track that does not overlap it would, with a
 * zero, be phased by whichever way the floating point fell, and the sign of a
 * compartment call is the entire result.
 *
 * The second is that **totals accumulate in `Float64Array` even when the input
 * is `Float32Array`.** `analysis/viewpoint.ts`'s `bandSums` says why that is not
 * fussiness: a sum over a thousand rows of a deep map runs past what float32
 * adds without drift, and the drift arrives as a curve whose peaks are a few per
 * cent short — plausible, and wrong.
 */

// ---------------------------------------------------------------------------
// Centre and spread
// ---------------------------------------------------------------------------

/** The mean of the values that are not `NaN`; `NaN` when none are. */
export function nanMean(values: ArrayLike<number>): number {
  let total = 0
  let seen = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isNaN(value)) continue
    total += value
    seen++
  }
  return seen === 0 ? Number.NaN : total / seen
}

/**
 * The median of the values that are not `NaN`; `NaN` when none are.
 *
 * The even case averages the two middle order statistics rather than taking the
 * lower, so that the median of a two-element sample is between its elements
 * where a reader would put it.
 */
export function nanMedian(values: ArrayLike<number>): number {
  const sorted = sortedFinite(values)
  return quantileOfSorted(sorted, 0.5)
}

/**
 * The mean after discarding `trim` of the observations from **each** end.
 *
 * `trim` is a fraction per tail, not a total: `0.1` drops the lowest tenth and
 * the highest tenth and averages the middle four fifths. That is the convention
 * `scipy.stats.trim_mean` and R's `mean(x, trim=)` both use, and agreeing with
 * the tools a reader will check against is worth more than any argument for the
 * other reading.
 *
 * The count dropped per tail is `floor(n * trim)`, so a small sample keeps
 * everything until the trim is large enough to have earned a whole observation.
 * Trimming everything falls back to the median rather than to `NaN`: the caller
 * asked for a robust centre, and a robust centre is exactly what is left.
 */
export function nanTrimmedMean(values: ArrayLike<number>, trim: number): number {
  const sorted = sortedFinite(values)
  const n = sorted.length
  if (n === 0) return Number.NaN
  const fraction = Number.isFinite(trim) ? Math.min(0.5, Math.max(0, trim)) : 0
  const cut = Math.floor(n * fraction)
  if (n - 2 * cut <= 0) return quantileOfSorted(sorted, 0.5)
  let total = 0
  for (let i = cut; i < n - cut; i++) total += sorted[i]
  return total / (n - 2 * cut)
}

/**
 * The smallest and largest value that is not `NaN`, or `null` when there is no
 * such value.
 *
 * `null` rather than `{ min: Infinity, max: -Infinity }` because the caller of
 * an extent is choosing an axis or a colour scale, and an infinite range and an
 * empty one need different pictures: one is a bug, the other is a window with no
 * data in it, which is an ordinary thing for a map to be showing.
 */
export function nanExtent(values: ArrayLike<number>): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let seen = false
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isNaN(value)) continue
    seen = true
    if (value < min) min = value
    if (value > max) max = value
  }
  return seen ? { min, max } : null
}

// ---------------------------------------------------------------------------
// numpy's own order of addition
// ---------------------------------------------------------------------------

/**
 * `numpy.add.reduce` over `values[from, from + n)`, added in **numpy's order**.
 *
 * For the ports (§18.9) and nothing else. A port is held to its reference's own
 * output, and where the reference makes a decision on a sum — a convergence test
 * on a log-likelihood, a tie between two means — a sum taken in another order is
 * a different number in the last place and, now and then, a different decision.
 * numpy does not add left to right: a contiguous float64 reduction is a
 * **pairwise** sum, eight running accumulators over blocks of at most 128, and
 * the halves of a longer run split at a multiple of eight
 * (`loops_utils.h.src`, `pairwise_sum`). This is that function, line for line,
 * so `np.sum` and `np.mean` in yapc and IDR are the same sums here.
 *
 * `NaN` is not skipped: numpy's `sum` does not skip it either, and the callers
 * never hand it one.
 */
export function numpySum(values: ArrayLike<number>, from = 0, n = values.length - from): number {
  if (n < 8) {
    let total = 0
    for (let i = 0; i < n; i++) total += values[from + i]
    return total
  }
  if (n <= 128) {
    let r0 = values[from]
    let r1 = values[from + 1]
    let r2 = values[from + 2]
    let r3 = values[from + 3]
    let r4 = values[from + 4]
    let r5 = values[from + 5]
    let r6 = values[from + 6]
    let r7 = values[from + 7]
    let i = 8
    for (; i < n - (n % 8); i += 8) {
      const at = from + i
      r0 += values[at]
      r1 += values[at + 1]
      r2 += values[at + 2]
      r3 += values[at + 3]
      r4 += values[at + 4]
      r5 += values[at + 5]
      r6 += values[at + 6]
      r7 += values[at + 7]
    }
    let total = r0 + r1 + (r2 + r3) + (r4 + r5 + (r6 + r7))
    for (; i < n; i++) total += values[from + i]
    return total
  }
  let half = Math.floor(n / 2)
  half -= half % 8
  return numpySum(values, from, half) + numpySum(values, from + half, n - half)
}

/** `numpy.mean` of `values[from, from + n)`: {@link numpySum} over the count. */
export function numpyMean(values: ArrayLike<number>, from = 0, n = values.length - from): number {
  return numpySum(values, from, n) / n
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * The fewest surviving pairs a correlation is reported for.
 *
 * Two points lie on a line, so `r` over two pairs is ±1 whatever the data says
 * — a perfect correlation reported from no evidence at all. Three is the
 * smallest number for which the coefficient is a statement about the data rather
 * than about the geometry of two points.
 */
export const MIN_PAIRS = 3

/**
 * Pearson's *r* over the pairs where **both** sides have a value.
 *
 * **Pairwise-complete, and that is the contract.** A pair where either side is
 * `NaN` is dropped whole, and if fewer than {@link MIN_PAIRS} survive the answer
 * is `NaN` rather than `0`. The zero is the dangerous one: §18.8's compartment
 * phasing decides the *sign* of an eigenvector from the correlation with a gene
 * density track, and a track that does not overlap the contig would, with a
 * zero, still nudge the comparison one way or the other and phase an
 * unphaseable eigenvector silently. `NaN` propagates into the note the drawer
 * shows instead, which is the honest outcome — *phasing was ambiguous*.
 *
 * Computed in two passes: the means first, then the centred sums. The one-pass
 * form built from `Σx`, `Σx²` and `Σxy` is algebraically the same and loses most
 * of its significant digits when the mean is large next to the spread, which is
 * exactly the shape of an observed/expected row centred on one.
 *
 * A constant input has zero variance and no correlation with anything, so it too
 * answers `NaN` rather than dividing by zero.
 */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let seen = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    sumA += x
    sumB += y
    seen++
  }
  if (seen < MIN_PAIRS) return Number.NaN
  const meanA = sumA / seen
  const meanB = sumB / seen

  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    const dx = x - meanA
    const dy = y - meanB
    cov += dx * dy
    varA += dx * dx
    varB += dy * dy
  }
  if (varA <= 0 || varB <= 0) return Number.NaN
  return cov / Math.sqrt(varA * varB)
}

/**
 * Spearman's *ρ*: Pearson's *r* on the ranks.
 *
 * The pairs are completed **before** ranking, not after. Ranking each vector
 * whole and then dropping the incomplete pairs would rank each side against
 * observations its partner never saw, so the two rank vectors would not be
 * rankings of the same sample — a bias that grows with the amount of missing
 * data and always in the same direction, which makes it invisible in a spot
 * check.
 *
 * Ties get average ranks (see {@link ranks}), which is what makes this the
 * coefficient to reach for on a track full of zeros: a bigWig over a genome is
 * mostly ties, and a rank scheme that broke them by index would correlate the
 * two files' bin orders rather than their signals.
 */
export function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let seen = 0
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(a[i]) && !Number.isNaN(b[i])) seen++
  }
  if (seen < MIN_PAIRS) return Number.NaN
  const left = new Float64Array(seen)
  const right = new Float64Array(seen)
  let at = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    left[at] = x
    right[at] = y
    at++
  }
  return pearson(ranks(left), ranks(right))
}

/**
 * One-based ranks, averaged within ties, with `NaN` left where it was.
 *
 * Keeping `NaN` in place rather than compacting means the result lines up with
 * the input index for index, so a caller can rank a whole track and then use the
 * ranks anywhere the track's own bins are used. Ranks are over the values that
 * exist, so a vector with two holes in it is ranked one to *n − 2*.
 *
 * The average-rank rule is the one every implementation a reader will check
 * against uses, and it is also the only one under which the sum of the ranks is
 * fixed — which is what keeps Spearman's ρ bounded by one when a third of the
 * bins are equal.
 */
export function ranks(values: ArrayLike<number>): Float64Array {
  const n = values.length
  const out = new Float64Array(n)
  const order: number[] = []
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(values[i])) out[i] = Number.NaN
    else order.push(i)
  }
  order.sort((i, j) => values[i] - values[j])

  let start = 0
  while (start < order.length) {
    let end = start + 1
    while (end < order.length && values[order[end]] === values[order[start]]) end++
    // The mean of the one-based positions this tied run occupies.
    const rank = (start + end + 1) / 2
    for (let k = start; k < end; k++) out[order[k]] = rank
    start = end
  }
  return out
}

// ---------------------------------------------------------------------------
// Binning
// ---------------------------------------------------------------------------

/**
 * `k + 1` edges cutting the values into `k` groups of equal population.
 *
 * The saddle's strata (§18.8) and the aggregation tasks' quantile bands are both
 * this: the reader asks for five groups, and what they mean is five groups with
 * the same number of features in them, not five equal slices of the value range.
 * The two coincide only for a uniform distribution, and no genomic score is
 * uniform.
 *
 * Edges come from the data's own order statistics with linear interpolation
 * between them — the definition `numpy.quantile` uses by default, so a reader
 * checking a saddle against a notebook gets the same cut points. The first and
 * last edge are the extremes, so nothing falls outside.
 *
 * Heavily tied data can produce two equal edges, and that is reported rather
 * than repaired: an empty stratum in the middle of a saddle is a true statement
 * about a track that is forty per cent zeros, and nudging the edge apart would
 * hide it. `NaN` values take part in nothing. No values at all gives an empty
 * array, since there is no honest edge to invent.
 */
export function quantileEdges(values: ArrayLike<number>, k: number): Float64Array {
  const groups = Math.max(1, Math.trunc(k))
  const sorted = sortedFinite(values)
  if (sorted.length === 0) return new Float64Array(0)
  const out = new Float64Array(groups + 1)
  for (let i = 0; i <= groups; i++) out[i] = quantileOfSorted(sorted, i / groups)
  return out
}

/**
 * The fewest resamples a column's interval is reported from.
 *
 * A percentile taken from one or two draws is the draw itself, drawn as a band
 * of zero width — the picture of a very confident answer, from a column almost
 * all of whose observations were missing.
 */
const MIN_DRAWS = 3

/** The most edges {@link logSpacedEdges} will produce before it stops. */
const MAX_LOG_EDGES = 1 << 14

/**
 * Geometric edges from `from`, each `factor` times the last, covering `to`.
 *
 * The natural axis for a P(s) curve (§18.8): separations span five orders of
 * magnitude, the interesting structure is spread evenly across the logarithm of
 * them, and linear bins would put nine tenths of the bins in the last decade
 * where nothing happens.
 *
 * **Strictly increasing, always.** Multiplying a positive double by a factor
 * above one always yields a larger double, so the sequence cannot repeat a
 * value — but only if `factor` is genuinely above one, and a factor of exactly
 * `1` arriving from a form, a stored session or an off-by-one default would
 * otherwise loop forever emitting the same edge. It is clamped, and the count is
 * capped at {@link MAX_LOG_EDGES}, because a worker that hangs is worse than a
 * curve that is coarser than asked for.
 *
 * The last edge is at or beyond `to`, so the whole range is inside a bin. A
 * range that is not a positive interval has no geometric edges at all and gives
 * an empty array — geometric spacing is undefined at and below zero, and the
 * caller's job is to decide what its own floor is rather than to have one
 * chosen here.
 */
export function logSpacedEdges(from: number, to: number, factor: number): Float64Array {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from) {
    return new Float64Array(0)
  }
  const step = Number.isFinite(factor) && factor > 1 ? factor : 1 + 1e-6
  const edges: number[] = [from]
  let edge = from
  while (edge < to && edges.length < MAX_LOG_EDGES) {
    edge *= step
    edges.push(edge)
  }
  return Float64Array.from(edges)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * A mean profile and a resampling interval around it.
 *
 * `rows` are the observations — features, windows, loops — and `cols` are the
 * positions along the profile they are aggregated over. `at(row, col)` reads one
 * cell, so a caller can hand this a per-feature matrix it never materialised.
 *
 * **The interval is a percentile bootstrap, not a standard error.** A metaplot's
 * per-position values are neither normal nor symmetric: a few hundred features
 * whose signal spans three orders of magnitude give a distribution with a long
 * right tail, and *mean ± 1.96 SEM* on that produces a lower bound below zero
 * for a quantity that cannot be negative, and a band whose two sides are equal
 * when the data's are not. Resampling the rows makes no distributional claim at
 * all, and the price is arithmetic — which this being a worker (§18.3) is
 * exactly what buys.
 *
 * **Rows are resampled, never cells.** The features are the independent
 * observations; the columns within one feature are a single curve and are
 * carried together, or the band would describe the smoothness of the profile
 * instead of the agreement between features.
 *
 * The band is only as reproducible as `rng` is, which is why the caller passes
 * one from `analysis/random.ts` and the seed rides along in the provenance
 * (§18.4).
 */
export function bootstrapBand(options: {
  rows: number
  cols: number
  at(row: number, col: number): number
  iterations: number
  level: number
  rng(): number
}): { mean: Float64Array; low: Float64Array; high: Float64Array } {
  const rows = Math.max(0, Math.trunc(options.rows))
  const cols = Math.max(0, Math.trunc(options.cols))
  const iterations = Math.max(0, Math.trunc(options.iterations))
  const level = Number.isFinite(options.level) ? Math.min(0.9999, Math.max(0, options.level)) : 0.95

  const mean = new Float64Array(cols)
  const low = new Float64Array(cols)
  const high = new Float64Array(cols)
  mean.fill(Number.NaN)
  low.fill(Number.NaN)
  high.fill(Number.NaN)
  if (rows === 0 || cols === 0) return { mean, low, high }

  // `at` is read `rows * cols * (iterations + 1)` times otherwise, and for a
  // thousand iterations that is a hundred million calls through a closure that
  // is usually indexing a typed array anyway. Cached once as `Float32Array`,
  // which is the precision the values arrive in throughout this app and half the
  // footprint of the alternative on a fifty-thousand-feature heatmap; every sum
  // taken from it is still accumulated in double.
  const cells = new Float32Array(rows * cols)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) cells[row * cols + col] = options.at(row, col)
  }

  columnMeans(cells, rows, cols, null, mean)
  if (iterations === 0) return { mean, low, high }

  // One draw's worth of per-column means, per iteration, kept column-major so
  // the percentile pass over a column is a contiguous read.
  const draws = new Float64Array(iterations * cols)
  const pick = new Int32Array(rows)
  const scratch = new Float64Array(cols)
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let row = 0; row < rows; row++) {
      pick[row] = Math.min(rows - 1, Math.floor(options.rng() * rows))
    }
    columnMeans(cells, rows, cols, pick, scratch)
    for (let col = 0; col < cols; col++) draws[col * iterations + iteration] = scratch[col]
  }

  const alpha = (1 - level) / 2
  const sample = new Float64Array(iterations)
  for (let col = 0; col < cols; col++) {
    let kept = 0
    for (let iteration = 0; iteration < iterations; iteration++) {
      const value = draws[col * iterations + iteration]
      if (Number.isNaN(value)) continue
      sample[kept] = value
      kept++
    }
    // A column every one of whose rows can be missing produces resamples with no
    // mean at all; a band drawn from a handful of survivors would be narrower
    // than the truth, so it is reported as absent instead.
    if (kept < MIN_DRAWS) continue
    const sorted = sample.subarray(0, kept)
    sorted.sort()
    low[col] = quantileOfSorted(sorted, alpha)
    high[col] = quantileOfSorted(sorted, 1 - alpha)
  }
  return { mean, low, high }
}

/**
 * Per-column `NaN`-skipping means of `cells`, over `pick`'s rows or over all of
 * them when `pick` is `null`. Written into `out`, which the caller reuses.
 */
function columnMeans(
  cells: Float32Array,
  rows: number,
  cols: number,
  pick: Int32Array | null,
  out: Float64Array,
): void {
  const totals = new Float64Array(cols)
  const seen = new Int32Array(cols)
  for (let i = 0; i < rows; i++) {
    const base = (pick === null ? i : pick[i]) * cols
    for (let col = 0; col < cols; col++) {
      const value = cells[base + col]
      if (Number.isNaN(value)) continue
      totals[col] += value
      seen[col]++
    }
  }
  for (let col = 0; col < cols; col++) {
    out[col] = seen[col] === 0 ? Number.NaN : totals[col] / seen[col]
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The non-`NaN` values, ascending. */
function sortedFinite(values: ArrayLike<number>): Float64Array {
  let seen = 0
  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) seen++
  }
  const out = new Float64Array(seen)
  let at = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isNaN(value)) continue
    out[at] = value
    at++
  }
  // The typed array's own sort is numeric; `Array.prototype.sort`'s default is
  // lexicographic, which is the bug this line exists to not be.
  out.sort()
  return out
}

/**
 * The `p`-quantile of an already-sorted sample, interpolating linearly between
 * the two order statistics it falls between — `numpy.quantile`'s default, so a
 * saddle's cut points match the notebook a reader checks them in.
 */
function quantileOfSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  if (n === 1) return sorted[0]
  const position = Math.min(1, Math.max(0, p)) * (n - 1)
  const lower = Math.floor(position)
  const upper = Math.min(n - 1, lower + 1)
  const fraction = position - lower
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower])
}
