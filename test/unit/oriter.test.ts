/**
 * The ori/ter call, checked rule by rule against configurations whose answer is
 * known — and the coverage curve against a function it can represent exactly.
 */

import { describe, expect, it } from 'vitest'

import {
  callOriTer,
  oriTerRatio,
  positionMean,
  separation,
  siteCluster,
  skewTurns,
  splineFit,
} from '../../src/analysis/oriter'

const L = 1_000_000

describe('positions on a circle', () => {
  it('measures the short way round, and straight on a line', () => {
    expect(separation(10, 990_000, L, true)).toBe(10_010)
    expect(separation(10, 990_000, L, false)).toBe(989_990)
  })

  /** Two sites either side of an origin at zero average to the origin, not to the terminus. */
  it('averages across the origin as angles', () => {
    const mean = positionMean([5_000, 995_000], L, true)
    expect(mean).toBeGreaterThanOrEqual(0)
    expect(mean).toBeLessThan(L)
    expect(separation(mean, 0, L, true)).toBeLessThan(1)
    expect(positionMean([5_000, 995_000], L, false)).toBe(500_000)
  })

  it('takes the densest cluster and leaves a lookalike far away out of it', () => {
    const found = siteCluster([1_000, 2_000, 4_000, 600_000], L, true, L / 8)
    expect(found?.count).toBe(3)
    expect(found?.centre).toBeCloseTo(2_333, -1)
  })
})

describe('the skew turning points', () => {
  it('reports the minimum and maximum at the middle of their steps', () => {
    const cumulative = Float32Array.from([0, -1, -2, -1, 0, 1, 2, 1])
    expect(skewTurns(cumulative, 10, 80)).toEqual({ low: 25, high: 65 })
  })
})

describe('placing the terminus', () => {
  const low = 10_000
  const high = 510_000

  it('follows the skew convention when nothing else is known', () => {
    const call = callOriTer({ length: L, circular: true, low, high, parS: [], matS: [] })
    expect(call).toMatchObject({ ori: low, ter: high, rule: 'skew', agreesWithSkew: true })
  })

  it('puts the terminus far from the parS cluster', () => {
    const call = callOriTer({
      length: L,
      circular: true,
      low,
      high,
      parS: [498_000, 505_000],
      matS: [],
    })
    // parS sits at the skew's maximum here, so that is the origin: the rule
    // decides, and it says it disagreed with the convention.
    expect(call).toMatchObject({ ori: high, ter: low, rule: 'parS', agreesWithSkew: false })
  })

  it('lets ten matS sites overrule parS, and fewer than ten abstain', () => {
    const matS = Array.from({ length: 10 }, (_, i) => 480_000 + i * 5_000)
    const decided = callOriTer({ length: L, circular: true, low, high, parS: [480_000], matS })
    expect(decided).toMatchObject({ ter: high, rule: 'matS' })
    const abstained = callOriTer({
      length: L,
      circular: true,
      low,
      high,
      parS: [15_000],
      matS: matS.slice(0, 9),
    })
    expect(abstained.rule).toBe('parS')
  })

  it('falls back to the lower coverage when there are no sites at all', () => {
    const call = callOriTer({
      length: L,
      circular: true,
      low,
      high,
      parS: [],
      matS: [],
      coverageAt: (at) => (at === low ? 1 : 3),
    })
    expect(call).toMatchObject({ ori: high, ter: low, rule: 'coverage', agreesWithSkew: false })
  })
})

describe('the coverage curve', () => {
  /**
   * Replication's two-slope shape on a circle: highest at the origin, lowest at
   * the terminus. A periodic cubic spline with a handful of knots follows it
   * closely, joins its own ends, and gives the ratio of the two.
   */
  it('fits a periodic two-slope profile and reads the ori/ter ratio off it', () => {
    const n = 200
    const positions = new Float64Array(n)
    const values = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      positions[i] = (i + 0.5) * (L / n)
      const d = separation(positions[i], 0, L, true) / (L / 2)
      values[i] = 2 ** (1 - d) // 2 at the origin, 1 at the terminus
    }
    const fit = splineFit(positions, values, L, 10, true)
    for (let i = 0; i < n; i++) expect(fit.fitted[i]).toBeCloseTo(values[i], 1)
    expect(fit.at(0)).toBeCloseTo(fit.at(L - 1), 2)
    const { ratio } = oriTerRatio(fit.fitted)
    expect(ratio).toBeGreaterThan(1.85)
    expect(ratio).toBeLessThan(2.05)
  })

  it('reproduces a straight line exactly on a line, and ignores missing values', () => {
    const positions = Float64Array.from({ length: 50 }, (_, i) => i * 1_000)
    const values = Float64Array.from({ length: 50 }, (_, i) => (i === 7 ? Number.NaN : 3 + i))
    const fit = splineFit(positions, values, 50_000, 6, false)
    expect(fit.fitted[7]).toBeCloseTo(10, 2)
    expect(fit.fitted[40]).toBeCloseTo(43, 2)
  })
})
