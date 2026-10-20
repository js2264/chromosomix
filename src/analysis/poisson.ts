/**
 * The Poisson tail `cooltools.dots` tests every pixel against, as SciPy computes it.
 *
 * `determine_thresholds` asks one question per λ-chunk and per observed count:
 * how many pixels of the chunk would reach that count by chance if the chunk's
 * upper edge were their expected — `poisson.sf(count, λ)`, times the pixels in
 * the chunk — and draws the chunk's threshold where that falls below the FDR's
 * share of the pixels that did. Those thresholds are integers decided by a
 * comparison, and the q-value of every call is the same tail divided by a count,
 * so the tail is ported rather than approximated: an `sf` a few ulps away from
 * SciPy's moves no threshold in practice, and an `sf` from another algorithm is
 * a second implementation whose agreement nothing guarantees.
 *
 * ## The upstream, exactly
 *
 * `scipy.stats.poisson.sf(k, μ)` is `special.pdtrc(floor(k), μ)`, clipped to
 * `[0, 1]`, and `pdtrc` is cephes' — SciPy 1.16.3 carries it as the header-only
 * `xsf::cephes`: `pdtrc(k, m) = igam(floor(k) + 1, m)`, the regularised lower
 * incomplete gamma function. Everything below is that file's `igam`, `igamc`
 * and their helpers, in its branches and with its constants: the power series
 * where `x < a`, the continued fraction for the complement where `x > a`, and
 * Temme's uniform asymptotic expansion (DLMF 8.12) wherever `a` and `x` are
 * close — which is where every threshold is decided — with the 25 × 25
 * coefficients `analysis/hiccupsTables.ts` transcribes. `lgam` is cephes'
 * (`gamma.h`), `log1p`, `log1pmx` and `expm1` cephes' (`unity.h`), `erfc`
 * cephes' (`ndtr.h`), and the scaled Lanczos sum cephes' (`lanczos.h`).
 *
 * What cannot be reproduced is the C library under them: `Math.log`, `Math.exp`
 * and `Math.pow` are V8's and SciPy calls glibc's, and the two can part in the
 * last bit. That is the whole of the difference, and the golden measures it.
 *
 * Only what a Poisson tail reaches is here. `pdtrc` is `igam` at an integer
 * `a ≥ 1`, so `lgam` is never asked for a negative argument and `lgam1p` never
 * for one near 0 or 1 but `a = 1` itself; both refuse the rest by name rather
 * than answer it wrongly.
 */

import { IGAM_ASYMPTOTIC } from './hiccupsTables'

/** `scipy.stats.poisson.sf(k, mu)`: the chance a Poisson(`mu`) draw exceeds `k`. */
export function poissonSf(k: number, mu: number): number {
  if (Number.isNaN(k) || Number.isNaN(mu) || mu < 0) return Number.NaN
  // `rv_discrete.sf`: below the support the answer is 1, and past it 0.
  if (k < 0) return 1
  if (k === Number.POSITIVE_INFINITY) return 0
  return Math.min(1, Math.max(0, pdtrc(Math.floor(k), mu)))
}

/** cephes' `pdtrc`: the terms `k + 1` to infinity of the Poisson distribution. */
export function pdtrc(k: number, m: number): number {
  if (k < 0 || m < 0) return Number.NaN
  if (m === 0) return 0
  return igam(Math.floor(k) + 1, m)
}

// ---------------------------------------------------------------------------
// cephes `const.h`, and the constants `igam.h` names
// ---------------------------------------------------------------------------

const MACHEP = 1.11022302462515654042e-16
const MAXLOG = 7.09782712893383996732e2
const LS2PI = 0.91893853320467274178
const MAXLGM = 2.556348e305
const M_SQRT2 = 1.4142135623730950488
const M_SQRT1_2 = 0.707106781186547524401
/** `unity.h`'s `detail::MAXITER`, which `log1pmx` stops at. */
const UNITY_MAXITER = 500

const IGAM_MAXITER = 2000
const IGAM = 1
const IGAMC = 0
const IGAM_SMALL = 20
const IGAM_LARGE = 200
const IGAM_SMALLRATIO = 0.3
const IGAM_LARGERATIO = 4.5
const IGAM_BIG = 4.503599627370496e15
const IGAM_BIGINV = 2.22044604925031308085e-16

