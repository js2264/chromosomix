/**
 * The scalogram — Lioy et al. 2018's picture of *how far* each locus reaches.
 *
 * Every other reading of the near-diagonal in this subtree collapses a bin's
 * contacts to one number: how much crosses it, which way it leans, how much
 * there is nearby. The scalogram keeps the **distribution** instead. At each bin
 * it asks: of everything this bin touches, how far away is the nearest tenth?
 * the nearest quarter? the half? — and draws those distances along the genome.
 *
 * What that shows is the thing a contact map makes obvious to the eye and no
 * single track captures: a region whose contacts are all local is a narrow
 * bundle of curves hugging the axis, a region that reaches across the chromosome
 * is the same bundle flung upwards, and a boundary between the two is a step in
 * every curve at once. On a bacterial chromosome it is the standard reading of
 * where the fold is tight and where it is loose; Lioy et al.'s original figures are
 * exactly this, and `HiContacts`' `scalogram()` is the same quantity.
 *
 * ## What is computed
 *
 * For bin `i`, the contact at separation `d` is the pair of cells either side of
 * it — `M[i, i + d]` and `M[i, i − d]` — which on a circular sequence are the two
 * ways round and on a linear one are whichever of the two exists. Those weights
 * are accumulated into a cumulative distribution over `d`, and the quantile `q`
 * is the separation at which that cumulative first reaches `q` of the total.
 *
 * **Interpolated, not rounded to the bin.** The answer is a distance rather than
 * a bin index, and the cumulative between two separations is a straight line
 * through the contact at the second one; taking the first separation that
 * crosses the threshold would quantise every curve onto multiples of the bin
 * size and turn five smooth ribbons into five staircases that all step in the
 * same places. The interpolation is what makes it a scalogram rather than a
 * mosaic.
 *
 * ## Why a *cumulative* distribution and not a mean
 *
 * Because the thing being measured has a heavy tail by construction. Contact
 * probability falls roughly as `1/s`, so the mean separation of a bin's contacts
 * is dominated by the handful of most distant ones and moves by a factor of two
 * when a single far cell is dropped by the balancer. A quantile does not: the
 * median of a bin's contacts is the median whether the far tail was measured
 * well or at all, which is what makes the picture comparable between a deep map
 * and a shallow one.
 *
 * ## What it is *not*
 *
 * Not P(s). P(s) is one curve for a whole sequence — contact against separation,
 * averaged over every bin — and it answers *how does this genome fold*. This is
 * per bin and answers *where does this genome fold differently from itself*. The
 * two are the same numbers summed in different directions, which is why the
 * scalogram sits directly after P(s) in the catalogue and why a reader who has
 * looked at one is exactly the reader who wants the other.
 */

import type { SeparationBand } from './band'

export interface ScalogramOptions {
  /**
   * The quantiles to report, each in `(0, 1)`.
   *
   * Sorted and de-duplicated by {@link scalogram}, because the ribbons are drawn
   * between *consecutive* members and a set given out of order would draw bands
   * between the wrong pairs.
   */
  quantiles: readonly number[]
  /** The widest separation to look out to, in bins. */
  maxDistance: number
  /**
   * Separations to leave out, as `ignore_diags` elsewhere.
   *
   * **`1` by default** — the main diagonal and nothing else. A bin's contact
   * with itself is not a contact at a distance, it is the largest number in the
   * row, and leaving it in would drag every quantile of every bin towards zero
   * by an amount that depends on how much self-ligation the library has. That is
   * a property of the protocol rather than of the fold.
   */
  ignoreDiags?: number
  /**
   * The fraction of separations that must carry a value before a bin is scored.
   *
   * A bin beside a dropped stretch has a cumulative distribution built from
   * whatever survived, and its median can be anywhere. `NaN` is the honest
   * answer, and a gap in the ribbons is what the renderer draws for one.
   */
  minValid: number
}

/** One quantile's track, in the band's own local bins, as a separation in bins. */
export interface ScalogramTrack {
  quantile: number
  /** Separation in **bins**, fractional; `NaN` where the bin was not scored. */
  distance: Float64Array
}

/**
 * The quantile separations at every bin of the band.
 *
 * One track per quantile, in ascending order of quantile — which is ascending
 * order of distance at every bin where the answer is defined, and is what lets
 * the renderer fill between consecutive members without sorting them per pixel.
 */
export function scalogram(band: SeparationBand, options: ScalogramOptions): ScalogramTrack[] {
  const n = band.n
  const quantiles = [...new Set(options.quantiles)]
    .filter((q) => q > 0 && q < 1)
    .sort((a, b) => a - b)
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 1))
  const first = Math.max(1, ignore)
  const maxDistance = Math.max(first, Math.min(Math.trunc(options.maxDistance), band.hi))

  const tracks: ScalogramTrack[] = quantiles.map((quantile) => ({
    quantile,
    distance: new Float64Array(n).fill(Number.NaN),
  }))
  if (quantiles.length === 0 || n === 0 || maxDistance < first) return tracks

  const steps = maxDistance - first + 1
  const need = Math.max(1, Math.ceil(steps * Math.max(0, Math.min(1, options.minValid))))
  // The cumulative for one bin, reused. `steps + 1` long with a zero at the
  // front, so the interpolation below can always look one step back without a
  // bounds test.
  const cumulative = new Float64Array(steps + 1)

  for (let bin = 0; bin < n; bin++) {
    let running = 0
    let valid = 0
    for (let step = 0; step < steps; step++) {
      const d = first + step
      // Both ways along the diagonal. `forward(bin, d)` is the cell `d` after
      // the bin and `forward(bin, -d)` is the cell `d` before it; on a circular
      // sequence those are the two arcs and both exist, on a linear one the
      // second is `NaN` for the first `d` bins and is simply not counted.
      const ahead = band.forward(bin, d)
      const behind = band.forward(bin, -d)
      const hasAhead = Number.isFinite(ahead)
      const hasBehind = Number.isFinite(behind)
      // A separation counts as measured when *either* side of the bin carried a
      // value: at the first bin of a linear sequence only one side ever can, and
      // requiring both would score every sequence's two ends `NaN` for a reason
      // that has nothing to do with the data.
      if (hasAhead || hasBehind) valid++
      running += (hasAhead ? ahead : 0) + (hasBehind ? behind : 0)
      cumulative[step + 1] = running
    }
    const total = cumulative[steps]
    if (valid < need || !(total > 0)) continue

    // One walk of the cumulative per bin, not one per quantile: the quantiles
    // are sorted, so the thresholds are crossed in order and the walk never goes
    // backwards. Over a chromosome at five quantiles that is four fifths of the
    // work saved, and more importantly it is the walk that cannot disagree with
    // itself about where a threshold fell.
    let step = 1
    for (let q = 0; q < quantiles.length; q++) {
      const target = quantiles[q] * total
      while (step < steps && cumulative[step] < target) step++
      const before = cumulative[step - 1]
      const after = cumulative[step]
      // How far between the two separations the threshold falls. A flat span —
      // no contact at all at this separation — puts it at the near end, which is
      // where the cumulative actually reached the value.
      const share = after > before ? (target - before) / (after - before) : 0
      // The sample points are separations, and the cumulative is read as a
      // straight line between two of them. `step − 1` is the separation `before`
      // was reached at, counted from `first`; the clamp is the first bucket,
      // where there is no earlier sample to interpolate from and every contact
      // counted is at exactly `first`.
      tracks[q].distance[bin] = first + Math.max(0, step - 2 + share)
    }
  }
  return tracks
}
