/**
 * A chart, as a {@link PlotFigure}.
 *
 * The contract every figure in the drawer has met since there were figures:
 * an element to put on screen, a `draw(ctx, box)` that paints the same picture
 * into any canvas context, and a `destroy`. It is the reason the PNG is a
 * *redraw* rather than a screenshot and the PDF is a real vector page rather
 * than a photograph — and it is met here too, which is the whole point of doing
 * the work this way.
 *
 * How a chart library meets it: ECharts is asked for **SVG**, not for a canvas.
 * On screen that SVG is the live, interactive chart. For an export the same
 * option is rendered once more, offscreen, at the size being exported to, and
 * the resulting picture is replayed onto the caller's context by
 * `figures/svgPaint.ts` — so a `VectorPage` receives paths and text, and the
 * file a reader publishes is a drawing.
 *
 * Only the bundle's own charts are registered, and the list is short on
 * purpose: ECharts is a big library and a wildcard import is most of a megabyte
 * of chart types nothing here draws.
 *
 * And it is fetched when the first figure is built rather than with the page,
 * exactly as three.js is for the 3D cell: `import()` below is a chunk of its
 * own on the web and folded into the one file of the standalone build, so a
 * reader who never runs an analysis never downloads a chart library. Everything
 * that needs it therefore waits on {@link ChartFigure.ready}.
 */

import type { ECharts } from 'echarts/core'

import { figurePaper } from '../ui/canvasPalette'
import { el } from '../ui/dom'
import { plotTheme, type PlotFigure } from '../ui/analysisPlots'
import { subscribeTextScale } from '../ui/textScale'
import { paintSvgString } from './svgPaint'
import { attachMarquee, windowOf, type Marquee, type MarqueeAxes, type MarqueeBox } from './marquee'
import { axisReach, optionOf, paperOption, ZOOM_X, ZOOM_Y, type ChartOption, type FigureTheme } from './option'
import { matrixOptionOf } from './matrixOption'
import type { MatrixFigureSpec, XyFigureSpec } from './spec'
import type { FigureStyle } from './style'

/** The library, once its chunk has arrived. `null` until then. */
let core: typeof import('./echartsBundle').echarts | null = null
let arriving: Promise<void> | null = null

/**
 * Fetch the library.
 *
 * Idempotent and shared: every figure on the page awaits the same promise, so
 * a result with six plots in it fetches one chunk. The charts it draws are
 * registered by `echartsBundle.ts`, which names them statically so the bundler
 * can leave the rest of the library out.
 */
async function load(): Promise<void> {
  if (core !== null) return
  arriving ??= import('./echartsBundle').then((module) => {
    core = module.echarts
  })
  await arriving
}

/**
 * The colours and the type, read off the page the figure is drawn on.
 *
 * The same `plotTheme` the hand-written painters use, so a chart and a contact
 * map in the same drawer agree about what the ink and the grid are — and so a
 * change of theme or of text scale reaches both by one route.
 */
export function themeOf(host: HTMLElement): FigureTheme {
  const theme = plotTheme(host)
  const family = /\d+(?:\.\d+)?px\s+(.*)$/.exec(theme.font)?.[1] ?? 'system-ui, sans-serif'
  return {
    ink: theme.ink,
    muted: theme.muted,
    grid: theme.grid,
    background: theme.background,
    series: theme.series,
    fontFamily: family,
    measure: (text, size) => {
      const ctx = ruler()
      if (ctx === null) return text.length * size * 0.6
      ctx.font = `${size}px ${family}`
      return ctx.measureText(text).width
    },
  }
}

/**
 * The ids of the zooms a `dataZoom` event moved, or `null` where it does not
 * say: the library reports a gesture as a batch of `{ dataZoomId }`, and an
 * action dispatched for one zoom as that zoom's id alone.
 */
function movedZooms(event: unknown): Set<string> | null {
  const one = (event ?? {}) as { dataZoomId?: unknown; batch?: Array<{ dataZoomId?: unknown }> }
  const ids = [one, ...(one.batch ?? [])]
    .map((entry) => entry.dataZoomId)
    .filter((id): id is string => typeof id === 'string')
  return ids.length === 0 ? null : new Set(ids)
}

/** One context to measure text on, for every figure: made when first asked. */
let measuring: CanvasRenderingContext2D | null | undefined
function ruler(): CanvasRenderingContext2D | null {
  if (measuring === undefined) measuring = document.createElement('canvas').getContext('2d')
  return measuring
}

/**
 * Height for a chart, matching what the hand-written curve has always used.
 *
 * 0.78 of the width, floored at 260 and capped at 520 — the floor is what a
 * folded drawer gets and is the number that matters, since a reader who has
 * narrowed the drawer to see the map beside it is still reading a plot rather
 * than a sparkline.
 */
