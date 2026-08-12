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
 * produces one with fewer entries in `series`; dragging across the plot produces
 * one whose series are clipped to the dragged range. There is no zoom transform,
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
  /** The x range a drag selected, or `null` for the whole thing. */
  domain: [number, number] | null
}

/** The same, for a matrix. */
interface MatrixView {
  vmin: number | null
  vmax: number | null
  colormap: string | null
}

/**
 * A curve, its controls, and the pointer gestures over it.
 *
 * Returned as a {@link PlotFigure} so the drawer, the PNG export and the PDF
 * export need no knowledge that it is interactive at all: `draw` paints the
 * current derived output, whatever the reader has done to it.
 */
export function interactiveCurve(output: CurveOutput): PlotFigure {
  const view: CurveView = {
    xLog: output.xScale === 'log',
    yLog: output.yScale === 'log',
    hidden: new Set(),
    domain: null,
  }

  let figure = curveFigure(derive(output, view))
  const body = el('div', { class: 'plot-body' }, figure.el)
  const readout = el('span', { class: 'plot-readout' })
  const controls = el('div', { class: 'plot-controls' })
  const host = el('div', { class: 'plot-interactive' }, controls, body)

  const rebuild = (): void => {
    figure.destroy()
    figure = curveFigure(derive(output, view))
    body.replaceChildren(figure.el)
    paintControls()
  }

  const toggle = (label: string, on: () => boolean, set: () => void, title: string): HTMLElement => {
    const node = button(label, () => {
      set()
      rebuild()
    }, { class: `btn btn-quiet${on() ? ' is-on' : ''}`, title })
    return node
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

    if (view.domain !== null) {
      parts.push(el('span', { class: 'plot-sep' }))
      parts.push(
        button(
          'reset zoom',
          () => {
            view.domain = null
            rebuild()
          },
          { class: 'btn btn-quiet', title: 'Back to the whole range (or double-click the plot)' },
        ),
      )
    }

    parts.push(readout)
    controls.replaceChildren(...parts)
  }

  // -------------------------------------------------------------------------
  // Pointer: a hover readout, and a drag that selects an x range
  // -------------------------------------------------------------------------

  const marquee = el('div', { class: 'plot-marquee hidden' })
  body.append(marquee)

  let dragFrom: number | null = null

  /**
   * Where the plot area sits inside the canvas.
   *
   * The margins are `drawCurve`'s, restated rather than exported, and the
   * comment is the reason: they are a property of how the figure is *drawn*, and
   * a pointer mapping that imported them would couple the interaction to the
   * renderer's internals so that changing a label's size moved the crosshair.
   * An approximation that is visibly off is better than a coupling that is
   * invisibly right, and these are within a pixel or two.
   */
  const plotBox = (): { left: number; right: number } => {
    const rect = body.getBoundingClientRect()
    return { left: rect.left + 54, right: rect.right - 12 }
  }

  const dataAt = (clientX: number): number | null => {
    const { left, right } = plotBox()
    if (right <= left) return null
    const fraction = (clientX - left) / (right - left)
    if (fraction < 0 || fraction > 1) return null
    const current = derive(output, view)
    const domain = xDomainOf(current)
    if (domain === null) return null
    const [lo, hi] = domain
    if (current.xScale === 'log' && lo > 0 && hi > 0) {
      return Math.exp(Math.log(lo) + fraction * (Math.log(hi) - Math.log(lo)))
    }
    return lo + fraction * (hi - lo)
  }

  body.addEventListener('pointermove', (event) => {
    const x = dataAt(event.clientX)
    if (x === null) {
      readout.textContent = ''
      return
    }
    const current = derive(output, view)
    const parts = current.series
      .map((series) => {
        const at = nearest(series.x, x)
        return at < 0 ? null : `${series.name} ${format(series.y[at])}`
      })
      .filter((part): part is string => part !== null)
      .slice(0, 3)
    readout.textContent = `${current.xLabel} ${format(x)}${parts.length === 0 ? '' : ' · '}${parts.join(' · ')}`
    if (dragFrom !== null) {
      const { left } = plotBox()
      const from = Math.min(dragFrom, event.clientX) - body.getBoundingClientRect().left
      const to = Math.max(dragFrom, event.clientX) - body.getBoundingClientRect().left
      marquee.classList.remove('hidden')
      marquee.style.left = `${Math.max(left - body.getBoundingClientRect().left, from)}px`
      marquee.style.width = `${Math.max(0, to - from)}px`
    }
  })

  body.addEventListener('pointerleave', () => {
    readout.textContent = ''
  })

  body.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragFrom = event.clientX
    body.setPointerCapture(event.pointerId)
  })

  body.addEventListener('pointerup', (event) => {
    if (dragFrom === null) return
    const from = dataAt(dragFrom)
    const to = dataAt(event.clientX)
    const travelled = Math.abs(event.clientX - dragFrom)
    dragFrom = null
    marquee.classList.add('hidden')
    body.releasePointerCapture?.(event.pointerId)
    // A drag of a few pixels is a click that moved, not a selection. Zooming to
    // a two-pixel window on a mis-click is the fastest way to make a plot feel
    // hostile.
    if (travelled < 8 || from === null || to === null || from === to) return
    view.domain = [Math.min(from, to), Math.max(from, to)]
    rebuild()
  })

  body.addEventListener('dblclick', () => {
    if (view.domain === null) return
    view.domain = null
    rebuild()
  })

  paintControls()

  return {
    el: host,
    draw: (ctx, box) => figure.draw(ctx, box),
    destroy: () => figure.destroy(),
  }
}

/**
 * The output as the reader has asked for it.
 *
 * Pure, so the export and the screen cannot disagree: both call this and both
 * get the same object.
 */
function derive(output: CurveOutput, view: CurveView): CurveOutput {
  const series = output.series
    .filter((entry) => !view.hidden.has(entry.name))
    .map((entry) => (view.domain === null ? entry : clip(entry, view.domain)))
    .filter((entry) => entry.x.length > 0)
  return {
    ...output,
    series: series.length > 0 ? series : output.series,
    xScale: view.xLog ? 'log' : 'linear',
    yScale: view.yLog ? 'log' : 'linear',
  }
}

/**
 * One series, cut to an x range.
 *
 * **One point is kept either side of the window**, and it is not a nicety: a
 * line clipped exactly at the boundary stops short of the edge of the plot, so a
 * zoomed curve appears to have gaps at both ends that the data does not have.
 */
function clip(
  series: CurveOutput['series'][number],
  [lo, hi]: [number, number],
): CurveOutput['series'][number] {
  let from = 0
  let to = series.x.length
  while (from < to && series.x[from] < lo) from += 1
  while (to > from && series.x[to - 1] > hi) to -= 1
  from = Math.max(0, from - 1)
  to = Math.min(series.x.length, to + 1)
  const slice = <T extends Float64Array | undefined>(values: T): T =>
    (values === undefined ? undefined : values.slice(from, to)) as T
  return {
    ...series,
    x: series.x.slice(from, to),
    y: series.y.slice(from, to),
    low: slice(series.low),
    high: slice(series.high),
  }
}

function xDomainOf(output: CurveOutput): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const series of output.series) {
    for (const value of series.x) {
      if (!Number.isFinite(value)) continue
      if (output.xScale === 'log' && value <= 0) continue
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }
  return lo <= hi ? [lo, hi] : null
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
