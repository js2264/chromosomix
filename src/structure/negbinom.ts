/**
 * pastis-NB: a count is a count, not a measurement of a distance (§25.6).
 *
 * `reconstruct.ts` takes the ShRec3D position — a contact count `c` is read as
 * a distance `c^(−1/α)`, the missing pairs are filled so the matrix is
 * complete, and beads are placed to honour those distances. That position has
 * two costs it cannot pay off. A **zero is not a distance**: `0^(−1/α)` is
 * infinite, so a pair the experiment did not sample has to be either dropped or
 * invented, and the filling that invents it is the one step in that pipeline
 * that is a guess rather than a reading. And a **count's precision is thrown
 * away**: a pair seen ten thousand times and a pair seen once become two
 * distances, and only the weighting bolted onto the refinement remembers which
 * of them the map was sure about.
 *
 * The negative binomial takes the other position, which is pastis'
 * (Varoquaux, Ay, Noble & Vert, *Bioinformatics* 2014 for the Poisson models;
 * Varoquaux, Noble & Vert 2023 for the overdispersed one). A count is a
 * **count**, drawn from a distribution whose mean falls off as a power of the
 * distance between the two beads:
 *
 * ```
 *   c_ij ~ NegativeBinomial(mean μ = b_i · b_j · d_ij^(−α), dispersion r_ij)
 *   r_ij = b_i · b_j · exp(c₀ + c₁ · log λ_ij),      λ_ij = d_ij^(−α)
 * ```
 *
 * where `b` is each bead's coverage bias — pastis' own place for it, and the
 * reason this takes **raw counts** and never a balanced matrix ({@link
 * NegBinomModel.bias}) — and the model is the one that makes the counts most
 * probable. Both costs go away at once. A zero is **evidence**, and weak
 * evidence at that — it says *probably far*, it needs no filling, and past a
 * certain distance it stops caring how far, which is exactly right for a pair a
 * shallow experiment missed. And a count's precision is in the likelihood
 * itself: the curvature of `−log P` at a pair seen ten thousand times is ten
 * thousand times that of a pair seen once, so the near diagonal holds the beads
 * without anybody weighting anything.
 *
 * **This is pastis-NB as pastis runs it**, function for function, so that a
 * model made here and one made by `pastis.optimization.negative_binomial_
 * structure.estimate_X` answer the same question in the same words:
 *
 * - **The dispersion is a function of the mean**, not of the separation. The
 *   counts' mean and variance are taken at each genomic separation
 *   ({@link momentsBySeparation}, pastis' `compute_mean_variance`), the
 *   dispersion each pair of moments implies, `r = m²/(v − m)`, is fitted
 *   against the mean as `r = exp(c₀ + c₁ log m)` ({@link fitDispersion}, its
 *   `ExponentialDispersion(degree=1)`), and during the fit every pair's `r` is
 *   read off that curve **at the model's own mean for the pair** — so it moves
 *   with the beads, and its derivative is part of the gradient.
 * - **The likelihood is the whole negative binomial**, gamma functions and all
 *   ({@link negBinomObjective}), so its value is the number pastis reports.
 * - **`β` is 1 and the biases are scaled to a mean of 1**, as pastis' pipeline
 *   scales them. The scale of the model is then fitted rather than chosen: a
 *   distance of 1 is where a pair of average coverage expects one contact.
 * - **The start is pastis' MDS** ({@link mdsObjective}): the relative stress
 *   `Σ (d − δ)²/δ²` over the pairs the map counted, `δ = (c/(b_i b_j))^(−1/α)`,
 *   from beads placed uniformly at random in a cube by a seeded generator —
 *   {@link randomStart}, whose draws are numpy's, so seed `s` starts from the
 *   very coordinates pastis' `random_state=s` does.
 * - **Both are solved by L-BFGS to pastis' own tolerances** (`structure/
 *   lbfgs.ts`, with SciPy's line-search constants): the MDS to
 *   `factr = 10¹²`, the likelihood to `factr = 10` and a largest gradient
 *   component of 1 — or at the reader's step budget, whichever comes first.
 *   The default budget, 150, is about where pastis' own L-BFGS-B stops on
 *   the validation's yeast map (125 to 148 steps, by its relative-reduction
 *   test); run on to the gradient, the likelihood keeps climbing slowly for
 *   several hundred more.
 *
 * One thing differs, and is named in §25.6: a separation whose counts are not
 * overdispersed beyond sampling noise is left out of the dispersion's fit
 * ({@link fitDispersion}), and if fewer than three remain the counts are read
 * as Poisson — pastis-PM2, the `r = ∞` corner of what is written here. On a
 * real map every separation is in, and the curve is pastis'.
 *
 * **What is optimised.** Three coordinates per bead. `α` is not optimised: it
 * is the reader's control, the same number *Model from the map* and *Model
 * versus map* already share, and estimating it here would make the one
 * parameter a reader sets mean something different depending on which method
 * they picked. pastis fixes it too, at the 3 its pipeline is run with.
 *
 * Arrays in and arrays out — no worker, no store, no DOM (§18.9).
 */

