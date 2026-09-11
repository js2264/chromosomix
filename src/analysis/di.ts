/**
 * The directionality index — Dixon et al. 2012's statistic, and the first thing
 * anybody computed from a Hi-C map that was a *track* rather than a picture.
 *
 * The question it asks at every bin is the one a reader asks by eye at a domain
 * edge: **does this bin talk upstream or downstream?** Inside a domain the two
 * are about equal, because the bin is surrounded by the same neighbourhood on
 * both sides. At the left edge of a domain nearly everything is downstream, at
 * the right edge nearly everything is upstream, and the sign flip between the
 * two is what the original paper's HMM segmented into TADs.
 *
 * ## The statistic
 *
 * With `A` the contacts in the window upstream of the bin and `B` the contacts
 * in the window downstream:
 *
 * ```
 * DI = sign(B − A) · (A − E)²/E + (B − E)²/E,   E = (A + B)/2
 * ```
 *
 * which is a signed χ² against the null that the bin is even-handed. Written out
 * it collapses to `sign(B − A) · (A − B)² / (A + B)`, and {@link directionalityIndex}
 * computes it in that form — one division rather than three, identical to the
 * last bit, and much harder to get subtly wrong. The identity is worth checking
 * once: `A − E = (A − B)/2` and `B − E = (B − A)/2`, so the bracket is
 * `((A − B)²/4 + (A − B)²/4) / E = (A − B)²/(2E) = (A − B)²/(A + B)`.
 *
 * ## Three things that decide whether the track means anything
 *
 * **The window never crosses a contig boundary.** `analysis/insulation.ts` says
 * this first and for the same reason: a window straddling the join between two
 * sequences compares contacts with `chrIV` against contacts with `chrV` and
 * reports the answer as a property of a position. On a metagenome that join is
 * between two organisms. So the band a caller passes is one sequence's, and on a
 * linear one the first and last `window` bins score `NaN` because their window
 * genuinely runs off the end.
 *
 * **Unless the sequence is circular**, in which case there is no end for it to
 * run off and every bin scores. That is not a special case in the arithmetic at
 * all — it is entirely inside {@link SeparationBand.forward} — which is why this
 * module can be read without thinking about it and why the wrap can only be
 * wrong in one place.
 *
 * **A bin whose window is mostly missing scores `NaN`, not a small number.**
 * Inside a balanced matrix whole rows are dropped (§6.4), and a bin next to a
 * dropped stretch has an `A` summed over three cells and a `B` summed over
 * fifty. The χ² of those two is enormous and entirely artefactual, and it lands
 * next to exactly the repeat-rich, unmappable regions a reader is most likely to
 * mistake for a boundary. {@link DirectionalityOptions.minValid} is what stops
 * it, and it is a fraction of each side separately rather than of the pair: a
 * bin with a full window one way and an empty window the other is the worst case
 * of all and would pass a test on the total.
 */

import type { SeparationBand } from './band'

export interface DirectionalityOptions {
  /** How far the statistic looks each way, in bins. */
  window: number
  /**
   * The fraction of each side's cells that must carry a value.
   *
   * Checked on the upstream and downstream sums *separately*; see the module
   * docstring for why the total will not do.
   */
  minValid: number
  /**
   * Separations to leave out of both sums, as `ignore_diags` everywhere else in
   * this subtree: `0` counts every cell, `1` drops the main diagonal, `2` drops
   * it and the two beside it.
   *
   * **`0` by default, unlike the diamond's `2`,** and the difference is real
   * rather than an oversight. Insulation *sums* the near-diagonal, so the
   * self-ligation spike at one and two bins of separation can be most of what it
   * is measuring. The directionality index *differences* two sums that both
   * contain it, so it largely cancels — and Dixon's own figures were computed
   * with every cell in. A reader comparing against a published DI track wants
   * the published arithmetic; a reader who can see their near-diagonal is
   * pathological can raise it.
   *
   * The main diagonal is never in either sum whatever this is set to: the bin's
   * contact with itself is neither upstream nor downstream of itself.
   */
  ignoreDiags?: number
}

/**
 * The index at every bin of the band, in the band's own local bins.
 *
 * `Float64Array` because a χ² over raw counts on a deep map is a large number
 * and the sums behind it are larger; the track is written out as `Float32` like
 * every other, and the rounding belongs at that boundary rather than in the
 * middle of the arithmetic.
 */
export function directionalityIndex(
  band: SeparationBand,
  options: DirectionalityOptions,
): Float64Array {
  const n = band.n
  const window = Math.max(1, Math.trunc(options.window))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  // The first separation either sum counts. `ignore_diags` counts the main
  // diagonal as one, and the main diagonal is not in either sum, so `0` and `1`
  // mean the same thing here and `2` starts at two bins of separation.
  const first = Math.max(1, ignore)
  const out = new Float64Array(n).fill(Number.NaN)
  if (window < first) return out

  // Cells per side, so `minValid` is a fraction of something countable. The
  // same care `diamondCells` takes for the diamond, and for the same reason: a
  // threshold computed against cells that can never be counted scores `NaN` at
  // bins whose window was perfectly good.
  const perSide = window - first + 1
  const need = Math.max(1, Math.ceil(perSide * Math.max(0, Math.min(1, options.minValid))))

  for (let bin = 0; bin < n; bin++) {
    let upstream = 0
    let downstream = 0
    let upValid = 0
    let downValid = 0
    for (let d = first; d <= window; d++) {
      // Downstream is the cell `d` along; upstream is the cell `d` along from
      // the bin `d` back, which is the same cell read from the other end. On a
      // circular band both wrap and neither loop knows it.
      const ahead = band.forward(bin, d)
      if (Number.isFinite(ahead)) {
        downstream += ahead
        downValid++
      }
      const behind = band.forward(bin - d, d)
      if (Number.isFinite(behind)) {
        upstream += behind
        upValid++
      }
    }
    if (upValid < need || downValid < need) continue

    const total = upstream + downstream
    // Not a zero: a bin with no contacts either way has no direction, and
    // reporting `0` would put it on the axis beside the bins that are genuinely
    // even-handed. A gap is what the rest of this subtree draws for *nothing to
    // say*, and it is what a bigWig written from this will carry.
    if (!(total > 0)) continue
    const difference = upstream - downstream
    const chi = (difference * difference) / total
    out[bin] = downstream >= upstream ? chi : -chi
  }
  return out
}