// ---------------------------------------------------------------------------
// polevl.h
// ---------------------------------------------------------------------------

function polevl(x: number, coef: readonly number[], n: number): number {
  let ans = coef[0]
  for (let i = 1; i <= n; i++) ans = ans * x + coef[i]
  return ans
}

function p1evl(x: number, coef: readonly number[], n: number): number {
  let ans = x + coef[0]
  for (let i = 1; i < n; i++) ans = ans * x + coef[i]
  return ans
}

/** A rational function, evaluated in `1/x` past one as cephes evaluates it. */
function ratevl(
  x: number,
  num: readonly number[],
  m: number,
  denom: readonly number[],
  n: number,
): number {
  const absx = Math.abs(x)
  let dir: number
  let at: number
  let y: number
  if (absx > 1) {
    dir = -1
    at = m
    y = 1 / x
  } else {
    dir = 1
    at = 0
    y = x
  }
  let numAns = num[at]
  at += dir
  for (let i = 1; i <= m; i++) {
    numAns = numAns * y + num[at]
    at += dir
  }
  at = absx > 1 ? n : 0
  let denomAns = denom[at]
  at += dir
  for (let i = 1; i <= n; i++) {
    denomAns = denomAns * y + denom[at]
    at += dir
  }
  if (absx > 1) return (Math.pow(x, m - n) * numAns) / denomAns
  return numAns / denomAns
}

// ---------------------------------------------------------------------------
// gamma.h: lgam, for the positive arguments a Poisson tail asks of it
// ---------------------------------------------------------------------------

const GAMMA_A = [
  8.11614167470508450300e-4, -5.95061904284301438324e-4, 7.93650340457716943945e-4,
  -2.77777777730099687205e-3, 8.33333333333331927722e-2,
]
const GAMMA_B = [
  -1.37825152569120859100e3, -3.88016315134637840924e4, -3.31612992738871184744e5,
  -1.16237097492762307383e6, -1.72173700820839662146e6, -8.53555664245765465627e5,
]
const GAMMA_C = [
  -3.51815701436523470549e2, -1.70642106651881159223e4, -2.20528590553854454839e5,
  -1.13933444367982507207e6, -2.53252307177582951285e6, -2.01889141433532773231e6,
]

function lgamLargeX(x: number): number {
  const q = (x - 0.5) * Math.log(x) - x + LS2PI
  if (x > 1.0e8) return q
  let p = 1.0 / (x * x)
  p = ((7.9365079365079365079365e-4 * p - 2.7777777777777777777778e-3) * p + 0.0833333333333333333333) / x
  return q + p
}

/** cephes' `lgam`: `log |Γ(x)|`, for `x > 0`. */
export function lgam(x: number): number {
  if (!Number.isFinite(x)) return x
  if (x <= 0) throw new RangeError(`lgam is ported for positive arguments only, not ${x}`)
  if (x < 13.0) {
    let z = 1.0
    let p = 0.0
    let u = x
    while (u >= 3.0) {
      p -= 1.0
      u = x + p
      z *= u
    }
    while (u < 2.0) {
      z /= u
      p += 1.0
      u = x + p
    }
    if (z < 0.0) z = -z
    if (u === 2.0) return Math.log(z)
    p -= 2.0
    const t = x + p
    p = (t * polevl(t, GAMMA_B, 5)) / p1evl(t, GAMMA_C, 6)
    return Math.log(z) + p
  }
  if (x > MAXLGM) return Number.POSITIVE_INFINITY
  if (x >= 1000.0) return lgamLargeX(x)
  const q = (x - 0.5) * Math.log(x) - x + LS2PI
  const p = 1.0 / (x * x)
  return q + polevl(p, GAMMA_A, 4) / x
}

/** cephes' `lgam1p`, `lgam(x + 1)`, where a Poisson tail asks for it: `x ≥ 1`. */
function lgam1p(x: number): number {
  if (x === 1) {
    // `log(x) + lgam1p_taylor(x - 1)`, and the Taylor series at zero is zero.
    return 0
  }
  if (Math.abs(x) <= 0.5 || Math.abs(x - 1) < 0.5) {
    throw new RangeError(`lgam1p is ported for x = 1 and x ≥ 1.5 only, not ${x}`)
  }
  return lgam(x + 1)
}