import { lbfgs, type LbfgsProgress, type LbfgsResult, type LbfgsStop, type Objective } from './lbfgs'
import type { Coordinates, DenseMatrix } from './reconstruct'

/** The machine epsilon SciPy's L-BFGS-B multiplies `factr` by. */
const EPSILON = 2.220446049250313e-16

/**
 * How each phase stops: pastis' arguments to SciPy, translated.
 *
 * `tolerance` is `factr · ε`, the share of the value an iteration must still
 * buy; `gradient` is `pgtol`, the largest gradient component at which the
 * problem counts as solved; `iterations` is `maxiter`. The MDS stops early on
 * purpose — `factr = 10¹²` is a part in five thousand — because it only has to
 * land the likelihood in the right basin; the likelihood itself runs until an
 * iteration buys nothing a double can hold.
 */
export const PASTIS_MDS = { tolerance: 1e12 * EPSILON, gradient: 1e-5, iterations: 10000 } as const
export const PASTIS_NB = { tolerance: 10 * EPSILON, gradient: 1 } as const

/** Curvature pairs L-BFGS keeps: SciPy's `maxcor`, which pastis leaves at its default. */
const HISTORY = 10

/** Overdispersed separations a curve of two coefficients is fitted through, at the fewest. */
const MIN_SEPARATIONS = 3

/** Of the longest sequence, the share of separations the moments are taken over: pastis' `f`. */
const SEPARATION_SHARE = 2 / 3

/** Everything the likelihood is a function of, besides the coordinates. */
export interface NegBinomModel {
  /**
   * The counts, `n × n`, **read above the diagonal only**.
   *
   * **`NaN` and `0` are different here**, and the difference is the whole point
   * of the method: `0` is a pair the map looked at and counted nothing for,
   * which is evidence that the two beads are far apart, and `NaN` is a pair the
   * map could not look at — a filtered bin, a gap — which is no evidence at
   * all. A `NaN` pair is skipped; a zero pair pushes. Below the diagonal is
   * free for {@link storeWishes} to use.
   */
  counts: DenseMatrix
  n: number
  /**
   * Each bead's coverage bias, scaled to a mean of 1, or `null` where the file
   * has no weights.
   *
   * A Hi-C bin is not read as often as its neighbour: mappability, restriction
   * density and copy number all scale how many pairs land on it, by a factor
   * that has nothing to do with where the bin is in space. `cooler balance`
   * measures that factor as a weight `w` per bin and the balanced matrix is
   * `raw·w_i·w_j`.
   *
   * **A likelihood cannot be handed the balanced matrix**, which is why this
   * field exists rather than the run simply reading balanced values. A balanced
   * value is not a count: it is not an integer, it is scaled by an arbitrary
   * constant, and — fatally for {@link momentsBySeparation} — *overdispersion
   * is a statement about a count*. `variance > mean` compares a squared quantity
   * with a linear one, so scaling the data by `k` scales the two sides
   * differently and a balanced map is never found overdispersed, whatever it
   * actually is. Handed balanced values the negative binomial silently becomes
   * a Poisson.
   *
   * So the counts stay raw and the bias goes where pastis puts it — **into the
   * mean**, `μ_ij = b_i·b_j·d^(−α)` with `b_i = 1/w_i` — and into the
   * dispersion, which pastis scales by the same product. The counts are then
   * counts, the dispersion is measurable, and the coverage is still corrected.
   */
  bias?: Float64Array | null
  /** The dispersion's curve against the mean, or `null` for none: a Poisson. */
  dispersion: Dispersion | null
  /**
   * The reader's exponent, positive, as in `d = c^(−1/α)`.
   *
   * The mean falls as `d^(−α)`, so the exponent this module works in is `−α`.
   * Kept in the reader's sign so that one control means one thing across both
   * methods and both directions of the law.
   */
  alpha: number
}

