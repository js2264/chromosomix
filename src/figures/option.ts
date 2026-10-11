/**
 * A figure, as the chart library's option object.
 *
 * Pure: a spec, a style and a theme in, a plain object out, no DOM and no
 * library. That is deliberate — this is where every decision about what the
 * picture *is* now lives, and a decision inside a renderer is a decision nobody
 * can test. `echartsFigure.ts` does nothing but hand the result to ECharts and
 * take the SVG back.
 *
 * Two rules hold throughout:
 *
 * - **The style decides, the spec supplies.** Nothing here reads a colour or a
 *   scale off the output; the style already resolved those from the task's
 *   suggestions (`figures/style.ts`), so what a reader has set and what a task
 *   proposed cannot disagree at this point.
 * - **What is drawn is what is exported.** The window is in the style, not in a
 *   zoom transform the export would have to reproduce — so a reader who zooms
 *   into a shoulder and presses PDF gets that shoulder, with its axes
 *   relabelled for the range they are actually showing.
 */

import { fmt } from '../ui/dom'
import { axisNumber } from '../units'
import { boxSummary, density, histogram, sorted } from './stats'
import {
  isCategorical,
  isDistribution,
  type FigureSeries,
  type MarkKind,
  type XyFigureSpec,
} from './spec'
import type { FigureStyle } from './style'

/** The colours and the type a figure borrows from the page it is drawn on. */
export interface FigureTheme {
  ink: string
  muted: string
  grid: string
  background: string
  /** The categorical palette, in order. */
  series: string[]
  fontFamily: string
}

/** What an option object is, without dragging the library's types in. */
export type ChartOption = Record<string, unknown>

/**
 * The colour a series is drawn in.
 *
 * Three sources in order, and the order is the argument: what the reader set,
 * then what the task said, then the palette — so a recolour survives a re-run
 * and a task that has an opinion about which line is which keeps it.
 *
 * The **index into the full list**, never into a filtered one: a figure whose
 * first series is switched off must not repaint every remaining line one place
 * up the palette (`analysisPlots.resolveSeriesColours` learned this the hard
 * way).
 */
export function seriesColour(
  series: FigureSeries,
  index: number,
  style: FigureStyle,
  theme: FigureTheme,
): string {
  const chosen = style.colours[series.id]
  if (chosen !== undefined) return chosen
  if (series.colour !== undefined) return series.colour
  return theme.series[index % theme.series.length]
}

/** How a series is drawn: its own mark where it has one, else the figure's. */
export function markOf(series: FigureSeries, style: FigureStyle): MarkKind {
  return isDistribution(style.mark) ? style.mark : (series.mark ?? style.mark)
}

/**
 * A log axis cannot show a zero, and pretending otherwise draws a false line.
 *
 * Non-positive values become `null`, which is a *gap* — the curve stops and
 * starts again. Clamping them to the smallest positive value instead would put
 * a point on the picture at a height nothing was measured at.
 */
function forAxis(value: number, log: boolean): number | null {
  if (!Number.isFinite(value)) return null
  if (log && value <= 0) return null
  return value
}

