/**
 * chromosight's pattern detection, as kernels.
 *
 * A port of the algorithm in Matthey-Doret et al., *Computer vision for pattern
 * detection in chromosome contact maps* (Nat. Commun. 11, 5795, 2020) — template
 * matching by normalised cross-correlation against a distance-detrended contact
 * map. Loops, borders, hairpins, centromeres and stripes are all the same
 * computation with a different template, which is the whole reason it is worth
 * porting rather than reimplementing one of them: a detector that agrees with a
 * published tool on loops and disagrees on borders is a detector nobody can
 * quote.
 *
 * **Agreement is the requirement, not the aspiration.** Every function here is a
 * transcription of a named function in `chromosight/utils/`, the correspondence
 * is stated in each doc comment, and `test/golden/analysis/chromosight.json` is
 * built by running the actual package over `demo/yeast/` so the two can be
 * compared cell for cell rather than in spirit. Where a decision looks arbitrary
 * — the `>= 10 → 1` clamp, the `half = size // 2 + 1` window, the sub-diagonal
 * band of `NaN` — it is upstream's and it is marked as such. Changing one of them
 * to something more defensible would be changing what the score means.
 *
 * **Dense where upstream is sparse, and that is the only structural departure.**
 * chromosight convolves scipy sparse matrices; this reads one contig at a time as
 * a dense square, which is what every other task on this map already does
 * (`run/blocks.ts`) and what the reader worker is built to serve. The two are
 * arithmetically identical — proven, not assumed: the golden compares the
 * detrended matrix, the correlation map, the scores, the p-values and the pileup.
 * What differs is the memory profile, so everything wider than the scan band is
 * stored as a {@link DiagonalBand} rather than as an `n²` array.
 *
 * There is no ICE here and there will not be. chromosight balances a raw cooler
 * itself; this app does not write to the file it opened (SPECS §13), so a raw
 * file is detected on its own counts with its detectable bins found the way
 * `get_detectable_bins` finds them, and the runner says so out loud.
 */

import { CHROMOSIGHT_KERNELS } from './chromosightKernels'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A square, odd-sided template. Row-major, `size * size` long. */
export interface Kernel {
  size: number
  values: Float64Array
}

/** The thresholds a scan runs under, all in bins rather than base pairs. */
export interface ScanSettings {
  /** Diagonals to scan, from `max_dist // binsize`, never below 1. */
  maxDist: number
  /** Score floor for a candidate pixel. */
  pearson: number
  /** Fraction of a window that may be undetectable, `max_perc_undetected / 100`. */
  missingTol: number
  /** Fraction of a window that may be zero, `max_perc_zero / 100`. */
  zeroTol: number
  /**
   * Whether the pattern lives *on* the diagonal, from `max_dist == 0` upstream.
   *
   * It reads like presentation and is not. `pattern_detector` moves a call's row
   * onto its column **before** the window is cut, so a border found one bin off
   * the diagonal is scored, filtered and piled up at the diagonal cell rather
   * than where the focus peaked. Doing it afterwards — which is the obvious
   * order, and the one this port had first — gives the same coordinates with
   * different scores, different windows and a different pileup.
   */
  onDiagonal?: boolean
}

/** One called pattern, in the bins of the square it was found on. */
export interface Pattern {
  bin1: number
  bin2: number
  /** The Pearson correlation with the template. */
  score: number
  /** Two-sided p-value from the Fisher transformation. */
  pvalue: number
  /** Which of the pattern's templates matched, for a multi-kernel preset. */
  kernel: number
  /** Which refinement pass found it. */
  iteration: number
}

/** A pattern and the window of contacts around it, as the pileup consumes it. */
export interface PatternWindow {
  pattern: Pattern
  /** `size * size`, row-major, `NaN` where the pixel is undetectable. */
  values: Float64Array
}

/**
 * A preset's templates, as the scan wants them.
 *
 * The one place `CHROMOSIGHT_KERNELS` is read, so the 88 kB of matrices are
 * reachable from the worker's bundle and from nowhere else — see
 * `chromosightPresets.ts` on why the two are separate modules. `Float64Array`
 * rather than the literal arrays because every inner loop below indexes them a
 * few hundred million times.
 */
export function templatesOf(preset: { name: string }): Kernel[] {
  const templates = CHROMOSIGHT_KERNELS[preset.name] ?? []
  return templates.map((template) => ({
    size: template.size,
    values: Float64Array.from(template.values),
  }))
}

// ---------------------------------------------------------------------------
// Band storage
// ---------------------------------------------------------------------------

/**
 * A run of diagonals of a square matrix, stored without the rest of it.
 *
 * Every object in this module is banded by construction: the detrended matrix
 * keeps `0 … keepDistance`, the correlation map keeps `0 … maxDist`, and
 * everything outside is a zero the sparse original never stored either. Holding
 * them as `n²` would be correct and would cost 2.5 GB on a human chromosome at
 * 10 kb, which is the same wall `analysis/tasks/compartments.ts` refuses at.
 *
 * `at` answers `0` outside the band rather than throwing, because that *is* the
 * value — the caller is convolving a template across an edge, and the arithmetic
 * upstream does the same by not storing the cell.
 */
export class DiagonalBand {
  readonly values: Float64Array

