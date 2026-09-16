/**
 * The HiC score: how much contact there is *around* a position, as one number
 * per bin.
 *
 * Bignaud et al. use it on maps where the thing being looked for is not a domain
 * boundary but a change in how tightly a stretch of the genome is folded against
 * itself — a transcribed region that has lost its local structure, a phage
 * genome that has gained one. The reading is deliberately blunt: put a square
 * window on the diagonal, centred on the bin, and take the **mean** of the half
 * of it that is above and to the right of the diagonal.
 *
 * ## What it is, exactly
 *
 * For bin `k` and a window reaching `x` bins each way:
 *
 * ```
 *                 1    k+x   k+x
 * HiC score(k) = ───    Σ     Σ    a[i, j]
 *                 N   i=k−x  j=i
 * ```
 *
 * — every cell with `k − x ≤ i ≤ j ≤ k + x`, which is the upper triangle of the
 * square, the main diagonal included — over `N`, the number of cells in it:
 *
 * ```
 * N = (2x + 1)(2x + 2) / 2 = (2x + 1)(x + 1)
 * ```
 *
 * Not `½(2x + 1)²`, which is what the derivation of this score is usually
 * written with and is half the *square* rather than the triangle: it leaves out
 * the half-diagonal the halving cuts through, and being a count of cells that is
 * never a whole number is the tell. At the three-diagonal window this task
 * defaults to it is 4.5 against a true 6, so the "mean" would run a third high.
 * It is a constant, so the shape of the track is the same either way — but a
 * lane labelled in contacts should be readable as contacts.
 *
 * ## Why a triangle and not the whole square
 *
 * The matrix is symmetric, so the two are the same reading up to one thing:
 * `square = 2 × triangle − diagonal`. Every off-diagonal cell is in the square
 * twice, once each side, and the main diagonal is in it once — so summing the
 * square gives the near-diagonal **half** the weight, relative to everything
 * else, that counting each pair once does. On a bacterial map where the main
 * diagonal is the largest thing in a three-bin window, that is not a constant:
 * it is a different track. Counting each contact once is what the published
 * score does and what this now does.
 *
 * ## Why it is computed one diagonal at a time
 *
 * The obvious loop is `O(x²)` cells per bin, which at a 200 kb window on a 1 kb
 * map is ten thousand per bin and a hundred million over a bacterial chromosome
 * — before anything is drawn. What is here is the same sum in `2x + 1` passes:
 * each **diagonal** of the band is walked once with a running prefix sum, and
 * every bin's window takes a constant number of lookups from it. That is
 * `O(n · x)` rather than `O(n · x²)`, holds one row of prefix at a time rather
 * than the band twice over, and is exact rather than approximate — it is the
 * same addition in a different order.
 *
 * The cells of the triangle at separation `d` are the rows `k − x … k + x − d`
 * of that diagonal, which is one range of one prefix; the triangle is therefore
 * one range per diagonal and there is no second, mirrored one to add.
 *
 * ## Missing cells, and windows that run off the end
 *
 * Two different things, and they are answered differently.
 *
 * A **partial window** — a bin closer to the end of a linear sequence than the
 * window reaches — gets no score at all. Dividing a short sum by the full `N`
 * would fade both ends of every chromosome out towards zero, which reads as
 * *this end is unstructured* and is the artefact the diamond refuses partial
 * windows for (§18.5). On a circular sequence there is no end to run off, the
 * window wraps, and every bin scores.
 *
 * A **dropped cell** inside a whole window is counted rather than guessed at. A
 * balanced matrix drops whole rows (§6.4) and a window overlapping a dropped
 * stretch has a genuinely smaller mean; the sum is never scaled up to pretend
 * the missing cells were average, which would be inventing the data the balancer
 * deliberately refused to supply, and a bin whose window has lost more than
 * `minValid` of itself scores `NaN` rather than a small number.
 */

import type { SeparationBand } from './band'

export interface HicScoreOptions {
  /** Half the square's side, in bins: the window reaches this far each way. */
  halfWidth: number
  /** The fraction of the triangle's cells that must carry a value. */
  minValid: number
  /**
   * Separations to leave out, as `ignore_diags` elsewhere: `0` counts every
   * cell, `1` drops the main diagonal, `2` drops it and the cells one bin
   * apart — the rule is `|col − row| < ignore`, as everywhere else here.
   *
   * `0` by default, because the score is a statement about *all* the contact
   * around a position and the near-diagonal is most of it. It is offered because
   * on a map where self-ligation has not been cleaned out that near-diagonal is
   * an artefact of the library rather than a fact about the fold, and a track
   * carried by it would be a picture of the protocol.
   *
   * `N` is reduced with it, so the score stays a mean of the cells it actually
   * counts rather than a sum over some of them divided by all of them.
   */
  ignoreDiags?: number
}

