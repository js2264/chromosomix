/**
 * The rank tests and summaries behind *Signal by group* (§18.8), against the
 * numbers SciPy gives for the same inputs — `scipy.stats.mannwhitneyu(…,
 * method='asymptotic')`, `scipy.stats.kruskal`, `scipy.stats.chi2.sf` and
 * NumPy's percentiles.
 */

import { describe, expect, it } from 'vitest'

import { chiSquareSurvival, kruskalWallis, mannWhitney, summarise } from '@/analysis/groupstats'

describe('the chi-square tail', () => {
  it('matches SciPy at the familiar critical values and beyond', () => {
    expect(chiSquareSurvival(3.841458820694124, 1)).toBeCloseTo(0.05, 10)
    expect(chiSquareSurvival(5.991464547107979, 2)).toBeCloseTo(0.05, 10)
    expect(chiSquareSurvival(7.814727903251178, 3)).toBeCloseTo(0.05, 10)
    expect(chiSquareSurvival(20, 4)).toBeCloseTo(0.0004993992273873336, 12)
    expect(chiSquareSurvival(0.5, 7)).toBeCloseTo(0.9994464813904249, 10)
  })

  it('is 1 at zero, and nothing for a count of freedom that is not one', () => {
    expect(chiSquareSurvival(0, 3)).toBe(1)
    expect(chiSquareSurvival(2, 0)).toBeNaN()
  })
})

describe('Mann–Whitney', () => {
  it('matches SciPy on two separated groups', () => {
    const test = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
    expect(test.u).toBe(0)
    expect(test.p).toBeCloseTo(0.012185780355344813, 10)
    expect(test.effect).toBe(-1)
  })

  it('matches SciPy with ties, and says which way the difference goes', () => {
    const a = [1.1, 2.2, 2.2, 3.5, 4.0, 6.1, 7.3]
    const b = [2.2, 3.0, 5.5, 6.1, 8.0, 9.2]
    const test = mannWhitney(a, b)
    expect(test.u).toBe(12.5)
    expect(test.p).toBeCloseTo(0.249819364694559, 10)
    expect(test.effect).toBeLessThan(0)
    expect(mannWhitney(b, a).effect).toBeCloseTo(-test.effect, 12)
  })

  it('reads every value tied as no difference at all, as SciPy does', () => {
    const test = mannWhitney([0.5, 0.5, 0.5], [0.5, 0.5])
    expect(test.u).toBe(3)
    expect(test.p).toBe(1)
  })

  it('leaves out values that are not numbers, and answers nothing for an empty group', () => {
    expect(mannWhitney([1, Number.NaN, 2], [3, 4]).u).toBe(0)
    expect(mannWhitney([], [1, 2]).p).toBeNaN()
  })
})

describe('Kruskal–Wallis', () => {
  it('matches SciPy on three groups', () => {
    const test = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    expect(test.h).toBeCloseTo(7.2, 10)
    expect(test.df).toBe(2)
    expect(test.p).toBeCloseTo(0.02732372244729252, 10)
  })

  it('matches SciPy with ties', () => {
    const test = kruskalWallis([[1.1, 2.2, 2.2, 3.5], [2.2, 3.0, 5.5], [6.1, 6.1, 8.0, 9.2]])
    expect(test.h).toBeCloseTo(7.651162790697674, 10)
    expect(test.p).toBeCloseTo(0.02180575408093139, 10)
  })

  it('needs two groups with values', () => {
    expect(kruskalWallis([[1, 2, 3], []]).p).toBeNaN()
  })
})

describe('a group summarised', () => {
  it('matches NumPy', () => {
    const summary = summarise([3, 1, 4, 1, 5, 9, 2, 6, Number.NaN])
    expect(summary.n).toBe(8)
    expect(summary.mean).toBeCloseTo(3.875, 12)
    expect(summary.sd).toBeCloseTo(2.748376143938713, 12)
    expect([summary.q1, summary.median, summary.q3]).toEqual([1.75, 3.5, 5.25])
  })
})
