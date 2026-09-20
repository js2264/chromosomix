// @vitest-environment jsdom
/**
 * Drawing a box on a chart to go to a place (§18.13).
 *
 * The wheel zooms one axis at a time and is the right gesture for following a
 * curve along. It is the wrong one for *arriving* somewhere: a reader who can
 * see the shoulder they want has to scroll in and pan back, twice, once per
 * axis, overshooting at every notch. A marquee says the whole thing once.
 *
 * Two rules carry it and both are here. **Which axes a drag is about** is read
 * off its shape, with no mode to be in — a flick across sets the abscissa, a
 * flick down sets the ordinate, a box sets both, and a press that went nowhere
 * is a click and moves nothing. And the gesture is taken in the **capture**
 * phase, because ECharts pans on a drag and a picture sliding under the box
 * being drawn on it is the one thing this must not do.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  attachMarquee,
  axesOf,
  MARQUEE_SHARE,
  windowOf,
  type MarqueeAxes,
  type MarqueeBox,
} from '@/figures/marquee'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** A plot the size of one in the drawer. */
const PLOT = { width: 600, height: 400 }

function box(left: number, top: number, right: number, bottom: number): MarqueeBox {
  return { left, top, right, bottom }
}

describe('which axes a drag is about', () => {
  it('sets the abscissa alone for a flick across the picture', () => {
    expect(axesOf(box(100, 200, 400, 206), PLOT)).toEqual({ x: true, y: false })
  })

  it('sets the ordinate alone for a flick down it', () => {
    expect(axesOf(box(300, 40, 306, 300), PLOT)).toEqual({ x: false, y: true })
  })

  it('sets both for a box', () => {
    expect(axesOf(box(100, 80, 400, 300), PLOT)).toEqual({ x: true, y: true })
  })

  it('sets neither for a press that went nowhere', () => {
    expect(axesOf(box(300, 200, 308, 205), PLOT)).toEqual({ x: false, y: false })
  })

  it('is a share of the axis, so the rule reads the same at any size', () => {
    // The same gesture, in the same *proportion*, on a figure four times the
    // width: a rule in pixels would set the abscissa on one and not the other.
    const small = { width: 300, height: 200 }
    const large = { width: 1200, height: 800 }
    expect(axesOf(box(0, 0, 300 * MARQUEE_SHARE, 2), small).x).toBe(true)
    expect(axesOf(box(0, 0, 1200 * MARQUEE_SHARE, 2), large).x).toBe(true)
    // …and just under it is a click on both.
    expect(axesOf(box(0, 0, 300 * MARQUEE_SHARE - 1, 2), small).x).toBe(false)
    expect(axesOf(box(0, 0, 1200 * MARQUEE_SHARE - 1, 2), large).x).toBe(false)
  })

  it('survives a plot with no size rather than dividing by it', () => {
    expect(axesOf(box(0, 0, 10, 10), { width: 0, height: 0 })).toEqual({ x: true, y: true })
  })
})

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

interface Wired {
  host: HTMLElement
  zooms: Array<{ box: MarqueeBox; axes: MarqueeAxes }>
  resets: number
  /** Presses the chart would have seen, had the marquee let them through. */
  leaked: string[]
  destroy(): void
}

function wire(chart: unknown = {}): Wired {
  const host = document.createElement('div')
  // jsdom lays nothing out, so the box has to be stated.
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 }) as DOMRect
  Object.defineProperty(host, 'clientWidth', { value: 600, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true })
  document.body.appendChild(host)

  // What ECharts binds: a listener on a child, in the bubble phase.
  const inner = document.createElement('div')
  host.appendChild(inner)
  const leaked: string[] = []
  for (const name of ['pointerdown', 'pointermove', 'pointerup']) {
    host.addEventListener(name, () => leaked.push(name))
  }

  const zooms: Array<{ box: MarqueeBox; axes: MarqueeAxes }> = []
  let resets = 0
  const held = attachMarquee({
    host,
    chart: () => chart as never,
    onZoom: (box, axes) => zooms.push({ box, axes }),
    onReset: () => {
      resets++
    },
  })
  return {
    host,
    zooms,
    leaked,
    get resets() {
      return resets
    },
    destroy: () => held.destroy(),
  }
}

