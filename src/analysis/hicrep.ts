/**
 * How much two contact maps agree — HiCRep's stratum-adjusted correlation.
 *
 * The number this app could not produce, and the only one in §18 whose unit is a
 * **pair of files**. Everything else in the catalogue describes one map; a deck
 * puts several side by side, locks their navigation, blends two in one square
 * and overlays their curves — and every one of those answers *do these look
 * alike* with a picture. The first question anybody asks of two Hi-C libraries
 * is how reproducible they are, and a picture is not an answer to it.
 *
 * ## Why not Pearson on the matrices
 *
 * Because it is dominated by the distance decay both maps share. Two entirely
 * unrelated Hi-C matrices of the same assembly correlate at about 0.9 on their
 * raw cells, for the same reason two unrelated photographs of the sky correlate:
 * almost all of the variance is in one shared gradient. Every cell near the
 * diagonal is large in both, every distant cell is small in both, and whatever
 * is *specific* to either map is a rounding error on top of that.
 *
 * ## What HiCRep does instead (Yang et al. 2017)
 *
 * Two steps, and the first is as important as the second.
 *
 * 1. **Smooth**, with a 2D mean filter of half-width `h`. A single-cell-sized
 *    view of a sparse matrix is mostly Poisson noise, and correlating noise with
 *    noise measures depth rather than structure. The filter is what makes two
 *    shallow replicates agree as well as two deep ones do.
 * 2. **Stratify by distance, then pool.** The correlation is computed
 *    *separately* on each diagonal — where the shared decay is a constant and
 *    therefore contributes no variance at all — and the per-diagonal
 *    coefficients are combined by the Cochran–Mantel–Haenszel weighting,
 *    `N_k √(var₁ₖ · var₂ₖ)`. That weight is what stops a distant stratum with
 *    four non-zero cells from counting as much as the near ones, and it is the
 *    whole reason the pooled number behaves like a correlation rather than like
 *    an average of noise.
 *
 * ## Where this departs from the reference, and why it is said out loud
 *
 * The reference implementations (`hicrep` in R, `hicreppy`) are defined over
 * dense matrices of **raw counts**, which have no missing cells. This app reads
 * balanced maps as often as raw ones, and a balanced map has genuine `NaN`s
 * wherever the balancer dropped a bin. Two decisions follow and neither is
 * silent:
 *
 * - the smoothing window is a mean over the cells that **have** values rather
 *   than over the window's full area, which is identical to the reference
 *   wherever nothing is missing and is the only reading that does not pull every
 *   value near a gap towards zero;
 * - a stratum's correlation is over the positions where **both** maps have a
 *   value, so a bin one map dropped removes that position from the comparison
 *   rather than from one side of it.
 *
 * Neither changes the answer on the files the reference was defined for.
 */

import { pearson } from './stats'

/** One map's smoothed diagonals for one sequence; `[k]` is the `k`-th. */
export type Strata = Array<Float64Array>

/** What one stratum contributed to the pooled number. */
export interface StratumResult {
  /** Diagonal offset, in bins. */
  k: number
  /** Positions where both maps had a value. */
  n: number
  /** Pearson's r on this diagonal. */
  r: number
  /** The Cochran–Mantel–Haenszel weight, `n √(var₁ var₂)`. */
  weight: number
}

export interface SccResult {
  /** The pooled coefficient, or `NaN` where no stratum could be compared. */
  scc: number
  strata: StratumResult[]
}

/**
 * The stratum-adjusted correlation between two maps' smoothed diagonals.
 *
 * `a` and `b` must be the same sequence at the same bin size — which the caller
 * establishes, because *the same sequence* is a question about two files' naming
 * (§5.9) and not one this arithmetic can ask.
 */
export function stratumAdjusted(a: Strata, b: Strata): SccResult {
  const strata: StratumResult[] = []
  const upTo = Math.min(a.length, b.length)
  let weighted = 0
  let weights = 0

  for (let k = 0; k < upTo; k++) {
    const x = a[k]
    const y = b[k]
    const paired = completePairs(x, y)
    if (paired === null) continue
    const r = pearson(paired.x, paired.y)
    if (!Number.isFinite(r)) continue
    // The variances of the **completed** pairs, not of each vector whole: the
    // weight and the coefficient have to be about the same sample, or a stratum
    // where one map is mostly missing is weighted by variance it did not
    // contribute a correlation from.
    const weight = paired.n * Math.sqrt(varianceOf(paired.x) * varianceOf(paired.y))
    if (!Number.isFinite(weight) || weight <= 0) {
      strata.push({ k, n: paired.n, r, weight: 0 })
      continue
    }
    strata.push({ k, n: paired.n, r, weight })
    weighted += weight * r
    weights += weight
  }

  return { scc: weights > 0 ? weighted / weights : Number.NaN, strata }
}

