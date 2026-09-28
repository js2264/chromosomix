/**
 * Diamond insulation, and the boundaries its minima call — cooltools', exactly.
 *
 * The arithmetic a reader can do by eye and cannot do accurately, which is the
 * same sentence `analysis/viewpoint.ts` opens with and the same reason both exist:
 * slide a square window along the diagonal, and at every bin ask how much
 * contact crosses it. Where a domain boundary sits, very little does.
 *
 * **The definition is `cooltools.insulation`'s, to the pixel**, because an
 * insulation score is compared with cooltools' more than with anything else and
 * a second definition under the same name is a difference a reader finds in a
 * figure rather than in a changelog. The golden holds this file to cooltools'
 * own table — score, cells counted and boundary strength, bin for bin
 * (`scripts/make_analysis_golden.py`). Three things here are load-bearing, and
 * each is a place a reimplementation goes quietly wrong.
 *
 * **The diamond never crosses a contig boundary.** It is a window over *one*
 * sequence — cooltools' region — and a window straddling the join between
 * `chrIV` and `chrV` averages contacts between two chromosomes and reports the
 * answer as a property of a position, which on a metagenome, where the join is
 * between two organisms, is not a subtle error. Every function here works within
 * one contig's square and the caller supplies them one at a time.
 *
 * **The score is a mean, not a sum.** The window at bin `k` is the square of
 * rows `(k − w, k]` against columns `[k, k + w)` — its corner is the diagonal
 * pixel `(k, k)` — less the cells nearer the diagonal than `ignoreDiags`, and
 * the score is the mean of the cells in it that carry a value. A mean is what
 * lets a window lose cells without reading as insulation: one that runs off the
 * end of the sequence, or over a row the balancer dropped (§6.4), averages what
 * it has, where a sum of fewer cells is a smaller number that looks exactly like
 * a boundary. So every bin with a cell to average is scored, the two ends of a
 * sequence included.
 *
 * **It is a log2 ratio against the sequence's median.** A raw mean falls with
 * depth and with distance from the centromere, so dividing by one number per
 * sequence is what makes two chromosomes comparable and what makes zero read as
 * *typical*. The median rather than the mean because it is cooltools', and
 * because the scores being looked for are the tail.
 */

import type { SeparationBand } from './band'

/** A dense on-diagonal square for one sequence, row-major. */
export interface ContigSquare {
  /** Bins on a side. */
  size: number
  values: Float32Array
}

export interface DiamondOptions {
  /** Side of the diamond, in bins: cooltools' `window_bp` over the bin size. */
  window: number
  /**
   * Diagonals to leave out, cooltools' `ignore_diags`: a cell counts when its
   * separation `col − row` is at least this.
   *
   * `0` counts every cell, the diagonal pixel at the diamond's corner included;
   * `2`, the default, drops that pixel and the two beside it — the cells where
   * self-ligation and unligated fragments land. Those are the largest in the
   * matrix, so at a small window the corner can be most of the mean, and a track
   * carried by it is a picture of how deep the near-diagonal is rather than of
   * what crosses the bin.
   */
  ignoreDiags?: number
}

/**
 * Cells of a whole diamond that `ignoreDiags` leaves countable.
 *
 * The diamond is `window × window` cells at separations `0 … 2w − 2`: `d + 1`
 * of them at separation `d` up to `w − 1`, and `2w − 1 − d` past it. Counted
 * rather than solved for — `w²` additions once per call. At `ignoreDiags` of
 * `2w − 1` or more nothing is left, **a window being only as wide as its widest
 * separation**, and the runner says so rather than drawing a lane of gaps.
 */
export function diamondCells(window: number, ignoreDiags: number): number {
  const w = Math.max(1, Math.trunc(window))
  const ignore = Math.max(0, Math.trunc(ignoreDiags))
  let cells = 0
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < w; b++) if (a + b >= ignore) cells++
  }
  return cells
}

