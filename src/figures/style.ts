/**
 * What the reader has decided about a figure, and where that decision is kept.
 *
 * The other half of `spec.ts`. A {@link FigureSpec} is the numbers; this is
 * everything about how they look — the mark, the axes, the colours, the legend,
 * which series is switched off, how a table is sorted. Two properties are worth
 * stating, because the whole design follows from them:
 *
 * **One flat record for every kind of figure.** A matrix has no line width and
 * a curve has no colormap, and both fields are here regardless. The alternative
 * is a discriminated union, which buys type safety over fields nobody reads and
 * costs a migration every time a figure gains a control — and, worse, makes the
 * stored shape depend on the kind, so a table that later becomes a scatter
 * cannot carry its own axis choice across. Flat and mostly-ignored is the
 * cheaper truth.
 *
 * **Every field is a decision, so every field is remembered.** Per file, per
 * task, per output, in the same `UiMemory` a task's parameters live in and for
 * the same reason (`analysis/memory.ts`): a reader who found the log axis that
 * shows what they are looking at should not have to find it again after
 * clicking a chromosome. What is stored is untrusted — a session outlives the
 * build that wrote it — so {@link sanitiseStyle} validates every field against
 * the spec it is about to be applied to.
 */

import { recall, remember } from '../state/UiMemory'
import { COLORMAP_NAMES } from '../render/colormaps'
import { XY_MARKS, DISTRIBUTION_MARKS, type AxisScale, type FigureSpec, type MarkKind } from './spec'

/** Where the legend sits, or that there is none. */
export type LegendPlace = 'right' | 'top' | 'bottom' | 'none'

export interface AxisStyle {
  scale: AxisScale
  /** The window shown, or `null` to fit whatever is visible. */
  domain: [number, number] | null
  /** A name the reader typed, or `null` for the task's. */
  label: string | null
  grid: boolean
}

export interface FigureStyle {
  // --- shared -------------------------------------------------------------
  /** A title the reader typed, or `null` for the output's own label. */
  title: string | null
  /** Base type size in CSS pixels; every other size is derived from it. */
  fontSize: number
  tooltip: boolean
  legend: LegendPlace

  // --- xy -----------------------------------------------------------------
  mark: MarkKind
  x: AxisStyle
  y: AxisStyle
  /** Series ids the reader has switched off. */
  hidden: string[]
  /** Series ids the reader has recoloured, over the task's own and the palette. */
  colours: Record<string, string>
  lineWidth: number
  pointSize: number
  /** A smoothed line, which is a claim about what is between the samples. */
  smooth: boolean
  /** Fill under a line, on top of whatever mark is chosen. */
  fillArea: boolean
  /** Draw the task's own band, where the series has one. */
  bands: boolean
  /** Bins for a histogram; `0` is Freedman–Diaconis on the data. */
  bins: number
  /** Show every point of a box or violin beside the summary. */
  jitter: boolean

  // --- matrix -------------------------------------------------------------
  colormap: string | null
  vmin: number | null
  vmax: number | null

  // --- table --------------------------------------------------------------
  sortKey: string | null
  sortDown: boolean
  filter: string
  /** Column keys shown, or `null` for all of them. */
  columns: string[] | null
  /**
   * The table drawn as a chart instead of as rows.
   *
   * `y` alone is a distribution; `x` and `y` together are a scatter, and `fit`
   * draws the least-squares line through it. `null` is the table itself, which
   * is what a table opens as.
   */
  plot: { x: string | null; y: string; mark: MarkKind; fit: boolean } | null
}

