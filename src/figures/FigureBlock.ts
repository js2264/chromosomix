/**
 * One output, as a figure with its controls: the strip, the dialog, the exports.
 *
 * This is what the drawer puts on screen for every result that is a picture.
 * It owns four things and nothing else:
 *
 * - the **style**, recalled for this file, task and output and written back on
 *   every change, so what a reader set survives a re-run and a reload;
 * - the **figure**, which is a chart, a rasterised matrix or a table depending
 *   on what the output is and what the reader has asked for;
 * - the **slim strip** above it — the three or four controls that are reached
 *   for constantly, inline, where they cost no gesture at all;
 * - the **dialog**, which is the whole settings column beside the figure at the
 *   size of the window. The same shell the 3D model opens in (`ui/StageDialog`),
 *   because it is the same idea and a reader who has learned one has learned
 *   both.
 *
 * The figure element is **moved** into the dialog and moved back, never copied.
 * A chart that was rebuilt for the dialog would lose the window the reader had
 * zoomed to and, worse, could differ from the one the export draws; moving it
 * means there is only ever one figure and one answer.
 */

import { button, el } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { stageDialog } from '../ui/StageDialog'
import type { Modal } from '../ui/Modal'
import { matrixFigure, type PlotFigure } from '../ui/analysisPlots'
import { dotplotFigure } from '../ui/dotplotFigure'
import { drawnAsChart } from './matrixOption'
import { chartFigure, themeOf, type ChartFigure } from './echartsFigure'
import { figureSettings, type FigureSettings } from './settings'
import { tableView } from './tableFigure'
import {
  distributionOfTable,
  specOf,
  xyOfTable,
  type FigureSpec,
  type MatrixFigureSpec,
  type XyFigureSpec,
} from './spec'
import { defaultStyle, forgetStyle, recallStyle, rememberStyle, type FigureStyle } from './style'
import type { MatrixOutput, TaskOutput } from '../analysis/types'

/** Where the figure dialog's sidebar width is kept, so a reader sets it once. */
const SIDE_SCOPE = 'figure:side'

export interface FigureBlockProps {
  output: TaskOutput
  /** The task id, which with the output's id names this figure's memory. */
  task: string
  /** The file the style is remembered against. */
  uri: string
  /** Buttons the drawer owns — TSV, bigWig, bedGraph — for the head row. */
  extras?: HTMLElement[]
  /** The drawer's own exports, which carry the provenance this does not know. */
  onPng?: (figure: PlotFigure) => void
  onPdf?: (figure: PlotFigure) => void
}

export interface FigureBlock {
  el: HTMLElement
  /** The figure as it now stands, or `null` where it is a table. */
  drawable(): PlotFigure | null
  /**
   * Settled once the figure can be drawn.
   *
   * The chart library arrives in a chunk of its own, so a caller that exports
   * in the same tick as the block was built — a test — waits on this. A reader
   * pressing PDF has waited by looking at the picture.
   */
  ready(): Promise<void>
  destroy(): void
}

export function figureBlock(props: FigureBlockProps): FigureBlock {
  const spec = specOf(props.output)
  if (spec === null) throw new Error('this output is not a figure')
  return blockOf(spec, props)
}

