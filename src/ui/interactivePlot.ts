/**
 * A figure you can ask questions of, without a chart library and without a
 * second renderer.
 *
 * The drawer's figures are drawn by one function per kind, onto a
 * `CanvasRenderingContext2D` that is sometimes a canvas and sometimes a
 * `VectorPage` — which is what makes the PNG a redraw and the PDF true vector
 * rather than a screenshot (`ui/vector.ts`). Every one of those properties is
 * worth more than any charting dependency, so none of them is given up here.
 *
 * The whole of the technique is instead: **an interactive figure is a plain
 * figure of a derived output**. Turning on a log axis produces a `CurveOutput`
 * with `xScale: 'log'` and hands it to the same `drawCurve`; hiding a series
 * produces one with fewer entries in `series`; dragging a rectangle across the
 * plot produces one whose `xDomain` and `yDomain` are that rectangle. There is
 * no zoom transform,
 * no second code path, and no way for what is exported to differ from what is on
 * screen — the export draws whatever object is current, which is the object the
 * controls built.
 *
 * That last property is the reason to do it this way rather than by transforming
 * the canvas. A reader who zooms into the first decade of a P(s), sets a log
 * axis and presses PDF gets *that* picture, at vector resolution, with its axes
 * relabelled for the range they are actually showing. A transform would have
 * given them the whole curve with a clipping rectangle over it.
 */

import { el, button } from './dom'
import { icon } from './icons'
import {
  curveFigure,
  matrixFigure,
  type CurveLayout,
  type PlotFigure,
} from './analysisPlots'
import { COLORMAP_NAMES } from '../render/colormaps'
import type { CurveOutput, MatrixOutput } from '../analysis/types'

/** What the reader has done to a curve, over and above what the task produced. */
interface CurveView {
  xLog: boolean
  yLog: boolean
  /** Series names the reader has switched off. */
  hidden: Set<string>
  /**
   * The window each axis shows, or `null` to fit the data.
   *
   * Two axes rather than one, which is the whole of the zoom: a curve is a
   * shape in both directions and a drag that could only cut the abscissa left a
   * reader who wanted to look at a shoulder half a decade deep with the entire
   * ordinate still in the picture.
   */
  x: [number, number] | null
  y: [number, number] | null
}

/** The same, for a matrix. */
interface MatrixView {
  vmin: number | null
  vmax: number | null
  colormap: string | null
}

/** How far a pointer must travel on an axis before the drag means that axis. */
const DRAG_SLOP = 8

/**
 * A curve, its controls, and the pointer gestures over it.
 *
 * Returned as a {@link PlotFigure} so the drawer, the PNG export and the PDF
 * export need no knowledge that it is interactive at all: `draw` paints the
 * current derived output, whatever the reader has done to it.
 */
