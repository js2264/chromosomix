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
import { tipHead, tipRow } from './tooltip'

/** The colours and the type a figure borrows from the page it is drawn on. */
export interface FigureTheme {
  ink: string
  muted: string
  grid: string
  background: string
  /** The categorical palette, in order. */
  series: string[]
  fontFamily: string
  /**
   * How wide a run of text is, in pixels, at a size in the figure's type —
   * what the room a legend takes is measured with. Absent where there is no
   * page to measure on, and then estimated (see {@link widthOf}).
   */
  measure?(text: string, size: number): number
}

/**
 * The width of a run of text in the figure's type: measured where the theme can
 * measure, and otherwise six tenths of the size a character, which is about
 * what a proportional sans-serif averages over a file name.
 */
function widthOf(theme: FigureTheme, text: string, size: number): number {
  return theme.measure?.(text, size) ?? text.length * size * 0.6
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

// ---------------------------------------------------------------------------
// The pointer
// ---------------------------------------------------------------------------

/**
 * The part of the library's tooltip parameters a formatter reads.
 *
 * Written out here rather than imported, for the reason {@link ChartOption} is:
 * this module does not drag the library's types in.
 */
interface TipParams {
  seriesName?: string
  seriesType?: string
  /** The category under the pointer: for a box, the series it summarises. */
  name?: string
  value?: unknown
  color?: unknown
  /** The abscissa under the pointer, on an `axis` trigger. */
  axisValue?: unknown
}

/** The five numbers a box is drawn from, top down, as the eye reads it. */
const BOX_ROWS = ['high', 'upper quartile', 'median', 'lower quartile', 'low'] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The ordinate of a datum, which is a `[x, y]` pair everywhere this draws one. */
function ordinateOf(value: unknown): number | null {
  const y = Array.isArray(value) ? (value as unknown[])[1] : value
  return isFiniteNumber(y) ? y : null
}

/**
 * What the pointer says over an xy figure.
 *
 * Built here rather than left to the library, for the two reasons
 * `figures/tooltip.ts` gives: the names in it are the file's own, and the
 * library's markup styles itself with attributes the site's policy refuses.
 * Every string reaches the page through that module, so this decides only
 * *what* is said:
 *
 * - **Along a curve, the abscissa first**, then a row per series under the
 *   pointer. A sequence's name over its bar and `84.3 kb` along a P(s), where
 *   the library printed the raw number under the pointer — `6.00` for the
 *   seventh sequence, `84,281.00` for a separation.
 * - **Each coordinate as its own axis spells it**: base pairs, a list's names,
 *   per cent, and otherwise `axisNumber` on the axis's own scale — so a P(s)
 *   reads `2.24e-7` under ticks of `1e-7` rather than `0.000000224`, and a
 *   reader matching the number to the picture is never translating between two
 *   notations.
 * - **Over a point, a histogram's bar, a box or a violin**, the series first
 *   and then what the mark stands for: the pair a point is, the count a bar
 *   holds, the five numbers a box is drawn from. A violin is its own answer,
 *   and names itself.
 */
function tooltipOf(
  spec: XyFigureSpec,
  style: FigureStyle,
): (params: TipParams | TipParams[]) => string {
  const histo = style.mark === 'histogram'
  const xScale = style.x.scale === 'log' ? 'log' : 'linear'
  const yScale = style.y.scale === 'log' ? 'log' : 'linear'
  // A histogram's abscissa is the ordinate's quantity and its ordinate a count,
  // so neither keeps the figure's own spelling — the rule its axes follow.
  const xSpelling = histo ? undefined : xFormatter(spec)
  const ySpelling = histo ? undefined : yFormatter(spec)
  // A name is drawn only where the pointer stands *on* a member of the list;
  // between two, the number is still an answer.
  const spellX = (value: number): string => {
    const spelled = xSpelling?.(value) ?? ''
    return spelled !== '' ? spelled : axisNumber(value, xScale)
  }
  const spellY = ySpelling ?? ((value: number) => axisNumber(value, yScale))

  return (params) => {
    if (Array.isArray(params)) {
      const at = params[0]
      if (at === undefined) return ''
      const rows = params.flatMap((one) => {
        const y = ordinateOf(one.value)
        return y === null ? [] : [tipRow(one.color, one.seriesName ?? '', spellY(y))]
      })
      return tipHead(isFiniteNumber(at.axisValue) ? spellX(at.axisValue) : '') + rows.join('')
    }
    if (params.seriesType === 'boxplot') {
      // The library may put the category's index in front of the five, so the
      // box is the last five; the header is the category, which is the series
      // the box summarises — the boxplot series itself is called `box`.
      const box = Array.isArray(params.value) ? (params.value as unknown[]).slice(-5) : []
      const head = tipHead(params.name ?? '')
      if (box.length !== 5 || !box.every(isFiniteNumber)) return head
      // Spelled as the box's own ordinate is (`distributionOption`), which
      // knows no unit: it is the sample's axis, not the curve's.
      const down = [...box].reverse()
      return head + BOX_ROWS.map((label, at) => tipRow(null, label, axisNumber(down[at], yScale))).join('')
    }
    const head = tipHead(params.seriesName ?? '')
    if (params.seriesType === 'custom') return head
    const pair = Array.isArray(params.value) ? (params.value as unknown[]) : []
    const [x, y] = pair
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return head
    return head + (histo ? tipRow(params.color, spellX(x), fmt.int(y)) : tipRow(params.color, spellX(x), spellY(y)))
  }
}

/**
 * An axis, in the frame's ink.
 *
 * **Every plot is drawn in a frame** (§18.13): a box in the ink, all four sides,
 * which is the grid's own border ({@link frameOf}). The axes are two of its
 * sides, so their line and ticks are the same ink — a grey rule under a black
 * one reads as a second line — and they stay on the frame whatever the other
 * axis holds: the library's default puts an axis through the other's zero,
 * which across a profile that changes sign is a line through the middle of
 * the picture carrying the ticks with it. The gridlines are solid and thin —
 * every line in a plot is solid — and stop short of the two ends of an axis,
 * where the frame is: a dashed grey line drawn over it was the dotted grey
 * border there was before the frame.
 */
function axisBase(theme: FigureTheme, style: FigureStyle, grid: boolean): ChartOption {
  return {
    axisLine: { onZero: false, lineStyle: { color: theme.ink, width: FRAME_WIDTH } },
    axisTick: { lineStyle: { color: theme.ink, width: FRAME_WIDTH } },
    axisLabel: { color: theme.muted, fontSize: style.fontSize, fontFamily: theme.fontFamily },
    nameTextStyle: { color: theme.ink, fontSize: style.fontSize, fontFamily: theme.fontFamily },
    splitLine: {
      show: grid,
      showMinLine: false,
      showMaxLine: false,
      lineStyle: { color: theme.grid, type: 'solid', width: GRID_WIDTH },
    },
  }
}

/** The frame's line, in CSS pixels: the painter's (`analysisPlots.FRAME_WIDTH`). */
const FRAME_WIDTH = 1

/**
 * A gridline, in CSS pixels: half the frame's, a guide for the eye rather than
 * a mark of anything — and the painter's (`analysisPlots.GRID_WIDTH`).
 */
const GRID_WIDTH = 0.5

/**
 * The frame round the plot: the grid's border, in the ink, over the data.
 *
 * Over rather than under, as the painter draws its own last: it closes over the
 * ends of a curve that starts on it rather than being painted through by them.
 * The grid's rectangle ignores the pointer, so nothing under it stops
 * answering; and its fill is clear, so over is only ever the line.
 */
export function frameOf(theme: FigureTheme): ChartOption {
  return {
    show: true,
    backgroundColor: 'transparent',
    borderColor: theme.ink,
    borderWidth: FRAME_WIDTH,
    // Above the series, which sit at the library's 2.
    z: 3,
  }
}

/**
 * The room an axis fitted to its data keeps at each end, as a share of the
 * span, in the axis's own terms — decades on a log axis.
 *
 * A twentieth, which is what matplotlib and ggplot2 both keep: a maximum drawn
 * on the frame is a maximum nobody can see. It used to be the library's *nice*
 * extent, which on a log axis is a whole decade at each end — a P(s) from 5 kb
 * to 2 Mb drawn from 1 kb to 10 Mb, with most of a decade empty on either side.
 */
const FIT_ROOM = 0.05

/**
 * The extent an axis fits its data to: the values' own, with `room` of the span
 * at each end (in decades on a log axis). Non-finite values are skipped, and on
 * a log axis anything at or below zero, which it has no place for.
 *
 * `null` where there is nothing to fit — no value, or one — and the library's
 * own fit then stands.
 */
export function fitOf(values: Iterable<number>, log: boolean, room: number): [number, number] | null {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value) || (log && value <= 0)) continue
    if (value < low) low = value
    if (value > high) high = value
  }
  if (!(low < high)) return null
  // Exact where there is no room: `10 ** Math.log10(5000)` is a hair under
  // 5000, which would put the first point a hair outside the axis.
  if (!(room > 0)) return [low, high]
  if (log) {
    const from = Math.log10(low)
    const to = Math.log10(high)
    const pad = (to - from) * room
    return [10 ** (from - pad), 10 ** (to + pad)]
  }
  const pad = (high - low) * room
  return [low - pad, high + pad]
}