/**
 * The dispersion as a curve against the mean: `r(λ) = exp(c₀ + c₁ log λ)`.
 *
 * pastis' `ExponentialDispersion(degree=1)`. Large `r` is Poisson — variance
 * equal to mean; small `r` is heavy overdispersion. `λ` is the mean a pair of
 * average coverage would have; a pair's own `r` is this times `b_i·b_j`.
 */
export interface Dispersion {
  c0: number
  c1: number
}

/** The moments of the counts at each genomic separation, as pastis takes them. */
export interface SeparationMoments {
  /** The separation, in bins along a sequence. */
  separation: Int32Array
  /** The mean of `c / (b_i b_j)` over the pairs that far apart. */
  mean: Float64Array
  /** Their unbiased variance, over the mean of `1 / (b_i b_j)`. */
  variance: Float64Array
  /** How many pairs were seen at it, zeros included. */
  pairs: Float64Array
}

/** What a fit ends with. */
export interface NegBinomFit {
  coords: Coordinates
  /** The negative log-likelihood, less `Σ log c!` — the number pastis' objective returns. */
  value: number
  iterations: number
  evaluations: number
  stop: LbfgsStop
}

/** What the MDS start ends with: the same shape, its value the relative stress. */
export type MdsFit = NegBinomFit

/**
 * pastis' `compute_mean_variance`: the counts' mean and variance at each
 * genomic separation within a sequence.
 *
 * Over the separations up to two-thirds of the longest sequence, and over the
 * pairs within one sequence only. Each count is divided by its pair's bias
 * product before the moments are taken, and the variance is then divided by the
 * mean of `1/(b_i b_j)`: if a pair's count is negative binomial with mean
 * `bλ` and dispersion `b·r`, its corrected count has variance `(λ + λ²/r)/b`,
 * and averaging `1/b` out is what leaves the `λ + λ²/r` the dispersion is read
 * from. **Zeros are counted** — they are observations of the count at that
 * separation, and leaving them out would overstate the mean and understate the
 * dispersion. A `NaN`, a pair the map could not see, is not.
 *
 * The separation is counted **in beads**, as pastis counts it: it is handed
 * the beads and their sequences' lengths and nothing else, so two beads either
 * side of a filtered bin are one apart to it. `index` orders the beads along
 * their sequence and is not otherwise read.
 */
export function momentsBySeparation(
  counts: DenseMatrix,
  n: number,
  group: Int32Array,
  index: Int32Array,
  bias: Float64Array | null = null,
): SeparationMoments {
  // Each sequence's beads in their order along it, so a separation is a walk
  // down one diagonal rather than a pass over every pair — and counted in
  // beads, as pastis counts it, a filtered bin being no bead at all.
  const byGroup = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const held = byGroup.get(group[i])
    if (held === undefined) byGroup.set(group[i], [i])
    else held.push(i)
  }
  let longest = 0
  const along: Int32Array[] = []
  for (const beads of byGroup.values()) {
    beads.sort((a, b) => index[a] - index[b])
    along.push(Int32Array.from(beads))
    longest = Math.max(longest, beads.length)
  }

  const separation: number[] = []
  const mean: number[] = []
  const variance: number[] = []
  const pairs: number[] = []
  // `range(1, int(min_size))`: up to, and not including, two-thirds of the longest.
  const last = Math.floor(longest * SEPARATION_SHARE)
  for (let s = 1; s < last; s++) {
    let seen = 0
    let sum = 0
    let inverse = 0
    for (const beads of along) {
      for (let p = 0; p + s < beads.length; p++) {
        const i = beads[p]
        const j = beads[p + s]
        const c = counts[i < j ? i * n + j : j * n + i]
        if (!Number.isFinite(c)) continue
        const b = bias === null ? 1 : bias[i] * bias[j]
        seen++
        sum += c / b
        inverse += 1 / b
      }
    }
    if (seen < 2) continue
    const m = sum / seen
    // The second pass, about the mean, as numpy takes it: a sum of squares
    // less `n·m²` would lose to cancellation exactly where a map is nearly
    // Poisson and the variance is a small difference of large numbers.
    let squares = 0
    for (const beads of along) {
      for (let p = 0; p + s < beads.length; p++) {
        const i = beads[p]
        const j = beads[p + s]
        const c = counts[i < j ? i * n + j : j * n + i]
        if (!Number.isFinite(c)) continue
        const deviation = c / (bias === null ? 1 : bias[i] * bias[j]) - m
        squares += deviation * deviation
      }
    }
    separation.push(s)
    mean.push(m)
    variance.push(squares / (seen - 1) / (inverse / seen))
    pairs.push(seen)
  }
  return {
    separation: Int32Array.from(separation),
    mean: Float64Array.from(mean),
    variance: Float64Array.from(variance),
    pairs: Float64Array.from(pairs),
  }
}

