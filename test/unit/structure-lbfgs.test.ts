/**
 * The optimiser, held still against minima that are known (§25.6).
 *
 * `structure/negbinom.ts` is a likelihood and cannot have a golden of its own
 * beyond "it finds the model the counts were made from"; what *can* be held
 * still is the thing underneath it, against functions whose minimisers are
 * written in the textbook the method came from. Rosenbrock is the standard
 * hard case — a curved valley whose floor is flat — and a quadratic is the
 * case a quasi-Newton method should finish in a handful of iterations.
 */

import { describe, expect, it } from 'vitest'

import { lbfgs, type LbfgsResult, type Objective } from '@/structure/lbfgs'

/** Drain the generator, counting the yields so the breathing can be checked. */
function run(objective: Objective, start: number[], options = {}): { result: LbfgsResult; yields: number } {
  const walk = lbfgs(objective, Float64Array.from(start), options)
  let yields = 0
  let step = walk.next()
  while (step.done !== true) {
    yields++
    step = walk.next()
  }
  return { result: step.value, yields }
}

/** `(1 − x)² + 100 (y − x²)²`, minimised at `(1, 1)` with value 0. */
const rosenbrock: Objective = (p, g) => {
  const [x, y] = [p[0], p[1]]
  g[0] = -2 * (1 - x) - 400 * x * (y - x * x)
  g[1] = 200 * (y - x * x)
  return (1 - x) ** 2 + 100 * (y - x * x) ** 2
}

/** A badly conditioned quadratic: `Σ kᵢ (xᵢ − i)²`, minimised at `xᵢ = i`. */
function quadratic(scales: number[]): Objective {
  return (p, g) => {
    let sum = 0
    for (let i = 0; i < p.length; i++) {
      const gap = p[i] - i
      g[i] = 2 * scales[i] * gap
      sum += scales[i] * gap * gap
    }
    return sum
  }
}

describe('L-BFGS', () => {
  it('finds Rosenbrock’s minimum from the textbook’s hard start', () => {
    // Run to the gradient rather than to the value tolerance, so what is
    // measured is the method's accuracy and not where it chose to stop.
    const { result } = run(rosenbrock, [-1.2, 1], { iterations: 300, tolerance: 0 })
    expect(result.point[0]).toBeCloseTo(1, 9)
    expect(result.point[1]).toBeCloseTo(1, 9)
    expect(result.value).toBeLessThan(1e-20)
    expect(result.stop).toBe('gradient')
    // Forty iterations on Rosenbrock from (−1.2, 1) is what a quasi-Newton
    // method is for: steepest descent needs thousands.
    expect(result.iterations).toBeLessThan(60)
  })

  it('solves a quadratic over six decades of curvature', () => {
    const scales = [1e-3, 1, 10, 1e3, 1e4, 1e3, 10, 1, 1e-3, 1]
    const { result } = run(quadratic(scales), new Array(10).fill(0), { iterations: 400 })
    for (let i = 0; i < 10; i++) expect(result.point[i]).toBeCloseTo(i, 4)
  })

  it('yields once per evaluation, so a caller can breathe and cancel', () => {
    const { result, yields } = run(rosenbrock, [-1.2, 1], { iterations: 300 })
    expect(yields).toBe(result.evaluations)
    // A line search is several evaluations, so there are always more of them
    // than iterations — the reason the generator yields on the evaluation.
    expect(result.evaluations).toBeGreaterThan(result.iterations)
  })

  it('stops on the gradient when it starts at the answer, without an evaluation wasted', () => {
    const { result } = run(quadratic([1, 1, 1]), [0, 1, 2])
    expect(result.stop).toBe('gradient')
    expect(result.iterations).toBe(0)
    expect(result.evaluations).toBe(1)
  })

  it('stops on the value once an iteration stops buying anything', () => {
    const { result } = run(rosenbrock, [-1.2, 1], { iterations: 500, gradientTolerance: 0 })
    expect(result.stop).toBe('value')
    expect(result.value).toBeLessThan(1e-10)
    // It stopped because the steps stopped paying, not because it ran out.
    expect(result.iterations).toBeLessThan(500)
  })

  it('honours the iteration budget and reports it', () => {
    const { result } = run(rosenbrock, [-1.2, 1], { iterations: 3 })
    expect(result.iterations).toBe(3)
    expect(result.stop).toBe('steps')
  })

  it('never lets the value rise: every iteration is a descent', () => {
    const walk = lbfgs(rosenbrock, Float64Array.from([-1.2, 1]), { iterations: 200 })
    let best = Number.POSITIVE_INFINITY
    let step = walk.next()
    while (step.done !== true) {
      expect(step.value.value).toBeLessThanOrEqual(best + 1e-15)
      best = Math.min(best, step.value.value)
      step = walk.next()
    }
    expect(step.value.value).toBeLessThanOrEqual(best + 1e-15)
  })

  it('shortens rather than stepping into a domain it cannot evaluate', () => {
    // `−log x` on the positive half line: a step along the gradient from 0.5
    // overshoots into the region where the function is not defined, and the
    // search has to find its way back rather than return a `NaN`.
    const barrier: Objective = (p, g) => {
      const x = p[0]
      if (!(x > 0)) {
        g[0] = 0
        return Number.POSITIVE_INFINITY
      }
      g[0] = -1 / x + 1
      return -Math.log(x) + x
    }
    const { result } = run(barrier, [0.01], { iterations: 100 })
    expect(result.point[0]).toBeCloseTo(1, 6)
    expect(Number.isFinite(result.value)).toBe(true)
  })

  it('leaves the caller’s start alone', () => {
    const start = Float64Array.from([-1.2, 1])
    const walk = lbfgs(rosenbrock, start, { iterations: 50 })
    let step = walk.next()
    while (step.done !== true) step = walk.next()
    expect(Array.from(start)).toEqual([-1.2, 1])
    expect(step.value.point[0]).not.toBe(-1.2)
  })

  it('is deterministic: the same start gives the same answer twice', () => {
    const a = run(rosenbrock, [-1.2, 1], { iterations: 80 })
    const b = run(rosenbrock, [-1.2, 1], { iterations: 80 })
    expect(Array.from(a.result.point)).toEqual(Array.from(b.result.point))
    expect(a.result.evaluations).toBe(b.result.evaluations)
  })
})
