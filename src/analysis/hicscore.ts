/**
 * The HiC score: how much contact there is *around* a position, as one number
 * per bin.
 *
 * Bignaud et al. use it on maps where the thing being looked for is not a domain
 * boundary but a change in how tightly a stretch of the genome is folded against
 * itself — a transcribed region that has lost its local structure, a phage
 * genome that has gained one. The reading is deliberately blunt: put a square
 * window on the diagonal, centred on the bin, and add up everything inside it.
 *
 * ## What it is, exactly
 *
 * For bin `i` and a square `2h + 1` bins on a side:
 *
 * ```
 * score(i) = Σ M[r, c]   for r, c ∈ [i − h, i + h]
 * ```
 *
 * The **whole square**, not a band and not a triangle: cells on both sides of
 * the diagonal, the diagonal itself, and the corners where the two ends of the
 * window contact each other. That last part is the half of it that insulation
 * throws away and this one keeps, and it is why the two tracks are not the same
 * track smoothed differently — a bin in a compact domain has bright corners and
 * a bin in an open one does not.
 *
 * ## Why it is computed one diagonal at a time
 *
 * The obvious loop is `(2h + 1)²` additions per bin, which at a 200 kb window on
 * a 1 kb map is forty thousand per bin and four hundred million over a bacterial
 * chromosome — before anything is drawn. What is here is the same sum in
 * `2h + 1` passes: each **diagonal** of the band is walked once with a running
 * prefix sum, and every bin's window takes a constant number of lookups from it.
 * That is `O(n · h)` rather than `O(n · h²)`, holds one row of prefix at a time
 * rather than the band twice over, and is exact rather than approximate — it is
 * the same addition in a different order.
 *
 * The symmetry does the other half of the work. The matrix is symmetric, so the
 * cells at separation `−o` inside the square are the cells at `+o` inside it read
 * from the other end, and their sum is the same; each diagonal is therefore
 * walked once and counted twice, with the main diagonal counted once.
 *
 * ## Missing cells
 *
 * Counted rather than guessed at. A balanced matrix drops whole rows (§6.4) and
 * a window overlapping a dropped stretch has a genuinely smaller sum — so the
 * cells that carried a value are counted, and a bin whose window is mostly gone
 * scores `NaN` rather than a small number that reads as *not much contact here*.
 * The sum itself is over what was countable and is never scaled up to pretend
 * the missing cells were average, which would be inventing the data the balancer
 * deliberately refused to supply.
 */

import type { SeparationBand } from './band'

export interface HicScoreOptions {
  /** Half the square's side, in bins: the window reaches this far each way. */
  halfWidth: number
  /** The fraction of the square's cells that must carry a value. */
  minValid: number
  /**
   * Separations to leave out, as `ignore_diags` elsewhere: `0` counts every
   * cell, `1` drops the main diagonal, `2` drops it and the two beside it.
   *
   * `0` by default, because the score is a statement about *all* the contact
   * around a position and the near-diagonal is most of it. It is offered because
   * on a map where self-ligation has not been cleaned out that near-diagonal is
   * an artefact of the library rather than a fact about the fold, and a track
   * carried by it would be a picture of the protocol.
   */
  ignoreDiags?: number
}

/**
 * The score at every bin of the band, in the band's own local bins.
 *
 * The band must reach `2 × halfWidth`, which is the widest separation inside the
 * square — the two far corners. A narrower one leaves those corners `NaN` and
 * they are counted as missing, which the `minValid` guard will then notice.
 */
export function hicScore(band: SeparationBand, options: HicScoreOptions): Float64Array {
  const n = band.n
  const h = Math.max(0, Math.trunc(options.halfWidth))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const out = new Float64Array(n).fill(Number.NaN)
  if (n === 0) return out

  const sums = new Float64Array(n)
  const counts = new Float64Array(n)

  // Cells in a full square, so `minValid` is a fraction of something the window
  // could actually contain. `ignoreDiags` removes `2 × (2h + 1 − d)` of them per
  // cut diagonal `d`, plus the main one.
  const side = 2 * h + 1
  let cells = side * side
  for (let d = 0; d < ignore; d++) {
    if (d > 2 * h) break
    cells -= d === 0 ? side : 2 * (side - d)
  }
  const need = Math.max(1, Math.ceil(Math.max(0, cells) * Math.max(0, Math.min(1, options.minValid))))

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
    // The main diagonal is in the square once; every other is in it twice, once
    // each side.
    const weight = offset === 0 ? 1 : 2

    for (let bin = 0; bin < n; bin++) {
      // Rows whose cell at this separation lands inside the square: the row is
      // at least the window's start and the *column* is at most its end.
      const lo = bin - h
      const hiRow = bin + h - offset
      if (hiRow < lo) continue
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
        const a = Math.max(0, lo)
        const b = Math.min(n - 1, hiRow)
        if (b < a) continue
        sum = prefixSum[b + 1] - prefixSum[a]
        count = prefixCount[b + 1] - prefixCount[a]
      }
      sums[bin] += weight * sum
      counts[bin] += weight * count
    }
  }

  for (let bin = 0; bin < n; bin++) {
    if (counts[bin] >= need) out[bin] = sums[bin]
  }
  return out
}
