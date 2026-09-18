/**
 * Zoom out, as arithmetic.
 *
 * The button beside the region box means the thing a genome browser has always
 * meant by zoom out — a **wider range**, re-read — rather than what the scroll
 * wheel on the map means, which is the same block drawn larger. All of the
 * interest is at the edges: a window against the end of a chromosome cannot be
 * centred, a window three presses from the whole sequence has to become the
 * whole sequence rather than a coordinate pair that spells it, and on a circle
 * there are no ends to be stopped by.
 */

import { describe, expect, it } from 'vitest'

import { widenRegion, ZOOM_OUT_FACTOR } from '@/ui/RegionView'

/** Yeast chromosome I, which is short enough to reach the end of in two presses. */
const LENGTH = 230_218

function window(start: number, end: number, length = LENGTH) {
  return { contig: 'I', start, end, length }
}

describe('in the middle of a sequence', () => {
  it('widens about the centre, not about either end', () => {
    expect(widenRegion(window(100_000, 110_000))).toBe('I:90000-120000')
  })

  it('keeps the old window as the middle third', () => {
    const widened = widenRegion(window(100_000, 110_000))
    const [start, end] = (widened ?? '').split(':')[1].split('-').map(Number)
    expect(end - start).toBe(10_000 * ZOOM_OUT_FACTOR)
    expect((start + end) / 2).toBe(105_000)
  })
})

describe('against an end', () => {
  it('slides the window in rather than asking for a negative coordinate', () => {
    expect(widenRegion(window(0, 10_000))).toBe('I:0-30000')
  })

  it('does the same at the far end', () => {
    expect(widenRegion(window(LENGTH - 10_000, LENGTH))).toBe(`I:${LENGTH - 30_000}-${LENGTH}`)
  })
})

describe('reaching the whole sequence', () => {
  it('names it, rather than spelling its coordinates out', () => {
    expect(widenRegion(window(100_000, 190_000))).toBe('I')
  })

  it('has nowhere to go once the whole of it is on screen', () => {
    expect(widenRegion(window(0, LENGTH))).toBeNull()
  })

  it('refuses a window with no width, and one on a sequence with no length', () => {
    expect(widenRegion(window(1_000, 1_000))).toBeNull()
    expect(widenRegion(window(0, 10, 0))).toBeNull()
  })
})

describe('on a sequence the reader has declared circular (§8.15)', () => {
  const CIRCLE = { circular: true }
  /** A 3 Mb bacterial chromosome. */
  const CHR = 3_000_000

  it('wraps past the origin instead of sliding the window sideways', () => {
    // Centred 20 kb in with a 60 kb window: the left edge is 10 kb *before* the
    // origin, which on a circle is 10 kb before the end.
    expect(widenRegion({ contig: 'chr', start: 10_000, end: 30_000, length: CHR }, CIRCLE)).toBe(
      'chr:2990000-50000',
    )
  })

  it('wraps at the far end too', () => {
    expect(
      widenRegion({ contig: 'chr', start: 2_970_000, end: 2_990_000, length: CHR }, CIRCLE),
    ).toBe('chr:2950000-10000')
  })

  it('still names the whole sequence once a press would cover a lap', () => {
    expect(
      widenRegion({ contig: 'chr', start: 0, end: 1_200_000, length: CHR }, CIRCLE),
    ).toBe('chr')
  })

  it('leaves a window clear of the junction alone', () => {
    expect(
      widenRegion({ contig: 'chr', start: 1_000_000, end: 1_100_000, length: CHR }, CIRCLE),
    ).toBe('chr:900000-1200000')
  })
})

describe('the factor', () => {
  it('is the caller’s where it is given', () => {
    expect(widenRegion(window(100_000, 110_000), { factor: 2 })).toBe('I:95000-115000')
  })
})
