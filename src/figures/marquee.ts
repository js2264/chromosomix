/**
 * Zooming a chart by drawing a box on it, and getting back out of it.
 *
 * The wheel zooms one axis at a time — the abscissa on its own, the ordinate
 * with shift — and that is the right gesture for following a curve along, which
 * is what most of these figures are read by. It is the wrong one for *going to a
 * place*: a reader who can see the shoulder they want has to arrive at it by
 * scrolling in and panning back, twice, once per axis, and every notch of it
 * overshoots.
 *
 * A **marquee** says the whole thing in one gesture: hold ⌘ (or Ctrl, which is
 * the same key on the other two platforms), drag a box round what you want, and
 * the axes come back holding it.
 *
 * ## Which axes it sets
 *
 * Both, one, or neither — **read off the shape of the drag**, with no mode to be
 * in and nothing to choose first. An axis is set when the drag covered at least
 * {@link MARQUEE_SHARE} of *that axis's* length on screen: a flick across the
 * picture sets the abscissa and leaves the ordinate alone, a flick down it sets
 * the ordinate, and a box sets both. Proportional rather than a pixel count, so
 * the rule reads the same on a figure in the drawer's column and on the same
 * figure filling a window.
 *
 * Neither is a *click*, not a failed zoom: a press with ⌘ held that travelled a
 * few pixels is somebody who changed their mind, and the picture should not move.
 *
 * ## Why it is written here rather than asked of the library
 *
 * ECharts has a brush, and it is two things this is not. It arrives with a
 * toolbox of buttons over the picture — a second set of controls beside the
 * strip this application already gives every figure — and it zooms the rectangle
 * on *both* axes always, which throws away the distinction above. What is left
 * to write is small: a `<div>` with a border, three pointer handlers, and one
 * call to the chart's own pixel-to-data conversion at the end.
 *
 * The handlers are bound in the **capture** phase on the host. ECharts binds its
 * own on the element it makes *inside* that host, so capture is what lets this
 * see the press first and stop it: without that, a ⌘-drag would pan the chart
 * under the box being drawn.
 */

import type { ECharts } from 'echarts/core'

import { el } from '../ui/dom'

/**
 * How much of an axis a drag must cover for that axis to be set: a twelfth.
 *
 * On a 600-pixel-wide plot that is 50 pixels of travel, which is a deliberate
 * sideways movement and not a wobble. Below it on both axes the gesture is a
 * click and nothing moves.
 */
export const MARQUEE_SHARE = 1 / 12

/** A rectangle in the host's own pixels, normalised so `from` is the top left. */
export interface MarqueeBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** Which axes a drag of this shape sets. */
export interface MarqueeAxes {
  x: boolean
  y: boolean
}

/**
 * Which axes a box covers enough of to be about.
 *
 * Exported because it is the rule, and a rule is worth testing without a
 * browser: the whole of *what a reader meant by that drag* is these two
 * comparisons.
 */
export function axesOf(box: MarqueeBox, plot: { width: number; height: number }): MarqueeAxes {
  return {
    x: box.right - box.left >= Math.max(1, plot.width) * MARQUEE_SHARE,
    y: box.bottom - box.top >= Math.max(1, plot.height) * MARQUEE_SHARE,
  }
}

export interface MarqueeOptions {
  /** The element the chart is mounted in; the overlay is a child of it. */
  host: HTMLElement
  /** The live chart, or `null` before the library has arrived. */
  chart(): ECharts | null
  /**
   * A box was drawn and released. `axes` says which of the two it was about;
   * the caller converts and applies. Not called for a drag that moved too
   * little to be one, which is a click.
   */
  onZoom(box: MarqueeBox, axes: MarqueeAxes): void
  /** The reader double-clicked inside the picture. */
  onReset(): void
}

export interface Marquee {
  destroy(): void
}

/** Whether this event carries the modifier the marquee is held under. */
function held(event: MouseEvent): boolean {
  // ⌘ on a Mac, Ctrl everywhere else, and both accepted on both — a reader who
  // learnt one on a laptop and sits down at another machine should not have to
  // learn the other. Neither collides: the wheel's own modifier is shift.
  return event.metaKey || event.ctrlKey
}

/**
 * Attach the marquee to a chart's host.
 *
 * Returns the teardown. Safe to call where there is no `PointerEvent` — a test
 * environment, a build with no DOM — in which case nothing is bound and the
 * teardown is a no-op.
 */
