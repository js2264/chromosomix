/**
 * The zoom steps beside the region box, as arithmetic.
 *
 * They mean the thing a genome browser has always meant by zoom — a **different
 * range**, re-read — rather than what the scroll wheel on the map means, which
 * is the same block drawn larger. One function does both directions because it
 * is one piece of arithmetic, and all of the interest is at the edges they
 * share: a window against the end of a chromosome cannot be centred, a window
 * one press from the whole sequence has to become the whole sequence rather than
 * a coordinate pair that spells it, a window already at the file's own bin size
 * has nowhere finer to go, and on a circle a press stops at the ends as it does
 * on a line — the way across the origin is `ori` or a window typed across it
 * (§8.15), and the one window measured the long way round is one already there.
 */

import { describe, expect, it } from 'vitest'

import { zoomedRegion, ZOOM_STEPS } from '@/ui/RegionView'

/** Three times wider, which is the step the button beside the box takes. */
const OUT = 3

const CIRCLE = { circular: true }
/** A 3 Mb bacterial chromosome. */
const CHR = 3_000_000

/** Yeast chromosome I, which is short enough to reach the end of in two presses. */
const LENGTH = 230_218

function window(start: number, end: number, length = LENGTH) {
  return { contig: 'I', start, end, length }
}

describe('in the middle of a sequence', () => {
  it('widens about the centre, not about either end', () => {
    expect(zoomedRegion(window(100_000, 110_000), OUT)).toBe('I:90000-120000')
  })

  it('keeps the old window as the middle third', () => {
    const widened = zoomedRegion(window(100_000, 110_000), OUT)
    const [start, end] = (widened ?? '').split(':')[1].split('-').map(Number)
    expect(end - start).toBe(10_000 * OUT)
    expect((start + end) / 2).toBe(105_000)
  })
})

describe('against an end', () => {
  it('slides the window in rather than asking for a negative coordinate', () => {
    expect(zoomedRegion(window(0, 10_000), OUT)).toBe('I:0-30000')
  })

  it('does the same at the far end', () => {
    expect(zoomedRegion(window(LENGTH - 10_000, LENGTH), OUT)).toBe(`I:${LENGTH - 30_000}-${LENGTH}`)
  })
})

describe('reaching the whole sequence', () => {
  it('names it, rather than spelling its coordinates out', () => {
    expect(zoomedRegion(window(100_000, 190_000), OUT)).toBe('I')
  })

  it('has nowhere to go once the whole of it is on screen', () => {
    expect(zoomedRegion(window(0, LENGTH), OUT)).toBeNull()
  })

  it('refuses a window with no width, and one on a sequence with no length', () => {
    expect(zoomedRegion(window(1_000, 1_000), OUT)).toBeNull()
    expect(zoomedRegion(window(0, 10, 0), OUT)).toBeNull()
  })
})

describe('on a sequence the reader has declared circular (§8.15)', () => {

  it('stops at the origin as a line stops at its start, rather than wrapping past it', () => {
    // Centred 20 kb in with a 60 kb window: the left edge would be 10 kb before
    // the origin. It used to wrap there — `chr:2990000-50000`, the picture split
    // at the junction — which made the zoom steps a third way across the origin
    // beside `ori` and a typed window, and the one a reader took by accident.
    expect(zoomedRegion({ contig: 'chr', start: 10_000, end: 30_000, length: CHR }, OUT, CIRCLE)).toBe(
      'chr:0-60000',
    )
  })

  it('stops at the far end too', () => {
    expect(
      zoomedRegion({ contig: 'chr', start: 2_970_000, end: 2_990_000, length: CHR }, OUT, CIRCLE),
    ).toBe('chr:2940000-3000000')
  })

  it('zooms a circle exactly as it zooms a line, wherever the window does not cross the origin', () => {
    for (const [start, end] of [
      [10_000, 30_000],
      [2_970_000, 2_990_000],
      [1_000_000, 1_100_000],
    ]) {
      for (const factor of [10, 3, 1 / 3, 1 / 10]) {
        const framed = { contig: 'chr', start, end, length: CHR }
        expect(zoomedRegion(framed, factor, CIRCLE)).toBe(zoomedRegion(framed, factor))
      }
    }
  })

  it('still names the whole sequence once a press would cover a lap', () => {
    expect(
      zoomedRegion({ contig: 'chr', start: 0, end: 1_200_000, length: CHR }, OUT, CIRCLE),
    ).toBe('chr')
  })

  it('widens a window that already runs across the origin', () => {
    // The end below the start is the whole point: on a circle that is one
    // window, measured the long way round the outside — 2,950,000 to 3,000,000
    // and on to 50,000, which is 100 kb. Three times that, about its own middle.
    expect(
      zoomedRegion({ contig: 'chr', start: 2_950_000, end: 50_000, length: CHR }, OUT, CIRCLE),
    ).toBe('chr:2850000-150000')
  })

  it('refuses a backwards window on a sequence nobody declared', () => {
    // Off a circle there is no long way round, and a negative span is not a
    // window to widen.
    expect(zoomedRegion({ contig: 'chr', start: 2_950_000, end: 50_000, length: CHR }, OUT)).toBeNull()
  })

  it('leaves a window clear of the junction alone', () => {
    expect(
      zoomedRegion({ contig: 'chr', start: 1_000_000, end: 1_100_000, length: CHR }, OUT, CIRCLE),
    ).toBe('chr:900000-1200000')
  })
})

describe('the factor', () => {
  it('is the caller’s: two is a smaller step than three', () => {
    expect(zoomedRegion(window(100_000, 110_000), 2)).toBe('I:95000-115000')
  })
})

describe('zooming in', () => {
  it('narrows about the centre, leaving the new window inside the old', () => {
    expect(zoomedRegion(window(100_000, 130_000), 1 / 3)).toBe('I:110000-120000')
  })

  it('is offered on a whole chromosome, which is an ordinary thing to zoom into', () => {
    // The widening direction refuses here — there is nowhere wider — and the
    // narrowing one must not, or the button would be dead on every view a reader
    // opens a chromosome at.
    expect(zoomedRegion(window(0, LENGTH), 3)).toBeNull()
    expect(zoomedRegion(window(0, LENGTH), 1 / 10)).toBe('I:103598-126620')
  })

  it('stops at the file’s own bin size rather than naming a sub-bin window', () => {
    expect(zoomedRegion(window(100_000, 101_000), 1 / 10, { floor: 1000 })).toBeNull()
    expect(zoomedRegion(window(100_000, 110_000), 1 / 10, { floor: 1000 })).toBe('I:104500-105500')
  })

  it('refuses a press that would change nothing', () => {
    expect(zoomedRegion(window(100_000, 100_003), 1)).toBeNull()
  })

  it('stays wrapped on a circle while it still crosses the origin', () => {
    expect(
      zoomedRegion({ contig: 'chr', start: 2_950_000, end: 50_000, length: CHR }, 1 / 3, CIRCLE),
    ).toBe('chr:2983334-16667')
  })
})

describe('the steps the bar offers', () => {
  it('are four, widest first, two out and two in', () => {
    expect(ZOOM_STEPS.map((step) => step.label)).toEqual(['10×', '3×', '3×', '10×'])
    expect(ZOOM_STEPS.map((step) => step.out)).toEqual([true, true, false, false])
    // Each in is the exact undo of the out beside it.
    expect(ZOOM_STEPS[0].factor * ZOOM_STEPS[3].factor).toBeCloseTo(1, 12)
    expect(ZOOM_STEPS[1].factor * ZOOM_STEPS[2].factor).toBeCloseTo(1, 12)
  })
})