/** The figure as the task meant it, before the reader touched anything. */
export function defaultStyle(spec: FigureSpec): FigureStyle {
  const base: FigureStyle = {
    title: null,
    fontSize: 11,
    tooltip: true,
    legend: 'right',
    mark: 'line',
    x: { scale: 'linear', domain: null, label: null, grid: true },
    y: { scale: 'linear', domain: null, label: null, grid: true },
    hidden: [],
    colours: {},
    lineWidth: 1.8,
    pointSize: 6,
    smooth: false,
    fillArea: false,
    bands: true,
    bins: 0,
    jitter: false,
    colormap: null,
    vmin: null,
    vmax: null,
    sortKey: null,
    sortDown: false,
    filter: '',
    columns: null,
    plot: null,
  }
  if (spec.kind === 'xy') {
    base.mark = spec.mark
    base.x = { scale: spec.xScale, domain: domainOf(spec.xDomain), label: null, grid: true }
    base.y = { scale: spec.yScale, domain: domainOf(spec.yDomain), label: null, grid: true }
    // One series needs no legend, and a legend naming one line is a column of
    // the figure's width spent on a word already in the axis title.
    base.legend = spec.series.length > 1 ? 'right' : 'none'
    base.fillArea = spec.mark === 'area'
  }
  if (spec.kind === 'matrix') {
    base.colormap = spec.output.colormap
    base.vmin = spec.output.range?.[0] ?? null
    base.vmax = spec.output.range?.[1] ?? null
    base.legend = 'none'
  }
  return base
}

function domainOf(pair: readonly number[] | undefined): [number, number] | null {
  return pair === undefined ? null : [pair[0], pair[1]]
}

// ---------------------------------------------------------------------------
// Reading back what was stored
// ---------------------------------------------------------------------------

const MARKS: readonly MarkKind[] = [...XY_MARKS, ...DISTRIBUTION_MARKS]
const PLACES: readonly LegendPlace[] = ['right', 'top', 'bottom', 'none']

function one<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function number(value: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < lo ? lo : value > hi ? hi : value
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [lo, hi] = value
  if (typeof lo !== 'number' || typeof hi !== 'number') return null
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null
  return [lo, hi]
}

function axis(value: unknown, fallback: AxisStyle): AxisStyle {
  if (typeof value !== 'object' || value === null) return fallback
  const raw = value as Record<string, unknown>
  return {
    scale: one(raw['scale'], ['linear', 'log'] as const, fallback.scale),
    domain: pair(raw['domain']),
    label: typeof raw['label'] === 'string' ? raw['label'] : null,
    grid: flag(raw['grid'], fallback.grid),
  }
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * A stored style, checked against the figure it is about to be applied to.
 *
 * Every field falls back to the default rather than to whatever was in storage,
 * and the defaults come from the spec — so a curve whose series were renamed
 * between builds comes back with its axes and its mark and without a set of
 * hidden names that no longer match anything.
 */
export function sanitiseStyle(raw: unknown, spec: FigureSpec): FigureStyle {
  const base = defaultStyle(spec)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const stored = raw as Record<string, unknown>

  const colours: Record<string, string> = {}
  const rawColours = stored['colours']
  if (typeof rawColours === 'object' && rawColours !== null && !Array.isArray(rawColours)) {
    for (const [key, value] of Object.entries(rawColours as Record<string, unknown>)) {
      if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) colours[key] = value
    }
  }

  const columnKeys = spec.kind === 'table' ? spec.columns.map((column) => column.key) : []
  const storedColumns = names(stored['columns']).filter((key) => columnKeys.includes(key))
  const plot = plotOf(stored['plot'], columnKeys)

  return {
    title: typeof stored['title'] === 'string' ? stored['title'] : base.title,
    fontSize: number(stored['fontSize'], base.fontSize, 7, 24),
    tooltip: flag(stored['tooltip'], base.tooltip),
    legend: one(stored['legend'], PLACES, base.legend),
    mark: one(stored['mark'], MARKS, base.mark),
    x: axis(stored['x'], base.x),
    y: axis(stored['y'], base.y),
    hidden: names(stored['hidden']),
    colours,
    lineWidth: number(stored['lineWidth'], base.lineWidth, 0.25, 8),
    pointSize: number(stored['pointSize'], base.pointSize, 1, 30),
    smooth: flag(stored['smooth'], base.smooth),
    fillArea: flag(stored['fillArea'], base.fillArea),
    bands: flag(stored['bands'], base.bands),
    bins: Math.round(number(stored['bins'], base.bins, 0, 400)),
    jitter: flag(stored['jitter'], base.jitter),
    colormap:
      typeof stored['colormap'] === 'string' && COLORMAP_NAMES.includes(stored['colormap'])
        ? stored['colormap']
        : base.colormap,
    vmin: typeof stored['vmin'] === 'number' && Number.isFinite(stored['vmin']) ? stored['vmin'] : base.vmin,
    vmax: typeof stored['vmax'] === 'number' && Number.isFinite(stored['vmax']) ? stored['vmax'] : base.vmax,
    sortKey:
      typeof stored['sortKey'] === 'string' && columnKeys.includes(stored['sortKey'])
        ? stored['sortKey']
        : base.sortKey,
    sortDown: flag(stored['sortDown'], base.sortDown),
    filter: typeof stored['filter'] === 'string' ? stored['filter'] : base.filter,
    columns: storedColumns.length === 0 ? base.columns : storedColumns,
    plot,
  }
}

