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
 *   c_ij ~ NegativeBinomial(mean = β · b_i · b_j · d_ij^(−α), dispersion r_ij)
 * ```
 *
 * where `b` is each bead's coverage bias — pastis' own place for it, and the
 * reason this takes **raw counts** and never a balanced matrix ({@link
 * NegBinomModel.bias}) —
 *
 * and the model is the one that makes the counts most probable. Both costs go
 * away at once. A zero is **evidence**, and weak evidence at that — it says
 * *probably far*, it needs no filling, and past a certain distance it stops
 * caring how far, which is exactly right for a pair a shallow experiment
 * missed. And a count's precision is in the likelihood itself: the curvature of
 * `−log P` at a pair seen ten thousand times is ten thousand times that of a
 * pair seen once, so the near diagonal holds the beads without anybody
 * weighting anything.
 *
 * **Why negative binomial and not Poisson.** A Poisson has one parameter, so
 * its variance is its mean — and Hi-C counts are not like that. They are
 * **overdispersed**, and by an amount that itself varies with genomic
 * separation: replicate variance near the diagonal is a few times the mean,
 * and far from it can be orders of magnitude more. A Poisson fit to such data
 * believes the far, noisy pairs far more than it should, which is the same
 * failure the unweighted SMACOF has, arrived at by a different road. The
 * negative binomial adds the one parameter that fixes it — `r`, where the
 * variance is `μ + μ²/r` — and pastis-NB's contribution is to let `r` **vary
 * with genomic separation** rather than be one number for the map. That is what
 * {@link dispersionBySeparation} estimates, and it is why this module is
 * pastis-NB and not pastis-PM2. As `r → ∞` the negative binomial *is* the
 * Poisson, so PM2 is the `r = ∞` corner of what is written here, and the test
 * holds it to that.
 *
 * **What is optimised.** Three coordinates per bead and `log β`, by L-BFGS
 * (`structure/lbfgs.ts`) — which is the optimiser pastis reaches for too,
 * through SciPy. `α` is not optimised: it is the reader's control, the same
 * number *Model from the map* and *Model versus map* already share, and
 * estimating it here would make the one parameter a reader sets mean something
 * different depending on which method they picked. `β` is a variable rather
 * than a constant because the scale of the model and the scale of the mean are
 * the same degree of freedom — `X → kX` with `β → k^α β` is the identical
 * likelihood — and the honest way to handle a degeneracy is to let the
 * optimiser sit anywhere along it and to fix the scale afterwards, which
 * `normaliseCoordinates` does.
 *
 * **What it is started from.** The MDS model — classical scaling and weighted
 * SMACOF, which is to say the whole of `reconstruct.ts`. That is pastis' own
 * procedure: its Poisson and NB solvers are initialised from its MDS mode,
 * because a likelihood surface with a pole at every collided pair is not
 * something to enter from noise. So this module does not replace ShRec3D here;
 * it stands on it.
 *
 * Arrays in and arrays out — no worker, no store, no DOM (§18.9).
 */

import { lbfgs, type LbfgsProgress, type LbfgsResult, type LbfgsStop, type Objective } from './lbfgs'
import type { Coordinates, DenseMatrix } from './reconstruct'

/**
 * The dispersion `r` the counts show, by genomic separation.
 *
 * Large `r` is Poisson — variance equal to mean; small `r` is heavy
 * overdispersion. Held per **cis separation in beads** and once for every trans
 * pair, which is the shape pastis-NB's dispersion-against-genomic-distance fit
 * has and the shape a Hi-C map's overdispersion actually takes.
 */
export interface Dispersion {
  /** `r` at cis separation `s`; `cis[0]` is the diagonal and never read. */
  cis: Float64Array
  /** `r` for a pair whose two beads are on different sequences. */
  trans: number
}

/**
 * The `r` standing for *no overdispersion at all*.
 *
 * A separation whose counts are no more variable than a Poisson's would be —
 * which happens on a shallow map, on simulated counts, and at separations with
 * too few pairs to tell — gets this rather than an infinity, because an
 * infinity is not a number the objective can carry. At a million, and with
 * means of order one, `μ/r` is a millionth and the likelihood is a Poisson's to
 * six figures; {@link negBinomObjective} is written in `log1p` precisely so
 * that this stays true instead of vanishing into the rounding of a large
 * constant.
 */
export const POISSON_DISPERSION = 1e6

/** How far apart two separations may be and still share a dispersion estimate. */
const BIN_GROWTH = 1.25
/** Pairs a separation bin needs before its variance is believed. */
const BIN_PAIRS = 32

/** Everything the likelihood is a function of, besides the coordinates. */
export interface NegBinomModel {
  /**
   * The counts, `n × n`, symmetrised.
   *
   * **`NaN` and `0` are different here**, and the difference is the whole point
   * of the method: `0` is a pair the map looked at and counted nothing for,
   * which is evidence that the two beads are far apart, and `NaN` is a pair the
   * map could not look at — a filtered bin, a gap — which is no evidence at
   * all. A `NaN` pair is skipped; a zero pair pushes.
   */
  counts: DenseMatrix
  n: number
  /** The sequence each bead lies on, for telling a cis pair from a trans one. */
  group: Int32Array
  /** The bead's position along its sequence, for the separation. */
  index: Int32Array
  dispersion: Dispersion
  /**
   * Each bead's coverage bias, or `null` where the file has no weights.
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
   * constant, and — fatally for {@link dispersionBySeparation} — *overdispersion
   * is a statement about a count*. `variance > mean` compares a squared quantity
   * with a linear one, so scaling the data by `k` scales the two sides
   * differently and a balanced map is never found overdispersed, whatever it
   * actually is. Handed balanced values the negative binomial silently becomes
   * a Poisson.
   *
   * So the counts stay raw and the bias goes where pastis puts it — **into the
   * mean**, `μ_ij = β·b_i·b_j·d^(−α)` with `b_i = 1/w_i`. The counts are then
   * counts, the dispersion is measurable, and the coverage is still corrected.
   */
  bias?: Float64Array | null
  /**
   * The reader's exponent, positive, as in `d = c^(−1/α)`.
   *
   * The mean falls as `d^(−α)`, so the exponent this module works in is `−α`.
   * Kept in the reader's sign so that one control means one thing across both
   * methods and both directions of the law.
   */
  alpha: number
}

/** What the fit ends with. */
export interface NegBinomFit {
  coords: Coordinates
  /** The scale of the mean: `μ = β d^(−α)`. */
  beta: number
  /** The negative log-likelihood, up to the terms no structure can change. */
  value: number
  iterations: number
  evaluations: number
  stop: LbfgsStop
}

/**
 * The dispersion of the counts at each separation, by the method of moments.
 *
 * A negative binomial with mean `μ` has variance `μ + μ²/r`, so a set of counts
 * with sample mean `m` and sample variance `v` implies `r = m² / (v − m)`.
 * That is the estimator, applied **per genomic separation** — which is the
 * claim pastis-NB makes and tests: overdispersion is not one number for a map,
 * it grows as the counts thin out with distance.
 *
 * Separations are pooled into **log-spaced bins** before the moments are taken,
 * for the same reason P(s) is drawn on log bins: a separation near the length
 * of a sequence has a handful of pairs and a variance computed from a handful
 * of numbers is noise, and the bins are wide exactly where the pairs are few.
 * A bin with too few pairs to believe, or one whose counts are not overdispersed
 * at all, takes {@link POISSON_DISPERSION}; a bin with no pairs takes the
 * nearest bin that has an answer, walking outward, which is the rule
 * `fillDistances` already uses for the same problem.
 *
 * **Zeros are counted.** They are observations of the count at that separation
 * and leaving them out would understate the mean and overstate the dispersion.
 * A `NaN` — a pair the map could not see — is not an observation and is left
 * out. One pass over the matrix.
 */
export function dispersionBySeparation(
  counts: DenseMatrix,
  n: number,
  group: Int32Array,
  index: Int32Array,
): Dispersion {
  let maxSeparation = 0
  for (let i = 0; i < n; i++) if (index[i] > maxSeparation) maxSeparation = index[i]

  // Sums per separation: how many pairs, their total, and their total squared —
  // everything a mean and a variance need, in one pass and in `O(separations)`.
  const pairs = new Float64Array(maxSeparation + 1)
  const sum = new Float64Array(maxSeparation + 1)
  const square = new Float64Array(maxSeparation + 1)
  let transPairs = 0
  let transSum = 0
  let transSquare = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = counts[i * n + j]
      if (!Number.isFinite(c)) continue
      if (group[i] === group[j]) {
        const s = Math.abs(index[i] - index[j])
        pairs[s] += 1
        sum[s] += c
        square[s] += c * c
      } else {
        transPairs += 1
        transSum += c
        transSquare += c * c
      }
    }
  }

  // Log-spaced bins over the separations, widening as the pairs thin out.
  const cis = new Float64Array(maxSeparation + 1).fill(Number.NaN)
  const edges: number[] = []
  for (let edge = 1; edge <= maxSeparation; edge = Math.max(edge + 1, Math.ceil(edge * BIN_GROWTH))) {
    edges.push(edge)
  }
  edges.push(maxSeparation + 1)
  for (let b = 0; b + 1 < edges.length; b++) {
    let np = 0
    let ns = 0
    let nq = 0
    for (let s = edges[b]; s < edges[b + 1]; s++) {
      np += pairs[s]
      ns += sum[s]
      nq += square[s]
    }
    const r = momentDispersion(np, ns, nq)
    if (Number.isNaN(r)) continue
    for (let s = edges[b]; s < edges[b + 1]; s++) cis[s] = r
  }

  // A separation nothing was estimated for reads the nearest that was, either
  // way — the same walk `fillDistances` does, and for the same reason: a gap in
  // the middle of a decay should read its neighbours rather than a default.
  for (let s = 1; s <= maxSeparation; s++) {
    if (!Number.isNaN(cis[s])) continue
    let found = Number.NaN
    for (let step = 1; step <= maxSeparation && Number.isNaN(found); step++) {
      const lo = s - step
      const hi = s + step
      if (lo >= 1 && !Number.isNaN(cis[lo])) found = cis[lo]
      else if (hi <= maxSeparation && !Number.isNaN(cis[hi])) found = cis[hi]
    }
    cis[s] = Number.isNaN(found) ? POISSON_DISPERSION : found
  }
  if (maxSeparation >= 0) cis[0] = POISSON_DISPERSION

  const trans = momentDispersion(transPairs, transSum, transSquare)
  return { cis, trans: Number.isNaN(trans) ? POISSON_DISPERSION : trans }
}

/**
 * `r = m² / (v − m)`, or {@link POISSON_DISPERSION} where the counts are not
 * overdispersed; `NaN` where there is not enough to say.
 *
 * The sample variance is the unbiased one, and the guard is on the *pair count*
 * rather than on the variance: a bin of five pairs can show a variance ten
 * times its mean by luck, and believing it would give the far pairs a dispersion
 * that says the map knows nothing about them.
 */
function momentDispersion(pairs: number, sum: number, square: number): number {
  if (pairs < BIN_PAIRS) return Number.NaN
  const mean = sum / pairs
  if (!(mean > 0)) return POISSON_DISPERSION
  const variance = (square - pairs * mean * mean) / (pairs - 1)
  if (!(variance > mean)) return POISSON_DISPERSION
  const r = (mean * mean) / (variance - mean)
  return Number.isFinite(r) && r > 0 ? Math.min(r, POISSON_DISPERSION) : POISSON_DISPERSION
}

/**
 * The scale the counts imply for a given model: `β = Σc / Σd^(−α)`.
 *
 * The Poisson maximum-likelihood estimate of `β` holding the structure fixed,
 * which is pastis' own seed and is a moment match — the model's predicted total
 * is made equal to the observed total. It is only a start; `log β` is a
 * variable of the fit and moves from here.
 */
export function seedBeta(model: NegBinomModel, coords: Coordinates): number {
  const { counts, n, alpha } = model
  const bias = model.bias ?? null
  const half = -alpha / 2
  const cube = alpha === 3
  const { x, y, z } = coords
  let observed = 0
  let predicted = 0
  for (let i = 0; i < n; i++) {
    const bi = bias === null ? 1 : bias[i]
    for (let j = i + 1; j < n; j++) {
      const c = counts[i * n + j]
      if (!Number.isFinite(c)) continue
      const dx = x[i] - x[j]
      const dy = y[i] - y[j]
      const dz = z[i] - z[j]
      const d2 = dx * dx + dy * dy + dz * dz
      if (!(d2 > 0)) continue
      observed += c
      predicted += (bias === null ? 1 : bi * bias[j]) * (cube ? 1 / (d2 * Math.sqrt(d2)) : Math.pow(d2, half))
    }
  }
  return predicted > 0 && observed > 0 ? observed / predicted : 1
}

/** The optimiser's vector: `x`, then `y`, then `z`, then `log β`. */
export function packModel(coords: Coordinates, beta: number): Float64Array {
  const n = coords.x.length
  const out = new Float64Array(3 * n + 1)
  out.set(coords.x, 0)
  out.set(coords.y, n)
  out.set(coords.z, 2 * n)
  out[3 * n] = Math.log(beta > 0 ? beta : 1)
  return out
}

/** The vector back as coordinates and a `β`; `into` is written over. */
export function readModel(vector: Float64Array, into: Coordinates): number {
  const n = into.x.length
  into.x.set(vector.subarray(0, n))
  into.y.set(vector.subarray(n, 2 * n))
  into.z.set(vector.subarray(2 * n, 3 * n))
  return Math.exp(vector[3 * n])
}

/**
 * The negative log-likelihood and its gradient, in one pass over the pairs.
 *
 * ```
 *   f    = Σ_{i<j} (r + c)·log(1 + μ/r) − c·log μ ,    μ = β·d^(−α)
 *   ∂f/∂x_i = Σ_j  (−α)·k_ij·(x_i − x_j)/d²  ,          k = r·(μ − c)/(r + μ)
 *   ∂f/∂logβ = Σ_{i<j} k_ij
 * ```
 *
 * **What `k` says.** Written out, `∂f/∂μ · μ` is `μ(r + c)/(r + μ) − c`, and
 * that collapses to `r(μ − c)/(r + μ)` — which is the Poisson's own `μ − c`
 * **shrunk by `r/(r + μ)`**. So the negative binomial is not a different force
 * on the beads; it is the same force, turned down at every pair in proportion
 * to how overdispersed that pair's separation was found to be. A pair with no
 * overdispersion (`r ≫ μ`) pulls with its full Poisson weight; a pair at a
 * separation where the counts scattered far more than their mean pulls with a
 * fraction of it. That is the entire content of pastis-NB over pastis-PM2, in
 * one factor, and it is why the collapsed form is the one written below: it is
 * both cheaper and exact where the long form loses digits to `r + c` at large
 * `r`.
 *
 * `f` is the true negative log-likelihood **less `Σ (r + c)·log r`**, a
 * constant no structure can change. Dropping it is not cosmetic: at
 * {@link POISSON_DISPERSION} that constant is a billion and the part that
 * depends on the model is of order one, so keeping it would spend nine of the
 * sixteen digits a double has on a number the optimiser must not move, and the
 * line search would be comparing decreases against rounding. Written with
 * `log1p` the constant never appears and the Poisson limit is exact: as
 * `r → ∞`, `(r + c)·log1p(μ/r) → μ` and `f → Σ μ − c·log μ`, which is
 * pastis-PM2's objective.
 *
 * **No square root is taken.** Every term wants `d²` or a power of it — `μ` is
 * `β (d²)^(−α/2)` and the gradient divides by `d²` — so the distance itself is
 * never needed. At the default `α = 3` that power is one `sqrt` of `d²` and a
 * division, which is why the pass costs about what a SMACOF step costs.
 *
 * A pair with a non-finite count is skipped: the map could not look at it, and
 * a model should not be pushed by a pair nobody observed. A pair whose beads
 * have collided has an infinite mean, and the whole objective is returned as
 * infinite so the line search shortens instead of stepping into the pole.
 */
export function negBinomObjective(model: NegBinomModel): Objective {
  const { counts, n, group, index, dispersion, alpha } = model
  const bias = model.bias ?? null
  const power = -alpha
  const half = power / 2
  const cube = alpha === 3
  const { cis, trans } = dispersion

  return (vector, gradient) => {
    const beta = Math.exp(vector[3 * n])
    if (!Number.isFinite(beta) || beta <= 0) return Number.POSITIVE_INFINITY
    gradient.fill(0)
    let value = 0
    let betaGradient = 0

    for (let i = 0; i < n; i++) {
      const row = i * n
      const xi = vector[i]
      const yi = vector[n + i]
      const zi = vector[2 * n + i]
      const gi = group[i]
      const ii = index[i]
      const bi = bias === null ? 1 : bias[i]
      // Accumulated for `i` and flushed once, rather than read and written
      // `n` times through the gradient array.
      let gx = 0
      let gy = 0
      let gz = 0
      for (let j = i + 1; j < n; j++) {
        const c = counts[row + j]
        if (!Number.isFinite(c)) continue
        const dx = xi - vector[j]
        const dy = yi - vector[n + j]
        const dz = zi - vector[2 * n + j]
        const d2 = dx * dx + dy * dy + dz * dz
        if (!(d2 > 0)) return Number.POSITIVE_INFINITY
        const scale = bias === null ? beta : beta * bi * bias[j]
        const mu = scale * (cube ? 1 / (d2 * Math.sqrt(d2)) : Math.pow(d2, half))
        if (!Number.isFinite(mu) || mu <= 0) return Number.POSITIVE_INFINITY
        const r = gi === group[j] ? cis[Math.abs(ii - index[j])] : trans

        value += (r + c) * Math.log1p(mu / r)
        if (c > 0) value -= c * Math.log(mu)

        const k = (r * (mu - c)) / (r + mu)
        betaGradient += k
        const coefficient = (power * k) / d2
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

    gradient[3 * n] = betaGradient
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
}

/**
 * The likelihood at a model, without moving it — for a caller that wants the
 * number rather than the fit.
 */
export function negBinomValue(model: NegBinomModel, coords: Coordinates, beta: number): number {
  const objective = negBinomObjective(model)
  return objective(packModel(coords, beta), new Float64Array(3 * model.n + 1))
}

/**
 * Fit the model from `start`, an evaluation at a time.
 *
 * The generator is the caller's way to breathe: at ten thousand beads one
 * evaluation is a hundred million pair visits, a line search is several of
 * them, and a run that did not yield between them would freeze the tab for the
 * whole of a fit and leave a cancel nowhere to land. `start` is not written
 * over — a cancelled fit leaves the MDS model it began from intact.
 */
export function* fitNegativeBinomial(
  model: NegBinomModel,
  start: Coordinates,
  options: { iterations?: number; history?: number; beta?: number } = {},
): Generator<LbfgsProgress, NegBinomFit, void> {
  const n = model.n
  const beta = options.beta ?? seedBeta(model, start)
  const objective = negBinomObjective(model)
  const walk = lbfgs(objective, packModel(start, beta), {
    iterations: options.iterations ?? 200,
    history: options.history ?? 8,
  })
  let step = walk.next()
  while (step.done !== true) {
    yield step.value
    step = walk.next()
  }
  const result: LbfgsResult = step.value
  const coords: Coordinates = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
  }
  const fitted = readModel(result.point, coords)
  return {
    coords,
    beta: fitted,
    value: result.value,
    iterations: result.iterations,
    evaluations: result.evaluations,
    stop: result.stop,
  }
}

/**
 * What to tell the reader about the dispersion that was fitted.
 *
 * The near diagonal and the far pairs, because the one claim pastis-NB makes
 * over pastis-PM2 is that those two numbers differ — and a run that reports
 * them lets a reader see whether, on *their* map, they did. Where they are both
 * {@link POISSON_DISPERSION} the negative binomial found no overdispersion and
 * the answer is a Poisson's, which is worth knowing before reading anything
 * into it.
 */
export function dispersionRange(dispersion: Dispersion): { near: number; far: number; poisson: boolean } {
  const { cis } = dispersion
  const last = cis.length - 1
  const near = cis.length > 1 ? cis[1] : POISSON_DISPERSION
  const far = last >= 1 ? cis[last] : near
  return { near, far, poisson: near >= POISSON_DISPERSION && far >= POISSON_DISPERSION }
}