  constructor(
    readonly n: number,
    /** Lowest offset `col - row` stored, inclusive. */
    readonly lo: number,
    /** Highest offset `col - row` stored, inclusive. */
    readonly hi: number,
  ) {
    this.values = new Float64Array((hi - lo + 1) * n)
  }

  /** Index of `(row, col)`, or `-1` where the cell is outside the band. */
  index(row: number, col: number): number {
    const offset = col - row
    if (offset < this.lo || offset > this.hi || row < 0 || row >= this.n) return -1
    return (offset - this.lo) * this.n + row
  }

  at(row: number, col: number): number {
    const at = this.index(row, col)
    return at < 0 ? 0 : this.values[at]
  }

  set(row: number, col: number, value: number): void {
    const at = this.index(row, col)
    if (at >= 0) this.values[at] = value
  }
}

// ---------------------------------------------------------------------------
// Detectable bins
// ---------------------------------------------------------------------------

/**
 * Bins the balancer kept, which is what chromosight calls detectable.
 *
 * `HicGenome.normalize` ends on `np.flatnonzero(np.isfinite(self.bins.weight))`
 * and nothing else: a bin whose weight the balancer threw out is a bin whose
 * pixels are `NaN`, and every count of "undetectable pixels" downstream is a
 * count of those. This is therefore the same set the app's own dense reads
 * produce gaps for (`metacooler/matrix.ts`, `applyWeights`), which is why the
 * two agree without a second convention.
 */
/**
 * Where one sequence's raw contacts come from.
 *
 * Two shapes satisfy it and the arithmetic below cannot tell them apart: a dense
 * `n × n` square ({@link denseContacts}), which is what a test and a golden hand
 * over, and a **band** of the diagonals a scan can actually reach, which is what
 * a runner reads from a file.
 *
 * The interface exists because the second one is the only one that scales. Every
 * cell {@link distanceLaw} and {@link detrend} ever look at has
 * `0 ≤ col − row ≤ keepDistance`; the square around those cells was read, held
 * and thrown away, and on a mammalian chromosome at 5 kb it is six gigabytes
 * that a browser will not allocate at any price. Reading the band instead is not
 * an optimisation of this module — nothing here changes — it is the removal of
 * a ceiling that was never this module's to impose.
 */
export interface ContactSource {
  /** `(row, col)`; `0` for a cell the source does not hold. */
  at(row: number, col: number): number
}

/** A dense, mirrored `n × n` square as a {@link ContactSource}. */
export function denseContacts(values: ArrayLike<number>, n: number): ContactSource {
  return {
    at(row: number, col: number): number {
      if (row < 0 || row >= n || col < 0 || col >= n) return 0
      return values[row * n + col]
    },
  }
}

export function detectableFromWeights(weights: ArrayLike<number>, from: number, to: number): Uint8Array {
  const out = new Uint8Array(to - from)
  for (let i = from; i < to; i++) out[i - from] = Number.isFinite(weights[i]) ? 1 : 0
  return out
}

/**
 * `preprocessing.get_detectable_bins`, for a file with no weights to read.
 *
 * The proportion of non-zero pixels per bin, and everything more than `nMads`
 * median absolute deviations below the median is out. chromosight reaches this
 * path by balancing the file first; this app cannot write weights back into a
 * cooler it opened (SPECS §13), so a raw file gets the rule applied to its raw
 * counts and the runner states that the two are not the same starting point.
 */
export function detectableFromCounts(values: ArrayLike<number>, n: number, nMads: number): Uint8Array {
  // Non-zero pixels per bin, counting the symmetric square as it stands: this
  // mirrors `sum_mat_bins` on a binarised matrix, where a mirrored dense block
  // and an upper-triangular sparse one give the same per-bin total.
  const sums = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    let total = 0
    for (let c = 0; c < n; c++) {
      const value = values[r * n + c]
      if (Number.isFinite(value) && value !== 0) total++
    }
    sums[r] = total
  }
  return detectableFromMarginal(sums, nMads)
}

/**
 * The same cut, from a marginal somebody else counted.
 *
 * The marginal is the one quantity in this module that is genuinely a property
 * of a whole *row* rather than of the band — it counts non-zero pixels at every
 * separation — so a runner that reads only the band cannot produce it from what
 * it holds and counts it from the pixel table instead. What the cut is applied
 * to is the same vector either way, which is why the arithmetic is here and the
 * counting is not.
 */
export function detectableFromMarginal(sums: ArrayLike<number>, nMads: number): Uint8Array {
  const n = sums.length
  const median = medianOf(sums)
  const deviations = new Float64Array(n)
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(sums[i] - median)
  const mad = medianOf(deviations)
  const threshold = Math.max(1, median - mad * nMads)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = sums[i] >= threshold ? 1 : 0
  return out
}

function medianOf(values: ArrayLike<number>): number {
  const sorted = Array.from(values as ArrayLike<number>).filter((value) => Number.isFinite(value))
  if (sorted.length === 0) return Number.NaN
  sorted.sort((a, b) => a - b)
  const half = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2
}

// ---------------------------------------------------------------------------
// Detrending
// ---------------------------------------------------------------------------

