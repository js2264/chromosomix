/**
 * One track made out of two.
 *
 * The failure this file is really about is the one that looks right: laying two
 * bigWigs onto a uniform grid and evaluating both onto it produces a lane that
 * is correct in the middle of every interval and wrong at every edge, and the
 * edges are where the readings are. So the first two tests are about *where the
 * cuts fall* rather than about the arithmetic, and they use inputs whose
 * boundaries deliberately interleave.
 *
 * The rest pin the three answers a comparison has to be able to give — a number,
 * "only in the numerator", and "no comparison here" — because collapsing any of
 * them into another is silent and changes the finding.
 */

import { describe, expect, it } from 'vitest'

import {
  combineSamples,
  derivedTrackLabel,
  isTrackOp,
  neutralOf,
  type TrackOp,
} from '@/annotations/derived'
import type { TrackSampleSet, TrackSamples } from '@/annotations/types'

function region(
  intervals: Array<[number, number, number]>,
  contig = 'chrI',
  start = 0,
  end = 100,
): TrackSamples {
  return {
    contig,
    start,
    end,
    starts: Int32Array.from(intervals.map((i) => i[0])),
    ends: Int32Array.from(intervals.map((i) => i[1])),
    values: Float32Array.from(intervals.map((i) => i[2])),
    min: null,
    max: null,
    summary: false,
  }
}

function set(...regions: TrackSamples[]): TrackSampleSet {
  return { basesPerPixel: 1, regions, extent: null }
}

/** The combined lane as `[start, end, value]` triples, for readable assertions. */
function triples(result: TrackSampleSet | null, at = 0): Array<[number, number, number]> {
  if (result === null) return []
  const r = result.regions[at]
  return [...r.starts].map((s, i) => [s, r.ends[i], r.values[i]])
}

describe('the common refinement', () => {
  it('cuts at every boundary of either input, not at a grid of its own', () => {
    // Boundaries at 0/10/20 against 0/5/20: a uniform grid would have to pick
    // one of them and smear the other.
    const a = set(region([[0, 10, 4], [10, 20, 8]]))
    const b = set(region([[0, 5, 2], [5, 20, 4]]))
    expect(triples(combineSamples(a, b, 'ratio'))).toEqual([
      [0, 5, 2],
      [5, 10, 1],
      [10, 20, 2],
    ])
  })

  it('keeps a sharp edge sharp instead of ramping it across a cell', () => {
    // The control steps by a factor of ten at a single base. Resampled onto any
    // grid coarser than one base, that edge becomes a slope and the ratio
    // against it spikes at exactly the position being asked about.
    const a = set(region([[0, 100, 10]]))
    const b = set(region([[0, 49, 1], [49, 100, 10]]))
    const out = triples(combineSamples(a, b, 'ratio'))
    expect(out).toEqual([
      [0, 49, 10],
      [49, 100, 1],
    ])
  })

  it('produces at most as many intervals as its two inputs together', () => {
    const a = set(region([[0, 3, 1], [3, 6, 2], [6, 9, 3]]))
    const b = set(region([[0, 4, 1], [4, 8, 2]]))
    const out = combineSamples(a, b, 'difference')
    expect(out?.regions[0].starts.length).toBeLessThanOrEqual(5 + 3)
  })
})

describe('the three answers a comparison can give', () => {
  const a = set(region([[0, 10, 8], [10, 20, 0], [20, 30, 5]]))
  const b = set(region([[0, 10, 2], [10, 20, 4], [20, 30, 0]]))

  it('divides where both sides have a value', () => {
    expect(triples(combineSamples(a, b, 'ratio'))[0]).toEqual([0, 10, 4])
  })

  it('says "only in the numerator" by pinning it to the top of the lane', () => {
    // Not `Infinity`, which no lane can draw and no autoscale can bound, and not
    // dropped either — the finding survives, at the far end of what this lane
    // actually reached, which is exactly what it means.
    const out = triples(combineSamples(a, b, 'ratio'))
    const extent = combineSamples(a, b, 'ratio')?.extent
    expect(out[2][2]).toBe(extent?.max)
    expect(Number.isFinite(out[2][2])).toBe(true)
    // And it is genuinely the extreme, not a value in the middle of the lane.
    for (const [, , value] of out) expect(value).toBeLessThanOrEqual(out[2][2])
  })

  it('leaves a gap where neither side has anything', () => {
    // Both tracks silent over 40–50: no interval is emitted at all, so the lane
    // draws a break rather than a run of zeros along its floor.
    const left = set(region([[0, 10, 4]]))
    const right = set(region([[0, 10, 2]]))
    const out = combineSamples(left, right, 'ratio')
    expect(triples(out)).toEqual([[0, 10, 2]])
  })

  it('carries a gap on one side through as no comparison', () => {
    const left = set(region([[0, 10, 4]]))
    const right = set(region([[5, 10, 2]]))
    const out = triples(combineSamples(left, right, 'ratio'))
    // 0–5 has a numerator and no denominator: not a ratio, and not zero either.
    expect(Number.isNaN(out[0][2])).toBe(true)
    expect(out[1]).toEqual([5, 10, 2])
  })
})

