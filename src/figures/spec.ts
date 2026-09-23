/**
 * What a figure is *of*, apart from how it is drawn.
 *
 * A task returns a {@link TaskOutput} — a curve, a profile, a matrix, a table —
 * and for a long time each of those went straight to a painter that knew both
 * the data and every decision about how it should look. That worked while the
 * decisions were the task's. It stops working the moment they are the reader's:
 * a figure that can be restyled needs somewhere for the style to live that is
 * not the data, and somewhere for the data to live that a change of style does
 * not rewrite.
 *
 * So this is the data half. A {@link FigureSpec} is the output turned into the
 * plainest thing that can be plotted — numbers, names, labels, and the task's
 * *suggestions* about scale and window — and nothing about colour, line width,
 * legend placement or which series is switched off. Those are `style.ts`, and
 * the pair is what a figure is built from.
 *
 * Three shapes, because there are three genuinely different pictures:
 *
 * - **xy** — one or more series over a shared pair of axes. A curve, a profile,
 *   a scatter, a histogram and a box plot are all this; which of them it *looks*
 *   like is a mark, and a mark is a style.
 * - **matrix** — a small dense grid. It carries the {@link MatrixOutput} itself
 *   rather than a decomposition of it, because a matrix is still drawn by
 *   `ui/analysisPlots.ts` and always will be: it is a raster, the app already
 *   has the rasteriser the contact maps use, and a chart library redrawing it
 *   would be a second answer to a question that has one.
 * - **table** — rows and columns, which is a picture too once you can sort it,
 *   filter it and plot a column against another.
 */

import { profileCurve } from '../ui/analysisPlots'
import type {
  CurveOutput,
  MatrixOutput,
  ProfileOutput,
  TableColumn,
  TaskOutput,
} from '../analysis/types'

/** How a series is drawn. The task suggests one; the reader decides. */
export type MarkKind =
  | 'line'
  | 'area'
  | 'step'
  | 'points'
  | 'bars'
  | 'histogram'
  | 'box'
  | 'violin'

export type AxisScale = 'linear' | 'log'

/** The marks that make sense for a series of (x, y) pairs, in menu order. */
export const XY_MARKS: readonly MarkKind[] = ['line', 'area', 'step', 'points', 'bars']

/** The marks that summarise a *distribution* and so ignore the x values. */
export const DISTRIBUTION_MARKS: readonly MarkKind[] = ['histogram', 'box', 'violin']

/**
 * The marks that turn the *series* into the abscissa.
 *
 * A box and a violin are one shape per sample side by side, so the axis under
 * them is a list of names. A histogram is not: it keeps a number line, and what
 * it puts on it is the values themselves — which is why it summarises a
 * distribution and still belongs on an ordinary pair of axes.
 */
export const CATEGORY_MARKS: readonly MarkKind[] = ['box', 'violin']

export interface FigureSeries {
  /**
   * The key a style hangs on: a hidden series, a recoloured one.
   *
   * The name, unless two series share one. A style is remembered across runs
   * (`figures/style.ts`), so this has to be stable from one run of the same task
   * to the next — which the name is and the index is not, since a task that
   * drops an empty chromosome would otherwise shift everyone's colour.
   */
  id: string
  name: string
  x: number[]
  y: number[]
  /** The band, where the task computed one; both ends or neither. */
  low?: number[]
  high?: number[]
  /** The task's own colour, where it had an opinion. */
  colour?: string
  /** Observations behind the line, for the legend. */
  n?: number
  /** What the task thinks this is; overridden by the style. */
  mark?: MarkKind
  /** The stack this series shares, where the bars are parts of one whole. */
  stack?: string
}

export interface FigureStat {
  label: string
  value: number
  digits?: number
  hint?: string
}