/**
 * The extent an xy figure's axis fits its data to, over the series that are
 * drawn — `null` where the library's own fit stands.
 *
 * - **Along a curve, the abscissa runs from the first sample to the last**, with
 *   no room: a P(s) runs from its first separation to its last, and those ends
 *   are the data's (the painter's curve is drawn the same way, `padSpan`).
 *   **Points** keep the room on it, because a marker centred on the frame is
 *   half a marker.
 * - **The ordinate keeps the room**, and takes in a band where one is drawn —
 *   and under a box or a violin, everything they draw: the whiskers and the
 *   outliers, a violin's whole support, the points beside them.
 * - **A histogram's abscissa runs from its first bin's edge to its last**, with
 *   the room; its ordinate is a count from zero, the library's.
 * - **Bars keep the library's fit**: a bar's ordinate starts at zero, and its
 *   abscissa has to hold the bars' widths, which the library measures and this
 *   does not. So does a box's or a violin's abscissa, which is the series'
 *   names.
 */
export function figureFit(spec: XyFigureSpec, style: FigureStyle, which: 'x' | 'y'): [number, number] | null {
  const drawn = spec.series.filter((series) => !style.hidden.includes(series.id))
  if (style.mark === 'histogram') {
    if (which === 'y') return null
    // The bins `histogramSeries` draws, from the same call.
    const edges = drawn.flatMap((series) => histogram(series.y, style.bins).edges)
    return fitOf(edges, style.x.scale === 'log', FIT_ROOM)
  }
  if (isCategorical(style.mark)) {
    return which === 'x' ? null : fitOf(distributionOrdinates(drawn, style), style.y.scale === 'log', FIT_ROOM)
  }
  const marks = drawn.map((series) => markOf(series, style))
  if (marks.includes('bars') || (which === 'y' && style.mark === 'bars')) return null
  const xLog = style.x.scale === 'log'
  const yLog = style.y.scale === 'log'
  if (which === 'x') {
    // The points that are drawn, as `pairs` and `bandSeries` draw them: a value
    // a log axis has no place for is a gap on both axes.
    const xs: number[] = []
    for (const series of drawn) {
      const banded = style.bands && series.low !== undefined && series.high !== undefined
      for (let i = 0; i < series.y.length; i++) {
        const x = forAxis(series.x[i] ?? i, xLog)
        if (x === null) continue
        const drawnHere =
          forAxis(series.y[i], yLog) !== null ||
          (banded && forAxis((series.low as number[])[i], yLog) !== null && forAxis((series.high as number[])[i], yLog) !== null)
        if (drawnHere) xs.push(x)
      }
    }
    return fitOf(xs, xLog, marks.includes('points') ? FIT_ROOM : 0)
  }
  // The ordinate fits **what is drawn in the abscissa's window**: a P(s) a
  // task opens from 4 kb would otherwise keep room above it for the first
  // separations, which are off the picture to its left. A line crossing an
  // edge of the window is drawn up to the frame, so it counts at the frame.
  const window = style.x.domain
  const ys: number[] = []
  for (const series of drawn) {
    const lines = markOf(series, style) !== 'points'
    const runs: Array<readonly number[]> = [series.y]
    if (style.bands && series.low !== undefined && series.high !== undefined) runs.push(series.low, series.high)
    for (const run of runs) seen(series, run, window, lines, xLog, yLog, ys)
  }
  return fitOf(ys, yLog, FIT_ROOM)
}

