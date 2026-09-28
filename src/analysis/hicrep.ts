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
 *    coefficients are pooled with **variance-stabilised weights**: a diagonal's
 *    weight is `n` times the variance of its values' *ranks*, which depends on
 *    nothing but `n`, and is `(n + 1) / 12`. So every diagonal counts by how many
 *    positions it compares. Weighting by the variance of the values themselves —
 *    the Cochran–Mantel–Haenszel weight before the stabilisation — lets the few
 *    diagonals nearest the main one, where the counts are largest and the
 *    correlation highest, carry the whole number, and on raw counts that alone
 *    lifts it by a few tenths.
 *
 * ## Which reference, exactly
 *
 * `hicrep` 0.2.6 (Lin), the Python implementation of the R package, reproduced
 * to its arithmetic — the golden and `notebooks/validation.qmd` hold this file
 * to it. Its details are part of the answer, so they are kept:
 *
 * - the map is its **upper triangle**, with the main diagonal and every diagonal
 *   past the furthest compared set to zero **before** smoothing — so a window
 *   near the diagonal averages in the zeros below it;
 * - the window's mean is over **every cell it covers inside the sequence**,
 *   zeros included — `(h + 1 + min(d, h))` rows by as many columns, `d` being the
 *   distance to the sequence's nearer end;
 * - a diagonal is compared over the positions where **either** map is non-zero,
 *   and one where neither is left out; a diagonal whose values are constant has
 *   no correlation and counts as zero, with its weight.
 *
 * ## Where a balanced map takes it further
 *
 * The reference is defined over raw counts, which have no missing cells; a
 * balanced map has `NaN` wherever the balancer dropped a bin. Such a cell is left
 * out of the window's mean — its sum and its count — and a position whose window
 * is all `NaN` is left out of the comparison. Neither changes a raw map's answer.
 */

/** One map's smoothed diagonals for one sequence; `[k]` is the `k`-th. */
export type Strata = Array<Float64Array>

/** What one stratum contributed to the pooled number. */
export interface StratumResult {
  /** Diagonal offset, in bins. */
  k: number
  /** Positions compared: where either map is non-zero, and both have a value. */
  n: number
  /** Pearson's r on this diagonal; `NaN` where either side is constant. */
  r: number
  /** The variance-stabilised weight, `(n + 1) / 12`. */
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
 *
 * Diagonals `1 … maxK`: the main one is not compared, having been set to zero
 * before the smoothing. A diagonal with fewer than two positions has no weight;
 * one whose correlation is undefined — a constant side — pools as zero with its
 * weight, as the reference pools it.
 */
export function stratumAdjusted(a: Strata, b: Strata): SccResult {
  const strata: StratumResult[] = []
  const upTo = Math.min(a.length, b.length)
  let weighted = 0
  let weights = 0

  for (let k = 1; k < upTo; k++) {
    const paired = comparedPairs(a[k], b[k])
    if (paired === null) continue
    const r = correlation(paired.x, paired.y)
    const weight = (paired.n + 1) / 12
    strata.push({ k, n: paired.n, r, weight })
    weighted += weight * (Number.isFinite(r) ? r : 0)
    weights += weight
  }

  return { scc: weights > 0 ? weighted / weights : Number.NaN, strata }
}

/**
 * The positions a diagonal is compared over: both maps have a value and at least
 * one is non-zero. `null` under two, where the weight is undefined.
 */
function comparedPairs(
  x: Float64Array,
  y: Float64Array,
): { x: Float64Array; y: Float64Array; n: number } | null {
  const length = Math.min(x.length, y.length)
  const keep = (i: number): boolean =>
    Number.isFinite(x[i]) && Number.isFinite(y[i]) && (x[i] !== 0 || y[i] !== 0)
  let kept = 0
  for (let i = 0; i < length; i++) if (keep(i)) kept++
  if (kept < 2) return null
  const outX = new Float64Array(kept)
  const outY = new Float64Array(kept)
  let at = 0
  for (let i = 0; i < length; i++) {
    if (!keep(i)) continue
    outX[at] = x[i]
    outY[at] = y[i]
    at++
  }
  return { x: outX, y: outY, n: kept }
}

/** Pearson's r of two equal-length samples, `NaN` where either is constant. */
function correlation(x: Float64Array, y: Float64Array): number {
  const n = x.length
  let meanX = 0
  let meanY = 0
  for (let i = 0; i < n; i++) {
    meanX += x[i]
    meanY += y[i]
  }
  meanX /= n
  meanY /= n
  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    cov += dx * dy
    varX += dx * dx
    varY += dy * dy
  }
  return cov / Math.sqrt(varX * varY)
}

