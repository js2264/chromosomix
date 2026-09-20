/**
 * A result matrix, as the chart library's option object (§18.13).
 *
 * The same contract `option.ts` meets for the xy figures — a spec, a style and a
 * theme in, a plain object out, no DOM and no library — and here for the same
 * reason: what the picture *is* should be testable without a browser.
 *
 * ## Why a chart rather than the painter it had
 *
 * `analysisPlots.drawMatrix` draws a perfectly good matrix, and it is still what
 * draws the ones too large for this (see {@link MATRIX_CHART_CELLS}). What it
 * cannot do is answer a question. A saddle plot, a cis/trans matrix, a pileup
 * and a track-correlation square are all *small grids of labelled cells*, and
 * the thing a reader wants from one is the number under the pointer — which of
 * these two sequences, how strong, is that cell the one the statistic under the
 * picture is about. A painted picture has no answer; a chart hovers, and the
 * colour bar becomes a control rather than a caption.
 *
 * **The contact map is not one of these** and is not drawn here. It is a raster
 * of up to sixteen million cells behind a reader that pools on the way
 * (`metacooler/pooling.ts`), it has its own gestures, its own overlays and its
 * own export path, and a heatmap series of one rect per cell is not a thing it
 * could ever be.
 *
 * ## The colour scale is this application's, not the library's
 *
 * `visualMap.inRange.color` takes a list of stops, so the ramp is *sampled* out
 * of `render/colormaps.ts` — the same `afmhot_r`, the same `seismic`, the same
 * tables matplotlib ships and the contact map draws with. A chart library's own
 * palette here would mean a saddle plot in the drawer and a saddle plot in a
 * paper being different pictures of the same numbers.
 *
 * And the **scale** is `analysisPlots.matrixRange`'s, restated: a task that
 * fixes its own range keeps it, a diverging output stays symmetric about its
 * centre, and everything else is fitted to the data. A scale fitted to the
 * extremes of a ratio would move its own white point with the data, which is
 * the one thing a diverging scale must not do.
 *
 * ## The marginal profiles
 *
 * A pileup carries aggregate track signal along its two edges (§18.8), and those
 * are two more series on two more grids that share the matrix's axes. They are
 * drawn from the same values the painter uses and sit in the same places, so a
 * reader who has seen the figure before sees the same figure.
 */

import { colormapCss, DEFAULT_COLORMAP, isColormap } from '../render/colormaps'
import { trimNumber } from '../ui/dom'
import type { MatrixOutput } from '../analysis/types'
import type { ChartOption, FigureTheme } from './option'
import type { FigureStyle } from './style'

/**
 * The most cells a matrix may have and still be drawn as a chart.
 *
 * A heatmap series is one rectangle per cell in the SVG, which is what makes it
 * hoverable and what makes it exportable as a drawing — and what puts a ceiling
 * on it. Twenty thousand is about a hundred and forty a side: comfortably past
 * every figure this was asked for (a pileup is 43², a saddle 50², a cis/trans
 * square is one cell per sequence) and comfortably short of the one that would
 * break it, the metaplot's per-feature heatmap, which is one row per feature and
 * runs to thousands.
 *
 * Above it the canvas painter draws, exactly as it did before there was a chart
 * — and that is the right picture there rather than a concession: five hundred
 * thousand rects is not something a reader can point at, so the interaction it
 * would buy does not exist at that size either.
 */
export const MATRIX_CHART_CELLS = 20_000

/** Whether this matrix is one the chart draws. */
export function drawnAsChart(output: MatrixOutput): boolean {
  const cells = output.nrows * output.ncols
  return cells > 0 && cells <= MATRIX_CHART_CELLS
}

/** How many stops the ramp is sampled at for `visualMap`. */
const RAMP_STOPS = 32

/** The app's own colormap, as the list of stops `visualMap` takes. */
export function rampOf(name: string): string[] {
  const map = isColormap(name) ? name : DEFAULT_COLORMAP
  const out: string[] = []
  for (let i = 0; i < RAMP_STOPS; i++) out.push(colormapCss(map, i / (RAMP_STOPS - 1)))
  return out
}

