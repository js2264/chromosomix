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
 * ## The track, and the borders under it
 *
 * Dixon's own segmentation was a three-state HMM over this track — downstream
 * biased, upstream biased, neither — and a domain ran from the first bin of a
 * downstream-biased run to the last bin of the upstream-biased run before the
 * next one. What {@link directionBorders} does instead is integrate the index and
 * call the curve's minima by their prominence ({@link callBoundaries}) — the
 * reading the diamond's boundaries are made by too; the reasoning for that
 * choice, and what it costs, is at {@link integratedDirection}. The two
 * outputs differ in one visible way worth knowing before comparing a domain set
 * against a published one: the HMM leaves *gaps* — stretches it calls
 * unorganised and puts in no domain — and borders-between-borders tile, so every
 * base of a scored sequence is inside exactly one domain.
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
import { callBoundaries, type Boundary } from './insulation'

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

/**
 * The running sum of the index, standardised — the curve whose minima are the
 * domain borders.
 *
 * ## Why the integral, rather than the sign flips themselves
 *
 * The reading the index gives of a domain is a **shape along the sequence**, not
 * a value at a bin: the 5′ half of a domain looks downstream and the 3′ half
 * looks upstream, so one domain is a positive block followed by a negative one
 * and the border between two domains is where the track crosses from negative
 * back to positive. Read crossing by crossing that is a fragile thing to call —
 * a track that stutters `− − + − + + +` has two crossings a bin apart and only
 * one of them is a border, and the rules that pick the right one are the rules
 * of prominence written out badly.
 *
 * Summing the index turns the shape into a topography. The curve climbs through
 * every downstream-biased block and falls through every upstream-biased one, so
 * **each border is a local minimum** and a stutter is a shallow dimple on the
 * flank of the real trough — which is exactly the distinction a prominence
 * draws. {@link callBoundaries} scores each minimum by how far the curve must
 * climb on both sides before it falls lower, the same topographic prominence
 * cooltools' `find_boundaries` reads off the diamond's track
 * (`insulationBoundaries`, which is what the diamond is called by now).
 * So a border of this task and a boundary of that one mean the same kind of
 * thing, though they are no longer called by one kernel: the diamond's follow
 * cooltools' own rule to the pixel, mask and all.
 *
 * ## Why it is standardised first
 *
 * The index is a χ², so its size grows with how deep the map is: the same domain
 * in a library sequenced twice as far scores roughly twice as high. An absolute
 * threshold on the raw integral would therefore be a different threshold on
 * every file, and a reader who found a good one would find it again from scratch
 * on the next map. Dividing by the **median absolute index** over the sequence
 * removes that: the curve then climbs by about one unit per bin through a block
 * of typical strength, and a prominence reads as *how many bins of ordinary
 * directional bias this arm carries*, which is a property of the structure
 * rather than of the sequencing.
 *
 * Bins the index left as gaps stay gaps here — the sum carries across them but
 * emits nothing, so a dropped stretch cannot be the floor of a trough and cannot
 * invent a border at its edge. What the carry does mean is that a long gap glues
 * the two sides together rather than restarting the curve, which is the gentler
 * of the two wrong answers: restarting would put a step in the curve, and a step
 * is a minimum.
 */
export function integratedDirection(di: ArrayLike<number>): Float64Array {
  const n = di.length
  const out = new Float64Array(n).fill(Number.NaN)

  const magnitudes: number[] = []
  for (let i = 0; i < n; i++) {
    const value = di[i]
    if (Number.isFinite(value)) magnitudes.push(Math.abs(value))
  }
  if (magnitudes.length === 0) return out
  magnitudes.sort((a, b) => a - b)
  const scale = magnitudes[magnitudes.length >> 1]
  // Every bin even-handed, or every one of them a gap. Either way there is no
  // structure to integrate and no scale to divide by, and the honest curve is
  // the one that says nothing rather than one built on a division by zero.
  if (!(scale > 0)) return out

  let total = 0
  for (let i = 0; i < n; i++) {
    const value = di[i]
    if (!Number.isFinite(value)) continue
    total += value / scale
    out[i] = total
  }
  return out
}

/** One called domain border, in bins local to its sequence. */
export interface DirectionBorderOptions {
  /**
   * How far the integrated curve must climb on both sides of a minimum, in bins
   * of ordinary directional bias. See {@link integratedDirection} for what the
   * unit means and why it is not the index's own.
   */
  prominence: number
  /** Minimum gap between two calls, in bins. */
  spacing: number
}

/**
 * The domain borders of one sequence, from its index.
 *
 * **The call lands one bin past the minimum**, and the bin matters. The floor of
 * a trough in the integrated curve is the last bin that still looks *upstream* —
 * the last bin of the domain that is ending — so the border itself, the first
 * bin that looks downstream, is the one after it. Reporting the minimum would
 * put every border one bin early and every domain one bin adrift of the domain
 * it is meant to be, which at 40 kb is 40 kb of somebody else's TAD at each end.
 *
 * The prominence is carried through from the curve rather than recomputed, so it
 * is comparable with the number in {@link Boundary} the diamond reports even
 * though the two are in different units — both answer *how far does the track
 * have to climb to escape this call*, which is what a reader filtering an
 * overlay on its score is asking.
 */
export function directionBorders(
  di: ArrayLike<number>,
  options: DirectionBorderOptions,
): Boundary[] {
  const n = di.length
  const minima = callBoundaries(integratedDirection(di), {
    prominence: options.prominence,
    spacing: options.spacing,
  })
  const out: Boundary[] = []
  const seen = new Set<number>()
  for (const minimum of minima) {
    const bin = minimum.bin + 1
    // A minimum on the last bin has no bin after it to be the border of, and
    // the same call arriving twice is one border: both are the shift's doing
    // rather than the curve's, so both are dropped here rather than left for
    // the BED writer to trip over.
    if (bin >= n || seen.has(bin)) continue
    seen.add(bin)
    out.push({ bin, score: di[bin], prominence: minimum.prominence })
  }
  return out
}
