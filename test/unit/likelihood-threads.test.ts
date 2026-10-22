/**
 * pastis-NB's likelihood shared across helper workers (`analysis/likelihoodThreads.ts`).
 *
 * What has to hold is that sharing changes nothing but the time: the value and
 * the gradient are the bits one thread computes (`negBinomObjective`) whatever
 * the number of helpers, and so is a whole fit; a helper that cannot start, or
 * fails partway, leaves its bands to the thread that asked, with the same
 * numbers; and the end of a fit terminates every helper. The helpers here are
 * in-process stand-ins that run the real helper (`likelihoodHelper`) and hand
 * its messages over a task apart through a structured clone — its buffers
 * transferred, and so detached on the side that sent them, as a worker's are.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { numpyRandom } from '@/analysis/random'
import {
  likelihoodHelper,
  openLikelihood,
  shareBands,
  useLikelihoodThreads,
  type LikelihoodMessage,
  type LikelihoodRequest,
} from '@/analysis/likelihoodThreads'
import {
  fitNegativeBinomial,
  likelihoodBands,
  likelihoodWalk,
  negBinomObjective,
  randomStart,
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

async function fitThreaded(model: NegBinomModel, iterations: number): Promise<{ fit: NegBinomFit; threads: number }> {
  const evaluator = openLikelihood(model)
  try {
    const walk = likelihoodWalk(model.n, randomStart(model.n, numpyRandom(0)), { iterations })
    let step = walk.next()
    while (step.done !== true) {
      const value = await evaluator.evaluate(step.value.point, step.value.gradient)
      step = walk.next(value)
    }
    return { fit: step.value, threads: evaluator.threads }
  } finally {
    evaluator.close()
  }
}

describe('the bands', () => {
  it('are laid out by the bead count alone, each about the same share of the pairs', () => {
    expect(Array.from(likelihoodBands(10))).toEqual([0, 10])
    const edges = likelihoodBands(905)
    expect(edges.length - 1).toBe(28)
    expect(edges[0]).toBe(0)
    expect(edges[edges.length - 1]).toBe(905)
    const pairs = Array.from({ length: edges.length - 1 }, (_, b) => {
      let sum = 0
      for (let i = edges[b]; i < edges[b + 1]; i++) sum += 905 - 1 - i
      return sum
    })
    const mean = pairs.reduce((a, b) => a + b, 0) / pairs.length
    for (const share of pairs) expect(Math.abs(share / mean - 1)).toBeLessThan(0.15)
    // Sixty-four at most, however many beads.
    expect(likelihoodBands(12000).length - 1).toBe(64)
  })

  it('go to as many threads as are allowed, this one with a little less, and fewer where the copies would not fit', () => {
    const edges = likelihoodBands(905)
    const plan = shareBands(edges, 905, 3, 4)
    // This thread keeps 0.9 of a helper's share: six bands of 28, the helpers seven or eight each.
    expect(plan).toEqual([0, 6, 14, 21, 28])
    // Never more threads than bands.
    expect(shareBands(likelihoodBands(70), 70, 7, 4)).toEqual([0, 1, 2])
    // Copies of singles: seven helpers at 12,000 beads, one at 20,000, none at
    // 30,000, where even one helper's half of the triangle is over the budget…
    expect(shareBands(likelihoodBands(12000), 12000, 7, 4).length - 2).toBe(7)
    expect(shareBands(likelihoodBands(20000), 20000, 7, 4).length - 2).toBe(1)
    expect(shareBands(likelihoodBands(30000), 30000, 7, 4)).toEqual([0, 64])
    // …and all seven where the matrix is shared and nothing is copied.
    expect(shareBands(likelihoodBands(30000), 30000, 7, 0).length - 2).toBe(7)
  })
})

describe('the likelihood on several threads', () => {
  it('is the bits one thread computes, value and gradient, on one, two, four and eight threads', async () => {
    const model = modelOf(300)
    const objective = negBinomObjective(model)
    const points = [pointOf(300, 1), pointOf(300, 2)]
    const want = points.map((point) => {
      const gradient = new Float64Array(900)
      return { value: objective(point, gradient), gradient }
    })
    for (const helpers of [0, 1, 3, 7]) {
      useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, helpers)
      const evaluator = openLikelihood(model)
      expect(evaluator.threads).toBe(helpers + 1)
      for (const [at, point] of points.entries()) {
        const gradient = new Float64Array(900)
        const value = await evaluator.evaluate(point, gradient)
        expect(value).toBe(want[at].value)
        expect(gradient).toEqual(want[at].gradient)
      }
      evaluator.close()
    }
  })

  it('reads a shared matrix where it has one, copying nothing, and still gives the same bits', async () => {
    const model = modelOf(300)
    const shared = new Float32Array(new SharedArrayBuffer(model.counts.length * 4))
    shared.set(model.counts)
    const point = pointOf(300, 6)
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
    const evaluator = openLikelihood({ ...model, counts: shared })
    const gradient = new Float64Array(900)
    expect(await evaluator.evaluate(point, gradient)).toBe(value)
    expect(gradient).toEqual(want)
    // Every helper was handed the one matrix, not a copy of its rows.
    expect(setups).toHaveLength(3)
    for (const setup of setups) {
      if (setup.kind !== 'setup') throw new Error('not a setup')
      expect(setup.shared).toBe(true)
      expect(setup.counts).toBe(shared)
    }
    evaluator.close()
  })

  it('says a collided pair is outside the domain, as one thread does', async () => {
    const model = modelOf(300)
    const point = pointOf(300, 3)
    point[200] = point[201]
    point[500] = point[501]
    point[800] = point[801]
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const evaluator = openLikelihood(model)
    expect(await evaluator.evaluate(point, new Float64Array(900))).toBe(Number.POSITIVE_INFINITY)
    expect(negBinomObjective(model)(point, new Float64Array(900))).toBe(Number.POSITIVE_INFINITY)
    evaluator.close()
  })

  it('fits the same model, to the bit, as one thread', async () => {
    const model = modelOf(280)
    const alone = fitNegativeBinomial(model, randomStart(280, numpyRandom(0)), { iterations: 12 })
    let step = alone.next()
    while (step.done !== true) step = alone.next()
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const { fit, threads } = await fitThreaded(model, 12)
    expect(threads).toBe(4)
    expect(fit.value).toBe(step.value.value)
    expect(fit.evaluations).toBe(step.value.evaluations)
    expect(Array.from(fit.coords.x)).toEqual(Array.from(step.value.coords.x))
    expect(Array.from(fit.coords.z)).toEqual(Array.from(step.value.coords.z))
  })

  it('computes here what a helper that cannot start, or that fails partway, would have, and gives the same numbers', async () => {
    const model = modelOf(300)
    const objective = negBinomObjective(model)
    const point = pointOf(300, 4)
    const want = new Float64Array(900)
    const value = objective(point, want)
    let spawned = 0
    const terminatedBefore = FakeHelper.terminated
    useLikelihoodThreads(() => {
      spawned++
      // The first cannot be started at all; the second fails at its second evaluation.
      if (spawned === 1) throw new Error('no workers here')
      return new FakeHelper(spawned === 2 ? 2 : Number.POSITIVE_INFINITY) as unknown as Worker
    }, 3)
    const evaluator = openLikelihood(model)
    expect(evaluator.threads).toBe(3)
    for (let k = 0; k < 3; k++) {
      const gradient = new Float64Array(900)
      expect(await evaluator.evaluate(point, gradient)).toBe(value)
      expect(gradient).toEqual(want)
    }
    // The one that failed was let go at once.
    expect(FakeHelper.terminated - terminatedBefore).toBe(1)
    evaluator.close()
  })

  it('terminates every helper when the fit ends', async () => {
    const model = modelOf(300)
    const started = FakeHelper.started
    const terminated = FakeHelper.terminated
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const evaluator = openLikelihood(model)
    await evaluator.evaluate(pointOf(300, 5), new Float64Array(900))
    evaluator.close()
    expect(FakeHelper.started - started).toBe(3)
    expect(FakeHelper.terminated - terminated).toBe(3)
  })

  it('stays on one thread for a small model, where a round trip would cost more than it saves', () => {
    useLikelihoodThreads(() => new FakeHelper() as unknown as Worker, 3)
    const evaluator = openLikelihood(modelOf(120))
    expect(evaluator.threads).toBe(1)
    evaluator.close()
  })
})
