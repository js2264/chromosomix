/**
 * pastis-NB's fit shared across helper workers (`analysis/likelihoodThreads.ts`):
 * its MDS start, then its likelihood, on the same helpers.
 *
 * What has to hold is that sharing changes nothing but the time: the value and
 * the gradient are the bits one thread computes (`mdsObjective`,
 * `negBinomObjective`) whatever the number of helpers, and so is a whole fit; a
 * helper that cannot start, or fails partway, leaves its bands to the thread
 * that asked, with the same numbers; and the end of a fit terminates every
 * helper, and a helper that has not said it is up yet is not waited for. The helpers here are
 * in-process stand-ins that run the real helper (`likelihoodHelper`) and hand
 * its messages over a task apart through a structured clone — its buffers
 * transferred, and so detached on the side that sent them, as a worker's are.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { numpyRandom } from '@/analysis/random'
import {
  likelihoodHelper,
  openFitThreads,
  shareBands,
  useLikelihoodThreads,
  type LikelihoodMessage,
  type LikelihoodRequest,
} from '@/analysis/likelihoodThreads'
import {
  fitMds,
  fitNegativeBinomial,
  likelihoodBands,
  likelihoodWalk,
  mdsBands,
  mdsObjective,
  mdsWalk,
  negBinomObjective,
  randomStart,
  storeWishes,
  type MdsFit,
  type NegBinomFit,
  type NegBinomModel,
} from '@/structure/negbinom'

afterEach(() => useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 0))

/** A helper that runs the real one a task apart, and can be told to fail at its `failAt`-th evaluation. */
class FakeHelper {
  static started = 0
  static terminated = 0
  onmessage: ((event: MessageEvent<LikelihoodMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  evaluations = 0
  private alive = true
  private readonly handle: (request: LikelihoodRequest) => void
  constructor(private readonly failAt = Number.POSITIVE_INFINITY) {
    FakeHelper.started++
    this.handle = likelihoodHelper((message, transfer) => {
      const sent = structuredClone(message, { transfer: transfer ?? [] })
      setTimeout(() => {
        if (this.alive) this.onmessage?.({ data: sent } as MessageEvent<LikelihoodMessage>)
      }, 0)
    })
  }
  postMessage(request: LikelihoodRequest, transfer: Transferable[]): void {
    // Transferred: the sender's copy is detached, as a worker's would be.
    const received = structuredClone(request, { transfer })
    setTimeout(() => {
      if (!this.alive) return
      if (received.kind === 'evaluate' && ++this.evaluations >= this.failAt) {
        this.onerror?.({ preventDefault: () => {} } as ErrorEvent)
        return
      }
      this.handle(received)
    }, 0)
  }
  terminate(): void {
    if (this.alive) FakeHelper.terminated++
    this.alive = false
  }
}

/** A map of `n` beads on two sequences: whole counts, zeros, a gap, some not whole, uneven coverage. */
function modelOf(n: number): NegBinomModel {
  const next = numpyRandom(n)
  const counts = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const near = (i < n / 2) === (j < n / 2) ? 400 / (1 + j - i) : 3
      const u = next()
      const c = u < 0.002 ? Number.NaN : u < 0.2 ? 0 : u < 0.25 ? Math.round(near * 10) / 4 + 0.5 : Math.round(near * u * 2)
      counts[i * n + j] = c
      counts[j * n + i] = c
    }
  }
  const bias = Float64Array.from({ length: n }, () => 0.6 + next() * 0.8)
  return { counts, n, bias, dispersion: { c0: 1.1, c1: 0.15 }, alpha: 3 }
}

/** Until the helpers just started have said they are up: a task or two, here. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

/** Beads on a stretched random walk, so no two meet. */
function pointOf(n: number, seed: number): Float64Array {
  const next = numpyRandom(seed)
  const point = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    point[i] = i * 0.3 + next()
    point[n + i] = next() * 4
    point[2 * n + i] = next() * 4
  }
  return point
}

