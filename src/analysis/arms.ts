/**
 * A bacterial chromosome read in the frame of its two arms.
 *
 * Replication runs from one origin in both directions, so a bacterial
 * chromosome is two **arms** (replichores) that meet again at the terminus. In
 * many species they are held side by side — by SMC loaded at parS near the
 * origin — and a locus then touches not only its neighbours along its own arm
 * but its mirror image on the other one. The map shows both: the ordinary
 * diagonal, and a **secondary diagonal** perpendicular to it through the origin,
 * the inter-arm contacts (Le et al. 2013; Wang et al. 2017).
 *
 * The ordinary expected curve knows only the first. It averages each diagonal
 * of the map, and every diagonal crosses the secondary one, so the average is
 * inflated by it: the secondary diagonal comes out of an observed/expected map
 * brighter than anything else, everything else darker than it should be, and a
 * correlation of that map is dominated by the X it draws — its leading
 * eigenvectors are the arms, not compartments. This module is the expected that
 * removes both diagonals.
 *
 * ## Coordinates
 *
 * Each bin gets its **offset from the origin**, `u` — signed, and on a circle
 * the short way round, so it runs from −n/2 to n/2. `|u|` is how far along its
 * arm a bin is, and its sign is which arm. Two bins then have a
 * **longitudinal separation** `Δ = ||uᵢ| − |uⱼ||` — how far apart they are
 * along the ori–ter axis — and a **position** `Σ = |uᵢ| + |uⱼ|`, twice how far
 * from the origin the pair sits. On one arm `Δ` is the ordinary separation along
 * the DNA; across the two arms it is the distance from the secondary diagonal.
 *
 * ## The expectation
 *
 * A cell is compared with the cells of **its own kind** — same arm, or opposite
 * arms — at the **same `Δ`**, taken within `window` bins of its own position
 * along the arms. The window is what lets the expectation follow what changes
 * slowly from origin to terminus — the arms are most tightly aligned near the
 * origin — without following what changes quickly, which is the compartment
 * plaid left behind for the correlation to find. `0` takes every cell of that
 * kind and separation on the sequence, which is the arm-frame reading of the
 * ordinary chromosome-wide expected.
 *
 * **Where the two diagonals cross — at the origin and at the terminus — the
 * expectation is at its weakest.** A pair straddling either is close along the
 * DNA however far apart the two arms put it, and the window averages it with
 * pairs that are not; within about a window of each crossing the ratio is less
 * to be believed than elsewhere. That is stated rather than corrected, because
 * the correction is a model of the crossing, and the crossing is two small
 * stretches of a chromosome.
 *
 * Pure: arrays in, arrays out, no worker and no file.
 */

/** Where the arms of one sequence meet, in its own bins. */
export interface ArmFrame {
  /** Bins in the sequence. */
  n: number
  /** The bin the origin falls in, `0 ≤ origin < n`. */
  origin: number
  /** Whether the sequence joins its own ends (§8.15). */
  circular: boolean
}

/**
 * Each bin's signed offset from the origin.
 *
 * On a circle, the short way round: `−⌊n/2⌋ … ⌈n/2⌉ − 1`, so the bin opposite
 * the origin is on one arm and not on both. On a line, simply `i − origin`, and
 * the two arms are as long as the sequence either side of the origin makes them.
 */
export function armOffsets(frame: ArmFrame): Int32Array {
  const { n, origin, circular } = frame
  const out = new Int32Array(n)
  const half = Math.floor(n / 2)
  for (let i = 0; i < n; i++) {
    const raw = i - origin
    out[i] = circular ? ((((raw + half) % n) + n) % n) - half : raw
  }
  return out
}

/** How far along its arm the farthest bin is — `max |u|`. */
function longestArm(offsets: ArrayLike<number>): number {
  let most = 0
  for (let i = 0; i < offsets.length; i++) most = Math.max(most, Math.abs(offsets[i]))
  return most
}

/**
 * The arm-frame expectation of every cell of a block of one sequence.
 *
 * `values` is row-major, `rowBins.length × colBins.length`, and the two arrays
 * say which bin of the sequence each row and column is — which is what lets the
 * block be anything from the whole square to a window of it, or the square
 * rotated so the origin is in the middle, and still be read in the one frame.
 * A cell with no value contributes nothing and is still given an expectation:
 * a gap in the observed matrix is not a gap in the model, and masking it is the
 * caller's business.
 *
 * @param window Half-width, in bins, of the stretch along the arms each cell is
 *   compared within; `0` for the whole sequence.
 * @returns The expectation per cell; `NaN` where no cell of that kind and
 *   separation had a value anywhere within the window.
 */