export function interactiveCurve(output: CurveOutput): PlotFigure {
  // What the task asked the figure to open on, kept apart from what the reader
  // has done to it since: `reset` means "back to the picture I was given", and
  // a reset that went to the full extent instead would undo the runner's own
  // statement about which decade of a P(s) is worth looking at.
  const opening: Pick<CurveView, 'x' | 'y'> = {
    x: output.xDomain === undefined ? null : [...output.xDomain],
    y: output.yDomain === undefined ? null : [...output.yDomain],
  }
  const view: CurveView = {
    xLog: output.xScale === 'log',
    yLog: output.yScale === 'log',
    hidden: new Set(),
    x: opening.x === null ? null : [...opening.x],
    y: opening.y === null ? null : [...opening.y],
  }

  let layout: CurveLayout | null = null
  const onLayout = (next: CurveLayout | null): void => {
    layout = next
  }

  let figure = curveFigure(derive(output, view), onLayout)
  const body = el('div', { class: 'plot-body' }, figure.el)
  const readout = el('span', { class: 'plot-readout' })
  const controls = el('div', { class: 'plot-controls' })
  const host = el('div', { class: 'plot-interactive' }, controls, body)
  const marquee = el('div', { class: 'plot-marquee hidden' })

  const rebuild = (): void => {
    figure.destroy()
    figure = curveFigure(derive(output, view), onLayout)
    // **The marquee goes back in.** It lives in `body` because `body` is its
    // positioning context, and `replaceChildren` used to drop it on the first
    // rebuild — so the very first zoom worked and every drag after it selected
    // an invisible rectangle. A gesture that stops drawing itself after one use
    // reads as a broken control rather than as a missing element.
    body.replaceChildren(figure.el, marquee)
    paintControls()
    paintBoxes()
  }

  const toggle = (label: string, on: () => boolean, set: () => void, title: string): HTMLElement => {
    const node = button(label, () => {
      set()
      rebuild()
    }, { class: `btn btn-quiet${on() ? ' is-on' : ''}`, title })
    return node
  }

  // -------------------------------------------------------------------------
  // The axis boxes
  // -------------------------------------------------------------------------

  /**
   * Built once and re-appended, never rebuilt.
   *
   * `paintControls` replaces the row on every change, and an input recreated
   * under a reader's fingers loses the caret mid-number — so these four are made
   * here, live for the life of the figure, and are only *read from* by the
   * repaint.
   */
  const boxes = {
    x0: axisBox('Left edge of the plot, in the units of the x axis. Empty fits the data.'),
    x1: axisBox('Right edge of the plot, in the units of the x axis. Empty fits the data.'),
    y0: axisBox('Bottom of the plot. Empty fits whatever falls inside the x window.'),
    y1: axisBox('Top of the plot. Empty fits whatever falls inside the x window.'),
  }

  function axisBox(title: string): HTMLInputElement {
    const input = el('input', {
      class: 'input plot-axis-box',
      type: 'text',
      title,
      attrs: { inputmode: 'decimal', spellcheck: 'false' },
    }) as HTMLInputElement
    const commit = (): void => {
      readBoxes()
      rebuild()
    }
    input.addEventListener('change', commit)
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') commit()
    })
    return input
  }

  /** The four boxes into {@link view}: a pair is a window only when both parse. */
  function readBoxes(): void {
    const pair = (a: HTMLInputElement, b: HTMLInputElement): [number, number] | null => {
      const lo = parseBound(a.value)
      const hi = parseBound(b.value)
      // Half a window is not a window. Filling one box and leaving the other
      // empty is how a reader says "from here", and answering it with an axis
      // that runs from a number to nowhere would be a plot with one edge.
      if (lo === null || hi === null || lo === hi) return null
      return [Math.min(lo, hi), Math.max(lo, hi)]
    }
    view.x = pair(boxes.x0, boxes.x1)
    view.y = pair(boxes.y0, boxes.y1)
  }

  /** {@link view} into the four boxes, leaving whichever one has the caret alone. */
  function paintBoxes(): void {
    const put = (input: HTMLInputElement, value: number | undefined): void => {
      if (document.activeElement === input) return
      input.value = value === undefined ? '' : boundText(value)
    }
    put(boxes.x0, view.x?.[0])
    put(boxes.x1, view.x?.[1])
    put(boxes.y0, view.y?.[0])
    put(boxes.y1, view.y?.[1])
  }

  function paintControls(): void {
    const parts: HTMLElement[] = [
      toggle(
        'log x',
        () => view.xLog,
        () => {
          view.xLog = !view.xLog
        },
        'A logarithmic separation axis, which is how a P(s) is read',
      ),
      toggle(
        'log y',
        () => view.yLog,
        () => {
          view.yLog = !view.yLog
        },
        'A logarithmic value axis',
      ),
    ]

    // A series picker only where there is more than one to pick between. One
    // line with a checkbox beside it is a control that can only be turned off.
    if (output.series.length > 1) {
      parts.push(el('span', { class: 'plot-sep' }))
      for (const series of output.series) {
        const off = view.hidden.has(series.name)
        parts.push(
          button(
            series.name,
            () => {
              if (off) view.hidden.delete(series.name)
              else view.hidden.add(series.name)
              // Never all of them: a plot with no series is an empty box and a
              // reader who clicked the last one meant to isolate it, which is
              // what the modifier below is for.
              if (view.hidden.size >= output.series.length) view.hidden.clear()
              rebuild()
            },
            {
              class: `btn btn-quiet plot-series${off ? ' is-off' : ''}`,
              title: off ? `Show ${series.name}` : `Hide ${series.name} — alt-click to isolate it`,
            },
          ),
        )
        const last = parts[parts.length - 1]
        last.addEventListener('click', (event) => {
          if (!(event as MouseEvent).altKey) return
          event.stopPropagation()
          view.hidden = new Set(
            output.series.map((other) => other.name).filter((name) => name !== series.name),
          )
          rebuild()
        })
      }
    }

    // Each axis in a group of its own, so a control row that wraps — sixteen
    // series on a yeast genome wraps it twice — takes the label with its boxes
    // rather than leaving a lone `y` at the end of the line above them.
    parts.push(el('span', { class: 'plot-sep' }))
    parts.push(
      el('span', { class: 'plot-axis-pair' }, el('span', { class: 'plot-axis-label', text: 'x' }), boxes.x0, boxes.x1),
      el('span', { class: 'plot-axis-pair' }, el('span', { class: 'plot-axis-label', text: 'y' }), boxes.y0, boxes.y1),
    )

    if (!sameWindow(view.x, opening.x) || !sameWindow(view.y, opening.y)) {
      parts.push(
        button(
          'reset',
          () => {
            view.x = opening.x === null ? null : [...opening.x]
            view.y = opening.y === null ? null : [...opening.y]
            rebuild()
          },
          {
            class: 'btn btn-quiet',
            title: 'Back to the window this figure opened on (or double-click the plot)',
          },
        ),
      )
    }

    parts.push(readout)
    controls.replaceChildren(...parts)
  }

  // -------------------------------------------------------------------------
  // Pointer: a hover readout, and a drag that selects a rectangle
  // -------------------------------------------------------------------------

  body.append(marquee)

  let dragFrom: { x: number; y: number } | null = null

  /**
   * Where the plot area sits, and what its edges are worth.
   *
   * From {@link drawCurve}'s own return value rather than from margins restated
   * here. The margins are decided by the width of the widest tick label and the
   * height of the legend, so an approximation drifts whenever either changes —
   * which was tolerable while a drag only had to find an x, and is not once it
   * has to find a rectangle whose top edge the reader can see.
   */
  const dataAt = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (layout === null) return null
    const rect = figure.el.getBoundingClientRect()
    const { plot } = layout
    if (!(plot.width > 0) || !(plot.height > 0)) return null
    const fx = (clientX - rect.left - plot.x) / plot.width
    const fy = 1 - (clientY - rect.top - plot.y) / plot.height
    return {
      x: fromDrawSpace(layout.x.lo + fx * (layout.x.hi - layout.x.lo), layout.x.log),
      y: fromDrawSpace(layout.y.lo + fy * (layout.y.hi - layout.y.lo), layout.y.log),
    }
  }

  /** The plot area in `body` coordinates, for placing the marquee. */
  const plotRect = (): { left: number; top: number; right: number; bottom: number } | null => {
    if (layout === null) return null
    const rect = figure.el.getBoundingClientRect()
    const host = body.getBoundingClientRect()
    const left = rect.left - host.left + layout.plot.x
    const top = rect.top - host.top + layout.plot.y
    return { left, top, right: left + layout.plot.width, bottom: top + layout.plot.height }
  }

  const drawMarquee = (clientX: number, clientY: number): void => {
    const area = plotRect()
    if (area === null || dragFrom === null) return
    const host = body.getBoundingClientRect()
    const clamp = (value: number, lo: number, hi: number): number =>
      Math.min(Math.max(value, lo), hi)
    const x0 = clamp(dragFrom.x - host.left, area.left, area.right)
    const x1 = clamp(clientX - host.left, area.left, area.right)
    const y0 = clamp(dragFrom.y - host.top, area.top, area.bottom)
    const y1 = clamp(clientY - host.top, area.top, area.bottom)
    marquee.classList.remove('hidden')
    marquee.style.left = `${Math.min(x0, x1)}px`
    marquee.style.top = `${Math.min(y0, y1)}px`
    marquee.style.width = `${Math.abs(x1 - x0)}px`
    marquee.style.height = `${Math.abs(y1 - y0)}px`
  }

  body.addEventListener('pointermove', (event) => {
    const at = dataAt(event.clientX, event.clientY)
    if (at === null) {
      readout.textContent = ''
      return
    }
    const current = derive(output, view)
    const parts = current.series
      .map((series) => {
        const index = nearest(series.x, at.x)
        return index < 0 ? null : `${series.name} ${format(series.y[index])}`
      })
      .filter((part): part is string => part !== null)
      .slice(0, 3)
    readout.textContent = `${current.xLabel} ${format(at.x)}${parts.length === 0 ? '' : ' · '}${parts.join(' · ')}`
    if (dragFrom !== null) drawMarquee(event.clientX, event.clientY)
  })

  body.addEventListener('pointerleave', () => {
    readout.textContent = ''
  })

  body.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragFrom = { x: event.clientX, y: event.clientY }
    body.setPointerCapture(event.pointerId)
  })

  body.addEventListener('pointerup', (event) => {
    if (dragFrom === null) return
    const from = dataAt(dragFrom.x, dragFrom.y)
    const to = dataAt(event.clientX, event.clientY)
    const moved = { x: Math.abs(event.clientX - dragFrom.x), y: Math.abs(event.clientY - dragFrom.y) }
    dragFrom = null
    marquee.classList.add('hidden')
    body.releasePointerCapture?.(event.pointerId)
    if (from === null || to === null) return
    // **Per axis**, so a drag that is deliberately flat still means something. A
    // rectangle nine pixels wide and two tall is a horizontal band, and taking
    // its height literally would zoom the ordinate onto two pixels of noise; a
    // drag of a few pixels either way is a click that moved, and zooming to it
    // is the fastest way to make a plot feel hostile.
    const wantX = moved.x >= DRAG_SLOP && from.x !== to.x
    const wantY = moved.y >= DRAG_SLOP && from.y !== to.y
    if (!wantX && !wantY) return
    if (wantX) view.x = [Math.min(from.x, to.x), Math.max(from.x, to.x)]
    if (wantY) view.y = [Math.min(from.y, to.y), Math.max(from.y, to.y)]
    rebuild()
  })

  body.addEventListener('dblclick', () => {
    if (sameWindow(view.x, opening.x) && sameWindow(view.y, opening.y)) return
    view.x = opening.x === null ? null : [...opening.x]
    view.y = opening.y === null ? null : [...opening.y]
    rebuild()
  })

  paintControls()
  paintBoxes()

  return {
    el: host,
    draw: (ctx, box) => figure.draw(ctx, box),
    destroy: () => figure.destroy(),
  }
}