/** A pointer event of the shape the marquee reads. */
function press(
  type: string,
  x: number,
  y: number,
  options: { meta?: boolean; ctrl?: boolean } = {},
): PointerEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    metaKey: options.meta ?? false,
    ctrlKey: options.ctrl ?? false,
    button: 0,
  }) as PointerEvent
}

/** Drag from one point to another with the modifier held. */
function drag(
  wired: Wired,
  from: [number, number],
  to: [number, number],
  options: { meta?: boolean; ctrl?: boolean } = { meta: true },
): void {
  const inner = wired.host.firstElementChild as HTMLElement
  inner.dispatchEvent(press('pointerdown', from[0], from[1], options))
  inner.dispatchEvent(press('pointermove', to[0], to[1], options))
  inner.dispatchEvent(press('pointerup', to[0], to[1], options))
}

describe('the gesture', () => {
  it('reports the box and the axes it was about', () => {
    const wired = wire()
    drag(wired, [100, 80], [400, 300])
    expect(wired.zooms).toHaveLength(1)
    expect(wired.zooms[0].box).toEqual({ left: 100, top: 80, right: 400, bottom: 300 })
    expect(wired.zooms[0].axes).toEqual({ x: true, y: true })
    wired.destroy()
  })

  it('normalises a drag made backwards, so up-and-left is a box too', () => {
    const wired = wire()
    drag(wired, [400, 300], [100, 80])
    expect(wired.zooms[0].box).toEqual({ left: 100, top: 80, right: 400, bottom: 300 })
    wired.destroy()
  })

  it('takes ⌘ and Ctrl alike, so one hand fits every machine', () => {
    const wired = wire()
    drag(wired, [100, 80], [400, 300], { ctrl: true })
    expect(wired.zooms).toHaveLength(1)
    wired.destroy()
  })

  it('leaves a drag with no modifier to the chart, which pans on it', () => {
    const wired = wire()
    drag(wired, [100, 80], [400, 300], {})
    expect(wired.zooms).toEqual([])
    // …and every press reached the listener ECharts would have bound.
    expect(wired.leaked).toEqual(['pointerdown', 'pointermove', 'pointerup'])
    wired.destroy()
  })

  it('stops a held drag reaching the chart, so nothing pans under the box', () => {
    const wired = wire()
    drag(wired, [100, 80], [400, 300])
    expect(wired.leaked).toEqual([])
    wired.destroy()
  })

  it('says nothing where the library has not arrived', () => {
    const wired = wire(null)
    drag(wired, [100, 80], [400, 300])
    expect(wired.zooms).toEqual([])
    wired.destroy()
  })

  it('reports nothing for a press that did not travel', () => {
    const wired = wire()
    drag(wired, [300, 200], [306, 204])
    expect(wired.zooms).toEqual([])
    wired.destroy()
  })

  it('draws the box while the hand moves and takes it away on release', () => {
    const wired = wire()
    const inner = wired.host.firstElementChild as HTMLElement
    const rect = wired.host.querySelector('.figure-marquee') as HTMLElement
    expect(rect.classList.contains('hidden')).toBe(true)
    inner.dispatchEvent(press('pointerdown', 100, 80, { meta: true }))
    inner.dispatchEvent(press('pointermove', 400, 300, { meta: true }))
    expect(rect.classList.contains('hidden')).toBe(false)
    expect(rect.style.left).toBe('100px')
    expect(rect.style.width).toBe('300px')
    inner.dispatchEvent(press('pointerup', 400, 300, { meta: true }))
    expect(rect.classList.contains('hidden')).toBe(true)
    wired.destroy()
  })

  it('gives the box back on a cancelled pointer rather than leaving it up', () => {
    const wired = wire()
    const inner = wired.host.firstElementChild as HTMLElement
    inner.dispatchEvent(press('pointerdown', 100, 80, { meta: true }))
    inner.dispatchEvent(press('pointermove', 400, 300, { meta: true }))
    inner.dispatchEvent(press('pointercancel', 400, 300, { meta: true }))
    const rect = wired.host.querySelector('.figure-marquee') as HTMLElement
    expect(rect.classList.contains('hidden')).toBe(true)
    expect(wired.zooms).toEqual([])
    wired.destroy()
  })
})