// ---------------------------------------------------------------------------
// lanczos.h
// ---------------------------------------------------------------------------

const LANCZOS_G = 6.024680040776729583740234375
const LANCZOS_SUM_EXPG_SCALED_NUM = [
  0.006061842346248906525783753964555936883222, 0.5098416655656676188125178644804694509993,
  19.51992788247617482847860966235652136208, 449.9445569063168119446858607650988409623,
  6955.999602515376140356310115515198987526, 75999.29304014542649875303443598909137092,
  601859.6171681098786670226533699352302507, 3481712.15498064590882071018964774556468,
  14605578.08768506808414169982791359218571, 43338889.32467613834773723740590533316085,
  86363131.28813859145546927288977868422342, 103794043.1163445451906271053616070238554,
  56906521.91347156388090791033559122686859,
]
const LANCZOS_SUM_EXPG_SCALED_DENOM = [
  1, 66, 1925, 32670, 357423, 2637558, 13339535, 45995730, 105258076, 150917976, 120543840,
  39916800, 0,
]

function lanczosSumExpgScaled(x: number): number {
  return ratevl(x, LANCZOS_SUM_EXPG_SCALED_NUM, 12, LANCZOS_SUM_EXPG_SCALED_DENOM, 12)
}

// ---------------------------------------------------------------------------
// unity.h
// ---------------------------------------------------------------------------

const UNITY_LP = [
  4.5270000862445199635215e-5, 4.9854102823193375972212e-1, 6.5787325942061044846969e0,
  2.9911919328553073277375e1, 6.0949667980987787057556e1, 5.7112963590585538103336e1,
  2.0039553499201281259648e1,
]
const UNITY_LQ = [
  1.5062909083469192043167e1, 8.3047565967967209469434e1, 2.2176239823732856465394e2,
  3.0909872225312059774938e2, 2.1642788614495947685003e2, 6.0118660497603843919306e1,
]
const UNITY_EP = [1.2617719307481059087798e-4, 3.0299440770744196129956e-2, 9.9999999999999999991025e-1]
const UNITY_EQ = [
  3.0019850513866445504159e-6, 2.5244834034968410419224e-3, 2.2726554820815502876593e-1,
  2.0000000000000000000897e0,
]

/** cephes' `log1p`, not the platform's: `log1pmx` calls this one. */
function log1p(x: number): number {
  let z = 1.0 + x
  if (z < M_SQRT1_2 || z > M_SQRT2) return Math.log(z)
  z = x * x
  z = -0.5 * z + x * ((z * polevl(x, UNITY_LP, 6)) / p1evl(x, UNITY_LQ, 6))
  return x + z
}

/** `log(1 + x) - x`. */
function log1pmx(x: number): number {
  if (Math.abs(x) < 0.5) {
    let xfac = x
    let res = 0
    for (let n = 2; n < UNITY_MAXITER; n++) {
      xfac *= -x
      const term = xfac / n
      res += term
      if (Math.abs(term) < MACHEP * Math.abs(res)) break
    }
    return res
  }
  return log1p(x) - x
}

function expm1(x: number): number {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return x
    return x > 0 ? x : -1.0
  }
  if (x < -0.5 || x > 0.5) return Math.exp(x) - 1.0
  const xx = x * x
  let r = x * polevl(xx, UNITY_EP, 2)
  r = r / (polevl(xx, UNITY_EQ, 3) - r)
  return r + r
}

// ---------------------------------------------------------------------------
// ndtr.h: erfc
// ---------------------------------------------------------------------------

const NDTR_P = [
  2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687e0,
  4.86371970985681366614e1, 1.96520832956077098242e2, 5.26445194995477358631e2,
  9.34528527171957607540e2, 1.02755188689515710272e3, 5.57535335369399327526e2,
]
const NDTR_Q = [
  1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2,
  9.75708501743205489753e2, 1.82390916687909736289e3, 2.24633760818710981792e3,
  1.65666309194161350182e3, 5.57535340817727675546e2,
]
const NDTR_R = [
  5.64189583547755073984e-1, 1.27536670759978104416e0, 5.01905042251180477414e0,
  6.16021097993053585195e0, 7.40974269950448939160e0, 2.97886665372100240670e0,
]
const NDTR_S = [
  2.26052863220117276590e0, 9.39603524938001434673e0, 1.20489539808096656605e1,
  1.70814450747565897222e1, 9.60896809063285878198e0, 3.36907645100081516050e0,
]
const NDTR_T = [
  9.60497373987051638749e0, 9.00260197203842689217e1, 2.23200534594684319226e3,
  7.00332514112805075473e3, 5.55923013010394962768e4,
]
const NDTR_U = [
  3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3,
  2.26290000613890934246e4, 4.92673942608635921086e4,
]