/**
 * pastis' `ExponentialDispersion(degree=1).fit`, weighted as its pipeline
 * weights it: the curve `r = exp(c₀ + c₁ log m)` through the dispersion each
 * separation's moments imply, `r = m²/(v − m)`, by least squares with each
 * residual weighted by the square root of the separation's pair count.
 *
 * Least squares **on `r` itself**, not on its logarithm, and from `(0, 0)`, as
 * SciPy's `least_squares` is called there — so the separations with the most
 * pairs and the largest `r` steer it, which is pastis' choice and is kept. The
 * solver is Levenberg–Marquardt on the two coefficients, which lands on the
 * minimum SciPy's trust region does wherever there is one.
 *
 * A separation whose counts are **not overdispersed** is left out: one whose
 * variance is not above its mean by more than three standard errors of a
 * Poisson's sample variance, `√((m + 2m²)/N)`. A real Hi-C map clears that by
 * orders of magnitude at every separation — the validation's yeast map by a
 * factor of hundreds — so there it changes nothing. Poisson counts clear it one
 * time in a thousand, and pastis, entering every separation as it comes, reads
 * them otherwise: `v ≤ m` gives a negative `r` that drags the curve towards
 * zero, and `v` a hair above `m` an `r` in the thousands, and a curve forced
 * through both calls the most Poisson counts on the map the most overdispersed
 * and loses the model. With fewer than three separations left there is no
 * curve worth drawing, and the answer is `null`: no overdispersion, a Poisson.
 */
export function fitDispersion(moments: SeparationMoments): Dispersion | null {
  const logs: number[] = []
  const targets: number[] = []
  const weights: number[] = []
  for (let k = 0; k < moments.mean.length; k++) {
    const m = moments.mean[k]
    const v = moments.variance[k]
    // Above the mean by more than three standard errors of a Poisson's sample
    // variance, `√((m + 2m²)/N)`: a real map clears it by orders of magnitude
    // at every separation, and Poisson counts clear it one time in a thousand.
    if (!(m > 0) || !(v > m + 3 * Math.sqrt((m + 2 * m * m) / moments.pairs[k]))) continue
    const r = (m * m) / (v - m)
    if (!Number.isFinite(r)) continue
    logs.push(Math.log(m))
    targets.push(r)
    weights.push(moments.pairs[k])
  }
  if (logs.length < MIN_SEPARATIONS) return null

  const cost = (c0: number, c1: number): number => {
    let sum = 0
    for (let k = 0; k < logs.length; k++) {
      const residual = Math.exp(c0 + c1 * logs[k]) - targets[k]
      sum += weights[k] * residual * residual
    }
    return sum
  }
  let c0 = 0
  let c1 = 0
  let current = cost(c0, c1)
  let damping = 1e-3
  for (let iteration = 0; iteration < 500 && Number.isFinite(current); iteration++) {
    // The normal equations of the linearised residuals, `JᵀJ δ = −Jᵀρ`, two by two.
    let a00 = 0
    let a01 = 0
    let a11 = 0
    let g0 = 0
    let g1 = 0
    for (let k = 0; k < logs.length; k++) {
      const fitted = Math.exp(c0 + c1 * logs[k])
      const residual = fitted - targets[k]
      const w = weights[k]
      a00 += w * fitted * fitted
      a01 += w * fitted * fitted * logs[k]
      a11 += w * fitted * fitted * logs[k] * logs[k]
      g0 += w * fitted * residual
      g1 += w * fitted * residual * logs[k]
    }
    let moved = false
    while (damping < 1e16) {
      const d00 = a00 * (1 + damping)
      const d11 = a11 * (1 + damping)
      const det = d00 * d11 - a01 * a01
      if (!(Math.abs(det) > 0)) {
        damping *= 10
        continue
      }
      const step0 = -(d11 * g0 - a01 * g1) / det
      const step1 = -(d00 * g1 - a01 * g0) / det
      const tried = cost(c0 + step0, c1 + step1)
      if (Number.isFinite(tried) && tried < current) {
        c0 += step0
        c1 += step1
        const gain = current - tried
        current = tried
        damping = Math.max(damping / 10, 1e-12)
        moved = gain > 1e-15 * current && Math.abs(step0) + Math.abs(step1) > 1e-15 * (1 + Math.abs(c0) + Math.abs(c1))
        break
      }
      damping *= 10
    }
    if (!moved) break
  }
  return Number.isFinite(c0) && Number.isFinite(c1) ? { c0, c1 } : null
}