/**
 * The ordinates one run of a series puts inside a window of the abscissa —
 * every value whose abscissa is in it, and where `lines` joins the samples,
 * the value at the frame of each segment that crosses one of its edges,
 * interpolated as the axes draw it (in decades on a log axis). A value a log
 * axis has no place for breaks the line there, as it does on the picture.
 */
function seen(
  series: FigureSeries,
  run: readonly number[],
  window: [number, number] | null,
  lines: boolean,
  xLog: boolean,
  yLog: boolean,
  out: number[],
): void {
  const space = (value: number, log: boolean): number => (log ? Math.log10(value) : value)
  let before: { x: number; y: number } | null = null
  for (let i = 0; i < run.length; i++) {
    const x = forAxis(series.x[i] ?? i, xLog)
    const y = forAxis(run[i], yLog)
    if (x === null || y === null) {
      before = null
      continue
    }
    if (window === null || (x >= window[0] && x <= window[1])) out.push(y)
    if (window !== null && lines && before !== null) {
      for (const edge of window) {
        if ((before.x - edge) * (x - edge) >= 0) continue
        const at = (space(edge, xLog) - space(before.x, xLog)) / (space(x, xLog) - space(before.x, xLog))
        const value = space(before.y, yLog) + at * (space(y, yLog) - space(before.y, yLog))
        out.push(yLog ? 10 ** value : value)
      }
    }
    before = { x, y }
  }
}

