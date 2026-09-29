/**
 * The draws a resampled map is made of (§6.5): a seeded generator, and the two
 * discrete distributions that drawing contacts reduces to.
 *
 * **Subsampling** is choosing `N` of a file's `T` contacts, every subset equally
 * likely — cooltools' `random-sample --count N --exact`, which draws `N` distinct
 * indices out of `range(T)` and counts how many land in each pixel. The count a
 * group of contacts receives is then **hypergeometric**, and a sample drawn group
 * by group — sequence pairs, then pixels — with each group's share hypergeometric
 * in what is left is the same distribution, drawn without ever holding `T`
 * indices. **Oversampling** adds contacts drawn with replacement from a
 * probability map, whose shares are **binomial** in the same way.
 *
 * Both samplers are numpy's, ported line for line (`random_binomial` with its
 * BTPE and inversion arms, `random_hypergeometric` with HRUA and the direct
 * draw), because they are the published, tested answers to how these two are
 * drawn exactly at any size — a count of 190,000 on a diagonal pixel and a
 * genome of 10⁹ contacts included — and a sampler written from a textbook is a
 * sampler whose tails nobody has checked.
 *
 * The generator is **xoshiro128\*\***, not the analysis tasks' mulberry32
 * (`analysis/random.ts`): that one's period is 2³², which is fine for resampling
 * a few thousand rows and not for a stream that walks a hundred million contacts.
 * Each group gets a generator of its own, seeded from the map's seed and the
 * group's coordinates ({@link seedOf}), so what a pixel receives does not depend
 * on which other pixels happened to be read beside it — the property that lets
 * two workers, and the command line, arrive at the same map.
 */

/** 2⁵³, the denominator of a double drawn from 53 random bits. */
const TWO_53 = 9007199254740992

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k))
}