/**
 * `N`: cells in the upper triangle of a `2h + 1` square, less the cut diagonals.
 *
 * Diagonal `d` of the triangle holds `2h + 1 − d` cells — the whole row of the
 * window at `d = 0`, one cell at `d = 2h` — so the total is the triangular
 * number `(2h + 1)(2h + 2) / 2`. Summed rather than solved for because
 * `ignoreDiags` takes the first few off the front and the closed form for that
 * is two triangular numbers subtracted, which is a line nobody can check by eye
 * against a `2h` that may be smaller than the cut.
 *
 * Exported because the runner quotes it in a note and the tests check the
 * arithmetic the header argues about.
 */
export function triangleCells(halfWidth: number, ignoreDiags = 0): number {
  const h = Math.max(0, Math.trunc(halfWidth))
  const ignore = Math.max(0, Math.trunc(ignoreDiags))
  const side = 2 * h + 1
  let cells = 0
  for (let d = ignore; d <= 2 * h; d++) cells += side - d
  return cells
}

/**
 * The score at every bin of the band, in the band's own local bins.
 *
 * The band must reach `2 × halfWidth`, which is the widest separation inside the
 * window — the corner where the two ends of it contact each other. A narrower
 * one leaves that corner `NaN` and it is counted as missing, which the
 * `minValid` guard will then notice.
 */
export function hicScore(band: SeparationBand, options: HicScoreOptions): Float64Array {
  const n = band.n
  const h = Math.max(0, Math.trunc(options.halfWidth))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const out = new Float64Array(n).fill(Number.NaN)
  if (n === 0) return out

  // `N`, and the threshold under it: `minValid` is a fraction of what the window
  // could actually hold, so cutting diagonals moves both together.
  const cells = triangleCells(h, ignore)
  if (cells <= 0) return out
  const need = Math.max(1, Math.ceil(cells * Math.max(0, Math.min(1, options.minValid))))

  // Bins with a whole window around them. On a line that is everything but the
  // two ends; on a circle it is every bin, because the window wraps. Scoring
  // only these is what keeps a short sum from being divided by a full `N` —
  // see the header.
  const first = band.circular ? 0 : h
  const last = band.circular ? n - 1 : n - 1 - h
  if (last < first) return out

  const sums = new Float64Array(n)
  const counts = new Float64Array(n)

  // One prefix pass per diagonal, reused. `n + 1` long so `prefix[k]` is the sum
  // of the first `k` entries and an empty range is a subtraction rather than a
  // branch.
  const prefixSum = new Float64Array(n + 1)
  const prefixCount = new Float64Array(n + 1)

  // `ignore_diags` counts the main diagonal as one, so `ignore` is exactly the
  // first separation that survives the cut.
  for (let offset = ignore; offset <= 2 * h; offset++) {
    // The diagonal itself, as a prefix. `forward` answers `NaN` off the end of a
    // linear sequence and wraps on a circular one, so this loop is the same on
    // both and the only difference is how many of its entries are finite.
    for (let row = 0; row < n; row++) {
      const value = band.forward(row, offset)
      const finite = Number.isFinite(value)
      prefixSum[row + 1] = prefixSum[row] + (finite ? value : 0)
      prefixCount[row + 1] = prefixCount[row] + (finite ? 1 : 0)
    }
    const total = prefixSum[n]
    const totalCount = prefixCount[n]

    for (let bin = first; bin <= last; bin++) {
      // Rows whose cell at this separation lands inside the triangle: the row is
      // at least the window's start and the *column* is at most its end. Each is
      // counted once — the mirrored cell below the diagonal is the same contact
      // and the triangle is what says so.
      const lo = bin - h
      const hiRow = bin + h - offset
      let sum: number
      let count: number
      if (band.circular) {
        // A window that runs off either end of a circular sequence comes back on
        // at the other, so the range is two pieces of the prefix rather than a
        // clamped one. Written as a length from a normalised start, which is the
        // one form that cannot produce a negative span.
        const span = Math.min(n, hiRow - lo + 1)
        const start = ((lo % n) + n) % n
        const end = start + span
        if (end <= n) {
          sum = prefixSum[end] - prefixSum[start]
          count = prefixCount[end] - prefixCount[start]
        } else {
          sum = total - prefixSum[start] + prefixSum[end - n]
          count = totalCount - prefixCount[start] + prefixCount[end - n]
        }
      } else {
        // `first` and `last` put the whole window inside the sequence, so this
        // range needs no clamping: `0 ≤ lo ≤ hiRow ≤ n − 1` for every `offset`
        // the loop reaches.
        sum = prefixSum[hiRow + 1] - prefixSum[lo]
        count = prefixCount[hiRow + 1] - prefixCount[lo]
      }
      sums[bin] += sum
      counts[bin] += count
    }
  }

  for (let bin = first; bin <= last; bin++) {
    if (counts[bin] >= need) out[bin] = sums[bin] / cells
  }
  return out
}