function pairs(series: FigureSeries, style: FigureStyle): Array<[number, number] | null> {
  const xLog = style.x.scale === 'log'
  const yLog = style.y.scale === 'log'
  const out: Array<[number, number] | null> = []
  for (let i = 0; i < series.y.length; i++) {
    const x = forAxis(series.x[i] ?? i, xLog)
    const y = forAxis(series.y[i], yLog)
    out.push(x === null || y === null ? null : [x, y])
  }
  return out
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/**
 * The x axis label, in the units the reader navigates by.
 *
 * A profile's x is a bin index, which is a true number nobody thinks in: with a
 * bin size to multiply by it becomes `1.22 Mb`, the same quantity written the
 * way the map's own ruler writes it.
 */
/**
 * How the abscissa is spelled, where the quantity on it has a unit.
 *
 * Three ways it can. A figure whose x is in **bins** carries the bin size and is
 * multiplied up. A figure whose x is already in **base pairs** says so in its
 * own axis name — `Genomic separation (bp)` — and takes `fmt.bp` directly: that
 * axis used to fall through to the plain magnitude spelling, so a P(s) reaching
 * a megabase printed `4000`, `10000`, `100000`, `1e6` where the app's own units
 * read `4.0 kb`, `10.0 kb`, `100.0 kb`, `1.00 Mb` (§26.2). And a figure whose x
 * is a **list** carries the list's names, one per value, and each tick is the
 * name of the thing standing at it — a sequence, under its own bar.
 *
 * A name is drawn only where the tick lands *on* one of the values, because a
 * tick at 3.5 names nothing: there is no sequence between the fourth and the
 * fifth. The axis is asked for whole-numbered ticks so that it usually does
 * land on one (`minInterval`), and a list too long to label thins itself out
 * rather than overprinting (`hideOverlap`) — which is the same bargain the
 * cis/trans square strikes at forty sequences.
 *
 * `undefined` for anything else, and the caller falls back to
 * {@link axisNumber}.
 */
function xFormatter(spec: XyFigureSpec): ((value: number) => string) | undefined {
  const binsize = spec.binsize
  if (binsize !== undefined) return (value: number) => fmt.bp(value * binsize)
  if (/\(bp\)/i.test(spec.xLabel ?? '')) return (value: number) => fmt.bp(value)
  const names = spec.xTicks
  if (names !== undefined) {
    return (value: number) => (Number.isInteger(value) ? (names[value] ?? '') : '')
  }
  return undefined
}

/**
 * How the ordinate is spelled, where the quantity on it has a unit.
 *
 * The one case, and it is `xFormatter`'s `(bp)` rule on the other axis: an axis
 * of **fractions** says so in its own name — `Share of the sequence’s contacts
 * (%)` — and is spelled by `fmt.pct`, because §26.2's *a fraction takes
 * `fmt.pct`* is about the surface rather than about the number. The values
 * behind it stay fractions, so the TSV a reader checks the figure against holds
 * `0.933` where the axis reads `93.3%`, exactly as a table of lengths holds
 * `1,531,933` under a summary reading `1.53 Mb`.
 *
 * The places are the tick's own: a tick at a whole per cent spends none of
 * them, one between two spends one. Four zeros after a decimal point is what
 * {@link axisNumber} exists to prevent, and `0.0%`, `25.0%`, `50.0%` is the
 * same complaint one order of magnitude up.
 */
function yFormatter(spec: XyFigureSpec): ((value: number) => string) | undefined {
  if (!/\(%\)/.test(spec.yLabel ?? '')) return undefined
  return (value: number) => {
    const per = value * 100
    return fmt.pct(value, Math.abs(per - Math.round(per)) < 1e-9 ? 0 : 1)
  }
}

function axisBase(theme: FigureTheme, style: FigureStyle, grid: boolean): ChartOption {
  return {
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { lineStyle: { color: theme.grid } },
    axisLabel: { color: theme.muted, fontSize: style.fontSize, fontFamily: theme.fontFamily },
    nameTextStyle: { color: theme.ink, fontSize: style.fontSize, fontFamily: theme.fontFamily },
    splitLine: { show: grid, lineStyle: { color: theme.grid, type: 'dashed' } },
  }
}

// ---------------------------------------------------------------------------
// The option
// ---------------------------------------------------------------------------

/** A domain as the zoom's own window, or the whole of the data. */
function zoomWindow(domain: [number, number] | null): ChartOption {
  return domain === null
    ? { start: 0, end: 100 }
    : { startValue: domain[0], endValue: domain[1] }
}

/**
 * The option an export draws: the screen's, less the hidden series' names in
 * its legend.
 *
 * On screen a hidden series stays in the legend, greyed, because that entry is
 * the control that brings it back. On paper there is nothing to click, and a
 * grey name beside no line is a series the figure says it has and does not show.
 */
export function paperOption(option: ChartOption): ChartOption {
  const legend = option['legend'] as
    | { show?: boolean; data?: unknown; selected?: Record<string, boolean> }
    | undefined
  if (legend === undefined || legend.show === false || !Array.isArray(legend.data) || legend.selected === undefined) {
    return option
  }
  const selected = legend.selected
  return {
    ...option,
    legend: { ...legend, data: legend.data.filter((name) => selected[String(name)] !== false) },
  }
}

/** How much room a legend down one side or along an edge takes, in pixels. */
const LEGEND_WIDTH = 132
const LEGEND_HEIGHT = 28

export function optionOf(
  spec: XyFigureSpec,
  style: FigureStyle,
  theme: FigureTheme,
): ChartOption {
  const shown = spec.series.map((series, index) => ({
    series,
    index,
    colour: seriesColour(series, index, style, theme),
    hidden: style.hidden.includes(series.id),
  }))

  // The chart hides a series through its legend's selection, so a legend that
  // is switched off still carries one: without it every hidden series is drawn.
  const names = shown.map((entry) => entry.series.name)
  const selected = Object.fromEntries(shown.map((entry) => [entry.series.name, !entry.hidden]))
  const legend =
    style.legend === 'none'
      ? { show: false, data: names, selected }
      : {
          show: true,
          type: 'scroll',
          data: names,
          selected,
          textStyle: { color: theme.ink, fontSize: style.fontSize, fontFamily: theme.fontFamily },
          ...(style.legend === 'right'
            ? { orient: 'vertical', right: 8, top: 'middle' }
            : style.legend === 'top'
              ? { orient: 'horizontal', top: 4, left: 'center' }
              : { orient: 'horizontal', bottom: 4, left: 'center' }),
        }

  const categorical = isCategorical(style.mark)
  // A box or a violin has no legend (`distributionOption`), so it keeps no room
  // for one either: a strip kept for a list that is never drawn is an empty
  // band down one side of the figure.
  const edge = categorical ? 'none' : style.legend
  const grid = {
    left: 8,
    right: edge === 'right' ? LEGEND_WIDTH : 16,
    top: edge === 'top' ? LEGEND_HEIGHT + 8 : 16,
    bottom: edge === 'bottom' ? LEGEND_HEIGHT + 8 : 8,
    // The modern spelling of `containLabel`, and stricter than it was: `'all'`
    // (the default under this mode) keeps the axis *names* inside the box too,
    // so a figure whose ordinate is called "contact probability" does not push
    // its own title off the left edge.
    outerBoundsMode: 'same',
  }

  const built = categorical
    ? distributionOption(spec, style, theme, shown)
    : xyOption(spec, style, theme, shown)

  return {
    backgroundColor: theme.background,
    animation: false,
    textStyle: { fontFamily: theme.fontFamily, fontSize: style.fontSize, color: theme.ink },
    ...(style.title === null || style.title === ''
      ? {}
      : {
          title: {
            text: style.title,
            left: 'center',
            top: 4,
            textStyle: {
              color: theme.ink,
              fontSize: style.fontSize + 4,
              fontFamily: theme.fontFamily,
            },
          },
        }),
    grid: {
      ...grid,
      top: style.title === null || style.title === '' ? grid.top : grid.top + style.fontSize + 12,
    },
    legend,
    tooltip: style.tooltip
      ? {
              trigger:
            categorical || style.mark === 'points' || style.mark === 'histogram'
              ? 'item'
              : 'axis',
          axisPointer: { type: 'cross', lineStyle: { color: theme.muted } },
          backgroundColor: theme.background,
          borderColor: theme.grid,
          textStyle: { color: theme.ink, fontSize: style.fontSize },
        }
      : { show: false },
    ...built,
  }
}

interface Entry {
  series: FigureSeries
  index: number
  colour: string
  hidden: boolean
}

/**
 * The bounds an axis needs so that its window can reach past the data.
 *
 * The window is the zoom's, and a zoom lives inside the axis: ECharts clamps a
 * window to the extent of what is drawn, so a window wider than the data — one
 * a task opens two figures on so that they share an ordinate, or a range typed
 * to match another figure — came out as the data's own. Where the window does
 * reach past the data, the axis is stretched to it on that side and no
 * further; where it does not, nothing is set and the axis fits the data as it
 * always has, so the zoom still answers for every window inside it. The labels
 * are the window's ends', printed where they are round and left off where not.
 */
function reachOf(
  domain: [number, number] | null,
  values: number[],
  log: boolean,
): { bounds: ChartOption; labels: ChartOption } {
  if (domain === null) return { bounds: {}, labels: {} }
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value) || (log && value <= 0)) continue
    if (value < low) low = value
    if (value > high) high = value
  }
  const below = low > high || domain[0] < low
  const above = low > high || domain[1] > high
  // An end of the window is a tick of the axis, labelled with the end itself —
  // which is wherever the window put it: `8.00215` after a box drawn by hand,
  // printed over the `10` beside it. So an end is labelled only when it is a
  // number a reader would write, inside the data or past it, and otherwise the
  // ticks inside it are.
  const span = domain[1] - domain[0]
  const bare = (end: number): boolean => !roundEnd(end, span, log)
  return {
    bounds: { ...(below ? { min: domain[0] } : {}), ...(above ? { max: domain[1] } : {}) },
    labels: {
      ...(bare(domain[0]) ? { showMinLabel: false } : {}),
      ...(bare(domain[1]) ? { showMaxLabel: false } : {}),
    },
  }
}