function blockOf(spec: FigureSpec, props: FigureBlockProps): FigureBlock {
  let style = recallStyle(props.uri, props.task, spec)
  // Declared before the first `place`, which reads it: a `let` in the dead zone
  // is a `ReferenceError` at the moment the first figure is built, and the
  // drawer catches it and prints it where the picture should be.
  let dialog: Modal | null = null
  let settings: FigureSettings | null = null
  let figure: PlotFigure | { el: HTMLElement; destroy(): void } = place(spec, style)

  const body = el('div', { class: 'figure-body' }, figure.el)
  const strip = el('div', { class: 'figure-strip' })
  const head = el('div', { class: 'analysis-figure-head' })
  const host = el('div', { class: 'analysis-figure figure-block' }, head, strip, body)

  // -------------------------------------------------------------------------

  /** Whether the figure on screen can be rebuilt in place rather than replaced. */
  const chart = (): ChartFigure | null =>
    'update' in figure ? (figure as ChartFigure) : null

  function place(built: FigureSpec, current: FigureStyle): PlotFigure | { el: HTMLElement; destroy(): void } {
    // A figure built while the dialog is up takes the dialog's height, not the
    // drawer column's — the reset that rebuilds it must not shrink it.
    const fill = dialog !== null
    if (built.kind === 'matrix' && built.output.streaks !== undefined) {
      // A dot plot on screen is a view of its own (§28.2): its streaks drawn
      // as lines at any zoom and read under the pointer. Its cells stay what an
      // export draws.
      const figure = dotplotFigure(built.output.streaks)
      figure.setFill?.(fill)
      return figure
    }
    if (built.kind === 'matrix') {
      // The painter takes the *styled* output, because it reads the colours and
      // the scale off the output it is given; the chart takes the raw one and
      // reads them off the style, which is what lets a recolour be an update in
      // place rather than a rebuild (`matrixOption.matrixOptionOf`).
      const output = drawnAsChart(built.output) ? built.output : styledMatrix(built, current)
      // A matrix small enough to be one rect per cell is a chart: hoverable, with
      // a colour bar the reader can clip by, zoomed by the same wheel and the
      // same marquee as every other figure. Above that the painter draws
      // (`matrixOption.MATRIX_CHART_CELLS`) — the metaplot's per-feature heatmap
      // is thousands of rows, and half a million rects is not a picture anybody
      // can point at.
      if (!drawnAsChart(output)) return matrixFigure(output)
      return chartFigure({
        spec: { ...built, output },
        // No legend: a heatmap has one series and its key is the colour bar.
        style: { ...current, legend: 'none' },
        onStyle: (next) => adopt(next),
        fill,
      })
    }
    if (built.kind === 'table') {
      if (current.plot === null) {
        return tableView(built, current, (key, down) => apply({ sortKey: key, sortDown: down }))
      }
      const derived =
        current.plot.x === null
          ? distributionOfTable(built, current.plot.y, current.plot.mark)
          : xyOfTable(built, current.plot.x, current.plot.y, current.plot.mark)
      return chartFigure({
        spec: derived,
        // A table drawn as a chart is one series, and a legend naming one
        // series is a column of the figure's width spent on a word already in
        // the axis title — the same rule `defaultStyle` applies to a curve.
        style: { ...current, mark: current.plot.mark, legend: 'none' },
        onStyle: (next) => adopt(next),
        fill,
      })
    }
    return chartFigure({ spec: built, style: current, onStyle: (next) => adopt(next), fill })
  }

  /** A style the *chart* produced: already applied, so only stored and echoed. */
  function adopt(next: FigureStyle): void {
    style = next
    rememberStyle(props.uri, props.task, spec.id, style)
    settings?.refresh()
    paintStrip()
  }

  /** A style a *control* produced: applied, stored, and the figure told. */
  function apply(patch: Partial<FigureStyle>): void {
    const before = style
    style = { ...style, ...patch }
    rememberStyle(props.uri, props.task, spec.id, style)
    // A chart of the same data takes the change in place, which keeps the
    // instance — and therefore the element the dialog may be holding.
    const live = chart()
    if (live !== null && sameFigure(spec, before, style)) live.update(style)
    // A dot plot is not rebuilt for a style: its view draws the streaks and
    // nothing the style says (§28.2), and a new one would throw away the window
    // the reader had zoomed to — for a title, which is the head's.
    else if (!(spec.kind === 'matrix' && spec.output.streaks !== undefined)) swap()
    settings?.refresh()
    paintStrip()
    // The head carries the title, which is one of the things a control sets.
    paintHead()
  }

  /**
   * Build the figure again and put the new one where the old one was.
   *
   * *Where it was*, not in the body: while the dialog is up the figure lives
   * in the dialog's stage, and replacing it in the body throws — which is how
   * a reset pressed in the dialog used to do nothing at all.
   */
  function swap(): void {
    const next = place(spec, style)
    const parent = figure.el.parentElement ?? body
    parent.replaceChild(next.el, figure.el)
    figure.destroy()
    figure = next
  }

  function reset(): void {
    forgetStyle(props.uri, props.task, spec.id)
    style = defaultStyle(spec)
    swap()
    settings?.refresh()
    paintStrip()
    paintHead()
  }

  // -------------------------------------------------------------------------
  // The strip: the two or three controls worth an inline row
  // -------------------------------------------------------------------------

  function paintStrip(): void {
    const items: HTMLElement[] = []
    if (spec.kind === 'xy') {
      const marks = el('select', { class: 'select select-tight' })
      for (const mark of ['line', 'area', 'step', 'points', 'bars', 'histogram', 'box', 'violin']) {
        marks.appendChild(el('option', { value: mark, text: mark }))
      }
      marks.value = style.mark
      marks.title = 'How the series are drawn'
      marks.addEventListener('change', () => apply({ mark: marks.value as FigureStyle['mark'] }))
      items.push(marks)
      items.push(
        axisToggle('x', style, apply),
        axisToggle('y', style, apply),
        pressed('list', style.legend !== 'none', 'legend', () =>
          apply({ legend: style.legend === 'none' ? 'right' : 'none' }),
        ),
        button('fit', () => apply({ x: { ...style.x, domain: null }, y: { ...style.y, domain: null } }), {
          class: 'btn btn-quiet',
          title: 'Both axes back to the whole of the data — the wheel zooms, this undoes it',
        }),
      )
    } else if (spec.kind === 'matrix' && spec.output.streaks !== undefined) {
      // A dot plot on screen is its streaks, red and blue whatever the colours
      // of its cells (§28.2): a colour picker there would change nothing seen.
    } else if (spec.kind === 'matrix') {
      const maps = el('select', { class: 'select select-tight' })
      maps.appendChild(el('option', { value: '', text: 'auto' }))
      // The short list, **plus whatever is in force**. A `select` whose value
      // is not one of its options draws empty, and a task that names its own
      // colours — a saddle's `RdBu_r`, a pileup's `fall` — put exactly that on
      // screen: a control that looked broken for the figures most likely to
      // have been recoloured on purpose.
      const offered = MATRIX_MAPS.includes(style.colormap ?? '')
        ? MATRIX_MAPS
        : [...(style.colormap === null ? [] : [style.colormap]), ...MATRIX_MAPS]
      for (const name of offered) maps.appendChild(el('option', { value: name, text: name }))
      maps.value = style.colormap ?? ''
      maps.title = 'The colours the values are drawn in'
      maps.addEventListener('change', () => apply({ colormap: maps.value === '' ? null : maps.value }))
      items.push(maps)
    } else {
      const box = el('input', {
        class: 'input input-tight',
        type: 'search',
        placeholder: 'filter rows',
        value: style.filter,
      }) as HTMLInputElement
      box.title = 'Rows whose text contains this, anywhere'
      box.addEventListener('change', () => apply({ filter: box.value }))
      items.push(box)
    }
    strip.replaceChildren(...items)
  }

  // -------------------------------------------------------------------------

  function paintHead(): void {
    const drawable = asDrawable(figure)
    head.replaceChildren(
      el('span', { class: 'analysis-figure-title', text: style.title ?? props.output.label }),
      ...(props.extras ?? []),
      ...(drawable === null || props.onPng === undefined
        ? []
        : [
            button('PNG', () => props.onPng?.(drawable), {
              class: 'btn',
              title: 'The figure as a raster, redrawn at 300 dpi',
            }),
          ]),
      ...(drawable === null || props.onPdf === undefined
        ? []
        : [
            button('PDF', () => props.onPdf?.(drawable), {
              class: 'btn',
              title: 'The figure as a true vector page — restylable, recolourable, scalable',
            }),
          ]),
      iconButton('sliders-horizontal', 'Customise this figure', () => enlarge(), {
        class: 'btn btn-icon figure-enlarge',
        size: 14,
      }),
    )
  }

  /**
   * The figure at the size of the window, with every control beside it.
   *
   * The element is moved, not rebuilt — see the note at the top of this file —
   * and put back wherever it was when the dialog closes.
   */
  function enlarge(): void {
    if (dialog !== null) return
    const column = settingsColumn()
    dialog = stageDialog({
      title: style.title ?? props.output.label,
      stage: figure.el,
      side: column.el,
      memoryKey: () => props.uri,
      scope: SIDE_SCOPE,
      onResize: () => filling(true),
      onClose: () => {
        dialog = null
        filling(false)
        body.replaceChildren(figure.el)
        paintHead()
      },
    })
    // The window decides the height from here until the dialog closes.
    filling(true)
  }

  /**
   * The figure takes the dialog's height, or goes back to choosing its own.
   *
   * Both renderers answer to this: a chart and a *painted* matrix alike sit in
   * the top half of the window otherwise, which on the one figure large enough
   * to still be painted — a heatmap of five thousand features — is the half a
   * reader opened the dialog to see more of.
   */
  function filling(on: boolean): void {
    chart()?.setFill(on)
    const held = figure as Partial<PlotFigure>
    held.setFill?.(on)
  }

  function settingsColumn(): FigureSettings {
    if (settings === null) {
      settings = figureSettings({
        spec,
        style: () => style,
        onChange: (next) => apply(next),
        onReset: () => reset(),
        theme: () => themeOf(host),
      })
    }
    settings.refresh()
    return settings
  }

  paintStrip()
  paintHead()

  return {
    el: host,
    drawable: () => asDrawable(figure),
    ready: () => ('ready' in figure ? (figure as ChartFigure).ready : Promise.resolve()),
    destroy(): void {
      dialog?.close()
      figure.destroy()
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asDrawable(figure: { el: HTMLElement; destroy(): void }): PlotFigure | null {
  return 'draw' in figure ? (figure as PlotFigure) : null
}

/**
 * Whether two styles describe the same *kind* of figure.
 *
 * A chart can be told about a new style; a table that has become a scatter, or
 * a matrix whose colormap changed, has to be built again. Asking here rather
 * than rebuilding always is what lets a wheel zoom and a legend click leave the
 * instance — and the element the dialog is holding — where it is.
 */
function sameFigure(spec: FigureSpec, before: FigureStyle, after: FigureStyle): boolean {
  // A matrix drawn as a chart takes a recolour and a new scale in place, like
  // every other chart; one drawn by the painter is rebuilt, which is what the
  // caller falls back to anyway when `chart()` answers `null`.
  if (spec.kind === 'matrix') return true
  if (spec.kind === 'table') {
    if (before.plot === null || after.plot === null) return before.plot === after.plot
    return before.plot.x === after.plot.x && before.plot.y === after.plot.y
  }
  return true
}

/** The matrix's colours, offered inline; the full list is in the dialog. */
const MATRIX_MAPS = ['fall', 'viridis', 'magma', 'seismic', 'coolwarm', 'bwr']

function axisToggle(which: 'x' | 'y', style: FigureStyle, apply: (patch: Partial<FigureStyle>) => void): HTMLElement {
  const axis = style[which]
  const on = axis.scale === 'log'
  // **Bordered when off.** It was `btn-quiet`, which takes the border and the
  // background away, so an unlit `log x` was plain grey text beside a `<select>`
  // — a label as far as the eye is concerned, and the off state of a toggle is
  // exactly when a reader needs to see that there is something to press. §26.3
  // asks for lit and plain, not lit and gone.
  const node = button(`log ${which}`, () => apply({ [which]: { ...axis, scale: on ? 'linear' : 'log' } } as Partial<FigureStyle>), {
    class: 'btn btn-toggle',
    title: on ? `A linear ${which} axis` : `A log ${which} axis — values at or below zero become gaps`,
  })
  node.setAttribute('aria-pressed', String(on))
  return node
}

function pressed(name: Parameters<typeof icon>[0], on: boolean, label: string, onPick: () => void): HTMLElement {
  const node = iconButton(name, on ? `Hide the ${label}` : `Show the ${label}`, onPick, {
    class: 'btn btn-icon btn-toggle',
    size: 13,
  })
  node.setAttribute('aria-pressed', String(on))
  return node
}

/**
 * The matrix as the reader has set it: colours, and the two ends of the scale.
 *
 * A derived output rather than a second renderer, which is the rule the whole
 * drawer is built on — the existing rasteriser draws it, exactly as it draws
 * the contact map, and nothing about how a matrix is painted changes here.
 */
function styledMatrix(spec: MatrixFigureSpec, style: FigureStyle): MatrixOutput {
  const output = { ...spec.output }
  if (style.colormap !== null) output.colormap = style.colormap
  if (style.vmin === null && style.vmax === null) return output
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const value of spec.output.values) {
    if (!Number.isFinite(value)) continue
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  const from = style.vmin ?? (Number.isFinite(lo) ? lo : 0)
  const to = style.vmax ?? (Number.isFinite(hi) ? hi : 1)
  if (from < to) output.range = [from, to]
  return output
}

/** Re-exported so the drawer can keep one list of every figure it built. */
export type { XyFigureSpec }
