/**
 * Observed/expected, the correlation matrix, the eigenvectors, and the saddle.
 *
 * The chain §18.8 describes, as four pure functions. Each is short; what is long
 * is the reasoning about missing data, because a compartment analysis is where
 * dropped bins do the most damage and where the damage is least visible.
 *
 * **A bin the balancer dropped is excluded from the matrix, not zeroed.** A
 * zeroed row asserts that its bin is uncorrelated with everything — which is a
 * strong, false claim that pulls the eigenvector towards zero there, and which
 * on a chromosome arm full of dropped bins produces a compartment track with a
 * flat region that looks exactly like a real one. So the chain works over an
 * *index* of usable bins and the caller expands the result back over the full
 * grid afterwards, restoring the gaps as gaps.
 *
 * **Phasing is reported, not assumed.** The sign of an eigenvector is arbitrary,
 * and the convention that positive means the active compartment is a convention
 * — it has to be attached to something. Attaching it to a signal the reader
 * chooses, and printing the correlation that was used, is what makes the track's
 * sign a claim rather than an accident. Below a threshold the answer is *I could
 * not tell*, which is a legitimate result and a much better one than a coin flip.
 */

import type { ExpectedCurve } from './expected'
import { expectedAt } from './expected'
import { pearson, quantileEdges } from './stats'

/**
 * The bins of a square that carry enough data to take part.
 *
 * A row is usable when it has at least `minFraction` finite cells. Everything
 * downstream works over this index, which is what keeps a dropped bin out of the
 * correlation rather than in it as a zero.
 */
export function usableBins(
  values: Float32Array,
  n: number,
  minFraction = 0.1,
): Int32Array {
  const keep: number[] = []
  const needed = Math.max(1, Math.ceil(n * minFraction))
  for (let r = 0; r < n; r++) {
    let seen = 0
    for (let c = 0; c < n; c++) if (Number.isFinite(values[r * n + c])) seen++
    if (seen >= needed) keep.push(r)
  }
  return Int32Array.from(keep)
}

/**
 * The square as observed/expected, over the usable bins only.
 *
 * Row-major and `m × m` where `m` is `index.length`. A cell whose expected is
 * unknown — past the end of the curve, or at an offset nothing was measured at —
 * is `NaN` rather than the observed value: dividing by an unknown and keeping the
 * numerator would put raw counts and ratios in the same matrix.
 */
export function observedOverExpected(
  values: Float32Array,
  n: number,
  index: Int32Array,
  curve: ExpectedCurve,
): Float64Array {
  const m = index.length
  const out = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    const row = index[r]
    for (let c = 0; c < m; c++) {
      const col = index[c]
      const observed = values[row * n + col]
      const denominator = expectedAt(curve, Math.abs(col - row))
      out[r * m + c] =
        Number.isFinite(observed) && Number.isFinite(denominator) && denominator !== 0
          ? observed / denominator
          : Number.NaN
    }
  }
  return out
}

/**
 * The Pearson correlation between every pair of rows.
 *
 * This is the `m²` object §18.6 gates on, and it is built once and handed
 * straight to the eigensolver, which consumes it in place. The diagonal is
 * exactly 1 by construction rather than by computation — a row correlated with
 * itself over pairwise-complete cells is 1, and computing it invites a
 * floating-point 0.9999999 on the diagonal of a matrix that is about to be
 * deflated.
 */
export function correlationMatrix(oe: Float64Array, m: number): Float64Array {
  const out = new Float64Array(m * m)
  const rows: Float64Array[] = []
  for (let r = 0; r < m; r++) rows.push(oe.subarray(r * m, (r + 1) * m))
  for (let r = 0; r < m; r++) {
    out[r * m + r] = 1
    for (let c = r + 1; c < m; c++) {
      const value = pearson(rows[r], rows[c])
      // A pair with too little overlap gets 0 rather than NaN: the eigensolver
      // needs a real matrix, and *no evidence of correlation* is the honest
      // reading of two rows that never overlap. `pearson` returning NaN is what
      // distinguishes that from a computed zero, and it is why the substitution
      // happens here where it can be commented rather than inside the statistic.
      const filled = Number.isFinite(value) ? value : 0
      out[r * m + c] = filled
      out[c * m + r] = filled
    }
  }
  return out
}