/**
 * Whether the end of a window is a number to print at the end of its axis: a
 * whole power of ten on a log axis, and on a linear one a whole tenth of the
 * decade its span is in — `10` or `-2` on a span of 40 or 6, `0.15` on a span
 * of 0.7, never `8.00215`.
 */
function roundEnd(end: number, span: number, log: boolean): boolean {
  if (log) {
    if (!(end > 0)) return false
    const power = Math.log10(end)
    return Math.abs(power - Math.round(power)) < 1e-9
  }
  if (!Number.isFinite(end) || !(span > 0)) return false
  const steps = end / 10 ** (Math.floor(Math.log10(span)) - 1)
  return Math.abs(steps - Math.round(steps)) < 1e-6 * Math.max(1, Math.abs(steps))
}

/** A figure of (x, y) pairs: lines, areas, steps, points, bars, histograms. */
function xyOption(
  spec: XyFigureSpec,
  style: FigureStyle,
  theme: FigureTheme,
  shown: Entry[],
): ChartOption {
  const histo = style.mark === 'histogram'
  const series: ChartOption[] = []

  // How solid a fill is has to know how many there are: sixteen chromosomes
  // filled at the opacity that suits one is a block of mud, and at the opacity
  // that suits sixteen a single series is barely there.
  const filled = Math.max(1, shown.filter((entry) => !entry.hidden).length)
  const fillOpacity = Math.max(0.07, 0.35 / Math.sqrt(filled))

  for (const entry of shown) {
    if (histo) {
      series.push(...histogramSeries(entry, style, Math.min(1, 0.9 / Math.sqrt(filled) + 0.1)))
      continue
    }
    // The band goes in first, so the line it belongs to is drawn over it.
    if (style.bands && entry.series.low !== undefined && entry.series.high !== undefined) {
      series.push(...bandSeries(entry, style))
    }
    series.push(lineSeries(entry, style, fillOpacity))
  }

  // A histogram's abscissa is the quantity itself and its ordinate is a count,
  // which is the one case where the figure's own axis names are not the axes.
  const xName = style.x.label ?? (histo ? spec.yLabel : spec.xLabel)
  const yName = style.y.label ?? (histo ? 'count' : spec.yLabel)
  // **Both axes need a formatter.** The ordinate had none, so a log-scaled P(s)
  // printed `0.0000001` and the slope beside it eight zeros — see
  // `units.axisNumber`. Each keeps the spelling its own quantity has — base
  // pairs, a list of names, per cent — and takes the magnitude spelling where it
  // has none. Neither on a histogram: there the abscissa is the *ordinate's*
  // quantity and the ordinate is a count, so the figure's own units are on
  // neither axis.
  const xSpelling = histo ? undefined : xFormatter(spec)
  const ySpelling = histo ? undefined : yFormatter(spec)
  // A histogram's axes are a quantity and a count, neither of them a series' x
  // or y, so its windows stay the zoom's alone.
  const drawn = shown.filter((entry) => !entry.hidden).map((entry) => entry.series)
  const none = { bounds: {}, labels: {} }
  const xReach = histo ? none : reachOf(style.x.domain, drawn.flatMap((line) => line.x), style.x.scale === 'log')
  const yReach = histo ? none : reachOf(style.y.domain, drawn.flatMap((line) => line.y), style.y.scale === 'log')

  return {
    xAxis: {
      type: style.x.scale === 'log' ? 'log' : 'value',
      name: xName,
      nameLocation: 'middle',
      nameGap: style.fontSize * 2.4,
      scale: true,
      // A named abscissa is a list, so the ticks belong on its members: whole
      // numbers, and as many of them as fit without one name printing over the
      // next.
      ...(spec.xTicks !== undefined && !histo ? { minInterval: 1 } : {}),
      ...xReach.bounds,
      ...axisBase(theme, style, style.x.grid),
      axisLabel: {
        ...(axisBase(theme, style, style.x.grid).axisLabel as object),
        // Labels that would print over each other are thinned rather than
        // overprinted: a list too long to name, and as much a distance spelled
        // `300.0 kb` once the type is raised for print.
        ...(!histo ? { hideOverlap: true } : {}),
        ...xReach.labels,
        formatter:
          xSpelling ?? ((value: number) => axisNumber(value, style.x.scale === 'log' ? 'log' : 'linear')),
      },
    },
    yAxis: {
      type: style.y.scale === 'log' ? 'log' : 'value',
      name: yName,
      nameLocation: 'middle',
      nameGap: style.fontSize * 4,
      // A bar is read as its own area, so its axis has to start at zero; a
      // curve is read as a shape, and a zero forced under a P(s) spends the
      // whole height on empty space. `scale: true` is ECharts for "fit the
      // data", which is right for everything but the bars.
      scale: style.mark !== 'histogram' && style.mark !== 'bars',
      ...yReach.bounds,
      ...axisBase(theme, style, style.y.grid),
      axisLabel: {
        ...(axisBase(theme, style, style.y.grid).axisLabel as object),
        ...(!histo ? { hideOverlap: true } : {}),
        ...yReach.labels,
        formatter:
          ySpelling ?? ((value: number) => axisNumber(value, style.y.scale === 'log' ? 'log' : 'linear')),
      },
    },
    // Wheel zooms the abscissa and drags pan it, which is the gesture a curve
    // is read with; the ordinate takes the same wheel with shift held, so a
    // reader can go after a shoulder in both directions without a mode.
    //
    // The window lives *here* rather than in the axes' `min`/`max`, and that is
    // the single-source rule this whole module is built on: a wheel gesture and
    // a number typed into the sidebar are then the same change to the same
    // place, and the export draws whichever of them happened last.
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        filterMode: 'none',
        ...zoomWindow(style.x.domain),
      },
      {
        type: 'inside',
        yAxisIndex: 0,
        zoomOnMouseWheel: 'shift',
        moveOnMouseMove: false,
        filterMode: 'none',
        ...zoomWindow(style.y.domain),
      },
    ],
    series,
  }
}

