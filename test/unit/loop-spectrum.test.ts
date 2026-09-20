/**
 * The loop spectrum: score against separation.
 *
 * A caller already returns a pileup and a histogram of scores, and both of them
 * average the distance away. The failure that hides in both is the one this plot
 * exists for — a set whose near calls score and whose far calls do not is the
 * same pileup and the same histogram as a set where every call scores — so what
 * is worth pinning is that the trend line actually follows the scores, that the
 * cloud stays the same picture when it is thinned, and that a pattern with no
 * separation to plot against gets no plot rather than a degenerate one.
 */

import { describe, expect, it } from 'vitest'

import { loopSpectrum, SPECTRUM_POINTS } from '@/analysis/loopSpectrum'

const OPTIONS = {
  id: 'spectrum',
  label: 'Loop spectrum',
  noun: 'calls',
  yLabel: 'score',
}

/** `n` calls spread log-uniformly, scored by a function of their separation. */
function calls(n: number, score: (separation: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const separation = Math.round(10_000 * Math.pow(1000, i / Math.max(1, n - 1)))
    return { separation, score: score(separation) }
  })
}

describe('the cloud', () => {
  it('is drawn as points, because two calls are two measurements', () => {
    const spectrum = loopSpectrum(calls(50, () => 0.5), OPTIONS)
    expect(spectrum?.series[0].mark).toBe('points')
  })

  it('is on a log separation axis, as every distance plot here is', () => {
    const spectrum = loopSpectrum(calls(50, () => 0.5), OPTIONS)
    expect(spectrum?.xScale).toBe('log')
    expect(spectrum?.yScale).toBe('linear')
    expect(spectrum?.xLabel).toContain('Separation')
  })

  it('counts every call in the legend even when it draws fewer', () => {
    const many = SPECTRUM_POINTS * 3
    const spectrum = loopSpectrum(calls(many, () => 0.5), OPTIONS)
    expect(spectrum?.series[0].n).toBe(many)
    expect(spectrum?.series[0].name).toContain(many.toLocaleString())
    expect(spectrum?.series[0].x.length).toBeLessThanOrEqual(SPECTRUM_POINTS)
  })

  it('thins across the whole range rather than keeping the first n', () => {
    const many = calls(SPECTRUM_POINTS * 4, () => 0.5)
    const spectrum = loopSpectrum(many, OPTIONS)
    const x = spectrum?.series[0].x as Float64Array
    const widest = many[many.length - 1].separation
    // The last mark drawn is near the last call, not a quarter of the way in.
    expect(x[x.length - 1]).toBeGreaterThan(widest / 2)
  })
})

describe('the median line', () => {
  it('follows a score that falls away with distance', () => {
    // The failure the plot exists to show: a detector reporting the distance
    // decay it did not remove.
    const spectrum = loopSpectrum(
      calls(400, (separation) => 1 / Math.log10(separation)),
      OPTIONS,
    )
    const y = spectrum?.series[1].y as Float64Array
    expect(y.length).toBeGreaterThan(2)
    expect(y[0]).toBeGreaterThan(y[y.length - 1])
  })

  it('is flat where the score does not depend on distance', () => {
    const spectrum = loopSpectrum(calls(400, () => 0.42), OPTIONS)
    const y = spectrum?.series[1].y as Float64Array
    for (const value of y) expect(value).toBeCloseTo(0.42, 10)
  })

  it('is a median, so a handful of outliers do not carry it', () => {
    const steady = calls(200, () => 0.4)
    const spiked = steady.map((call, i) => (i % 40 === 0 ? { ...call, score: 100 } : call))
    const plain = loopSpectrum(steady, OPTIONS)?.series[1].y as Float64Array
    const outliers = loopSpectrum(spiked, OPTIONS)?.series[1].y as Float64Array
    expect([...outliers]).toEqual([...plain])
  })

  it('rises through the separations its band actually holds', () => {
    const spectrum = loopSpectrum(calls(200, () => 0.5), OPTIONS)
    const x = spectrum?.series[1].x as Float64Array
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1])
    // Inside the range of the calls, not at the edges the bands were cut at.
    expect(x[0]).toBeGreaterThanOrEqual(10_000)
    expect(x[x.length - 1]).toBeLessThanOrEqual(10_000_000)
  })
})

describe('what it refuses to draw', () => {
  it('has no plot for a pattern whose anchors are one bin apart', () => {
    // A border, a hairpin: every separation is zero and a scatter over one x is
    // not a plot.
    expect(loopSpectrum([{ separation: 0, score: 1 }, { separation: 0, score: 2 }], OPTIONS))
      .toBeNull()
  })

  it('has no plot for a single call', () => {
    expect(loopSpectrum([{ separation: 50_000, score: 0.8 }], OPTIONS)).toBeNull()
    expect(loopSpectrum([], OPTIONS)).toBeNull()
  })

  it('drops a call with no score rather than plotting a gap', () => {
    const spectrum = loopSpectrum(
      [
        { separation: 10_000, score: 0.5 },
        { separation: 20_000, score: Number.NaN },
        { separation: 30_000, score: 0.7 },
      ],
      OPTIONS,
    )
    expect(spectrum?.series[0].n).toBe(2)
  })
})