/** A signal the sign of a component is attached to, over the same bins. */
export interface PhasingSignal {
  name: string
  /** One value per *usable* bin, in the same order as the index. */
  values: Float64Array
}

export interface Phasing {
  /** Whether the component was flipped. */
  flipped: boolean
  /** The correlation the decision was made on. */
  r: number
  /** `false` when |r| was too small to decide. */
  confident: boolean
  signal: string
}

/**
 * Give a component's sign a meaning.
 *
 * Flips so that positive correlates with the signal, and says how strongly. The
 * threshold is the caller's, and below it nothing is flipped and `confident` is
 * `false` — because a sign chosen on an `r` of 0.04 is a coin flip wearing a
 * decision's clothes, and a reader comparing two chromosomes phased that way
 * would be comparing noise.
 */
export function phaseComponent(
  component: Float64Array,
  signal: PhasingSignal,
  threshold: number,
): Phasing {
  const r = pearson(component, signal.values)
  if (!Number.isFinite(r) || Math.abs(r) < threshold) {
    return { flipped: false, r: Number.isFinite(r) ? r : Number.NaN, confident: false, signal: signal.name }
  }
  const flipped = r < 0
  if (flipped) {
    for (let i = 0; i < component.length; i++) component[i] = -component[i]
  }
  return { flipped, r, confident: true, signal: signal.name }
}

/**
 * The saddle: observed/expected averaged by the compartment rank of both bins.
 *
 * Bins are sorted by their eigenvector value and cut into equal groups, and each
 * cell of the saddle is the mean O/E between two groups. The picture is the whole
 * compartment claim in one square — AA and BB bright at the corners, AB dark off
 * them — and the three numbers under it are what makes it a measurement.
 *
 * Quantiles of the *eigenvector*, not of the signal it was phased by: the
 * eigenvector is what the matrix says, and ranking by anything else would be
 * asking whether the matrix agrees with a track rather than what the matrix
 * itself contains.
 */
export function saddle(
  oe: Float64Array,
  m: number,
  component: Float64Array,
  bins: number,
): { values: Float32Array; edges: Float64Array; strength: { aa: number; bb: number; ab: number } } {
  const edges = quantileEdges(component, bins)
  const group = new Int32Array(m).fill(-1)
  for (let i = 0; i < m; i++) {
    const value = component[i]
    if (!Number.isFinite(value)) continue
    // The last group is closed at the top, so the maximum lands inside it
    // rather than in a group that does not exist.
    let g = 0
    while (g < bins - 1 && value >= edges[g + 1]) g++
    group[i] = g
  }

  const sum = new Float64Array(bins * bins)
  const count = new Float64Array(bins * bins)
  for (let r = 0; r < m; r++) {
    const gr = group[r]
    if (gr < 0) continue
    for (let c = 0; c < m; c++) {
      const gc = group[c]
      if (gc < 0) continue
      const value = oe[r * m + c]
      if (!Number.isFinite(value)) continue
      sum[gr * bins + gc] += value
      count[gr * bins + gc] += 1
    }
  }
  const values = new Float32Array(bins * bins)
  for (let i = 0; i < values.length; i++) {
    values[i] = count[i] > 0 ? sum[i] / count[i] : Number.NaN
  }

  // The corners, over the extreme fifth of the range at each end — which is the
  // conventional reading and is what makes the three numbers comparable between
  // runs at different quantile counts.
  const edge = Math.max(1, Math.round(bins / 5))
  const mean = (r0: number, r1: number, c0: number, c1: number): number => {
    let total = 0
    let seen = 0
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const value = values[r * bins + c]
        if (!Number.isFinite(value)) continue
        total += value
        seen++
      }
    }
    return seen === 0 ? Number.NaN : total / seen
  }
  return {
    values,
    edges,
    strength: {
      // `bb` is the *low* end of the eigenvector and `aa` the high one, which is
      // only meaningful once the component has been phased — the saddle inherits
      // whatever meaning phasing gave the sign, and inherits its uncertainty too.
      bb: mean(0, edge, 0, edge),
      aa: mean(bins - edge, bins, bins - edge, bins),
      ab: mean(0, edge, bins - edge, bins),
    },
  }
}
