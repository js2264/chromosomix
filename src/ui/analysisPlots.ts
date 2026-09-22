/**
 * The pictures the Analysis drawer puts under a result.
 *
 * Every one of them is drawn **through a `CanvasRenderingContext2D` and through
 * nothing else** — no DOM nodes, no SVG, no chart library. That is not a
 * preference about how to draw a chart; it is the single decision that gives
 * §18.7 its promise of a true vector figure. `ui/vector.ts` implements the same
 * context interface and emits PDF operators, so a function that takes a context
 * and a box already knows how to write itself onto paper, and the export path
 * has nothing to reimplement. The corollary is a hard constraint the whole file
 * lives under: only the members enumerated in `VectorTarget` may be touched.
 * `putImageData` and `createImageData` are not among them, which is why a matrix
 * here is a grid of filled rectangles rather than a raster — the opposite of the
 * choice `render/heatmap.ts` makes, and right for the opposite reason: a pileup
 * is tens of cells on a side, and tens of cells are paths.
 *
 * The three drawing functions are pure: a context, an output, a box and a
 * palette in, marks out. Nothing here owns a canvas, reads the clock or knows
 * what a devicePixelRatio is. The two figure wrappers below own the canvas, the
 * resizing and the redraw, and hand the *same* draw function to the export — so
 * the figure in the PDF is the figure that was on screen by construction rather
 * than by care.
 */

import type {
  CurveOutput,
  CurveSeries,
  MarginProfile,
  MatrixMargins,
  MatrixOutput,
  ProfileOutput,
  TableColumn,
  TableOutput,
} from '../analysis/types'
import {
  COLORMAP_SIZE,
  DEFAULT_COLORMAP,
  applyColormap,
  colormapIndex,
  isColormap,
} from '../render/colormaps'
import { el, fmt, trimNumber } from './dom'
import { axisNumber, resolutionLabel } from '../units'
import { scaleFont, subscribeTextScale } from './textScale'
import { parseFont } from './vector'

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

export interface PlotTheme {
  ink: string
  muted: string
  grid: string
  background: string
  series: string[]
  font: string
}

/**
 * Okabe–Ito, which is the categorical set designed against a colour-vision
 * deficiency model rather than measured for lightness afterwards (§7.2 takes the
 * same line about the colormaps).
 *
 * Ordered by how well each holds against white paper, which is why the yellow is
 * last: it is the one member of the set that a printed figure loses, and a
 * result with eight series has already asked more of a legend than a legend can
 * give. Black sits seventh rather than being dropped — against seven hues it
 * reads as a series, and this is a figure, not a UI.
 */
const SERIES_COLOURS: readonly string[] = [
  '#0072B2',
  '#D55E00',
  '#009E73',
  '#CC79A7',
  '#E69F00',
  '#56B4E9',
  '#000000',
  '#F0E442',
]

/** The size every mark in these plots is derived from, before the text scale. */
const PLOT_FONT = '11px system-ui, sans-serif'

/**
 * The colours a plot borrows from the stylesheet, read off the node it is
 * mounted in.
 *
 * Read rather than decided, which is the same arrangement `readCanvasPalette`
 * keeps for the map and for the same reason: the *stylesheet* knows whether a
 * given box follows the theme. In the drawer it does not — `.analysis-figure`
 * re-declares the light palette exactly as `.content` does, because a plot in
 * there is a figure that leaves the app as a PNG or a PDF — so a figure comes
 * out ink on white in either theme while a plot mounted anywhere else follows
 * the theme like the rest of the furniture. Both behaviours fall out of asking
 * the host, and neither is written down twice.
 *
 * The fallbacks are the light values, because a canvas asked before it is in the
 * document has no computed custom properties and the palette it is about to be
 * mounted into is the light one. A plot that came out invisible would be the
 * worse failure.
 */
