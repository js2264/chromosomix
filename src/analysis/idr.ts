/**
 * IDR — the irreproducible discovery rate — as a port (§18.9).
 *
 * The test yapc puts its candidates through, and the one the field puts every
 * peak set through: two replicates rank the same candidates, and a copula
 * mixture model asks how far down the two rankings go on agreeing (Li, Brown,
 * Huang & Bickel 2011, *Ann. Appl. Stat.* 5:1752). What it reports per peak is
 * the posterior probability that the peak belongs to the *irreproducible*
 * component — the **local** IDR — and, from those, the **global** IDR of a
 * threshold: the expected share of irreproducible peaks among everything at
 * least as reproducible. The global IDR is what is thresholded, and it is to a
 * ranked list what a q-value is to a list of p-values.
 *
 * ## The upstream, exactly
 *
 * Nathan Boley's `idr` 2.0.3, at the commit yapc's own `yapc/idr.py` cites
 * (`74665e73`), through the function yapc calls: `fit_model_and_calc_local_idr`
 * with its defaults, then `calc_global_IDR`. It is the implementation ENCODE's
 * pipelines use. Everything is here in its order, with its constants and its
 * convergence tests, because a fit is a path and not only a place: a coordinate
 * ascent started one step differently ends a hair apart, and a peak on the
 * threshold is then on the other side of it.
 *
 * - **Pseudo-values by bisection**, `inv_cdf.pyx`: each rank is mapped to the
 *   point where the mixture's marginal CDF reaches `(rank + 1) / (n + 1)`,
 *   bisected to a tolerance **in CDF space**, with the bracket carried from one
 *   rank to the next. The fit uses 10⁻⁸ and the final local IDRs 10⁻¹².
 * - **`erf` is fdlibm's**, the one glibc's is built from, since the bisection
 *   stops on a comparison of it and a different `erf` stops somewhere else.
 * - **Sums are numpy's**, pairwise (`numpySum`), for the same reason.
 * - **EM, falling back to coordinate ascent** with SciPy's bounded Brent
 *   (`fminbound`) whenever an EM step leaves the parameter box — which is what
 *   happens when the two tracks do not behave like replicates, and is reported.
 * - **The asserts are kept.** `idr` asserts that no step lowers the likelihood
 *   by more than 10⁻⁶; where it would stop with an `AssertionError`, this stops
 *   with an {@link IdrError} saying which step, rather than going on to produce
 *   numbers the reference never would.
 *
 * What is deliberately *not* reproduced is its tie-breaking: `idr` ranks with
 * `np.lexsort` on an unseeded `np.random.random` key, so two equal scores are
 * ordered by chance and a rerun is a different fit. Here a tie is ordered by
 * position in the list, which is one of the orders `idr` could have drawn, and a
 * rerun is the same fit (§18.4). Ties between curvature scores are rare enough
 * that the golden has none.
 */

import { numpyMean, numpySum } from './stats'

/** `idr/__init__.py`'s constants, by the names it gives them. */
export const IDR_DEFAULTS = {
  maxIter: 3000,
  convergenceEps: 1e-6,
  /** Starting point: μ, σ, ρ, and the mixing proportion. */
  start: [0.1, 1.0, 0.2, 0.5] as const,
  /** `utility.DEFAULT_PV_COVERGE_EPS`, the fit's pseudo-value tolerance. */
  pseudoValueEps: 1e-8,
  /** The tolerance `calc_local_IDR` recomputes the pseudo-values to. */
  finalPseudoValueEps: 1e-12,
  /** EM steps per round before the pseudo-values are recomputed. */
  emStepsPerRound: 30,
} as const

/** The box the model's parameters are kept in: μ, σ, ρ, p. */
const MIN_THETA = [0.0, 0.2, 0.1, 0.01] as const
const MAX_THETA = [20.0, 20, 0.99, 0.99] as const

/** {@link MIN_THETA} and {@link MAX_THETA}, for saying where a fit ended against them. */
export const IDR_BOX = { min: MIN_THETA, max: MAX_THETA } as const

