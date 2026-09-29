/**
 * The draws a resampled map is made of (§6.5): the generator, and numpy's
 * binomial and hypergeometric samplers as ported in `metacooler/sampling.ts`.
 *
 * A sampler is right when its draws have the distribution's moments and, where
 * the support is small enough to enumerate, its probabilities — so each regime
 * of each port (inversion and BTPE; the direct draw and HRUA) is held against
 * the formulas, from a fixed seed so a failure is a number and not a flake.
 */

import { describe, expect, it } from 'vitest'

import { Rng, binomial, hypergeometric, logFactorial, seedOf } from '../../src/metacooler/sampling'

/** Mean and variance of `draws` draws. */
function moments(draw: () => number, draws: number): { mean: number; variance: number; min: number; max: number } {
  let sum = 0
  let squares = 0
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < draws; i++) {
    const x = draw()
    sum += x
    squares += x * x
    if (x < min) min = x
    if (x > max) max = x
  }
  const mean = sum / draws
  return { mean, variance: squares / draws - mean * mean, min, max }
}

/** Log of the hypergeometric probability of `k`. */
function logHypergeometric(k: number, good: number, bad: number, sample: number): number {
  const choose = (n: number, r: number): number => logFactorial(n) - logFactorial(r) - logFactorial(n - r)
  return choose(good, k) + choose(bad, sample - k) - choose(good + bad, sample)
}

describe('the generator', () => {
  it('draws doubles in [0, 1) and is the same stream from the same seed', () => {
    const a = new Rng(42)
    const b = new Rng(42)
    const c = new Rng(43)
    let differs = false
    for (let i = 0; i < 10_000; i++) {
      const x = a.nextDouble()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
      expect(b.nextDouble()).toBe(x)
      if (c.nextDouble() !== x) differs = true
    }
    expect(differs).toBe(true)
  })

  it('draws integers over [0, max] inclusive, each about equally often', () => {
    const rng = new Rng(7)
    const seen = new Array<number>(7).fill(0)
    for (let i = 0; i < 70_000; i++) seen[rng.interval(6)]++
    for (const count of seen) expect(Math.abs(count - 10_000)).toBeLessThan(400)
    expect(rng.interval(0)).toBe(0)
    const big = rng.interval(2 ** 40)
    expect(Number.isInteger(big) && big >= 0 && big <= 2 ** 40).toBe(true)
  })

  it('seeds differ by every part, and the high half of a large part counts', () => {
    expect(seedOf(1, 2, 3)).not.toBe(seedOf(1, 3, 2))
    expect(seedOf(1, 2 ** 33)).not.toBe(seedOf(1, 0))
    expect(seedOf(5, 6)).toBe(seedOf(5, 6))
  })
})

describe('logFactorial', () => {
  it('is log k! from the table and from Stirling alike', () => {
    let exact = 0
    for (let k = 1; k <= 2000; k++) {
      exact += Math.log(k)
      expect(logFactorial(k)).toBeCloseTo(exact, 8)
    }
    expect(logFactorial(0)).toBe(0)
  })
})

