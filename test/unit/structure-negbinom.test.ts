/**
 * pastis-NB, held still (§25.6).
 *
 * Four things are checked, in the order they can break. **pastis' own
 * numbers**: the likelihood, its gradient, the MDS objective, the moments, the
 * dispersion's fit and numpy's draws, each against what pastis (GitHub
 * `6888ac2`) returns on the same input — written out below, computed once by
 * pastis itself — because a port is a claim to give pastis' answer and the
 * claim is only as good as the comparison. The **gradient** against finite
 * differences, because a hand-written derivative that disagrees with its own
 * function by a sign or a factor still descends *somewhere* and the model it
 * lands on looks like a model. The **Poisson limit**, because pastis-PM2 is
 * the `r = ∞` corner of this and a negative binomial that does not reduce to
 * it is not a negative binomial. And the **recovery**: a helix whose counts
 * were made by the law comes back as that helix, which is the one golden a
 * reconstruction can honestly have (§18.9).
 */

import { describe, expect, it } from 'vitest'

import { numpyRandom } from '@/analysis/random'
import {
  fitDispersion,
  fitMds,
  fitNegativeBinomial,
  mdsObjective,
  momentsBySeparation,
  negBinomObjective,
  negBinomValue,
  packCoordinates,
  randomStart,
  storeWishes,
  type Dispersion,
  type NegBinomFit,
  type NegBinomModel,
  type SeparationMoments,
} from '@/structure/negbinom'
import { spearman, type Coordinates } from '@/structure/reconstruct'

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

/** The means the law gives, `scale · bᵢ bⱼ d^(−α)`, as the counts. */
function meansOf(c: Coordinates, alpha: number, scale: number, bias?: Float64Array): Float64Array {
  const n = c.x.length
  const values = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j])
      values[i * n + j] = scale * (bias === undefined ? 1 : bias[i] * bias[j]) * Math.pow(d, -alpha)
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
  // Past a few hundred, `e^(−λ)` underflows and the normal is the Poisson to
  // the precision any of this is measured at.
  if (lambda > 500) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(next)))
  const limit = Math.exp(-lambda)
  let k = 0
  let product = 1
  do {
    k++
    product *= Math.max(1e-300, next())
  } while (product > limit)
  return k - 1
}

function normalDraw(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-300, next()))) * Math.cos(2 * Math.PI * next())
}