/** μ, σ, ρ and the mixing proportion `p` of the reproducible component. */
export type IdrTheta = [mu: number, sigma: number, rho: number, p: number]

/** Raised where `idr` itself would stop on an assertion. */
export class IdrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdrError'
  }
}

// ---------------------------------------------------------------------------
// erf, as fdlibm computes it
// ---------------------------------------------------------------------------

const scratch = new Float64Array(1)
const words = new Int32Array(scratch.buffer)
/** Which of the two words is the high one, on this machine. */
const HIGH = new Uint8Array(Float64Array.of(1).buffer)[7] === 0x3f ? 1 : 0
const LOW = 1 - HIGH

const ERX = 8.45062911510467529297e-1
const EFX = 1.28379167095512586316e-1
const EFX8 = 1.02703333676410069053e0
const PP = [
  1.28379167095512558561e-1, -3.25042107247001499370e-1, -2.84817495755985104766e-2,
  -5.77027029648944159157e-3, -2.37630166566501626084e-5,
] as const
const QQ = [
  3.97917223959155352819e-1, 6.50222499887672944485e-2, 5.08130628187576562776e-3,
  1.32494738004321644526e-4, -3.96022827877536812320e-6,
] as const
const PA = [
  -2.36211856075265944077e-3, 4.14856118683748331666e-1, -3.72207876035701323847e-1,
  3.18346619901161753674e-1, -1.10894694282396677476e-1, 3.54783043256182359371e-2,
  -2.16637559486879084300e-3,
] as const
const QA = [
  1.06420880400844228286e-1, 5.40397917702171048937e-1, 7.18286544141962662868e-2,
  1.26171219808761642112e-1, 1.36370839120290507362e-2, 1.19844998467991074170e-2,
] as const
const RA = [
  -9.86494403484714822705e-3, -6.93858572707181764372e-1, -1.05586262253232909814e1,
  -6.23753324503260060396e1, -1.62396669462573470355e2, -1.84605092906711035994e2,
  -8.12874355063065934246e1, -9.81432934416914548592e0,
] as const
const SA = [
  1.96512716674392571292e1, 1.37657754143519042600e2, 4.34565877475229228821e2,
  6.45387271733267880336e2, 4.29008140027567833386e2, 1.08635005541779435134e2,
  6.57024977031928170135e0, -6.04244152148580987438e-2,
] as const
const RB = [
  -9.86494292470009928597e-3, -7.99283237680523006574e-1, -1.77579549177547519889e1,
  -1.60636384855821916062e2, -6.37566443368389627722e2, -1.02509513161107724954e3,
  -4.83519191608651397019e2,
] as const
const SB = [
  3.03380607434824582924e1, 3.25792512996573918826e2, 1.53672958608443695994e3,
  3.19985821950859553908e3, 2.55305040643316442583e3, 4.74528541206955367215e2,
  -2.24409524465858183362e1,
] as const

/**
 * The error function, as fdlibm's `s_erf.c` computes it — the code glibc's `erf`
 * and so the C `erf` that `idr`'s Cython calls are both built from.
 *
 * The polynomial forms are written out rather than looped over, because a loop
 * that evaluated the same Horner scheme in another association would be another
 * function in the last place, which is the one thing this is here to not be.
 */