export function plotTheme(host: HTMLElement): PlotTheme {
  const style = getComputedStyle(host)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    ink: pick('--text', '#16181d'),
    muted: pick('--text-dim', '#5b6169'),
    grid: pick('--border', '#dcdfe3'),
    background: pick('--bg', '#ffffff'),
    // A copy: the constant is shared by every plot on screen and a caller that
    // recoloured one series would recolour all of them.
    series: [...SERIES_COLOURS],
    font: scaleFont(PLOT_FONT),
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface PlotBox {
  width: number
  height: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Line widths, in CSS pixels, and deliberately not `1 / dpr`.
 *
 * The renderers in `render/` write `Math.max(1 / dpr, 0.75)` because each of
 * them owns a canvas whose transform it set, so `1 / dpr` is one device pixel
 * and the floor keeps it from vanishing on a high-density screen. These
 * functions own no canvas and are handed a context that may be a `VectorPage`,
 * where a "device pixel" is a PDF unit and the figure will be rasterised at
 * whatever the printer runs at. So the widths are stated in the units the layout
 * is in, with the same 0.75 floor those callers arrived at — about half a point
 * at 300 dpi, which is a thin rule rather than a missing one.
 */
const RULE_WIDTH = 0.75
const FRAME_WIDTH = 1
const SERIES_WIDTH = 1.6

/** Tick marks, drawn outward from the frame. */
const TICK_LENGTH = 4

/** A band is a range, not a second line; it must not read as one. */
const BAND_ALPHA = 0.18

/** Below this the plot area is smaller than its own axis labels. */
const MIN_PLOT_SIDE = 24

function fontSizeOf(font: string): number {
  return parseFont(font).size
}

/** The same font with a heading's weight, for the axis titles. */
function boldOf(font: string): string {
  return parseFont(font).bold ? font : `600 ${font}`
}

function paintBackground(ctx: CanvasRenderingContext2D, box: PlotBox, theme: PlotTheme): void {
  // Painted rather than cleared: `VectorPage.clearRect` is a no-op, since a page
  // is written in order and there is nothing behind it, so a figure that relied
  // on the clear would have no ground of its own in the PDF.
  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, box.width, box.height)
}

function drawEmpty(
  ctx: CanvasRenderingContext2D,
  box: PlotBox,
  theme: PlotTheme,
  message: string,
): void {
  ctx.fillStyle = theme.muted
  ctx.font = theme.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(message, box.width / 2, box.height / 2)
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

interface Span {
  lo: number
  hi: number
}

interface Axis {
  readonly log: boolean
  /** Domain in *drawing* space, which is log10 units on a log axis. */
  readonly lo: number
  readonly hi: number
  /** Fraction along the axis, or `NaN` where the value has no place on it. */
  fraction(value: number): number
}

/**
 * Where a curve was drawn, and on what axes — the figure's answer to "what is
 * under this pixel".
 *
 * Returned by {@link drawCurve} rather than recomputed by the caller, and that
 * is the whole point: the margins are decided by the widths of the tick labels
 * and the height of the legend, so anything that measured them from outside
 * would be an approximation that drifts every time a label changes. A marquee
 * has to land on the number the reader is pointing at, and a rectangle that is
 * eight pixels out is a rectangle that selects the wrong range.
 *
 * `lo` and `hi` are in **drawing space** — log10 units on a log axis — because
 * that is the space the pixel mapping is linear in.
 */
export interface CurveLayout {
  plot: Rect
  x: { log: boolean; lo: number; hi: number }
  y: { log: boolean; lo: number; hi: number }
}

/**
 * A data value in the space the axis is linear in, or `NaN` if it has none.
 *
 * The `NaN` for a non-positive value on a log axis is the whole point of this
 * function existing. `Math.log10(0)` is `-Infinity` and `Math.log10(-1)` is
 * `NaN`, and either one, folded into a minimum, drags the axis to negative
 * infinity and collapses every curve onto a single line at the top of the plot.
 * A contact-probability curve starts at a separation of zero, so this is not a
 * corner case: it is what P(s) does to a log axis on the first point of the
 * first series, every time. The point is **dropped**, exactly as `NaN` is
 * dropped from a sum everywhere else in this codebase.
 */
function drawSpace(value: number, log: boolean): number {
  if (!Number.isFinite(value)) return Number.NaN
  if (!log) return value
  return value > 0 ? Math.log10(value) : Number.NaN
}

function makeAxis(log: boolean, span: Span): Axis {
  const width = span.hi - span.lo
  return {
    log,
    lo: span.lo,
    hi: span.hi,
    fraction(value: number): number {
      const at = drawSpace(value, log)
      return Number.isNaN(at) ? Number.NaN : (at - span.lo) / width
    },
  }
}

/**
 * Room around the data, in drawing space.
 *
 * The y axis gets a little: a maximum drawn exactly on the frame is a maximum a
 * reader cannot see. The x axis gets none — a P(s) runs from its first
 * separation to its last, and padding it would put white space where the data's
 * own limits are the information.
 */
function padSpan(span: Span, fraction: number): Span {
  const width = span.hi - span.lo
  if (!(width > 0)) {
    // A single distinct value would divide by zero. Half a unit either side puts
    // the line across the middle of the plot instead of along its edge.
    const pad = Math.max(Math.abs(span.lo) * 0.05, 0.5)
    return { lo: span.lo - pad, hi: span.hi + pad }
  }
  return { lo: span.lo - width * fraction, hi: span.hi + width * fraction }
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** Through `units.axisNumber`, which is where an axis tick's magnitude is spelled. */
function exponentLabel(value: number): string {
  return axisNumber(value)
}

/**
 * A tick's number, with as many places as its own step justifies and no more.
 *
 * `step` rather than the value decides the precision, so a ladder of 0.25, 0.50,
 * 0.75 keeps its trailing zeros aligned instead of reading 0.25, 0.5, 0.75.
 */
function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return ''
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs < 1e-4 || abs >= 1e6) return exponentLabel(value)
  const places = Math.min(6, Math.max(0, -Math.floor(Math.log10(Math.abs(step)))))
  return trimZeros(value.toFixed(places))
}

/** The 1-2-5 ladder over `[lo, hi]`, the same rung set `chooseBpStep` climbs. */
function linearTicks(lo: number, hi: number, maxTicks: number): number[] {
  const raw = (hi - lo) / Math.max(1, maxTicks)
  if (!(raw > 0)) return []
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude
  const first = Math.ceil(lo / step)
  const out: number[] = []
  // Indexed off `first` rather than accumulated: `v += 0.1` twenty times lands
  // a whole ulp away from `2`, and the last tick then falls outside the domain
  // and is dropped — the one tick a reader most wants, the axis maximum.
  for (let i = 0; ; i++) {
    const value = (first + i) * step
    if (value > hi + step * 1e-9) break
    out.push(value === 0 ? 0 : value)
    if (out.length > maxTicks + 2) break
  }
  return out
}

/**
 * Decades within a log domain, with the 2…9 subdivisions where they still read.
 *
 * `lo` and `hi` are log10. Minor ticks are dropped past six decades, where they
 * stop being a subdivision and become a grey smear along the axis.
 */
function decadeTicks(
  lo: number,
  hi: number,
  maxTicks: number,
): { major: number[]; minor: number[] } {
  const first = Math.ceil(lo - 1e-9)
  const last = Math.floor(hi + 1e-9)
  const decades: number[] = []
  for (let d = first; d <= last; d++) decades.push(d)
  const stride = Math.max(1, Math.ceil(decades.length / Math.max(1, maxTicks)))
  const major = decades.filter((_, index) => index % stride === 0).map((d) => 10 ** d)
  const minor: number[] = []
  if (stride === 1 && decades.length <= 6) {
    for (let d = first - 1; d <= last; d++) {
      for (let m = 2; m <= 9; m++) {
        const value = m * 10 ** d
        const at = Math.log10(value)
        if (at > lo && at < hi) minor.push(value)
      }
    }
  }
  return { major, minor }
}

interface AxisTicks {
  major: Array<{ value: number; label: string }>
  minor: number[]
}

function axisTicks(axis: Axis, maxTicks: number): AxisTicks {
  const label = (values: number[]): AxisTicks => {
    const step = values.length > 1 ? values[1] - values[0] : axis.hi - axis.lo
    return { major: values.map((value) => ({ value, label: formatTick(value, step) })), minor: [] }
  }
  if (!axis.log) return label(linearTicks(axis.lo, axis.hi, maxTicks))

  const { major, minor } = decadeTicks(axis.lo, axis.hi, maxTicks)
  if (major.length >= 2) {
    return { major: major.map((value) => ({ value, label: formatTick(value, value) })), minor }
  }
  // Less than two decades in view — a zoomed-in P(s), a saddle strength over one
  // order of magnitude. Decades alone would label such an axis once or not at
  // all, so it is labelled on the 1-2-5 ladder in data units instead. The axis
  // is still logarithmic; only its labels stop being powers of ten.
  return label(linearTicks(10 ** axis.lo, 10 ** axis.hi, maxTicks))
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * The x and y domains, over every series and every band edge at once.
 *
 * Paired rather than scanned axis by axis: a point whose x has no place on a log
 * axis contributes no y either, which is what stops the dropped first point of a
 * P(s) — separation zero, and by far the largest count in the series — from
 * setting the top of a y axis it is not drawn on.
 */
function curveDomains(output: CurveOutput): { x: Span; y: Span } | null {
  const xLog = output.xScale === 'log'
  const yLog = output.yScale === 'log'
  const asked = { x: askedSpan(output.xDomain, xLog), y: askedSpan(output.yDomain, yLog) }
  const x: Span = { lo: Number.POSITIVE_INFINITY, hi: Number.NEGATIVE_INFINITY }
  const y: Span = { lo: Number.POSITIVE_INFINITY, hi: Number.NEGATIVE_INFINITY }

  for (const series of output.series) {
    const columns = [series.y, series.low, series.high]
    for (let i = 0; i < series.x.length; i++) {
      const at = drawSpace(series.x[i], xLog)
      if (Number.isNaN(at)) continue
      // **The y fit is over the x window, not over the series.** With a window
      // asked for, the points outside it are not on the picture, and letting
      // them set the ordinate is how a P(s) zoomed to 4 kb–1 Mb still came out
      // with its whole height spent on the near-diagonal spike sitting off the
      // left edge. Auto means "fit what is shown".
      const inside = asked.x === null || (at >= asked.x.lo && at <= asked.x.hi)
      let seen = false
      for (const column of columns) {
        if (column === undefined || i >= column.length) continue
        const value = drawSpace(column[i], yLog)
        if (Number.isNaN(value)) continue
        seen = true
        if (!inside) continue
        if (value < y.lo) y.lo = value
        if (value > y.hi) y.hi = value
      }
      if (!seen) continue
      if (at < x.lo) x.lo = at
      if (at > x.hi) x.hi = at
    }
  }
  // A window an axis cannot be fitted in — nothing inside the x window, so no y
  // to draw against — is `null`, and the figure says "nothing to plot". Widening
  // back out to the whole series instead would answer a question nobody asked
  // and look exactly like a figure that had not been asked one.
  const xSpan = asked.x ?? (x.lo <= x.hi ? padSpan(x, 0) : null)
  const ySpan = asked.y ?? (y.lo <= y.hi ? padSpan(y, 0.05) : null)
  if (xSpan === null || ySpan === null) return null
  return { x: xSpan, y: ySpan }
}

/**
 * An explicit axis window in drawing space, or `null` for "fit the data".
 *
 * Either bound may be absent or unusable — a reader clears one box, or asks for
 * zero on a log axis — and the answer is to fall back to the data for *that*
 * axis rather than to refuse the pair. Reversed bounds are sorted rather than
 * rejected: a marquee dragged right to left is the same rectangle.
 */
function askedSpan(domain: readonly [number, number] | undefined, log: boolean): Span | null {
  if (domain === undefined) return null
  const lo = drawSpace(domain[0], log)
  const hi = drawSpace(domain[1], log)
  if (Number.isNaN(lo) || Number.isNaN(hi) || lo === hi) return null
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }
}

function seriesColour(series: CurveSeries, index: number, theme: PlotTheme): string {
  return series.colour ?? theme.series[index % theme.series.length]
}

/**
 * Every series' colour fixed against the list it belongs to, once.
 *
 * {@link seriesColour} colours by **position**, which is right when it is handed
 * the whole figure and wrong the moment anything filters the list first. Hiding
 * a series in the drawer's figures used to do exactly that: with series
 * `A, B, C` and `A` switched off, `B` took `A`'s colour and `C` took `B`'s — the
 * lines, their confidence bands and their legend swatches all stepping one place
 * up the palette. It was silent, it survived into the PNG and the PDF, and its
 * most visible form was alt-click *isolate*, which hides everything but one
 * series and so always redrew that series in the first palette entry, whichever
 * one the reader had picked out.
 *
 * So the colour is resolved here, against the full, unfiltered list, and stamped
 * onto the series before anything is allowed to drop entries. `colour` already
 * wins over the palette everywhere it is read, so nothing downstream changes:
 * what a filtered list gets is a list of series that already know what colour
 * they are.
 *
 * **A series that carries its own colour keeps it**, sentinels included — the
 * `colour: 'none'` of the legend's "+N more" entry names no series and must go
 * on naming none. And the *index* is the only thing this reads, so a task that
 * left its colours off still gets one palette entry per line in list order,
 * which is what `analysis/combine.ts` relies on to give four maps four colours.
 *
 * No theme is needed, and that is a fact about the palette rather than an
 * oversight: `plotTheme` reads ink, grid and background off the host but hands
 * back the *same* Okabe–Ito series list either way, because a figure is a figure
 * in light and dark alike. Should the categorical palette ever come to depend on
 * the host, this function is where the theme has to arrive.
 */
export function resolveSeriesColours(series: readonly CurveSeries[]): CurveSeries[] {
  return series.map((entry, index) =>
    entry.colour === undefined
      ? { ...entry, colour: SERIES_COLOURS[index % SERIES_COLOURS.length] }
      : entry,
  )
}

function legendText(series: CurveSeries): string {
  return series.n === undefined || !Number.isFinite(series.n)
    ? series.name
    : `${series.name} (n = ${fmt.int(series.n)})`
}

/**
 * How many lines of legend a figure will give up to naming its series.
 *
 * Three, and past that it says how many it did not name. **The curves are all
 * drawn either way** — this is a cap on the *names*, not on the data, and the
 * distinction is the whole of why it is here rather than in the task: P(s) over
 * a metagenome is four thousand sequences and every one of them is a real
 * answer, but four thousand legend entries is a legend taller than the screen
 * pushing the picture off the bottom of it. What the reader loses is a lookup
 * they could not have used at that size anyway; what they keep is the shape of
 * four thousand curves, which is the thing they ran it for.
 */
const LEGEND_LINES = 3

/**
 * The legend, wrapped into lines above the plot.
 *
 * Above rather than floating inside the frame at a corner, which is what a
 * chart library would do: a legend over the data hides whichever series happens
 * to reach that corner, and on a drawer 300 pixels wide there is no corner that
 * is reliably empty. Measured here so the caller can subtract its height before
 * it lays the plot out — the legend takes room from the picture rather than
 * covering it.
 */
function legendLines(
  ctx: CanvasRenderingContext2D,
  output: CurveOutput,
  width: number,
  swatch: number,
  gap: number,
): CurveSeries[][] {
  if (output.series.length < 2) return []
  const lines: CurveSeries[][] = []
  let line: CurveSeries[] = []
  let used = 0
  for (let i = 0; i < output.series.length; i++) {
    const series = output.series[i]
    const need = swatch + gap * 0.5 + ctx.measureText(legendText(series)).width + gap * 1.5
    if (line.length > 0 && used + need > width) {
      lines.push(line)
      line = []
      used = 0
      // Full. The remainder is counted rather than listed, in an entry with no
      // swatch — it names no one series, so a colour beside it would be a lie
      // about which.
      if (lines.length === LEGEND_LINES) {
        const rest = output.series.length - i
        lines[LEGEND_LINES - 1] = [
          ...lines[LEGEND_LINES - 1],
          { name: `+${fmt.int(rest)} more`, x: EMPTY_SERIES, y: EMPTY_SERIES, colour: 'none' },
        ]
        return lines
      }
    }
    line.push(series)
    used += need
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/** The `x`/`y` of a legend entry that names no data. Shared; never written to. */
const EMPTY_SERIES = new Float64Array(0)

/**
 * One series' band, as filled polygons at reduced alpha.
 *
 * One polygon per run of drawable points rather than one for the whole series:
 * a gap in the middle of a bootstrap interval — a distance bin no feature
 * reached — would otherwise be bridged by a straight edge across it, drawing a
 * confidence interval over a region where there is no estimate at all.
 */
function drawBand(
  ctx: CanvasRenderingContext2D,
  series: CurveSeries,
  x: Axis,
  y: Axis,
  plot: Rect,
  colour: string,
): void {
  const { low, high } = series
  if (low === undefined || high === undefined) return
  const n = Math.min(series.x.length, low.length, high.length)

  ctx.save()
  ctx.globalAlpha = BAND_ALPHA
  ctx.fillStyle = colour
  const at = (index: number): number => plot.x + x.fraction(series.x[index]) * plot.width
  const up = (value: number): number => plot.y + (1 - y.fraction(value)) * plot.height

  let start = -1
  const flush = (end: number): void => {
    if (start >= 0 && end - start >= 2) {
      ctx.beginPath()
      for (let i = start; i < end; i++) {
        if (i === start) ctx.moveTo(at(i), up(high[i]))
        else ctx.lineTo(at(i), up(high[i]))
      }
      for (let i = end - 1; i >= start; i--) ctx.lineTo(at(i), up(low[i]))
      ctx.closePath()
      ctx.fill()
    }
    start = -1
  }

  for (let i = 0; i < n; i++) {
    const ok =
      !Number.isNaN(x.fraction(series.x[i])) &&
      !Number.isNaN(y.fraction(low[i])) &&
      !Number.isNaN(y.fraction(high[i]))
    if (ok) {
      if (start < 0) start = i
    } else {
      flush(i)
    }
  }
  flush(n)
  ctx.restore()
}

function drawSeriesLine(
  ctx: CanvasRenderingContext2D,
  series: CurveSeries,
  x: Axis,
  y: Axis,
  plot: Rect,
  colour: string,
): void {
  const n = Math.min(series.x.length, series.y.length)
  ctx.strokeStyle = colour
  ctx.fillStyle = colour
  ctx.lineWidth = SERIES_WIDTH
  ctx.lineJoin = 'round'

  // A series whose x is not an ordering draws as marks and nothing else. Taken
  // first, because everything below is about which *runs* of points to join, and
  // the answer here is none of them.
  if (series.mark === 'points') {
    const radius = SERIES_WIDTH * 1.4
    for (let i = 0; i < n; i++) {
      const fx = x.fraction(series.x[i])
      const fy = y.fraction(series.y[i])
      if (Number.isNaN(fx) || Number.isNaN(fy)) continue
      ctx.beginPath()
      ctx.arc(
        plot.x + fx * plot.width,
        plot.y + (1 - fy) * plot.height,
        radius,
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
    return
  }

  let start = -1
  const flush = (end: number): void => {
    if (start >= 0) {
      if (end - start === 1) {
        // A lone drawable point between two gaps strokes nothing, and dropping
        // it would silently lose the only estimate in that stretch. Drawn as a
        // square of the line's own width, which is what the eye reads as "one
        // measurement" rather than "a very short line".
        const size = SERIES_WIDTH * 1.6
        ctx.fillRect(
          plot.x + x.fraction(series.x[start]) * plot.width - size / 2,
          plot.y + (1 - y.fraction(series.y[start])) * plot.height - size / 2,
          size,
          size,
        )
      } else if (end - start > 1) {
        ctx.beginPath()
        for (let i = start; i < end; i++) {
          const px = plot.x + x.fraction(series.x[i]) * plot.width
          const py = plot.y + (1 - y.fraction(series.y[i])) * plot.height
          if (i === start) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
    }
    start = -1
  }

  for (let i = 0; i < n; i++) {
    const ok = !Number.isNaN(x.fraction(series.x[i])) && !Number.isNaN(y.fraction(series.y[i]))
    if (ok) {
      if (start < 0) start = i
    } else {
      flush(i)
    }
  }
  flush(n)
}

/**
 * Draw a curve output into `box`, from its own origin.
 *
 * The transform is the caller's: on screen the figure wrapper has already scaled
 * the context by the device pixel ratio, and on paper `VectorPage.setOrigin` has
 * placed it. Touching `setTransform` here would undo either one.
 */
export function drawCurve(
  ctx: CanvasRenderingContext2D,
  output: CurveOutput,
  box: { width: number; height: number },
  theme: PlotTheme,
): CurveLayout | null {
  paintBackground(ctx, box, theme)

  const size = fontSizeOf(theme.font)
  const line = Math.round(size * 1.35)
  const gap = Math.round(size * 0.45)
  ctx.font = theme.font

  const domains = curveDomains(output)
  if (domains === null) {
    drawEmpty(ctx, box, theme, 'nothing to plot')
    return null
  }
  const x = makeAxis(output.xScale === 'log', domains.x)
  const y = makeAxis(output.yScale === 'log', domains.y)

  // Tick counts come from the box rather than from the plot area, which is not
  // known yet: the labels decide the margins and the margins would then decide
  // the labels. Erring towards too few is the safe direction — a sparse axis
  // reads, a crowded one does not.
  const yTicks = axisTicks(y, Math.max(2, Math.floor(box.height / (line * 3))))
  const xTicks = axisTicks(x, Math.max(2, Math.floor(box.width / (size * 7))))

  let widestY = 0
  for (const tick of yTicks.major) widestY = Math.max(widestY, ctx.measureText(tick.label).width)
  let widestX = 0
  for (const tick of xTicks.major) widestX = Math.max(widestX, ctx.measureText(tick.label).width)

  const left = Math.ceil(widestY) + TICK_LENGTH + gap + (output.yLabel === '' ? 0 : line)
  const right = Math.ceil(widestX / 2) + gap
  // Wrapped against the plot area rather than the whole box, because that is
  // where it is drawn from: measuring against the box would let the last entry
  // of a line run off the right edge by the width of the y axis.
  const legend = legendLines(ctx, output, Math.max(0, box.width - left - right), size * 1.6, gap)
  // Half a line of headroom above the frame, because the topmost y tick label is
  // centred on its own tick and a tick can land on the domain's ceiling.
  const top = legend.length * line + (legend.length > 0 ? gap : 0) + Math.ceil(line / 2)
  const bottom =
    TICK_LENGTH + gap + line + (output.xLabel === '' ? 0 : line) + Math.round(size * 0.3)

  const plot: Rect = {
    x: left,
    y: top,
    width: box.width - left - right,
    height: box.height - top - bottom,
  }
  if (plot.width < MIN_PLOT_SIDE || plot.height < MIN_PLOT_SIDE) {
    drawEmpty(ctx, box, theme, 'too small to draw')
    return null
  }

  // Gridlines under everything, so a line crossing one is unambiguously on top.
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = RULE_WIDTH
  ctx.beginPath()
  for (const tick of yTicks.major) {
    const at = y.fraction(tick.value)
    if (!(at >= 0 && at <= 1)) continue
    const py = plot.y + (1 - at) * plot.height
    ctx.moveTo(plot.x, py)
    ctx.lineTo(plot.x + plot.width, py)
  }
  for (const tick of xTicks.major) {
    const at = x.fraction(tick.value)
    if (!(at >= 0 && at <= 1)) continue
    const px = plot.x + at * plot.width
    ctx.moveTo(px, plot.y)
    ctx.lineTo(px, plot.y + plot.height)
  }
  ctx.stroke()

  // Clipped to the frame, which matters only once an axis window can be asked
  // for: a series then runs off the edge of the plot rather than ending at it,
  // and unclipped it would be drawn across the tick labels and the legend. The
  // clip is a path in the PDF as much as on the canvas (`ui/vector.ts`), so the
  // export is cut the same way rather than differently.
  ctx.save()
  ctx.beginPath()
  ctx.rect(plot.x, plot.y, plot.width, plot.height)
  ctx.clip()
  // Every band before any line: within a series the band belongs under its own
  // line, and across series it belongs under all of them — a translucent wash
  // laid over a neighbour's line tints it into a colour the legend does not
  // name.
  output.series.forEach((series, index) => {
    drawBand(ctx, series, x, y, plot, seriesColour(series, index, theme))
  })
  output.series.forEach((series, index) => {
    drawSeriesLine(ctx, series, x, y, plot, seriesColour(series, index, theme))
  })
  ctx.restore()

  // The frame last, so it closes over the ends of the data rather than being
  // painted through by them.
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = FRAME_WIDTH
  // The series left a round join behind, which is right for a polyline and
  // wrong for a rectangle; PDF carries the join in the graphics state, so it has
  // to be put back rather than assumed.
  ctx.lineJoin = 'miter'
  ctx.strokeRect(plot.x, plot.y, plot.width, plot.height)

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = RULE_WIDTH
  ctx.beginPath()
  for (const value of xTicks.minor) {
    const at = x.fraction(value)
    if (!(at >= 0 && at <= 1)) continue
    const px = plot.x + at * plot.width
    ctx.moveTo(px, plot.y + plot.height)
    ctx.lineTo(px, plot.y + plot.height + TICK_LENGTH / 2)
  }
  for (const value of yTicks.minor) {
    const at = y.fraction(value)
    if (!(at >= 0 && at <= 1)) continue
    const py = plot.y + (1 - at) * plot.height
    ctx.moveTo(plot.x - TICK_LENGTH / 2, py)
    ctx.lineTo(plot.x, py)
  }
  ctx.stroke()

  ctx.strokeStyle = theme.muted
  ctx.fillStyle = theme.muted
  ctx.font = theme.font
  ctx.lineWidth = RULE_WIDTH

  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const tick of yTicks.major) {
    const at = y.fraction(tick.value)
    if (!(at >= 0 && at <= 1)) continue
    const py = plot.y + (1 - at) * plot.height
    ctx.beginPath()
    ctx.moveTo(plot.x - TICK_LENGTH, py)
    ctx.lineTo(plot.x, py)
    ctx.stroke()
    ctx.fillText(tick.label, plot.x - TICK_LENGTH - gap * 0.5, py)
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const tick of xTicks.major) {
    const at = x.fraction(tick.value)
    if (!(at >= 0 && at <= 1)) continue
    const px = plot.x + at * plot.width
    ctx.beginPath()
    ctx.moveTo(px, plot.y + plot.height)
    ctx.lineTo(px, plot.y + plot.height + TICK_LENGTH)
    ctx.stroke()
    // The mark stays on its value and the label steps back inside the box when
    // it would hang off the end — the colourbar's rule, for the same reason:
    // half of a number is not a number.
    const half = ctx.measureText(tick.label).width / 2
    const put = Math.min(Math.max(px, half), box.width - half)
    ctx.fillText(tick.label, put, plot.y + plot.height + TICK_LENGTH + gap * 0.4)
  }

  ctx.fillStyle = theme.ink
  ctx.font = boldOf(theme.font)
  if (output.xLabel !== '') {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(output.xLabel, plot.x + plot.width / 2, box.height - Math.round(size * 0.2))
  }
  if (output.yLabel !== '') {
    ctx.save()
    ctx.translate(Math.round(size * 0.9), plot.y + plot.height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(output.yLabel, 0, 0)
    ctx.restore()
  }

  ctx.font = theme.font
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const swatch = size * 1.6
  legend.forEach((entries, row) => {
    let at = plot.x
    const py = Math.round(row * line + line / 2)
    for (const series of entries) {
      // `colour: 'none'` is the "+N more" entry, which names no series and
      // therefore draws no swatch; everything else takes its own line's colour.
      if (series.colour !== 'none') {
        ctx.strokeStyle = seriesColour(series, output.series.indexOf(series), theme)
        ctx.lineWidth = SERIES_WIDTH
        ctx.beginPath()
        ctx.moveTo(at, py)
        ctx.lineTo(at + swatch, py)
        ctx.stroke()
      }
      const text = legendText(series)
      ctx.fillStyle = theme.ink
      ctx.fillText(text, at + swatch + gap * 0.5, py)
      at += swatch + gap * 0.5 + ctx.measureText(text).width + gap * 1.5
    }
  })

  return { plot, x: { log: x.log, lo: x.lo, hi: x.hi }, y: { log: y.log, lo: y.lo, hi: y.hi } }
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

/**
 * The 256 colours of a colormap as CSS strings, built once per name.
 *
 * The same argument `RGBA_CACHE` makes one level down: this is read once per
 * cell of the matrix, and a `rgb(…)` string built inside that loop is an
 * allocation per cell for a value that has 256 possibilities.
 */
const CSS_LUTS = new Map<string, string[]>()

function colourTable(name: string): string[] {
  const held = CSS_LUTS.get(name)
  if (held !== undefined) return held
  const lut = applyColormap(name)
  const table: string[] = new Array<string>(COLORMAP_SIZE)
  for (let i = 0; i < COLORMAP_SIZE; i++) {
    table[i] = `rgb(${lut[i * 4]}, ${lut[i * 4 + 1]}, ${lut[i * 4 + 2]})`
  }
  CSS_LUTS.set(name, table)
  return table
}

/**
 * The colour scale, symmetric about `centre` where the output declares one.
 *
 * That symmetry is the whole reason `MatrixOutput.centre` exists: a scale fitted
 * to the data's own extremes moves its midpoint with the data, so the value that
 * means "no change" — 1 for a ratio, 0 for a correlation — lands on a different
 * colour in every panel, and two pileups become uncomparable by exactly the
 * amount their tails differ.
 */
function matrixRange(output: MatrixOutput): { vmin: number; vmax: number } | null {
  // A scale the task fixed is not a suggestion: it is there so the picture can
  // be laid beside the one the tool it agrees with draws. See `MatrixOutput.range`.
  if (output.range !== undefined && output.range[1] > output.range[0]) {
    return { vmin: output.range[0], vmax: output.range[1] }
  }
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const value of output.values) {
    if (!Number.isFinite(value)) continue
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  if (!(lo <= hi)) return null
  if (output.centre !== undefined) {
    const centre = output.centre
    // A constant matrix at the centre value has no half-width; one unit is a
    // readable span and puts every cell on the midpoint colour, which is the
    // true answer rather than a division by zero.
    const half = Math.max(Math.abs(hi - centre), Math.abs(lo - centre)) || 1
    return { vmin: centre - half, vmax: centre + half }
  }
  return { vmin: lo, vmax: hi > lo ? hi : lo + 1 }
}

/**
 * A cell's side, in CSS pixels, snapped to a whole pixel where there is room.
 *
 * Adjacent rectangles that meet on a fractional boundary are antialiased against
 * each other, and a grid of them shows a lattice of pale seams that reads as
 * structure in the data. Whole-pixel cells tile exactly and have none. Below one
 * pixel there is no grid to snap to and no seam to see either, so the fractional
 * size stands — which is what keeps a 500-row per-feature heatmap inside its box
 * instead of overflowing it by 500 rounded-up pixels.
 */
function cellSide(available: number, count: number): number {
  const raw = available / Math.max(1, count)
  return raw >= 1 ? Math.floor(raw) : Math.max(raw, 0)
}

/**
 * **One cell size for both axes**, so a cell is a square and an `n × n` matrix
 * is a square picture.
 *
 * The two were computed independently, each filling its own axis, which left the
 * aspect of a saddle or a correlation heatmap to be decided by how wide the
 * reader had dragged the drawer: the same 50 × 50 saddle was a tall rectangle in
 * a narrow panel and a squat one in a wide one. That is a picture whose shape
 * carries no information and reads as one whose shape does — a saddle is read by
 * comparing its two corners, and a corner stretched 40% along one axis looks
 * stronger than the one opposite it. A correlation heatmap over eight tracks is
 * the same argument with the diagonal as the giveaway.
 *
 * The smaller of the two, so the picture fits either way; the slack on the other
 * axis is centred rather than pooled at one end (see {@link drawMatrix}). A
 * non-square matrix keeps its own aspect exactly, which is the same rule stated
 * once: the cells are square, so the picture is as tall as it is many.
 *
 * Not every matrix wants it: see {@link matrixCells}, which is where the choice
 * is made, and `MatrixOutput.aspect`, which is where it is declared.
 */
export function squareCell(
  availableWidth: number,
  availableHeight: number,
  ncols: number,
  nrows: number,
): number {
  return Math.min(cellSide(availableWidth, ncols), cellSide(availableHeight, nrows))
}

/**
 * The cell's width and height — square, or one that fills the box.
 *
 * {@link squareCell} is the rule for a matrix with the *same quantity on both
 * axes*, which is nearly all of them and every one with a diagonal. The
 * exception is a picture whose rows are a **list**: the metaplot's per-feature
 * heatmap is three thousand features down and a thousand bins across, and
 * square cells there make it a ribbon a fifth of the card wide with white on
 * either side. Nothing is compared across its diagonal because it has none —
 * a row is a feature and a column is a distance — so the cell may be as wide as
 * the box allows, which is the block every metaplot tool draws and the shape
 * that lines the picture up with the profile above it.
 */
export function matrixCells(
  availableWidth: number,
  availableHeight: number,
  output: Pick<MatrixOutput, 'ncols' | 'nrows' | 'aspect'>,
): { width: number; height: number } {
  if (output.aspect === 'fill') {
    return {
      width: cellSide(availableWidth, output.ncols),
      height: cellSide(availableHeight, output.nrows),
    }
  }
  const cell = squareCell(availableWidth, availableHeight, output.ncols, output.nrows)
  return { width: cell, height: cell }
}

/**
 * Where a list of tick labels sits along an axis of `cells` cells.
 *
 * One label per cell names *that cell*, so it goes at the cell's centre — a
 * saddle's quantile groups, a MAG list. Any other count is a scale laid across
 * the axis and its two ends are the axis's two ends — a pileup's `-100 kb`,
 * `0`, `+100 kb`, which must reach the corners or they are describing a
 * different window from the one drawn.
 */
function tickFractions(count: number, cells: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0.5]
  if (count === cells) return Array.from({ length: count }, (_, i) => (i + 0.5) / count)
  return Array.from({ length: count }, (_, i) => i / (count - 1))
}

/** Every k-th label, where k is what it takes for two of them not to collide. */
function labelStride(need: number, fractions: number[], length: number): number {
  if (fractions.length < 2) return 1
  const spacing = Math.abs(fractions[1] - fractions[0]) * length
  if (!(spacing > 0)) return fractions.length
  return Math.max(1, Math.ceil(need / spacing))
}

function formatStat(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return '—'
  if (digits !== undefined) return value.toFixed(digits)
  return Number.isInteger(value) ? fmt.int(value) : trimNumber(value)
}

/**
 * The extent a marginal profile is drawn against, per track name (§18.8).
 *
 * **Its own**, and not from zero. A band three lines tall is not an axis and
 * cannot be read as one; what it promises is the *shape* of the aggregate along
 * the window, which is the whole reason it is there. Drawn from zero, a ChIP
 * track whose aggregate runs from 45 to 92 — a signal that doubles at the
 * anchor — is a line across the top of the band with a bump in it, while the
 * same numbers as a metaplot curve in the same drawer are a peak twice the
 * height of the baseline. Two pictures of one quantity that disagree about
 * whether anything happened is the complaint this is a fix for. The range is
 * printed in the key, which is what keeps a self-scaled band honest about how
 * much of an effect it is showing.
 *
 * **One ruler per quantity, across both edges.** The same track drawn above the
 * picture and beside it is one measurement, and two bands normalised apart
 * would invite a reader to compare a bump on one against a bump on the other
 * when the two are drawn to different scales. Two *different* tracks keep their
 * own rulers, because two units have no common axis.
 */
function marginScales(
  margins: MatrixMargins | undefined,
): Map<string, { lo: number; hi: number }> {
  const out = new Map<string, { lo: number; hi: number }>()
  for (const profile of [...(margins?.top ?? []), ...(margins?.right ?? [])]) {
    const held = out.get(profile.name) ?? {
      lo: Number.POSITIVE_INFINITY,
      hi: Number.NEGATIVE_INFINITY,
    }
    for (const value of profile.values) {
      if (!Number.isFinite(value)) continue
      if (value < held.lo) held.lo = value
      if (value > held.hi) held.hi = value
    }
    out.set(profile.name, held)
  }
  return out
}

/**
 * One marginal profile, filled under a line, against an edge of the picture.
 *
 * Its colour comes from {@link SERIES_COLOURS}, deliberately the same list a
 * curve draws from: a track above a pileup and the same track as a curve two
 * blocks down the drawer are one quantity, and one colour for it in both is the
 * difference between a figure a reader can follow and a page of unrelated
 * pictures.
 *
 * Normalised against {@link marginScales}'s answer for its track. A profile with
 * no variation in it draws flat on its own baseline rather than filling the
 * band, which is what "no variation" looks like.
 *
 * `along: 'x'` runs left to right above the picture; `along: 'y'` runs top to
 * bottom beside it, growing rightwards — the two edges the anchors of an
 * off-diagonal pileup sit on.
 *
 * `NaN` is a gap and is drawn as one: the fill and the line both break, so a
 * window with no coverage reads as missing rather than as zero.
 */
function drawMargin(
  ctx: CanvasRenderingContext2D,
  profile: MarginProfile,
  fallback: string,
  theme: PlotTheme,
  layout: {
    along: 'x' | 'y'
    plot: Rect
    band: number
    gap: number
    range?: { lo: number; hi: number }
  },
): void {
  const { values } = profile
  let lo = layout.range?.lo ?? Number.POSITIVE_INFINITY
  let hi = layout.range?.hi ?? Number.NEGATIVE_INFINITY
  if (layout.range === undefined) {
    for (const value of values) {
      if (!Number.isFinite(value)) continue
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }
  if (!(lo <= hi)) return
  const floor = lo
  const span = hi - floor
  const colour = profile.colour ?? fallback
  const { along, plot, band, gap: pad } = layout

  // Where a value of `fraction` lands, and where the baseline is: above the
  // picture the band grows upwards, beside it the band grows rightwards.
  const base = along === 'x' ? plot.y - pad : plot.x + plot.width + pad
  const depth = (fraction: number): number =>
    along === 'x' ? base - fraction * band : base + fraction * band
  const across = (index: number): number =>
    along === 'x'
      ? plot.x + ((index + 0.5) / values.length) * plot.width
      : plot.y + ((index + 0.5) / values.length) * plot.height

  const point = (index: number, fraction: number): [number, number] =>
    along === 'x' ? [across(index), depth(fraction)] : [depth(fraction), across(index)]

  // Runs of finite values, each filled and stroked on its own so a gap stays a
  // gap.
  let run: Array<[number, number]> = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length > 1) {
      ctx.fillStyle = colour
      ctx.globalAlpha = BAND_ALPHA
      ctx.beginPath()
      const last = run[run.length - 1]
      // The fill is the run plus the two feet that drop it onto the band's own
      // baseline, so a profile is an area under a line rather than a ribbon.
      if (along === 'x') ctx.moveTo(run[0][0], base)
      else ctx.moveTo(base, run[0][1])
      for (const [x, y] of run) ctx.lineTo(x, y)
      if (along === 'x') ctx.lineTo(last[0], base)
      else ctx.lineTo(base, last[1])
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
    }
    ctx.strokeStyle = colour
    ctx.lineWidth = SERIES_WIDTH
    ctx.beginPath()
    run.forEach(([x, y], at) => (at === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.stroke()
    run = []
  }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!Number.isFinite(value)) {
      flush()
      continue
    }
    run.push(point(index, span > 0 ? (value - floor) / span : 0))
  }
  flush()

  // The band's own baseline, so a flat profile is visibly flat rather than
  // absent, and so the two bands read as two plots rather than as decoration.
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = RULE_WIDTH
  ctx.beginPath()
  if (along === 'x') {
    ctx.moveTo(plot.x, base)
    ctx.lineTo(plot.x + plot.width, base)
  } else {
    ctx.moveTo(base, plot.y)
    ctx.lineTo(base, plot.y + plot.height)
  }
  ctx.stroke()
  ctx.lineWidth = FRAME_WIDTH
}

/**
 * Draw a matrix output into `box`, from its own origin.
 *
 * Cells are filled rectangles rather than a raster, and that is forced rather
 * than chosen: `putImageData` is not part of `VectorTarget`, so a rasterised
 * pileup could not be written to a PDF page at all. It is also the right shape
 * for the data — §18.7's matrices are tens to a few hundred cells on a side, and
 * a few hundred rectangles in a vector figure is a figure a reader can restyle.
 */
export function drawMatrix(
  ctx: CanvasRenderingContext2D,
  output: MatrixOutput,
  box: { width: number; height: number },
  theme: PlotTheme,
): void {
  paintBackground(ctx, box, theme)

  const size = fontSizeOf(theme.font)
  const line = Math.round(size * 1.35)
  const gap = Math.round(size * 0.45)
  ctx.font = theme.font

  const range = matrixRange(output)
  if (range === null || output.nrows < 1 || output.ncols < 1) {
    drawEmpty(ctx, box, theme, 'nothing to plot')
    return
  }
  // An unknown colormap name would throw out of `applyColormap` in the middle of
  // a paint. A result drawn on the default ramp is a result the reader can see
  // and question; an exception is a blank drawer.
  const colours = colourTable(isColormap(output.colormap) ? output.colormap : DEFAULT_COLORMAP)

  const barTicks = linearTicks(
    range.vmin,
    range.vmax,
    Math.max(2, Math.floor(box.height / (line * 3))),
  )
  const barStep = barTicks.length > 1 ? barTicks[1] - barTicks[0] : range.vmax - range.vmin
  let widestBar = 0
  for (const value of barTicks) {
    widestBar = Math.max(widestBar, ctx.measureText(formatTick(value, barStep)).width)
  }
  let widestY = 0
  for (const label of output.yTicks) widestY = Math.max(widestY, ctx.measureText(label).width)

  const barWidth = Math.round(size * 0.9)
  // The marginal profiles, and the two bands they need. A band is three lines
  // tall, which is enough for a shape to be a shape and little enough that the
  // picture — which is the subject — keeps its size. See {@link MatrixMargins}.
  const topMargins = (output.margins?.top ?? []).filter((profile) => profile.values.length > 0)
  const rightMargins = (output.margins?.right ?? []).filter((profile) => profile.values.length > 0)
  const band = Math.round(size * 3)
  const topBand = topMargins.length > 0 ? band + gap : 0
  const rightBand = rightMargins.length > 0 ? band + gap : 0
  // One key line for however many profiles there are, above everything: with
  // two tracks over one pileup a reader has to be told which line is which, and
  // there is no room for a legend beside a band three lines tall.
  const keyLine = topMargins.length + rightMargins.length > 0 ? line : 0
  const left =
    Math.ceil(widestY) +
    (widestY > 0 ? TICK_LENGTH + gap : gap) +
    (output.yLabel === '' ? 0 : line)
  const right = gap * 2 + barWidth + TICK_LENGTH + Math.ceil(widestBar) + gap + rightBand
  // Half a line, so the top row's tick label and the bar's `vmax` — both centred
  // on the top edge — sit inside the box rather than half out of it.
  const top = Math.ceil(line / 2) + keyLine + topBand
  const stats = output.stats ?? []
  const bottom =
    (output.xTicks.length > 0 ? TICK_LENGTH + gap + line : gap) +
    (output.xLabel === '' ? 0 : line) +
    (stats.length > 0 ? gap + stats.length * line : 0) +
    Math.round(size * 0.3)

  const availableWidth = box.width - left - right
  const availableHeight = box.height - top - bottom
  if (availableWidth < MIN_PLOT_SIDE || availableHeight < MIN_PLOT_SIDE) {
    drawEmpty(ctx, box, theme, 'too small to draw')
    return
  }

  const cell = matrixCells(availableWidth, availableHeight, output)
  const cellW = cell.width
  const cellH = cell.height
  const plot: Rect = {
    // Centred in what is left over after the cells were snapped to whole pixels,
    // so the slack is split rather than pooled against the colour bar.
    x: left + Math.round((availableWidth - cellW * output.ncols) / 2),
    y: top + Math.round((availableHeight - cellH * output.nrows) / 2),
    width: cellW * output.ncols,
    height: cellH * output.nrows,
  }
  if (!(plot.width > 0) || !(plot.height > 0)) {
    drawEmpty(ctx, box, theme, 'too small to draw')
    return
  }

  const scale = 1 / (range.vmax - range.vmin)
  let painted = -1
  for (let row = 0; row < output.nrows; row++) {
    const y0 = plot.y + row * cellH
    for (let col = 0; col < output.ncols; col++) {
      const index = colormapIndex((output.values[row * output.ncols + col] - range.vmin) * scale)
      // `-1` is matplotlib's "bad" colour, which is transparent — a `NaN` cell.
      // Left unpainted rather than filled with the background, so the paper (or
      // whatever the figure is composited over) shows through and a missing cell
      // is visibly missing instead of being drawn at one end of the scale.
      if (index < 0) continue
      if (index !== painted) {
        ctx.fillStyle = colours[index]
        painted = index
      }
      ctx.fillRect(plot.x + col * cellW, y0, cellW, cellH)
    }
  }

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = FRAME_WIDTH
  ctx.strokeRect(plot.x, plot.y, plot.width, plot.height)

  // The marginals, against the two edges they run along, and the one line of key
  // above both. Drawn before the ticks so the axis furniture is painted over
  // them rather than under.
  //
  // **A colour per name, not per profile.** The commonest case is one track
  // drawn on both edges — the same aggregate along the rows and along the
  // columns — and colouring by position would give the one quantity two colours
  // and the key two rows, which is a legend asserting there are two of them.
  const named = [...topMargins, ...rightMargins]
  const order = [...new Set(named.map((profile) => profile.name))]
  const colourOf = (profile: MarginProfile): string =>
    profile.colour ?? SERIES_COLOURS[Math.max(0, order.indexOf(profile.name)) % SERIES_COLOURS.length]
  const scales = marginScales(output.margins)
  for (const profile of topMargins) {
    drawMargin(ctx, profile, colourOf(profile), theme, {
      along: 'x',
      plot,
      band,
      gap,
      range: scales.get(profile.name),
    })
  }
  for (const profile of rightMargins) {
    drawMargin(ctx, profile, colourOf(profile), theme, {
      along: 'y',
      plot,
      band,
      gap,
      range: scales.get(profile.name),
    })
  }
  if (keyLine > 0) {
    ctx.font = theme.font
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    let keyAt = gap
    for (const name of order) {
      const profile = named.find((one) => one.name === name)
      if (profile === undefined) continue
      ctx.fillStyle = colourOf(profile)
      ctx.fillRect(keyAt, Math.round(size * 0.55), Math.round(size * 0.7), RULE_WIDTH * 2.5)
      keyAt += Math.round(size * 0.7) + gap * 0.6
      ctx.fillStyle = theme.muted
      // The range the band is drawn against, beside the name. A self-scaled
      // band says *what the shape is* and not how big it is, and these two
      // numbers are what put the size back — without them a doubling and a
      // rounding error are the same picture.
      const scale = scales.get(name)
      const text =
        scale === undefined || !(scale.lo <= scale.hi)
          ? name
          : `${name}  ${trimNumber(scale.lo)}–${trimNumber(scale.hi)}`
      ctx.fillText(text, keyAt, 0)
      keyAt += ctx.measureText(text).width + gap * 1.6
    }
  }

  ctx.fillStyle = theme.muted
  ctx.strokeStyle = theme.muted
  ctx.lineWidth = RULE_WIDTH
  ctx.font = theme.font

  const xFractions = tickFractions(output.xTicks.length, output.ncols)
  let widestX = 0
  for (const label of output.xTicks) widestX = Math.max(widestX, ctx.measureText(label).width)
  const xStride = labelStride(widestX + gap, xFractions, plot.width)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  output.xTicks.forEach((label, index) => {
    if (index % xStride !== 0) return
    const px = plot.x + xFractions[index] * plot.width
    ctx.beginPath()
    ctx.moveTo(px, plot.y + plot.height)
    ctx.lineTo(px, plot.y + plot.height + TICK_LENGTH)
    ctx.stroke()
    const half = ctx.measureText(label).width / 2
    const put = Math.min(Math.max(px, half), box.width - half)
    ctx.fillText(label, put, plot.y + plot.height + TICK_LENGTH + gap * 0.4)
  })

  const yFractions = tickFractions(output.yTicks.length, output.nrows)
  const yStride = labelStride(line, yFractions, plot.height)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  output.yTicks.forEach((label, index) => {
    if (index % yStride !== 0) return
    // Row 0 is the top row, which is how a matrix is written down and how
    // `render/heatmap.ts` draws one — so the fractions run *down* the axis.
    const py = plot.y + yFractions[index] * plot.height
    ctx.beginPath()
    ctx.moveTo(plot.x - TICK_LENGTH, py)
    ctx.lineTo(plot.x, py)
    ctx.stroke()
    ctx.fillText(label, plot.x - TICK_LENGTH - gap * 0.5, py)
  })

  // The colour bar, `vmin` at the bottom, matching every other vertical bar in
  // this application and matplotlib's own.
  // Past the right-hand band, not over it: `right` reserves both, and the bar is
  // the outermost of the two.
  const barX = box.width - right + gap + rightBand
  for (let i = 0; i < COLORMAP_SIZE; i++) {
    const y0 = plot.y + plot.height * (1 - (i + 1) / COLORMAP_SIZE)
    const y1 = plot.y + plot.height * (1 - i / COLORMAP_SIZE)
    ctx.fillStyle = colours[i]
    ctx.fillRect(barX, y0, barWidth, y1 - y0)
  }
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = FRAME_WIDTH
  ctx.strokeRect(barX, plot.y, barWidth, plot.height)

  ctx.fillStyle = theme.muted
  ctx.strokeStyle = theme.muted
  ctx.lineWidth = RULE_WIDTH
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const value of barTicks) {
    const at = (value - range.vmin) * scale
    if (!(at >= 0 && at <= 1)) continue
    const py = plot.y + (1 - at) * plot.height
    ctx.beginPath()
    ctx.moveTo(barX + barWidth, py)
    ctx.lineTo(barX + barWidth + TICK_LENGTH, py)
    ctx.stroke()
    ctx.fillText(formatTick(value, barStep), barX + barWidth + TICK_LENGTH + gap * 0.4, py)
  }

  ctx.fillStyle = theme.ink
  ctx.font = boldOf(theme.font)
  const tickRow = output.xTicks.length > 0 ? TICK_LENGTH + gap + line : gap
  const labelBottom = plot.y + plot.height + tickRow
  if (output.xLabel !== '') {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(output.xLabel, plot.x + plot.width / 2, labelBottom)
  }
  if (output.yLabel !== '') {
    ctx.save()
    ctx.translate(Math.round(size * 0.9), plot.y + plot.height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(output.yLabel, 0, 0)
    ctx.restore()
  }

  // The numbers under the picture — P2LL, AA/BB strength, an r. One per line
  // rather than a row of them: the drawer is a column three hundred pixels wide,
  // and a statistic that wrapped between its label and its value would read as
  // two statistics. The `hint` is not drawn; it is a tooltip, and a figure has
  // nowhere to hover.
  let statY = labelBottom + (output.xLabel === '' ? 0 : line) + gap
  ctx.font = theme.font
  ctx.textBaseline = 'top'
  for (const stat of stats) {
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.muted
    ctx.fillText(stat.label, plot.x, statY)
    ctx.fillStyle = theme.ink
    const after = plot.x + ctx.measureText(`${stat.label}  `).width
    ctx.fillText(formatStat(stat.value, stat.digits), after, statY)
    statY += line
  }
}

// ---------------------------------------------------------------------------
// Figures: a canvas that owns itself
// ---------------------------------------------------------------------------

export interface PlotFigure {
  el: HTMLElement
  draw(ctx: CanvasRenderingContext2D, box: { width: number; height: number }): void
  destroy(): void
  /**
   * Take the height of the box instead of choosing one from the width.
   *
   * What the dialog turns on. In the drawer a figure decides how tall it is,
   * because the column it is in has no height of its own; in a dialog the
   * window decides, and a figure that kept its own answer sits in the top half
   * of it with the rest blank — which is what a five-thousand-row heatmap
   * enlarged to see it better used to do.
   */
  setFill?(on: boolean): void
}

/** The width a figure is drawn at before anything has measured its column. */
const MIN_FIGURE_WIDTH = 240

/**
 * Call `onChange` whenever the effective theme changes.
 *
 * Both halves are needed and neither is enough: `ThemeToggle` writes `data-theme`
 * on `<html>` for an explicit light or dark choice, and *removes* it for
 * "system", where the answer comes from the media query instead. A canvas is not
 * restyled by CSS, so a figure that watched only one of the two would keep the
 * old palette until something else made it redraw.
 */
function watchTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const observer =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => onChange())
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  const listener = (): void => onChange()
  media?.addEventListener?.('change', listener)
  return () => {
    observer?.disconnect()
    media?.removeEventListener?.('change', listener)
  }
}

/**
 * A canvas in a wrapper, sized to its column and redrawn when anything it is
 * drawn *from* changes.
 *
 * The wrapper is not decoration. A `ResizeObserver` on the canvas itself would
 * observe a box this code resizes, which is the classic feedback loop; observing
 * the parent, whose height is decided by the canvas and whose width is decided
 * by the drawer, breaks it — and the width comparison below closes the remaining
 * half of it, since setting the canvas height changes the wrapper's height and
 * fires the observer again with the same width.
 *
 * `draw` is exposed rather than kept private because it is the same function the
 * PDF export calls with a `VectorPage`'s context. There is one implementation of
 * each figure, and the file the reader downloads is drawn by it.
 */
function canvasFigure<T>(
  paint: (ctx: CanvasRenderingContext2D, box: PlotBox, theme: PlotTheme) => T,
  heightFor: (width: number) => number,
  /**
   * What the last *on-screen* paint laid out, for a caller that maps pointers
   * onto it.
   *
   * Called from {@link redraw} and never from `draw`, and the distinction is
   * load-bearing rather than tidiness: `draw` is the export path, which paints
   * the same figure into a PDF page eight inches wide, and a layout recorded
   * from that would put the marquee somewhere the reader is not.
   */
  onLayout?: (layout: T) => void,
): PlotFigure {
  // The width is stated inline as well as in the class. `canvas.width` is the
  // backing store in *device* pixels, and a canvas whose stylesheet never
  // arrived would be drawn at that size instead — a figure twice as wide as its
  // column on a retina screen. The class still carries the block display.
  const canvas = el('canvas', { class: 'analysis-figure-canvas', style: { width: '100%' } })
  const host = el('div', { class: 'analysis-figure-canvas-host' }, canvas)
  let width = 0
  let fill = false

  const redraw = (): void => {
    const cssWidth = Math.max(MIN_FIGURE_WIDTH, Math.round(width))
    const cssHeight = fill
      ? Math.max(MIN_FIGURE_WIDTH, Math.round(host.clientHeight))
      : heightFor(cssWidth)
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    canvas.style.height = `${cssHeight}px`
    const wantWidth = Math.max(1, Math.round(cssWidth * dpr))
    const wantHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== wantWidth) canvas.width = wantWidth
    if (canvas.height !== wantHeight) canvas.height = wantHeight
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)
    const layout = paint(ctx, { width: cssWidth, height: cssHeight }, plotTheme(host))
    onLayout?.(layout)
  }

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect
          const next = box?.width ?? 0
          // The height matters only when the *box* decides it; otherwise the
          // figure sets it and observing it would be the classic feedback loop.
          if (Math.abs(next - width) < 0.5 && !fill) return
          width = next
          redraw()
        })
  observer?.observe(host)
  // A `ResizeObserver` delivers the initial size on `observe`, so the draw below
  // would be thrown away a frame later. Without one — under a test runner, or an
  // old browser — nothing else will ever ask for pixels.
  if (observer === null) redraw()

  const stopTheme = watchTheme(redraw)
  // The text scale is the other thing a figure is drawn from that changes under
  // it: `plotTheme` reads `scaleFont`, so a press of the smaller/larger control
  // must reach the canvas the same way it reaches the lanes.
  const stopText = subscribeTextScale(redraw)

  return {
    el: host,
    draw(ctx: CanvasRenderingContext2D, box: { width: number; height: number }): void {
      paint(ctx, box, plotTheme(host))
    },
    setFill(on: boolean): void {
      if (fill === on) return
      fill = on
      host.classList.toggle('analysis-figure-fill', on)
      redraw()
    },
    destroy(): void {
      observer?.disconnect()
      stopTheme()
      stopText()
    },
  }
}