export function chartHeight(width: number): number {
  return Math.max(260, Math.min(520, Math.round(width * 0.78)))
}

export interface ChartFigureOptions {
  /**
   * The figure. A matrix is drawn as a heatmap (`matrixOption.ts`) and
   * everything else as an xy chart — one instance, one contract, one export
   * path, and a reader who learnt the gestures on a curve has learnt them on a
   * pileup.
   */
  spec: XyFigureSpec | MatrixFigureSpec
  style: FigureStyle
  /**
   * The reader changed the style *through the chart* — a legend click, a wheel
   * zoom. Called with the new style so the caller can store it and repaint its
   * own controls; the figure has already applied it.
   */
  onStyle?: (style: FigureStyle) => void
  /** Fill the host instead of choosing a height from the width. */
  fill?: boolean
}

export interface ChartFigure extends PlotFigure {
  /** Redraw with a style the caller has changed. */
  update(style: FigureStyle): void
  /**
   * Take the height of the box instead of choosing one from the width.
   *
   * What the dialog turns on: in the drawer a figure decides how tall it is,
   * because the column it is in has no height of its own; in a dialog the
   * window decides, and a chart that kept its own answer would sit in the top
   * half of it with the rest blank.
   */
  setFill(on: boolean): void
  /** The style as it now stands, zoom included. */
  current(): FigureStyle
  /**
   * Settled once the library has arrived and the first frame is up.
   *
   * {@link PlotFigure.draw} is synchronous by contract and cannot wait, so a
   * caller that draws without having waited — a test, an export fired in the
   * same tick as the figure was built — is told plainly rather than handed an
   * empty page.
   */
  ready: Promise<void>
}