export function erf(x: number): number {
  scratch[0] = x
  const hx = words[HIGH]
  const ix = hx & 0x7fffffff
  if (ix >= 0x7ff00000) {
    // erf(NaN) is NaN, and erf(±inf) is ±1.
    const i = (hx >>> 31) << 1
    return 1 - i + 1 / x
  }
  if (ix < 0x3feb0000) {
    if (ix < 0x3e300000) {
      if (ix < 0x00800000) return 0.125 * (8.0 * x + EFX8 * x)
      return x + EFX * x
    }
    const z = x * x
    const r = PP[0] + z * (PP[1] + z * (PP[2] + z * (PP[3] + z * PP[4])))
    const s = 1 + z * (QQ[0] + z * (QQ[1] + z * (QQ[2] + z * (QQ[3] + z * QQ[4]))))
    const y = r / s
    return x + x * y
  }
  if (ix < 0x3ff40000) {
    const s = Math.abs(x) - 1
    const p = PA[0] + s * (PA[1] + s * (PA[2] + s * (PA[3] + s * (PA[4] + s * (PA[5] + s * PA[6])))))
    const q = 1 + s * (QA[0] + s * (QA[1] + s * (QA[2] + s * (QA[3] + s * (QA[4] + s * QA[5])))))
    return hx >= 0 ? ERX + p / q : -ERX - p / q
  }
  if (ix >= 0x40180000) return hx >= 0 ? 1 - 1e-300 : 1e-300 - 1
  const ax = Math.abs(x)
  const s = 1 / (ax * ax)
  let r: number
  let q: number
  if (ix < 0x4006db6e) {
    r = RA[0] + s * (RA[1] + s * (RA[2] + s * (RA[3] + s * (RA[4] + s * (RA[5] + s * (RA[6] + s * RA[7]))))))
    q =
      1 +
      s * (SA[0] + s * (SA[1] + s * (SA[2] + s * (SA[3] + s * (SA[4] + s * (SA[5] + s * (SA[6] + s * SA[7])))))))
  } else {
    r = RB[0] + s * (RB[1] + s * (RB[2] + s * (RB[3] + s * (RB[4] + s * (RB[5] + s * RB[6])))))
    q = 1 + s * (SB[0] + s * (SB[1] + s * (SB[2] + s * (SB[3] + s * (SB[4] + s * (SB[5] + s * SB[6]))))))
  }
  // `SET_LOW_WORD(z, 0)`: |x| with its low 32 bits cleared.
  scratch[0] = ax
  words[LOW] = 0
  const z = scratch[0]
  const e = Math.exp(-z * z - 0.5625) * Math.exp((z - ax) * (z + ax) + r / q)
  return hx >= 0 ? 1 - e / ax : e / ax - 1
}

// ---------------------------------------------------------------------------
// Pseudo-values
// ---------------------------------------------------------------------------

/** `c_cdf`: the marginal CDF of the two-component mixture. */
function mixtureCdf(x: number, mu: number, sigma: number, lamda: number): number {
  const normX = (x - mu) / sigma
  return 0.5 * lamda * erf(normX / Math.SQRT2) + 0.5 * (1 - lamda) * erf(x / Math.SQRT2) + 0.5
}

/** `c_cdf_i`: bisection for the point whose CDF is `r`, to `eps` in CDF space. */
function inverseCdf(
  r: number,
  mu: number,
  sigma: number,
  lamda: number,
  lb: number,
  ub: number,
  eps: number,
): number {
  let mid = 0
  for (let i = 0; i < 1000; i++) {
    mid = lb + (ub - lb) / 2
    const guess = mixtureCdf(mid, mu, sigma, lamda)
    if (Math.abs(guess - r) < eps) return mid
    if (guess < r) lb = mid
    else ub = mid
  }
  return mid
}

/**
 * `c_compute_pseudo_values`: each rank's point on the mixture's marginal.
 *
 * The ranks are 0-based and a permutation. The points are found in rank order,
 * each bracketed from the one before — the lower end is the previous answer and
 * the upper end twice the last step past it — which is what makes this linear
 * in the number of peaks rather than a fresh bisection each.
 */
export function pseudoValues(
  ranks: Int32Array,
  mu: number,
  sigma: number,
  lamda: number,
  eps: number,
): Float64Array {
  return byRank(ranks, rankPoints(ranks.length, mu, sigma, lamda, eps))
}

/**
 * Both replicates' pseudo-values, from one bisection.
 *
 * `idr` bisects once per replicate, but what it bisects for — the point of each
 * rank `0 … n − 1` — depends on the number of peaks and the parameters and not
 * on the ranks, which only say which peak takes which point. Two replicates of
 * the same peaks are the same `n`, so the points are found once and each
 * replicate's ranks read them: the same numbers, for half the `erf`s that were
 * most of a fit's time.
 */