/** `r` at a mean of `λ`, for a pair of average coverage. */
export function dispersionAt(dispersion: Dispersion, lambda: number): number {
  return Math.exp(dispersion.c0 + dispersion.c1 * Math.log(lambda))
}

/**
 * pastis' random start: every coordinate uniform in `[−1, 1)`, drawn as
 * `1 − 2·rand(3n)` and read three to a bead.
 *
 * Handed numpy's own generator (`analysis/random.ts`'s `numpyRandom`), seed `s`
 * gives the coordinates `RandomState(s)` gives pastis, to the last bit — so the
 * one place a run of pastis and a run here could part at the very first step is
 * closed, and what is left between them is the optimiser's path.
 */
export function randomStart(n: number, rng: () => number): Coordinates {
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = 1 - 2 * rng()
    y[i] = 1 - 2 * rng()
    z[i] = 1 - 2 * rng()
  }
  return { x, y, z }
}

/**
 * The reciprocal of each counted pair's wish distance, `1/δ = (c/(b_i b_j))^(1/α)`,
 * written **below the diagonal** of the counts, `0` where the map counted nothing.
 *
 * pastis' `compute_wish_distances` on the bias-corrected counts with `β = 1`.
 * Below the diagonal because the likelihood reads only above it: the matrix is
 * symmetric, its lower half holds nothing the counts above do not, and storing
 * the wishes there costs the MDS no matrix of its own and no `pow` per pair per
 * evaluation. Singles, which hold a wish to a part in ten million — far past
 * where an MDS that stops at a part in five thousand can tell.
 */
export function storeWishes(counts: DenseMatrix, n: number, bias: Float64Array | null, alpha: number): void {
  const power = 1 / alpha
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = counts[i * n + j]
      const wish = Number.isFinite(c) && c > 0 ? c / (bias === null ? 1 : bias[i] * bias[j]) : 0
      counts[j * n + i] = wish > 0 ? (alpha === 3 ? Math.cbrt(wish) : Math.pow(wish, power)) : 0
    }
  }
}

/**
 * pastis' MDS objective: the relative stress over the counted pairs.
 *
 * ```
 *   f = Σ_{i≠j} (d_ij − δ_ij)² / δ_ij²  =  2 Σ_{i>j} (d_ij · w_ij − 1)²,   w = 1/δ
 * ```
 *
 * Over ordered pairs, as pastis' dense objective sums it, so the value is
 * pastis'. Relative rather than absolute because a near pair's wish is small and
 * a far pair's large, and an absolute stress would spend the model on the far
 * pairs' errors; this one asks every pair to be right to the same share. The
 * gradient is the exact one — pastis' dense gradient is half of it, which moves
 * SciPy's path but not the minimum. A pair whose beads have met contributes its
 * constant and no gradient, as pastis' does.
 */
export function mdsObjective(wishes: DenseMatrix, n: number): Objective {
  return (vector, gradient) => {
    gradient.fill(0)
    let value = 0
    for (let i = 1; i < n; i++) {
      const row = i * n
      const xi = vector[i]
      const yi = vector[n + i]
      const zi = vector[2 * n + i]
      let gx = 0
      let gy = 0
      let gz = 0
      for (let j = 0; j < i; j++) {
        const w = wishes[row + j]
        if (!(w > 0)) continue
        const dx = xi - vector[j]
        const dy = yi - vector[n + j]
        const dz = zi - vector[2 * n + j]
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const e = d * w - 1
        value += 2 * e * e
        if (!(d > 0)) continue
        const coefficient = (4 * e * w) / d
        const fx = coefficient * dx
        const fy = coefficient * dy
        const fz = coefficient * dz
        gx += fx
        gy += fy
        gz += fz
        gradient[j] -= fx
        gradient[n + j] -= fy
        gradient[2 * n + j] -= fz
      }
      gradient[i] += gx
      gradient[n + i] += gy
      gradient[2 * n + i] += gz
    }
    return value
  }
}

// `lgamma(c + r) − lgamma(r) − c·log r` and `r·(ψ(c + r) − ψ(r))`, written by
// `countTerms` for the objective's inner loop to read: two numbers out of a
// function called a hundred million times an evaluation, without an object
// allocated for each.
let termG = 0
let termH = 0

