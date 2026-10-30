/**
 * The map report as one HTML page: everything the run produced, in reading
 * order, in a file that needs nothing beside it.
 *
 * Written from the {@link TaskResult} alone — no DOM, no chart library — so the
 * drawer's button and `chromosomix mapreport` produce the same bytes, and the
 * page opens years later in any browser with no network. The figures are SVG
 * drawn here, a line, a point or a bar per value, each with its value as a
 * `<title>` the browser shows under the pointer; every figure has its table, on
 * the page or in the TSV beside it. Light and dark are both chosen, by the
 * reader's system, and the page prints.
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
  return `${number(value * 100, value * 100 < 1 && value > 0 ? 3 : 2)} %`
}

/** A length in base pairs, at the largest unit it is a whole number of. */
function bp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1e6 && value % 1e5 === 0) return `${GROUPED.format(value / 1e6)} Mb`
  if (value >= 1e3 && value % 100 === 0) return `${GROUPED.format(value / 1e3)} kb`
  return `${GROUPED.format(value)} bp`
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

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const WIDTH = 720
const HEIGHT = 300
const MARGIN = { left: 84, right: 20, top: 16, bottom: 48 }

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

/** A curve output as an SVG figure: lines, points or bars, one series per colour, in fixed order. */
function curveFigure(curve: CurveOutput, options: { xUnit?: 'bp' | 'number'; yZero?: boolean } = {}): string {
  const xLog = curve.xScale === 'log'
  const yLog = curve.yScale === 'log'
  const inX = (x: number): boolean =>
    curve.xDomain === undefined || (x >= curve.xDomain[0] && x <= curve.xDomain[1])
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
  if (xr === null || yr === null) return '<p class="empty">Nothing to draw.</p>'
  // A point or a bar on the edge of the domain is drawn whole: the domain a
  // figure fits itself to is widened by a little, a declared one is not.
  const pad = (range: [number, number], log: boolean, by: number): [number, number] =>
    log ? [range[0] / (1 + by), range[1] * (1 + by)] : [range[0] - (range[1] - range[0]) * by, range[1] + (range[1] - range[0]) * by]
  const marked = series.some((s) => s.mark === 'points' || s.mark === 'bars')
  if (curve.xDomain === undefined && marked) xr = pad(xr, xLog, 0.06)
  if (curve.yDomain === undefined) yr = pad(yr, yLog, marked ? 0.08 : 0.02)
  if (options.yZero === true && !yLog) yr = [Math.min(0, yr[0]), yr[1]]
  const left = MARGIN.left
  const right = WIDTH - MARGIN.right
  const top = MARGIN.top
  const bottom = HEIGHT - MARGIN.bottom
  const x = scale(xr[0], xr[1], xLog, left, right)
  const y = scale(yr[0], yr[1], yLog, bottom, top)
  const xUnit = options.xUnit ?? (/\(bp\)/.test(curve.xLabel) ? 'bp' : 'number')

  const parts: string[] = []
  // The grid, recessive, and the two axes.
  for (const t of y.ticks) {
    const py = y.at(t)
    parts.push(`<line class="grid" x1="${left}" x2="${right}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}"/>`)
    parts.push(`<text class="tick" x="${left - 8}" y="${(py + 4).toFixed(1)}" text-anchor="end">${tick(t, 'number', yLog)}</text>`)
  }
  for (const t of x.ticks) {
    const px = x.at(t)
    parts.push(`<line class="axis" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${bottom}" y2="${bottom + 5}"/>`)
    parts.push(`<text class="tick" x="${px.toFixed(1)}" y="${bottom + 19}" text-anchor="middle">${tick(t, xUnit, xLog)}</text>`)
  }
  parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`)
  parts.push(
    `<text class="label" x="${(left + right) / 2}" y="${HEIGHT - 8}" text-anchor="middle">${escape(curve.xLabel)}</text>`,
  )
  parts.push(
    `<text class="label" transform="translate(14 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle">${escape(curve.yLabel)}</text>`,
  )

  const valid = (s: CurveSeries, k: number): boolean =>
    inX(s.x[k]) && Number.isFinite(s.y[k]) && (!yLog || s.y[k] > 0) && (!xLog || s.x[k] > 0)
  const title = (s: CurveSeries, k: number): string =>
    `<title>${escape(s.name)} · ${xUnit === 'bp' ? bp(s.x[k]) : number(s.x[k], s.x[k] < 10 ? 2 : 0)}: ${number(s.y[k], Math.abs(s.y[k]) < 10 ? 4 : 1)}</title>`
  series.forEach((s, index) => {
    const colour = `var(--series-${index + 1})`
    const mark = s.mark ?? 'line'
    if (mark === 'bars') {
      const n = s.x.length
      const width = Math.max(2, ((right - left) / Math.max(1, n)) * 0.8)
      const base = yLog ? bottom : y.at(Math.max(yr![0], 0))
      for (let k = 0; k < n; k++) {
        if (!valid(s, k)) continue
        const px = x.at(s.x[k])
        const py = y.at(s.y[k])
        parts.push(
          `<rect fill="${colour}" x="${(px - width / 2).toFixed(1)}" y="${Math.min(py, base).toFixed(1)}" ` +
            `width="${width.toFixed(1)}" height="${Math.abs(base - py).toFixed(1)}" rx="1.5">${title(s, k)}</rect>`,
        )
      }
      return
    }
    if (mark === 'line') {
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
      const dense = s.x.length > 400
      parts.push(`<path class="line${dense ? ' dense' : ''}" stroke="${colour}" d="${path}"/>`)
      // A hover target a value is one too many past a few hundred: the TSV
      // holds every one of them.
      if (dense) return
    }
    // Points: every value of a points series, and a hover target on a line's.
    for (let k = 0; k < s.x.length; k++) {
      if (!valid(s, k)) continue
      const px = x.at(s.x[k]).toFixed(1)
      const py = y.at(s.y[k]).toFixed(1)
      parts.push(
        mark === 'points'
          ? `<circle class="dot" cx="${px}" cy="${py}" r="4" fill="${colour}">${title(s, k)}</circle>`
          : `<circle class="hit" cx="${px}" cy="${py}" r="5">${title(s, k)}</circle>`,
      )
    }
  })
  const legend =
    series.length > 1
      ? `<ul class="legend">${series
          .map((s, index) => `<li><span class="key" style="background:var(--series-${index + 1})"></span>${escape(s.name)}</li>`)
          .join('')}</ul>`
      : ''
  const more =
    curve.series.length > series.length
      ? `<p class="note">The first ${series.length} of ${curve.series.length} lines are drawn; every one is in the TSV.</p>`
      : ''
  return (
    `<figure><figcaption>${escape(curve.label)}</figcaption>${legend}` +
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escape(curve.label)}">${parts.join('')}</svg>${more}</figure>`
  )
}