export function pseudoValuePair(
  r1: Int32Array,
  r2: Int32Array,
  mu: number,
  sigma: number,
  lamda: number,
  eps: number,
): [Float64Array, Float64Array] {
  const points = rankPoints(r1.length, mu, sigma, lamda, eps)
  const other = r2.length === r1.length ? points : rankPoints(r2.length, mu, sigma, lamda, eps)
  return [byRank(r1, points), byRank(r2, other)]
}

/** `points[ranks[i]]` for each peak `i`. */
function byRank(ranks: Int32Array, points: Float64Array): Float64Array {
  const out = new Float64Array(ranks.length)
  for (let i = 0; i < ranks.length; i++) out[i] = points[ranks[i]]
  return out
}

/** The point on the mixture's marginal of each rank `0 … n − 1`, in rank order. */
function rankPoints(n: number, mu: number, sigma: number, lamda: number, eps: number): Float64Array {
  const ordered = new Float64Array(n)
  if (n === 0) return ordered
  const pseudoN = n + 1
  const smallest = 1 / pseudoN
  let lb = 0 <= mu ? 0 : mu
  while (mixtureCdf(lb, mu, sigma, lamda) > smallest) lb -= 1
  let ub = 0 >= mu ? 0 : mu
  while (mixtureCdf(ub, mu, sigma, lamda) < 1 - smallest) ub += 1
  lb = inverseCdf(smallest, mu, sigma, lamda, lb, ub, eps)
  ordered[0] = lb
  for (let i = 1; i < n; i++) {
    const r = (i + 1) / pseudoN
    if (mixtureCdf(ub, mu, sigma, lamda) < r) ub += 10
    const res = inverseCdf(r, mu, sigma, lamda, lb, ub, eps)
    ordered[i] = res
    lb = res
    ub = lb + 2 * (res - ordered[i - 1])
  }
  return ordered
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * The two-component model over one set of pseudo-values.
 *
 * Built once per set and asked many times: an EM round evaluates the likelihood
 * after every step, and a coordinate-ascent round a few hundred times inside
 * `fminbound`, all at the same pseudo-values. The **noise** component's density
 * depends on nothing else — it is a standard bivariate normal — so it is
 * computed once here, where `idr` recomputes it on every call; the values are
 * identical, since the same operations are done on the same numbers, and a
 * coordinate-ascent fit is two to three times faster for it.
 */
class Mixture {
  readonly n: number
  /** `exp(calc_gaussian_lhd(0, 0, 1, 1, 0, z1, z2))`, per peak. */
  private readonly noise: Float64Array
  /** The signal component's density at the parameters last asked about. */
  private readonly signal: Float64Array
  private readonly terms: Float64Array
  /** The μ, σ and ρ {@link signal} was computed at; `p` does not enter it. */
  private at: [number, number, number] = [Number.NaN, Number.NaN, Number.NaN]

  constructor(
    readonly z1: Float64Array,
    readonly z2: Float64Array,
  ) {
    this.n = z1.length
    this.noise = new Float64Array(this.n)
    this.signal = new Float64Array(this.n)
    this.terms = new Float64Array(this.n)
    density(0, 1, 0, z1, z2, this.noise)
  }

  /** `calc_gaussian_mix_log_lhd`: the log-likelihood, summed numpy's way. */
  logLik(theta: Readonly<IdrTheta>): number {
    this.signalAt(theta)
    const p = theta[3]
    for (let i = 0; i < this.n; i++) {
      this.terms[i] = Math.log(p * this.signal[i] + (1 - p) * this.noise[i])
    }
    return numpySum(this.terms)
  }

  /** `calc_post_membership_prbs`: each peak's probability of being reproducible. */
  membership(theta: Readonly<IdrTheta>): Float64Array {
    this.signalAt(theta)
    const p = theta[3]
    const out = new Float64Array(this.n)
    for (let i = 0; i < this.n; i++) {
      const s = p * this.signal[i]
      out[i] = s / (s + (1 - p) * this.noise[i])
    }
    return out
  }

  /**
   * The signal density at `theta`, recomputed only when μ, σ or ρ moved: a
   * coordinate-ascent step on the mixing proportion evaluates the likelihood
   * thirty times at one density, and it is the same numbers each time.
   */
  private signalAt(theta: Readonly<IdrTheta>): void {
    const at = this.at
    if (theta[0] === at[0] && theta[1] === at[1] && theta[2] === at[2]) return
    density(theta[0], theta[1], theta[2], this.z1, this.z2, this.signal)
    this.at = [theta[0], theta[1], theta[2]]
  }
}

/**
 * `numpy.exp(calc_gaussian_lhd(mu, mu, sigma, sigma, rho, z1, z2))`, into `out`.
 *
 * The log density of a bivariate normal with equal means, equal spreads and
 * correlation `rho`, with `idr`'s own `-1.837877` for `−log 2π`, in `idr`'s
 * order of operations, and then its exponential.
 */
function density(
  mu: number,
  sigma: number,
  rho: number,
  z1: Float64Array,
  z2: Float64Array,
  out: Float64Array,
): void {
  const constant = -1.837877 - Math.log(sigma) - Math.log(sigma) - 0.5 * Math.log(1 - rho * rho)
  const twoRho = 2 * rho
  const denominator = 2 * (1 - rho * rho)
  for (let i = 0; i < z1.length; i++) {
    const a = (z1[i] - mu) / sigma
    const b = (z2[i] - mu) / sigma
    out[i] = Math.exp(constant - (a * a - twoRho * a * b + b * b) / denominator)
  }
}

/** `EM_step`: one expectation–maximisation update, with the pseudo-values held. */
function emStep(model: Mixture, theta: Readonly<IdrTheta>): IdrTheta {
  const { n, z1, z2 } = model
  const ez = model.membership(theta)
  const ezSum = numpySum(ez)
  const work = new Float64Array(n)
  for (let i = 0; i < n; i++) work[i] = ez[i] * z1[i]
  const mu1 = numpySum(work) / ezSum
  for (let i = 0; i < n; i++) work[i] = ez[i] * z2[i]
  const mu2 = numpySum(work) / ezSum
  const mu = (mu1 + mu2) / 2
  for (let i = 0; i < n; i++) {
    const d = z1[i] - mu
    work[i] = ez[i] * (d * d)
  }
  const squares1 = numpySum(work)
  for (let i = 0; i < n; i++) {
    const d = z2[i] - mu
    work[i] = ez[i] * (d * d)
  }
  const squares2 = numpySum(work)
  const sigma = Math.sqrt((squares1 + squares2) / (2 * ezSum))
  for (let i = 0; i < n; i++) work[i] = ez[i] * (z1[i] - mu) * (z2[i] - mu)
  const rho = (2 * numpySum(work)) / (squares1 + squares2)
  return [mu, sigma, rho, ezSum / n]
}

/** `clip_model_params`: the parameters put back in their box, and whether they left it. */
function clipTheta(theta: Readonly<IdrTheta>): { theta: IdrTheta; changed: boolean } {
  const out: IdrTheta = [theta[0], theta[1], theta[2], theta[3]]
  let changed = false
  if (out[0] < MIN_THETA[0]) {
    out[0] = MIN_THETA[0]
    changed = true
  }
  if (out[1] < MIN_THETA[1]) {
    out[1] = MIN_THETA[1]
    changed = true
  }
  if (out[2] < MIN_THETA[2]) {
    out[2] = MIN_THETA[2]
    changed = true
  } else if (out[2] > MAX_THETA[2]) {
    out[2] = MAX_THETA[2]
    changed = true
  }
  if (out[3] < MIN_THETA[3]) {
    out[3] = MIN_THETA[3]
    changed = true
  } else if (out[3] > MAX_THETA[3]) {
    out[3] = MAX_THETA[3]
    changed = true
  }
  return { theta: out, changed }
}

/** `EM_iteration`: EM steps until the likelihood stops rising or a step leaves the box. */
function emIteration(
  model: Mixture,
  start: Readonly<IdrTheta>,
  maxIter: number,
  eps: number,
): { theta: IdrTheta; changed: boolean } {
  let previous: Readonly<IdrTheta> = start
  let previousLhd = model.logLik(previous)
  let theta: IdrTheta = [start[0], start[1], start[2], start[3]]
  for (let i = 0; i < maxIter; i++) {
    const clipped = clipTheta(emStep(model, previous))
    theta = clipped.theta
    const lhd = model.logLik(theta)
    if (clipped.changed) return { theta, changed: true }
    if (!(lhd + 1e-6 >= previousLhd)) {
      throw new IdrError('An EM step lowered the likelihood, which stops idr’s own fit.')
    }
    if (lhd - previousLhd < eps) return { theta, changed: false }
    previous = theta
    previousLhd = lhd
  }
  return { theta, changed: false }
}

/**
 * `fminbound`: SciPy's bounded Brent minimisation (`_minimize_scalar_bounded`,
 * SciPy 1.10), with its defaults — `xatol = 1e-5`, 500 evaluations.
 */
export function fminbound(
  f: (x: number) => number,
  x1: number,
  x2: number,
  xatol = 1e-5,
  maxfun = 500,
): number {
  if (!Number.isFinite(x1) || !Number.isFinite(x2)) {
    throw new IdrError('Optimization bounds must be finite scalars.')
  }
  if (x1 > x2) throw new IdrError('The lower bound exceeds the upper bound.')
  const sqrtEps = Math.sqrt(2.2e-16)
  const goldenMean = 0.5 * (3.0 - Math.sqrt(5.0))
  let a = x1
  let b = x2
  let fulc = a + goldenMean * (b - a)
  let nfc = fulc
  let xf = fulc
  let rat = 0.0
  let e = 0.0
  let x = xf
  let fx = f(x)
  let num = 1
  let ffulc = fx
  let fnfc = fx
  let xm = 0.5 * (a + b)
  let tol1 = sqrtEps * Math.abs(xf) + xatol / 3.0
  let tol2 = 2.0 * tol1
  while (Math.abs(xf - xm) > tol2 - 0.5 * (b - a)) {
    let golden = true
    if (Math.abs(e) > tol1) {
      golden = false
      let r = (xf - nfc) * (fx - ffulc)
      let q = (xf - fulc) * (fx - fnfc)
      let p = (xf - fulc) * q - (xf - nfc) * r
      q = 2.0 * (q - r)
      if (q > 0.0) p = -p
      q = Math.abs(q)
      r = e
      e = rat
      if (Math.abs(p) < Math.abs(0.5 * q * r) && p > q * (a - xf) && p < q * (b - xf)) {
        rat = (p + 0.0) / q
        x = xf + rat
        if (x - a < tol2 || b - x < tol2) {
          const si = Math.sign(xm - xf) + (xm - xf === 0 ? 1 : 0)
          rat = tol1 * si
        }
      } else {
        golden = true
      }
    }
    if (golden) {
      e = xf >= xm ? a - xf : b - xf
      rat = goldenMean * e
    }
    const si = Math.sign(rat) + (rat === 0 ? 1 : 0)
    x = xf + si * Math.max(Math.abs(rat), tol1)
    const fu = f(x)
    num += 1
    if (fu <= fx) {
      if (x >= xf) a = xf
      else b = xf
      fulc = nfc
      ffulc = fnfc
      nfc = xf
      fnfc = fx
      xf = x
      fx = fu
    } else {
      if (x < xf) a = x
      else b = x
      if (fu <= fnfc || nfc === xf) {
        fulc = nfc
        ffulc = fnfc
        nfc = x
        fnfc = fu
      } else if (fu <= ffulc || fulc === xf || fulc === nfc) {
        fulc = x
        ffulc = fu
      }
    }
    xm = 0.5 * (a + b)
    tol1 = sqrtEps * Math.abs(xf) + xatol / 3.0
    tol2 = 2.0 * tol1
    if (num >= maxfun) break
  }
  return xf
}

/** `CA_step`: one coordinate moved to its bounded optimum, if that helps. */
function caStep(model: Mixture, theta: IdrTheta, index: number): number {
  const inner: IdrTheta = [theta[0], theta[1], theta[2], theta[3]]
  const fixed = theta[index]
  const loss = (alpha: number): number => {
    inner[index] = fixed + alpha
    return -model.logLik(inner)
  }
  if (!(fixed >= MIN_THETA[index]) || !(fixed <= MAX_THETA[index])) {
    throw new IdrError('A coordinate-ascent step started outside idr’s parameter box.')
  }
  const alpha = fminbound(loss, MIN_THETA[index] - fixed, MAX_THETA[index] - fixed)
  const previous = -loss(0)
  const next = -loss(alpha)
  if (next > previous) {
    theta[index] += alpha
    return next
  }
  return previous
}

/** `CA_iteration`: coordinate ascent until the likelihood stops rising. */
function caIteration(
  model: Mixture,
  start: Readonly<IdrTheta>,
  maxIter: number,
  eps: number,
): IdrTheta {
  let previousLhd = model.logLik(start)
  let theta: IdrTheta = [start[0], start[1], start[2], start[3]]
  let lhd = previousLhd
  for (let i = 0; i < maxIter; i++) {
    for (let index = 0; index < 4; index++) lhd = caStep(model, theta, index)
    const clipped = clipTheta(theta)
    if (clipped.changed) {
      throw new IdrError('Coordinate ascent left idr’s parameter box, which stops idr’s own fit.')
    }
    theta = clipped.theta
    if (!(lhd + 1e-6 >= previousLhd)) {
      throw new IdrError('A coordinate-ascent round lowered the likelihood, which stops idr’s own fit.')
    }
    if (lhd - previousLhd < eps) return theta
    previousLhd = lhd
  }
  return theta
}

/** What a fit found, and how it got there. */
export interface IdrFit {
  theta: IdrTheta
  /** Rounds of EM (or coordinate ascent) and pseudo-value updates. */
  rounds: number
  /** Whether any round fell back to coordinate ascent — an EM step left the box. */
  coordinateAscent: boolean
}

/**
 * `estimate_model_params` → `EMP_with_pseudo_value_algorithm`, with `idr`'s
 * defaults: rounds of EM on fixed pseudo-values, the pseudo-values recomputed
 * after each, until both the parameters and the pseudo-values move by less than
 * the tolerance — and not before the fifth round.
 *
 * `between` is called after every round with the number of rounds done, and is
 * awaited: it is where a caller in a worker hands the thread back and checks for
 * a cancel, since a fit over a hundred thousand peaks is minutes rather than a
 * moment. It is not given anything it could change the fit with.
 */
export async function fitIdr(
  r1: Int32Array,
  r2: Int32Array,
  options: {
    start?: Readonly<IdrTheta>
    maxIter?: number
    eps?: number
    between?: (rounds: number) => void | Promise<void>
  } = {},
): Promise<IdrFit> {
  const eps = options.eps ?? IDR_DEFAULTS.convergenceEps
  const maxIter = options.maxIter ?? IDR_DEFAULTS.maxIter
  const pvEps = IDR_DEFAULTS.pseudoValueEps
  const s = options.start ?? IDR_DEFAULTS.start
  let theta: IdrTheta = [s[0], s[1], s[2], s[3]]
  let [z1, z2] = pseudoValuePair(r1, r2, theta[0], theta[1], theta[3], pvEps)
  let coordinateAscent = false
  let rounds = 0
  const change = new Float64Array(r1.length)
  for (let i = 0; i < maxIter; i++) {
    rounds = i + 1
    const previous = theta
    const model = new Mixture(z1, z2)
    const em = emIteration(model, previous, IDR_DEFAULTS.emStepsPerRound, eps / 10)
    theta = em.theta
    if (em.changed) {
      coordinateAscent = true
      theta = caIteration(model, previous, IDR_DEFAULTS.emStepsPerRound, eps / 10)
    }
    const paramChange = numpySum([
      Math.abs(theta[0] - previous[0]),
      Math.abs(theta[1] - previous[1]),
      Math.abs(theta[2] - previous[2]),
      Math.abs(theta[3] - previous[3]),
    ])
    const previousZ1 = z1
    const previousZ2 = z2
    ;[z1, z2] = pseudoValuePair(r1, r2, theta[0], theta[1], theta[3], pvEps)
    for (let k = 0; k < change.length; k++) change[k] = Math.abs(previousZ1[k] - z1[k])
    const moved1 = numpyMean(change)
    for (let k = 0; k < change.length; k++) change[k] = Math.abs(previousZ2[k] - z2[k])
    const moved = moved1 + numpyMean(change)
    if (options.between !== undefined) await options.between(rounds)
    if (i > 3 && paramChange < eps && moved < eps) break
  }
  return { theta, rounds, coordinateAscent }
}

/**
 * `calc_local_IDR`: one minus each peak's reproducible membership, at pseudo-values
 * recomputed to 10⁻¹².
 *
 * Two of `idr`'s rules are applied after the model, and both are kept. A peak
 * whose two pseudo-values sum below zero — below the noise component's mean in
 * both replicates, taken together — is set to 1 (`FILTER_PEAKS_BELOW_NOISE_MEAN`),
 * and every value is clipped to `[1e-6, 1]`, because "it doesn't make sense for
 * the IDR values to be smaller than the optimization tolerance".
 */
export function localIdr(theta: Readonly<IdrTheta>, r1: Int32Array, r2: Int32Array): Float64Array {
  const eps = IDR_DEFAULTS.finalPseudoValueEps
  const [z1, z2] = pseudoValuePair(r1, r2, theta[0], theta[1], theta[3], eps)
  const ez = new Mixture(z1, z2).membership(theta)
  const floor = IDR_DEFAULTS.convergenceEps
  const out = new Float64Array(ez.length)
  for (let i = 0; i < out.length; i++) {
    let value = 1 - ez[i]
    if (z1[i] + z2[i] < 0) value = 1
    out[i] = value < floor ? floor : value > 1 ? 1 : value
  }
  return out
}

/**
 * `calc_global_IDR`: for each peak, the mean local IDR of every peak at least as
 * reproducible — ties included, since `rankdata(…, method='max')` gives a tie
 * the rank of its last member.
 *
 * `idr` takes each of those means afresh, which is quadratic in the number of
 * peaks; a running total gives the same means to within a few units in the last
 * place, which is below anything a threshold at 10⁻³ can see.
 */
export function globalIdr(local: Float64Array): Float64Array {
  const n = local.length
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => local[a] - local[b] || a - b)
  const out = new Float64Array(n)
  let total = 0
  let at = 0
  while (at < n) {
    let end = at
    while (end < n && local[order[end]] === local[order[at]]) {
      total += local[order[end]]
      end++
    }
    const mean = total / end
    for (let k = at; k < end; k++) out[order[k]] = mean
    at = end
  }
  return out
}

/** `-math.log10(max(1e-5, IDR))`: the scaled IDR yapc and `idr` both report. */
export function scaledIdr(value: number): number {
  return -Math.log10(Math.max(1e-5, value))
}

/**
 * Ranks in `idr`'s sense: 0 for the lowest score, `n − 1` for the highest.
 *
 * `np.lexsort((np.random.random(n), scores)).argsort()` — ties ordered by the
 * random key. Here by position; see the module docstring.
 */
export function idrRanks(scores: Float64Array): Int32Array {
  const n = scores.length
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => scores[a] - scores[b] || a - b)
  const out = new Int32Array(n)
  for (let k = 0; k < n; k++) out[order[k]] = k
  return out
}