export interface XyFigureSpec {
  kind: 'xy'
  id: string
  label: string
  xLabel: string
  yLabel: string
  series: FigureSeries[]
  /** The scales the task opens on. */
  xScale: AxisScale
  yScale: AxisScale
  /** The window the task opens on, absent to fit the data. */
  xDomain?: [number, number]
  yDomain?: [number, number]
  /** The mark the task opens on, where no series names its own. */
  mark: MarkKind
  /**
   * Base pairs per x unit, when x is a bin index.
   *
   * Only a profile has one, and it is what lets the axis be labelled in
   * megabases rather than in bin numbers — the same quantity, in the units the
   * reader navigates by.
   */
  binsize?: number
  /**
   * What the points of the abscissa are called, where they are a list.
   *
   * The same quantity {@link binsize} is: a spelling for a numeric axis, so the
   * axis keeps its wheel, its marquee and its typed window and the names are
   * drawn at the ticks (`CurveOutput.xTicks`).
   */
  xTicks?: string[]
  stats?: FigureStat[]
}

export interface MatrixFigureSpec {
  kind: 'matrix'
  id: string
  label: string
  /** Untouched: the existing rasteriser draws this, as it draws a contact map. */
  output: MatrixOutput
}

export interface TableFigureSpec {
  kind: 'table'
  id: string
  label: string
  columns: TableColumn[]
  rows: Array<Record<string, string | number>>
}

export type FigureSpec = XyFigureSpec | MatrixFigureSpec | TableFigureSpec

/**
 * An output as something plottable, or `null` where it is not a picture.
 *
 * `intervals` is the `null`: a set of coordinates is an overlay on the map it
 * was called from, and the drawer says so rather than drawing it twice.
 */
export function specOf(output: TaskOutput): FigureSpec | null {
  switch (output.kind) {
    case 'curve':
      return xyOfCurve(output)
    case 'profile':
      return xyOfProfile(output)
    case 'matrix':
      return { kind: 'matrix', id: output.id, label: output.label, output }
    case 'table':
      return {
        kind: 'table',
        id: output.id,
        label: output.label,
        columns: output.columns,
        rows: output.rows,
      }
    default:
      return null
  }
}

/** Series names, made unique, so a style can name one of them. */
function keyed(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}#${count + 1}`
  })
}

/** Typed arrays as plain ones, since that is what a chart library reads. */
function plain(values: ArrayLike<number> | undefined): number[] | undefined {
  return values === undefined ? undefined : Array.from(values)
}

function xyOfCurve(output: CurveOutput): XyFigureSpec {
  const ids = keyed(output.series.map((series) => series.name))
  // The mark the *figure* opens on: a task that drew every series as points
  // meant a scatter, one that drew all of them as bars meant a bar chart, one
  // that made every series a sample meant violins, and one that drew none of
  // them meant lines. Unanimity rather than the first
  // series' opinion, because a figure-wide mark is what the reader's control
  // sets and a mixed set has no single answer to open on.
  const every = (mark: MarkKind): boolean =>
    output.series.length > 0 && output.series.every((series) => series.mark === mark)
  const opening: MarkKind = every('points')
    ? 'points'
    : every('bars')
      ? 'bars'
      : every('violin')
        ? 'violin'
        : 'line'
  return {
    kind: 'xy',
    id: output.id,
    label: output.label,
    xLabel: output.xLabel,
    yLabel: output.yLabel,
    xScale: output.xScale,
    yScale: output.yScale,
    xDomain: output.xDomain === undefined ? undefined : [...output.xDomain],
    yDomain: output.yDomain === undefined ? undefined : [...output.yDomain],
    mark: opening,
    xTicks: output.xTicks === undefined ? undefined : [...output.xTicks],
    stats: undefined,
    series: output.series.map((series, index) => ({
      id: ids[index],
      name: series.name,
      x: Array.from(series.x),
      y: Array.from(series.y),
      low: plain(series.low),
      high: plain(series.high),
      colour: series.colour,
      n: series.n,
      // `points` and nothing else. A series' own mark *overrides* the reader's
      // control (see {@link markOf}), which is what a scatter among curves
      // needs and what a set of bars must not have: every series of a bar chart
      // is a bar, so the opinion belongs to the figure — where the mark control
      // can then take it away again.
      mark: series.mark === 'points' ? 'points' : undefined,
      stack: series.stack,
    })),
  }
}

