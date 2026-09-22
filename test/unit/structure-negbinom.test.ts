/**
 * pastis-NB, held still (§25.6).
 *
 * Three things are checked, in the order they can break. The **gradient**
 * against finite differences, because a hand-written derivative that disagrees
 * with its own function by a sign or a factor still descends *somewhere* and
 * the model it lands on looks like a model. The **Poisson limit**, because
 * pastis-PM2 is the `r = ∞` corner of this and a negative binomial that does
 * not reduce to it is not a negative binomial. And the **recovery**: a helix
 * whose counts were made by the law comes back as that helix, which is the one
 * golden a reconstruction can honestly have (§18.9).
 */

import { describe, expect, it } from 'vitest'

import {
  POISSON_DISPERSION,
  dispersionBySeparation,
  dispersionRange,
  fitNegativeBinomial,
  negBinomObjective,
  negBinomValue,
  packModel,
  readModel,
  seedBeta,
  type NegBinomModel,
} from '@/structure/negbinom'
import { classicalMds, fillDistances, distancesFromContacts, spearman, type Coordinates } from '@/structure/reconstruct'

/** A helix of `n` beads, the same one `structure-reconstruct.test.ts` uses. */
function helix(n: number): Coordinates {
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * 0.5
    x[i] = Math.cos(t) * 3
    y[i] = Math.sin(t) * 3
    z[i] = i * 0.35
  }
  return { x, y, z }
}

function pairDistances(c: Coordinates): number[] {
  const n = c.x.length
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      out.push(Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j]))
    }
  }
  return out
}

/** The means the law gives, `β bᵢ bⱼ d^(−α)`, as the counts — zeros where `drop` says. */
function meansOf(
  c: Coordinates,
  alpha: number,
  beta: number,
  drop?: (i: number, j: number) => boolean,
  bias?: Float64Array,
): Float64Array {
  const n = c.x.length
  const values = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (drop?.(i, j) === true) {
        values[i * n + j] = 0
        continue
      }
      const d = Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j])
      values[i * n + j] = beta * (bias === undefined ? 1 : bias[i] * bias[j]) * Math.pow(d, -alpha)
    }
  }
  return values
}

/** A deterministic stream in [0, 1), so two runs of a test give one answer. */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

/**
 * A Poisson draw at `lambda`, by Knuth's method, off the same stream.
 *
 * The generative model the whole method assumes, so the sparse-map golden below
 * is counts that were actually *drawn* rather than counts that were rounded.
 */
function poissonDraw(next: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0
  const limit = Math.exp(-lambda)
  let k = 0
  let product = 1
  do {
    k++
    product *= Math.max(1e-300, next())
  } while (product > limit)
  return k - 1
}

const N = 48
const ALPHA = 3
const BETA = 4
const GROUP = Int32Array.from({ length: N }, (_, i) => (i < 30 ? 0 : 1))
const INDEX = Int32Array.from({ length: N }, (_, i) => (i < 30 ? i : i - 30))

function modelOf(counts: Float64Array, n = N, group = GROUP, index = INDEX, alpha = ALPHA): NegBinomModel {
  return { counts, n, group, index, alpha, dispersion: dispersionBySeparation(counts, n, group, index) }
}