/** The positions where both have a value, or `null` where there are too few. */
function completePairs(
  x: Float64Array,
  y: Float64Array,
): { x: Float64Array; y: Float64Array; n: number } | null {
  const length = Math.min(x.length, y.length)
  let kept = 0
  for (let i = 0; i < length; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) kept++
  }
  // Two points always correlate perfectly and say nothing; a stratum this thin
  // is left out of the pooling rather than contributing an r of one.
  if (kept < 3) return null
  const outX = new Float64Array(kept)
  const outY = new Float64Array(kept)
  let at = 0
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    outX[at] = x[i]
    outY[at] = y[i]
    at++
  }
  return { x: outX, y: outY, n: kept }
}

/** Population variance, which is what the CMH weight is defined over. */
function varianceOf(values: Float64Array): number {
  const n = values.length
  if (n === 0) return Number.NaN
  let total = 0
  for (let i = 0; i < n; i++) total += values[i]
  const mean = total / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (values[i] - mean) ** 2
  return ss / n
}

/**
 * Smooth one tile and read the diagonals its own rows own.
 *
 * A **summed-area table** rather than a window walked per cell: the filter is a
 * mean over `(2h+1)²` cells, and walking it costs that many operations per cell
 * where a prefix sum costs four. On a chromosome at a fine resolution with `h`
 * of five that is a factor of a hundred and twenty, which is the difference
 * between a task that runs and one that is abandoned.
 *
 * Two tables rather than one, because the values are NaN-aware: one over the
 * finite values and one over the count of them, so the window's mean is over
 * what was there.
 *
 * `into[k][i]` receives the smoothed value at `(i, i + k)` in the **sequence's**
 * own coordinates, for every `i` the tile owns.
 */
export function smoothTileInto(
  tile: { values: Float32Array; size: number; from: number; ownFrom: number; ownTo: number },
  h: number,
  maxK: number,
  into: Strata,
): void {
  const size = tile.size
  const stride = size + 1
  const sums = new Float64Array(stride * stride)
  const counts = new Float64Array(stride * stride)

  for (let r = 0; r < size; r++) {
    const row = r * size
    const above = r * stride
    const here = (r + 1) * stride
    for (let c = 0; c < size; c++) {
      const value = tile.values[row + c]
      const finite = Number.isFinite(value)
      sums[here + c + 1] =
        (finite ? value : 0) + sums[here + c] + sums[above + c + 1] - sums[above + c]
      counts[here + c + 1] =
        (finite ? 1 : 0) + counts[here + c] + counts[above + c + 1] - counts[above + c]
    }
  }

  const box = (r0: number, c0: number, r1: number, c1: number, table: Float64Array): number =>
    table[(r1 + 1) * stride + c1 + 1] -
    table[r0 * stride + c1 + 1] -
    table[(r1 + 1) * stride + c0] +
    table[r0 * stride + c0]

  for (let own = tile.ownFrom; own < tile.ownTo; own++) {
    // Local to the tile's square, which starts at `tile.from` in the sequence.
    const r = own - tile.from
    for (let k = 0; k < into.length && k <= maxK; k++) {
      const c = r + k
      if (c >= size) break
      const r0 = Math.max(0, r - h)
      const r1 = Math.min(size - 1, r + h)
      const c0 = Math.max(0, c - h)
      const c1 = Math.min(size - 1, c + h)
      const seen = box(r0, c0, r1, c1, counts)
      // A window with nothing in it is `NaN` rather than zero: an absent pixel
      // is a measured zero and a dropped bin is not, and the whole window being
      // dropped means this position says nothing about either map.
      into[k][own] = seen > 0 ? box(r0, c0, r1, c1, sums) / seen : Number.NaN
    }
  }
}

/** Strata arrays for a sequence of `bins` bins, up to `maxK`, filled with NaN. */
export function emptyStrata(bins: number, maxK: number): Strata {
  const out: Strata = []
  for (let k = 0; k <= maxK; k++) out.push(new Float64Array(bins).fill(Number.NaN))
  return out
}