function lineSeries(entry: Entry, style: FigureStyle, fillOpacity: number): ChartOption {
  const mark = markOf(entry.series, style)
  const data = pairs(entry.series, style)
  const common = {
    id: entry.series.id,
    name: entry.series.name,
    data,
    color: entry.colour,
    emphasis: { focus: 'series' },
  }
  if (mark === 'points') {
    return {
      ...common,
      type: 'scatter',
      symbolSize: style.pointSize,
      itemStyle: { color: entry.colour, opacity: 0.85 },
    }
  }
  if (mark === 'bars') {
    return {
      ...common,
      type: 'bar',
      itemStyle: { color: entry.colour },
      barMaxWidth: 24,
      // Only here. A stack is a statement about bars standing on each other,
      // and the same field on a line or an area would silently redraw the upper
      // series as the sum of two quantities (`CurveSeries.stack`) — so a reader
      // who restyles a stacked bar chart to lines gets the two series it is of.
      ...(entry.series.stack === undefined ? {} : { stack: entry.series.stack }),
    }
  }
  const area = mark === 'area' || style.fillArea
  return {
    ...common,
    type: 'line',
    step: mark === 'step' ? 'middle' : false,
    smooth: style.smooth,
    symbol: 'none',
    lineStyle: { width: style.lineWidth, color: entry.colour },
    ...(area ? { areaStyle: { color: entry.colour, opacity: fillOpacity, origin: 'start' } } : {}),
    // A gap is a gap: a bin with no value is not a line through zero.
    connectNulls: false,
    // Largest-triangle-three-buckets: a million-point profile is drawn as the
    // thousand points that keep its shape, which is the same reduction the
    // painter this replaces did by hand.
    sampling: 'lttb',
  }
}