function erf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN
  if (x < 0.0) return -erf(-x)
  if (Math.abs(x) > 1.0) return 1.0 - erfc(x)
  const z = x * x
  return (x * polevl(z, NDTR_T, 4)) / p1evl(z, NDTR_U, 5)
}

function erfc(a: number): number {
  if (Number.isNaN(a)) return Number.NaN
  const x = a < 0.0 ? -a : a
  if (x < 1.0) return 1.0 - erf(a)
  let z = -a * a
  if (z < -MAXLOG) return a < 0 ? 2.0 : 0.0
  z = Math.exp(z)
  let p: number
  let q: number
  if (x < 8.0) {
    p = polevl(x, NDTR_P, 8)
    q = p1evl(x, NDTR_Q, 8)
  } else {
    p = polevl(x, NDTR_R, 5)
    q = p1evl(x, NDTR_S, 6)
  }
  let y = (z * p) / q
  if (a < 0) y = 2.0 - y
  if (y !== 0.0) return y
  return a < 0 ? 2.0 : 0.0
}

// ---------------------------------------------------------------------------
// igam.h
// ---------------------------------------------------------------------------

/** `x^a e^{-x} / Γ(a)`, with the correction cephes makes to its reference. */
function igamFac(a: number, x: number): number {
  if (Math.abs(a - x) > 0.4 * Math.abs(a)) {
    const ax = a * Math.log(x) - x - lgam(a)
    if (ax < -MAXLOG) return 0.0
    return Math.exp(ax)
  }
  const fac = a + LANCZOS_G - 0.5
  let res = Math.sqrt(fac / Math.exp(1)) / lanczosSumExpgScaled(a)
  if (a < 200 && x < 200) {
    res *= Math.exp(a - x) * Math.pow(x / fac, a)
  } else {
    const num = x - a - LANCZOS_G + 0.5
    res *= Math.exp(a * log1pmx(num / fac) + (x * (0.5 - LANCZOS_G)) / fac)
  }
  return res
}

/** igamc by DLMF 8.9.2. */
function igamcContinuedFraction(a: number, x: number): number {
  const ax = igamFac(a, x)
  if (ax === 0.0) return 0.0
  let y = 1.0 - a
  let z = x + y + 1.0
  let c = 0.0
  let pkm2 = 1.0
  let qkm2 = x
  let pkm1 = x + 1.0
  let qkm1 = z * x
  let ans = pkm1 / qkm1
  for (let i = 0; i < IGAM_MAXITER; i++) {
    c += 1.0
    y += 1.0
    z += 2.0
    const yc = y * c
    const pk = pkm1 * z - pkm2 * yc
    const qk = qkm1 * z - qkm2 * yc
    let t: number
    if (qk !== 0) {
      const r = pk / qk
      t = Math.abs((ans - r) / r)
      ans = r
    } else {
      t = 1.0
    }
    pkm2 = pkm1
    pkm1 = pk
    qkm2 = qkm1
    qkm1 = qk
    if (Math.abs(pk) > IGAM_BIG) {
      pkm2 *= IGAM_BIGINV
      pkm1 *= IGAM_BIGINV
      qkm2 *= IGAM_BIGINV
      qkm1 *= IGAM_BIGINV
    }
    if (t <= MACHEP) break
  }
  return ans * ax
}

/** igam by DLMF 8.11.4. */
function igamSeries(a: number, x: number): number {
  const ax = igamFac(a, x)
  if (ax === 0.0) return 0.0
  let r = a
  let c = 1.0
  let ans = 1.0
  for (let i = 0; i < IGAM_MAXITER; i++) {
    r += 1.0
    c *= x / r
    ans += c
    if (c <= MACHEP * ans) break
  }
  return (ans * ax) / a
}