/** A bound as typed, or `null` for "fit the data". Accepts `4000` and `1e6` alike. */
function parseBound(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** A bound in a box: short enough to read back, exact enough to retype. */
function boundText(value: number): string {
  return String(Number(value.toPrecision(6)))
}

function sameWindow(a: [number, number] | null, b: [number, number] | null): boolean {
  if (a === null || b === null) return a === b
  return a[0] === b[0] && a[1] === b[1]
}

/** {@link drawSpace}'s inverse: a drawing-space coordinate back to a data value. */
function fromDrawSpace(value: number, log: boolean): number {
  return log ? Math.pow(10, value) : value
}

/**
 * The output as the reader has asked for it.
 *
 * Pure, so the export and the screen cannot disagree: both call this and both
 * get the same object.
 */
function derive(output: CurveOutput, view: CurveView): CurveOutput {
  const series = output.series.filter((entry) => !view.hidden.has(entry.name))
  return {
    ...output,
    // Never empty: hiding the last series is a reader isolating something, and
    // an empty frame is a worse answer than the picture they started from.
    series: series.length > 0 ? series : output.series,
    xScale: view.xLog ? 'log' : 'linear',
    yScale: view.yLog ? 'log' : 'linear',
    // The window travels *on the output*, so the PDF is cut where the screen is
    // and the axes are relabelled for it. Nothing is dropped from `series`:
    // clipping the arrays was how this used to zoom, and it cannot express a
    // window in y at all — a point above the top of the frame is part of the
    // line that leaves it, not a gap in the data.
    ...(view.x === null ? {} : { xDomain: [view.x[0], view.x[1]] as [number, number] }),
    ...(view.y === null ? {} : { yDomain: [view.y[0], view.y[1]] as [number, number] }),
  }
}

/** Index of the point nearest `x`, by binary search over an ascending axis. */
function nearest(xs: Float64Array, x: number): number {
  if (xs.length === 0) return -1
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1
  return lo
}

function format(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-3)) return value.toExponential(2)
  if (magnitude >= 100) return value.toFixed(0)
  if (magnitude >= 1) return value.toFixed(2)
  return value.toPrecision(3)
}