describe('binomial', () => {
  const cases: Array<[number, number]> = [
    [10, 0.3], // inversion
    [1000, 0.01], // inversion, n·p = 10
    [200, 0.4], // BTPE, n·p = 80
    [190_948, 0.0558], // BTPE: a diagonal pixel subsampled
    [1_000_000, 0.9], // the complement arm
    [5, 1e-9],
  ]
  for (const [n, p] of cases) {
    it(`has the moments of Binomial(${n}, ${p})`, () => {
      const rng = new Rng(seedOf(n, p * 1e9))
      const draws = 40_000
      const m = moments(() => binomial(rng, n, p), draws)
      const mean = n * p
      const variance = n * p * (1 - p)
      expect(m.min).toBeGreaterThanOrEqual(0)
      expect(m.max).toBeLessThanOrEqual(n)
      // Five standard errors of the mean, and of the variance (≈ σ²√(2/draws)).
      expect(Math.abs(m.mean - mean)).toBeLessThan(5 * Math.sqrt(variance / draws) + 1e-9)
      expect(Math.abs(m.variance - variance)).toBeLessThan(5 * variance * Math.sqrt(2 / draws) + 1e-6)
    })
  }

  it('matches the probabilities of Binomial(12, 0.35) by χ²', () => {
    const rng = new Rng(11)
    const n = 12
    const p = 0.35
    const draws = 60_000
    const seen = new Array<number>(n + 1).fill(0)
    for (let i = 0; i < draws; i++) seen[binomial(rng, n, p)]++
    let chi = 0
    for (let k = 0; k <= n; k++) {
      const logP =
        logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p)
      const expected = draws * Math.exp(logP)
      if (expected > 5) chi += (seen[k] - expected) ** 2 / expected
    }
    // 12 degrees of freedom: the 99.9th percentile of χ² is 32.9.
    expect(chi).toBeLessThan(32.9)
  })

  it('is 0 and n at the ends, and the same draw from the same seed', () => {
    expect(binomial(new Rng(1), 0, 0.5)).toBe(0)
    expect(binomial(new Rng(1), 50, 0)).toBe(0)
    expect(binomial(new Rng(1), 50, 1)).toBe(50)
    expect(binomial(new Rng(99), 10_000, 0.3)).toBe(binomial(new Rng(99), 10_000, 0.3))
  })
})

describe('hypergeometric', () => {
  const cases: Array<[number, number, number]> = [
    [5, 20, 4], // direct
    [30, 70, 8], // direct
    [40, 60, 30], // HRUA
    [3, 10_000_000, 2_000_000], // a small pixel in a large pool
    [190_948, 179_000_000, 10_000_000], // a diagonal pixel
    [60_000_000, 119_175_551, 10_000_000], // a sequence pair's share
    [900, 100, 950], // sample past half the population
  ]
  for (const [good, bad, sample] of cases) {
    it(`has the moments of Hypergeometric(${good}, ${bad}, ${sample})`, () => {
      const rng = new Rng(seedOf(good, bad, sample))
      const draws = 30_000
      const total = good + bad
      const m = moments(() => hypergeometric(rng, good, bad, sample), draws)
      const mean = (sample * good) / total
      const variance = sample * (good / total) * (bad / total) * ((total - sample) / (total - 1))
      expect(m.min).toBeGreaterThanOrEqual(Math.max(0, sample - bad))
      expect(m.max).toBeLessThanOrEqual(Math.min(good, sample))
      expect(Math.abs(m.mean - mean)).toBeLessThan(5 * Math.sqrt(variance / draws) + 1e-9)
      expect(Math.abs(m.variance - variance)).toBeLessThan(5 * variance * Math.sqrt(2 / draws) + 1e-6)
    })
  }

  for (const [good, bad, sample] of [
    [12, 18, 7],
    [25, 25, 20],
  ] as Array<[number, number, number]>) {
    it(`matches the probabilities of Hypergeometric(${good}, ${bad}, ${sample}) by χ²`, () => {
      const rng = new Rng(seedOf(good, sample))
      const draws = 60_000
      const top = Math.min(good, sample)
      const seen = new Array<number>(top + 1).fill(0)
      for (let i = 0; i < draws; i++) seen[hypergeometric(rng, good, bad, sample)]++
      let chi = 0
      let cells = 0
      for (let k = Math.max(0, sample - bad); k <= top; k++) {
        const expected = draws * Math.exp(logHypergeometric(k, good, bad, sample))
        if (expected > 5) {
          chi += (seen[k] - expected) ** 2 / expected
          cells++
        }
      }
      // χ² at the 99.9th percentile, by the Wilson–Hilferty approximation.
      const df = cells - 1
      const bound = df * (1 - 2 / (9 * df) + 3.09 * Math.sqrt(2 / (9 * df))) ** 3
      expect(chi).toBeLessThan(bound)
    })
  }

  it('takes everything when the sample is the population, and nothing of nothing', () => {
    const rng = new Rng(3)
    expect(hypergeometric(rng, 7, 5, 12)).toBe(7)
    expect(hypergeometric(rng, 0, 5, 3)).toBe(0)
    expect(hypergeometric(rng, 7, 0, 3)).toBe(3)
    expect(hypergeometric(rng, 7, 5, 0)).toBe(0)
  })
})