/**
 * Height for a curve.
 *
 * Taller than it was, and the two curves that made the case are the ones §18.8
 * puts first: P(s) is read over three or four decades on a log-log axis, and its
 * *derivative* is a shape whose whole content is a shoulder a few tenths of a
 * unit deep. At the old 0.62 of the width both were about 170 px in a folded
 * drawer, which is a plot with four y ticks in it — enough to see that a curve
 * goes down and not enough to see how.
 *
 * 0.78, floored at 260 and capped at 520. The floor is what a narrow drawer
 * gets, and it is the number that matters: a reader who has folded the drawer to
 * see the map beside it is still reading a plot rather than a sparkline. The cap
 * stops a full-width drawer on a wide screen from making one curve taller than
 * the window, which would be worse than short — two figures in a run would then
 * never be on screen together.
 */
function curveHeight(width: number): number {
  return Math.max(260, Math.min(520, Math.round(width * 0.78)))
}

/**
 * Height for a matrix, from its own aspect.
 *
 * The margins are estimated here — the exact ones need a context to measure the
 * labels with, and the box has to be decided before there is one — so the number
 * is a *request*. {@link drawMatrix} fits itself inside whatever box it is given
 * and never overruns it, so an estimate that is a few pixels out costs a few
 * pixels of white, not a clipped figure.
 */