export function armExpected(
  values: ArrayLike<number>,
  rowBins: ArrayLike<number>,
  colBins: ArrayLike<number>,
  frame: ArmFrame,
  window: number,
): Float64Array {
  const offsets = armOffsets(frame)
  const nrows = rowBins.length
  const ncols = colBins.length
  // Sized by the longest arm there is. On a circle that is half the sequence,
  // and on a line it is whichever side of the origin is longer — up to all of
  // it, with the origin at an end — so a table sized for a circle dropped the
  // far cells of a line and folded its largest Σ into the next Δ.
  const maxArm = longestArm(offsets)
  const maxDelta = maxArm + 1
  const maxSigma = 2 * maxArm + 1
  const whole = !(window > 0)
  // Σ is bucketed a quarter-window at a time: a box filter `window` bins wide
  // does not need every bin of Σ, and the table is then small enough for any
  // sequence the correlation downstream can afford. `0` needs no Σ at all.
  const bucket = whole ? maxSigma : Math.max(1, Math.floor(window / 4))
  const buckets = Math.ceil(maxSigma / bucket)
  const reach = whole ? buckets : Math.max(1, Math.ceil(window / bucket))

  // Two tables, one per kind, indexed [Δ][bucket of Σ].
  const sums = [new Float64Array(maxDelta * buckets), new Float64Array(maxDelta * buckets)]
  const counts = [new Float64Array(maxDelta * buckets), new Float64Array(maxDelta * buckets)]
  const cellKey = (r: number, c: number): { kind: 0 | 1; delta: number; slot: number } => {
    const ur = offsets[rowBins[r]]
    const uc = offsets[colBins[c]]
    const ar = Math.abs(ur)
    const ac = Math.abs(uc)
    // The origin bin is on the first arm, which is the whole of what `>= 0` says.
    const kind: 0 | 1 = ur >= 0 === uc >= 0 ? 0 : 1
    return { kind, delta: Math.abs(ar - ac), slot: Math.floor((ar + ac) / bucket) }
  }

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const value = values[r * ncols + c]
      if (!Number.isFinite(value)) continue
      const { kind, delta, slot } = cellKey(r, c)
      const at = delta * buckets + slot
      sums[kind][at] += value
      counts[kind][at] += 1
    }
  }

  // The box filter along Σ, per kind and Δ, as prefix sums over the buckets.
  const means = [new Float64Array(maxDelta * buckets), new Float64Array(maxDelta * buckets)]
  for (let kind = 0; kind < 2; kind++) {
    const prefixSum = new Float64Array(buckets + 1)
    const prefixCount = new Float64Array(buckets + 1)
    for (let delta = 0; delta < maxDelta; delta++) {
      const row = delta * buckets
      for (let b = 0; b < buckets; b++) {
        prefixSum[b + 1] = prefixSum[b] + sums[kind][row + b]
        prefixCount[b + 1] = prefixCount[b] + counts[kind][row + b]
      }
      for (let b = 0; b < buckets; b++) {
        const lo = Math.max(0, b - reach)
        const hi = Math.min(buckets, b + reach + 1)
        const count = prefixCount[hi] - prefixCount[lo]
        means[kind][row + b] = count > 0 ? (prefixSum[hi] - prefixSum[lo]) / count : Number.NaN
      }
    }
  }

  const out = new Float64Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const { kind, delta, slot } = cellKey(r, c)
      out[r * ncols + c] = means[kind][delta * buckets + slot]
    }
  }
  return out
}

/** A decay curve per separation, in the shape `analysis/expected.ts`'s curves have. */
export interface ArmDecayCurve {
  maxOffset: number
  sum: Float64Array
  count: Float64Array
  mean: Float64Array
}

/**
 * The decay along both arms, averaged over the whole of them: for each kind of
 * pair — **within an arm**, or **across the arms** — the mean cell at each
 * longitudinal separation `Δ`.
 *
 * Within an arm, `Δ` is the ordinary separation along the DNA and the curve is
 * the main diagonal's decay with the secondary diagonal left out of it; across
 * the arms, `Δ` is the distance from the secondary diagonal and the curve is how
 * the inter-arm contacts fall away from it. These are {@link armExpected}'s two
 * tables at a window of `0`, by `Δ` alone, so a figure of them is a figure of
 * the expectation that whole-sequence detrending divides by; the windowed one
 * follows them along the arms. Pure, and `NaN` where no cell of that kind and
 * separation had a value.
 */
