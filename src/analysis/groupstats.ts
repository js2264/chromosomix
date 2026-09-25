/**
 * One quantity compared between groups: the summaries and the tests a *Signal
 * by group* run reports (§18.8).
 *
 * **Rank tests**, because the quantities this is asked about are neither normal
 * nor on one scale: a ChIP track's per-bin means are a long right tail, an
 * eigenvector is signed, a GC fraction is bounded. Mann–Whitney for a pair of
 * groups and Kruskal–Wallis over all of them, each corrected for ties — a zoom
 * level of a bigWig hands many bins the same value — and read through the
 * normal and chi-square approximations, which at the hundreds of bins a genome
 * gives are exact enough for any P a reader acts on. They are the asymptotic
 * forms `scipy.stats.mannwhitneyu` and `scipy.stats.kruskal` use, and the tests
 * hold them to SciPy's own numbers.
 *
 * Pure: arrays in, numbers out.
 */

import { standardNormalCdf } from './chromosight'

/** What a group's values look like, in the columns a table prints. */
export interface GroupSummary {
  n: number
  mean: number
  /** Sample standard deviation (n − 1); `NaN` below two values. */
  sd: number
  median: number
  q1: number
  q3: number
}

/** The finite values, ascending. */
export function sortedFinite(values: ArrayLike<number>): Float64Array {
  let n = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++
  const out = new Float64Array(n)
  let at = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) out[at++] = values[i]
  return out.sort()
}

/** The `p` quantile of ascending values, interpolated linearly (R's type 7, NumPy's default). */
export function quantileOf(ascending: ArrayLike<number>, p: number): number {
  const n = ascending.length
  if (n === 0) return Number.NaN
  const at = Math.min(n - 1, Math.max(0, p * (n - 1)))
  const lo = Math.floor(at)
  const hi = Math.min(n - 1, lo + 1)
  return ascending[lo] + (ascending[hi] - ascending[lo]) * (at - lo)
}

export function summarise(values: ArrayLike<number>): GroupSummary {
  const sorted = sortedFinite(values)
  const n = sorted.length
  if (n === 0) {
    return { n: 0, mean: Number.NaN, sd: Number.NaN, median: Number.NaN, q1: Number.NaN, q3: Number.NaN }
  }
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i]
  const mean = sum / n
  let squares = 0
  for (let i = 0; i < n; i++) squares += (sorted[i] - mean) ** 2
  return {
    n,
    mean,
    sd: n > 1 ? Math.sqrt(squares / (n - 1)) : Number.NaN,
    median: quantileOf(sorted, 0.5),
    q1: quantileOf(sorted, 0.25),
    q3: quantileOf(sorted, 0.75),
  }
}

/**
 * The ranks of the pooled values, ties sharing their mean rank, and the tie
 * term `Σ (t³ − t)` over every run of `t` equal values.
 */
function midranks(pooled: Float64Array): { ranks: Float64Array; ties: number } {
  const n = pooled.length
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pooled[a] - pooled[b])
  const ranks = new Float64Array(n)
  let ties = 0
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && pooled[order[j + 1]] === pooled[order[i]]) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k]] = rank
    const t = j - i + 1
    if (t > 1) ties += t * t * t - t
    i = j + 1
  }
  return { ranks, ties }
}

export interface MannWhitney {
  /** Pairs in which the first group's value is the larger, ties counting half. */
  u: number
  z: number
  /** Two-sided. */
  p: number
  /**
   * The rank-biserial correlation `2U / (n₁n₂) − 1`: +1 where every value of the
   * first group is above every value of the second, −1 the other way round.
   */
  effect: number
}

/**
 * Mann–Whitney U of `a` against `b`, two-sided, by the normal approximation
 * with the tie and continuity corrections.
 */
export function mannWhitney(a: ArrayLike<number>, b: ArrayLike<number>): MannWhitney {
  const first = sortedFinite(a)
  const second = sortedFinite(b)
  const n1 = first.length
  const n2 = second.length
  if (n1 === 0 || n2 === 0) return { u: Number.NaN, z: Number.NaN, p: Number.NaN, effect: Number.NaN }
  const pooled = new Float64Array(n1 + n2)
  pooled.set(first, 0)
  pooled.set(second, n1)
  const { ranks, ties } = midranks(pooled)
  let r1 = 0
  for (let i = 0; i < n1; i++) r1 += ranks[i]
  const u = r1 - (n1 * (n1 + 1)) / 2
  const total = n1 + n2
  const mean = (n1 * n2) / 2
  const variance = ((n1 * n2) / 12) * (total + 1 - ties / (total * (total - 1)))
  const effect = (2 * u) / (n1 * n2) - 1
  // Every value tied: the two samples cannot be told apart at all, which SciPy
  // reports as P = 1 rather than as no answer.
  if (!(variance > 0)) return { u, z: 0, p: 1, effect }
  const away = u - mean
  const z = (away - 0.5 * Math.sign(away)) / Math.sqrt(variance)
  return { u, z, p: Math.min(1, 2 * standardNormalCdf(-Math.abs(z))), effect }
}

export interface KruskalWallis {
  h: number
  df: number
  p: number
}

/** Kruskal–Wallis H over every group with a value, tie-corrected, against χ² on k − 1. */
export function kruskalWallis(groups: ReadonlyArray<ArrayLike<number>>): KruskalWallis {
  const kept = groups.map(sortedFinite).filter((group) => group.length > 0)
  const k = kept.length
  const total = kept.reduce((sum, group) => sum + group.length, 0)
  if (k < 2 || total < 2) return { h: Number.NaN, df: Math.max(0, k - 1), p: Number.NaN }
  const pooled = new Float64Array(total)
  let at = 0
  for (const group of kept) {
    pooled.set(group, at)
    at += group.length
  }
  const { ranks, ties } = midranks(pooled)
  let statistic = 0
  at = 0
  for (const group of kept) {
    let sum = 0
    for (let i = 0; i < group.length; i++) sum += ranks[at + i]
    statistic += (sum * sum) / group.length
    at += group.length
  }
  statistic = (12 / (total * (total + 1))) * statistic - 3 * (total + 1)
  const correction = 1 - ties / (total * total * total - total)
  if (!(correction > 0)) return { h: Number.NaN, df: k - 1, p: Number.NaN }
  const h = statistic / correction
  return { h, df: k - 1, p: chiSquareSurvival(h, k - 1) }
}

/** `P(χ²ₖ > x)`: the regularised upper incomplete gamma `Q(k/2, x/2)`. */
export function chiSquareSurvival(x: number, df: number): number {
  if (!(df > 0) || Number.isNaN(x)) return Number.NaN
  if (x <= 0) return 1
  return upperGamma(df / 2, x / 2)
}

/**
 * `Q(s, x)`, by the series for its complement below `x = s + 1` and by the
 * continued fraction above it — the split at which each converges in a few
 * dozen terms (Numerical Recipes §6.2).
 */
function upperGamma(s: number, x: number): number {
  const scale = Math.exp(-x + s * Math.log(x) - lnGamma(s))
  if (x < s + 1) {
    let term = 1 / s
    let sum = term
    for (let n = 1; n < 1000; n++) {
      term *= x / (s + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break
    }
    return Math.max(0, 1 - sum * scale)
  }
  const tiny = 1e-300
  let b = x + 1 - s
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - s)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return Math.min(1, scale * h)
}

/** `ln Γ(x)`, by Lanczos (g = 7, nine terms). */
function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  const shifted = x - 1
  let a = c[0]
  const t = shifted + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (shifted + i)
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(a)
}