/** A chart of an xy figure, interactive on screen and exportable as itself. */
export function chartFigure(options: ChartFigureOptions): ChartFigure {
  const host = el('div', {
    class: options.fill === true ? 'figure-chart figure-chart-fill' : 'figure-chart',
  })
  let style = options.style
  let chart: ECharts | null = null
  let fill = options.fill === true
  let width = 0
  let height = 0
  /** Torn down: a chunk that arrives after this must not build anything. */
  let dead = false
  /** Suppresses the write-back while the option we just built is being applied. */
  let settling = false
  let marquee: Marquee | null = null
  /**
   * Where a double click goes back to: the windows a **control** last set.
   *
   * The single-source rule this module is built on says the window lives in the
   * style and that a wheel gesture and a number typed into the sidebar are the
   * same change to the same place. That is still true — this is not a second
   * window, it is a second *bookmark*, and the only thing it decides is where
   * *back* is. A reader who typed `4000` to `1e6`, scrolled about inside it and
   * pressed home means those two numbers, not the whole of the data; a reader
   * who typed nothing means the whole of the data, which is what `null` is.
   *
   * Written by {@link ChartFigure.update}, which is what a control reaches this
   * through, and never by the chart's own gestures — exactly the distinction
   * `FigureBlock` already draws between `apply` and `adopt`.
   */
  let home: { x: [number, number] | null; y: [number, number] | null } = {
    x: options.style.x.domain,
    y: options.style.y.domain,
  }

  /**
   * The option, for a box of a stated size.
   *
   * The size matters to a matrix and to a legend down the right: a heatmap's
   * grid is given a width and a height in pixels so the cells can be square
   * (see {@link matrixOptionOf}), and a legend's names wrap where they would
   * take more than their share of the width (`option.sideLegend`); an xy
   * chart's grid is otherwise four insets and stretches to whatever it is put
   * in. It is a parameter rather than the figure's own `width`/`height`
   * because an export is drawn at the page's size, not the screen's.
   */
  const build = (box: { width: number; height: number }, on: HTMLElement = host): ChartOption =>
    options.spec.kind === 'matrix'
      ? matrixOptionOf(options.spec.output, style, themeOf(on), box)
      : optionOf(options.spec, style, themeOf(on), box)

  /** How tall the picture is: the box's height, or one chosen from the width. */
  const tall = (): number => (fill ? host.clientHeight : chartHeight(width))

  const mount = (): void => {
    if (chart !== null || width <= 0 || core === null) return
    height = tall()
    if (height <= 0) return
    chart = core.init(host, null, { renderer: 'svg', width, height })
    chart.on('legendselectchanged', (event: unknown) => {
      const spec = options.spec
      if (spec.kind === 'matrix') return
      const selected = (event as { selected?: Record<string, boolean> }).selected
      if (selected === undefined) return
      const hidden = spec.series
        .filter((series) => selected[series.name] === false)
        .map((series) => series.id)
      style = { ...style, hidden }
      options.onStyle?.(style)
    })
    // The zoom is a *style* change, not a view transform, so it is written back
    // the moment it happens: the export then draws the window the reader is
    // looking at, and the sidebar's own number boxes agree with the picture.
    chart.on('dataZoom', (event: unknown) => {
      if (settling || chart === null) return
      const zooms = (chart.getOption() as { dataZoom?: Array<Record<string, unknown>> }).dataZoom
      if (zooms === undefined) return
      const domainOf = (zoom: Record<string, unknown> | undefined): [number, number] | null => {
        if (zoom === undefined) return null
        const lo = zoom['startValue']
        const hi = zoom['endValue']
        if (typeof lo !== 'number' || typeof hi !== 'number') return null
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null
        return [lo, hi]
      }
      // Only the zoom the gesture moved: the library reports both windows as
      // numbers afterwards, and taking the other one too froze an ordinate on
      // auto at whatever it showed the moment the abscissa was wheeled.
      const moved = movedZooms(event)
      const x = moved === null || moved.has(ZOOM_X)
      const y = moved === null || moved.has(ZOOM_Y)
      const before = style.x.domain
      style = {
        ...style,
        x: x ? { ...style.x, domain: domainOf(zooms[0]) ?? style.x.domain } : style.x,
        y: y ? { ...style.y, domain: domainOf(zooms[1]) ?? style.y.domain } : style.y,
      }
      const spec = options.spec
      if (spec.kind !== 'matrix') {
        // The ends of a window are labelled only where they are round (§18.13),
        // which a gesture changes as much as a typed number does; and an
        // ordinate on auto fits what is drawn in the abscissa's window, so a
        // wheel or a drag along the abscissa refits it as it goes. Through the
        // axes alone, a merge that leaves the zoom being dragged where it is,
        // where a rebuild would drop it mid-gesture — and what an export then
        // draws from the style is what the screen shows.
        const labels = (reach: ReturnType<typeof axisReach>): ChartOption => ({
          showMinLabel: reach.labels['showMinLabel'] ?? null,
          showMaxLabel: reach.labels['showMaxLabel'] ?? null,
          customValues: reach.ticks ?? null,
        })
        const xReach = axisReach(spec, style, 'x')
        const yReach = axisReach(spec, style, 'y')
        const refit = style.y.domain === null && style.x.domain !== before
        settling = true
        chart.setOption({
          xAxis: { axisLabel: labels(xReach), axisTick: { customValues: xReach.ticks ?? null } },
          yAxis: {
            ...(refit
              ? {
                  min: yReach.bounds['min'] ?? null,
                  max: yReach.bounds['max'] ?? null,
                }
              : {}),
            axisLabel: labels(yReach),
            axisTick: { customValues: yReach.ticks ?? null },
          },
        })
        settling = false
      }
      options.onStyle?.(style)
    })
    apply()
  }

  /**
   * The axes a marquee covered, as data windows.
   *
   * Only the ones the drag was about: an axis it was not about keeps whatever
   * it had, which is what makes a flick across the picture a zoom of the
   * abscissa alone rather than a zoom of both with the ordinate guessed.
   */
  const zoomTo = (box: MarqueeBox, axes: MarqueeAxes): void => {
    if (chart === null) return
    const next = { ...style }
    if (axes.x) {
      const span = windowOf(chart, { xAxisIndex: 0 }, box.left, box.right, false)
      if (span !== null) next.x = { ...next.x, domain: span }
    }
    if (axes.y) {
      // Screen y runs down and the ordinate runs up, which `windowOf` sorts out
      // by converting both ends and ordering the answer rather than the pixels.
      const span = windowOf(chart, { yAxisIndex: 0 }, box.top, box.bottom, true)
      if (span !== null) next.y = { ...next.y, domain: span }
    }
    if (next.x.domain === style.x.domain && next.y.domain === style.y.domain) return
    style = next
    apply()
    options.onStyle?.(style)
  }

  /** Home: the windows a control last set, or the whole of the data. */
  const goHome = (): void => {
    if (style.x.domain === home.x && style.y.domain === home.y) return
    style = { ...style, x: { ...style.x, domain: home.x }, y: { ...style.y, domain: home.y } }
    apply()
    options.onStyle?.(style)
  }

  const apply = (): void => {
    if (chart === null) return
    settling = true
    // `notMerge`, because a rebuild may have *fewer* series than the last one —
    // a merge would leave the old ones on the picture, which is how a figure
    // ends up showing a band belonging to a series that is no longer drawn.
    chart.setOption(build({ width, height }), true)
    settling = false
  }

  const resize = (): void => {
    if (width <= 0) return
    if (chart === null) {
      mount()
      return
    }
    const next = tall()
    if (next <= 0) return
    height = next
    chart.resize({ width, height })
    // A matrix's grid is stated in pixels, so a new box is a new layout — the
    // alternative is a square pileup that stops being square the moment the
    // drawer is dragged. So is a legend down the right, whose names wrap to
    // the width; a curve's grid is otherwise insets and needs nothing.
    if (options.spec.kind === 'matrix' || style.legend === 'right') apply()
  }

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect
          const nextWidth = box?.width ?? 0
          // The height matters only when the box decides it; otherwise the
          // chart sets it and observing it would be the classic feedback loop.
          const settled =
            Math.abs(nextWidth - width) < 0.5 &&
            (!fill || Math.abs((box?.height ?? 0) - height) < 0.5)
          if (settled && chart !== null) return
          width = nextWidth
          resize()
        })
  observer?.observe(host)

  // The two things a figure is drawn from that change underneath it. A canvas
  // is not restyled by CSS and neither is a chart's option, so a theme switch
  // or a press of the text-size control has to reach this the same way it
  // reaches the lanes: by rebuilding.
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onTheme = (): void => apply()
  const watcher =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(onTheme)
  watcher?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  media?.addEventListener?.('change', onTheme)
  const stopText = subscribeTextScale(() => apply())

  // The library, then the first frame. A figure whose host has no width yet —
  // a folded drawer, a dialog not laid out — mounts on the resize instead.
  //
  // The failure is *caught*, and says so on the figure rather than escaping as
  // an unhandled rejection: a chunk that did not arrive is a network problem
  // the reader can act on, and a figure that is merely blank is one they
  // cannot. `ready` settles either way, so nothing waiting on it hangs.
  const ready = load().then(
    () => {
      if (dead || typeof document === 'undefined') return
      if (width > 0) mount()
      // After the library, because the marquee asks the chart to convert its
      // pixels and there is nothing to ask before then. Bound to the host and
      // not to the chart's own element, so it survives the mount happening on a
      // later resize — a figure in a folded drawer has no width yet.
      marquee ??= attachMarquee({
        host,
        chart: () => chart,
        onZoom: zoomTo,
        onReset: goHome,
      })
    },
    () => {
      // `dead` is not the only way this can arrive too late: a test tears the
      // document down without destroying every figure it built, and there is
      // then nothing left to say it to.
      if (dead || typeof document === 'undefined') return
      host.replaceChildren(
        el('p', {
          class: 'hint',
          text: 'The chart library did not load. Check the connection and reopen this result.',
        }),
      )
    },
  )

  return {
    el: host,
    ready,

    /**
     * The same picture, at whatever size is asked for, on whatever context.
     *
     * Rendered offscreen rather than read off the live chart, because the two
     * sizes differ: a PDF page is not the width of the drawer, and a chart
     * scaled up from a screen-sized SVG would carry screen-sized type and
     * screen-spaced ticks into a figure meant for print.
     */
    draw(ctx: CanvasRenderingContext2D, box: { width: number; height: number }): void {
      if (core === null) throw new Error('the chart library has not arrived yet')
      const holder = document.createElement('div')
      holder.style.cssText =
        `position:absolute;left:-10000px;top:0;width:${box.width}px;height:${box.height}px`
      // Attached to the document so `plotTheme` finds the page's own colours;
      // the offset keeps it off screen for the frame it exists.
      host.appendChild(holder)
      const off = core.init(holder, null, {
        renderer: 'svg',
        width: box.width,
        height: box.height,
      })
      try {
        // On paper, whatever the theme where the chart is mounted (§7.2).
        off.setOption(paperOption(build(box, figurePaper())), true)
        paintSvgString(off.renderToSVGString(), ctx, box)
      } finally {
        off.dispose()
        holder.remove()
      }
    },

    update(next: FigureStyle): void {
      style = next
      // A control wrote this, so it is also where *back* is. See {@link home}.
      home = { x: next.x.domain, y: next.y.domain }
      apply()
    },

    setFill(on: boolean): void {
      if (fill === on) return
      fill = on
      host.classList.toggle('figure-chart-fill', on)
      resize()
    },

    current(): FigureStyle {
      return style
    },

    destroy(): void {
      dead = true
      marquee?.destroy()
      marquee = null
      observer?.disconnect()
      watcher?.disconnect()
      media?.removeEventListener?.('change', onTheme)
      stopText()
      chart?.dispose()
      chart = null
    },
  }
}