/** igamc by DLMF 8.7.3, which keeps the cancellation out of the complement. */
function igamcSeries(a: number, x: number): number {
  let fac = 1
  let sum = 0
  for (let n = 1; n < IGAM_MAXITER; n++) {
    fac *= -x / n
    const term = fac / (a + n)
    sum += term
    if (Math.abs(term) <= MACHEP * Math.abs(sum)) break
  }
  const logx = Math.log(x)
  const term = -expm1(a * logx - lgam1p(a))
  return term - Math.exp(a * logx - lgam(a)) * sum
}

/** igam or igamc by DLMF 8.12.3 / 8.12.4: Temme's expansion, for `a` near `x`. */
function asymptoticSeries(a: number, x: number, func: number): number {
  const K = IGAM_ASYMPTOTIC.length
  const N = IGAM_ASYMPTOTIC[0].length
  let maxpow = 0
  const lambda = x / a
  const sigma = (x - a) / a
  const etapow = new Float64Array(N)
  etapow[0] = 1
  let sum = 0
  let afac = 1
  let absoldterm = Number.POSITIVE_INFINITY
  const sgn = func === IGAM ? -1 : 1
  let eta: number
  if (lambda > 1) {
    eta = Math.sqrt(-2 * log1pmx(sigma))
  } else if (lambda < 1) {
    eta = -Math.sqrt(-2 * log1pmx(sigma))
  } else {
    eta = 0
  }
  let res = 0.5 * erfc(sgn * eta * Math.sqrt(a / 2))
  for (let k = 0; k < K; k++) {
    const row = IGAM_ASYMPTOTIC[k]
    let ck = row[0]
    for (let n = 1; n < N; n++) {
      if (n > maxpow) {
        etapow[n] = eta * etapow[n - 1]
        maxpow += 1
      }
      const ckterm = row[n] * etapow[n]
      ck += ckterm
      if (Math.abs(ckterm) < MACHEP * Math.abs(ck)) break
    }
    const term = ck * afac
    const absterm = Math.abs(term)
    if (absterm > absoldterm) break
    sum += term
    if (absterm < MACHEP * Math.abs(sum)) break
    absoldterm = absterm
    afac /= a
  }
  res += (sgn * Math.exp(-0.5 * a * eta * eta) * sum) / Math.sqrt(2 * Math.PI * a)
  return res
}

/** Whether `igam` and `igamc` take Temme's expansion at `(a, x)`. */
function asymptotic(a: number, x: number): boolean {
  const absxmaA = Math.abs(x - a) / a
  return (
    (a > IGAM_SMALL && a < IGAM_LARGE && absxmaA < IGAM_SMALLRATIO) ||
    (a > IGAM_LARGE && absxmaA < IGAM_LARGERATIO / Math.sqrt(a))
  )
}

/** cephes' `igam`: the regularised lower incomplete gamma function. */
export function igam(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x)) return Number.NaN
  if (x < 0 || a < 0) return Number.NaN
  if (a === 0) return x > 0 ? 1 : Number.NaN
  if (x === 0) return 0
  if (!Number.isFinite(a)) return Number.isFinite(x) ? 0 : Number.NaN
  if (!Number.isFinite(x)) return 1
  if (asymptotic(a, x)) return asymptoticSeries(a, x, IGAM)
  if (x > 1.0 && x > a) return 1.0 - igamc(a, x)
  return igamSeries(a, x)
}

/** cephes' `igamc`: its complement. */
export function igamc(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x)) return Number.NaN
  if (x < 0 || a < 0) return Number.NaN
  if (a === 0) return x > 0 ? 0 : Number.NaN
  if (x === 0) return 1
  if (!Number.isFinite(a)) return Number.isFinite(x) ? 1 : Number.NaN
  if (!Number.isFinite(x)) return 0
  if (asymptotic(a, x)) return asymptoticSeries(a, x, IGAMC)
  if (x > 1.1) {
    if (x < a) return 1.0 - igamSeries(a, x)
    return igamcContinuedFraction(a, x)
  }
  if (x <= 0.5) {
    if (-0.4 / Math.log(x) < a) return 1.0 - igamSeries(a, x)
    return igamcSeries(a, x)
  }
  if (x * 1.1 < a) return 1.0 - igamSeries(a, x)
  return igamcSeries(a, x)
}