function matrixHeight(output: MatrixOutput, width: number): number {
  const size = fontSizeOf(scaleFont(PLOT_FONT))
  const line = Math.round(size * 1.35)
  // The marginal bands are furniture too: a picture asked for the height it
  // needs without counting them comes back with its top band clipped, which is
  // the one part of the figure a reader cannot reconstruct from the rest.
  const gap = Math.round(size * 0.45)
  const band = Math.round(size * 3)
  const tops = output.margins?.top?.length ?? 0
  const sides = output.margins?.right?.length ?? 0
  const furniture =
    Math.round(size * 0.9) +
    (output.xTicks.length > 0 ? TICK_LENGTH + line : 0) +
    (output.xLabel === '' ? 0 : line) +
    (output.stats?.length ?? 0) * line +
    (tops > 0 ? band + gap : 0) +
    (tops + sides > 0 ? line : 0)
  const cells = Math.max(40, width - size * 4 - size * 6 - (sides > 0 ? band + gap : 0))
  // A picture whose rows are a **list** has no aspect of its own to ask for —
  // five thousand features against eighty bins would ask for sixty-four times
  // its width — so it takes a generous share of the card instead, which is
  // where a metaplot heatmap's few thousand rows want to be. See
  // `MatrixOutput.aspect` and {@link matrixCells}.
  if (output.aspect === 'fill') {
    return Math.round(furniture + Math.max(260, Math.min(560, cells * 0.55)))
  }
  const aspect = output.ncols > 0 ? output.nrows / output.ncols : 1
  return Math.round(furniture + Math.max(80, Math.min(420, cells * aspect)))
}