/**
 * The task's own band, as two stacked lines with the space between them filled.
 *
 * The lower edge is invisible and the upper one carries the fill, which is how
 * a stacked pair draws a ribbon; both are silent and neither is in the legend,
 * because a band is part of the series it belongs to rather than a series of
 * its own.
 */
function bandSeries(entry: Entry, style: FigureStyle): ChartOption[] {
  const low = entry.series.low as number[]
  const high = entry.series.high as number[]
  const yLog = style.y.scale === 'log'
  const xLog = style.x.scale === 'log'
  const base: Array<[number, number] | null> = []
  const span: Array<[number, number] | null> = []
  for (let i = 0; i < low.length; i++) {
    const x = forAxis(entry.series.x[i] ?? i, xLog)
    const lo = forAxis(low[i], yLog)
    const hi = forAxis(high[i], yLog)
    if (x === null || lo === null || hi === null) {
      base.push(null)
      span.push(null)
      continue
    }
    base.push([x, lo])
    span.push([x, hi - lo])
  }
  const stack = `band-${entry.series.id}`
  const quiet = {
    type: 'line',
    stack,
    symbol: 'none',
    silent: true,
    legendHoverLink: false,
    lineStyle: { opacity: 0 },
    tooltip: { show: false },
  }
  return [
    { ...quiet, id: `${stack}-low`, name: `${entry.series.name} ${stack}-low`, data: base },
    {
      ...quiet,
      id: `${stack}-high`,
      name: `${entry.series.name} ${stack}-high`,
      data: span,
      areaStyle: { color: entry.colour, opacity: 0.18 },
    },
  ]
}