/**
 * `preprocessing.distance_law` with `fun=nanmean` and no isotonic smoothing.
 *
 * The mean of the **non-zero** pixels of each diagonal, over pairs of detectable
 * bins. Both restrictions are load-bearing and neither is the obvious choice: a
 * mean over every cell would be a mean over the sparsity pattern as much as over
 * the contacts, and including undetectable bins would put the balancer's gaps
 * into the denominator the whole map is divided by.
 *
 * Smoothing is upstream's `--smooth-trend` and is off by default there and here.
 * It assumes contact can only fall with distance, which is false for a circular
 * chromosome and for a bacterial genome — most of what this app opens.
 */
export function distanceLaw(
  contacts: ContactSource,
  n: number,
  detectable: Uint8Array,
  maxDist: number,
): Float64Array {
  const out = new Float64Array(n)
  const diagonals = Math.min(n, maxDist + 1)
  for (let d = 0; d < diagonals; d++) {
    let total = 0
    let count = 0
    for (let r = 0; r + d < n; r++) {
      if (detectable[r] === 0 || detectable[r + d] === 0) continue
      const value = contacts.at(r, r + d)
      // `> 0` and not `!== 0`: the comparison upstream is `detect_diag > 0`,
      // which drops NaN as well as zero, and a balanced cooler's gaps are NaN.
      if (!(value > 0)) continue
      total += value
      count++
    }
    out[d] = count === 0 ? Number.NaN : total / count
  }
  return out
}

/**
 * The observed/expected map chromosight actually scans, banded.
 *
 * `ContactMap.detrend` then `remove_diags`: divide every stored pixel by its
 * diagonal's mean, clamp anything at or above `maxVal` back to 1, and keep the
 * upper triangle out to `keepDistance`.
 *
 * The clamp is the part worth stating. It looks like an outlier guard and is
 * one, but it also catches the cell whose diagonal mean is *zero* — division by
 * which is an infinity, which is `>= 10`, which becomes 1. Reproducing that
 * means dividing only the cells the sparse original stores: a zero pixel is not
 * divided and stays zero, so `0 / 0` never happens and a whole diagonal with no
 * contacts leaves no `NaN` behind.
 */
export function detrend(
  contacts: ContactSource,
  n: number,
  detectable: Uint8Array,
  keepDistance: number,
  maxVal = 10,
): DiagonalBand {
  const hi = Math.min(keepDistance, Math.max(0, n - 1))
  const law = distanceLaw(contacts, n, detectable, keepDistance)
  const band = new DiagonalBand(n, 0, hi)
  for (let d = 0; d <= hi; d++) {
    const expected = Number.isFinite(law[d]) ? law[d] : 0
    const base = (d - band.lo) * n
    for (let r = 0; r + d < n; r++) {
      const value = contacts.at(r, r + d)
      // The sparse original divides `.data`, so only stored pixels are touched.
      // A `NaN` from a dropped bin is not a stored pixel there — `create_mat`
      // has already turned it into an implicit zero — so it is one here either.
      if (!Number.isFinite(value) || value === 0) continue
      const scaled = value / expected
      band.values[base + r] = scaled >= maxVal ? 1 : scaled
    }
  }
  return band
}

// ---------------------------------------------------------------------------
// The missing mask
// ---------------------------------------------------------------------------

/**
 * Whether a pixel is missing, in the frame chromosight convolves inside.
 *
 * `preprocessing.make_missing_mask` composed with `frame_missing_mask`, for the
 * upper-symmetric case with a scan distance — evaluated pointwise instead of
 * assembled, because the assembled version is a sparse matrix half a gigabyte
 * wide on a chromosome this app will happily open.
 *
 * `row` and `col` are in the **contig's own** coordinates and may be negative or
 * past `n`: the convolution runs in "full" mode, which pads the square by half a
 * kernel so that a pattern can be found against the very first bin. Those pad
 * cells are missing rather than zero, which is what stops the edge of a
 * chromosome from correlating with a template purely because both are flat.
 *
 * Four rules, and every one of them is upstream's:
 *
 * - the `bigK` diagonals **below** the diagonal are missing, so a window that
 *   straddles it is scored on the half that carries signal;
 * - inside the square, a pixel is missing when either of its bins is
 *   undetectable **and** it is within the scan band — beyond the band nothing is
 *   masked, because nothing there is scanned;
 * - the pad above and to the left is missing only where the scan band reaches
 *   it, and the pad below is not missing at all;
 * - the pad to the right is missing only for the last `maxDist + 2` rows.
 *
 * The last two are asymmetric and look like an oversight. They are not: this is
 * an upper-triangular matrix scanned within a band, and the corners the rules
 * leave unmasked are corners no scanned window reaches.
 */
export function framedMissing(
  row: number,
  col: number,
  n: number,
  detectable: Uint8Array,
  maxDist: number,
  kernelSize: number,
): boolean {
  const below = row - col
  if (below >= 1 && below <= kernelSize) return true
  if (row >= 0 && row < n && col >= 0 && col < n) {
    const offset = col - row
    return offset >= 0 && offset <= maxDist && (detectable[row] === 0 || detectable[col] === 0)
  }
  if (col < 0) return row < 0
  if (col >= n) return row >= n - maxDist - 2
  if (row < 0) return col < maxDist + kernelSize
  return false
}