function plotOf(
  value: unknown,
  columnKeys: readonly string[],
): FigureStyle['plot'] {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const y = raw['y']
  if (typeof y !== 'string' || !columnKeys.includes(y)) return null
  const x = raw['x']
  return {
    x: typeof x === 'string' && columnKeys.includes(x) ? x : null,
    y,
    mark: one(raw['mark'], MARKS, 'points'),
    fit: flag(raw['fit'], false),
  }
}

// ---------------------------------------------------------------------------
// Per-file memory
// ---------------------------------------------------------------------------

/**
 * The one scope every figure's style lives in.
 *
 * One scope with the figure's key *inside* it, exactly as `ANALYSIS_SCOPE`
 * holds every task's parameters, and for the same reason: `state/SessionConfig`
 * gathers a session by reading a fixed list of scopes, and a scope named after
 * an output could not be on that list. Named in `SessionConfig`'s `SCOPES`; do
 * not rename lightly.
 */
export const FIGURES_SCOPE = 'analysis:figures'

/** Every figure's style on one file, by `task::output`. */
export type FigureMemory = Record<string, unknown>

/**
 * The key one figure hangs on: the task and the output within it.
 *
 * Not the run. A task re-run with a different window produces the same outputs
 * under the same ids, and a style that reset on every run would be a style
 * nobody could keep — which is the whole of what "remember it" means here.
 */
export function figureKey(task: string, outputId: string): string {
  return `${task}::${outputId}`
}

export function readFigureMemory(uri: string): FigureMemory {
  const raw = recall<unknown>(uri, FIGURES_SCOPE)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as FigureMemory
}

/** The style `task`'s `outputId` was last left in on `uri`, validated. */
export function recallStyle(
  uri: string,
  task: string,
  spec: FigureSpec,
): FigureStyle {
  return sanitiseStyle(readFigureMemory(uri)[figureKey(task, spec.id)], spec)
}

/**
 * Record how a figure was left.
 *
 * Read-modify-write, because the scope is shared: writing one figure's entry
 * without the others would drop every other figure on the file.
 */
export function rememberStyle(
  uri: string,
  task: string,
  outputId: string,
  style: FigureStyle,
): void {
  const all = readFigureMemory(uri)
  all[figureKey(task, outputId)] = style
  remember(uri, FIGURES_SCOPE, all)
}

/** Forget one figure's style, which is what a reset means across a reload. */
export function forgetStyle(uri: string, task: string, outputId: string): void {
  const all = readFigureMemory(uri)
  delete all[figureKey(task, outputId)]
  remember(uri, FIGURES_SCOPE, all)
}