/**
 * Per bin, what its diamond holds: the sum of the cells with a value, and how
 * many there were. cooltools' `sum_balanced` and `n_valid_pixels`.
 *
 * Kept as the two numbers rather than as their ratio for one reason: the count
 * is what boundary calling filters on — a fraction of the *fullest* diamond on
 * any sequence of the run ({@link insulationBoundaries}) — and a ratio has
 * forgotten it.
 */
export interface DiamondTotals {
  sums: Float64Array
  counts: Float64Array
}

/**
 * The diamond at every bin of one contig, read from its dense square.
 *
 * A cell counts when it lies inside the sequence, off the ignored diagonals, and
 * carries a value: a cell of a row the balancer dropped is `NaN` in a balanced
 * square and is not counted, which is cooltools' valid-pixel mask. A contact
 * that simply did not occur is a zero and is counted, as cooltools counts it.
 *
 * Accumulated in `Float64Array`, for `analysis/viewpoint.ts`'s reason: a sum
 * over a large window of a deep map runs past what float32 adds without drift.
 */
export function diamondTotals(square: ContigSquare, options: DiamondOptions): DiamondTotals {
  const { size, values } = square
  const w = Math.max(1, Math.trunc(options.window))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const sums = new Float64Array(size)
  const counts = new Float64Array(size)
  for (let k = 0; k < size; k++) {
    let total = 0
    let seen = 0
    // `a` rows up from the corner and `b` columns along it: the cell
    // `(k − a, k + b)`, at separation `a + b`.
    for (let a = 0; a < w && k - a >= 0; a++) {
      const base = (k - a) * size
      for (let b = Math.max(0, ignore - a); b < w && k + b < size; b++) {
        const value = values[base + k + b]
        if (Number.isNaN(value)) continue
        total += value
        seen++
      }
    }
    sums[k] = total
    counts[k] = seen
  }
  return { sums, counts }
}

/**
 * The same diamond, read from a band rather than from a square — for a sequence
 * that joins its own ends (SPECS §8.15).
 *
 * Every cell of the diamond at bin `k` is at a separation between `0` and
 * `2w − 2`, so **it is a band already**: the cell `(k − a, k + b)` is `a + b`
 * along from row `k − a`. On a circular band that row wraps and every bin has a
 * whole diamond, including the ones at the junction; on a linear one `forward`
 * answers `NaN` past either end and the ends average what they hold, exactly as
 * {@link diamondTotals} gives them — `analysis-insulation.test.ts` asserts the
 * two agree on a linear band, which is what makes a second implementation safe
 * rather than a second answer.
 */
export function diamondTotalsBanded(band: SeparationBand, options: DiamondOptions): DiamondTotals {
  const n = band.n
  const w = Math.max(1, Math.trunc(options.window))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const sums = new Float64Array(n)
  const counts = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let total = 0
    let seen = 0
    for (let a = 0; a < w; a++) {
      for (let b = Math.max(0, ignore - a); b < w; b++) {
        const value = band.forward(k - a, a + b)
        if (!Number.isFinite(value)) continue
        total += value
        seen++
      }
    }
    sums[k] = total
    counts[k] = seen
  }
  return { sums, counts }
}

/**
 * The totals as cooltools' `log2_insulation_score`.
 *
 * The mean of each diamond, divided by the median of those means over the
 * sequence, in log2. A diamond with no cell to average is `NaN`; one whose mean
 * is exactly zero is `NaN` too rather than minus infinity — a bin with no contact
 * across it is one the data cannot place a boundary at, an infinite trough would
 * take the lane's value axis with it, and it could not be written to a bigWig
 * at all (§18.7). The zeros still count towards the median, as cooltools counts
 * them.
 */