/** Below this a gamma function is shifted up by its recurrence before its series is summed. */
const STIRLING = 7
/** Up to this a whole count's terms are summed exactly, factor by factor. */
const SMALL_COUNT = 16
/** …while `r` is below this, so that `(r + c)^c` stays far inside a double. */
const SMALL_RATE = 1e9

/**
 * The two parts of a count's likelihood that need the gamma function, into
 * `termG` and `termH`:
 *
 * ```
 *   G = lgamma(c + r) − lgamma(r) − c·log r      (the log-likelihood's count term)
 *   H = r · (ψ(c + r) − ψ(r))                    (its derivative, times r)
 * ```
 *
 * A whole count up to {@link SMALL_COUNT} never comes here: the objective sums
 * it exactly, inline, as `G = log Π_{k<c} (r + k) − c·log r` and
 * `H = r Σ_{k<c} 1/(r + k)` — most pairs of most maps, whose far counts are a
 * handful. Everything else is Stirling's series for both, each argument first lifted to {@link STIRLING}
 * by the recurrence, written so that the `c·log r` cancels on paper rather
 * than in rounding — `G` is a few units where `lgamma(r)` is thousands, and the
 * difference of two large numbers is where a likelihood's digits go. To seven
 * terms at seven the series is good to a part in 10¹³.
 */
function countTerms(c: number, r: number, logR: number): void {
  // ψ(r) = ψ(r + m) − Σ 1/(r + k) and lgamma(r) = lgamma(r + m) − log Π (r + k).
  let x = r
  let px = 1
  let sx = 0
  while (x < STIRLING) {
    px *= x
    sx += 1 / x
    x += 1
  }
  let y = c + r
  let py = 1
  let sy = 0
  while (y < STIRLING) {
    py *= y
    sy += 1 / y
    y += 1
  }
  const lx = x === r ? logR : Math.log(x)
  const ratio = Math.log1p((y - x) / x) // log y − log x, without losing it to their difference
  const ix = 1 / x
  const iy = 1 / y
  const ix2 = ix * ix
  const iy2 = iy * iy
  // lgamma(z) = (z − ½) log z − z + ½ log 2π + gammaTail(z)
  const tailX = ix * (1 / 12 - ix2 * (1 / 360 - ix2 * (1 / 1260 - ix2 * (1 / 1680 - ix2 * (1 / 1188 - (ix2 * 691) / 360360)))))
  const tailY = iy * (1 / 12 - iy2 * (1 / 360 - iy2 * (1 / 1260 - iy2 * (1 / 1680 - iy2 * (1 / 1188 - (iy2 * 691) / 360360)))))
  // ψ(z) = log z − 1/(2z) − psiTail(z)
  const psiX = ix2 * (1 / 12 - ix2 * (1 / 120 - ix2 * (1 / 252 - ix2 * (1 / 240 - ix2 * (1 / 132 - (ix2 * 691) / 32760)))))
  const psiY = iy2 * (1 / 12 - iy2 * (1 / 120 - iy2 * (1 / 252 - iy2 * (1 / 240 - iy2 * (1 / 132 - (iy2 * 691) / 32760)))))
  const shift = px === py ? 0 : Math.log(px / py)
  // (y − ½) log y − (x − ½) log x  =  (y − ½)(log y − log x) + (y − x) log x, and
  // where neither was lifted `(y − x) log x` is the `c log r` taken off after:
  // the two are dropped together rather than subtracted.
  const carried = px === 1 && py === 1 ? 0 : (y - x) * lx - c * logR
  termG = (y - 0.5) * ratio - (px === 1 && py === 1 ? c : y - x) + tailY - tailX + shift + carried
  termH = r * (ratio - 0.5 * (iy - ix) - psiY + psiX - sy + sx)
}