/**
 * The colour scale, symmetric about `centre` where the output declares one.
 *
 * `analysisPlots.matrixRange`'s rule, restated here rather than imported,
 * because that module is the *painter* and this one must not depend on it —
 * they are two renderers of one output and the dependency would be the wrong way
 * round. The rule itself is one paragraph and is written down in both.
 */
export function matrixScale(
  output: MatrixOutput,
  style?: Pick<FigureStyle, 'vmin' | 'vmax'>,
): { vmin: number; vmax: number } | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const value of output.values) {
    if (!Number.isFinite(value)) continue
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  // **What the reader typed wins over everything.** Above the task's own fixed
  // range and above the data, because the two boxes in the settings column are
  // the one place a person says *draw it between these* — and a control that
  // lost to a value in the output would be a control that silently does nothing
  // on exactly the figures that set one.
  const typed = style ?? { vmin: null, vmax: null }
  if (typed.vmin !== null || typed.vmax !== null) {
    const from = typed.vmin ?? (Number.isFinite(lo) ? lo : 0)
    const to = typed.vmax ?? (Number.isFinite(hi) ? hi : 1)
    if (from < to) return { vmin: from, vmax: to }
  }
  // A scale the task fixed is not a suggestion: it is there so the picture can
  // be laid beside the one the tool it agrees with draws.
  if (output.range !== undefined && output.range[1] > output.range[0]) {
    return { vmin: output.range[0], vmax: output.range[1] }
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
 * The tick labels an axis carries, one per cell, blank where the output gave
 * none.
 *
 * `MatrixOutput` states its ticks as *evenly spaced labels* rather than one per
 * cell — `xTicks` may hold five strings for a forty-three-column pileup — so
 * they are spread onto the cells they name. A category axis needs a label per
 * category; the empty ones are what leaves the axis with five labels on it.
 *
 * **The ends are the ends**, which is `analysisPlots.tickFractions`'s rule and
 * the reason this is not simply a label every k-th cell. A pileup's ticks are
 * `-100 kb`, `0`, `+100 kb`: a scale laid *across* the axis, whose first and
 * last labels name its two ends. Spread onto band centres instead, `-100 kb`
 * would land four cells in and the picture would be claiming a window it is not
 * drawing. One label per cell is the other case — a saddle's quantile groups, a
 * list of MAGs — and there each label names its own cell already.
 */
export function spreadTicks(labels: readonly string[], cells: number): string[] {
  const out = new Array<string>(Math.max(0, cells)).fill('')
  if (labels.length === 0 || cells <= 0) return out
  if (labels.length === cells) {
    for (let i = 0; i < cells; i++) out[i] = labels[i] ?? ''
    return out
  }
  // One label is about the whole axis, so it goes in the middle of it.
  if (labels.length === 1) {
    out[Math.floor((cells - 1) / 2)] = labels[0]
    return out
  }
  labels.forEach((label, index) => {
    const at = Math.round((index * (cells - 1)) / (labels.length - 1))
    // Two labels on one cell is a picture with fewer cells than the output has
    // ticks to say about it. The first claimant keeps the cell — except the
    // last label, which owns the last cell, because that is the end of the
    // scale and the end is the thing this rule is for.
    if (out[at] === '' || index === labels.length - 1) out[at] = label
  })
  return out
}

/** `[col, row, value]` per finite cell — the shape a heatmap series takes. */
function cellsOf(output: MatrixOutput): Array<[number, number, number]> {
  const data: Array<[number, number, number]> = []
  for (let row = 0; row < output.nrows; row++) {
    for (let col = 0; col < output.ncols; col++) {
      const value = output.values[row * output.ncols + col]
      // A non-finite cell is *no measurement here* and is left out rather than
      // drawn: the background shows through, which is what the painter does and
      // what a reader reads as a gap.
      if (!Number.isFinite(value)) continue
      // The ordinate runs **down**: row 0 is the top of the picture, as it is
      // in every contact map in this application and in the painter this
      // replaces. A category axis numbers upward from the bottom, so the row
      // index is flipped once, here, rather than everywhere that reads it.
      data.push([col, output.nrows - 1 - row, value])
    }
  }
  return data
}

/**
 * The extent each marginal profile is drawn against, per track name (§18.8).
 *
 * `analysisPlots.marginScales`'s rule, restated here for the reason every rule
 * in this module is restated: that one is the painter's and this one must not
 * import it. **Its own extent, not zero**, because a band three lines tall is
 * not an axis and what it promises is the shape along the window — a ChIP
 * track running from 45 to 92 drawn from zero is a line across the top of the
 * band with a bump in it, while the same numbers as a curve in the same drawer
 * are a peak twice the height of its baseline. And **one ruler per quantity
 * across both edges**, since the same track above the picture and beside it is
 * one measurement; two different tracks keep their own, two units having no
 * common axis.
 */
export function marginScales(
  margins: MatrixOutput['margins'],
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
 * The profiles along an edge, as line series on their own grid.
 *
 * Plotted as a **fraction of the track's own extent** on a `0…1` axis rather
 * than in their own units, which is the only way two tracks in two units can
 * share one band — and is what the painter does with the same numbers. See
 * {@link marginScales}.
 */
function marginSeries(
  profiles: ReadonlyArray<{ name: string; values: Float64Array }>,
  theme: FigureTheme,
  style: FigureStyle,
  grid: number,
  vertical: boolean,
  order: readonly string[],
  scales: Map<string, { lo: number; hi: number }>,
): ChartOption[] {
  return profiles.map((profile, index) => {
    // By **name**, not by position on this edge: the same track above the
    // picture and beside it is one quantity and takes one colour, which is the
    // rule the painter's key is drawn from.
    const at = Math.max(0, order.indexOf(profile.name))
    const colour = theme.series[at % theme.series.length]
    const scale = scales.get(profile.name)
    const span = scale === undefined ? 0 : scale.hi - scale.lo
    const points: Array<[number, number]> = []
    for (const [index, value] of profile.values.entries()) {
      if (!Number.isFinite(value)) continue
      // A profile with no variation in it sits on its own baseline rather than
      // filling the band, which is what "no variation" looks like.
      const height = span > 0 && scale !== undefined ? (value - scale.lo) / span : 0
      // The right-hand band runs **down** with the matrix's rows, so its
      // profile is flipped exactly as the cells are.
      const along = vertical ? profile.values.length - 1 - index : index
      points.push(vertical ? [height, along] : [along, height])
    }
    return {
      type: 'line',
      name: profile.name,
      id: `margin-${vertical ? 'right' : 'top'}-${index}`,
      xAxisIndex: grid,
      yAxisIndex: grid,
      data: points,
      showSymbol: false,
      lineStyle: { color: colour, width: Math.max(1, style.lineWidth * 0.8) },
      itemStyle: { color: colour },
      areaStyle: { color: colour, opacity: 0.18 },
      // Out of the tooltip: the matrix's own cell is what a reader is pointing
      // at, and three answers under one pointer is three things to read.
      silent: true,
      tooltip: { show: false },
      z: 3,
    }
  })
}

/** A band's axes: hidden, pinned to the matrix's cell count and to `0…1`. */
function bandAxis(grid: number, cells: number, vertical: boolean): ChartOption[] {
  const along = {
    type: 'value',
    gridIndex: grid,
    min: -0.5,
    max: cells - 0.5,
    show: false,
  }
  // The profiles arrive already scaled (see {@link marginSeries}), so the band
  // is the unit interval and a flat profile sits on its floor rather than being
  // stretched to fill by an axis fitted to nothing.
  const across = { type: 'value', gridIndex: grid, min: 0, max: 1, show: false }
  return vertical ? [across, along] : [along, across]
}

/**
 * The option for a matrix, laid out for a box of this size.
 *
 * The layout is the painter's, in the same order and for the same reasons: the
 * picture is the subject and takes the room, the marginal bands are three lines
 * tall apiece, the colour bar stands down the right where a reader looks for a
 * scale, and the statistics go under the picture as a subtitle because they are
 * about the whole of it rather than about any part.
 *
 * **Why it is told how big the box is.** A chart's grid is otherwise stated as
 * four insets and stretches to whatever it is put in, and a saddle stretched
 * 40% along one axis is a picture whose shape carries a claim nobody made — the
 * argument `analysisPlots.squareCell` makes at length. A square aspect cannot
 * be expressed as four insets, so the grid is given a width and a height in
 * pixels instead, which means knowing the box. `MatrixOutput.aspect` is where a
 * picture says which of the two it wants.
 */
export function matrixOptionOf(
  output: MatrixOutput,
  style: FigureStyle,
  theme: FigureTheme,
  plot: { width: number; height: number },
): ChartOption {
  const scale = matrixScale(output, style)
  const size = style.fontSize
  const topProfiles = (output.margins?.top ?? []).filter((p) => p.values.length > 0)
  const rightProfiles = (output.margins?.right ?? []).filter((p) => p.values.length > 0)
  const band = size * 3.5
  const gap = size * 0.8

  // One key line for however many profiles there are, above everything: with
  // two tracks over one pileup a reader has to be told which line is which, and
  // there is no room for a legend beside a band three lines tall.
  const names = [...new Set([...topProfiles, ...rightProfiles].map((one) => one.name))]
  const scales = marginScales(output.margins)
  const titled = style.title !== null && style.title !== ''
  const keyLine = names.length > 0 ? size * 1.8 : 0
  const headroom =
    (titled ? size + 14 : 4) + keyLine + (topProfiles.length > 0 ? band + gap : 0)
  // The bar down the right, and the band beside the picture where there is one.
  const barRoom = size * 5.5
  const rightRoom = barRoom + (rightProfiles.length > 0 ? band + gap : 0)
  const stats = output.stats ?? []
  const footer = (output.xLabel === '' ? 0 : size * 1.6) + (stats.length > 0 ? size * 1.8 : 0)

  // What is left for the picture once the furniture has taken its room.
  const inset = {
    left: output.yLabel === '' ? size * 3.5 : size * 5,
    right: rightRoom,
    top: headroom,
    bottom: size * 2.6 + footer,
  }
  const roomW = Math.max(1, plot.width - inset.left - inset.right)
  const roomH = Math.max(1, plot.height - inset.top - inset.bottom)
  const across = Math.max(1, output.ncols)
  const down = Math.max(1, output.nrows)
  // Square, or filling the box — see {@link MatrixOutput.aspect} and
  // `analysisPlots.matrixCells`, which is the same choice for the painter.
  const cell =
    output.aspect === 'fill'
      ? { width: roomW / across, height: roomH / down }
      : (() => {
          const side = Math.min(roomW / across, roomH / down)
          return { width: side, height: side }
        })()
  const main = {
    // The slack is centred rather than pooled against the colour bar, which is
    // what the painter does with it too.
    left: inset.left + (roomW - cell.width * across) / 2,
    top: inset.top + (roomH - cell.height * down) / 2,
    width: cell.width * across,
    height: cell.height * down,
    containLabel: false,
  }
  const grids: ChartOption[] = [main]
  const xAxes: ChartOption[] = []
  const yAxes: ChartOption[] = []
  const series: ChartOption[] = []

  /**
   * The ink an axis is drawn in, and **which of its labels are drawn**.
   *
   * A tick list shorter than the axis is a *scale laid across it* — a pileup's
   * five distances over forty-three columns — spread onto the cells it names
   * with blanks in between ({@link spreadTicks}). The library thins labels by
   * counting **categories**, blanks included, so left to itself it draws every
   * k-th column and hides four of the five things there were to read. With one
   * label per cell the thinning is right and is what keeps a fifty-quantile
   * saddle from writing a wall of numbers along its foot.
   */
  const axisInk = (labels: readonly string[], cells: number): ChartOption => ({
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { lineStyle: { color: theme.grid } },
    axisLabel: {
      color: theme.muted,
      fontSize: size,
      fontFamily: theme.fontFamily,
      ...(labels.length > 0 && labels.length !== cells ? { interval: 0 } : {}),
    },
    nameTextStyle: { color: theme.ink, fontSize: size, fontFamily: theme.fontFamily },
    splitLine: { show: false },
    splitArea: { show: false },
  })

  xAxes.push({
    type: 'category',
    gridIndex: 0,
    data: spreadTicks(output.xTicks, output.ncols),
    name: output.xLabel,
    nameLocation: 'middle',
    nameGap: size * 2.2,
    ...axisInk(output.xTicks, output.ncols),
  })
  yAxes.push({
    type: 'category',
    gridIndex: 0,
    // Reversed with the cells, so the *first* row of the output is the top row
    // of the picture: see {@link cellsOf}.
    data: [...spreadTicks(output.yTicks, output.nrows)].reverse(),
    name: output.yLabel,
    nameLocation: 'middle',
    nameGap: size * 3.4,
    ...axisInk(output.yTicks, output.nrows),
  })

  series.push({
    type: 'heatmap',
    id: 'matrix',
    name: output.label,
    data: cellsOf(output),
    xAxisIndex: 0,
    yAxisIndex: 0,
    // No border between cells. Adjacent rectangles that meet on a fractional
    // boundary are antialiased against each other and a grid of them shows a
    // lattice of pale seams, which reads as structure in the data — the same
    // argument `analysisPlots.cellSide` makes for snapping the painter's cells.
    itemStyle: { borderWidth: 0 },
    emphasis: { itemStyle: { borderColor: theme.ink, borderWidth: 1 } },
    progressive: 0,
  })

  if (topProfiles.length > 0) {
    // Against the picture's own edges, not the box's: a profile that shared the
    // abscissa's range but not its pixels would be a curve of somewhere else.
    grids.push({ left: main.left, width: main.width, top: main.top - band - gap, height: band })
    const at = grids.length - 1
    const [x, y] = bandAxis(at, output.ncols, false)
    xAxes.push(x)
    yAxes.push(y)
    series.push(...marginSeries(topProfiles, theme, style, at, false, names, scales))
  }
  if (rightProfiles.length > 0) {
    grids.push({ left: main.left + main.width + gap, width: band, top: main.top, height: main.height })
    const at = grids.length - 1
    const [x, y] = bandAxis(at, output.nrows, true)
    xAxes.push(x)
    yAxes.push(y)
    series.push(...marginSeries(rightProfiles, theme, style, at, true, names, scales))
  }

  // The window, as cell indices on the two category axes. Same place the xy
  // figures keep theirs (`option.ts`), so the wheel, the marquee and a reset all
  // reach a matrix through the one route they reach a curve through — and the
  // bands zoom *with* the picture, since a marginal that stayed put over a
  // zoomed pileup would be a profile of somewhere else.
  // The colour bar, beside the picture: past the right-hand band where there
  // is one, and no taller than the picture itself.
  const barAt = main.left + main.width + gap + (rightProfiles.length > 0 ? band + gap : 0)
  // As tall as the picture, less a line at each end: `calculable` writes the
  // two ends of the scale *outside* the bar, and a bar the exact height of an
  // untitled figure would put the top one off the canvas.
  const barTall = Math.max(size * 6, main.height - size * 2)

  const xGrids = [0, ...(topProfiles.length > 0 ? [1] : [])]
  const yGrids = [0, ...(rightProfiles.length > 0 ? [grids.length - 1] : [])]
  const cellWindow = (domain: [number, number] | null, cells: number): ChartOption =>
    domain === null
      ? { start: 0, end: 100 }
      : {
          startValue: Math.max(0, Math.round(domain[0])),
          endValue: Math.min(cells - 1, Math.round(domain[1])),
        }

  const subtitle = stats
    .map((stat) => `${stat.label} ${stat.value.toFixed(stat.digits ?? 2)}`)
    .join('   ·   ')

  return {
    backgroundColor: theme.background,
    animation: false,
    textStyle: { fontFamily: theme.fontFamily, fontSize: size, color: theme.ink },
    ...(titled || subtitle !== ''
      ? {
          title: [
            ...(titled
              ? [
                  {
                    text: style.title,
                    left: 'center',
                    top: 4,
                    textStyle: {
                      color: theme.ink,
                      fontSize: size + 4,
                      fontFamily: theme.fontFamily,
                    },
                  },
                ]
              : []),
            ...(subtitle === ''
              ? []
              : [
                  {
                    // Under the picture, because the numbers are about the whole
                    // of it: P2LL, an AA/BB strength, an r.
                    text: subtitle,
                    left: 'center',
                    bottom: 2,
                    textStyle: {
                      color: theme.muted,
                      fontSize: size,
                      fontFamily: theme.fontFamily,
                    },
                  },
                ]),
          ],
        }
      : {}),
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    // The key for the bands, with **the range each is drawn against**: a
    // self-scaled band says what the shape is and not how big it is, and these
    // two numbers are what put the size back. Not a control — a heatmap's one
    // series is not something to switch off, and neither is a marginal.
    ...(names.length === 0
      ? {}
      : {
          legend: {
            data: names.map((name) => ({ name, icon: 'roundRect' })),
            left: size * 0.5,
            top: titled ? size + 10 : 2,
            selectedMode: false,
            itemWidth: Math.round(size * 0.9),
            itemHeight: Math.max(2, Math.round(size * 0.22)),
            itemGap: Math.round(size),
            textStyle: { color: theme.muted, fontSize: size, fontFamily: theme.fontFamily },
            formatter: (name: string): string => {
              const scale = scales.get(name)
              return scale === undefined || !(scale.lo <= scale.hi)
                ? name
                : `${name}  ${trimNumber(scale.lo)}–${trimNumber(scale.hi)}`
            },
          },
        }),
    ...(scale === null
      ? {}
      : {
          visualMap: {
            type: 'continuous',
            min: scale.vmin,
            max: scale.vmax,
            // Draggable handles: the colour bar stops being a caption and
            // becomes the clip control, which on a pileup with one hot cell is
            // the first thing a reader reaches for.
            calculable: true,
            realtime: true,
            orient: 'vertical',
            // **Beside the picture and as tall as it**, rather than against the
            // far edge at a fixed height. Both were wrong the moment the grid
            // stopped filling the box: a square pileup in a wide dialog left
            // the bar stranded a hand's width away from the cells it is the key
            // to, and a bar of twelve lines in a figure nine hundred tall is a
            // sliver nobody can drag a handle on.
            left: barAt,
            top: main.top + (main.height - barTall) / 2,
            itemWidth: Math.round(size * 0.9),
            itemHeight: Math.round(barTall),
            // The two ends of the scale, in **significant figures rather than
            // decimal places**. A balanced pileup runs between 0 and 0.0002,
            // and the library's own rounding printed both ends of that as `0`
            // — a colour bar saying the picture runs from nothing to nothing.
            formatter: (value: number): string => trimNumber(value),
            inRange: { color: rampOf(style.colormap ?? output.colormap) },
            textStyle: { color: theme.muted, fontSize: size, fontFamily: theme.fontFamily },
            // The series the bar is *about*: the marginal profiles are a second
            // quantity in their own units and colouring them by the matrix's
            // scale would be a claim nobody made.
            seriesIndex: 0,
          },
        }),
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: xGrids,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        filterMode: 'none',
        ...cellWindow(style.x.domain, output.ncols),
      },
      {
        type: 'inside',
        yAxisIndex: yGrids,
        zoomOnMouseWheel: 'shift',
        moveOnMouseMove: false,
        filterMode: 'none',
        ...cellWindow(style.y.domain, output.nrows),
      },
    ],
    tooltip: style.tooltip
      ? {
          trigger: 'item',
          backgroundColor: theme.background,
          borderColor: theme.grid,
          textStyle: { color: theme.ink, fontSize: size },
          formatter: cellTooltip(output),
        }
      : { show: false },
    series,
  }
}

/**
 * What the pointer says over a cell.
 *
 * The two labels and the value, and the labels are the **axis ticks** where the
 * output gave any: on a cis/trans matrix those are sequence names, which is the
 * whole answer to *which pair is this*; on a pileup they are offsets from the
 * anchor. Where there are none, the cell's own index, which is still better than
 * nothing — a reader counting rows can check it.
 */
export function cellTooltip(
  output: MatrixOutput,
): (params: { value?: unknown }) => string {
  const xLabels = spreadTicks(output.xTicks, output.ncols)
  const yLabels = spreadTicks(output.yTicks, output.nrows)
  return (params) => {
    const cell = params.value
    if (!Array.isArray(cell) || cell.length < 3) return ''
    const [col, flipped, value] = cell as [number, number, number]
    const row = output.nrows - 1 - flipped
    const xName = xLabels[col] !== '' ? xLabels[col] : `column ${col + 1}`
    const yName = yLabels[row] !== '' ? yLabels[row] : `row ${row + 1}`
    const shown = Math.abs(value) >= 1e-3 && Math.abs(value) < 1e6
      ? value.toFixed(3)
      : value.toExponential(2)
    return `${yName} · ${xName}<br/><b>${shown}</b>`
  }
}