export function armDecay(
  values: ArrayLike<number>,
  frame: ArmFrame,
): { within: ArmDecayCurve; across: ArmDecayCurve } {
  const { n } = frame
  const offsets = armOffsets(frame)
  const maxOffset = longestArm(offsets)
  const curve = (): ArmDecayCurve => ({
    maxOffset,
    sum: new Float64Array(maxOffset + 1),
    count: new Float64Array(maxOffset + 1),
    mean: new Float64Array(maxOffset + 1),
  })
  const within = curve()
  const across = curve()
  for (let r = 0; r < n; r++) {
    const ur = offsets[r]
    const ar = Math.abs(ur)
    for (let c = 0; c < n; c++) {
      const value = values[r * n + c]
      if (!Number.isFinite(value)) continue
      const uc = offsets[c]
      // The origin bin is on the first arm, as `armExpected` reads it.
      const kind = ur >= 0 === uc >= 0 ? within : across
      const delta = Math.abs(ar - Math.abs(uc))
      kind.sum[delta] += value
      kind.count[delta] += 1
    }
  }
  for (const kind of [within, across]) {
    for (let d = 0; d <= maxOffset; d++) {
      kind.mean[d] = kind.count[d] > 0 ? kind.sum[d] / kind.count[d] : Number.NaN
    }
  }
  return { within, across }
}

/**
 * How strongly the two arms are aligned, along their length.
 *
 * Read off an observed/expected map whose expectation is the **ordinary** one —
 * the distance decay alone, which is what makes the secondary diagonal stand out
 * of it — as the mean ratio over the cells within `band` bins of the secondary
 * diagonal: opposite arms, `Δ ≤ band`.
 *
 * **Only where the two diagonals are apart.** Near the origin and the terminus
 * the secondary diagonal runs into the main one, and its cells there are pairs
 * a few bins apart along the DNA, whose ratio says how compact that stretch is
 * rather than whether the arms are aligned — the terminus macrodomain of
 * *E. coli* is compact and has no aligned arms at all. So a cell closer to the
 * main diagonal than `2 × band + 2` bins is left out, which is exactly where the
 * two bands would overlap.
 *
 * Two readings of the same cells:
 *
 * - **by distance from the origin**, `(|uᵢ| + |uⱼ|) / 2` rounded to a bin — the
 *   profile a figure plots, rising from the origin as the two diagonals part and
 *   falling towards the terminus as the alignment is lost;
 * - **per bin**, the mean over each bin's own row of those cells — how much this
 *   locus touches its mirror image, as a track along the chromosome.
 *
 * `NaN` where no such cell had a value.
 */
export function interArmProfile(
  oe: ArrayLike<number>,
  frame: ArmFrame,
  band: number,
): { byDistance: Float64Array; byBin: Float64Array } {
  const { n, circular } = frame
  const offsets = armOffsets(frame)
  const reach = Math.max(0, Math.round(band))
  const apart = 2 * reach + 2
  const half = longestArm(offsets) + 1
  const distanceSum = new Float64Array(half)
  const distanceCount = new Float64Array(half)
  const binSum = new Float64Array(n)
  const binCount = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    const ur = offsets[r]
    const ar = Math.abs(ur)
    for (let c = 0; c < n; c++) {
      const uc = offsets[c]
      if (ur >= 0 === uc >= 0) continue
      const ac = Math.abs(uc)
      if (Math.abs(ar - ac) > reach) continue
      const straight = Math.abs(r - c)
      if ((circular ? Math.min(straight, n - straight) : straight) < apart) continue
      const value = oe[r * n + c]
      if (!Number.isFinite(value)) continue
      const d = Math.min(half - 1, Math.round((ar + ac) / 2))
      distanceSum[d] += value
      distanceCount[d] += 1
      binSum[r] += value
      binCount[r] += 1
    }
  }
  const byDistance = new Float64Array(half)
  for (let d = 0; d < half; d++) {
    byDistance[d] = distanceCount[d] > 0 ? distanceSum[d] / distanceCount[d] : Number.NaN
  }
  const byBin = new Float64Array(n)
  for (let i = 0; i < n; i++) byBin[i] = binCount[i] > 0 ? binSum[i] / binCount[i] : Number.NaN
  return { byDistance, byBin }
}

/**
 * The half-width of the running mean the peak and the reach are read from, as a
 * share of the arm.
 */
const SUMMARY_SMOOTHING = 0.02