/**
 * The negative log-likelihood and its gradient, in one pass over the pairs —
 * pastis' `negative_binomial_obj` and `negative_binomial_gradient`, with every
 * pair of beads the map could see, zeros included (`use_zero_entries=True`).
 *
 * Per pair, with `λ = d^(−α)`, `s = b_i b_j`, `μ = s·λ`, `r = s·exp(c₀ + c₁ log λ)`
 * and `q = μ/r = exp((1 − c₁) log λ − c₀)`, which the bias cancels out of:
 *
 * ```
 *   f      = −G(c, r) + (c + r)·log(1 + q) − c·log μ
 *   ∂f/∂log λ = (1 − c₁)·(μ − c)/(1 + q) + c₁·(r·log(1 + q) − H(c, r))
 *   ∂f/∂x_i  = −α · ∂f/∂log λ · (x_i − x_j)/d²
 * ```
 *
 * That `f` is pastis' `−lgamma(c + r) + lgamma(r) − c log μ − r log r +
 * (c + r) log(r + μ)` rearranged so that nothing large is subtracted from
 * anything large: `G` is {@link countTerms}', and the `r log r` that would be
 * a billion at a near-Poisson pair is folded into `log(1 + q)`.
 *
 * **What the derivative says.** At `c₁ = 0` the dispersion is one number and
 * the pull on a pair is the Poisson's `μ − c` shrunk by `r/(r + μ)`: the same
 * force, turned down where the counts scatter. pastis-NB's `r` grows with the
 * mean, `c₁` of it per unit of `log λ`, so moving the beads also moves how much
 * the map is believed there — that is the second term, and it is why a
 * dispersion read off a curve against the mean cannot be held fixed per pair.
 *
 * `dispersion: null` is the Poisson, `f = μ − c log μ` and `∂f/∂log λ = μ − c`:
 * pastis-PM2, and the limit of the above as `r → ∞`.
 *
 * **One logarithm per pair, and no square root but at `α = 3`.** `log d²` gives
 * `log λ`, `log μ` and `log r` with the biases' logarithms taken once; at
 * `α = 3`, `λ` itself is a square root and a division. A pair with a
 * non-finite count is skipped: the map could not look at it. A pair whose beads
 * have collided has an infinite mean, and the whole objective is returned as
 * infinite so the line search shortens instead of stepping into the pole.
 */