/**
 * A matrix figure with its colour range and colormap in reach.
 *
 * The same technique and the same reason: a pileup whose scale the reader has
 * set is a *different `MatrixOutput`*, drawn by the same `drawMatrix`, exported
 * by the same two buttons. A saddle read at the task's automatic range and a
 * saddle read at a range chosen to make two conditions comparable are the same
 * picture answering different questions, and only the second is the one that
 * goes in a figure.
 */
export function interactiveMatrix(output: MatrixOutput): PlotFigure {
  const view: MatrixView = { vmin: null, vmax: null, colormap: null }
  const auto = rangeOf(output.values)

  let figure = matrixFigure(withView(output, view))
  const body = el('div', { class: 'plot-body' }, figure.el)
  const controls = el('div', { class: 'plot-controls' })
  const host = el('div', { class: 'plot-interactive' }, controls, body)

  const rebuild = (): void => {
    figure.destroy()
    figure = matrixFigure(withView(output, view))
    body.replaceChildren(figure.el)
  }

  const numberBox = (
    label: string,
    get: () => number,
    set: (value: number | null) => void,
  ): HTMLElement => {
    const input = el('input', { class: 'plot-number', type: 'text' }) as HTMLInputElement
    input.value = trim(get())
    input.addEventListener('change', () => {
      const parsed = Number(input.value)
      set(input.value.trim() === '' || !Number.isFinite(parsed) ? null : parsed)
      input.value = trim(get())
      rebuild()
    })
    return el('label', { class: 'plot-field' }, el('span', { text: label }), input)
  }

  const picker = el('select', { class: 'plot-select' }) as HTMLSelectElement
  for (const name of COLORMAP_NAMES) {
    const option = el('option', { text: name }) as HTMLOptionElement
    option.value = name
    if (name === output.colormap) option.selected = true
    picker.append(option)
  }
  picker.addEventListener('change', () => {
    view.colormap = picker.value
    rebuild()
  })

  controls.replaceChildren(
    numberBox(
      'min',
      () => view.vmin ?? auto[0],
      (value) => {
        view.vmin = value
      },
    ),
    numberBox(
      'max',
      () => view.vmax ?? auto[1],
      (value) => {
        view.vmax = value
      },
    ),
    button(
      'auto',
      () => {
        view.vmin = null
        view.vmax = null
        rebuild()
        // The boxes show the automatic numbers again, which is what "auto"
        // means here: not an empty field, but the range the task chose.
        for (const input of controls.querySelectorAll('input')) input.dispatchEvent(new Event('sync'))
      },
      { class: 'btn btn-quiet', title: 'Back to the range the run chose' },
    ),
    el('span', { class: 'plot-sep' }),
    el('label', { class: 'plot-field' }, icon('palette', { size: 13 }), picker),
  )

  return {
    el: host,
    draw: (ctx, box) => figure.draw(ctx, box),
    destroy: () => figure.destroy(),
  }
}

/**
 * A matrix rescaled to the reader's range.
 *
 * Clamped rather than masked: a cell above the ceiling is drawn *at* the ceiling,
 * which is what a colour scale means everywhere else in this application. Turning
 * it transparent instead would make a saturated pileup look like missing data.
 */
function withView(output: MatrixOutput, view: MatrixView): MatrixOutput {
  if (view.vmin === null && view.vmax === null && view.colormap === null) return output
  const auto = rangeOf(output.values)
  const lo = view.vmin ?? auto[0]
  const hi = view.vmax ?? auto[1]
  const values = new Float32Array(output.values.length)
  for (let i = 0; i < values.length; i++) {
    const value = output.values[i]
    values[i] = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : value
  }
  return { ...output, values, colormap: view.colormap ?? output.colormap }
}

function rangeOf(values: Float32Array): [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  return lo <= hi ? [lo, hi] : [0, 1]
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return ''
  const magnitude = Math.abs(value)
  if (magnitude >= 1000 || magnitude === 0) return value.toFixed(0)
  if (magnitude >= 1) return value.toFixed(3).replace(/\.?0+$/, '')
  return value.toPrecision(3)
}