/** The model's map with pastis' wishes below the diagonal, as the fit holds it once its MDS is to run. */
function withWishes(model: NegBinomModel): NegBinomModel {
  storeWishes(model.counts, model.n, model.bias ?? null, model.alpha)
  return model
}

/** pastis-NB's two walks, the MDS and then the likelihood, each evaluation shared among the helpers. */
async function fitThreaded(
  model: NegBinomModel,
  iterations: number,
): Promise<{ start: MdsFit; fit: NegBinomFit; threads: number[] }> {
  const fit = openFitThreads(model.n, model.counts)
  try {
    await settle()
    const mds = fit.mds(model.counts)
    const starting = mdsWalk(model.n, randomStart(model.n, numpyRandom(0)), { iterations })
    let ask = starting.next()
    while (ask.done !== true) ask = starting.next(await mds.evaluate(ask.value.point, ask.value.gradient))
    const start = ask.value
    const likelihood = fit.likelihood(model)
    const walk = likelihoodWalk(model.n, start.coords, { iterations })
    let step = walk.next()
    while (step.done !== true) step = walk.next(await likelihood.evaluate(step.value.point, step.value.gradient))
    return { start, fit: step.value, threads: [mds.threads, likelihood.threads] }
  } finally {
    fit.close()
  }
}

describe('the bands', () => {
  it('are laid out by the bead count alone, each about the same share of the pairs', () => {
    expect(Array.from(likelihoodBands(10))).toEqual([0, 10])
    expect(Array.from(mdsBands(10))).toEqual([0, 10])
    for (const [edges, pairsOf] of [
      [likelihoodBands(905), (i: number) => 905 - 1 - i],
      [mdsBands(905), (i: number) => i],
    ] as const) {
      expect(edges.length - 1).toBe(28)
      expect(edges[0]).toBe(0)
      expect(edges[edges.length - 1]).toBe(905)
      const pairs = Array.from({ length: edges.length - 1 }, (_, b) => {
        let sum = 0
        for (let i = edges[b]; i < edges[b + 1]; i++) sum += pairsOf(i)
        return sum
      })
      const mean = pairs.reduce((a, b) => a + b, 0) / pairs.length
      for (const share of pairs) expect(Math.abs(share / mean - 1)).toBeLessThan(0.15)
    }
    // Sixty-four at most, however many beads.
    expect(likelihoodBands(12000).length - 1).toBe(64)
    expect(mdsBands(12000).length - 1).toBe(64)
  })

  it('go to as many threads as are allowed, this one with a little less, and fewer where the copies would not fit', () => {
    const edges = likelihoodBands(905)
    const plan = shareBands(edges, 905, 3, 4)
    // This thread keeps 0.9 of a helper's share: six bands of 28, the helpers seven or eight each.
    expect(plan).toEqual([0, 6, 14, 21, 28])
    // The MDS's bands are as many, and shared the same way.
    expect(shareBands(mdsBands(905), 905, 3, 4, 'mds')).toEqual([0, 6, 14, 21, 28])
    // Never more threads than bands.
    expect(shareBands(likelihoodBands(70), 70, 7, 4)).toEqual([0, 1, 2])
    // Copies of singles: seven helpers at 12,000 beads, one at 20,000, none at
    // 30,000, where even one helper's half of the triangle is over the budget…
    expect(shareBands(likelihoodBands(12000), 12000, 7, 4).length - 2).toBe(7)
    expect(shareBands(likelihoodBands(20000), 20000, 7, 4).length - 2).toBe(1)
    expect(shareBands(likelihoodBands(30000), 30000, 7, 4)).toEqual([0, 64])
    expect(shareBands(mdsBands(30000), 30000, 7, 4, 'mds')).toEqual([0, 64])
    // …and all seven where the matrix is shared and nothing is copied.
    expect(shareBands(likelihoodBands(30000), 30000, 7, 0).length - 2).toBe(7)
  })
})