export function curveFigure(
  output: CurveOutput,
  onLayout?: (layout: CurveLayout | null) => void,
): PlotFigure {
  return canvasFigure(
    (ctx, box, theme) => drawCurve(ctx, output, box, theme),
    curveHeight,
    onLayout,
  )
}

/**
 * How many points a per-bin profile is drawn with.
 *
 * A metagenome has four million bins and a drawer is eight hundred pixels wide,
 * so a line with a point per bin is four million `lineTo` calls to paint four
 * hundred pixels — several seconds a frame, for a picture that cannot show what
 * it drew. Above this many the bins are bucketed; below it every one is drawn.
 */
const PROFILE_POINTS = 1200

/**
 * A per-bin profile as a curve, so it can be drawn where there is no lane.
 *
 * §18.5 is unchanged and this is not a second opinion about it: a per-bin result
 * *is* a track, and wherever there is an Annotations panel it goes there and
 * inherits colour, limits, edges, the tooltip and the browser by being the same
 * object a bigWig is. A `.metacool` has no such panel (§8.5), and the choice
 * there is not between a lane and a picture — it is between a picture and
 * nothing at all, which is what a coverage run on a metagenome used to produce.
 *
 * **Bucketed with a band, not sampled.** Taking every thousandth bin would drop
 * exactly the spikes a marginal is read for, and would drop them silently. Each
 * bucket is drawn as its mean with its min–max behind it, so a spike inside one
 * shows as a band reaching up to it — the picture says "something in here got
 * that high" rather than quietly saying it did not. A profile short enough to
 * draw whole gets no band, because there is nothing being summarised.
 *
 * `NaN` stays `NaN`: a bucket with no finite value in it is a gap, and
 * {@link drawSeriesLine} breaks the line there rather than bridging it.
 */
