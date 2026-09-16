/**
 * The HiC score: how much contact a bin makes with its near neighbourhood, as
 * one number per bin.
 *
 * Bignaud et al. use it on maps where the thing being looked for is not a domain
 * boundary but a change in how tightly a stretch of the genome is folded against
 * itself — a transcribed region that has lost its local structure, a phage
 * genome that has gained one. The reading is deliberately blunt: take the bin's
 * own line across the near-diagonal and average it.
 *
 * ## What it is, exactly
 *
 * For bin `k` over `D` diagonals counting the main one — so separations
 * `0 … D − 1`:
 *
 * ```
 *                 1    D−1
 * HiC score(k) = ───    Σ    a[k, k + d]        d running −(D−1) … +(D−1)
 *                 N   d=−(D−1)
 * ```
 *
 * — the cells of **column `k` itself**, reaching `D − 1` bins each way, over
 * `N = 2D − 1`, the number of them. Every cell in it touches bin `k`: this is
 * *how much contact this bin makes*, not how dense contact is in the
 * neighbourhood around it.
 *
 * ## Half a crosshair, not a whole one
 *
 * Drawn on a map the shape is a **straight line through the diagonal** — one
 * arm-pair of the cross, not the cross. The matrix is symmetric, so the row and
 * the column carry the same contacts under two names, and summing both would
 * count every off-diagonal contact twice while counting the main diagonal once.
 * One arm-pair counts each contact exactly once. (On the E. coli map this was
 * checked against, the whole cross would say 4.918 where the line says 3.743.)
 *
 * The same argument in a different shape as the square-window reading this
 * replaced: **half of a symmetric figure, with the main diagonal kept whole**.
 * What changed is which figure. A square window also counts contacts *between*
 * `k`'s neighbours — the self-contact of `k − 1`, the corner joining `k − 1` to
 * `k + 1` — none of which involves `k` at all, and on a bacterial map those
 * borrowed cells make consecutive bins share half their score and the track come
 * out as a three-bin plateau. The line borrows nothing: a bright bin is bright
 * in its own score and nowhere else.
 *
 * ## Missing cells, and lines that run off the end
 *
 * Two different things, and they are answered differently.
 *
 * A **partial line** — a bin closer to the end of a linear sequence than the
 * score reaches — gets no score at all. Dividing a short sum by the full `N`
 * would fade both ends of every chromosome out towards zero, which reads as
 * *this end is unstructured* and is the artefact the diamond refuses partial
 * windows for (§18.5). On a circular sequence there is no end to run off, the
 * line wraps, and every bin scores.
 *
 * A **dropped cell** inside a whole line is counted rather than guessed at. A
 * balanced matrix drops whole rows (§6.4) and a line crossing a dropped stretch
 * has a genuinely smaller mean; the sum is never scaled up to pretend the
 * missing cells were average, which would be inventing the data the balancer
 * deliberately refused to supply, and a bin that has lost more than `minValid`
 * of its line scores `NaN` rather than a small number.
 */

import type { SeparationBand } from './band'

export interface HicScoreOptions {
  /**
   * Diagonals the line spans, **counting the main one**: `3` is the main
   * diagonal and the two either side of it, which reaches two bins each way.
   */
  diagonals: number
  /** The fraction of the line's cells that must carry a value. */
  minValid: number
  /**
   * Separations to leave out, as `ignore_diags` elsewhere: `0` counts every
   * cell, `1` drops the main diagonal, `2` drops it and the cells one bin
   * apart — the rule is `|col − row| < ignore`, as everywhere else here.
   *
   * `0` by default, because the score is a statement about *all* the contact a
   * bin makes and the near-diagonal is most of it. It matters more here than it
   * looks: at three diagonals the main diagonal is the bulk of the line, it is
   * where self-ligation and undigested fragments land, and on a balanced map it
   * is the one place the weights were never fitted — cooler's balancer excludes
   * `ignore_diags` diagonals from its own solve and then scales them anyway. A
   * score carried by that cell is a score carried by the protocol.
   *
   * `N` is reduced with it, so the score stays a mean of the cells it actually
   * counts rather than a sum over some of them divided by all of them.
   */
  ignoreDiags?: number
}

/**
 * `N`: cells in the line, less the cut diagonals.
 *
 * One cell on the main diagonal and **two on every other** — the line crosses
 * each separation once each side — so `D` diagonals give `2D − 1` cells. Summed
 * rather than solved for because `ignoreDiags` takes the first few off the
 * front, and the closed form for that has a special case at zero that is exactly
 * the kind of thing nobody checks.
 *
 * Exported because the runner quotes it in a note and the tests check the
 * arithmetic the header argues about.
 */
export function lineCells(diagonals: number, ignoreDiags = 0): number {
  const far = Math.max(1, Math.trunc(diagonals)) - 1
  const ignore = Math.max(0, Math.trunc(ignoreDiags))
  let cells = 0
  for (let sep = ignore; sep <= far; sep++) cells += sep === 0 ? 1 : 2
  return cells
}

/**
 * The score at every bin of the band, in the band's own local bins.
 *
 * The band must reach `diagonals − 1`, which is the widest separation the line
 * touches. A shallower one answers `NaN` past its depth and those cells are
 * counted as missing, which the `minValid` guard will then notice.
 */
export function hicScore(band: SeparationBand, options: HicScoreOptions): Float64Array {
  const n = band.n
  const far = Math.max(1, Math.trunc(options.diagonals)) - 1
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const out = new Float64Array(n).fill(Number.NaN)
  if (n === 0) return out

  // `N`, and the threshold under it: `minValid` is a fraction of what the line
  // could actually hold, so cutting diagonals moves both together.
  const cells = lineCells(far + 1, ignore)
  if (cells <= 0) return out
  const need = Math.max(1, Math.ceil(cells * Math.max(0, Math.min(1, options.minValid))))

  // Bins with a whole line through them. On a line of sequence that is
  // everything but the two ends; on a circle it is every bin, because the line
  // wraps. Scoring only these is what keeps a short sum from being divided by a
  // full `N` — see the header.
  const first = band.circular ? 0 : far
  const last = band.circular ? n - 1 : n - 1 - far
  if (last < first) return out

  for (let bin = first; bin <= last; bin++) {
    let sum = 0
    let count = 0
    // The line itself, written as the two arms it is. `forward` takes a negative
    // offset and means what it says — the cell that many bins *before* `bin` —
    // so the upstream arm needs no index arithmetic here and no separate wrap.
    for (let sep = ignore; sep <= far; sep++) {
      const down = band.forward(bin, sep)
      if (Number.isFinite(down)) {
        sum += down
        count++
      }
      // The main diagonal is one cell and is not walked twice.
      if (sep === 0) continue
      const up = band.forward(bin, -sep)
      if (Number.isFinite(up)) {
        sum += up
        count++
      }
    }
    if (count >= need) out[bin] = sum / cells
  }
  return out
}