describe('the fit on several threads', () => {
  it('is the bits one thread computes, value and gradient, MDS and likelihood, on one, two, four and eight threads', async () => {
    const model = withWishes(modelOf(300))
    const objectives = { mds: mdsObjective(model.counts, 300), likelihood: negBinomObjective(model) }
    const points = [pointOf(300, 1), pointOf(300, 2)]
    for (const helpers of [0, 1, 3, 7]) {
      useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, helpers)
      const fit = openFitThreads(300, model.counts)
      expect(fit.threads).toBe(helpers + 1)
      await settle()
      for (const [name, open] of [
        ['mds', () => fit.mds(model.counts)],
        ['likelihood', () => fit.likelihood(model)],
      ] as const) {
        const evaluator = open()
        expect(evaluator.threads).toBe(helpers + 1)
        for (const point of points) {
          const want = new Float64Array(900)
          const value = objectives[name](point, want)
          const gradient = new Float64Array(900)
          expect(await evaluator.evaluate(point, gradient)).toBe(value)
          expect(gradient).toEqual(want)
        }
      }
      fit.close()
    }
  })

  it('reads a shared matrix where it has one, copying nothing, and still gives the same bits', async () => {
    const model = withWishes(modelOf(300))
    const shared = new Float32Array(new SharedArrayBuffer(model.counts.length * 4))
    shared.set(model.counts)
    const point = pointOf(300, 6)
    const wantMds = new Float64Array(900)
    const mdsValue = mdsObjective(model.counts, 300)(point, wantMds)
    const want = new Float64Array(900)
    const value = negBinomObjective(model)(point, want)
    const setups: LikelihoodRequest[] = []
    useLikelihoodThreads(() => {
      const helper = new FakeHelper()
      const post = helper.postMessage.bind(helper)
      helper.postMessage = (request, transfer) => {
        if (request.kind === 'setup') setups.push(request)
        post(request, transfer)
      }
      return helper as unknown as Worker
    }, 3)
    const fit = openFitThreads(300, shared)
    await settle()
    const gradient = new Float64Array(900)
    expect(await fit.mds(shared).evaluate(point, gradient)).toBe(mdsValue)
    expect(gradient).toEqual(wantMds)
    expect(await fit.likelihood({ ...model, counts: shared }).evaluate(point, gradient)).toBe(value)
    expect(gradient).toEqual(want)
    // Every helper was handed the one matrix, not a copy of its rows, once for each objective.
    expect(setups).toHaveLength(6)
    for (const setup of setups) {
      if (setup.kind !== 'setup') throw new Error('not a setup')
      expect(setup.shared).toBe(true)
      expect(setup.values).toBe(shared)
    }
    fit.close()
  })

  it('says a collided pair is outside the domain of the likelihood, as one thread does', async () => {
    const model = modelOf(300)
    const point = pointOf(300, 3)
    point[200] = point[201]
    point[500] = point[501]
    point[800] = point[801]
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const fit = openFitThreads(300, model.counts)
    await settle()
    expect(await fit.likelihood(model).evaluate(point, new Float64Array(900))).toBe(Number.POSITIVE_INFINITY)
    expect(negBinomObjective(model)(point, new Float64Array(900))).toBe(Number.POSITIVE_INFINITY)
    fit.close()
  })

  it('fits the same MDS start and the same model, to the bit, as one thread', async () => {
    const model = withWishes(modelOf(280))
    const starting = fitMds(model.counts, 280, randomStart(280, numpyRandom(0)), { iterations: 12 })
    let mds = starting.next()
    while (mds.done !== true) mds = starting.next()
    const alone = fitNegativeBinomial(model, mds.value.coords, { iterations: 12 })
    let step = alone.next()
    while (step.done !== true) step = alone.next()
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const { start, fit, threads } = await fitThreaded(model, 12)
    expect(threads).toEqual([4, 4])
    expect(start.value).toBe(mds.value.value)
    expect(start.evaluations).toBe(mds.value.evaluations)
    expect(Array.from(start.coords.y)).toEqual(Array.from(mds.value.coords.y))
    expect(fit.value).toBe(step.value.value)
    expect(fit.evaluations).toBe(step.value.evaluations)
    expect(Array.from(fit.coords.x)).toEqual(Array.from(step.value.coords.x))
    expect(Array.from(fit.coords.z)).toEqual(Array.from(step.value.coords.z))
  })

  it('computes here what a helper that cannot start, or that fails partway, would have, and gives the same numbers', async () => {
    const model = withWishes(modelOf(300))
    const point = pointOf(300, 4)
    const wantMds = new Float64Array(900)
    const mdsValue = mdsObjective(model.counts, 300)(point, wantMds)
    const want = new Float64Array(900)
    const value = negBinomObjective(model)(point, want)
    let spawned = 0
    const terminatedBefore = FakeHelper.terminated
    useLikelihoodThreads(() => {
      spawned++
      // The first cannot be started at all; the second fails at its second evaluation.
      if (spawned === 1) throw new Error('no workers here')
      return new FakeHelper(spawned === 2 ? 2 : Number.POSITIVE_INFINITY) as unknown as Worker
    }, 3)
    const fit = openFitThreads(300, model.counts)
    expect(fit.threads).toBe(3)
    await settle()
    const mds = fit.mds(model.counts)
    expect(mds.threads).toBe(3)
    for (let k = 0; k < 3; k++) {
      const gradient = new Float64Array(900)
      expect(await mds.evaluate(point, gradient)).toBe(mdsValue)
      expect(gradient).toEqual(wantMds)
    }
    // The one that failed was let go at once, and the likelihood is shared without it.
    expect(FakeHelper.terminated - terminatedBefore).toBe(1)
    const likelihood = fit.likelihood(model)
    expect(likelihood.threads).toBe(2)
    for (let k = 0; k < 2; k++) {
      const gradient = new Float64Array(900)
      expect(await likelihood.evaluate(point, gradient)).toBe(value)
      expect(gradient).toEqual(want)
    }
    fit.close()
  })

  it('does not wait for a helper that has not said it is up, and gives the same numbers either way', async () => {
    const model = withWishes(modelOf(300))
    const point = pointOf(300, 7)
    const want = new Float64Array(900)
    const value = mdsObjective(model.counts, 300)(point, want)
    const started: FakeHelper[] = []
    useLikelihoodThreads(() => {
      const helper = new FakeHelper()
      started.push(helper)
      return helper as unknown as Worker
    }, 3)
    const fit = openFitThreads(300, model.counts)
    const mds = fit.mds(model.counts)
    for (const wait of [false, true]) {
      if (wait) await settle()
      const gradient = new Float64Array(900)
      expect(await mds.evaluate(point, gradient)).toBe(value)
      expect(gradient).toEqual(want)
      // Asked nothing before they were up; asked once each after.
      expect(started.map((helper) => helper.evaluations)).toEqual([0, 0, 0].map(() => (wait ? 1 : 0)))
    }
    fit.close()
  })

  it('starts its helpers once for both objectives, and terminates every one when the fit ends', async () => {
    const model = withWishes(modelOf(300))
    const started = FakeHelper.started
    const terminated = FakeHelper.terminated
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const fit = openFitThreads(300, model.counts)
    await fit.mds(model.counts).evaluate(pointOf(300, 5), new Float64Array(900))
    await fit.likelihood(model).evaluate(pointOf(300, 5), new Float64Array(900))
    fit.close()
    expect(FakeHelper.started - started).toBe(3)
    expect(FakeHelper.terminated - terminated).toBe(3)
  })

  it('stays on one thread for a small model, where a round trip would cost more than it saves', () => {
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const model = modelOf(120)
    const fit = openFitThreads(120, model.counts)
    expect(fit.threads).toBe(1)
    expect(fit.mds(model.counts).threads).toBe(1)
    expect(fit.likelihood(model).threads).toBe(1)
    fit.close()
  })
})