describe('the log ratio', () => {
  it('puts a doubling and a halving the same distance either side of zero', () => {
    const a = set(region([[0, 10, 4], [10, 20, 1]]))
    const b = set(region([[0, 10, 2], [10, 20, 2]]))
    const out = triples(combineSamples(a, b, 'log2ratio'))
    expect(out[0][2]).toBeCloseTo(1, 6)
    expect(out[1][2]).toBeCloseTo(-1, 6)
  })

  it('keeps an empty numerator on the axis rather than at minus infinity', () => {
    // A lane is drawn between two limits and cannot draw `-Infinity`; "none of
    // this here" is a real finding and belongs at the floor, not off the bottom.
    const a = set(region([[0, 10, 0]]))
    const b = set(region([[0, 10, 4]]))
    const value = triples(combineSamples(a, b, 'log2ratio'))[0][2]
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeLessThan(0)
  })

  it('still has no answer where neither side does', () => {
    const a = set(region([[0, 10, 0]]))
    const b = set(region([[0, 10, 0]]))
    expect(Number.isNaN(triples(combineSamples(a, b, 'log2ratio'))[0][2])).toBe(true)
  })
})

describe('what the lane reports about itself', () => {
  it('drops a region the other track has no counterpart for', () => {
    // Half a comparison drawn as though it were a whole one is the failure.
    const a = set(region([[0, 10, 4]], 'chrI'), region([[0, 10, 4]], 'chrII'))
    const b = set(region([[0, 10, 2]], 'chrI'))
    const out = combineSamples(a, b, 'ratio')
    expect(out?.regions).toHaveLength(1)
    expect(out?.regions[0].contig).toBe('chrI')
  })

  it('measures its extent over what it produced, not over its operands', () => {
    const a = set(region([[0, 10, 8], [10, 20, 2]]))
    const b = set(region([[0, 20, 2]]))
    expect(combineSamples(a, b, 'ratio')?.extent).toEqual({ min: 1, max: 4 })
  })

  it('offers no min/max band, because a band does not compose', () => {
    const a = set(region([[0, 10, 4]]))
    const b = set(region([[0, 10, 2]]))
    const out = combineSamples(a, b, 'ratio')
    expect(out?.regions[0].min).toBeNull()
    expect(out?.regions[0].max).toBeNull()
  })

  it('waits for both operands rather than drawing one of them', () => {
    const a = set(region([[0, 10, 4]]))
    expect(combineSamples(a, null, 'ratio')).toBeNull()
    expect(combineSamples(null, a, 'ratio')).toBeNull()
  })
})

describe('how a derived lane names and centres itself', () => {
  it('names itself after the operation it is', () => {
    expect(derivedTrackLabel('treated', 'control', 'log2ratio')).toBe('log₂(treated / control)')
    expect(derivedTrackLabel('treated', 'control', 'difference')).toBe('treated − control')
  })

  it('knows the line a reader reads departures from', () => {
    expect(neutralOf('ratio')).toBe(1)
    expect(neutralOf('log2ratio')).toBe(0)
    expect(neutralOf('difference')).toBe(0)
  })

  it('accepts only operations it can serve', () => {
    expect(isTrackOp('ratio')).toBe(true)
    expect(isTrackOp('quotient' as TrackOp)).toBe(false)
  })
})