export function profileCurve(output: ProfileOutput): CurveOutput {
  const values = output.values
  const from = output.extent[0]
  const n = values.length
  const buckets = n > PROFILE_POINTS ? PROFILE_POINTS : n
  const width = buckets === 0 ? 1 : n / buckets
  const x = new Float64Array(buckets)
  const y = new Float64Array(buckets)
  const low = new Float64Array(buckets)
  const high = new Float64Array(buckets)

  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * width)
    const hi = Math.max(lo + 1, Math.floor((b + 1) * width))
    let sum = 0
    let count = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let i = lo; i < hi && i < n; i++) {
      const value = values[i]
      if (Number.isNaN(value)) continue
      sum += value
      count++
      if (value < min) min = value
      if (value > max) max = value
    }
    // The bucket's midpoint, in the file's own bin numbering: the axis a reader
    // reads off this is the one the map's own coordinates are in.
    x[b] = from + (lo + hi) / 2
    y[b] = count === 0 ? Number.NaN : sum / count
    low[b] = count === 0 ? Number.NaN : min
    high[b] = count === 0 ? Number.NaN : max
  }

  const banded = buckets < n
  return {
    kind: 'curve',
    id: output.id,
    label: output.label,
    series: [
      {
        name: output.label,
        x,
        y,
        ...(banded ? { low, high } : {}),
      },
    ],
    xLabel: `bin (${resolutionLabel(output.binsize)} each)`,
    yLabel: output.unit === '' ? output.label : `${output.label} (${output.unit})`,
    xScale: 'linear',
    yScale: 'linear',
  }
}