/** One bar per named value, on a shared axis from 0 to 1: the cis fraction of each sequence. */
function namedBars(curve: CurveOutput): string {
  const s = curve.series[0]
  const names = curve.xTicks ?? []
  const n = s?.y.length ?? 0
  if (n === 0) return ''
  const rowHeight = 18
  const left = 140
  const right = WIDTH - 60
  const height = n * rowHeight + 36
  const x = scale(0, 1, false, left, right)
  const parts: string[] = []
  for (const t of x.ticks) {
    const px = x.at(t)
    parts.push(`<line class="grid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="4" y2="${height - 28}"/>`)
    parts.push(`<text class="tick" x="${px.toFixed(1)}" y="${height - 12}" text-anchor="middle">${number(t * 100)} %</text>`)
  }
  for (let k = 0; k < n; k++) {
    const value = s.y[k]
    const top = 6 + k * rowHeight
    const name = names[k] ?? String(k + 1)
    parts.push(`<text class="tick" x="${left - 8}" y="${top + 12}" text-anchor="end">${escape(name)}</text>`)
    if (!Number.isFinite(value)) continue
    const width = Math.max(0, x.at(value) - left)
    parts.push(
      `<rect fill="var(--series-1)" x="${left}" y="${top + 2}" width="${width.toFixed(1)}" height="${rowHeight - 6}" rx="2">` +
        `<title>${escape(name)}: ${percent(value)}</title></rect>`,
    )
    parts.push(`<text class="value" x="${(left + width + 6).toFixed(1)}" y="${top + 12}">${percent(value)}</text>`)
  }
  return (
    `<figure><figcaption>${escape(curve.label)}</figcaption>` +
    `<svg viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escape(curve.label)}">${parts.join('')}</svg></figure>`
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Columns that hold a fraction, printed as a percentage. */
const FRACTIONS = new Set(['share', 'empty', 'belowTenthMedian', 'fraction'])

/** The most rows a table is printed with; the TSV holds the rest. */
const MAX_ROWS = 200

function cell(column: TableColumn, value: string | number | undefined): string {
  if (value === undefined) return '<td></td>'
  if (column.kind === 'text') return `<td>${escape(String(value))}</td>`
  const n = Number(value)
  if (FRACTIONS.has(column.key)) return `<td class="num">${percent(n)}</td>`
  if (column.key === 'binsize') return `<td class="num">${bp(n)}</td>`
  return `<td class="num">${number(n, column.digits ?? 0)}</td>`
}

function tableOf(output: TableOutput, columns?: readonly string[]): string {
  const shown = columns === undefined ? output.columns : output.columns.filter((c) => columns.includes(c.key))
  const rows = output.rows.slice(0, MAX_ROWS)
  const head = shown
    .map((c) => `<th${c.kind === 'number' ? ' class="num"' : ''}${c.hint ? ` title="${escape(c.hint)}"` : ''}>${escape(c.label)}</th>`)
    .join('')
  const body = rows.map((row) => `<tr>${shown.map((c) => cell(c, row[c.key])).join('')}</tr>`).join('')
  const more =
    output.rows.length > rows.length
      ? `<p class="note">The first ${GROUPED.format(rows.length)} of ${GROUPED.format(output.rows.length)} rows; every one is in the TSV.</p>`
      : ''
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function find<K extends TaskOutput['kind']>(
  result: TaskResult,
  id: string,
  kind: K,
): Extract<TaskOutput, { kind: K }> | undefined {
  return result.outputs.find((output) => output.id === id && output.kind === kind) as
    | Extract<TaskOutput, { kind: K }>
    | undefined
}

/** The figures at a glance: a few numbers, each with what it is. */
function glance(result: TaskResult): string {
  const summary = find(result, 'report-summary', 'table')
  const ladder = find(result, 'report-resolutions', 'table')
  const map = (measure: string): Record<string, string | number> | undefined =>
    summary?.rows.find((row) => row.group === 'Map' && row.measure === measure)
  const finest = ladder?.rows[ladder.rows.length - 1]
  const tiles: Array<[string, string]> = []
  const contacts = map('contacts')
  if (contacts !== undefined) tiles.push([number(Number(contacts.value)), 'contacts'])
  const cis = map('cis')
  if (cis !== undefined) tiles.push([percent(Number(cis.share)), 'of them cis'])
  const far = map('cis, bins ≥ 20 kb apart')
  if (far !== undefined) tiles.push([percent(Number(far.share)), 'cis, bins at least 20 kb apart'])
  if (finest !== undefined) {
    tiles.push([number(Number(finest.reached80)), `contacts reached by 80 % of ${bp(Number(finest.binsize))} bins`])
  }
  if (tiles.length === 0) return ''
  return `<div class="tiles">${tiles
    .map(([value, what]) => `<div class="tile"><div class="figure">${value}</div><div class="what">${escape(what)}</div></div>`)
    .join('')}</div>`
}

function section(title: string, intro: string, body: string): string {
  if (body.trim() === '') return ''
  return `<section><h2>${escape(title)}</h2><p class="intro">${intro}</p>${body}</section>`
}

/** The page, from a run of the map report. `sample` names it where the file's own name is not wanted. */
export function mapReportPage(result: TaskResult, sample: string): string {
  const provenance = result.provenance
  const name = sample || provenance.framing.uri.split(/[\\/]/).pop() || 'map'
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

  const sections = [
    section(
      'The library',
      'What the contact map holds, counted from its stored counts — and, where the map was binned here from a ' +
        '<code>.pairs</code>, what <code>pairtools stats</code> counts over its records.',
      summary === undefined ? '' : tableOf(summary),
    ),
    section(
      'Resolutions, coarsest to finest',
      'How the contacts spread over bins of each size: the file’s own resolutions and its finest bin doubled. A contact ' +
        'counts once at each of its two ends, as Juicer’s <code>calculate_map_resolution.sh</code> counts it. Rao et al. ' +
        '(2014) call a map’s resolution the finest bin size at which 80 % of bins hold at least 1,000 contacts; the ' +
        'column it reads is here, and no line is drawn at 1,000.',
      (ladder === undefined ? '' : tableOf(ladder)) +
        (ladderCurve === undefined ? '' : curveFigure(ladderCurve, { xUnit: 'bp' })),
    ),
    section(
      'Contact probability, P(s)',
      'How contact falls away with distance along the sequence, over the whole genome, as the P(s) task computes it, ' +
        'and the slope of its logarithm.',
      (ps === undefined ? '' : curveFigure(ps, { xUnit: 'bp' })) + (slope === undefined ? '' : curveFigure(slope, { xUnit: 'bp' })),
    ),
    section(
      'Coverage',
      'Every contact touching each bin, from the raw counts, as the Coverage task computes it: along the genome, ' +
        'sequences end to end, and how many bins hold how much.',
      (along === undefined ? '' : curveFigure(along, { xUnit: 'number', yZero: true })) +
        (spread === undefined ? '' : curveFigure(spread, { xUnit: 'number', yZero: true })),
    ),
    section(
      'Cis and trans per sequence',
      'Of the contacts touching each sequence, how many stay on it, as the Cis and trans task computes them.',
      (fractions !== undefined && (fractions.xTicks?.length ?? 0) <= 60 ? namedBars(fractions) : '') +
        (cistrans === undefined ? '' : tableOf(cistrans)),
    ),
  ]
  const notes =
    result.notes.length === 0
      ? ''
      : `<section><h2>Notes</h2><ul class="notes">${result.notes.map((note) => `<li>${prose(note)}</li>`).join('')}</ul></section>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escape(provenance.app)}">
<title>Map report · ${escape(name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="kicker">chromosomix · map report</p>
<h1>${escape(name)}</h1>
<p class="meta">the whole file at ${escape(bp(provenance.framing.binsize))} · ${escape(when)}</p>
</header>
${glance(result)}
${sections.join('\n')}
${notes}
<section><h2>Provenance</h2><p class="intro">The task, its parameters, the file and the build, as every export from this run carries them.</p>
<pre>${escape(provenanceLines(provenance).join('\n'))}</pre></section>
</main>
</body>
</html>
`
}

/**
 * The page's own stylesheet: the app's type, a recessive grid, and the first
 * three of the reference categorical palette — each chosen for its surface,
 * light and dark, rather than one inverted into the other.
 */
const STYLE = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --raised: #f3f2ef; --text: #0b0b0b; --text-2: #52514e; --muted: #75746f;
  --rule: #e2e1dc; --grid: #ecebe7;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --series-8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #1a1a19; --raised: #242422; --text: #f0efec; --text-2: #c3c2b7; --muted: #9a998f;
    --rule: #3a3936; --grid: #2c2c2a;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 16px 64px; }
header { margin-bottom: 24px; }
.kicker { margin: 0; color: var(--muted); font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
h1 { margin: 4px 0; font-size: 28px; font-weight: 600; overflow-wrap: anywhere; }
.meta { margin: 0; color: var(--text-2); }
h2 { font-size: 19px; font-weight: 600; margin: 40px 0 6px; padding-top: 16px; border-top: 1px solid var(--rule); }
.intro { color: var(--text-2); margin: 0 0 16px; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--raised); border-radius: 8px; padding: 14px 16px; }
.tile .figure { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .what { color: var(--text-2); font-size: 13px; }
.table { overflow-x: auto; margin: 0 0 16px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 10px; border-bottom: 1px solid var(--rule); text-align: left; white-space: nowrap; }
th { color: var(--text-2); font-weight: 600; white-space: normal; vertical-align: bottom; }
.num { text-align: right; }
figure { margin: 8px 0 24px; }
figcaption { font-weight: 600; margin-bottom: 4px; }
svg { width: 100%; height: auto; display: block; }
svg text { fill: var(--text-2); font-size: 12px; }
svg .label { fill: var(--text); font-size: 13px; }
svg .value { fill: var(--text-2); font-size: 11px; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--muted); stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .line.dense { stroke-width: 1; }
svg .dot { stroke: var(--surface); stroke-width: 2; }
svg .hit { fill: transparent; }
svg .hit:hover { fill: var(--text-2); }
.legend { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--text-2); font-size: 13px; }
.legend .key { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.note { color: var(--muted); font-size: 13px; }
.notes { color: var(--text-2); padding-left: 20px; }
.empty { color: var(--muted); }
pre { background: var(--raised); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; color: var(--text-2); }
@media print { body { background: #fff; } main { max-width: none; } h2 { break-after: avoid; } figure, .table { break-inside: avoid; } }
`