// ---------------------------------------------------------------------------
// Normalised cross-correlation
// ---------------------------------------------------------------------------

/** What one window's correlation was computed from. */
export interface WindowScore {
  corr: number
  /** Pixels that were not missing — the `n` of the significance test. */
  present: number
}

/**
 * The Pearson correlation of the template with the window centred on a pixel.
 *
 * `detection.normxcorr2` in full mode with a missing mask, one pixel at a time.
 * The identity that makes the sparse original's six convolutions unnecessary is
 * that **the signal is zero wherever the mask says missing** — `check_missing_mask`
 * asserts exactly that upstream — so a sum over the present pixels of the signal
 * is a plain window sum, and only the *template's* moments need correcting for
 * what is absent:
 *
 * ```
 *   r = (Σxk/n − x̄k̄) / √((Σx²/n − x̄²)(Σk²/n − k̄²))
 * ```
 *
 * with every sum over the present pixels and `k̄`, `Σk²` taken over the same
 * subset. A window with too few present pixels scores zero rather than a
 * correlation over a handful of cells, which is `missingTol`'s whole job.
 */
export function correlateAt(
  matrix: DiagonalBand,
  n: number,
  detectable: Uint8Array,
  kernel: Kernel,
  row: number,
  col: number,
  settings: { maxDist: number; missingTol: number },
): WindowScore {
  const size = kernel.size
  const half = (size - 1) / 2
  const cells = size * size
  const minPresent = Math.trunc((1 - settings.missingTol) * cells)

  let sum = 0
  let sumSquares = 0
  let cross = 0
  let missingKernel = 0
  let missingKernel2 = 0
  let missing = 0
  let kernelSum = 0
  let kernelSum2 = 0

  for (let a = 0; a < size; a++) {
    const r = row - half + a
    for (let b = 0; b < size; b++) {
      const c = col - half + b
      const weight = kernel.values[a * size + b]
      kernelSum += weight
      kernelSum2 += weight * weight
      if (framedMissing(r, c, n, detectable, settings.maxDist, size)) {
        missing++
        missingKernel += weight
        missingKernel2 += weight * weight
        continue
      }
      const value = r >= 0 && r < n && c >= 0 && c < n ? matrix.at(r, c) : 0
      sum += value
      sumSquares += value * value
      cross += value * weight
    }
  }

  const present = cells - missing
  if (present < minPresent || present === 0) return { corr: 0, present }
  const meanX = sum / present
  const meanX2 = sumSquares / present
  const meanK = (kernelSum - missingKernel) / present
  const meanK2 = (kernelSum2 - missingKernel2) / present
  const variance = (meanX2 - meanX * meanX) * (meanK2 - meanK * meanK)
  const denominator = variance > 0 ? Math.sqrt(variance) : 0
  if (!(Math.abs(denominator) >= 1e-10)) return { corr: 0, present }
  const value = (cross / present - meanX * meanK) / denominator
  // Rounding can put a coefficient a hair outside [-1, 1]; upstream clips, and
  // `arctanh` on 1.0000000001 is not a number anybody wants in a p-value.
  return { corr: Math.min(1, Math.max(-1, value)), present }
}

/**
 * The correlation map over the scan band.
 *
 * The same arithmetic as {@link correlateAt} at every pixel, with the two
 * shortcuts that make it affordable on a real chromosome:
 *
 * - **a window with no missing pixel skips the mask entirely.** Whether one has
 *   any is a prefix-sum lookup on the undetectable bins plus a comparison
 *   against the sub-diagonal band, and the great majority of windows in a
 *   balanced map have none.
 * - **a window with no signal is not correlated.** Its variance is zero, so
 *   upstream's denominator guard would answer zero anyway; here it is answered
 *   without the multiply-accumulate.
 *
 * Both are exact — they decide *whether* to run the loop, never what it
 * computes — which is what lets the golden compare this to the sparse original
 * cell for cell rather than within a tolerance for having taken a short cut.
 */
export function correlate(
  matrix: DiagonalBand,
  n: number,
  detectable: Uint8Array,
  kernel: Kernel,
  settings: { maxDist: number; missingTol: number },
): DiagonalBand {
  const band = emptyCorrelation(n, settings.maxDist)
  correlateInto(band, matrix, n, detectable, kernel, settings, 0, n)
  return band
}

/** The band a correlation over `n` bins will fill. */
export function emptyCorrelation(n: number, maxDist: number): DiagonalBand {
  return new DiagonalBand(n, 0, Math.min(maxDist, Math.max(0, n - 1)))
}

/**
 * {@link correlate} over a run of rows, into a band the caller owns.
 *
 * A whole chromosome's correlation is seconds of arithmetic that yields to
 * nothing, and `analysis/job.ts` is emphatic about what that costs: a cancel is
 * a *message*, and a runner that never returns to its event loop never receives
 * one. So the row range is the caller's, and the caller breathes between slices.
 */