/** {@link profileCurve}, drawn. */
export function profileFigure(output: ProfileOutput): PlotFigure {
  return curveFigure(profileCurve(output))
}

export function matrixFigure(output: MatrixOutput): PlotFigure {
  return canvasFigure(
    (ctx, box, theme) => drawMatrix(ctx, output, box, theme),
    (width) => matrixHeight(output, width),
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function cellText(column: TableColumn, raw: string | number | undefined): string {
  if (raw === undefined) return '—'
  if (column.kind !== 'number') return String(raw)
  const value = typeof raw === 'number' ? raw : Number(raw)
  // `NaN` is *no value here*, the same as everywhere else in this codebase — an
  // em dash, never a zero and never the word NaN.
  if (!Number.isFinite(value)) return '—'
  return column.digits === undefined ? fmt.int(value) : value.toFixed(column.digits)
}

export interface TableFigure {
  el: HTMLElement
  destroy(): void
}

/**
 * A result table: a plain scrolling table, and deliberately not a
 * {@link VirtualTable}.
 *
 * Virtualisation exists in this app for 154,468 contigs, where 154 k rows of DOM
 * is several seconds of layout before anything appears. A per-feature score
 * table is a few hundred rows, which is one layout pass — and the machinery is
 * not free: `.tr` is `position: absolute` precisely so rows can be placed by
 * transform, and every one of the virtual table's sort, filter and keyboard
 * affordances would then have to mean something here. This is a *record* of what
 * a task produced, checkable by eye and exportable as TSV (§18.7), so it is the
 * table it looks like.
 *
 * The typography is the virtual table's, because a number in a result should be
 * set like a number in a genomes table: `.thead`, `.td` and `.num` are all pure
 * appearance and are reused. `.th` is not — it carries a pointer cursor and an
 * accent hover, which are a promise to sort that this table does not keep.
 */
export function tableFigure(output: TableOutput): TableFigure {
  const head = el(
    'thead',
    { class: 'thead' },
    el(
      'tr',
      {},
      ...output.columns.map((column) =>
        el('th', {
          class: column.kind === 'number' ? 'td num' : 'td',
          text: column.label,
          title: column.hint ?? '',
          style: { fontWeight: '600', color: 'var(--text-dim)' },
        }),
      ),
    ),
  )

  const body = el('tbody', {})
  for (const row of output.rows) {
    body.appendChild(
      el(
        'tr',
        { style: { borderTop: '1px solid var(--border)' } },
        ...output.columns.map((column) =>
          el('td', {
            class: column.kind === 'number' ? 'td num' : 'td',
            text: cellText(column, row[column.key]),
          }),
        ),
      ),
    )
  }

  const table = el(
    'table',
    {
      style: {
        borderCollapse: 'collapse',
        width: '100%',
        // Digits of the same width, so a column of numbers can be compared by
        // its shape — the one thing `.tr` gave the virtual table's rows that is
        // worth carrying over by hand.
        fontVariantNumeric: 'tabular-nums',
      },
    },
    head,
    body,
  )

  const host = el(
    'div',
    { class: 'analysis-figure-scroll' },
    output.rows.length === 0
      ? el('div', { class: 'tempty', text: 'This run produced no rows.' })
      : table,
  )

  return {
    el: host,
    // Nothing to release: the table is DOM and goes when its parent does. It is
    // still here so the drawer can hold every figure in one list and tear them
    // all down the same way, rather than branching on which kind it has.
    destroy(): void {},
  }
}
