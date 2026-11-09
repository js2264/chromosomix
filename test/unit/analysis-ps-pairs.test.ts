/**
 * The pairs each separation could hold, with balancing on — P(s)'s denominator.
 *
 * Held to the walk it replaced, separation by separation: every pair of bins
 * `k` apart looked at, and counted when neither weight is `NaN`. The count is
 * integers either way, so the two must agree exactly, over lines with nothing
 * dropped, everything dropped, a few bins dropped, most dropped, and dropped
 * bins in runs — the shape a centromere or an unmappable arm gives a real map.
 */

import { describe, expect, it } from 'vitest'

import { keptPairs } from '@/analysis/run/expected'

/** The walk: a pass over the line for every separation. */
function walked(weight: Float64Array, from: number, to: number, last: number): number[] {
  const out: number[] = []
  for (let k = 0; k <= last; k++) {
    let pairs = 0
    for (let i = from; i + k < to; i++) if (!Number.isNaN(weight[i]) && !Number.isNaN(weight[i + k])) pairs++
    out.push(pairs)
  }
  return out
}

/** Weights over `length` bins, each dropped with probability `drop`, in runs of up to `run`. */
function weights(length: number, drop: number, run: number, seed: number): Float64Array {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state / 2 ** 31
  }
  const out = new Float64Array(length)
  for (let i = 0; i < length; ) {
    const gone = next() < drop
    const span = 1 + Math.floor(next() * run)
    for (let j = 0; j < span && i < length; j++, i++) out[i] = gone ? Number.NaN : 0.5 + next()
  }
  return out
}

describe('the pairs both of whose bins the balancer kept', () => {
  it('counts what a walk of every separation counts, however many bins are dropped', () => {
    for (const [drop, run] of [
      [0, 1],
      [1, 1],
      [0.05, 1],
      [0.1, 30],
      [0.5, 1],
      [0.5, 12],
      [0.9, 4],
      [0.97, 1],
    ]) {
      for (const length of [1, 2, 3, 17, 400]) {
        const weight = weights(length + 9, drop, run, 7 + length)
        const [from, to] = [4, 4 + length]
        for (const last of [0, 1, Math.floor(length / 3), length - 1]) {
          if (last < 0 || last > length - 1) continue
          const label = `drop ${drop} in runs of ${run}, ${length} bins, to ${last}`
          expect([...keptPairs(weight, from, to, last)], label).toEqual(walked(weight, from, to, last))
        }
      }
    }
  })

  it('is the line less its dropped bins at no separation, and the closed form with none dropped', () => {
    const weight = new Float64Array([1, Number.NaN, 1, 1, Number.NaN, 1])
    expect(keptPairs(weight, 0, 6, 0)[0]).toBe(4)
    expect([...keptPairs(new Float64Array(5).fill(1), 0, 5, 4)]).toEqual([5, 4, 3, 2, 1])
    expect([...keptPairs(new Float64Array(3).fill(Number.NaN), 0, 3, 2)]).toEqual([0, 0, 0])
  })
})