export function negBinomObjective(model: NegBinomModel): Objective {
  const { counts, n, dispersion, alpha } = model
  const bias = model.bias ?? null
  const logBias = bias === null ? null : Float64Array.from(bias, (b) => Math.log(b))
  const half = alpha / 2
  const cube = alpha === 3
  const nb = dispersion !== null
  const c0 = nb ? dispersion.c0 : 0
  const c1 = nb ? dispersion.c1 : 0
  const slope = 1 - c1

  return (vector, gradient) => {
    gradient.fill(0)
    let value = 0
    for (let i = 0; i < n; i++) {
      const row = i * n
      const xi = vector[i]
      const yi = vector[n + i]
      const zi = vector[2 * n + i]
      const bi = bias === null ? 1 : bias[i]
      const li = logBias === null ? 0 : logBias[i]
      // Accumulated for `i` and flushed once, rather than read and written
      // `n` times through the gradient array.
      let gx = 0
      let gy = 0
      let gz = 0
      for (let j = i + 1; j < n; j++) {
        const c = counts[row + j]
        if (!(c >= 0)) continue
        const dx = xi - vector[j]
        const dy = yi - vector[n + j]
        const dz = zi - vector[2 * n + j]
        const d2 = dx * dx + dy * dy + dz * dz
        if (!(d2 > 0)) return Number.POSITIVE_INFINITY
        const logLambda = -half * Math.log(d2)
        const lambda = cube ? 1 / (d2 * Math.sqrt(d2)) : Math.exp(logLambda)
        const mu = (bias === null ? 1 : bi * bias[j]) * lambda
        let k: number
        if (nb) {
          const logQ = slope * logLambda - c0
          const q = Math.exp(logQ)
          const r = mu / q
          // `log1p` only where it is needed: above a thousandth `log(1 + q)`
          // loses nothing a double holds, and costs half as much.
          const spread = q > 1e-3 ? Math.log(1 + q) : Math.log1p(q)
          value += (c + r) * spread
          k = (slope * (mu - c)) / (1 + q) + c1 * r * spread
          if (c > 0) {
            const logMu = li + (logBias === null ? 0 : logBias[j]) + logLambda
            const logR = logMu - logQ
            // The gamma terms, `G` and `H` ({@link countTerms}). A whole count
            // up to {@link SMALL_COUNT} — most pairs of most maps — is summed
            // exactly here rather than in a call: `Π_{k<c} (r + k)` and
            // `Σ 1/(r + k)` as one running fraction over it, four factors at a
            // time so the chain of products each waits on is a quarter as long.
            let g = 0
            let h = 1
            if (c > 1 && c <= SMALL_COUNT && c === Math.floor(c) && r < SMALL_RATE) {
              let product = 1
              let numerator = 0
              let m = 0
              for (; m + 4 <= c; m += 4) {
                const a = r + m
                const b = a + 1
                const e = a + 2
                const f = a + 3
                const ab = a * b
                const ef = e * f
                const block = ab * ef
                numerator = numerator * block + ((a + b) * ef + (e + f) * ab) * product
                product *= block
              }
              for (; m < c; m++) {
                const a = r + m
                numerator = numerator * a + product
                product *= a
              }
              g = Math.log(product) - c * logR
              h = (r * numerator) / product
            } else if (c !== 1) {
              countTerms(c, r, logR)
              g = termG
              h = termH
            }
            value -= g + c * logMu
            k -= c1 * h
          }
        } else {
          value += mu
          k = mu - c
          if (c > 0) value -= c * (li + (logBias === null ? 0 : logBias[j]) + logLambda)
        }
        const coefficient = (-alpha * k) / d2
        const fx = coefficient * dx
        const fy = coefficient * dy
        const fz = coefficient * dz
        gx += fx
        gy += fy
        gz += fz
        gradient[j] -= fx
        gradient[n + j] -= fy
        gradient[2 * n + j] -= fz
      }
      gradient[i] += gx
      gradient[n + i] += gy
      gradient[2 * n + i] += gz
    }
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
}

/** The optimiser's vector: `x`, then `y`, then `z`. */
export function packCoordinates(coords: Coordinates): Float64Array {
  const n = coords.x.length
  const out = new Float64Array(3 * n)
  out.set(coords.x, 0)
  out.set(coords.y, n)
  out.set(coords.z, 2 * n)
  return out
}

/** The vector back as coordinates, in new arrays. */
export function readCoordinates(vector: Float64Array, n: number): Coordinates {
  return {
    x: Float64Array.from(vector.subarray(0, n)),
    y: Float64Array.from(vector.subarray(n, 2 * n)),
    z: Float64Array.from(vector.subarray(2 * n, 3 * n)),
  }
}

/** The likelihood at a model, without moving it — for a caller that wants the number rather than the fit. */
export function negBinomValue(model: NegBinomModel, coords: Coordinates): number {
  return negBinomObjective(model)(packCoordinates(coords), new Float64Array(3 * model.n))
}

/**
 * pastis' MDS from `start`, an evaluation at a time: L-BFGS on
 * {@link mdsObjective} to pastis' `factr = 10¹²`. `wishes` is the matrix
 * {@link storeWishes} wrote below the diagonal of.
 */
export function* fitMds(
  wishes: DenseMatrix,
  n: number,
  start: Coordinates,
  options: { iterations?: number } = {},
): Generator<LbfgsProgress, MdsFit, void> {
  const walk = lbfgs(mdsObjective(wishes, n), packCoordinates(start), {
    iterations: options.iterations ?? PASTIS_MDS.iterations,
    history: HISTORY,
    tolerance: PASTIS_MDS.tolerance,
    gradientTolerance: PASTIS_MDS.gradient,
  })
  return yield* finish(walk, n)
}

/**
 * Fit the model from `start`, an evaluation at a time, to pastis' `factr = 10`
 * and `pgtol = 1`, or until `iterations` run out.
 *
 * The generator is the caller's way to breathe: at ten thousand beads one
 * evaluation is fifty million pair visits, a line search is one or more of
 * them, and a run that did not yield between them would freeze the tab for the
 * whole of a fit and leave a cancel nowhere to land. `start` is not written
 * over — a cancelled fit leaves the MDS model it began from intact.
 */
export function* fitNegativeBinomial(
  model: NegBinomModel,
  start: Coordinates,
  options: { iterations?: number } = {},
): Generator<LbfgsProgress, NegBinomFit, void> {
  const walk = lbfgs(negBinomObjective(model), packCoordinates(start), {
    iterations: options.iterations ?? 100000,
    history: HISTORY,
    tolerance: PASTIS_NB.tolerance,
    gradientTolerance: PASTIS_NB.gradient,
  })
  return yield* finish(walk, model.n)
}

function* finish(
  walk: Generator<LbfgsProgress, LbfgsResult, void>,
  n: number,
): Generator<LbfgsProgress, NegBinomFit, void> {
  let step = walk.next()
  while (step.done !== true) {
    yield step.value
    step = walk.next()
  }
  const result = step.value
  return {
    coords: readCoordinates(result.point, n),
    value: result.value,
    iterations: result.iterations,
    evaluations: result.evaluations,
    stop: result.stop,
  }
}