/**
 * Where the reach ends: the share of the peak's `log2` the running mean must
 * fall below, so `0.2` is four-fifths of the way back to no enrichment.
 */
const REACH_FLOOR = 0.2

/**
 * Two numbers for comparing one chromosome's arm alignment with another's.
 *
 * - **reach** — how far from the origin the enrichment holds: going outwards
 *   from its peak, the last distance before it first falls below a fifth of it,
 *   in bins — where the alignment ends, rather than where it is half-way down.
 *   A species whose arms are zipped from origin to terminus reaches most of the
 *   arm; one whose alignment is confined round parS reaches a fraction. Half of
 *   the peak was the floor first, and it read the middle of the fall: where the
 *   alignment is still spreading out from parS its edge is a slope tens of bins
 *   long, and half-way down it is well behind the last aligned loci — a time
 *   course of ParB induced in *B. subtilis* reached 600 kb at 15 minutes and
 *   1.5 Mb at 45, where a fifth of the peak reads 930 kb and 1.9 Mb.
 * - **score** — how strong it is **over that stretch**: the mean `log2`
 *   enrichment of the secondary diagonal from the origin out to the reach. So
 *   the two say different things — how far, and how strongly within it — where a
 *   mean over the whole arm is both at once, and a strong alignment confined
 *   round parS reads there like a weak one that runs to the terminus. It is
 *   read over the stretch that holds above a fifth of the peak, so on a
 *   chromosome whose arms are not aligned it is the mean of the noise's highest
 *   stretch and reads above zero: 0.29 on *E. coli* at 5 kb, where the whole
 *   arm's mean is 0.08. Where nothing reaches — no stretch above zero at all — it is the mean
 *   over the whole arm.
 *
 * `over`, where given, is the stretch to average over in place of this
 * profile's own reach: another profile's, so that a control is read over the
 * same distances as the measurement it controls. `NaN` there is the whole arm.
 *
 * The peak and the reach are read from a **running mean over 2% of the arm**
 * either side. Read cell by cell, one noisy distance set the peak, and the last
 * distance anywhere above the floor set the reach — which on a flat profile is
 * wherever the noise last happened to be high: *Escherichia coli*, whose arms
 * are not aligned at all, was reported as aligned to within a few bins of its
 * terminus.
 *
 * `NaN` for the reach where there is no enrichment to measure. The score and the
 * peak are `log2`; the task's table gives them as folds over expected, two to
 * these (§18.8).
 */
export function interArmSummary(
  byDistance: ArrayLike<number>,
  over?: number,
): { score: number; reach: number; peak: number } {
  let seen = 0
  const n = byDistance.length
  const logs = new Float64Array(n)
  for (let d = 0; d < n; d++) {
    const value = byDistance[d]
    logs[d] = value > 0 ? Math.log2(value) : Number.NaN
    if (Number.isFinite(logs[d])) seen++
  }
  if (seen === 0) return { score: Number.NaN, reach: Number.NaN, peak: Number.NaN }
  const k = Math.max(1, Math.round(n * SUMMARY_SMOOTHING))
  const smoothed = new Float64Array(n).fill(Number.NaN)
  let peak = Number.NEGATIVE_INFINITY
  let at = -1
  for (let d = 0; d < n; d++) {
    let sum = 0
    let count = 0
    for (let e = Math.max(0, d - k); e <= Math.min(n - 1, d + k); e++) {
      if (!Number.isFinite(logs[e])) continue
      sum += logs[e]
      count++
    }
    if (count === 0) continue
    smoothed[d] = sum / count
    if (smoothed[d] > peak) {
      peak = smoothed[d]
      at = d
    }
  }
  let reach = Number.NaN
  if (peak > 0) {
    reach = at
    for (let d = at + 1; d < n; d++) {
      if (!Number.isFinite(smoothed[d])) continue
      if (smoothed[d] < peak * REACH_FLOOR) break
      reach = d
    }
  }
  // From the origin out to the reach — this profile's own, or the stretch handed
  // in — and over the whole arm where there is none.
  const stretch = over === undefined ? reach : over
  const last = Number.isFinite(stretch) ? Math.min(n - 1, Math.max(0, Math.floor(stretch))) : n - 1
  let total = 0
  let counted = 0
  for (let d = 0; d <= last; d++) {
    if (!Number.isFinite(logs[d])) continue
    total += logs[d]
    counted++
  }
  return { score: counted > 0 ? total / counted : Number.NaN, reach, peak }
}