export function correlateInto(
  band: DiagonalBand,
  matrix: DiagonalBand,
  n: number,
  detectable: Uint8Array,
  kernel: Kernel,
  settings: { maxDist: number; missingTol: number },
  fromRow: number,
  toRow: number,
): void {
  const size = kernel.size
  const half = (size - 1) / 2
  const cells = size * size

  // Undetectable bins, prefix-summed, so "does this window touch one" is O(1).
  const gaps = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) gaps[i + 1] = gaps[i] + (detectable[i] === 0 ? 1 : 0)
  const anyGap = (from: number, to: number): boolean => {
    const lo = Math.max(0, from)
    const hi = Math.min(n, to)
    return hi <= lo ? false : gaps[hi] - gaps[lo] > 0
  }

  let kernelSum = 0
  let kernelSum2 = 0
  for (let i = 0; i < cells; i++) {
    kernelSum += kernel.values[i]
    kernelSum2 += kernel.values[i] * kernel.values[i]
  }
  const meanK = kernelSum / cells
  const meanK2 = kernelSum2 / cells
  const kernelVariance = meanK2 - meanK * meanK

  for (let row = Math.max(0, fromRow); row < Math.min(n, toRow); row++) {
    const rowFrom = row - half
    const rowTo = row + half + 1
    for (let offset = 0; offset <= band.hi; offset++) {
      const col = row + offset
      if (col >= n) break
      const colFrom = col - half
      const colTo = col + half + 1
      // A window entirely inside the square, clear of the sub-diagonal band and
      // of every undetectable bin, has nothing to mask.
      const clean =
        rowFrom >= 0 &&
        rowTo <= n &&
        colFrom >= 0 &&
        colTo <= n &&
        colFrom > rowTo - 2 &&
        !anyGap(rowFrom, rowTo) &&
        !anyGap(colFrom, colTo)
      if (!clean) {
        const scored = correlateAt(matrix, n, detectable, kernel, row, col, settings)
        band.values[offset * n + row] = scored.corr
        continue
      }

      let sum = 0
      let sumSquares = 0
      let cross = 0
      for (let a = 0; a < size; a++) {
        const r = rowFrom + a
        // Only the stored diagonals hold anything; the rest of the window is the
        // zero the sparse original does not store either.
        const first = Math.max(0, matrix.lo - (colFrom - r))
        const last = Math.min(size, matrix.hi - (colFrom - r) + 1)
        if (last <= first) continue
        let at = (colFrom + first - r - matrix.lo) * n + r
        let index = a * size + first
        for (let b = first; b < last; b++) {
          const value = matrix.values[at]
          if (value !== 0) {
            sum += value
            sumSquares += value * value
            cross += value * kernel.values[index]
          }
          at += n
          index++
        }
      }
      if (sumSquares === 0) continue
      const meanX = sum / cells
      const variance = (sumSquares / cells - meanX * meanX) * kernelVariance
      const denominator = variance > 0 ? Math.sqrt(variance) : 0
      if (!(Math.abs(denominator) >= 1e-10)) continue
      const value = (cross / cells - meanX * meanK) / denominator
      band.values[offset * n + row] = Math.min(1, Math.max(-1, value))
    }
  }
}

// ---------------------------------------------------------------------------
// Significance
// ---------------------------------------------------------------------------

/**
 * `stats.corr_to_pval`: a two-sided p-value by the Fisher transformation.
 *
 * `2 Φ(−|artanh(r)| √(n − 3))`, where `n` is the number of pixels the
 * correlation was computed over — which is why {@link WindowScore} carries it.
 * Returned as a plain probability rather than upstream's log10, because
 * everything downstream here — the FDR, the table, the export — wants the
 * probability, and upstream immediately raises 10 to it.
 */
export function corrToPvalue(corr: number, present: number): number {
  if (!Number.isFinite(corr) || present <= 3) return Number.NaN
  const z = Math.atanh(Math.min(1 - 1e-16, Math.max(-1 + 1e-16, corr)))
  return 2 * standardNormalCdf(-Math.abs(z * Math.sqrt(present - 3)))
}

/**
 * Φ, the standard normal CDF, through `erfc`.
 *
 * Worth the exactness rather than a five-term fit. A p-value of 1e-40 is not a
 * number anybody reads, but it **is** a number the Benjamini-Hochberg step sorts
 * on, and an approximation that flattens the far tail makes the ordering of the
 * strongest patterns arbitrary — which is exactly where the reader looks first.
 */
function standardNormalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2)
}

/**
 * `erfc`, to within a few units in the last place.
 *
 * Two branches, because no single expansion is well behaved across the range the
 * Fisher transformation produces: the all-positive-terms series near zero, where
 * the alternating one would cancel, and the continued fraction past 2, where
 * `1 − erf(x)` would be a subtraction of two nearly equal numbers. The crossover
 * is where both are comfortably converged.
 */
function erfc(x: number): number {
  const z = Math.abs(x)
  const value = z < 2 ? 1 - erfSeries(z) : erfcFraction(z)
  return x >= 0 ? value : 2 - value
}

/** `erf(z) = (2/√π) e^{−z²} Σ 2ⁿ z^{2n+1} / (1·3·…·(2n+1))`, all terms positive. */
function erfSeries(z: number): number {
  let term = z
  let sum = z
  for (let n = 1; n < 200; n++) {
    term *= (2 * z * z) / (2 * n + 1)
    sum += term
    if (term < Math.abs(sum) * 1e-17) break
  }
  return ((2 / Math.sqrt(Math.PI)) * Math.exp(-z * z) * sum)
}