/**
 * A per-bin profile as a curve over the bins it covers.
 *
 * Through {@link profileCurve}, which is the same reduction the drawer has
 * always used: a whole-genome profile is millions of bins and a figure is a
 * thousand pixels wide, so it is bucketed to a few thousand points with the
 * bucket's min and max kept as a band. Doing it here rather than in the chart
 * means the PNG, the PDF and the screen are the same picture, and that the
 * reduction is visible in one place rather than hidden in a renderer's
 * downsampling.
 */
function xyOfProfile(output: ProfileOutput): XyFigureSpec {
  const spec = xyOfCurve(profileCurve(output))
  spec.binsize = output.binsize
  return spec
}

/**
 * The columns of a table that could be an axis.
 *
 * Number columns, because a scatter of two text columns is a picture of
 * nothing; the *categorical* case is a bar chart, which takes a text column for
 * x and is offered separately.
 */
export function numericColumns(spec: TableFigureSpec): TableColumn[] {
  return spec.columns.filter((column) => column.kind === 'number')
}

/**
 * A table as an xy figure: one column against another.
 *
 * The rows that have a number in both columns, in table order. A row missing
 * either is dropped rather than plotted at zero — a MAG with no completeness is
 * not a MAG that is 0% complete.
 */
export function xyOfTable(
  spec: TableFigureSpec,
  xKey: string,
  yKey: string,
  mark: MarkKind,
): XyFigureSpec {
  const x: number[] = []
  const y: number[] = []
  for (const row of spec.rows) {
    const a = Number(row[xKey])
    const b = Number(row[yKey])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    x.push(a)
    y.push(b)
  }
  const label = (key: string): string =>
    spec.columns.find((column) => column.key === key)?.label ?? key
  return {
    kind: 'xy',
    id: `${spec.id}:${xKey}:${yKey}`,
    label: spec.label,
    xLabel: label(xKey),
    yLabel: label(yKey),
    xScale: 'linear',
    yScale: 'linear',
    mark,
    series: [{ id: yKey, name: label(yKey), x, y }],
  }
}

/**
 * One numeric column as a distribution.
 *
 * `x` is the row index and carries no meaning: a histogram, a box and a violin
 * are all summaries of `y` alone, and pretending otherwise would put an axis on
 * the picture that says something untrue. The *column* is therefore the
 * ordinate's name, not the abscissa's — which is what puts it on the right axis
 * once a histogram turns it sideways and counts it.
 */
export function distributionOfTable(
  spec: TableFigureSpec,
  key: string,
  mark: MarkKind,
): XyFigureSpec {
  const y: number[] = []
  for (const row of spec.rows) {
    const value = Number(row[key])
    if (Number.isFinite(value)) y.push(value)
  }
  const column = spec.columns.find((entry) => entry.key === key)
  return {
    kind: 'xy',
    id: `${spec.id}:${key}`,
    label: spec.label,
    xLabel: 'row',
    yLabel: column?.label ?? key,
    xScale: 'linear',
    yScale: 'linear',
    mark,
    series: [{ id: key, name: column?.label ?? key, x: y.map((_, index) => index), y }],
  }
}

/** Whether a mark ignores x and summarises y on its own. */
export function isDistribution(mark: MarkKind): boolean {
  return DISTRIBUTION_MARKS.includes(mark)
}

/** Whether a mark puts the series' names on the abscissa. */
export function isCategorical(mark: MarkKind): boolean {
  return CATEGORY_MARKS.includes(mark)
}

/** The finite values of a series, for a domain or a summary. */
export function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value))
}