/** One series as bars over its own bins. */
function histogramSeries(entry: Entry, style: FigureStyle, opacity: number): ChartOption[] {
  const { edges, counts } = histogram(entry.series.y, style.bins)
  if (counts.length === 0) return []
  const data = counts.map((count, index) => [(edges[index] + edges[index + 1]) / 2, count])
  return [
    {
      id: entry.series.id,
      name: entry.series.name,
      type: 'bar',
      data,
      color: entry.colour,
      // Overlaid rather than side by side, at part opacity: two distributions
      // compared are two shapes over the same axis, and splitting each bin in
      // two moves both of them half a bin apart from where they are.
      barGap: '-100%',
      barCategoryGap: '1%',
      itemStyle: { color: entry.colour, opacity },
    },
  ]
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/**
 * A box or a violin: the series become categories and only `y` is read.
 *
 * `x` is dropped on purpose. These marks summarise a sample, and the sample has
 * no abscissa — drawing one would put an axis on the figure that says something
 * untrue about what was measured.
 */
function distributionOption(
  spec: XyFigureSpec,
  style: FigureStyle,
  theme: FigureTheme,
  shown: Entry[],
): ChartOption {
  const visible = shown.filter((entry) => !entry.hidden)
  const categories = visible.map((entry) => entry.series.name)
  const yName = style.y.label ?? spec.yLabel

  const series: ChartOption[] =
    style.mark === 'box'
      ? boxSeries(visible, style, theme)
      : violinSeries(visible, style, theme)

  if (style.jitter) {
    series.push({
      id: 'points',
      name: 'points',
      type: 'scatter',
      symbolSize: Math.max(2, style.pointSize / 2),
      itemStyle: { color: theme.muted, opacity: 0.4 },
      silent: true,
      data: visible.flatMap((entry, at) =>
        sorted(entry.series.y).map((value) => [at, value]),
      ),
    })
  }

  return {
    // No legend: the categories are named on the abscissa, and a second list of
    // the same names — whose swatches would have to agree with shapes the
    // renderer colours itself — is a place for the two to disagree.
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: categories,
      ...axisBase(theme, style, false),
      axisTick: { show: false },
    },
    yAxis: {
      type: style.y.scale === 'log' ? 'log' : 'value',
      name: yName,
      nameLocation: 'middle',
      nameGap: style.fontSize * 4,
      scale: true,
      ...(style.y.domain === null ? {} : { min: style.y.domain[0], max: style.y.domain[1] }),
      ...axisBase(theme, style, style.y.grid),
      axisLabel: {
        ...(axisBase(theme, style, style.y.grid).axisLabel as object),
        formatter: (value: number) => axisNumber(value, style.y.scale === 'log' ? 'log' : 'linear'),
      },
    },
    series,
  }
}