describe('going back', () => {
  it('is a double click, with no modifier to hold', () => {
    const wired = wire()
    const inner = wired.host.firstElementChild as HTMLElement
    inner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(wired.resets).toBe(1)
    wired.destroy()
  })
})

/**
 * Turning the box into a pair of numbers.
 *
 * The library's own conversion takes **two shapes** and answers differently to
 * each: a finder naming a *grid* takes the pair of pixels and gives back the
 * pair of data values, and one naming a single *axis* takes the one pixel along
 * it and gives back the one value. Handed a pair, the axis form does arithmetic
 * on an array and answers `NaN` — a marquee that draws its box, releases, and
 * moves nothing, with no error anywhere to say why. That is the failure this
 * group is here for, and it is invisible in a screenshot until you know to
 * look for the axes not having moved.
 */
describe('the window a box covers', () => {
  type Finder = { gridIndex?: number; xAxisIndex?: number; yAxisIndex?: number }
  const chart = (
    answer: (finder: Finder, value: number | number[]) => number | number[] | null,
  ): Parameters<typeof windowOf>[0] =>
    ({
      getWidth: () => 600,
      getHeight: () => 400,
      convertFromPixel: answer,
    }) as never

  /** A grid that maps a pixel to itself, so the arithmetic is readable. */
  const grid = chart((finder, value) =>
    finder.gridIndex === 0 && Array.isArray(value) ? [value[0], -value[1]] : null,
  )

  it('asks the grid, which answers in both coordinates', () => {
    expect(windowOf(grid, { xAxisIndex: 0 }, 100, 400, false)).toEqual([100, 400])
  })

  it('orders the two ends, so a drag up the picture is a window like any other', () => {
    // Screen y runs down and an ordinate runs up, so the top of the box is the
    // *larger* value: the answer is sorted rather than the pixels.
    expect(windowOf(grid, { yAxisIndex: 0 }, 80, 300, true)).toEqual([-300, -80])
  })

  it('falls back to the axis, which takes one pixel and answers with one', () => {
    const axis = chart((finder, value) =>
      finder.gridIndex === undefined && typeof value === 'number' ? value * 2 : null,
    )
    expect(windowOf(axis, { xAxisIndex: 0 }, 10, 20, false)).toEqual([20, 40])
  })

  it('says nothing where neither can answer, and the caller leaves the axis alone', () => {
    expect(windowOf(chart(() => null), { xAxisIndex: 0 }, 10, 20, false)).toBeNull()
    expect(windowOf(chart(() => Number.NaN), { xAxisIndex: 0 }, 10, 20, false)).toBeNull()
  })

  it('refuses a window of no width rather than a zoom to a single value', () => {
    expect(windowOf(grid, { xAxisIndex: 0 }, 100, 100, false)).toBeNull()
  })
})

describe('tearing it down', () => {
  it('takes its box and its handlers with it', () => {
    const wired = wire()
    wired.destroy()
    expect(wired.host.querySelector('.figure-marquee')).toBeNull()
    drag(wired, [100, 80], [400, 300])
    expect(wired.zooms).toEqual([])
    // …and the chart hears the press again, since nothing is intercepting.
    expect(wired.leaked).toEqual(['pointerdown', 'pointermove', 'pointerup'])
  })
})