/**
 * The ticks of a log axis spanning `[low, high]`, where the library's own are
 * wrong — `null` where they stand: one a decade, from three decades inside up
 * to ten.
 *
 * - **Ten decades or more**: the library labels every tenth one, which on an
 *   axis of twelve is one label; and handed a step, it counts it from the
 *   axis's end, which on a fitted axis is no decade at all (`1.2e-10`,
 *   `1.2e-8`). So every few decades, about six to the axis, each a whole power
 *   of ten and a multiple of the step.
 * - **Fewer than three decades inside**: the library labels only decades, so a
 *   window zoomed to 221 kb – 783 kb had no label at all. So 1, 2 and 5 of
 *   each decade, then every digit, then — inside a single step of those — an
 *   ordinary linear ladder, whichever first puts three ticks in the window.
 */
export function logTicks(low: number, high: number): number[] | null {
  if (!(low > 0) || !(high > low)) return null
  const from = Math.log10(low)
  const to = Math.log10(high)
  if (to - from >= 10) {
    const step = Math.ceil((to - from) / 6)
    const out: number[] = []
    for (let power = Math.ceil(from / step) * step; power <= to + 1e-9; power += step) out.push(10 ** power)
    return out
  }
  if (Math.floor(to + 1e-9) - Math.ceil(from - 1e-9) + 1 >= 3) return null
  const inside = (value: number): boolean => value >= low * (1 - 1e-9) && value <= high * (1 + 1e-9)
  for (const digits of [[1, 2, 5], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
    const out: number[] = []
    for (let power = Math.floor(from); power <= Math.ceil(to); power++) {
      for (const digit of digits) {
        // A digit times a power of ten, written so: `3 * 1e-5` is a hair off.
        const value = Number(`${digit}e${power}`)
        if (inside(value)) out.push(value)
      }
    }
    if (out.length >= 3) return out
  }
  const raw = (high - low) / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / magnitude
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * magnitude
  const out: number[] = []
  for (let k = Math.ceil(low / step); k * step <= high * (1 + 1e-12); k++) out.push(Number((k * step).toPrecision(12)))
  return out
}

/**
 * An xy figure's axis as drawn: its bounds and which of its end labels print
 * ({@link reachOf}), from the window the style holds or the fit. What the chart
 * rebuilds an axis from, and what it sets the ordinate to alone when a wheel or
 * a drag moves the abscissa's window under an ordinate on auto.
 */
export function axisReach(
  spec: XyFigureSpec,
  style: FigureStyle,
  which: 'x' | 'y',
): { bounds: ChartOption; labels: ChartOption; ticks?: number[] } {
  const histo = style.mark === 'histogram'
  // A histogram's count is the library's, from zero, and its window the zoom's.
  if (histo && which === 'y') return { bounds: {}, labels: {} }
  const log = style[which].scale === 'log'
  const drawn = spec.series.filter((series) => !style.hidden.includes(series.id))
  const values = drawn.flatMap((series) =>
    histo ? histogram(series.y, style.bins).edges : which === 'x' ? series.x : series.y,
  )
  const reach = reachOf(style[which].domain, figureFit(spec, style, which), values, log)
  if (!log) return reach
  // The ticks are the shown window's: the window where there is one, else the
  // axis.
  const [low, high] = style[which].domain ?? [reach.bounds['min'], reach.bounds['max']]
  const ticks = typeof low === 'number' && typeof high === 'number' ? logTicks(low, high) : null
  return ticks === null ? reach : { ...reach, labels: tickedEnds(reach.labels, ticks, low, high), ticks }
}

/**
 * An axis's end labels, where its ticks are given rather than the library's.
 *
 * The library hides the first and the last of the *given* ticks, wherever they
 * fall, not the labels at the axis's ends: `showMinLabel: false`, meant for an
 * end at `10.85 kb`, took the 20 kb tick off a loop spectrum, its grid line
 * with it. So each stays only where that first or last tick is the end itself.
 */
function tickedEnds(labels: ChartOption, ticks: readonly number[], low: unknown, high: unknown): ChartOption {
  const at = (tick: number | undefined, end: unknown): boolean =>
    tick !== undefined &&
    typeof end === 'number' &&
    Math.abs(tick - end) <= 1e-9 * Math.max(Math.abs(tick), Math.abs(end))
  const out: ChartOption = { ...labels }
  if (!at(ticks[0], low)) delete out['showMinLabel']
  if (!at(ticks[ticks.length - 1], high)) delete out['showMaxLabel']
  return out
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

/** How much room a legend along an edge takes, in pixels. */
const LEGEND_HEIGHT = 28

/**
 * A legend down the right, as the library lays one out, in pixels: its distance
 * from the edge, its padding, a swatch, and the gap the library leaves between
 * a swatch and its name. Stated, so that the room kept for it is the room it
 * takes.
 */
const SIDE_LEGEND = { right: 8, padding: 5, icon: 25, iconGap: 5 } as const

/**
 * The most of a figure's width a legend down its right may take, the plot's
 * room and the names' together; a name too long for its share goes onto a
 * second line rather than over the plot.
 */
const SIDE_LEGEND_SHARE = 0.35

/** The narrowest a legend's names are wrapped to, however narrow the figure. */
const SIDE_LEGEND_MIN_TEXT = 72

/**
 * A name over as many lines as `width` allows, broken **after** the characters a
 * file's or a sample's name is built from — `.`, `-`, `_`, `:`, `/`, `,`, a
 * space — so `T4dNDD-infection.10min.mcool::5000` goes onto two lines as
 * `T4dNDD-infection.10min.` and `mcool::5000`. The library's own wrap breaks
 * only at a space or a few marks of punctuation, and a name with none of them
 * it cuts at whichever letter fills the line. A run with no break in it longer
 * than a line is cut by the letter, as a last resort.
 */
export function wrapName(name: string, width: number, measure: (text: string) => number): string[] {
  if (measure(name) <= width) return [name]
  const parts: string[] = []
  let part = ''
  for (const ch of name) {
    part += ch
    if ('.-_:/, '.includes(ch)) {
      parts.push(part)
      part = ''
    }
  }
  if (part !== '') parts.push(part)
  const lines: string[] = []
  let line = ''
  const flush = (): void => {
    const trimmed = line.trimEnd()
    if (trimmed !== '') lines.push(trimmed)
    line = ''
  }
  for (const piece of parts) {
    if (line !== '' && measure(line + piece) > width) flush()
    if (measure(piece) <= width) {
      line += piece
      continue
    }
    for (const ch of piece) {
      if (line !== '' && measure(line + ch) > width) flush()
      line += ch
    }
  }
  flush()
  return lines
}

/**
 * The legend down the right of a figure, and the room the plot leaves it.
 *
 * **Beside the plot, never over it.** The room used to be a fixed 132 pixels,
 * and a name longer than that — a file name with its resolution on, which is
 * what a series is called — ran the legend out over the curves. So the names
 * are measured, the room is what the longest takes plus the swatch, the
 * padding and a gap, and the plot is drawn in what is left. Past
 * {@link SIDE_LEGEND_SHARE} of the figure's width a name goes onto more lines
 * ({@link wrapName}) rather than taking the plot's room: in a folded drawer a
 * legend that kept every name on one line would leave the curves a sliver.
 * Without a box to share — a caller that does not say how big the figure is —
 * no name is wrapped.
 */
function sideLegend(
  names: readonly string[],
  style: FigureStyle,
  theme: FigureTheme,
  plot: { width: number; height: number } | undefined,
): { room: number; formatter: (name: string) => string } {
  const measure = (text: string): number => widthOf(theme, text, style.fontSize)
  const frame = SIDE_LEGEND.right + 2 * SIDE_LEGEND.padding + SIDE_LEGEND.icon + SIDE_LEGEND.iconGap
  const gap = style.fontSize
  const cap =
    plot === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(SIDE_LEGEND_MIN_TEXT, plot.width * SIDE_LEGEND_SHARE - frame - gap)
  const wrapped = new Map(names.map((name) => [name, wrapName(name, cap, measure)]))
  let widest = 0
  for (const lines of wrapped.values()) for (const line of lines) widest = Math.max(widest, measure(line))
  return {
    room: Math.ceil(frame + widest + gap),
    formatter: (name: string) => (wrapped.get(name) ?? [name]).join('\n'),
  }
}

export function optionOf(
  spec: XyFigureSpec,
  style: FigureStyle,
  theme: FigureTheme,
  /**
   * How big the figure is drawn, where the caller knows: what a legend down
   * the right may take of it ({@link sideLegend}). The plot is otherwise four
   * insets and stretches to whatever it is put in.
   */
  plot?: { width: number; height: number },
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
  const categorical = isCategorical(style.mark)
  // A box or a violin has no legend (`distributionOption`), so it keeps no room
  // for one either: a strip kept for a list that is never drawn is an empty
  // band down one side of the figure.
  const edge = categorical ? 'none' : style.legend
  const side = edge === 'right' ? sideLegend(names, style, theme, plot) : null
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
            ? {
                orient: 'vertical',
                right: SIDE_LEGEND.right,
                top: 'middle',
                padding: SIDE_LEGEND.padding,
                itemWidth: SIDE_LEGEND.icon,
                ...(side === null ? {} : { formatter: side.formatter }),
              }
            : style.legend === 'top'
              ? { orient: 'horizontal', top: 4, left: 'center' }
              : { orient: 'horizontal', bottom: 4, left: 'center' }),
        }

  const grid = {
    ...frameOf(theme),
    left: 8,
    right: side === null ? 16 : side.room,
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
          // Solid, as every line in a plot is: the library draws a cross dashed.
          axisPointer: {
            type: 'cross',
            lineStyle: { color: theme.muted, type: 'solid' },
            crossStyle: { color: theme.muted, type: 'solid' },
          },
          backgroundColor: theme.background,
          borderColor: theme.grid,
          textStyle: { color: theme.ink, fontSize: style.fontSize },
          // Never the library's own markup, which styles itself with `style=`
          // attributes the site's policy refuses: see {@link tooltipOf}.
          formatter: tooltipOf(spec, style),
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
 * The bounds an axis is drawn between, and which of its two end labels print.
 *
 * **Fitted, the axis is the fit** ({@link figureFit}): the data's extent and
 * the room kept round it, set as the axis's bounds — where it used to be the
 * library's *nice* extent, a whole decade past the data at each end of a log
 * axis. Its ends are rarely round, and an end is a tick of the axis labelled
 * with the end itself, so an end that is not round is left bare and the ticks
 * inside it carry the axis.
 *
 * **Under a window, the axis still holds the fit**, so the zoom answers for
 * every window inside it, and is stretched past it where the window reaches
 * further — a window a task opens two figures on so that they share an
 * ordinate, or a range typed to match another figure: the zoom lives inside the
 * axis, and ECharts clamps a window to the axis's extent. The labels are then
 * the window's ends', printed where they are round and left off where not.
 *
 * Where there is no fit — a histogram, bars — the axis is the library's, and
 * stretched to a window only where the window reaches past the data.
 */
function reachOf(
  domain: [number, number] | null,
  fit: [number, number] | null,
  values: number[],
  log: boolean,
): { bounds: ChartOption; labels: ChartOption } {
  const ends = (pair: [number, number]): ChartOption => {
    const span = pair[1] - pair[0]
    return {
      ...(roundEnd(pair[0], span, log) ? {} : { showMinLabel: false }),
      ...(roundEnd(pair[1], span, log) ? {} : { showMaxLabel: false }),
    }
  }
  if (domain === null) {
    return fit === null ? { bounds: {}, labels: {} } : { bounds: { min: fit[0], max: fit[1] }, labels: ends(fit) }
  }
  if (fit !== null) {
    return {
      bounds: { min: Math.min(fit[0], domain[0]), max: Math.max(fit[1], domain[1]) },
      labels: ends(domain),
    }
  }
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
  return {
    bounds: { ...(below ? { min: domain[0] } : {}), ...(above ? { max: domain[1] } : {}) },
    labels: ends(domain),
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
  //
  // **Text, not markup**, and that is why these two are not escaped where the
  // tooltip's strings are (`figures/tooltip.ts`): a tick label is drawn as an
  // SVG `<text>` whose content is set as text, so a sequence's name reaches the
  // page inert — and escaped, `a<b` would be printed as `a&lt;b`.
  const xSpelling = histo ? undefined : xFormatter(spec)
  const ySpelling = histo ? undefined : yFormatter(spec)
  // A histogram's axes are a quantity and a count, neither of them a series' x
  // or y, so its windows stay the zoom's alone.
  const xReach = axisReach(spec, style, 'x')
  const yReach = axisReach(spec, style, 'y')

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
      // A histogram's fit already holds its bars, edge to edge (`figureFit`),
      // and the library would widen it again by most of a bar each side.
      ...(histo ? { containShape: false } : {}),
      ...xReach.bounds,
      ...axisBase(theme, style, style.x.grid),
      ...(xReach.ticks === undefined
        ? {}
        : { axisTick: { ...(axisBase(theme, style, style.x.grid).axisTick as object), customValues: xReach.ticks } }),
      axisLabel: {
        ...(axisBase(theme, style, style.x.grid).axisLabel as object),
        ...(xReach.ticks === undefined ? {} : { customValues: xReach.ticks }),
        // Labels that would print over each other are thinned rather than
        // overprinted: a list too long to name, and as much a distance spelled
        // `300.0 kb` once the type is raised for print.
        ...(!histo ? { hideOverlap: true } : {}),
        ...xReach.labels,
        formatter:
          xSpelling ?? ((value: number) => axisNumber(value, style.x.scale === 'log' ? 'log' : 'linear')),
      },
      // The crosshair's number on the axis, spelled as the axis spells it: the
      // library's own printed `387,269.00` along a P(s) whose ticks say kb.
      axisPointer: { label: { formatter: pointerLabel(xSpelling, style.x.scale) } },
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
      ...(yReach.ticks === undefined
        ? {}
        : { axisTick: { ...(axisBase(theme, style, style.y.grid).axisTick as object), customValues: yReach.ticks } }),
      axisLabel: {
        ...(axisBase(theme, style, style.y.grid).axisLabel as object),
        ...(yReach.ticks === undefined ? {} : { customValues: yReach.ticks }),
        ...(!histo ? { hideOverlap: true } : {}),
        ...yReach.labels,
        formatter:
          ySpelling ?? ((value: number) => axisNumber(value, style.y.scale === 'log' ? 'log' : 'linear')),
      },
      // …and `0.00` on an ordinate whose ticks are `1e-8`.
      axisPointer: { label: { formatter: pointerLabel(ySpelling, style.y.scale) } },
    },
    // Wheel zooms the abscissa and drags pan it, which is the gesture a curve
    // is read with; the ordinate takes the same wheel with shift held, so a
    // reader can go after a shoulder in both directions without a mode.
    //
    // The window lives *here* rather than in the axes' `min`/`max`, and that is
    // the single-source rule this whole module is built on: a wheel gesture and
    // a number typed into the sidebar are then the same change to the same
    // place, and the export draws whichever of them happened last.
    // Named, so a gesture says which of the two it moved (`echartsFigure`).
    dataZoom: [
      {
        id: ZOOM_X,
        type: 'inside',
        xAxisIndex: 0,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        filterMode: 'none',
        ...zoomWindow(style.x.domain),
      },
      {
        id: ZOOM_Y,
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

/** The two zooms' ids, for a gesture to say which it moved. */
export const ZOOM_X = 'zoom-x'
export const ZOOM_Y = 'zoom-y'

/**
 * What the crosshair prints on an axis: the axis's own spelling where it has
 * one and it names the value — a list names only its members — and the
 * magnitude spelling on its scale otherwise.
 */
function pointerLabel(
  spelling: ((value: number) => string) | undefined,
  scale: FigureStyle['x']['scale'],
): (params: { value?: unknown }) => string {
  return ({ value }) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return ''
    const spelled = spelling?.(value) ?? ''
    return spelled !== '' ? spelled : axisNumber(value, scale === 'log' ? 'log' : 'linear')
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
    ...(area ? { // To zero, not to the bottom of the axis: a profile that dips below zero
    // is shaded down to zero and no further, so above and below read as two
    // sides of one line. Where zero is off the axis — every log axis, a window
    // that leaves it out — the fill stops at the edge nearest it.
    areaStyle: { color: entry.colour, opacity: fillOpacity, origin: 'auto' } } : {}),
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
 *
 * **Stacked whatever the signs** (`stackStrategy: 'all'`). ECharts stacks only
 * values of one sign by default, so a band whose lower edge is below zero had
 * its width stacked on zero instead: a strip from 0 to the band's width, nowhere
 * near its line — every insulation profile, a log ratio, drew its band so.
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
    stackStrategy: 'all',
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

  // The window a reader set, or the fit (§18.13).
  const log = style.y.scale === 'log'
  const window = style.y.domain ?? figureFit(spec, style, 'y')
  const ticks = log && window !== null ? logTicks(window[0], window[1]) : null

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
      ...(window === null ? {} : { min: window[0], max: window[1] }),
      ...axisBase(theme, style, style.y.grid),
      ...(ticks === null ? {} : { axisTick: { ...(axisBase(theme, style, style.y.grid).axisTick as object), customValues: ticks } }),
      axisLabel: {
        ...(axisBase(theme, style, style.y.grid).axisLabel as object),
        ...(window === null
          ? {}
          : ticks === null
            ? reachOf(window, null, [], log).labels
            : tickedEnds(reachOf(window, null, [], log).labels, ticks, window[0], window[1])),
        ...(ticks === null ? {} : { customValues: ticks }),
        formatter: (value: number) => axisNumber(value, log ? 'log' : 'linear'),
      },
    },
    series,
  }
}

/**
 * Every ordinate a box or a violin puts on the axis, as {@link boxSeries} and
 * {@link violinSeries} draw them: a box's whiskers and its outliers, a violin's
 * whole support — and a violin that has no shape to draw is drawn as a box —
 * and the points beside either.
 */
function distributionOrdinates(drawn: readonly FigureSeries[], style: FigureStyle): number[] {
  const shapes = style.mark === 'violin' ? drawn.map((series) => violinShape(series.y, style.y.scale === 'log')) : []
  const violins = shapes.some((shape) => shape.y.some((value) => value > 0))
  const out: number[] = []
  drawn.forEach((series, at) => {
    if (violins) {
      for (const value of shapes[at].at) out.push(value)
    } else {
      const box = boxSummary(series.y)
      out.push(box.low, box.high, ...box.outliers)
    }
    if (style.jitter) for (const value of series.y) out.push(value)
  })
  return out
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