function boxSeries(visible: Entry[], style: FigureStyle, theme: FigureTheme): ChartOption[] {
  const boxes = visible.map((entry) => boxSummary(entry.series.y))
  return [
    {
      id: 'box',
      name: 'box',
      type: 'boxplot',
      data: boxes.map((box, at) => ({
        value: [box.low, box.q1, box.median, box.q3, box.high],
        itemStyle: { color: visible[at].colour, borderColor: theme.ink, opacity: 0.55 },
      })),
      boxWidth: [10, 48],
    },
    {
      id: 'outliers',
      name: 'outliers',
      type: 'scatter',
      symbolSize: Math.max(3, style.pointSize / 1.5),
      itemStyle: { color: theme.muted },
      silent: true,
      data: boxes.flatMap((box, at) => box.outliers.map((value) => [at, value])),
    },
  ]
}

/**
 * A violin, drawn as a custom shape.
 *
 * ECharts has no violin, and the alternatives are worse than writing the
 * polygon: a mirrored pair of area series needs a numeric axis the categories
 * are not on, and a box with a density line beside it is two pictures. The
 * density itself is `stats.density`, so the shape is a documented estimator
 * rather than whatever a renderer happened to smooth.
 *
 * Every violin on one figure is scaled by the *same* peak, because two violins
 * side by side each normalised to their own width say the two samples are
 * equally concentrated, which is exactly the comparison they are there to make.
 */
function violinSeries(visible: Entry[], style: FigureStyle, theme: FigureTheme): ChartOption[] {
  const log = style.y.scale === 'log'
  const shapes = visible.map((entry) => violinShape(entry.series.y, log))
  const peak = Math.max(0, ...shapes.flatMap((shape) => shape.y))
  if (!(peak > 0)) return boxSeries(visible, style, theme)

  return visible.map((entry, at) => ({
    id: `violin-${entry.series.id}`,
    name: entry.series.name,
    type: 'custom',
    color: entry.colour,
    itemStyle: { color: entry.colour },
    // The density's own support, one datum per sample — which is what makes the
    // *axis* fit the violins. One datum would have left the ordinate sized to
    // sixteen medians with the shapes drawn far outside it, and a datum at zero
    // would have been filtered out by a log axis before `renderItem` ever ran.
    data: shapes[at].at.map((value) => [at, value]),
    // Cut at the grid. The support runs three bandwidths past the sample, and an
    // ordinate the task or the reader set cuts through it; a custom series is
    // not clipped by default, so the tail was drawn on over the category names.
    clip: true,
    renderItem: (
      params: { dataIndex: number },
      api: {
        coord: (point: [number, number]) => [number, number]
        size?: (point: [number, number]) => [number, number]
      },
    ) => {
      // One shape per series, drawn once; the rest of the data is there to be
      // measured by the axis, not to be drawn.
      if (params.dataIndex !== 0) return { type: 'group', children: [] }
      const shape = shapes[at]
      if (shape.at.length === 0) return { type: 'group', children: [] }
      const size = api.size?.([1, 0]) ?? [24, 0]
      const half = Math.min(48, size[0] * 0.42)
      const points: Array<[number, number]> = []
      for (let i = 0; i < shape.at.length; i++) {
        const [cx, cy] = api.coord([at, shape.at[i]])
        points.push([cx - (shape.y[i] / peak) * half, cy])
      }
      for (let i = shape.at.length - 1; i >= 0; i--) {
        const [cx, cy] = api.coord([at, shape.at[i]])
        points.push([cx + (shape.y[i] / peak) * half, cy])
      }
      return {
        type: 'polygon',
        shape: { points },
        style: {
          fill: entry.colour,
          opacity: 0.55,
          stroke: theme.ink,
          lineWidth: style.lineWidth / 2,
        },
      }
    },
    encode: { x: 0, y: 1 },
  }))
}

/**
 * A violin's outline, in the units the axis is in.
 *
 * On a log ordinate the density is estimated on `log10` of the values and
 * mapped back, which is both what R does under `scale_y_log10` and the only
 * thing that works: a Gaussian kernel on the raw values puts its support three
 * bandwidths below the smallest one, which on a log axis is a negative number
 * the axis cannot hold — and a shape whose points are all rejected is an empty
 * plot with its axes drawn neatly around it.
 */
function violinShape(values: readonly number[], log: boolean): { at: number[]; y: number[] } {
  if (!log) return density(values)
  const logs = sorted(values)
    .filter((value) => value > 0)
    .map((value) => Math.log10(value))
  const shape = density(logs)
  return { at: shape.at.map((value) => 10 ** value), y: shape.y }
}