/** A gamma draw of the given shape and unit scale: Marsaglia and Tsang's method. */
function gammaDraw(next: () => number, shape: number): number {
  if (shape < 1) return gammaDraw(next, shape + 1) * Math.pow(Math.max(1e-300, next()), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normalDraw(next)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    if (Math.log(Math.max(1e-300, next())) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
}

function run<T>(walk: Generator<unknown, T, void>): T {
  let step = walk.next()
  while (step.done !== true) step = walk.next()
  return step.value
}

/** pastis' whole pipeline on `counts`: its MDS from seed `seed`, then the likelihood. */
function pastis(model: NegBinomModel, seed = 0, iterations = 400): NegBinomFit {
  const wishes = Float64Array.from(model.counts)
  storeWishes(wishes, model.n, model.bias ?? null, model.alpha)
  const start = run(fitMds(wishes, model.n, randomStart(model.n, numpyRandom(seed))))
  return run(fitNegativeBinomial(model, start.coords, { iterations }))
}

function asCoordinates(rows: number[][]): Coordinates {
  return {
    x: Float64Array.from(rows, (r) => r[0]),
    y: Float64Array.from(rows, (r) => r[1]),
    z: Float64Array.from(rows, (r) => r[2]),
  }
}

const ALPHA = 3

// ---------------------------------------------------------------------------
// What pastis returned, computed once with pastis at GitHub `6888ac2`.
// ---------------------------------------------------------------------------

/** Six beads on two sequences of four and two; counts with a zero, ones, a few, many, and one not whole. */
const GOLDEN_X = asCoordinates([
  [0.834044009405148, 1.4406489868843162, 0.00022874963468977327],
  [0.6046651452636795, 0.2935117816342261, 0.1846771895375956],
  [0.3725204227553418, 0.6911214540860955, 0.7935349484613399],
  [1.077633468006714, 0.8383890288065896, 1.370439000793519],
  [0.40890449946303487, 1.7562348727818908, 0.05477518639585233],
  [1.3409350203568045, 0.8346096047342539, 1.1173796568915033],
])
const GOLDEN_COUNTS = Float64Array.from([
  [0, 250, 20, 3, 0, 1],
  [250, 0, 31, 7, 2, 2.5],
  [20, 31, 0, 120, 1, 0],
  [3, 7, 120, 0, 4, 9],
  [0, 2, 1, 4, 0, 60],
  [1, 2.5, 0, 9, 60, 0],
].flat())
/** Coverage biases, scaled to a mean of one as pastis' pipeline scales them. */
const GOLDEN_BIAS = Float64Array.from([
  0.6285244441683296, 0.6851698933189678, 1.2766496437687498, 1.4410635744650064, 0.7983563508839242,
  1.1702360933950227,
])
/** `ExponentialDispersion(degree=1)` with these coefficients set by hand. */
const GOLDEN_DISPERSION: Dispersion = { c0: 1.2, c1: 0.15 }
/** `negative_binomial_obj` and `negative_binomial_gradient`, `use_zero_counts=True`, `β = 1`. */
const GOLDEN_NB = {
  3: { value: -1084.792334416656, gradient: [
      [94.39262424300615, 469.15740451704767, -100.02907877142952],
      [-74.01140267313795, -481.5761842654563, 6.095530669878542],
      [-219.0522422520043, -29.62846929993468, -75.68766580080896],
      [227.85225814535744, 38.46253693982219, 141.01109493545073],
      [-43.666026509692955, 49.37806951551503, -60.29211789254398],
      [14.484789046471583, -45.79335740699395, 88.90223685945321],
    ] },
  2: { value: -1141.2583017970621, gradient: [
      [62.652902436390185, 303.9847813810966, -64.8810006866124],
      [-46.405568340124844, -315.58235909755496, 0.12140164856379698],
      [-149.3400957031115, -17.50052400465936, -49.670439602165196],
      [137.34850094626412, 26.46874095923972, 111.12287750628101],
      [-29.056963360509005, 32.184626571880415, -38.244731968382546],
      [24.80122402109103, -29.555265810002386, 41.55189310231535],
    ] },
}
/** `MDS_obj_dense` at the same beads, over `compute_wish_distances(counts / bᵢbⱼ, α = −3)`. */
const GOLDEN_MDS = 275.3451209783408

/** An overdispersed map of two sequences, thirty beads and nine, one pair a gap (`−1` here, `NaN` there). */
const MOMENT_COUNTS = Float64Array.from([
  [
    0, 61, 600, 153, 6, 27, 131, 21, 0, 0, 101, 16, 46, 22, 12, 0, 14, 38, 0, 27, 1, 1, 36, 12, 1, 15, 8, 5,
    1, 1, 5, 1, 3, 0, 1, 2, 6, 12, 1,
  ],
  [
    61, 0, 137, 68, 289, 62, 74, 1, 21, 6, 65, 11, 5, 3, 7, 25, 5, 25, 26, 30, 14, 5, 13, 8, 9, 10, 1, 1, 10,
    22, 2, 1, 1, 3, 0, 0, 9, 1, 2,
  ],
  [
    600, 137, 0, 314, 192, -1, 15, 22, 64, 86, 73, 19, 56, 41, 7, 13, 1, 0, 0, 57, 36, 33, 1, 7, 0, 2, 7, 0,
    3, 1, 0, 1, 1, 1, 0, 0, 1, 0, 0,
  ],
  [
    153, 68, 314, 0, 18, 23, 79, 16, 29, 7, 154, 17, 62, 80, 14, 4, 6, 1, 0, 25, 7, 31, 15, 2, 2, 37, 4, 3, 6,
    0, 0, 0, 1, 1, 3, 2, 0, 0, 1,
  ],
  [
    6, 289, 192, 18, 0, 181, 221, 33, 59, 16, 117, 41, 10, 7, 18, 51, 0, 8, 14, 23, 18, 12, 12, 23, 3, 18, 13,
    7, 8, 39, 0, 0, 0, 3, 2, 0, 0, 3, 0,
  ],
  [
    27, 62, -1, 23, 181, 0, 82, 68, 14, 65, 28, 6, 145, 38, 2, 17, 2, 11, 2, 4, 5, 17, 3, 32, 0, 3, 1, 3, 27,
    5, 0, 0, 2, 0, 0, 4, 0, 10, 0,
  ],
  [
    131, 74, 15, 79, 221, 82, 0, 112, 76, 91, 81, 3, 26, 41, 13, 31, 4, 16, 47, 4, 0, 25, 13, 3, 0, 5, 52, 1,
    8, 16, 14, 0, 0, 1, 1, 1, 3, 1, 5,
  ],
  [
    21, 1, 22, 16, 33, 68, 112, 0, 12, 42, 346, 1, 15, 115, 3, 2, 6, 0, 2, 5, 3, 4, 1, 21, 0, 0, 35, 5, 9, 0,
    0, 1, 0, 0, 1, 0, 0, 0, 0,
  ],
  [
    0, 21, 64, 29, 59, 14, 76, 12, 0, 16, 5, 48, 66, 76, 8, 98, 27, 13, 10, 32, 1, 20, 2, 14, 6, 2, 9, 4, 1,
    3, 0, 1, 5, 1, 0, 2, 0, 0, 0,
  ],
  [
    0, 6, 86, 7, 16, 65, 91, 42, 16, 0, 273, 31, 108, 138, 6, 9, 0, 21, 5, 39, 2, 31, 16, 5, 17, 10, 1, 1, 1,
    19, 0, 0, 3, 0, 3, 2, 1, 2, 0,
  ],
  [
    101, 65, 73, 154, 117, 28, 81, 346, 5, 273, 0, 53, 198, 7, 61, 12, 22, 14, 12, 152, 3, 12, 8, 32, 1, 21,
    27, 0, 24, 0, 3, 0, 1, 0, 0, 1, 6, 1, 4,
  ],
  [
    16, 11, 19, 17, 41, 6, 3, 1, 48, 31, 53, 0, 241, 456, 6, 15, 14, 82, 12, 7, 2, 62, 14, 6, 14, 25, 21, 0,
    25, 2, 1, 0, 5, 1, 1, 7, 0, 3, 0,
  ],
  [
    46, 5, 56, 62, 10, 145, 26, 15, 66, 108, 198, 241, 0, 76, 115, 51, 6, 22, 3, 26, 4, 64, 113, 120, 6, 4, 8,
    3, 25, 45, 1, 0, 1, 2, 0, 4, 0, 0, 2,
  ],
  [
    22, 3, 41, 80, 7, 38, 41, 115, 76, 138, 7, 456, 76, 0, 33, 578, 4, 42, 50, 20, 17, 82, 125, 36, 13, 0, 46,
    38, 2, 42, 1, 0, 0, 1, 2, 3, 0, 8, 1,
  ],
  [
    12, 7, 7, 14, 18, 2, 13, 3, 8, 6, 61, 6, 115, 33, 0, 105, 15, 25, 46, 78, 13, 0, 19, 33, 7, 2, 20, 16, 26,
    2, 0, 0, 4, 0, 5, 6, 1, 0, 0,
  ],
  [
    0, 25, 13, 4, 51, 17, 31, 2, 98, 9, 12, 15, 51, 578, 105, 0, 1, 139, 20, 106, 35, 8, 47, 37, 5, 1, 24, 8,
    2, 1, 0, 0, 7, 2, 1, 1, 0, 1, 0,
  ],
  [
    14, 5, 1, 6, 0, 2, 4, 6, 27, 0, 22, 14, 6, 4, 15, 1, 0, 70, 11, 52, 13, 0, 1, 7, 2, 4, 23, 5, 11, 5, 2, 1,
    0, 3, 2, 0, 3, 0, 2,
  ],
  [
    38, 25, 0, 1, 8, 11, 16, 0, 13, 21, 14, 82, 22, 42, 25, 139, 70, 0, 152, 10, 33, 28, 55, 30, 39, 1, 54,
    17, 0, 0, 3, 4, 0, 0, 2, 6, 0, 5, 5,
  ],
  [
    0, 26, 0, 0, 14, 2, 47, 2, 10, 5, 12, 12, 3, 50, 46, 20, 11, 152, 0, 27, 166, 44, 26, 12, 21, 15, 4, 22,
    8, 9, 1, 0, 2, 0, 1, 0, 0, 0, 0,
  ],
  [
    27, 30, 57, 25, 23, 4, 4, 5, 32, 39, 152, 7, 26, 20, 78, 106, 52, 10, 27, 0, 269, 201, 52, 67, 122, 54,
    62, 0, 20, 4, 0, 2, 0, 4, 0, 0, 0, 1, 1,
  ],
  [
    1, 14, 36, 7, 18, 5, 0, 3, 1, 2, 3, 2, 4, 17, 13, 35, 13, 33, 166, 269, 0, 34, 184, 56, 147, 12, 83, 12,
    10, 20, 2, 2, 0, 1, 3, 0, 0, 0, 0,
  ],
  [
    1, 5, 33, 31, 12, 17, 25, 4, 20, 31, 12, 62, 64, 82, 0, 8, 0, 28, 44, 201, 34, 0, 376, 215, 86, 74, 109,
    73, 5, 75, 16, 7, 6, 0, 0, 0, 2, 0, 0,
  ],
  [
    36, 13, 1, 15, 12, 3, 13, 1, 2, 16, 8, 14, 113, 125, 19, 47, 1, 55, 26, 52, 184, 376, 0, 88, 43, 114, 80,
    1, 3, 55, 0, 3, 0, 0, 2, 1, 7, 8, 5,
  ],
  [
    12, 8, 7, 2, 23, 32, 3, 21, 14, 5, 32, 6, 120, 36, 33, 37, 7, 30, 12, 67, 56, 215, 88, 0, 43, 102, 23, 36,
    119, 10, 0, 1, 0, 0, 0, 0, 0, 0, 1,
  ],
  [
    1, 9, 0, 2, 3, 0, 0, 0, 6, 17, 1, 14, 6, 13, 7, 5, 2, 39, 21, 122, 147, 86, 43, 43, 0, 24, 24, 11, 60, 0,
    0, 0, 0, 0, 3, 0, 1, 0, 2,
  ],
  [
    15, 10, 2, 37, 18, 3, 5, 0, 2, 10, 21, 25, 4, 0, 2, 1, 4, 1, 15, 54, 12, 74, 114, 102, 24, 0, 119, 1, 137,
    18, 0, 0, 5, 0, 1, 1, 0, 0, 0,
  ],
  [
    8, 1, 7, 4, 13, 1, 52, 35, 9, 1, 27, 21, 8, 46, 20, 24, 23, 54, 4, 62, 83, 109, 80, 23, 24, 119, 0, 188,
    152, 60, 1, 0, 4, 1, 2, 0, 0, 0, 0,
  ],
  [
    5, 1, 0, 3, 7, 3, 1, 5, 4, 1, 0, 0, 3, 38, 16, 8, 5, 17, 22, 0, 12, 73, 1, 36, 11, 1, 188, 0, 103, 29, 1,
    0, 0, 1, 0, 3, 0, 0, 0,
  ],
  [
    1, 10, 3, 6, 8, 27, 8, 9, 1, 1, 24, 25, 25, 2, 26, 2, 11, 0, 8, 20, 10, 5, 3, 119, 60, 137, 152, 103, 0,
    279, 4, 3, 0, 1, 0, 1, 5, 0, 0,
  ],
  [
    1, 22, 1, 0, 39, 5, 16, 0, 3, 19, 0, 2, 45, 42, 2, 1, 5, 0, 9, 4, 20, 75, 55, 10, 0, 18, 60, 29, 279, 0,
    5, 0, 2, 0, 0, 1, 0, 4, 1,
  ],
  [
    5, 2, 0, 0, 0, 0, 14, 0, 0, 0, 3, 1, 1, 1, 0, 0, 2, 3, 1, 0, 2, 16, 0, 0, 0, 0, 1, 1, 4, 5, 0, 29, 72, 49,
    83, 19, 10, 9, 54,
  ],
  [
    1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 4, 0, 2, 2, 7, 3, 1, 0, 0, 0, 0, 3, 0, 29, 0, 217, 209,
    101, 72, 57, 23, 4,
  ],
  [
    3, 1, 1, 1, 0, 2, 0, 0, 5, 3, 1, 5, 1, 0, 4, 7, 0, 0, 2, 0, 0, 6, 0, 0, 0, 5, 4, 0, 0, 2, 72, 217, 0, 38,
    52, 54, 121, 114, 46,
  ],
  [
    0, 3, 1, 1, 3, 0, 1, 0, 1, 0, 0, 1, 2, 1, 0, 2, 3, 0, 0, 4, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 49, 209, 38, 0,
    248, 23, 8, 26, 9,
  ],
  [
    1, 0, 0, 3, 2, 0, 1, 1, 0, 3, 0, 1, 0, 2, 5, 1, 2, 2, 1, 0, 3, 0, 2, 0, 3, 1, 2, 0, 0, 0, 83, 101, 52,
    248, 0, 121, 21, 17, 11,
  ],
  [
    2, 0, 0, 2, 0, 4, 1, 0, 2, 2, 1, 7, 4, 3, 6, 1, 0, 6, 0, 0, 0, 0, 1, 0, 0, 1, 0, 3, 1, 1, 19, 72, 54, 23,
    121, 0, 128, 22, 58,
  ],
  [
    6, 9, 1, 0, 0, 0, 3, 0, 0, 1, 6, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 2, 7, 0, 1, 0, 0, 0, 5, 0, 10, 57, 121, 8,
    21, 128, 0, 47, 37,
  ],
  [
    12, 1, 0, 0, 3, 10, 1, 0, 0, 2, 1, 3, 0, 8, 0, 1, 0, 5, 0, 1, 0, 0, 8, 0, 0, 0, 0, 0, 0, 4, 9, 23, 114,
    26, 17, 22, 47, 0, 376,
  ],
  [
    1, 2, 0, 1, 0, 0, 5, 0, 0, 0, 4, 0, 2, 1, 0, 0, 2, 5, 0, 1, 0, 0, 5, 1, 2, 0, 0, 0, 0, 1, 54, 4, 46, 9,
    11, 58, 37, 376, 0,
  ],
].flat(), (c) => (c < 0 ? Number.NaN : c))
const MOMENT_BIAS = Float64Array.from([
  1.4366197020597533, 1.0255241180436316, 1.4421570101554606, 1.1896340104869665, 1.1729010422161348,
  0.7012456396118393, 1.445672685706904, 0.4957365822188098, 0.7373737522822585, 0.9154141906709611,
  1.2528625274339376, 0.6832227248203969, 1.3347396787460701, 1.4526511882755009, 0.6500814214540365,
  1.0745872521943856, 0.49843529868168035, 0.8681935009464727, 0.5328801361149963, 1.4264579334589607,
  0.916741214908686, 1.418941381696372, 1.2596420830227413, 1.33796741746953, 0.6592113408658633,
  0.5630304481944117, 1.0779253689163923, 0.6541257539811975, 1.207813366609324, 0.8896126806712026,
  1.0066012485717937, 1.4077720886806833, 1.000517330996699, 0.5955861109857229, 0.6445790603375495,
  1.0235365922014728, 1.0031691552274185, 1.114028662890184, 0.882808298193592,
])
/** `compute_mean_variance(counts, [30, 9], bias=bias)`, and the fit pastis' pipeline makes of it. */
const GOLDEN_MOMENTS = {
  mean: [
    141.55134048260084, 114.0357922287458, 79.97825269523264, 60.673346798233204, 37.64587361850371,
    38.56678791264015, 37.74016624068026, 21.31863921396084, 28.512350873456107, 25.642209124781118,
    16.90691459242386, 12.485471428736757, 13.50626215668887, 13.882877882195128, 10.251738661554684,
    16.766682864860837, 15.257846247846107, 11.706200233721695, 13.608870079868446,
  ],
  variance: [
    13538.498942504857, 8917.202040757242, 8246.286419866423, 1936.2039785053653, 867.4660704534518,
    1473.577860895082, 1221.19602583232, 361.3068982229742, 419.0261400445041, 327.2514783273947,
    174.05362959918585, 194.47839718906067, 82.40152824019029, 289.3837444415104, 96.96191804574018,
    83.65286389995751, 230.87161702395056, 107.82708054555917, 293.48505077298756,
  ],
  pairs: [37, 35, 32, 31, 29, 27, 25, 23, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11],
  coef: [0.6332164841573824, -0.05664247998253752],
}

function goldenMoments(): SeparationMoments {
  return {
    separation: Int32Array.from(GOLDEN_MOMENTS.mean, (_, k) => k + 1),
    mean: Float64Array.from(GOLDEN_MOMENTS.mean),
    variance: Float64Array.from(GOLDEN_MOMENTS.variance),
    pairs: Float64Array.from(GOLDEN_MOMENTS.pairs),
  }
}

describe('pastis’ own numbers', () => {
  it('draws what numpy’s RandomState draws, past the first twist of its state', () => {
    const zero = numpyRandom(0)
    expect(Array.from({ length: 6 }, zero)).toEqual([
      0.5488135039273248, 0.7151893663724195, 0.6027633760716439, 0.5448831829968969, 0.4236547993389047,
      0.6458941130666561,
    ])
    const other = numpyRandom(4242)
    const draws = Array.from({ length: 1300 }, other)
    expect(draws.slice(0, 3)).toEqual([0.32494948661751344, 0.9404145795184473, 0.9140079427719414])
    expect(draws[1299]).toBe(0.9878863112903205)
  })

  it('starts where pastis starts: 1 − 2·rand(3n), three to a bead', () => {
    const start = randomStart(2, numpyRandom(0))
    const draws = Array.from({ length: 6 }, numpyRandom(0))
    expect([start.x[0], start.y[0], start.z[0], start.x[1], start.y[1], start.z[1]]).toEqual(draws.map((u) => 1 - 2 * u))
  })

  it('is pastis’ likelihood and pastis’ gradient, at α = 3 and at any other', () => {
    for (const alpha of [3, 2] as const) {
      const model: NegBinomModel = { counts: GOLDEN_COUNTS, n: 6, bias: GOLDEN_BIAS, dispersion: GOLDEN_DISPERSION, alpha }
      const gradient = new Float64Array(18)
      const value = negBinomObjective(model)(packCoordinates(GOLDEN_X), gradient)
      expect(Math.abs(value / GOLDEN_NB[alpha].value - 1)).toBeLessThan(1e-12)
      GOLDEN_NB[alpha].gradient.forEach((bead, i) => {
        bead.forEach((want, axis) => {
          expect(Math.abs(gradient[axis * 6 + i] - want)).toBeLessThan(1e-9 * Math.max(1, Math.abs(want)))
        })
      })
    }
  })

  it('is pastis’ MDS objective, its wishes kept below the diagonal', () => {
    const wishes = Float64Array.from(GOLDEN_COUNTS)
    storeWishes(wishes, 6, GOLDEN_BIAS, ALPHA)
    // …and the counts above it untouched, for the likelihood to read.
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) expect(wishes[i * 6 + j]).toBe(GOLDEN_COUNTS[i * 6 + j])
    const value = mdsObjective(wishes, 6)(packCoordinates(GOLDEN_X), new Float64Array(18))
    expect(Math.abs(value / GOLDEN_MDS - 1)).toBeLessThan(1e-6)
  })

  it('takes pastis’ moments at each separation, zeros counted and a gap not', () => {
    const n = 39
    const group = Int32Array.from({ length: n }, (_, i) => (i < 30 ? 0 : 1))
    const index = Int32Array.from({ length: n }, (_, i) => (i < 30 ? i : i - 30))
    const moments = momentsBySeparation(MOMENT_COUNTS, n, group, index, MOMENT_BIAS)
    // Two-thirds of the longest sequence, thirty beads: separations one to nineteen.
    expect(Array.from(moments.separation)).toEqual(Array.from({ length: 19 }, (_, k) => k + 1))
    expect(Array.from(moments.pairs)).toEqual(GOLDEN_MOMENTS.pairs)
    moments.mean.forEach((m, k) => expect(Math.abs(m / GOLDEN_MOMENTS.mean[k] - 1)).toBeLessThan(1e-12))
    moments.variance.forEach((v, k) => expect(Math.abs(v / GOLDEN_MOMENTS.variance[k] - 1)).toBeLessThan(1e-12))
  })

  it('fits pastis’ curve through them, to SciPy’s own tolerance', () => {
    const fitted = fitDispersion(goldenMoments())
    if (fitted === null) throw new Error('no curve')
    // SciPy stops once a step buys less than a part in 10⁸ of the cost, so its
    // coefficients are the minimum's to about four figures; this one goes to
    // the minimum, and so costs no more than SciPy's answer does.
    expect(fitted.c0).toBeCloseTo(GOLDEN_MOMENTS.coef[0], 3)
    expect(fitted.c1).toBeCloseTo(GOLDEN_MOMENTS.coef[1], 3)
    const cost = (c0: number, c1: number): number =>
      GOLDEN_MOMENTS.mean.reduce((sum, m, k) => {
        const v = GOLDEN_MOMENTS.variance[k]
        const residual = Math.exp(c0 + c1 * Math.log(m)) - (m * m) / (v - m)
        return sum + GOLDEN_MOMENTS.pairs[k] * residual * residual
      }, 0)
    expect(cost(fitted.c0, fitted.c1)).toBeLessThanOrEqual(cost(GOLDEN_MOMENTS.coef[0], GOLDEN_MOMENTS.coef[1]) * (1 + 1e-12))
  })
})

describe('the negative binomial objective', () => {
  const n = 7
  const next = stream(3)
  const coords: Coordinates = {
    x: Float64Array.from({ length: n }, () => next() * 4),
    y: Float64Array.from({ length: n }, () => next() * 4),
    z: Float64Array.from({ length: n }, () => next() * 4),
  }
  // Every kind of pair: a zero, a gap, a one, small whole counts, a large one
  // past the exact sum, and one that is not whole.
  const counts = new Float64Array(n * n)
  const kinds = [0, Number.NaN, 1, 3, 7, 16, 17, 40, 2.5, 900]
  let at = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      counts[i * n + j] = kinds[at++ % kinds.length]
      counts[j * n + i] = counts[i * n + j]
    }
  }
  const bias = Float64Array.from({ length: n }, (_, i) => 0.6 + i * 0.13)

  it('has the gradient it claims, to a central difference, with the dispersion moving with the mean', () => {
    for (const dispersion of [{ c0: 0.7, c1: 0.35 }, { c0: 2, c1: -0.2 }, null]) {
      for (const alpha of [3, 1.7]) {
        const objective = negBinomObjective({ counts, n, bias, dispersion, alpha })
        const point = packCoordinates(coords)
        const gradient = new Float64Array(3 * n)
        objective(point, gradient)
        const scratch = new Float64Array(3 * n)
        for (let k = 0; k < 3 * n; k++) {
          const h = 1e-6
          const up = Float64Array.from(point)
          const down = Float64Array.from(point)
          up[k] += h
          down[k] -= h
          const numeric = (objective(up, scratch) - objective(down, scratch)) / (2 * h)
          expect(Math.abs(gradient[k] - numeric)).toBeLessThan(1e-5 * Math.max(1, Math.abs(numeric)))
        }
      }
    }
  })

  it('becomes the Poisson as the dispersion runs out', () => {
    // pastis-PM2, written from first principles: Σ μ − c log μ.
    let poisson = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c = counts[i * n + j]
        if (Number.isNaN(c)) continue
        const d = Math.hypot(coords.x[i] - coords.x[j], coords.y[i] - coords.y[j], coords.z[i] - coords.z[j])
        const mu = bias[i] * bias[j] * Math.pow(d, -ALPHA)
        poisson += mu - (c > 0 ? c * Math.log(mu) : 0)
      }
    }
    expect(negBinomValue({ counts, n, bias, dispersion: null, alpha: ALPHA }, coords)).toBeCloseTo(poisson, 9)
    // …and the negative binomial tends to it as `r` grows without bound.
    const far = negBinomValue({ counts, n, bias, dispersion: { c0: 30, c1: 0 }, alpha: ALPHA }, coords)
    expect(Math.abs(far - poisson)).toBeLessThan(1e-6 * Math.abs(poisson))
  })

  it('pulls a pair as the Poisson does, shrunk by exactly r/(r + μ), where r does not move with the mean', () => {
    const two = Float64Array.from([0, 9, 9, 0])
    const apart: Coordinates = { x: Float64Array.from([0, 2]), y: new Float64Array(2), z: new Float64Array(2) }
    const mu = Math.pow(2, -ALPHA)
    const pull = (dispersion: Dispersion | null): number => {
      const gradient = new Float64Array(6)
      negBinomObjective({ counts: two, n: 2, alpha: ALPHA, dispersion })(packCoordinates(apart), gradient)
      return gradient[0]
    }
    // The Poisson's own pull, from first principles: `μ − c`, times `−α/d²`,
    // times the separation along x.
    const poisson = ((-ALPHA * (mu - 9)) / 4) * -2
    expect(pull(null)).toBeCloseTo(poisson, 12)
    for (const r of [0.25, 1, 4, 100]) {
      expect(pull({ c0: Math.log(r), c1: 0 })).toBeCloseTo((poisson * r) / (r + mu), 9)
    }
  })

  it('reads a zero as evidence and a gap as nothing', () => {
    const model = (c: number): NegBinomModel => {
      const held = Float64Array.from(counts)
      held[0 * n + 1] = c
      held[1 * n + 0] = c
      return { counts: held, n, bias, dispersion: { c0: 1, c1: 0.2 }, alpha: ALPHA }
    }
    const gap = negBinomValue(model(Number.NaN), coords)
    expect(negBinomValue(model(0), coords)).toBeGreaterThan(gap)
    // A gap is the pair taken out: moving the two beads changes nothing it adds.
    const moved: Coordinates = { x: Float64Array.from(coords.x), y: coords.y, z: coords.z }
    moved.x[1] += 0.3
    const without = (c: Coordinates): number => negBinomValue(model(Number.NaN), c)
    const withZero = (c: Coordinates): number => negBinomValue(model(0), c)
    expect(withZero(moved) - withZero(coords)).not.toBeCloseTo(without(moved) - without(coords), 6)
  })

  it('refuses a collided pair rather than returning an infinity in the gradient', () => {
    const same: Coordinates = { x: Float64Array.from(coords.x), y: Float64Array.from(coords.y), z: Float64Array.from(coords.z) }
    same.x[1] = same.x[0]
    same.y[1] = same.y[0]
    same.z[1] = same.z[0]
    expect(negBinomValue({ counts, n, bias, dispersion: { c0: 1, c1: 0.2 }, alpha: ALPHA }, same)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('the dispersion', () => {
  it('reads counts that do not scatter as a Poisson, and says so with no curve at all', () => {
    // A helix's counts are exact at every separation: no variance, nothing to fit.
    const n = 30
    const counts = meansOf(helix(n), ALPHA, 50)
    const moments = momentsBySeparation(counts, n, new Int32Array(n), Int32Array.from({ length: n }, (_, i) => i))
    expect(moments.mean.length).toBe(19)
    expect(fitDispersion(moments)).toBeNull()
  })

  it('leaves a separation that is not overdispersed out, rather than reading it as the most overdispersed', () => {
    const alone = fitDispersion(goldenMoments())
    // Three more separations: one whose variance is under its mean, which
    // pastis would enter as a negative `r`, and two a hair over it — within a
    // Poisson's own scatter — which it would enter as an `r` in the thousands.
    const base = goldenMoments()
    const more: SeparationMoments = {
      separation: Int32Array.from([...base.separation, 20, 21, 22]),
      mean: Float64Array.from([...base.mean, 4, 3, 3]),
      variance: Float64Array.from([...base.variance, 3, 3.01, 3.2]),
      pairs: Float64Array.from([...base.pairs, 400, 400, 400]),
    }
    expect(fitDispersion(more)).toEqual(alone)
  })
})

describe('the start', () => {
  it('has the gradient it claims, to a central difference', () => {
    const n = 6
    const wishes = Float64Array.from(GOLDEN_COUNTS)
    storeWishes(wishes, n, GOLDEN_BIAS, 2.4)
    const objective = mdsObjective(wishes, n)
    const point = packCoordinates(GOLDEN_X)
    const gradient = new Float64Array(3 * n)
    objective(point, gradient)
    const scratch = new Float64Array(3 * n)
    for (let k = 0; k < 3 * n; k++) {
      const up = Float64Array.from(point)
      const down = Float64Array.from(point)
      up[k] += 1e-6
      down[k] -= 1e-6
      const numeric = (objective(up, scratch) - objective(down, scratch)) / 2e-6
      expect(Math.abs(gradient[k] - numeric)).toBeLessThan(1e-5 * Math.max(1, Math.abs(numeric)))
    }
  })

  it('finds a helix’s shape from random positions, to pastis’ loose tolerance', () => {
    const n = 40
    const truth = helix(n)
    const wishes = meansOf(truth, ALPHA, 1)
    storeWishes(wishes, n, null, ALPHA)
    const start = run(fitMds(wishes, n, randomStart(n, numpyRandom(0))))
    expect(start.stop).toBe('value')
    expect(spearman(pairDistances(truth), pairDistances(start.coords))).toBeGreaterThan(0.99)
  })
})

describe('the fit', () => {
  it('gets a known helix back from the counts its law implies', () => {
    // As deep as a map: pastis stops once no gradient component is above one,
    // which on a map of a few counts a pair is before it has started.
    const n = 48
    const truth = helix(n)
    const counts = meansOf(truth, ALPHA, 4e3)
    const fit = pastis({ counts, n, dispersion: null, alpha: ALPHA })
    expect(spearman(pairDistances(truth), pairDistances(fit.coords))).toBeGreaterThan(0.999)
    expect(fit.stop).not.toBe('search')
  })

  it('gets it back from a map that is three-quarters zeros', () => {
    // A shallow experiment, drawn rather than described: counts are Poisson at
    // the law's own mean, and low enough that three pairs in four came back
    // empty. pastis' MDS has only the counted quarter to place the beads by;
    // the likelihood reads every zero as *probably far*, and is carried by them.
    const n = 48
    const truth = helix(n)
    const next = stream(5)
    const counts = new Float64Array(n * n)
    let zeros = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(truth.x[i] - truth.x[j], truth.y[i] - truth.y[j], truth.z[i] - truth.z[j])
        const c = poissonDraw(next, 60 * Math.pow(d, -ALPHA))
        counts[i * n + j] = c
        counts[j * n + i] = c
        if (c === 0) zeros++
      }
    }
    expect(zeros / ((n * (n - 1)) / 2)).toBeGreaterThan(0.7)
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    // Drawn Poisson, so there is no overdispersion to find, and none is found.
    const dispersion = fitDispersion(momentsBySeparation(counts, n, group, index))
    expect(dispersion).toBeNull()
    const fit = pastis({ counts, n, dispersion, alpha: ALPHA })
    expect(spearman(pairDistances(truth), pairDistances(fit.coords))).toBeGreaterThan(0.85)
  })

  it('scales a pair’s mean by its two beads’ coverage, and nothing else', () => {
    // The bias enters the mean, and the dispersion with it, so a model whose
    // law reproduces the counts is still stationary — with the biased counts.
    const n = 30
    const truth = helix(n)
    const bias = Float64Array.from({ length: n }, (_, i) => 0.5 + ((i * 3) % 7) / 5)
    const counts = meansOf(truth, ALPHA, 1, bias)
    const model: NegBinomModel = { counts, n, alpha: ALPHA, bias, dispersion: { c0: 1.1, c1: 0 } }
    const gradient = new Float64Array(3 * n)
    negBinomObjective(model)(packCoordinates(truth), gradient)
    expect(Math.max(...gradient.map(Math.abs))).toBeLessThan(1e-9)
    // …and the same counts read without the bias are *not* at a maximum: the
    // uneven coverage would be read as geometry.
    negBinomObjective({ ...model, bias: null })(packCoordinates(truth), gradient)
    expect(Math.max(...gradient.map(Math.abs))).toBeGreaterThan(1e-3)
  })

  it('recovers the shape through uneven coverage, and is fooled by it without the bias', () => {
    const n = 40
    const truth = helix(n)
    const next = stream(17)
    const bias = Float64Array.from({ length: n }, () => 0.5 + next() * 1.5)
    let sum = 0
    for (const b of bias) sum += b
    for (let i = 0; i < n; i++) bias[i] /= sum / n
    const counts = meansOf(truth, ALPHA, 4e3, bias)
    const solve = (b: Float64Array | null): Coordinates => pastis({ counts, n, alpha: ALPHA, bias: b, dispersion: null }).coords
    const corrected = spearman(pairDistances(truth), pairDistances(solve(bias)))
    const blind = spearman(pairDistances(truth), pairDistances(solve(null)))
    expect(corrected).toBeGreaterThan(0.99)
    expect(corrected).toBeGreaterThan(blind)
  })

  it('finds the dispersion counts were drawn with, and fits them at least as well as a Poisson does', () => {
    // Counts drawn as pastis-NB says a map's are: negative binomial, gamma
    // mixed into Poisson, with `r = 2·λ^0.15` — the shape the validation's
    // yeast map has. The curve comes back with its exponent, and the model with
    // it is at least as close to the truth as the Poisson's on every draw.
    const n = 44
    const truth = helix(n)
    const group = new Int32Array(n)
    const index = Int32Array.from({ length: n }, (_, i) => i)
    for (const seed of [1, 2, 3]) {
      const next = stream(seed * 101)
      const counts = new Float64Array(n * n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = Math.hypot(truth.x[i] - truth.x[j], truth.y[i] - truth.y[j], truth.z[i] - truth.z[j])
          const mu = 6e4 * Math.pow(d, -ALPHA)
          const r = 2 * Math.pow(mu, 0.15)
          counts[i * n + j] = poissonDraw(next, gammaDraw(next, r) * (mu / r))
          counts[j * n + i] = counts[i * n + j]
        }
      }
      const fitted = fitDispersion(momentsBySeparation(counts, n, group, index))
      expect(fitted).not.toBeNull()
      expect(Math.abs((fitted?.c1 ?? 0) - 0.15)).toBeLessThan(0.08)
      const nb = spearman(pairDistances(truth), pairDistances(pastis({ counts, n, alpha: ALPHA, dispersion: fitted }).coords))
      const poisson = spearman(pairDistances(truth), pairDistances(pastis({ counts, n, alpha: ALPHA, dispersion: null }).coords))
      expect(nb).toBeGreaterThan(0.9)
      expect(nb).toBeGreaterThanOrEqual(poisson)
    }
  })

  it('yields as it goes and never lets the likelihood rise', () => {
    const n = 24
    const truth = helix(n)
    const counts = meansOf(truth, ALPHA, 4)
    const start = randomStart(n, numpyRandom(1))
    const walk = fitNegativeBinomial({ counts, n, dispersion: { c0: 1, c1: 0.3 }, alpha: ALPHA }, start, { iterations: 60 })
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
    const n = 16
    const counts = meansOf(helix(n), ALPHA, 4)
    const start = randomStart(n, numpyRandom(2))
    const held = Array.from(start.x)
    run(fitNegativeBinomial({ counts, n, dispersion: { c0: 1, c1: 0.3 }, alpha: ALPHA }, start, { iterations: 30 }))
    expect(Array.from(start.x)).toEqual(held)
  })

  it('is deterministic: the same counts and the same seed give the same model twice', () => {
    const n = 20
    const counts = meansOf(helix(n), ALPHA, 4)
    const solve = (seed: number): { x: number[]; value: number } => {
      const fit = pastis({ counts, n, dispersion: { c0: 1, c1: 0.3 }, alpha: ALPHA }, seed, 40)
      return { x: Array.from(fit.coords.x), value: fit.value }
    }
    expect(solve(3)).toEqual(solve(3))
    expect(solve(4).x).not.toEqual(solve(3).x)
  })
})