export function insulationScore(totals: DiamondTotals): Float64Array {
  const n = totals.sums.length
  const means = new Float64Array(n).fill(Number.NaN)
  const finite: number[] = []
  for (let k = 0; k < n; k++) {
    if (!(totals.counts[k] > 0)) continue
    means[k] = totals.sums[k] / totals.counts[k]
    finite.push(means[k])
  }
  const out = new Float64Array(n).fill(Number.NaN)
  const median = medianOf(finite)
  if (!(median > 0)) return out
  for (let k = 0; k < n; k++) {
    const value = Math.log2(means[k] / median)
    if (Number.isFinite(value)) out[k] = value
  }
  return out
}

/** numpy's median: the middle value, or the mean of the two middle values. */
function medianOf(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = Float64Array.from(values).sort()
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** One called boundary, in bins local to its contig. */
export interface Boundary {
  bin: number
  /** The score at the minimum; negative is insulated. */
  score: number
  /** How far the track has to climb on both sides to escape this minimum. */
  prominence: number
}

export interface BoundaryOptions {
  /** Minimum prominence, in the score's own log2 units. */
  prominence: number
  /** Minimum gap between two calls, in bins. */
  spacing: number
}

/**
 * The local maxima of an array and the prominence of each —
 * `cooltools.lib.peaks.find_peak_prominence`, line for line.
 *
 * A maximum is a value strictly above both of its nearest neighbours that carry
 * a value, so neither end of the array is one and neither is any bin of a flat
 * top. Its prominence is how far it stands above the lowest point between it and
 * the nearest strictly higher value, on whichever side that is lower, which is
 * the topographic definition. The highest maximum, with nothing higher on either
 * side, is measured against the lowest local minimum of the whole array; where
 * two maxima share that height only the first is, and the second has no
 * prominence at all — cooltools' own arithmetic, kept because a boundary set
 * that matched it everywhere but there would not be the same set.
 *
 * Returned in the array's own indices, maxima in order, with `NaN` where a
 * maximum has no prominence.
 */
export function findPeakProminence(arr: ArrayLike<number>): {
  positions: number[]
  prominences: number[]
} {
  const n = arr.length
  const kept: number[] = []
  for (let i = 0; i < n; i++) if (!Number.isNaN(arr[i])) kept.push(i)

  const minima: number[] = []
  const maxima: number[] = []
  for (let k = 1; k < kept.length - 1; k++) {
    const before = arr[kept[k - 1]]
    const here = arr[kept[k]]
    const after = arr[kept[k + 1]]
    if (before > here && here < after) minima.push(kept[k])
    if (before < here && here > after) maxima.push(kept[k])
  }

  const prominences: number[] = []
  const unbounded: boolean[] = []
  for (const pos of maxima) {
    const height = arr[pos]
    let left = -1
    for (let j = pos - 1; j >= 0; j--) {
      if (arr[j] > height) {
        left = j
        break
      }
    }
    let right = -1
    for (let j = pos + 1; j < n; j++) {
      if (arr[j] > height) {
        right = j
        break
      }
    }
    // The left side runs from the higher value up to the maximum, excluding it;
    // the right from the maximum up to the higher value, excluding that. Either
    // way the maximum is compared with everything between.
    const fromLeft = left >= 0 ? height - lowest(arr, left, pos) : Number.NaN
    const fromRight = right >= 0 ? height - lowest(arr, pos, right) : Number.NaN
    prominences.push(nanMin(fromLeft, fromRight))
    unbounded.push(left < 0 && right < 0)
  }

  const top = unbounded.indexOf(true)
  if (top >= 0) {
    const pos = maxima[top]
    let floor = Number.POSITIVE_INFINITY
    for (const i of minima) floor = Math.min(floor, arr[i])
    prominences[top] = arr[pos] - (minima.length > 0 ? floor : lowest(arr, 0, n))
  }
  return { positions: maxima, prominences }
}

/** `np.nanmin(arr[from:to])`: the least value that is not `NaN`, or `NaN`. */
function lowest(arr: ArrayLike<number>, from: number, to: number): number {
  let out = Number.NaN
  for (let i = from; i < to; i++) {
    const value = arr[i]
    if (Number.isNaN(value)) continue
    if (Number.isNaN(out) || value < out) out = value
  }
  return out
}

function nanMin(a: number, b: number): number {
  if (Number.isNaN(a)) return b
  if (Number.isNaN(b)) return a
  return Math.min(a, b)
}

export interface InsulationBoundaryOptions {
  /**
   * The fewest cells a diamond must hold for its bin to take part —
   * `min_frac_valid_pixels` times the most any diamond of the run holds, which
   * is cooltools' rule and is why the caller works it out over every sequence
   * before calling any one of them.
   */
  minCells: number
  /** Boundary strength at or above which a minimum is a boundary, in log2 units. */
  threshold: number
  /** Minimum gap between two calls, in bins; `1` or less keeps them all. */
  spacing: number
}

/**
 * cooltools' boundaries on one sequence: `find_boundaries`, then the threshold.
 *
 * The bins whose diamond holds too few cells are **taken out of the track**, not
 * blanked in it — cooltools' mask — so the minima and their prominences are
 * those of what is left, read end to end. On what remains a boundary is a local
 * minimum of the score whose prominence ({@link findPeakProminence} of the
 * negated track) is at least `threshold`; the prominence is cooltools'
 * `boundary_strength`, and the call is its `is_boundary`.
 *
 * `spacing` is this app's own, and at its default does nothing: where two calls
 * are closer than it the stronger is kept.
 */
export function insulationBoundaries(
  score: Float64Array,
  counts: Float64Array,
  options: InsulationBoundaryOptions,
): Boundary[] {
  const bins: number[] = []
  for (let k = 0; k < score.length; k++) if (counts[k] >= options.minCells) bins.push(k)
  const track = bins.map((k) => -score[k])
  const { positions, prominences } = findPeakProminence(track)

  const found: Boundary[] = []
  for (let i = 0; i < positions.length; i++) {
    const prominence = prominences[i]
    if (!(prominence >= options.threshold)) continue
    const bin = bins[positions[i]]
    found.push({ bin, score: score[bin], prominence })
  }
  return thinned(found, options.spacing)
}

/**
 * Calls closer than `spacing` bins, reduced to the stronger of each such pair.
 *
 * Strongest first, so that where two calls are too close the one that survives
 * is the better one rather than the leftmost; answered in bin order.
 */
function thinned(found: Boundary[], spacing: number): Boundary[] {
  if (spacing <= 1) return [...found].sort((a, b) => a.bin - b.bin)
  const order = [...found].sort((a, b) => b.prominence - a.prominence)
  const kept: Boundary[] = []
  for (const candidate of order) {
    if (kept.some((other) => Math.abs(other.bin - candidate.bin) < spacing)) continue
    kept.push(candidate)
  }
  return kept.sort((a, b) => a.bin - b.bin)
}

/**
 * Local minima of a track, with a prominence each — the directionality index's
 * borders, called on its integrated curve (`analysis/di.ts`). The diamond's own
 * boundaries are cooltools' ({@link insulationBoundaries}).
 *
 * Prominence rather than depth, and the distinction is the whole of why this is
 * not three lines. A score of −1.2 in a quiet region is a boundary; the same
 * −1.2 halfway down the flank of a −3 trough is one boundary reported twice. So
 * each minimum is scored by how far the track must *climb* on both sides before
 * it falls lower than the minimum itself — which is exactly the topographic
 * definition, and which collapses a ragged trough to its floor.
 *
 * A plateau — several equal minima in a row, which a coarse bin size produces
 * often — is reported once, at its first bin, rather than once per bin.
 */
export function callBoundaries(
  score: Float64Array,
  options: BoundaryOptions,
): Boundary[] {
  const found: Boundary[] = []
  const n = score.length

  for (let i = 0; i < n; i++) {
    const value = score[i]
    if (!Number.isFinite(value)) continue
    // A minimum is a bin no higher than its finite neighbours, and strictly
    // lower than at least one of them — which is what excludes a flat run from
    // being n separate minima while still admitting the floor of a plateau.
    const left = previousFinite(score, i)
    const right = nextFinite(score, i)
    const leftValue = left < 0 ? Number.POSITIVE_INFINITY : score[left]
    const rightValue = right < 0 ? Number.POSITIVE_INFINITY : score[right]
    if (value > leftValue || value > rightValue) continue
    if (value === leftValue && value === rightValue) continue
    // The first bin of a plateau, not every bin of it.
    if (value === leftValue) continue

    const prominence = Math.min(climb(score, i, -1), climb(score, i, 1))
    if (!(prominence >= options.prominence)) continue
    found.push({ bin: i, score: value, prominence })
  }

  // Strongest first, then thinned by spacing, so that where two calls are too
  // close the one that survives is the better one rather than the leftmost.
  found.sort((a, b) => b.prominence - a.prominence)
  const kept: Boundary[] = []
  for (const candidate of found) {
    if (kept.some((other) => Math.abs(other.bin - candidate.bin) < options.spacing)) continue
    kept.push(candidate)
  }
  kept.sort((a, b) => a.bin - b.bin)
  return kept
}

/**
 * One domain: the span between two consecutive boundaries, in bins local to its
 * contig, half-open.
 *
 * `from` is the bin the upstream boundary was called at and `to` is the bin the
 * downstream one was called at, so consecutive domains **tile**: one ends where
 * the next begins, and the boundary bin belongs to the domain below it. That is
 * what makes a lane of them read as a segmentation rather than as a row of
 * boxes with gaps, and it is what puts a domain's two corners on the two bins
 * the calls were actually made at — which is what a scaled pileup lines up on.
 */
export interface Domain {
  from: number
  to: number
  /** The weaker of the two boundaries that bound it. */
  strength: number
}

/**
 * The domains between a sequence's boundary calls.
 *
 * **Two boundaries make a domain; one makes nothing, and the ends of the
 * sequence are not domains.** A chromosome with a single call has no interior
 * to report, and running the first domain back to the telomere — or the last one
 * on to it — would assert an edge the data never placed. So what comes back is
 * the gaps *between* calls and nothing else, which on a sequence with `n` calls
 * is `n - 1` domains.
 *
 * The strength is the **weaker** of the two edges, because a domain is only as
 * well defined as its worse-supported side: reporting the stronger would let one
 * good boundary vouch for a run of bad ones, and the score is what a reader
 * ranks and filters the set on.
 *
 * Sorted here rather than assumed. {@link callBoundaries} already answers in bin
 * order, but *consecutive* is the whole of what this computes, and a caller that
 * had sorted by prominence — which is the other order a boundary list comes in —
 * would otherwise get domains between calls that are not neighbours.
 */
export function domainsBetween(boundaries: readonly Boundary[]): Domain[] {
  const order = [...boundaries].sort((a, b) => a.bin - b.bin)
  const out: Domain[] = []
  for (let i = 1; i < order.length; i++) {
    const from = order[i - 1]
    const to = order[i]
    if (to.bin <= from.bin) continue
    out.push({
      from: from.bin,
      to: to.bin,
      strength: Math.min(from.prominence, to.prominence),
    })
  }
  return out
}

/** How far the track climbs from `at` before falling below it again. */
function climb(score: Float64Array, at: number, step: -1 | 1): number {
  const floor = score[at]
  let highest = floor
  for (let i = at + step; i >= 0 && i < score.length; i += step) {
    const value = score[i]
    if (!Number.isFinite(value)) break
    // A lower minimum ends the search: past it, this one is on somebody else's
    // flank and whatever is beyond belongs to them.
    if (value < floor) break
    if (value > highest) highest = value
  }
  return highest - floor
}

function previousFinite(score: Float64Array, from: number): number {
  for (let i = from - 1; i >= 0; i--) if (Number.isFinite(score[i])) return i
  return -1
}

function nextFinite(score: Float64Array, from: number): number {
  for (let i = from + 1; i < score.length; i++) if (Number.isFinite(score[i])) return i
  return -1
}