describe('the negative binomial objective', () => {
  it('has the gradient it claims, to a central difference', () => {
    const truth = helix(N)
    const counts = meansOf(truth, ALPHA, BETA)
    // A dispersion that actually varies, so the `r`-dependent terms are
    // exercised rather than sitting at the Poisson corner.
    const cis = Float64Array.from({ length: N }, (_, s) => (s === 0 ? POISSON_DISPERSION : 0.5 + s * 0.3))
    // …and a coverage bias that actually varies, so the `b` terms are in play.
    const bias = Float64Array.from({ length: N }, (_, i) => 0.4 + ((i * 7) % 11) / 8)
    const model: NegBinomModel = {
      counts,
      n: N,
      group: GROUP,
      index: INDEX,
      alpha: ALPHA,
      bias,
      dispersion: { cis, trans: 1.7 },
    }
    const objective = negBinomObjective(model)

    // Somewhere that is *not* the optimum, so every component is non-zero.
    const nudge = stream(99)
    const start = helix(N)
    for (let i = 0; i < N; i++) {
      start.x[i] += (nudge() - 0.5) * 1.5
      start.y[i] += (nudge() - 0.5) * 1.5
      start.z[i] += (nudge() - 0.5) * 1.5
    }
    const point = packModel(start, BETA * 1.3)
    const analytic = new Float64Array(point.length)
    objective(point, analytic)

    const scratch = new Float64Array(point.length)
    // Every coordinate of six beads spread through both sequences, and `log β`.
    const probes = [0, 1, 7, 29, 30, 41].flatMap((bead) => [bead, N + bead, 2 * N + bead])
    probes.push(3 * N)
    for (const at of probes) {
      const h = Math.max(1e-6, Math.abs(point[at]) * 1e-6)
      const held = point[at]
      point[at] = held + h
      const up = objective(point, scratch)
      point[at] = held - h
      const down = objective(point, scratch)
      point[at] = held
      const numeric = (up - down) / (2 * h)
      expect(Math.abs(analytic[at] - numeric)).toBeLessThan(1e-5 * Math.max(1, Math.abs(numeric)))
    }
  })

  it('is minimised where the mean equals the count, whatever the dispersion', () => {
    // `d/dμ [(r+c)log1p(μ/r) − c log μ] = (r+c)/(r+μ) − c/μ`, which is zero at
    // `μ = c` for every `r`. So a model whose law reproduces the counts exactly
    // is a stationary point, and its gradient in the coordinates is zero too.
    const truth = helix(N)
    const counts = meansOf(truth, ALPHA, BETA)
    for (const r of [0.2, 5, POISSON_DISPERSION]) {
      const model: NegBinomModel = {
        counts,
        n: N,
        group: GROUP,
        index: INDEX,
        alpha: ALPHA,
        dispersion: { cis: new Float64Array(N).fill(r), trans: r },
      }
      const gradient = new Float64Array(3 * N + 1)
      negBinomObjective(model)(packModel(truth, BETA), gradient)
      let most = 0
      for (const g of gradient) most = Math.max(most, Math.abs(g))
      expect(most).toBeLessThan(1e-9)
    }
  })

  it('becomes the Poisson as the dispersion runs out', () => {
    const truth = helix(20)
    const group = new Int32Array(20)
    const index = Int32Array.from({ length: 20 }, (_, i) => i)
    const counts = meansOf(truth, ALPHA, BETA)
    const shifted: Coordinates = { x: truth.x.map((v) => v * 1.4), y: truth.y, z: truth.z }
    // The Poisson negative log-likelihood, written out: `Σ μ − c log μ`.
    let poisson = 0
    for (let i = 0; i < 20; i++) {
      for (let j = i + 1; j < 20; j++) {
        const d = Math.hypot(shifted.x[i] - shifted.x[j], shifted.y[i] - shifted.y[j], shifted.z[i] - shifted.z[j])
        const mu = BETA * Math.pow(d, -ALPHA)
        poisson += mu - counts[i * 20 + j] * Math.log(mu)
      }
    }
    const model: NegBinomModel = {
      counts,
      n: 20,
      group,
      index,
      alpha: ALPHA,
      dispersion: { cis: new Float64Array(20).fill(POISSON_DISPERSION), trans: POISSON_DISPERSION },
    }
    expect(negBinomValue(model, shifted, BETA)).toBeCloseTo(poisson, 4)
  })

  it('reads a zero as evidence and a gap as nothing', () => {
    // Two beads, one pair. A counted zero says *far*, so the likelihood falls
    // as they separate; an unobservable pair says nothing, so it is flat.
    const group = new Int32Array(2)
    const index = Int32Array.from([0, 1])
    const near: Coordinates = { x: Float64Array.from([0, 1]), y: new Float64Array(2), z: new Float64Array(2) }
    const far: Coordinates = { x: Float64Array.from([0, 4]), y: new Float64Array(2), z: new Float64Array(2) }
    const dispersion = { cis: Float64Array.from([POISSON_DISPERSION, 2]), trans: 2 }

    const zero = Float64Array.from([0, 0, 0, 0])
    const zeroModel: NegBinomModel = { counts: zero, n: 2, group, index, alpha: ALPHA, dispersion }
    expect(negBinomValue(zeroModel, far, 1)).toBeLessThan(negBinomValue(zeroModel, near, 1))

    const gap = Float64Array.from([0, Number.NaN, Number.NaN, 0])
    const gapModel: NegBinomModel = { counts: gap, n: 2, group, index, alpha: ALPHA, dispersion }
    expect(negBinomValue(gapModel, far, 1)).toBe(negBinomValue(gapModel, near, 1))
    expect(negBinomValue(gapModel, far, 1)).toBe(0)
  })

  it('refuses a collided pair rather than returning an infinity in the gradient', () => {
    const group = new Int32Array(2)
    const index = Int32Array.from([0, 1])
    const counts = Float64Array.from([0, 3, 3, 0])
    const model: NegBinomModel = {
      counts,
      n: 2,
      group,
      index,
      alpha: ALPHA,
      dispersion: { cis: Float64Array.from([POISSON_DISPERSION, 2]), trans: 2 },
    }
    const same: Coordinates = { x: new Float64Array(2), y: new Float64Array(2), z: new Float64Array(2) }
    expect(negBinomValue(model, same, 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('the dispersion', () => {
  it('recovers a known overdispersion from the mean and the variance', () => {
    // 400 beads on one sequence; at every separation the counts are drawn
    // around a mean of 10 with a variance of 10 + 100/r for a known r.
    const n = 400
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const counts = new Float64Array(n * n)
    const next = stream(1234)
    // A mean far enough from zero that clipping the draw there is negligible:
    // the estimator is a statement about two moments, and a clipped tail moves
    // both of them.
    const mean = 200
    const r = 10
    const sd = Math.sqrt(mean + (mean * mean) / r)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // Box–Muller from the deterministic stream: the moment estimator is a
        // statement about the first two moments and nothing else, so a normal
        // with the negative binomial's variance tests exactly what it claims.
        const u = Math.max(1e-12, next())
        const v = next()
        const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
        const c = Math.max(0, mean + g * sd)
        counts[i * n + j] = c
        counts[j * n + i] = c
      }
    }
    const dispersion = dispersionBySeparation(counts, n, group, index)
    // Within a tenth. A variance from four hundred pairs has a standard error
    // of about seven per cent of itself, and `r` inherits it, so the digit is
    // not the claim — the magnitude is.
    expect(dispersion.cis[1]).toBeGreaterThan(r * 0.9)
    expect(dispersion.cis[1]).toBeLessThan(r * 1.1)
    expect(dispersion.cis[200]).toBeGreaterThan(r * 0.9)
    expect(dispersion.cis[200]).toBeLessThan(r * 1.1)
  })

  it('says Poisson where the counts are not overdispersed at all', () => {
    const n = 120
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const counts = new Float64Array(n * n).fill(5)
    for (let i = 0; i < n; i++) counts[i * n + i] = 0
    const dispersion = dispersionBySeparation(counts, n, group, index)
    expect(dispersion.cis[1]).toBe(POISSON_DISPERSION)
    expect(dispersionRange(dispersion).poisson).toBe(true)
  })

  it('grows the dispersion with separation where the map does', () => {
    // Exact near the diagonal, noisy far from it: the shape every Hi-C map has
    // and the one thing pastis-NB claims over pastis-PM2.
    const n = 300
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const counts = new Float64Array(n * n)
    const next = stream(77)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = j - i
        const c = s <= 10 ? 8 : 8 * (0.1 + next() * 1.8)
        counts[i * n + j] = c
        counts[j * n + i] = c
      }
    }
    const dispersion = dispersionBySeparation(counts, n, group, index)
    expect(dispersion.cis[1]).toBe(POISSON_DISPERSION)
    expect(dispersion.cis[200]).toBeLessThan(10)
    const range = dispersionRange(dispersion)
    expect(range.far).toBeLessThan(range.near)
    expect(range.poisson).toBe(false)
  })

  it('leaves a separation with too few pairs to the nearest one that had them', () => {
    const n = 40
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const counts = new Float64Array(n * n).fill(3)
    for (let i = 0; i < n; i++) counts[i * n + i] = 0
    const dispersion = dispersionBySeparation(counts, n, group, index)
    // Separation 39 is a single pair — far too few to believe a variance of —
    // and it still has a number, taken from the nearest bin that had enough.
    expect(Number.isFinite(dispersion.cis[39])).toBe(true)
    expect(dispersion.cis[39]).toBe(POISSON_DISPERSION)
  })
})

describe('the fit', () => {
  it('seeds β so the model’s predicted total matches the observed one', () => {
    const truth = helix(N)
    const counts = meansOf(truth, ALPHA, BETA)
    expect(seedBeta(modelOf(counts), truth)).toBeCloseTo(BETA, 6)
  })

  it('packs and reads a model back unchanged', () => {
    const truth = helix(12)
    const vector = packModel(truth, 2.5)
    const into: Coordinates = { x: new Float64Array(12), y: new Float64Array(12), z: new Float64Array(12) }
    expect(readModel(vector, into)).toBeCloseTo(2.5, 12)
    expect(Array.from(into.x)).toEqual(Array.from(truth.x))
    expect(Array.from(into.z)).toEqual(Array.from(truth.z))
  })

  it('gets a known helix back from the counts its law implies', () => {
    const truth = helix(N)
    const counts = meansOf(truth, ALPHA, BETA)
    const model = modelOf(counts)
    // Started where the runner starts it: the classical MDS solution.
    const start = classicalMds(
      fillDistances(distancesFromContacts(counts, N, ALPHA), N, GROUP, INDEX),
      N,
    )
    const walk = fitNegativeBinomial(model, start, { iterations: 400 })
    let step = walk.next()
    while (step.done !== true) step = walk.next()
    const fit = step.value
    const rho = spearman(pairDistances(truth), pairDistances(fit.coords))
    expect(rho).toBeGreaterThan(0.999)
    expect(fit.stop).not.toBe('search')
  })

  it('gets it back from a map that is three-quarters zeros', () => {
    // A shallow experiment, drawn rather than described: counts are Poisson at
    // the law's own mean, and `β` is low enough that three pairs in four came
    // back empty. This is the case the two positions part company over. Under
    // ShRec3D those zeros are not distances at all and the filling has to
    // invent them, which is why the classical start below is barely correlated
    // with the truth; here each one is a reading that says *probably far*, and
    // the fit is carried by them.
    const truth = helix(N)
    const next = stream(5)
    const counts = new Float64Array(N * N)
    let zeros = 0
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const d = Math.hypot(truth.x[i] - truth.x[j], truth.y[i] - truth.y[j], truth.z[i] - truth.z[j])
        const c = poissonDraw(next, 60 * Math.pow(d, -ALPHA))
        counts[i * N + j] = c
        counts[j * N + i] = c
        if (c === 0) zeros++
      }
    }
    expect(zeros / ((N * (N - 1)) / 2)).toBeGreaterThan(0.7)

    // The start is the ShRec3D model: only the pairs that were counted are
    // distances, and the rest are filled.
    const seen = new Float64Array(N * N).fill(Number.NaN)
    for (let at = 0; at < counts.length; at++) if (counts[at] > 0) seen[at] = counts[at]
    const start = classicalMds(fillDistances(distancesFromContacts(seen, N, ALPHA), N, GROUP, INDEX), N)
    expect(spearman(pairDistances(truth), pairDistances(start))).toBeLessThan(0.4)

    const walk = fitNegativeBinomial(modelOf(counts), start, { iterations: 400 })
    let step = walk.next()
    while (step.done !== true) step = walk.next()
    expect(spearman(pairDistances(truth), pairDistances(step.value.coords))).toBeGreaterThan(0.9)
  })

  it('shrinks a pair’s pull by exactly r/(r + μ), which is the whole of the method', () => {
    // The one identity everything else rests on: the negative binomial's force
    // on a pair is the Poisson's, scaled by `r/(r + μ)`. Measured on a single
    // pair, against the Poisson corner of the same function.
    const group = new Int32Array(2)
    const index = Int32Array.from([0, 1])
    const counts = Float64Array.from([0, 9, 9, 0])
    const apart: Coordinates = { x: Float64Array.from([0, 2]), y: new Float64Array(2), z: new Float64Array(2) }
    const beta = 5
    const mu = beta * Math.pow(2, -ALPHA)
    const pull = (r: number): number => {
      const gradient = new Float64Array(7)
      negBinomObjective({
        counts,
        n: 2,
        group,
        index,
        alpha: ALPHA,
        dispersion: { cis: Float64Array.from([POISSON_DISPERSION, r]), trans: r },
      })(packModel(apart, beta), gradient)
      return gradient[0]
    }
    // The Poisson's own pull, from first principles rather than from this
    // function: `k = μ − c`, times `−α/d²`, times the separation along x.
    const poisson = ((-ALPHA * (mu - 9)) / 4) * -2
    // `POISSON_DISPERSION` is a million and not an infinity, so even the corner
    // is shrunk — by six parts in ten million, which is the point of choosing
    // a million and is checked here rather than assumed.
    expect(pull(POISSON_DISPERSION)).toBeCloseTo((poisson * POISSON_DISPERSION) / (POISSON_DISPERSION + mu), 9)
    expect(pull(POISSON_DISPERSION) / poisson).toBeGreaterThan(1 - 1e-6)

    for (const r of [0.25, 1, 4, 100]) {
      expect(pull(r)).toBeCloseTo((poisson * r) / (r + mu), 9)
      // …and it is a shrinkage, never an amplification.
      expect(Math.abs(pull(r))).toBeLessThan(Math.abs(poisson))
    }
  })

  it('scales a pair’s mean by its two beads’ coverage, and nothing else', () => {
    // The bias enters the mean and only the mean, so a model whose law
    // reproduces the counts is still stationary — with the biased counts.
    const truth = helix(N)
    const bias = Float64Array.from({ length: N }, (_, i) => 0.5 + ((i * 3) % 7) / 5)
    const counts = meansOf(truth, ALPHA, BETA, undefined, bias)
    const model: NegBinomModel = {
      counts,
      n: N,
      group: GROUP,
      index: INDEX,
      alpha: ALPHA,
      bias,
      dispersion: { cis: new Float64Array(N).fill(3), trans: 3 },
    }
    const gradient = new Float64Array(3 * N + 1)
    negBinomObjective(model)(packModel(truth, BETA), gradient)
    let most = 0
    for (const g of gradient) most = Math.max(most, Math.abs(g))
    expect(most).toBeLessThan(1e-9)
    // …and the same counts read without the bias are *not* at a maximum: the
    // uneven coverage would be read as geometry.
    const blind = { ...model, bias: null }
    const blindGradient = new Float64Array(3 * N + 1)
    negBinomObjective(blind)(packModel(truth, seedBeta(blind, truth)), blindGradient)
    let blindMost = 0
    for (const g of blindGradient) blindMost = Math.max(blindMost, Math.abs(g))
    expect(blindMost).toBeGreaterThan(1)
  })

  it('recovers the shape through uneven coverage, and is fooled by it without the bias', () => {
    // A helix whose beads are read between half and twice as often as each
    // other — the thing `cooler balance` measures. Given the weights, the
    // model comes back; denied them, the coverage is read as geometry.
    const n = 40
    const truth = helix(n)
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const next = stream(17)
    const bias = Float64Array.from({ length: n }, () => 0.5 + next() * 1.5)
    const counts = meansOf(truth, ALPHA, 4e3, undefined, bias)
    const start = classicalMds(fillDistances(distancesFromContacts(counts, n, ALPHA), n, group, index), n)
    const solve = (b: Float64Array | null): Coordinates => {
      const walk = fitNegativeBinomial(
        { counts, n, group, index, alpha: ALPHA, bias: b, dispersion: dispersionBySeparation(counts, n, group, index) },
        start,
        { iterations: 400 },
      )
      let step = walk.next()
      while (step.done !== true) step = walk.next()
      return step.value.coords
    }
    const corrected = spearman(pairDistances(truth), pairDistances(solve(bias)))
    const blind = spearman(pairDistances(truth), pairDistances(solve(null)))
    expect(corrected).toBeGreaterThan(0.99)
    expect(corrected).toBeGreaterThan(blind)
  })

  it('holds the near diagonal that a Poisson lets the noisy far pairs pull off', () => {
    // The claim pastis-NB makes over pastis-PM2, as a measurement. Counts are
    // exact within six beads and multiplied by a wide random factor beyond, so
    // the fitted dispersion finds the far separations unreliable — and the
    // Poisson, having only one parameter, cannot and believes them. Deep
    // enough that the far counts are in the tens: overdispersion is variance
    // above the *mean*, and a mean below one cannot show it.
    const n = 44
    const truth = helix(n)
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    const counts = meansOf(truth, ALPHA, 6e4)
    const next = stream(31)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j - i <= 6) continue
        counts[i * n + j] *= 0.2 + next() * 1.6
        counts[j * n + i] = counts[i * n + j]
      }
    }
    const start = classicalMds(fillDistances(distancesFromContacts(counts, n, ALPHA), n, group, index), n)

    const fitted = dispersionBySeparation(counts, n, group, index)
    const flat = { cis: new Float64Array(n).fill(POISSON_DISPERSION), trans: POISSON_DISPERSION }
    const solve = (dispersion: typeof fitted): Coordinates => {
      const walk = fitNegativeBinomial({ counts, n, group, index, alpha: ALPHA, dispersion }, start, {
        iterations: 400,
      })
      let step = walk.next()
      while (step.done !== true) step = walk.next()
      return step.value.coords
    }

    // Measured at the truth's scale, as `structure-reconstruct.test.ts` does:
    // each model scaled so its mean consecutive-bead distance is the truth's.
    const nearError = (c: Coordinates): number => {
      let want = 0
      let have = 0
      for (let i = 0; i + 1 < n; i++) {
        want += Math.hypot(truth.x[i] - truth.x[i + 1], truth.y[i] - truth.y[i + 1], truth.z[i] - truth.z[i + 1])
        have += Math.hypot(c.x[i] - c.x[i + 1], c.y[i] - c.y[i + 1], c.z[i] - c.z[i + 1])
      }
      const k = want / have
      let sum = 0
      let count = 0
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
          const wanted = Math.hypot(truth.x[i] - truth.x[j], truth.y[i] - truth.y[j], truth.z[i] - truth.z[j])
          const held = k * Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j])
          sum += Math.abs(held / wanted - 1)
          count++
        }
      }
      return sum / count
    }

    // The dispersion found what was done to the counts: Poisson near the
    // diagonal, heavily overdispersed away from it.
    const range = dispersionRange(fitted)
    expect(range.poisson).toBe(false)
    expect(range.near).toBe(POISSON_DISPERSION)
    expect(range.far).toBeLessThan(20)
    // …and the model it gives holds the near diagonal about twice as well.
    expect(nearError(solve(fitted))).toBeLessThan(0.6 * nearError(solve(flat)))
  })

  it('yields as it goes and never lets the likelihood rise', () => {
    const truth = helix(24)
    const group = new Int32Array(24)
    const index = Int32Array.from({ length: 24 }, (_, i) => i)
    const counts = meansOf(truth, ALPHA, BETA)
    const start = classicalMds(fillDistances(distancesFromContacts(counts, 24, ALPHA), 24, group, index), 24)
    const walk = fitNegativeBinomial(modelOf(counts, 24, group, index), start, { iterations: 60 })
    let yields = 0
    let best = Number.POSITIVE_INFINITY
    let step = walk.next()
    while (step.done !== true) {
      yields++
      expect(step.value.value).toBeLessThanOrEqual(best + 1e-12)
      best = Math.min(best, step.value.value)
      step = walk.next()
    }
    expect(yields).toBe(step.value.evaluations)
    expect(yields).toBeGreaterThan(0)
  })

  it('leaves the model it was started from alone, so a cancel keeps it', () => {
    const truth = helix(16)
    const group = new Int32Array(16)
    const index = Int32Array.from({ length: 16 }, (_, i) => i)
    const counts = meansOf(truth, ALPHA, BETA)
    const start = classicalMds(fillDistances(distancesFromContacts(counts, 16, ALPHA), 16, group, index), 16)
    const held = Array.from(start.x)
    const walk = fitNegativeBinomial(modelOf(counts, 16, group, index), start, { iterations: 30 })
    let step = walk.next()
    while (step.done !== true) step = walk.next()
    expect(Array.from(start.x)).toEqual(held)
  })

  it('is deterministic: the same counts give the same model twice', () => {
    const truth = helix(20)
    const group = new Int32Array(20)
    const index = Int32Array.from({ length: 20 }, (_, i) => i)
    const counts = meansOf(truth, ALPHA, BETA)
    const start = classicalMds(fillDistances(distancesFromContacts(counts, 20, ALPHA), 20, group, index), 20)
    const solve = (): { x: number[]; value: number } => {
      const walk = fitNegativeBinomial(modelOf(counts, 20, group, index), start, { iterations: 40 })
      let step = walk.next()
      while (step.done !== true) step = walk.next()
      return { x: Array.from(step.value.coords.x), value: step.value.value }
    }
    expect(solve()).toEqual(solve())
  })
})
