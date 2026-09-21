/**
 * A per-bin profile, reduced to a drawable curve.
 *
 * Only reached on a file with no Annotations panel, where there is no lane for
 * the vector to be drawn as (§18.5) and the choice is between a picture and
 * nothing — but on that file it is the *only* view of a coverage run, so what it
 * loses matters.
 *
 * The property that carries it is **no silent loss**. A metagenome has four
 * million bins and a drawer eight hundred pixels, so something has to give; the
 * one thing that must not is a spike, since a marginal is read to find exactly
 * those. Buckets keep their min and max as a band, so a peak inside one is
 * visible as a band reaching up to it rather than dropped by a sampler taking
 * every thousandth bin.
 *
 * And `NaN` stays `NaN`. A gap in a profile is a bin the balancer dropped, and a
 * bucket bridged across it would draw a line through a stretch nothing measured.
 */

import { describe, expect, it } from 'vitest'

import { profileCurve } from '@/ui/analysisPlots'
import type { ProfileOutput } from '@/analysis/types'

function profile(values: number[], from = 0, binsize = 1000): ProfileOutput {
  return {
    kind: 'profile',
    id: 'p',
    label: 'Total coverage',
    values: Float32Array.from(values),
    extent: [from, from + values.length],
    binsize,
    unit: 'contacts',
  }
}

describe('a profile short enough to draw whole', () => {
  it('keeps every bin, and grows no band', () => {
    const curve = profileCurve(profile([1, 2, 3, 4]))
    const [series] = curve.series
    expect([...series.y]).toEqual([1, 2, 3, 4])
    // The x is the file's own bin number, at the middle of each bin.
    expect([...series.x]).toEqual([0.5, 1.5, 2.5, 3.5])
    // Nothing was summarised, so there is nothing for a band to say.
    expect(series.low).toBeUndefined()
    expect(series.high).toBeUndefined()
  })

  it('numbers its x from the profile’s own offset, not from zero', () => {
    const curve = profileCurve(profile([1, 2], 4000))
    expect([...curve.series[0].x]).toEqual([4000.5, 4001.5])
  })

  it('labels both axes from the profile', () => {
    const curve = profileCurve(profile([1], 0, 10_000))
    // `10 kb`, not `10.0 kb`: a bin size takes `resolutionLabel` (§26.2), so the
    // axis of a figure and the crumb over the map it was computed from spell
    // one number one way.
    expect(curve.xLabel).toBe('bin (10 kb each)')
    expect(curve.yLabel).toBe('Total coverage (contacts)')
    // A bare count has no unit, and inventing one would be a label that lies.
    const bare = profileCurve({ ...profile([1]), unit: '' })
    expect(bare.yLabel).toBe('Total coverage')
  })
})

describe('a profile too long to draw whole', () => {
  /** 12,000 bins is ten times the cap, so ten bins land in each bucket. */
  const long = (): ProfileOutput => profile(Array.from({ length: 12_000 }, () => 1))

  it('is bucketed down to something a canvas can paint', () => {
    const [series] = profileCurve(long()).series
    expect(series.y).toHaveLength(1200)
    expect(series.x).toHaveLength(1200)
  })

  it('keeps a spike as a band rather than sampling it away', () => {
    const values = Array.from({ length: 12_000 }, () => 1)
    // A single bin ten times the background, three quarters of the way along —
    // the exact thing a sampler at every tenth bin would step over.
    values[9003] = 10
    const [series] = profileCurve(profile(values)).series
    const at = 900
    expect(series.y?.[at]).toBeCloseTo((9 * 1 + 10) / 10, 6)
    expect(series.high?.[at]).toBe(10)
    expect(series.low?.[at]).toBe(1)
    // …and its neighbours are untouched, so the band marks where it is.
    expect(series.high?.[at - 1]).toBe(1)
  })

  it('leaves a bucket of nothing as a gap, and averages one that is partly there', () => {
    const values = Array.from({ length: 12_000 }, () => 1)
    for (let i = 0; i < 10; i++) values[i] = Number.NaN
    // Half of the second bucket, so the mean is over what is there.
    for (let i = 10; i < 15; i++) values[i] = Number.NaN
    const [series] = profileCurve(profile(values)).series
    expect(series.y?.[0]).toBeNaN()
    expect(series.low?.[0]).toBeNaN()
    expect(series.y?.[1]).toBe(1)
    expect(series.high?.[1]).toBe(1)
  })

  it('spans the whole profile, first bucket to last', () => {
    const [series] = profileCurve(long()).series
    expect(series.x[0]).toBeLessThan(10)
    expect(series.x[series.x.length - 1]).toBeGreaterThan(11_990)
  })
})

describe('the degenerate cases', () => {
  it('answers an empty profile with an empty series rather than throwing', () => {
    const [series] = profileCurve(profile([])).series
    expect(series.y).toHaveLength(0)
  })

  it('answers an all-gap profile with a series of gaps', () => {
    const [series] = profileCurve(profile([Number.NaN, Number.NaN])).series
    expect([...series.y].every(Number.isNaN)).toBe(true)
  })
})