export function attachMarquee(options: MarqueeOptions): Marquee {
  const { host } = options
  if (typeof window === 'undefined') return { destroy: () => {} }

  const rect = el('div', { class: 'figure-marquee hidden' })
  host.appendChild(rect)

  let from: { x: number; y: number } | null = null
  let pointer: number | null = null

  /** Where in the host a pointer event landed. */
  const at = (event: PointerEvent): { x: number; y: number } => {
    const box = host.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  const boxOf = (to: { x: number; y: number }): MarqueeBox => ({
    left: Math.min(from?.x ?? to.x, to.x),
    right: Math.max(from?.x ?? to.x, to.x),
    top: Math.min(from?.y ?? to.y, to.y),
    bottom: Math.max(from?.y ?? to.y, to.y),
  })

  const paint = (box: MarqueeBox): void => {
    rect.classList.remove('hidden')
    rect.style.left = `${box.left}px`
    rect.style.top = `${box.top}px`
    rect.style.width = `${Math.max(0, box.right - box.left)}px`
    rect.style.height = `${Math.max(0, box.bottom - box.top)}px`
  }

  const clear = (): void => {
    rect.classList.add('hidden')
    from = null
    pointer = null
  }

  const onDown = (event: PointerEvent): void => {
    if (!held(event) || event.button !== 0) return
    if (options.chart() === null) return
    // Before the chart sees it: the inside `dataZoom` pans on a drag, and a
    // picture sliding under the box being drawn on it is the one thing this
    // must not do.
    event.preventDefault()
    event.stopPropagation()
    from = at(event)
    pointer = event.pointerId
    host.setPointerCapture?.(event.pointerId)
  }

  const onMove = (event: PointerEvent): void => {
    if (from === null || event.pointerId !== pointer) return
    event.preventDefault()
    event.stopPropagation()
    paint(boxOf(at(event)))
  }

  const onUp = (event: PointerEvent): void => {
    if (from === null || event.pointerId !== pointer) return
    event.preventDefault()
    event.stopPropagation()
    const box = boxOf(at(event))
    clear()
    if (host.hasPointerCapture?.(event.pointerId) === true) {
      host.releasePointerCapture?.(event.pointerId)
    }
    const axes = axesOf(box, { width: host.clientWidth, height: host.clientHeight })
    // A press that went nowhere is a click. Saying so here rather than in the
    // caller keeps *what counts as a zoom* in one place.
    if (!axes.x && !axes.y) return
    options.onZoom(box, axes)
  }

  const onCancel = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return
    clear()
  }

  // Not bound with the modifier held, because a reader double-clicks with no
  // hands on the keyboard; and in the bubble phase, because the chart has
  // nothing of its own on a double click and letting it through costs nothing.
  const onDouble = (): void => options.onReset()

  host.addEventListener('pointerdown', onDown, true)
  host.addEventListener('pointermove', onMove, true)
  host.addEventListener('pointerup', onUp, true)
  host.addEventListener('pointercancel', onCancel, true)
  host.addEventListener('dblclick', onDouble)

  return {
    destroy(): void {
      host.removeEventListener('pointerdown', onDown, true)
      host.removeEventListener('pointermove', onMove, true)
      host.removeEventListener('pointerup', onUp, true)
      host.removeEventListener('pointercancel', onCancel, true)
      host.removeEventListener('dblclick', onDouble)
      rect.remove()
    },
  }
}

/**
 * The data window a pixel span covers, on one axis, ascending.
 *
 * `null` where the chart cannot answer — a press outside the plotting area, an
 * axis that is not there — and the caller then leaves that axis alone, which is
 * the same thing it does for an axis the drag was not about.
 *
 * Both ends are converted rather than one end plus a width, because a log axis
 * is not linear in pixels and a width in pixels means nothing on one.
 */
export function windowOf(
  chart: ECharts,
  finder: { xAxisIndex?: number; yAxisIndex?: number },
  lo: number,
  hi: number,
  vertical: boolean,
): [number, number] | null {
  const point = (along: number): number | null => {
    // **Two conversions, because the library's takes two shapes.** A finder
    // naming a *grid* takes the pair of pixels and answers with the pair of
    // data values; one naming a single *axis* takes the one pixel along it and
    // answers with the one value. Handed a pair, the axis form does arithmetic
    // on an array and answers `NaN` — which is a marquee that draws its box,
    // releases, and moves nothing, with no error anywhere to say why.
    //
    // The grid is asked first because it is the one that knows where the
    // plotting area is; the other coordinate is taken from the middle of the
    // picture rather than from the box, which may sit against an edge.
    const pixel: [number, number] = vertical
      ? [chart.getWidth() / 2, along]
      : [along, chart.getHeight() / 2]
    const pair = chart.convertFromPixel({ gridIndex: 0 }, pixel)
    const inGrid = Array.isArray(pair) ? pair[vertical ? 1 : 0] : null
    if (typeof inGrid === 'number' && Number.isFinite(inGrid)) return inGrid
    const single = chart.convertFromPixel(finder, along)
    const one = Array.isArray(single) ? single[vertical ? 1 : 0] : single
    return typeof one === 'number' && Number.isFinite(one) ? one : null
  }
  const a = point(lo)
  const b = point(hi)
  if (a === null || b === null) return null
  const [from, to] = a <= b ? [a, b] : [b, a]
  return from < to ? [from, to] : null
}