/** `erfc(z) = e^{−z²}/√π · 1/(z + ½/(z + 1/(z + 3/2/(z + …))))`, by modified Lentz. */
function erfcFraction(z: number): number {
  const tiny = 1e-300
  let d = 1 / z
  let c = 1e300
  let h = d
  for (let i = 1; i < 300; i++) {
    const a = i / 2
    d = z + a * d
    if (d === 0) d = tiny
    c = z + a / c
    if (c === 0) c = tiny
    d = 1 / d
    const delta = c * d
    h *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return (Math.exp(-z * z) / Math.sqrt(Math.PI)) * h
}

/**
 * `stats.fdr_correction`: Benjamini-Hochberg, as a q-value per input p-value.
 *
 * The cumulative minimum from the largest p-value down, which is what makes the
 * correction monotone: a pattern cannot end up with a smaller q-value than a
 * stronger one. `NaN` inputs come back as `NaN` and take no rank, because a
 * pattern with no p-value is not a test that was performed.
 */
export function fdrCorrection(pvalues: ArrayLike<number>): Float64Array {
  const n = pvalues.length
  const out = new Float64Array(n).fill(Number.NaN)
  const order: number[] = []
  for (let i = 0; i < n; i++) if (Number.isFinite(pvalues[i])) order.push(i)
  order.sort((a, b) => pvalues[b] - pvalues[a])
  const total = order.length
  let running = Number.POSITIVE_INFINITY
  for (let rank = 0; rank < total; rank++) {
    const step = total / (total - rank)
    running = Math.min(running, step * pvalues[order[rank]])
    out[order[rank]] = Math.min(1, running)
  }
  return out
}

// ---------------------------------------------------------------------------
// Foci
// ---------------------------------------------------------------------------

/** A candidate pixel: the brightest cell of one focus. */
export interface Focus {
  row: number
  col: number
  score: number
  /** Pixels in the focus, which is what `minSize` filters on. */
  size: number
}

/**
 * `detection.pick_foci`: one coordinate per island of highly correlated pixels.
 *
 * Thresholding a correlation map gives blobs rather than points — a loop is
 * several bins wide and its template matches all of them — so the call is the
 * *maximum* of each 4-connected island, and islands of a single pixel are
 * dropped as noise (`min_size`, 2 upstream).
 *
 * Union-find over a row-major sweep rather than a flood fill, because the order
 * matters: upstream takes the first maximum in the order scipy's COO holds the
 * pixels, which is row-major, and two pixels of a focus at exactly the same
 * correlation are not unheard of on a coarse map.
 */
export function pickFoci(corr: DiagonalBand, pearson: number, minSize = 2): Focus[] {
  const n = corr.n
  const width = corr.hi - corr.lo + 1
  const parent = new Int32Array(width * n).fill(-1)

  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let walk = index
    while (parent[walk] !== root) {
      const next = parent[walk]
      parent[walk] = root
      walk = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }

  const candidate = (row: number, col: number): number => {
    const at = corr.index(row, col)
    if (at < 0) return -1
    return corr.values[at] >= pearson ? at : -1
  }

  for (let row = 0; row < n; row++) {
    for (let offset = corr.lo; offset <= corr.hi; offset++) {
      const col = row + offset
      if (col < 0) continue
      if (col >= n) break
      const at = candidate(row, col)
      if (at < 0) continue
      parent[at] = at
      const left = candidate(row, col - 1)
      if (left >= 0) union(at, left)
      const up = candidate(row - 1, col)
      if (up >= 0) union(at, up)
    }
  }

  const best = new Map<number, Focus>()
  for (let row = 0; row < n; row++) {
    for (let offset = corr.lo; offset <= corr.hi; offset++) {
      const col = row + offset
      if (col < 0) continue
      if (col >= n) break
      const at = candidate(row, col)
      if (at < 0) continue
      const root = find(at)
      const score = corr.values[at]
      const held = best.get(root)
      if (held === undefined) {
        best.set(root, { row, col, score, size: 1 })
        continue
      }
      held.size++
      // Strictly greater, so a tie keeps the first pixel in row-major order.
      if (score > held.score) {
        held.row = row
        held.col = col
        held.score = score
      }
    }
  }
  return [...best.values()].filter((focus) => focus.size >= minSize)
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The contacts around a pattern, as `validate_patterns` cuts them.
 *
 * Three conventions, all upstream's and none of them the obvious one:
 *
 * - the window is `[p − size/2, p + size/2]` **inclusive on both sides**, taken
 *   from `half = size // 2 + 1`, so it is exactly as wide as the template;
 * - a pixel in an undetectable bin is `NaN` rather than zero, and so is every
 *   pixel in the `size` diagonals *below* the main one — the pileup would
 *   otherwise average in a triangle of structural zeros that no window above the
 *   diagonal has;
 * - a pixel outside the contig is `NaN` too, because the padded frame the
 *   convolution ran in counts its margins as undetectable.
 *
 * `null` where the window runs off the padded square, which upstream drops. The
 * asymmetry — a pattern on the *last* bin of a contig is dropped and one on the
 * first is not — falls out of `half` being one larger than the pad.
 */
export function windowAt(
  matrix: DiagonalBand,
  n: number,
  detectable: Uint8Array,
  size: number,
  row: number,
  col: number,
): Float64Array | null {
  const half = Math.floor(size / 2) + 1
  const pad = (size - 1) / 2
  // Bounds in the padded square, exactly as upstream tests them.
  if (row - half + 1 + pad < 0 || row + half + pad >= n + 2 * pad) return null
  if (col - half + 1 + pad < 0 || col + half + pad >= n + 2 * pad) return null

  const out = new Float64Array(size * size)
  for (let a = 0; a < size; a++) {
    const r = row - half + 1 + a
    const rowGap = r < 0 || r >= n || detectable[r] === 0
    for (let b = 0; b < size; b++) {
      const c = col - half + 1 + b
      const gap = rowGap || c < 0 || c >= n || detectable[c] === 0 || (r - c >= 1 && r - c <= size)
      out[a * size + b] = gap ? Number.NaN : matrix.at(r, c)
    }
  }
  return out
}

/** Whether a window has enough real signal in it to be scored. */
export function windowPasses(
  values: Float64Array,
  settings: { missingTol: number; zeroTol: number },
): boolean {
  let missing = 0
  let zeros = 0
  for (const value of values) {
    if (!Number.isFinite(value)) missing++
    else if (value === 0) zeros++
  }
  const total = values.length
  const undetected = missing / total
  const zero = total - missing === 0 ? 1 : zeros / (total - missing)
  return undetected < settings.missingTol && zero < settings.zeroTol
}

/**
 * `detection.pileup_patterns`: the per-cell mean over a stack of windows.
 *
 * Per **cell** and not per window, which is `nanmean` along the stacking axis:
 * a window with one undetectable row still contributes every other row it has,
 * and a cell no window could see stays absent rather than becoming a zero that
 * would read as a depletion.
 */
export function pileupOf(windows: ReadonlyArray<ArrayLike<number>>, size: number): Float64Array {
  const total = new Float64Array(size * size)
  const count = new Int32Array(size * size)
  for (const window of windows) {
    for (let i = 0; i < total.length; i++) {
      const value = window[i]
      if (!Number.isFinite(value)) continue
      total[i] += value
      count[i]++
    }
  }
  const out = new Float64Array(size * size)
  for (let i = 0; i < out.length; i++) out[i] = count[i] > 0 ? total[i] / count[i] : Number.NaN
  return out
}

/**
 * A diagonal pattern's pileup, folded onto itself.
 *
 * `cmd_detect`'s last step for a pattern whose `max_dist` is zero. Half of such
 * a window is below the diagonal and therefore all gaps, so the picture is a
 * triangle until its transpose is added back — and the diagonal itself is
 * subtracted once, because it belongs to both halves.
 */
export function symmetrise(values: Float64Array, size: number): Float64Array {
  const out = new Float64Array(size * size)
  for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(values[i]) ? values[i] : 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (r === c) continue
      out[r * size + c] += Number.isFinite(values[c * size + r]) ? values[c * size + r] : 0
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One square, end to end
// ---------------------------------------------------------------------------

/** A contig's contacts and what is known about its bins. */
export interface Square {
  /**
   * The raw contacts — a band from a file, or a dense square from a test.
   *
   * Read by {@link prepareSquare} and by nothing else in this module: once the
   * detrended band exists, every later step works from that.
   */
  contacts: ContactSource
  n: number
  detectable: Uint8Array
}

/** Everything one pass over one square produced. */
export interface SquareResult {
  /** The detrended, band-trimmed map the scan ran on — the pileup's source. */
  matrix: DiagonalBand
  corr: DiagonalBand
  found: PatternWindow[]
  /** Candidates that failed the window-quality filters. */
  rejected: number
}

/**
 * The detrended map, banded to the widest diagonal the scan can reach.
 *
 * `keepDistance` is upstream's: the scan distance plus the largest template, so
 * that a window centred on the last scanned diagonal still has contacts on the
 * far side of it. Wider than the correlation band, and deliberately.
 */
export function prepareSquare(
  square: Square,
  options: { maxDist: number; largestKernel: number },
): DiagonalBand {
  return detrend(
    square.contacts,
    square.n,
    square.detectable,
    keepDistanceFor(square.n, options.maxDist, options.largestKernel),
  )
}

/**
 * The widest diagonal a scan touches, and therefore the whole of what has to be
 * read.
 *
 * Exported because the *reader* needs it before the square exists: it decides
 * how wide a band comes off the file, and a band narrower than this would leave
 * {@link detrend} dividing by a distance law fitted to fewer diagonals than it
 * scans. One expression, used by both, so the two cannot drift apart.
 */
export function keepDistanceFor(n: number, maxDist: number, largestKernel: number): number {
  return Math.min(maxDist, n) + largestKernel
}

/**
 * `detection.pattern_detector` in detect mode, over one prepared square.
 *
 * Pick the foci of the correlation map, cut a window around each and drop the
 * ones sitting in too much missing data. The p-value comes from the same
 * window's present count, so a call made from half a window is not given the
 * significance of a whole one.
 *
 * The correlation arrives already computed, because a chromosome's worth of it
 * has to be interruptible — see {@link correlateInto}.
 */
export function detectOnSquare(
  square: Square,
  matrix: DiagonalBand,
  corr: DiagonalBand,
  kernel: Kernel,
  settings: ScanSettings,
): SquareResult {
  const { n, detectable } = square
  const found: PatternWindow[] = []
  let rejected = 0
  for (const focus of pickFoci(corr, settings.pearson)) {
    // Before the window is cut, never after. See {@link ScanSettings.onDiagonal}.
    const row = settings.onDiagonal === true ? focus.col : focus.row
    const values = windowAt(matrix, n, detectable, kernel.size, row, focus.col)
    if (values === null || !windowPasses(values, settings)) {
      rejected++
      continue
    }
    const scored = correlateAt(matrix, n, detectable, kernel, row, focus.col, settings)
    found.push({
      pattern: {
        bin1: row,
        bin2: focus.col,
        score: corr.at(row, focus.col),
        pvalue: corrToPvalue(corr.at(row, focus.col), scored.present),
        kernel: 0,
        iteration: 0,
      },
      values,
    })
  }
  return { matrix, corr, found, rejected }
}

/**
 * The same machinery in quantify mode: given coordinates, score them.
 *
 * The difference from detection is what happens to a window that fails the
 * quality filters — here it comes back with a `NaN` score and a `NaN` window
 * rather than being dropped, because the caller asked about *these* positions
 * and an answer of "no score" is an answer, while a shorter list is a silent
 * reordering of somebody's loop table.
 */
export function quantifyOnSquare(
  square: Square,
  matrix: DiagonalBand,
  kernel: Kernel,
  settings: ScanSettings,
  coords: ReadonlyArray<{ bin1: number; bin2: number }>,
): PatternWindow[] {
  const { n, detectable } = square
  const out: PatternWindow[] = []
  for (const coord of coords) {
    const values = windowAt(matrix, n, detectable, kernel.size, coord.bin1, coord.bin2)
    const usable = values !== null && windowPasses(values, settings)
    const scored = usable
      ? correlateAt(matrix, n, detectable, kernel, coord.bin1, coord.bin2, settings)
      : null
    out.push({
      pattern: {
        bin1: coord.bin1,
        bin2: coord.bin2,
        score: scored === null ? Number.NaN : scored.corr,
        pvalue: scored === null ? Number.NaN : corrToPvalue(scored.corr, scored.present),
        kernel: 0,
        iteration: 0,
      },
      values:
        usable && values !== null
          ? values
          : new Float64Array(kernel.size * kernel.size).fill(Number.NaN),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Neighbours
// ---------------------------------------------------------------------------

/**
 * `detection.remove_neighbours`: keep the best call of every smear.
 *
 * A strong pattern suppresses every other call within `winSize` bins on **both**
 * axes, which is `min_separation` in bins. Highest score first, so the survivor
 * of a cluster is its best pixel rather than whichever one the scan reached
 * first. Ties keep the earlier pattern, which is what a stable sort does
 * upstream.
 *
 * The comparison is on whole-file bins, so two calls on different sequences can
 * never suppress each other however close their local coordinates are.
 */
export function removeNeighbours(
  patterns: ReadonlyArray<{ bin1: number; bin2: number; score: number }>,
  winSize: number,
): boolean[] {
  const order = patterns.map((_, index) => index)
  order.sort((a, b) => {
    const difference = patterns[b].score - patterns[a].score
    if (Number.isNaN(difference)) return Number.isNaN(patterns[a].score) ? 1 : -1
    return difference !== 0 ? difference : a - b
  })
  const dropped = new Set<number>()
  for (const index of order) {
    if (dropped.has(index)) continue
    const pattern = patterns[index]
    for (const other of order) {
      if (other === index || dropped.has(other)) continue
      if (
        Math.abs(patterns[other].bin1 - pattern.bin1) < winSize &&
        Math.abs(patterns[other].bin2 - pattern.bin2) < winSize
      ) {
        dropped.add(other)
      }
    }
  }
  return patterns.map((_, index) => !dropped.has(index))
}

/**
 * `cmd_detect`'s whole-file tail: suppress, filter, then correct.
 *
 * The order is the reason this is one function rather than three calls at the
 * call site. Neighbour suppression runs first because two pixels of one loop are
 * not two discoveries; the distance floor runs next because a call this run was
 * never going to report should not enlarge the correction applied to the ones it
 * does; and only what survives both is handed to Benjamini-Hochberg. Reordering
 * any pair of them changes every q-value in the output while changing nothing
 * that looks wrong.
 *
 * The distance floor is compared in **base pairs**, as upstream compares it, so
 * a resolution that does not divide it evenly rounds the same way there and here.
 */
export function winnowCalls<T extends { bin1: number; bin2: number; score: number; pvalue: number }>(
  calls: readonly T[],
  options: { separationBins: number; minDistBp: number; binsize: number },
): { kept: T[]; qvalues: Float64Array } {
  const distinct = removeNeighbours(calls, options.separationBins)
  const kept = calls.filter(
    (call, index) =>
      distinct[index] &&
      Math.abs(call.bin2 - call.bin1) * options.binsize >= options.minDistBp &&
      Number.isFinite(call.pvalue),
  )
  return { kept, qvalues: fdrCorrection(kept.map((call) => call.pvalue)) }
}
