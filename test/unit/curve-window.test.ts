/**
 * The window a curve is drawn in, and how the ordinate follows it.
 *
 * A P(s) runs from one base pair to a whole chromosome, and both ends of that
 * are unreadable: the first break holds the diagonal and is orders of magnitude
 * above everything else, and the last few are a handful of cells each. So a
 * runner says which decades its figure is worth opening on and
 * `ui/interactivePlot.ts` lets the reader move it — a marquee, four boxes, a
 * double-click — by rewriting the same two fields.
 *
 * Two properties carry the whole feature and neither is visible from the
 * pictures a person looks at:
 *
 * - **`drawCurve` reports where it drew.** The margins come out of the widths of
 *   the tick labels and the height of the legend, so anything that guessed them
 *   from outside would be an approximation that drifts. A marquee has to land on
 *   the number under the pointer.
 * - **An auto ordinate fits the x window, not the series.** Otherwise a curve
 *   zoomed to 4 kb–1 Mb still spends its whole height on a spike sitting off the
 *   left edge, which is the bug that made the default window worth having.
 */

import { describe, expect, it } from 'vitest'

import { drawCurve, type PlotTheme } from '@/ui/analysisPlots'
import type { CurveOutput } from '@/analysis/types'

const THEME: PlotTheme = {
  ink: '#000',
  muted: '#888',
  grid: '#ccc',
  background: '#fff',
  series: ['#123456'],
  font: '12px sans-serif',
}

/**
 * A context that measures and records, and paints nothing.
 *
 * Every drawing call is a no-op; `measureText` returns a width proportional to
 * the string, which is all the layout needs. `clip` is counted, because clipping
 * to the frame is what stops a series running over the axis labels once a window
 * can be smaller than the data.
 */
function fakeContext(): { ctx: CanvasRenderingContext2D; clips: () => number } {
  const record = { clips: 0 }
  const target = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    clip: () => {
      record.clips += 1
    },
  } as unknown as CanvasRenderingContext2D
  const ctx = new Proxy(target, {
    get(base, key) {
      const held = Reflect.get(base, key)
      if (held !== undefined) return held
      return () => undefined
    },
    set() {
      return true
    },
  })
  return { ctx, clips: () => record.clips }
}

function curve(over: Partial<CurveOutput> = {}): CurveOutput {
  // Decades of x, and a y that falls by one decade per decade of x — so which
  // slice of the ordinate comes back says which slice of the abscissa was fitted.
  const x = Float64Array.from([1, 10, 100, 1_000, 10_000, 100_000, 1_000_000])
  const y = Float64Array.from([1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6])
  return {
    kind: 'curve',
    id: 'ps',
    label: 'P(s)',
    series: [{ name: 'all', x, y }],
    xLabel: 'Genomic separation (bp)',
    yLabel: 'Contact probability density (per bp)',
    xScale: 'log',
    yScale: 'log',
    ...over,
  }
}

const BOX = { width: 600, height: 400 }

describe('where a curve says it was drawn', () => {
  it('reports a plot rectangle inside the box, and the axes it used', () => {
    const { ctx } = fakeContext()
    const layout = drawCurve(ctx, curve(), BOX, THEME)
    expect(layout).not.toBeNull()
    expect(layout!.plot.width).toBeGreaterThan(0)
    expect(layout!.plot.height).toBeGreaterThan(0)
    // Margins on every side: the y label and its ticks on the left, the x label
    // and its ticks below.
    expect(layout!.plot.x).toBeGreaterThan(0)
    expect(layout!.plot.x + layout!.plot.width).toBeLessThanOrEqual(BOX.width)
    expect(layout!.plot.y + layout!.plot.height).toBeLessThan(BOX.height)
    // Drawing space, which is log10 units on a log axis — the space the pointer
    // mapping is linear in.
    expect(layout!.x.log).toBe(true)
    expect(layout!.x.lo).toBeCloseTo(0, 9)
    expect(layout!.x.hi).toBeCloseTo(6, 9)
  })

  it('clips the series to the frame', () => {
    const fake = fakeContext()
    drawCurve(fake.ctx, curve({ xDomain: [100, 10_000] }), BOX, THEME)
    expect(fake.clips()).toBeGreaterThan(0)
  })

  it('says nothing rather than guessing when there is nothing to draw', () => {
    const { ctx } = fakeContext()
    expect(drawCurve(ctx, curve({ series: [] }), BOX, THEME)).toBeNull()
  })
})

describe('an axis window', () => {
  it('is used exactly, with no padding of its own', () => {
    const { ctx } = fakeContext()
    const layout = drawCurve(ctx, curve({ xDomain: [100, 10_000] }), BOX, THEME)!
    expect(layout.x.lo).toBeCloseTo(2, 9)
    expect(layout.x.hi).toBeCloseTo(4, 9)
  })

  it('carries the ordinate with it, so an auto y fits what is shown', () => {
    const { ctx } = fakeContext()
    const whole = drawCurve(ctx, curve(), BOX, THEME)!
    const zoomed = drawCurve(ctx, curve({ xDomain: [100, 10_000] }), BOX, THEME)!
    // The whole series spans 1 down to 1e-6; the window holds 1e-2 to 1e-4, and
    // the ordinate is fitted to those three points and not to the seven.
    expect(whole.y.lo).toBeLessThan(-5)
    expect(zoomed.y.lo).toBeGreaterThan(-4.5)
    expect(zoomed.y.hi).toBeLessThan(-1.5)
  })

  it('takes the two axes independently', () => {
    const { ctx } = fakeContext()
    const layout = drawCurve(ctx, curve({ yDomain: [1e-3, 1] }), BOX, THEME)!
    // y as asked for, x still the whole series.
    expect(layout.y.lo).toBeCloseTo(-3, 9)
    expect(layout.y.hi).toBeCloseTo(0, 9)
    expect(layout.x.hi).toBeCloseTo(6, 9)
  })

  it('sorts a window given backwards, which a right-to-left drag produces', () => {
    const { ctx } = fakeContext()
    const layout = drawCurve(ctx, curve({ xDomain: [10_000, 100] }), BOX, THEME)!
    expect(layout.x.lo).toBeCloseTo(2, 9)
    expect(layout.x.hi).toBeCloseTo(4, 9)
  })

  it('falls back to the data for a bound the axis cannot take', () => {
    // Zero has no place on a log axis, and refusing the pair would leave a
    // reader who typed one wrong number with no plot at all.
    const { ctx } = fakeContext()
    const layout = drawCurve(ctx, curve({ xDomain: [0, 10_000] }), BOX, THEME)!
    expect(layout.x.lo).toBeCloseTo(0, 9)
    expect(layout.x.hi).toBeCloseTo(6, 9)
  })

  it('says nothing to plot for a window with nothing in it', () => {
    // Not a fallback to the whole range. A reader who typed a window past the
    // end of their data has a figure that says so and four boxes still holding
    // what they typed; a plot that quietly widened itself back out would answer
    // a question they did not ask and look exactly like one that had not.
    const { ctx } = fakeContext()
    expect(drawCurve(ctx, curve({ xDomain: [2e6, 3e6] }), BOX, THEME)).toBeNull()
  })
})