/**
 * Smooth one tile and read the diagonals its own rows own.
 *
 * The matrix smoothed is the reference's: the tile's **upper triangle** out to
 * `maxK`, the main diagonal, the lower triangle and every diagonal past `maxK`
 * set to zero first. The mean at `(i, j)` is the window's sum over the cells of
 * it that lie inside the sequence and carry a value, divided by how many that
 * is — `(h + 1 + min(dᵢ, h)) · (h + 1 + min(dⱼ, h))` on a map with nothing
 * missing, `d` being the distance to the sequence's nearer end.
 *
 * A **summed-area table** rather than a window walked per cell: the filter is a
 * sum over `(2h+1)²` cells, and walking it costs that many operations per cell
 * where a prefix sum costs four. Three tables — the values, the missing cells and
 * the non-zero ones — and the third is not bookkeeping: a difference of prefix
 * sums leaves a residue in the last places where the window's true sum is zero,
 * and whether a position is compared at all turns on whether it is zero. A window
 * with no non-zero cell is exactly zero.
 *
 * `into[k][i]` receives the smoothed value at `(i, i + k)` in the **sequence's**
 * own coordinates, for every `i` the tile owns and `1 ≤ k ≤ maxK`; `into[0][i]`
 * is left as it was, the main diagonal being set to zero before smoothing.
 */
export function smoothTileInto(
  tile: { values: Float32Array; size: number; from: number; ownFrom: number; ownTo: number },
  h: number,
  maxK: number,
  into: Strata,
): void {
  const size = tile.size
  const bins = into[0].length
  const stride = size + 1
  const sums = new Float64Array(stride * stride)
  const missing = new Float64Array(stride * stride)
  const nonzero = new Float64Array(stride * stride)

  for (let r = 0; r < size; r++) {
    const row = r * size
    const above = r * stride
    const here = (r + 1) * stride
    for (let c = 0; c < size; c++) {
      // Only the band `1 … maxK` above the diagonal; everything else is a zero.
      const inBand = c - r >= 1 && c - r <= maxK
      const value = inBand ? tile.values[row + c] : 0
      const gap = Number.isNaN(value)
      sums[here + c + 1] = (gap ? 0 : value) + sums[here + c] + sums[above + c + 1] - sums[above + c]
      missing[here + c + 1] = (gap ? 1 : 0) + missing[here + c] + missing[above + c + 1] - missing[above + c]
      nonzero[here + c + 1] =
        (!gap && value !== 0 ? 1 : 0) + nonzero[here + c] + nonzero[above + c + 1] - nonzero[above + c]
    }
  }

  const box = (r0: number, c0: number, r1: number, c1: number, table: Float64Array): number =>
    table[(r1 + 1) * stride + c1 + 1] -
    table[r0 * stride + c1 + 1] -
    table[(r1 + 1) * stride + c0] +
    table[r0 * stride + c0]
  // Rows or columns of the window inside the sequence, as the reference counts
  // them from a position's distance to the nearer end.
  const span = (at: number): number => h + 1 + Math.min(Math.min(at, bins - 1 - at), h)

  for (let own = tile.ownFrom; own < tile.ownTo; own++) {
    // Local to the tile's square, which starts at `tile.from` in the sequence.
    const r = own - tile.from
    for (let k = 1; k < into.length && k <= maxK; k++) {
      const c = r + k
      if (c >= size) break
      const r0 = Math.max(0, r - h)
      const r1 = Math.min(size - 1, r + h)
      const c0 = Math.max(0, c - h)
      const c1 = Math.min(size - 1, c + h)
      const cells = span(own) * span(own + k) - box(r0, c0, r1, c1, missing)
      // A window with nothing in it is `NaN` rather than zero: an absent pixel
      // is a measured zero and a dropped bin is not, and the whole window being
      // dropped means this position says nothing about either map.
      if (!(cells > 0)) {
        into[k][own] = Number.NaN
        continue
      }
      into[k][own] = box(r0, c0, r1, c1, nonzero) > 0 ? box(r0, c0, r1, c1, sums) / cells : 0
    }
  }
}

/** Strata arrays for a sequence of `bins` bins, up to `maxK`, filled with NaN. */
export function emptyStrata(bins: number, maxK: number): Strata {
  const out: Strata = []
  for (let k = 0; k <= maxK; k++) out.push(new Float64Array(bins).fill(Number.NaN))
  return out
}