/** A murmur3 finaliser: every input bit moves every output bit. */
function avalanche(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * One 32-bit seed from several integers — a map's seed and a group's coordinates.
 *
 * Each part is folded in as two 32-bit halves, so a coordinate past 2³² (a pixel
 * key on a large genome) is not truncated into a collision with a small one.
 */
export function seedOf(...parts: number[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    const value = Number.isFinite(part) ? Math.trunc(part) : 0
    const lo = value >>> 0
    const hi = Math.floor(value / 4294967296) >>> 0
    h = avalanche((h ^ lo) + 0x9e3779b9)
    h = avalanche((h ^ hi) + 0x7f4a7c15)
  }
  return h
}

/**
 * xoshiro128\*\* (Blackman & Vigna), seeded through splitmix32.
 *
 * Four 32-bit words of state and a period of 2¹²⁸ − 1; every output is one
 * `Math.imul` chain, which is what keeps a draw per contact affordable.
 */
export class Rng {
  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(seed: number) {
    let a = seed | 0
    const splitmix = (): number => {
      a = (a + 0x9e3779b9) | 0
      let t = a ^ (a >>> 16)
      t = Math.imul(t, 0x21f0aaad)
      t ^= t >>> 15
      t = Math.imul(t, 0x735a2d97)
      return (t ^ (t >>> 15)) >>> 0
    }
    this.s0 = splitmix()
    this.s1 = splitmix()
    this.s2 = splitmix()
    this.s3 = splitmix()
    // The one state the generator cannot leave. Four zero words out of
    // splitmix is not a thing that happens, and this makes it impossible.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1
  }

  /** A uniform integer in `[0, 2³²)`. */
  nextUint32(): number {
    let s0 = this.s0
    let s1 = this.s1
    let s2 = this.s2
    let s3 = this.s3
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0
    const t = s1 << 9
    s2 ^= s0
    s3 ^= s1
    s1 ^= s2
    s0 ^= s3
    s2 ^= t
    s3 = rotl(s3, 11)
    this.s0 = s0
    this.s1 = s1
    this.s2 = s2
    this.s3 = s3
    return result
  }

  /** A uniform double in `[0, 1)`, from 53 random bits. */
  nextDouble(): number {
    const hi = this.nextUint32() >>> 5
    const lo = this.nextUint32() >>> 6
    return (hi * 67108864 + lo) / TWO_53
  }

  /**
   * A uniform integer in `[0, max]`, inclusive — numpy's `random_interval`.
   *
   * Masked rejection below 2³², which is exact; above it a 53-bit double is
   * scaled, whose bias is one part in 2⁵³⁻ᵏ for a `max` of `k` bits — below
   * anything a count could show.
   */
  interval(max: number): number {
    if (max <= 0) return 0
    if (max <= 0xffffffff) {
      let mask = max
      mask |= mask >>> 1
      mask |= mask >>> 2
      mask |= mask >>> 4
      mask |= mask >>> 8
      mask |= mask >>> 16
      for (;;) {
        const value = (this.nextUint32() & mask) >>> 0
        if (value <= max) return value
      }
    }
    return Math.floor(this.nextDouble() * (max + 1))
  }
}

// ---------------------------------------------------------------------------
// Binomial — numpy's `random_binomial`
// ---------------------------------------------------------------------------

/**
 * The number of successes in `n` trials of probability `p`.
 *
 * numpy's dispatch: inversion where the mean is at most 30, BTPE above it, each
 * on the smaller of `p` and `1 − p`.
 */
export function binomial(rng: Rng, n: number, p: number): number {
  if (!(n > 0) || !(p > 0)) return 0
  if (p >= 1) return n
  if (p <= 0.5) {
    return p * n <= 30 ? binomialInversion(rng, n, p) : binomialBtpe(rng, n, p)
  }
  const q = 1 - p
  return n - (q * n <= 30 ? binomialInversion(rng, n, q) : binomialBtpe(rng, n, q))
}

/** `random_binomial_inversion`: walk the CDF from zero, restarting past the bound. */
function binomialInversion(rng: Rng, n: number, p: number): number {
  const q = 1 - p
  // `log1p` where numpy writes `log(q)`: the same number, without the digits
  // `1 − p` loses when `p` is a few parts in a billion.
  const qn = Math.exp(n * Math.log1p(-p))
  const np = n * p
  const bound = Math.min(n, Math.floor(np + 10 * Math.sqrt(np * q + 1)))
  let x = 0
  let px = qn
  let u = rng.nextDouble()
  while (u > px) {
    x++
    if (x > bound) {
      x = 0
      px = qn
      u = rng.nextDouble()
    } else {
      u -= px
      px = ((n - x + 1) * p * px) / (x * q)
    }
  }
  return x
}

/** The Stirling correction BTPE's final acceptance test adds for one argument. */
function stirlingTail(v: number): number {
  const v2 = v * v
  return (13680 - (462 - (132 - (99 - 140 / v2) / v2) / v2) / v2) / v / 166320
}

/**
 * `random_binomial_btpe` (Kachitvichyanukul & Schmeiser, 1988), for `p ≤ ½`.
 *
 * The four regions of the dominating function — triangle, two parallelograms,
 * two exponential tails — and numpy's step labels in the comments, so the port
 * can be read against its source.
 */
function binomialBtpe(rng: Rng, n: number, p: number): number {
  const r = Math.min(p, 1 - p)
  const q = 1 - r
  const fm = n * r + r
  const m = Math.floor(fm)
  const p1 = Math.floor(2.195 * Math.sqrt(n * r * q) - 4.6 * q) + 0.5
  const xm = m + 0.5
  const xl = xm - p1
  const xr = xm + p1
  const c = 0.134 + 20.5 / (15.3 + m)
  let a = (fm - xl) / (fm - xl * r)
  const laml = a * (1 + a / 2)
  a = (xr - fm) / (xr * q)
  const lamr = a * (1 + a / 2)
  const p2 = p1 * (1 + 2 * c)
  const p3 = p2 + c / laml
  const p4 = p3 + c / lamr
  const nrq = n * r * q
  const done = (y: number): number => (p > 0.5 ? n - y : y)

  for (;;) {
    // Step 10: the triangle.
    const u = rng.nextDouble() * p4
    let v = rng.nextDouble()
    let y: number
    if (u <= p1) return done(Math.floor(xm - p1 * v + u))
    if (u <= p2) {
      // Step 20: the parallelograms.
      const x = xl + (u - p1) / c
      v = v * c + 1 - Math.abs(m - x + 0.5) / p1
      if (v > 1) continue
      y = Math.floor(x)
    } else if (u <= p3) {
      // Step 30: the left tail.
      y = Math.floor(xl + Math.log(v) / laml)
      if (y < 0 || v === 0) continue
      v = v * (u - p2) * laml
    } else {
      // Step 40: the right tail.
      y = Math.floor(xr - Math.log(v) / lamr)
      if (y > n || v === 0) continue
      v = v * (u - p3) * lamr
    }
    // Step 50: an explicit ratio of probabilities, near the mode.
    const k = Math.abs(y - m)
    if (!(k > 20 && k < nrq / 2 - 1)) {
      const s = r / q
      const aa = s * (n + 1)
      let f = 1
      if (m < y) {
        for (let i = m + 1; i <= y; i++) f *= aa / i - s
      } else if (m > y) {
        for (let i = y + 1; i <= m; i++) f /= aa / i - s
      }
      if (v > f) continue
      return done(y)
    }
    // Step 52: squeeze on the log, then the Stirling bound.
    const rho = (k / nrq) * ((k * (k / 3 + 0.625) + 0.16666666666666666) / nrq + 0.5)
    const t = (-k * k) / (2 * nrq)
    const A = Math.log(v)
    if (A < t - rho) return done(y)
    if (A > t + rho) continue
    const x1 = y + 1
    const f1 = m + 1
    const z = n + 1 - m
    const w = n - y + 1
    const bound =
      xm * Math.log(f1 / x1) +
      (n - m + 0.5) * Math.log(z / w) +
      (y - m) * Math.log((w * r) / (x1 * q)) +
      stirlingTail(f1) +
      stirlingTail(z) +
      stirlingTail(x1) +
      stirlingTail(w)
    if (A > bound) continue
    return done(y)
  }
}

// ---------------------------------------------------------------------------
// Hypergeometric — numpy's `random_hypergeometric`
// ---------------------------------------------------------------------------

/** `log k!` below 126, where numpy tabulates it. */
const LOG_FACTORIAL = (() => {
  const table = new Float64Array(126)
  for (let k = 2; k < 126; k++) table[k] = table[k - 1] + Math.log(k)
  return table
})()

const HALF_LN_2PI = 0.9189385332046728

/** `log k!`: the table, then Stirling's series to the `1/k³` term, as numpy has it. */
export function logFactorial(k: number): number {
  if (k < 126) return LOG_FACTORIAL[k]
  return (k + 0.5) * Math.log(k) - k + (HALF_LN_2PI + (1 / k) * (1 / 12 - 1 / (360 * k * k)))
}

/**
 * How many of `sample` draws without replacement, from `good` marked and `bad`
 * unmarked items, are marked.
 *
 * numpy's dispatch: the ratio-of-uniforms method once ten or more draws are
 * taken and ten or more are left, the direct draw otherwise.
 */
export function hypergeometric(rng: Rng, good: number, bad: number, sample: number): number {
  if (!(sample > 0) || !(good > 0)) return 0
  if (!(bad > 0)) return Math.min(sample, good)
  const total = good + bad
  if (sample >= total) return good
  if (sample >= 10 && sample <= total - 10) return hypergeometricHrua(rng, good, bad, sample)
  return hypergeometricDirect(rng, good, bad, sample)
}

/** `hypergeometric_sample`: take the draws one at a time, from the smaller side. */
function hypergeometricDirect(rng: Rng, good: number, bad: number, sample: number): number {
  const total = good + bad
  const half = Math.floor(total / 2)
  let left = sample > half ? total - sample : sample
  let remainingTotal = total
  let remainingGood = good
  while (left > 0 && remainingGood > 0 && remainingTotal > remainingGood) {
    remainingTotal--
    if (rng.interval(remainingTotal) < remainingGood) remainingGood--
    left--
  }
  // Only marked items remain: every draw left takes one.
  if (remainingTotal === remainingGood) remainingGood -= left
  return sample > half ? remainingGood : good - remainingGood
}

const HRUA_D1 = 1.7155277699214135
const HRUA_D2 = 0.8989161620588988

/**
 * `hypergeometric_hrua` (Stadlober, 1989): ratio of uniforms under a table
 * mountain, on the smaller of the two sides and the smaller of sample and
 * complement, mapped back at the end.
 */
function hypergeometricHrua(rng: Rng, good: number, bad: number, sample: number): number {
  const popsize = good + bad
  const computedSample = Math.min(sample, popsize - sample)
  const minGoodBad = Math.min(good, bad)
  const maxGoodBad = Math.max(good, bad)
  const p = minGoodBad / popsize
  const q = maxGoodBad / popsize
  const mu = computedSample * p
  const a = mu + 0.5
  const variance = ((popsize - computedSample) * computedSample * p * q) / (popsize - 1)
  const c = Math.sqrt(variance + 0.5)
  const h = HRUA_D1 * c + HRUA_D2
  const m = Math.floor(((computedSample + 1) * (minGoodBad + 1)) / (popsize + 2))
  const g =
    logFactorial(m) +
    logFactorial(minGoodBad - m) +
    logFactorial(computedSample - m) +
    logFactorial(maxGoodBad - computedSample + m)
  // Sixteen standard deviations past the mean, or the end of the support.
  const b = Math.min(Math.min(computedSample, minGoodBad) + 1, Math.floor(a + 16 * c))
  let k: number
  for (;;) {
    const u = rng.nextDouble()
    const v = rng.nextDouble()
    // numpy divides by `U` unguarded; a zero here is one draw in 2⁵³, and it
    // would turn `X` into a NaN that every comparison below lets through.
    if (u === 0) continue
    const x = a + (h * (v - 0.5)) / u
    if (x < 0 || x >= b) continue
    k = Math.floor(x)
    const gp =
      logFactorial(k) +
      logFactorial(minGoodBad - k) +
      logFactorial(computedSample - k) +
      logFactorial(maxGoodBad - computedSample + k)
    const t = g - gp
    if (u * (4 - u) - 3 <= t) break
    if (u * (u - t) >= 1) continue
    if (2 * Math.log(u) <= t) break
  }
  if (good > bad) k = computedSample - k
  if (computedSample < sample) k = good - k
  return k
}
