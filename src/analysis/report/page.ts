/**
 * The map report as one HTML page: everything the run produced, laid out to be
 * read, in a file that needs nothing beside it.
 *
 * Written from the {@link TaskResult} alone — no DOM, no chart library — so the
 * drawer's button and `chromosomix mapreport` produce the same bytes, and the
 * page opens years later in any browser with no network. It is a small
 * document application:
 *
 * - **tabs**, one per question — an overview, the library, the resolutions,
 *   P(s), coverage, cis and trans, and how the numbers were made — each
 *   addressable (`#resolutions`) and walked with the arrow keys;
 * - **figures that answer the pointer**: a guide line and a card with every
 *   series' value at the nearest point, a legend whose chips hide and show a
 *   series, and each figure saved as SVG or its numbers as TSV;
 * - **tables** sorted by a click on a column and, past a dozen rows, filtered by
 *   a box, each saved as TSV;
 * - light and dark, the reader's system's or chosen and remembered, and a print
 *   that lays every tab out one after another.
 *
 * The one script is inline and small, and the page degrades without it: every
 * tab stacked, every value still under the pointer as an SVG `<title>`.
 *
 * Numbers only, as the run is (`tasks/mapreport.ts`): no colour on the page
 * says good or bad.
 */

import { provenanceLines } from '../write/tsv'
import type { CurveOutput, CurveSeries, TableColumn, TableOutput, TaskOutput, TaskResult } from '../types'

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A note as the drawer writes one, its `code` spans set as code. */
function prose(text: string): string {
  return escape(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

const GROUPED = new Intl.NumberFormat('en-US')

/** A count or a measure as the app prints one: grouped, to the column's digits. */
function number(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

/** A fraction as a percentage, §26.2's spelling of a share on a summary. */
function percent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${number(value * 100, value * 100 < 1 && value > 0 ? 3 : value * 100 < 10 ? 2 : 1)} %`
}

/** A length in base pairs, at the largest unit it is a whole number of. */
function bp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1e6 && value % 1e5 === 0) return `${GROUPED.format(value / 1e6)} Mb`
  if (value >= 1e3 && value % 100 === 0) return `${GROUPED.format(value / 1e3)} kb`
  return `${GROUPED.format(value)} bp`
}

/** A separation read off a curve, rounded as a reader says one: `4.8 kb`, `1.25 Mb`. */
function bpAbout(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1e6) return `${number(value / 1e6, 2)} Mb`
  if (value >= 1e4) return `${number(value / 1e3, 0)} kb`
  if (value >= 1e3) return `${number(value / 1e3, 1)} kb`
  return `${number(value, 0)} bp`
}

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
}

/** A value in a tooltip: grouped where it is large, in powers of ten where it is tiny. */
function valueText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 1e-3) {
    const exponent = Math.floor(Math.log10(abs))
    const power = String(exponent).replace(/./g, (c) => SUPERSCRIPT[c] ?? c)
    return `${number(value / 10 ** exponent, 2)} × 10${power}`
  }
  if (abs >= 100) return number(value, 0)
  if (abs >= 1) return number(value, 2)
  return number(value, 4)
}

/** A tick label: a length where the axis is one, a short number otherwise. */
function tick(value: number, unit: 'bp' | 'number', log = false): string {
  if (unit === 'bp') return bp(value)
  const abs = Math.abs(value)
  // On a logarithmic axis every decade from a thousand up is a power of ten,
  // so the labels up one axis are all of one form.
  const decade = log && abs > 0 && Math.abs(Math.log10(abs) - Math.round(Math.log10(abs))) < 1e-9
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6 || (decade && abs >= 1e3))) {
    const exponent = Math.floor(Math.log10(abs))
    const mantissa = value / 10 ** exponent
    const head = Math.abs(mantissa - 1) < 1e-9 ? '' : `${number(mantissa, 1)}×`
    return `${head}10<tspan dy="-0.5em" font-size="0.75em">${exponent}</tspan>`
  }
  return GROUPED.format(Number(value.toPrecision(3)))
}

/** An id a page can use: letters, digits and dashes. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

// ---------------------------------------------------------------------------
// What a page is built from
// ---------------------------------------------------------------------------

/** One file a button on the page saves: its name and its text. */
interface Download {
  name: string
  type: string
  text: string
}

/** What the script needs of one interactive figure: each series' points, placed and labelled. */
interface ChartData {
  x: string
  series: Array<{ name: string; slot: number; points: Array<[number, number, string, string]> }>
}

interface Page {
  sample: string
  downloads: Record<string, Download>
  charts: Record<string, ChartData>
  count: number
}

function newId(page: Page, stem: string): string {
  page.count += 1
  return `${slug(stem)}-${page.count}`
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** A figure's canvas, the width of the page's column, so its words are drawn at their own size there. */
const WIDTH = 990
/** A thumbnail's canvas: narrower, so that its words are drawn at a size that can be read. */
const BARE_WIDTH = 520
const MARGIN = { left: 84, right: 24, top: 18, bottom: 50 }

interface Scale {
  at(value: number): number
  ticks: number[]
}

function scale(lo: number, hi: number, log: boolean, from: number, to: number): Scale {
  if (log) {
    const a = Math.log10(lo)
    const b = Math.log10(hi)
    const span = b - a || 1
    const ticks: number[] = []
    const step = Math.max(1, Math.ceil((Math.floor(b) - Math.ceil(a) + 1) / 7))
    for (let k = Math.ceil(a); k <= Math.floor(b); k += step) ticks.push(10 ** k)
    // Under two decades the decades alone are one or two labels: the 2s and
    // 5s between them are labelled too.
    if (b - a < 2) {
      for (let k = Math.floor(a); k <= Math.ceil(b); k++) {
        for (const m of [2, 5]) {
          const value = m * 10 ** k
          if (value >= lo && value <= hi) ticks.push(value)
        }
      }
      ticks.sort((p, q) => p - q)
    }
    return { at: (value) => from + ((Math.log10(value) - a) / span) * (to - from), ticks }
  }
  const span = hi - lo || 1
  const raw = span / 5
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => span / s <= 6) ?? 10 * magnitude
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)))
  return { at: (value) => from + ((value - lo) / span) * (to - from), ticks }
}

/** The extent of the finite values, and of the positive ones where the axis is logarithmic. */
function extent(values: number[], log: boolean): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value) || (log && value <= 0)) continue
    lo = Math.min(lo, value)
    hi = Math.max(hi, value)
  }
  if (!(lo <= hi)) return null
  if (lo === hi) return log ? [lo / 2, hi * 2] : [lo - 1, hi + 1]
  return [lo, hi]
}

interface FigureOptions {
  xUnit?: 'bp' | 'number'
  yZero?: boolean
  height?: number
  /** A sentence under the title saying how to read the figure. */
  caption?: string
  /** A bare figure: no title, no buttons — the overview's thumbnails. */
  bare?: boolean
}

/** The long table a figure's TSV holds: a row per point, each series named. */
function curveTsv(curve: CurveOutput): string {
  const lines = [`# ${curve.label}`, ['series', curve.xLabel, curve.yLabel].join('\t')]
  for (const series of curve.series) {
    for (let k = 0; k < series.x.length; k++) {
      const name = curve.xTicks?.[k] ?? String(series.x[k])
      lines.push([series.name, name, Number.isFinite(series.y[k]) ? String(series.y[k]) : ''].join('\t'))
    }
  }
  return `${lines.join('\n')}\n`
}

/** A curve as an SVG figure in a card: lines, points or bars, a series per colour, in fixed order. */
function curveFigure(page: Page, curve: CurveOutput, options: FigureOptions = {}): string {
  const id = newId(page, curve.id)
  const height = options.height ?? 320
  const width = options.bare === true ? BARE_WIDTH : WIDTH
  const xLog = curve.xScale === 'log'
  const yLog = curve.yScale === 'log'
  const inX = (x: number): boolean => curve.xDomain === undefined || (x >= curve.xDomain[0] && x <= curve.xDomain[1])
  const series = curve.series.slice(0, 8)
  const xs: number[] = []
  const ys: number[] = []
  for (const s of series) {
    for (let k = 0; k < s.x.length; k++) {
      if (!inX(s.x[k])) continue
      xs.push(s.x[k])
      ys.push(s.y[k])
    }
  }
  let xr = curve.xDomain ?? extent(xs, xLog)
  let yr = curve.yDomain ?? extent(ys, yLog)
  if (xr === null || yr === null) return ''
  // A point or a bar on the edge of the domain is drawn whole: the domain a
  // figure fits itself to is widened by a little, a declared one is not.
  const pad = (range: [number, number], log: boolean, by: number): [number, number] =>
    log ? [range[0] / (1 + by), range[1] * (1 + by)] : [range[0] - (range[1] - range[0]) * by, range[1] + (range[1] - range[0]) * by]
  const marked = series.some((s) => s.mark === 'points' || s.mark === 'bars')
  if (curve.xDomain === undefined && marked) xr = pad(xr, xLog, 0.06)
  if (curve.yDomain === undefined) yr = pad(yr, yLog, marked ? 0.08 : 0.03)
  if (options.yZero === true && !yLog) yr = [Math.min(0, yr[0]), yr[1]]
  const left = options.bare === true ? 56 : MARGIN.left
  const right = width - MARGIN.right
  const top = MARGIN.top
  const bottom = height - MARGIN.bottom
  const x = scale(xr[0], xr[1], xLog, left, right)
  const y = scale(yr[0], yr[1], yLog, bottom, top)
  const xUnit = options.xUnit ?? (/\(bp\)/.test(curve.xLabel) ? 'bp' : 'number')
  const xText = (value: number): string => (xUnit === 'bp' ? bpAbout(value) : valueText(value))

  const parts: string[] = []
  for (const t of y.ticks) {
    const py = y.at(t)
    parts.push(`<line class="grid" x1="${left}" x2="${right}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}"/>`)
    parts.push(`<text class="tick" x="${left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end">${tick(t, 'number', yLog)}</text>`)
  }
  for (const t of x.ticks) {
    const px = x.at(t)
    parts.push(`<line class="axis" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${bottom}" y2="${bottom + 5}"/>`)
    parts.push(`<text class="tick" x="${px.toFixed(1)}" y="${bottom + 20}" text-anchor="middle">${tick(t, xUnit, xLog)}</text>`)
  }
  parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`)
  parts.push(`<text class="label" x="${(left + right) / 2}" y="${height - 8}" text-anchor="middle">${escape(curve.xLabel)}</text>`)
  // A thumbnail's title names its ordinate, and a rotated label longer than
  // a short plot would run off both its ends.
  if (options.bare !== true) {
    parts.push(
      `<text class="label" transform="translate(16 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle">${escape(curve.yLabel)}</text>`,
    )
  }

  const valid = (s: CurveSeries, k: number): boolean =>
    inX(s.x[k]) && Number.isFinite(s.y[k]) && (!yLog || s.y[k] > 0) && (!xLog || s.x[k] > 0)
  const data: ChartData = { x: curve.xLabel, series: [] }
  series.forEach((s, index) => {
    const slot = index + 1
    const colour = `var(--series-${slot})`
    const mark = s.mark ?? 'line'
    const group: string[] = []
    const points: Array<[number, number, string, string]> = []
    if (mark === 'bars') {
      const n = s.x.length
      const width = Math.max(2, ((right - left) / Math.max(1, n)) * 0.78)
      const base = yLog ? bottom : y.at(Math.max(yr![0], 0))
      for (let k = 0; k < n; k++) {
        if (!valid(s, k)) continue
        const px = x.at(s.x[k])
        const py = y.at(s.y[k])
        const tip = `around ${xText(s.x[k])}: ${valueText(s.y[k])} ${curve.yLabel.toLowerCase()}`
        group.push(
          `<rect class="bar" fill="${colour}" x="${(px - width / 2).toFixed(1)}" y="${Math.min(py, base).toFixed(1)}" ` +
            `width="${width.toFixed(1)}" height="${Math.max(0.5, Math.abs(base - py)).toFixed(1)}" rx="2" data-tip="${escape(tip)}">` +
            `<title>${escape(tip)}</title></rect>`,
        )
      }
    } else {
      if (mark === 'line' || mark === 'points') {
        let path = ''
        let pen = false
        for (let k = 0; k < s.x.length; k++) {
          if (!valid(s, k)) {
            pen = false
            continue
          }
          path += `${pen ? 'L' : 'M'}${x.at(s.x[k]).toFixed(1)},${y.at(s.y[k]).toFixed(1)}`
          pen = true
        }
        // Points are joined faintly, so a run of them reads as the trend it is.
        const kind = mark === 'points' ? ' joint' : s.x.length > 400 ? ' dense' : ''
        group.push(`<path class="line${kind}" stroke="${colour}" d="${path}"/>`)
      }
      for (let k = 0; k < s.x.length; k++) {
        if (!valid(s, k)) continue
        const px = x.at(s.x[k])
        const py = y.at(s.y[k])
        points.push([Number(px.toFixed(1)), Number(py.toFixed(1)), xText(s.x[k]), valueText(s.y[k])])
        if (mark === 'points') {
          group.push(
            `<circle class="dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5.5" fill="${colour}">` +
              `<title>${escape(s.name)} · ${escape(xText(s.x[k]))}: ${escape(valueText(s.y[k]))}</title></circle>`,
          )
        }
      }
      data.series.push({ name: s.name, slot, points })
    }
    parts.push(`<g class="series" data-series="${index}">${group.join('')}</g>`)
  })
  if (data.series.length > 0) page.charts[id] = data

  const svg =
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(curve.label)}" ` +
    `data-plot="${left},${top},${right},${bottom}">${parts.join('')}</svg>`
  if (options.bare === true) return `<div class="chart" data-chart="${id}">${svg}<div class="tip" hidden></div></div>`

  page.downloads[`${id}-tsv`] = { name: `${page.sample}.${curve.id}.tsv`, type: 'text/tab-separated-values', text: curveTsv(curve) }
  const legend =
    series.length > 1
      ? `<div class="legend" role="group" aria-label="Series">${series
          .map(
            (s, index) =>
              `<button type="button" class="chip" data-series="${index}" aria-pressed="true">` +
              `<span class="key" style="background:var(--series-${index + 1})"></span>${escape(s.name)}</button>`,
          )
          .join('')}</div>`
      : ''
  const more =
    curve.series.length > series.length
      ? `<p class="fine">The first ${series.length} of ${curve.series.length} lines are drawn; every one is in the TSV.</p>`
      : ''
  return card(
    curve.label,
    options.caption,
    [action('svg', `${id}`, 'SVG', `${page.sample}.${curve.id}.svg`), action('tsv', `${id}-tsv`, 'TSV')],
    `${legend}<div class="chart" data-chart="${id}">${svg}<div class="tip" hidden></div></div>${more}`,
  )
}

/** One bar per named value on a shared axis from 0 to 1: the cis fraction of each sequence. */
function namedBars(page: Page, curve: CurveOutput): string {
  const s = curve.series[0]
  const names = curve.xTicks ?? []
  const n = s?.y.length ?? 0
  if (n === 0) return ''
  const id = newId(page, curve.id)
  const rowHeight = 22
  const left = 150
  const right = WIDTH - 70
  const height = n * rowHeight + 40
  const x = scale(0, 1, false, left, right)
  const parts: string[] = []
  for (const t of x.ticks) {
    const px = x.at(t)
    parts.push(`<line class="grid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="4" y2="${height - 30}"/>`)
    parts.push(`<text class="tick" x="${px.toFixed(1)}" y="${height - 12}" text-anchor="middle">${number(t * 100)} %</text>`)
  }
  for (let k = 0; k < n; k++) {
    const value = s.y[k]
    const top = 6 + k * rowHeight
    const name = names[k] ?? String(k + 1)
    parts.push(`<text class="tick" x="${left - 10}" y="${top + 14}" text-anchor="end">${escape(name)}</text>`)
    if (!Number.isFinite(value)) {
      parts.push(`<text class="value" x="${left + 6}" y="${top + 14}">no contacts</text>`)
      continue
    }
    const width = Math.max(1, x.at(value) - left)
    const tip = `${name}: ${percent(value)} of its contacts are cis`
    parts.push(
      `<rect class="bar" fill="var(--series-1)" x="${left}" y="${top + 3}" width="${width.toFixed(1)}" height="${rowHeight - 7}" rx="3" data-tip="${escape(tip)}">` +
        `<title>${escape(tip)}</title></rect>`,
    )
    parts.push(`<text class="value" x="${(left + width + 8).toFixed(1)}" y="${top + 14}">${percent(value)}</text>`)
  }
  page.downloads[`${id}-tsv`] = { name: `${page.sample}.${curve.id}.tsv`, type: 'text/tab-separated-values', text: curveTsv(curve) }
  return card(
    curve.label,
    'Of the contacts touching each sequence, the share that stays on it.',
    [action('svg', id, 'SVG', `${page.sample}.${curve.id}.svg`), action('tsv', `${id}-tsv`, 'TSV')],
    `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escape(curve.label)}">${parts.join('')}</svg><div class="tip" hidden></div></div>`,
  )
}

// ---------------------------------------------------------------------------
// Cards, tables, tiles
// ---------------------------------------------------------------------------

/** A button the script answers: save an SVG of a figure, or a file the page holds. */
function action(kind: 'svg' | 'tsv', target: string, label: string, name = ''): string {
  return (
    `<button type="button" class="ghost" data-${kind}="${escape(target)}"${name ? ` data-name="${escape(name)}"` : ''} ` +
    `title="Save ${label === 'SVG' ? 'this figure as an SVG' : 'these numbers as a TSV'}">${ICON.download}${label}</button>`
  )
}

function card(title: string, caption: string | undefined, actions: string[], body: string): string {
  return (
    `<article class="card"><header class="card-head"><div><h3>${escape(title)}</h3>` +
    `${caption ? `<p class="caption">${caption}</p>` : ''}</div>` +
    `<div class="actions">${actions.join('')}</div></header>${body}</article>`
  )
}

/** Columns that hold a fraction, printed as a percentage. */
const FRACTIONS = new Set(['share', 'empty', 'belowTenthMedian', 'fraction'])

/** The most rows a table is printed with; the TSV holds the rest. */
const MAX_ROWS = 500

function cell(column: TableColumn, value: string | number | undefined): string {
  if (value === undefined || value === '') return '<td></td>'
  if (column.kind === 'text') return `<td data-v="${escape(String(value))}">${escape(String(value))}</td>`
  const n = Number(value)
  const sort = Number.isFinite(n) ? String(n) : ''
  if (FRACTIONS.has(column.key)) return `<td class="num" data-v="${sort}">${percent(n)}</td>`
  if (column.key === 'binsize') return `<td class="num" data-v="${sort}">${bp(n)}</td>`
  return `<td class="num" data-v="${sort}">${number(n, column.digits ?? 0)}</td>`
}

function tableTsv(output: TableOutput): string {
  const lines = [`# ${output.label}`, output.columns.map((c) => c.label).join('\t')]
  for (const row of output.rows) {
    lines.push(output.columns.map((c) => (row[c.key] === undefined ? '' : String(row[c.key]))).join('\t'))
  }
  return `${lines.join('\n')}\n`
}

function tableCard(
  page: Page,
  output: TableOutput,
  options: { title?: string; caption?: string; rows?: TableOutput['rows']; columns?: readonly string[] } = {},
): string {
  const id = newId(page, output.id)
  const rows = (options.rows ?? output.rows).slice(0, MAX_ROWS)
  const all = options.rows ?? output.rows
  const shown = options.columns === undefined ? output.columns : output.columns.filter((c) => options.columns!.includes(c.key))
  const head = shown
    .map(
      (c) =>
        `<th scope="col"${c.kind === 'number' ? ' class="num"' : ''}${c.hint ? ` title="${escape(c.hint)}"` : ''}>` +
        `<button type="button" class="sort" data-kind="${c.kind}">${escape(c.label)}<span class="arrow" aria-hidden="true"></span></button></th>`,
    )
    .join('')
  const body = rows.map((row) => `<tr>${shown.map((c) => cell(c, row[c.key])).join('')}</tr>`).join('')
  page.downloads[`${id}-tsv`] = {
    name: `${page.sample}.${output.id}.tsv`,
    type: 'text/tab-separated-values',
    text: tableTsv({ ...output, rows: all }),
  }
  const filter =
    all.length > 12
      ? `<div class="filter"><span class="icon">${ICON.search}</span><input type="search" placeholder="Filter ${GROUPED.format(all.length)} rows" aria-label="Filter rows" data-filter="${id}"></div>`
      : ''
  const more =
    all.length > rows.length
      ? `<p class="fine">The first ${GROUPED.format(rows.length)} of ${GROUPED.format(all.length)} rows; every one is in the TSV.</p>`
      : ''
  return card(
    options.title ?? output.label,
    options.caption,
    [action('tsv', `${id}-tsv`, 'TSV')],
    `${filter}<div class="table-wrap"><table id="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`,
  )
}

function tile(value: string, label: string, hint = ''): string {
  return `<div class="tile"${hint ? ` title="${escape(hint)}"` : ''}><div class="tile-value">${value}</div><div class="tile-label">${escape(label)}</div></div>`
}

function callout(kind: 'info' | 'how', title: string, body: string): string {
  return `<aside class="callout ${kind}"><span class="callout-icon">${kind === 'info' ? ICON.info : ICON.book}</span><div><strong>${escape(title)}</strong>${body}</div></aside>`
}

// ---------------------------------------------------------------------------
// The library: where the contacts are
// ---------------------------------------------------------------------------

type Row = Record<string, string | number>

/**
 * Every contact once, by how far apart its two ends are: within a bin, cis at
 * each of pairtools' separations, and trans — the summary's cumulative rows
 * taken apart, so the bar's segments sum to the whole.
 */
function composition(rows: readonly Row[]): string {
  const map = (measure: string): number => Number(rows.find((r) => r.group === 'Map' && r.measure === measure)?.value ?? Number.NaN)
  const total = map('contacts')
  if (!(total > 0)) return ''
  const diagonal = map('within one bin')
  const cis = map('cis')
  const trans = map('trans')
  const at = [1, 2, 4, 10, 20, 40].map((kb) => [kb, map(`cis, bins ≥ ${kb} kb apart`)] as const)
  const segments: Array<{ label: string; value: number; colour: string }> = [
    { label: 'within one bin', value: diagonal, colour: 'var(--seq-1)' },
  ]
  let before = cis - diagonal
  let lower = 0
  const shades = ['var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)']
  at.forEach(([kb, atLeast], index) => {
    const value = before - atLeast
    if (value > 0) {
      segments.push({ label: lower === 0 ? `cis, under ${kb} kb` : `cis, ${lower}–${kb} kb`, value, colour: shades[index] })
    }
    before = atLeast
    lower = kb
  })
  segments.push({ label: `cis, ${lower} kb and more`, value: before, colour: 'var(--seq-8)' })
  segments.push({ label: 'trans', value: trans, colour: 'var(--series-2)' })
  const shown = segments.filter((s) => s.value > 0)
  const bar = shown
    .map((s) => {
      const share = s.value / total
      const tip = `${s.label}: ${number(s.value)} contacts, ${percent(share)}`
      return `<span class="seg" style="flex-grow:${share};background:${s.colour}" data-tip="${escape(tip)}" title="${escape(tip)}"></span>`
    })
    .join('')
  const keys = shown
    .map(
      (s) =>
        `<li><span class="key" style="background:${s.colour}"></span><span class="k-label">${escape(s.label)}</span>` +
        `<span class="k-value">${percent(s.value / total)}</span></li>`,
    )
    .join('')
  return card(
    'Where the contacts are',
    'Every contact once, by how far apart its two ends are: the cis ones by the separation of their bins, then the trans.',
    [],
    `<div class="chart stack-wrap" data-chart="composition"><div class="stack">${bar}</div><div class="tip" hidden></div></div><ul class="stack-keys">${keys}</ul>`,
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function find<K extends TaskOutput['kind']>(result: TaskResult, id: string, kind: K): Extract<TaskOutput, { kind: K }> | undefined {
  return result.outputs.find((output) => output.id === id && output.kind === kind) as Extract<TaskOutput, { kind: K }> | undefined
}

interface Panel {
  id: string
  label: string
  title: string
  lede: string
  body: string
}

/** The page, from a run of the map report. `sample` names it where the file's own name is not wanted. */
export function mapReportPage(result: TaskResult, sample: string): string {
  const provenance = result.provenance
  const name = sample || provenance.framing.uri.split(/[\\/]/).pop() || 'map'
  const page: Page = { sample: name, downloads: {}, charts: {}, count: 0 }
  const summary = find(result, 'report-summary', 'table')
  const ladder = find(result, 'report-resolutions', 'table')
  const ladderCurve = find(result, 'report-resolution-curve', 'curve')
  const ps = find(result, 'report-ps', 'curve')
  const slope = find(result, 'report-ps-slope', 'curve')
  const along = find(result, 'report-coverage', 'curve')
  const spread = find(result, 'report-coverage-spread', 'curve')
  const cistrans = find(result, 'report-cistrans', 'table')
  const fractions = find(result, 'report-cistrans-fractions', 'curve')
  const created = new Date(provenance.createdAt)
  const when = Number.isNaN(created.getTime())
    ? provenance.createdAt
    : created.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'

  const rows: Row[] = summary?.rows ?? []
  const mapRow = (measure: string): Row | undefined => rows.find((r) => r.group === 'Map' && r.measure === measure)
  const ladderRows: Row[] = ladder?.rows ?? []
  const finest = ladderRows[ladderRows.length - 1]
  const coarsest = ladderRows[0]
  const sequences = cistrans?.rows.length ?? 0

  // -- Overview
  const tiles = [
    mapRow('contacts') && tile(number(Number(mapRow('contacts')!.value)), 'contacts in the map'),
    mapRow('cis') && tile(percent(Number(mapRow('cis')!.share)), 'cis', 'Both ends on one sequence.'),
    mapRow('trans') && tile(percent(Number(mapRow('trans')!.share)), 'trans', 'The two ends on two sequences.'),
    mapRow('cis, bins ≥ 20 kb apart') &&
      tile(percent(Number(mapRow('cis, bins ≥ 20 kb apart')!.share)), 'cis, at least 20 kb apart'),
    finest && tile(number(Number(finest.reached80)), `contacts reached by 80 % of ${bp(Number(finest.binsize))} bins`),
    finest && tile(number(Number(finest.median)), `median contacts per ${bp(Number(finest.binsize))} bin`),
    mapRow('within one bin') && tile(percent(Number(mapRow('within one bin')!.share)), 'within one bin'),
    sequences > 0 && tile(number(sequences), sequences === 1 ? 'sequence' : 'sequences'),
  ].filter((t): t is string => typeof t === 'string')

  const glance = (target: string, title: string, figure: string): string =>
    figure === ''
      ? ''
      : `<a class="glance" href="#${target}" data-goto="${target}"><div class="glance-head"><span>${escape(title)}</span><span class="go">${ICON.arrow}</span></div>${figure}</a>`
  const glances = [
    ladderCurve && glance('resolutions', 'Contacts per bin, by bin size', curveFigure(page, ladderCurve, { xUnit: 'bp', height: 240, bare: true })),
    ps && glance('decay', 'Contact probability, P(s)', curveFigure(page, ps, { xUnit: 'bp', height: 240, bare: true })),
  ]
    .filter((g): g is string => typeof g === 'string' && g !== '')
    .join('')
  const notes =
    result.notes.length === 0
      ? ''
      : callout('info', 'Notes from the run', `<ul>${result.notes.map((note) => `<li>${prose(note)}</li>`).join('')}</ul>`)

  const panels: Panel[] = [
    {
      id: 'overview',
      label: 'Overview',
      title: 'At a glance',
      lede: `The library behind <strong>${escape(name)}</strong>, counted from the whole map. Every figure here is a number; none of them is marked as a pass or a fail.`,
      body:
        `<div class="tiles">${tiles.join('')}</div>` +
        (glances ? `<div class="glances">${glances}</div>` : '') +
        notes,
    },
    {
      id: 'library',
      label: 'Library',
      title: 'The library',
      lede:
        'What the contact map holds, counted from its stored counts — and, where the map was binned here from a ' +
        '<code>.pairs</code>, what <code>pairtools stats</code> counts over its records.',
      body:
        composition(rows) +
        (summary === undefined
          ? ''
          : (rows.some((r) => r.group === 'Records')
              ? tableCard(page, summary, {
                  title: 'From the records',
                  caption: 'As <code>pairtools stats</code> counts them, over the pairs the map was binned from.',
                  rows: rows.filter((r) => r.group === 'Records'),
                  columns: ['measure', 'value', 'share'],
                })
              : '') +
            tableCard(page, summary, {
              title: 'From the map',
              caption: 'Separations are between the starts of the two bins.',
              rows: rows.filter((r) => r.group === 'Map'),
              columns: ['measure', 'value', 'share'],
            })),
    },
    {
      id: 'resolutions',
      label: 'Resolutions',
      title: 'Resolutions, coarsest to finest',
      lede:
        `How the contacts spread over bins of each size, from ${coarsest ? bp(Number(coarsest.binsize)) : 'the coarsest'} ` +
        `down to ${finest ? bp(Number(finest.binsize)) : 'the finest'}: the file’s own resolutions and its finest bin doubled.`,
      body:
        callout(
          'how',
          'Reading this',
          '<p>A contact counts once at each of its two ends, as Juicer’s <code>calculate_map_resolution.sh</code> counts it, ' +
            'so a coarser bin holds exactly the sum of its finer ones. Rao et al. (2014) call a map’s resolution the finest ' +
            'bin size at which 80 % of bins hold at least 1,000 contacts: the column that criterion reads is ' +
            '<em>reached by 80 % of bins</em>. No line is drawn at any count.</p>',
        ) +
        (ladderCurve === undefined
          ? ''
          : curveFigure(page, ladderCurve, {
              xUnit: 'bp',
              caption: 'The median bin and the bin four in five reach, at every bin size; both axes logarithmic.',
            })) +
        (ladder === undefined ? '' : tableCard(page, ladder, { caption: 'Sort by any column; save it as a TSV.' })),
    },
    {
      id: 'decay',
      label: 'P(s)',
      title: 'Contact probability, P(s)',
      lede: 'How contact falls away with distance along the sequence, over the whole genome, as the P(s) task computes it.',
      body:
        (ps === undefined ? '' : curveFigure(page, ps, { xUnit: 'bp', caption: 'Both axes logarithmic; the first two diagonals left out.' })) +
        (slope === undefined
          ? ''
          : curveFigure(page, slope, { xUnit: 'bp', caption: 'The local slope of the curve above, d log P / d log s.' })),
    },
    {
      id: 'coverage',
      label: 'Coverage',
      title: 'Coverage',
      lede: 'Every contact touching each bin, from the raw counts, as the Coverage task computes it.',
      body:
        (along === undefined
          ? ''
          : curveFigure(page, along, { xUnit: 'number', yZero: true, caption: 'The sequences end to end, in the file’s order.' })) +
        (spread === undefined
          ? ''
          : curveFigure(page, spread, {
              xUnit: 'number',
              yZero: true,
              caption: 'How many bins hold how much, on log-spaced classes; the empty bins are counted in the notes.',
            })),
    },
    {
      id: 'cistrans',
      label: 'Cis & trans',
      title: 'Cis and trans per sequence',
      lede: 'Of the contacts touching each sequence, how many stay on it, as the Cis and trans task computes them.',
      body:
        (fractions !== undefined && (fractions.xTicks?.length ?? 0) <= 80 ? namedBars(page, fractions) : '') +
        (cistrans === undefined ? '' : tableCard(page, cistrans, { caption: 'Sort by any column, or filter by name.' })),
    },
    {
      id: 'about',
      label: 'About',
      title: 'How these numbers were made',
      lede: 'The run behind this page: what it noted, and the task, parameters, file and build every export from it carries.',
      body:
        (result.notes.length === 0
          ? ''
          : card('Notes from the run', undefined, [], `<ul class="notes">${result.notes.map((note) => `<li>${prose(note)}</li>`).join('')}</ul>`)) +
        card(
          'Provenance',
          undefined,
          [`<button type="button" class="ghost" data-copy="provenance">${ICON.copy}Copy</button>`],
          `<pre id="provenance">${escape(provenanceLines(provenance).join('\n'))}</pre>`,
        ),
    },
  ].filter((panel) => panel.body.trim() !== '')

  const tabs = panels
    .map(
      (panel, index) =>
        `<a role="tab" id="tab-${panel.id}" href="#${panel.id}" aria-controls="${panel.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escape(panel.label)}</a>`,
    )
    .join('')
  const sections = panels
    .map(
      (panel, index) =>
        `<section class="panel${index === 0 ? ' active' : ''}" id="${panel.id}" role="tabpanel" aria-labelledby="tab-${panel.id}">` +
        `<div class="panel-head"><h2>${escape(panel.title)}</h2><p class="lede">${panel.lede}</p></div>${panel.body}</section>`,
    )
    .join('\n')

  const data = JSON.stringify({ downloads: page.downloads, charts: page.charts }).replace(/</g, '\\u003c')
  const chips = [
    `the whole file at ${bp(provenance.framing.binsize)}`,
    finest && Number(finest.binsize) !== provenance.framing.binsize ? `counted at ${bp(Number(finest.binsize))}` : '',
    when,
  ].filter(Boolean)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escape(provenance.app)}">
<meta name="color-scheme" content="light dark">
<title>Map report · ${escape(name)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
<div class="top-inner">
<div class="brand"><span class="mark" aria-hidden="true">${ICON.mark}</span><span>chromosomix <span class="dim">· map report</span></span></div>
<div class="tools">
<button type="button" class="ghost" data-theme-toggle title="Light, dark, or as the system is">${ICON.theme}<span data-theme-label>Auto</span></button>
<button type="button" class="ghost" data-print title="Print every tab, or save them as a PDF">${ICON.print}Print</button>
</div>
</div>
<div class="hero">
<h1>${escape(name)}</h1>
<p class="chips">${chips.map((chip) => `<span class="chip-static">${escape(String(chip))}</span>`).join('')}</p>
</div>
<nav class="tabs" role="tablist" aria-label="Sections of the report">${tabs}</nav>
</header>
<main>
${sections}
</main>
<footer class="foot">Written by chromosomix ${escape(provenance.app.replace(/\s+cli$/, ''))} from one run of the map report. Nothing on this page is fetched from anywhere.</footer>
<script type="application/json" id="report-data">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// Icons: Lucide's, inline
// ---------------------------------------------------------------------------

const svgIcon = (body: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

const ICON = {
  download: svgIcon('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  print: svgIcon('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  theme: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  book: svgIcon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  search: svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  copy: svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  arrow: svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  mark: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 21 21 3v18z" fill="var(--series-1)" opacity=".9"/><path d="M3 21 12 12v9z" fill="var(--series-2)"/></svg>`,
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/**
 * The page's own stylesheet. Colours are tokens, each chosen for its surface —
 * the reference categorical palette's first slots and a sequential blue ramp —
 * in light and in dark, the dark set applied by the system unless the reader
 * chose one (`data-theme`).
 */
const LIGHT = `
  color-scheme: light;
  --bg: #f6f6f4; --surface: #ffffff; --raised: #f3f2ef; --text: #0b0b0b; --text-2: #52514e; --muted: #75746f;
  --rule: #e6e5e0; --grid: #eeede9; --accent: #2a78d6; --accent-soft: #e5effb; --shadow: 0 1px 2px rgba(20,20,10,.05), 0 4px 16px rgba(20,20,10,.04);
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --series-8: #e34948;
  --seq-1: #0d366b; --seq-2: #184f95; --seq-3: #256abf; --seq-4: #3987e5; --seq-5: #5598e7; --seq-6: #6da7ec; --seq-7: #9ec5f4; --seq-8: #cde2fb;`
const DARK = `
  color-scheme: dark;
  --bg: #121211; --surface: #1a1a19; --raised: #242422; --text: #f0efec; --text-2: #c3c2b7; --muted: #9a998f;
  --rule: #33322f; --grid: #2a2a28; --accent: #5598e7; --accent-soft: #1d2a3a; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.25);
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  --seq-1: #cde2fb; --seq-2: #9ec5f4; --seq-3: #6da7ec; --seq-4: #3987e5; --seq-5: #256abf; --seq-6: #1c5cab; --seq-7: #184f95; --seq-8: #104281;`

const STYLE = `
:root {${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK} } }
:root[data-theme="dark"] {${DARK} }
* { box-sizing: border-box; }
html { scroll-padding-top: 140px; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; }
code { font: 0.86em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--raised); padding: 1px 5px; border-radius: 4px; }
.ico { flex: none; }
button { font: inherit; color: inherit; }
.ghost { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--rule);
  background: var(--surface); border-radius: 7px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.ghost:hover { color: var(--text); border-color: var(--muted); }
.ghost:focus-visible, .tabs a:focus-visible, .chip:focus-visible, .sort:focus-visible, .glance:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* the header: brand, title, tabs */
.top { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--rule); }
.top-inner, .hero, .tabs, main, .foot { max-width: 1080px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
.top-inner { display: flex; align-items: center; justify-content: space-between; height: 52px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 14px; letter-spacing: .01em; }
.brand .dim { color: var(--muted); font-weight: 500; }
.tools { display: flex; gap: 8px; }
.hero { padding-top: 6px; padding-bottom: 10px; }
h1 { margin: 0; font-size: clamp(22px, 3.2vw, 30px); font-weight: 650; letter-spacing: -.01em; overflow-wrap: anywhere; }
.chips { margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chip-static { font-size: 12.5px; color: var(--text-2); background: var(--raised); border-radius: 999px; padding: 2px 10px; }
.tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tabs a { position: relative; padding: 10px 14px 12px; color: var(--text-2); text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap; border-radius: 6px 6px 0 0; }
.tabs a:hover { color: var(--text); background: var(--raised); }
.tabs a[aria-selected="true"] { color: var(--text); }
.tabs a[aria-selected="true"]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2.5px; border-radius: 2px; background: var(--accent); }

/* panels */
main { padding-top: 28px; padding-bottom: 48px; }
.js .panel { display: none; }
.js .panel.active { display: block; animation: rise .22s ease-out; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.panel + .panel { margin-top: 48px; }
.js .panel + .panel { margin-top: 0; }
.panel-head { margin-bottom: 20px; }
h2 { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: -.005em; }
.lede { margin: 0; color: var(--text-2); max-width: 70ch; }

/* tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 16px 18px; box-shadow: var(--shadow); }
.tile-value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.tile-label { color: var(--text-2); font-size: 13px; margin-top: 2px; }
.glances { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 20px; }
.glance { display: block; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px 6px; color: inherit;
  text-decoration: none; box-shadow: var(--shadow); transition: border-color .15s, transform .15s; }
.glance:hover { border-color: var(--accent); transform: translateY(-1px); }
.glance-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 14px; }
.glance .go { color: var(--accent); display: inline-flex; }

/* cards */
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 18px 20px 16px; margin-bottom: 18px; box-shadow: var(--shadow); }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 10px; }
h3 { margin: 0; font-size: 15.5px; font-weight: 620; }
.caption { margin: 2px 0 0; color: var(--text-2); font-size: 13px; }
.actions { display: flex; gap: 6px; flex: none; }
.fine { color: var(--muted); font-size: 12.5px; margin: 8px 0 0; }

/* callouts */
.callout { display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; margin-bottom: 18px; background: var(--accent-soft); color: var(--text); }
.callout-icon { color: var(--accent); padding-top: 2px; }
.callout strong { display: block; font-size: 14px; margin-bottom: 2px; }
.callout p { margin: 0; color: var(--text-2); font-size: 14px; }
.callout ul { margin: 4px 0 0; padding-left: 18px; color: var(--text-2); font-size: 14px; }

/* figures */
.chart { position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.ico { width: 16px; height: 16px; display: block; }
.mark svg { display: block; }
svg text { fill: var(--text-2); font-size: 12px; }
svg .label { fill: var(--text); font-size: 12.5px; font-weight: 500; }
svg .value { fill: var(--text-2); font-size: 11.5px; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--muted); stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .line.dense { stroke-width: 1.1; }
svg .line.joint { stroke-width: 1.5; opacity: .45; }
svg .dot { stroke: var(--surface); stroke-width: 2; }
svg .bar { transition: opacity .12s; }
svg .bar:hover, svg .bar.hot { opacity: .78; }
svg .guide { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
svg .focus { stroke: var(--surface); stroke-width: 2; }
svg .series { transition: opacity .15s; }
svg .series.off { opacity: 0; pointer-events: none; }
.tip { position: absolute; z-index: 5; pointer-events: none; min-width: 120px; max-width: 280px; background: var(--surface); color: var(--text);
  border: 1px solid var(--rule); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: 0 6px 24px rgba(0,0,0,.14); }
.tip .t-head { color: var(--text-2); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.tip .t-row { display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
.tip .t-row b { margin-left: auto; font-weight: 600; }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; flex: none; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px; }
.chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--rule); background: var(--surface); border-radius: 999px;
  padding: 3px 11px 3px 9px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
.chip[aria-pressed="false"] { opacity: .45; }
.chip[aria-pressed="false"] .key { background: transparent !important; outline: 1.5px solid var(--muted); outline-offset: -1.5px; }

/* where the contacts are */
.stack-wrap { margin: 6px 0 14px; }
.stack { display: flex; height: 34px; border-radius: 8px; overflow: hidden; gap: 2px; background: var(--surface); }
.seg { min-width: 2px; cursor: default; transition: filter .12s; }
.seg:hover, .seg.hot { filter: brightness(1.1) saturate(1.1); }
.stack-keys { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 6px 18px; font-size: 13px; }
.stack-keys li { display: flex; align-items: center; gap: 8px; }
.k-label { color: var(--text-2); }
.k-value { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }

/* tables */
.filter { position: relative; margin: 2px 0 10px; max-width: 320px; }
.filter .icon { position: absolute; left: 10px; top: 8px; color: var(--muted); display: inline-flex; }
.filter input { width: 100%; height: 32px; padding: 0 10px 0 32px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 13.5px; }
.filter input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.table-wrap { overflow: auto; max-height: 620px; border: 1px solid var(--rule); border-radius: 10px; }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 12px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--rule); }
tbody tr:last-child td { border-bottom: none; }
th { position: sticky; top: 0; background: var(--raised); z-index: 1; font-weight: 600; font-size: 12.5px; color: var(--text-2); }
.num { text-align: right; }
tbody tr:hover td { background: var(--accent-soft); }
.sort { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
th.num .sort { flex-direction: row-reverse; }
.sort .arrow::after { content: "↕"; opacity: .35; font-size: 11px; }
.sort[data-dir="asc"] .arrow::after { content: "↑"; opacity: 1; color: var(--accent); }
.sort[data-dir="desc"] .arrow::after { content: "↓"; opacity: 1; color: var(--accent); }

.notes { margin: 0; padding-left: 18px; color: var(--text-2); }
.notes li + li { margin-top: 6px; }
pre { background: var(--raised); padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; color: var(--text-2); margin: 0; }
.foot { color: var(--muted); font-size: 12.5px; padding-top: 0; padding-bottom: 40px; }

@media (max-width: 640px) {
  .top-inner, .hero, .tabs, main, .foot { padding-left: 16px; padding-right: 16px; }
  .tools .ghost span, .tools .ghost:last-child { font-size: 0; gap: 0; }
  .card { padding: 14px 14px 12px; }
  .card-head { flex-direction: column; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tile { padding: 12px 14px; }
  .tile-value { font-size: 20px; }
  .tile-label { font-size: 12.5px; }
  /* A figure keeps a width its words can be read at, and scrolls sideways. */
  .card .chart { overflow-x: auto; }
  .card .chart svg { min-width: 600px; }
}
@media print {
  body { background: #fff; }
  .top { position: static; backdrop-filter: none; background: #fff; border: none; }
  .tabs, .tools, .actions, .filter, .legend { display: none !important; }
  .js .panel { display: block !important; animation: none; }
  .panel { break-before: page; }
  .panel:first-of-type { break-before: auto; }
  .card, .tile, .glance { box-shadow: none; break-inside: avoid; }
  .table-wrap { max-height: none; overflow: visible; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/**
 * Tabs, the pointer on figures, legend chips, sorting and filtering, saving,
 * the theme and printing — in plain DOM calls, every one inside a guard, so a
 * browser that refuses one thing still shows the rest.
 */
const SCRIPT = `
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  root.classList.add('js');
  var data = {};
  try { data = JSON.parse(doc.getElementById('report-data').textContent); } catch (e) {}
  var downloads = data.downloads || {}, charts = data.charts || {};

  // -- tabs
  var tabs = [].slice.call(doc.querySelectorAll('[role="tab"]'));
  function show(id, focus) {
    var found = false;
    tabs.forEach(function (tab) {
      var on = tab.getAttribute('aria-controls') === id;
      if (on) found = true;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      var panel = doc.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.classList.toggle('active', on);
      if (on && focus) tab.focus();
      if (on) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return found;
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      var id = tab.getAttribute('aria-controls');
      show(id);
      try { history.replaceState(null, '', '#' + id); } catch (e) {}
      window.scrollTo({ top: 0 });
    });
    tab.addEventListener('keydown', function (event) {
      var next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      next = (next + tabs.length) % tabs.length;
      var id = tabs[next].getAttribute('aria-controls');
      show(id, true);
      try { history.replaceState(null, '', '#' + id); } catch (e) {}
    });
  });
  [].forEach.call(doc.querySelectorAll('[data-goto]'), function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      var id = link.getAttribute('data-goto');
      show(id);
      try { history.replaceState(null, '', '#' + id); } catch (e) {}
      window.scrollTo({ top: 0 });
    });
  });
  if (!(location.hash && show(location.hash.slice(1))) && tabs[0]) show(tabs[0].getAttribute('aria-controls'));

  // -- the tooltip card
  function place(tip, box, x, y) {
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 14, top = y - h - 12;
    if (left + w > box.width) left = x - w - 14;
    if (left < 0) left = 0;
    if (top < 0) top = y + 16;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function row(slot, name, value) {
    var r = doc.createElement('div'); r.className = 't-row';
    var k = doc.createElement('span'); k.className = 'key'; k.style.background = 'var(--series-' + slot + ')';
    var n = doc.createElement('span'); n.textContent = name;
    var v = doc.createElement('b'); v.textContent = value;
    r.appendChild(k); r.appendChild(n); r.appendChild(v); return r;
  }

  // -- figures: a guide and the nearest point of every shown series
  var NS = 'http://www.w3.org/2000/svg';
  [].forEach.call(doc.querySelectorAll('.chart'), function (wrap) {
    var svg = wrap.querySelector('svg'), tip = wrap.querySelector('.tip');
    if (!tip) return;
    var chart = charts[wrap.getAttribute('data-chart')];
    var hidden = {};
    if (svg && chart && chart.series.length && svg.getAttribute('data-plot')) {
      var plot = svg.getAttribute('data-plot').split(',').map(Number);
      var guide = doc.createElementNS(NS, 'line');
      guide.setAttribute('class', 'guide'); guide.setAttribute('y1', plot[1]); guide.setAttribute('y2', plot[3]); guide.style.display = 'none';
      svg.appendChild(guide);
      var focus = chart.series.map(function (s) {
        var c = doc.createElementNS(NS, 'circle');
        c.setAttribute('class', 'focus'); c.setAttribute('r', '5'); c.setAttribute('fill', 'var(--series-' + s.slot + ')'); c.style.display = 'none';
        svg.appendChild(c); return c;
      });
      var view = svg.viewBox.baseVal;
      function nearest(points, x) {
        var lo = 0, hi = points.length - 1;
        if (hi < 0) return null;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (points[mid][0] < x) lo = mid; else hi = mid; }
        return Math.abs(points[lo][0] - x) <= Math.abs(points[hi][0] - x) ? points[lo] : points[hi];
      }
      function leave() { tip.hidden = true; guide.style.display = 'none'; focus.forEach(function (c) { c.style.display = 'none'; }); }
      svg.addEventListener('pointermove', function (event) {
        var box = svg.getBoundingClientRect();
        var x = (event.clientX - box.left) * view.width / box.width;
        if (x < plot[0] - 8 || x > plot[2] + 8) return leave();
        var at = null, picked = [];
        chart.series.forEach(function (s, i) {
          if (hidden[i]) { focus[i].style.display = 'none'; return; }
          var p = nearest(s.points, x);
          if (!p) return;
          if (at === null || Math.abs(p[0] - x) < Math.abs(at[0] - x)) at = p;
          picked.push([i, p]);
        });
        if (!at) return leave();
        guide.setAttribute('x1', at[0]); guide.setAttribute('x2', at[0]); guide.style.display = '';
        tip.textContent = '';
        var head = doc.createElement('div'); head.className = 't-head'; head.textContent = at[2]; tip.appendChild(head);
        picked.forEach(function (pick) {
          var i = pick[0], p = pick[1], c = focus[i];
          var close = Math.abs(p[0] - at[0]) < 1.5;
          c.style.display = close ? '' : 'none';
          if (!close) return;
          c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
          tip.appendChild(row(chart.series[i].slot, chart.series[i].name, p[3]));
        });
        var scaleX = box.width / view.width, wrapBox = wrap.getBoundingClientRect();
        place(tip, wrapBox, at[0] * scaleX + box.left - wrapBox.left, (event.clientY - wrapBox.top));
      });
      svg.addEventListener('pointerleave', leave);
    }
    // bars and stacked segments carry their own words
    [].forEach.call(wrap.querySelectorAll('[data-tip]'), function (mark) {
      var title = mark.querySelector('title'); if (title) title.remove(); mark.removeAttribute('title');
      mark.addEventListener('pointermove', function (event) {
        var box = wrap.getBoundingClientRect();
        tip.textContent = mark.getAttribute('data-tip');
        mark.classList.add('hot');
        place(tip, box, event.clientX - box.left, event.clientY - box.top);
      });
      mark.addEventListener('pointerleave', function () { tip.hidden = true; mark.classList.remove('hot'); });
    });
    // the legend's chips hide and show a series
    var card = wrap.closest('.card');
    if (!card || !svg) return;
    [].forEach.call(card.querySelectorAll('.chip[data-series]'), function (chip) {
      chip.addEventListener('click', function () {
        var i = chip.getAttribute('data-series'), on = chip.getAttribute('aria-pressed') !== 'false';
        chip.setAttribute('aria-pressed', on ? 'false' : 'true');
        hidden[i] = on;
        var g = svg.querySelector('.series[data-series="' + i + '"]'); if (g) g.classList.toggle('off', on);
      });
    });
  });

  // -- tables: sort by a column, filter by a word
  [].forEach.call(doc.querySelectorAll('table'), function (table) {
    var body = table.tBodies[0];
    [].forEach.call(table.querySelectorAll('.sort'), function (button, column) {
      button.addEventListener('click', function () {
        var dir = button.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
        [].forEach.call(table.querySelectorAll('.sort'), function (b) { b.removeAttribute('data-dir'); });
        button.setAttribute('data-dir', dir);
        var numeric = button.getAttribute('data-kind') === 'number', sign = dir === 'asc' ? 1 : -1;
        var rows = [].slice.call(body.rows);
        rows.sort(function (a, b) {
          var x = a.cells[column] ? a.cells[column].getAttribute('data-v') : '', y = b.cells[column] ? b.cells[column].getAttribute('data-v') : '';
          if (numeric) { var p = parseFloat(x), q = parseFloat(y); if (isNaN(p)) return 1; if (isNaN(q)) return -1; return (p - q) * sign; }
          return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
  });
  [].forEach.call(doc.querySelectorAll('[data-filter]'), function (input) {
    var table = doc.getElementById(input.getAttribute('data-filter'));
    if (!table) return;
    input.addEventListener('input', function () {
      var words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
      [].forEach.call(table.tBodies[0].rows, function (r) {
        var text = r.textContent.toLowerCase();
        r.hidden = !words.every(function (w) { return text.indexOf(w) !== -1; });
      });
    });
  });

  // -- saving: a file the page holds, a figure as SVG, the provenance copied
  function save(name, type, text) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: type }));
      var a = doc.createElement('a'); a.href = url; a.download = name; doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {}
  }
  [].forEach.call(doc.querySelectorAll('[data-tsv]'), function (button) {
    button.addEventListener('click', function () {
      var file = downloads[button.getAttribute('data-tsv')];
      if (file) save(file.name, file.type, file.text);
    });
  });
  [].forEach.call(doc.querySelectorAll('[data-svg]'), function (button) {
    button.addEventListener('click', function () {
      var wrap = doc.querySelector('[data-chart="' + button.getAttribute('data-svg') + '"]');
      var svg = wrap && wrap.querySelector('svg');
      if (!svg) return;
      var copy = svg.cloneNode(true);
      [].forEach.call(copy.querySelectorAll('.guide, .focus'), function (n) { n.remove(); });
      var style = getComputedStyle(root), resolve = function (value) {
        return String(value).replace(/var\\((--[a-z0-9-]+)\\)/g, function (_, name) { return style.getPropertyValue(name).trim(); });
      };
      [].forEach.call(copy.querySelectorAll('[fill], [stroke]'), function (n) {
        if (n.getAttribute('fill')) n.setAttribute('fill', resolve(n.getAttribute('fill')));
        if (n.getAttribute('stroke')) n.setAttribute('stroke', resolve(n.getAttribute('stroke')));
      });
      var sheet = doc.createElementNS(NS, 'style');
      sheet.textContent = resolve('text{font:12px -apple-system,Segoe UI,Roboto,Arial,sans-serif;fill:var(--text-2)}.label{fill:var(--text);font-size:12.5px}' +
        '.grid{stroke:var(--grid)}.axis{stroke:var(--muted)}.line{fill:none;stroke-width:2;stroke-linejoin:round}.line.dense{stroke-width:1.1}.dot{stroke:var(--surface);stroke-width:2}.series.off{display:none}');
      copy.insertBefore(sheet, copy.firstChild);
      copy.setAttribute('xmlns', NS);
      var rect = doc.createElementNS(NS, 'rect');
      rect.setAttribute('width', '100%'); rect.setAttribute('height', '100%'); rect.setAttribute('fill', resolve('var(--surface)'));
      copy.insertBefore(rect, sheet.nextSibling);
      save(button.getAttribute('data-name') || 'figure.svg', 'image/svg+xml', new XMLSerializer().serializeToString(copy));
    });
  });
  [].forEach.call(doc.querySelectorAll('[data-copy]'), function (button) {
    button.addEventListener('click', function () {
      var node = doc.getElementById(button.getAttribute('data-copy'));
      if (!node || !navigator.clipboard) return;
      navigator.clipboard.writeText(node.textContent).then(function () {
        var was = button.lastChild.textContent; button.lastChild.textContent = 'Copied';
        setTimeout(function () { button.lastChild.textContent = was; }, 1400);
      }, function () {});
    });
  });

  // -- the theme, as the system has it or as the reader chose, remembered where the browser lets it be
  var themes = ['auto', 'light', 'dark'], names = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  var label = doc.querySelector('[data-theme-label]');
  function theme(value) {
    if (value === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', value);
    if (label) label.textContent = names[value];
  }
  var chosen = 'auto';
  try { chosen = localStorage.getItem('chromosomix-report-theme') || 'auto'; } catch (e) {}
  if (themes.indexOf(chosen) === -1) chosen = 'auto';
  theme(chosen);
  var toggle = doc.querySelector('[data-theme-toggle]');
  if (toggle) toggle.addEventListener('click', function () {
    chosen = themes[(themes.indexOf(chosen) + 1) % themes.length];
    theme(chosen);
    try { localStorage.setItem('chromosomix-report-theme', chosen); } catch (e) {}
  });
  var print = doc.querySelector('[data-print]');
  if (print) print.addEventListener('click', function () { window.print(); });
})();
`
