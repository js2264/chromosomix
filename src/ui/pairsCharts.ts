/**
 * The Pairs statistics card's three small charts (§3.7), drawn from the
 * import's own counts with no run.
 *
 * - **P(s) by orientation**: the four strand orientations' separation
 *   histograms, each bin's count over its width as pairtools' own plots divide
 *   it, on log-log axes, with a thin rule where pairtools finds the four meet.
 * - **Pair types**: one stacked bar of every record by its type.
 * - **Cis**: the share of the unique mapped pairs that is cis, and that reaches
 *   past each of pairtools' six distances, as small columns over a full track.
 *
 * ## Built by hand, in the theme
 *
 * Plain SVG rather than the analysis figures' canvas: a side card follows the
 * reader's theme, and every figure in the drawer is pinned light because it
 * leaves the app as a picture. So no colour is written here. Each mark carries
 * a class and the stylesheet gives it `--text-dim`, `--border`, `--accent` or
 * one of the card's own `--pairs-*` series, which have a light and a dark step
 * (`styles.css`, `.pairs-stats`).
 *
 * ## Laid out at the width it is shown at
 *
 * A chart is drawn at the card's width as measured, so a label is 10 px at any
 * column width rather than a scaled picture of one. Until it is measured — and
 * in a test, where nothing is — it is drawn at {@link DEFAULT_WIDTH}, the
 * General column's own, and scaled into whatever it is given, so nothing is cut
 * on the frame before the measurement either.
 *
 * ## What a library without something gets
 *
 * Each builder returns `null` for what it cannot draw — no strands, no
 * `pair_type` column, no cis pair — and the card leaves that chart out rather
 * than drawing an empty frame.
 */

import { CONVERGENCE_THRESHOLD, convergenceOf, STATS_STRANDS, type PairStats, type StatsStrands } from '../pairs/stats'
import { resolutionLabel } from '../units'
import { el, fmt } from './dom'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The width a chart is drawn at before it is measured: the General column's card. */
export const DEFAULT_WIDTH = 236

/** Below this, a chart is drawn at this width and scaled down rather than squeezed. */
const MIN_WIDTH = 140

/** The labels' size, in pixels. */
const FONT = 10

/** A label's width, for placing it: a generous average advance, so an estimate errs wide. */
function textWidth(text: string, size = FONT): number {
  return text.length * size * 0.6
}

type Attrs = Record<string, string | number>

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  for (const child of children) node.append(child)
  return node
}

/** A label, sized here so the layout and the drawing agree on it. */
function label(text: string, x: number, y: number, anchor: 'start' | 'middle' | 'end', cls = 'pairs-stats-label'): SVGTextElement {
  return svg('text', { class: cls, x: round(x), y: round(y), 'text-anchor': anchor, 'font-size': FONT }, text)
}

/** A hover's text on a mark. */
function tip(text: string): SVGTitleElement {
  return svg('title', {}, text)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** Half a pixel off the grid, so a one-pixel line lands on one row of pixels. */
function crisp(value: number): number {
  return Math.round(value) + 0.5
}

/**
 * An `svg` with an accessible name, drawn at the width it is given.
 *
 * `draw` is called again whenever the measured width changes, into an emptied
 * root, so the layout never has to scale. The height is fixed, so a redraw
 * never changes the box it was measured in — which would be a resize loop.
 */
function chartSvg(
  cls: string,
  height: number,
  ariaLabel: string,
  title: string,
  draw: (root: SVGSVGElement, width: number) => void,
): SVGSVGElement {
  const root = svg('svg', {
    class: `pairs-stats-svg ${cls}`,
    role: 'img',
    'aria-label': ariaLabel,
    width: '100%',
    height,
    preserveAspectRatio: 'xMinYMin meet',
  })
  let drawn = -1
  const paint = (measured: number): void => {
    const width = Math.max(MIN_WIDTH, Math.round(measured))
    if (width === drawn) return
    drawn = width
    root.setAttribute('viewBox', `0 0 ${width} ${height}`)
    root.replaceChildren(svg('title', {}, title))
    draw(root, width)
  }
  paint(DEFAULT_WIDTH)
  if (typeof ResizeObserver !== 'undefined') {
    // Never disconnected by hand. The card is built before it is mounted, so
    // the first word from the observer can come while the chart is still out
    // of the document — retiring it then left every chart at its default width
    // for good — and the panel moves cards between hosts. An observer that
    // only its own chart holds goes with the chart.
    new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0
      if (width > 0 && root.isConnected) paint(width)
    }).observe(root)
  }
  return root
}

/** A block of the card: a caption, what goes under it, and the chart. */
function block(cls: string, caption: string | HTMLElement, ...children: Array<Node | null>): HTMLElement {
  const head = typeof caption === 'string' ? el('div', { class: 'pairs-stats-caption', text: caption }) : caption
  return el('div', { class: `pairs-stats-chart ${cls}` }, head, ...children)
}

// ---------------------------------------------------------------------------
// P(s) by orientation
// ---------------------------------------------------------------------------

/** How each orientation is named, drawn and described. */
const ORIENTATIONS: Record<StatsStrands, { name: string; slot: number; dash: string; what: string }> = {
  '+-': { name: '+−', slot: 1, dash: '', what: 'inward, the reads facing each other' },
  '-+': { name: '−+', slot: 2, dash: '5 2.5', what: 'outward, the reads facing away' },
  '--': { name: '−−', slot: 3, dash: '1.5 2', what: 'tandem, both on the minus strand' },
  '++': { name: '++', slot: 4, dash: '7 2 1.5 2', what: 'tandem, both on the plus strand' },
}

/** One orientation's points: a bin's geometric centre and its count per base pair, `null` at an empty bin. */
export interface DecaySeries {
  strands: StatsStrands
  name: string
  points: Array<[number, number] | null>
  /** The separations the drawn bins cover: the first one's left edge and the last one's right. */
  span: [number, number]
  /** Cis pairs behind the line. */
  pairs: number
}

/**
 * Each orientation's contact frequency by separation, as pairtools plots it:
 * every bin's count over its width, at its geometric centre (the axis is
 * logarithmic). The `[0, 1)` bin has no place on a log axis and the last bin
 * no right edge, so neither is drawn; an empty bin is a break in the line.
 * An orientation with fewer than two points is left out, and so is the chart
 * when no orientation has two.
 */
export function decaySeries(stats: PairStats): DecaySeries[] {
  const edges = stats.distEdges
  const out: DecaySeries[] = []
  for (const strands of STATS_STRANDS) {
    const counts = stats.distFreq[strands]
    if (counts === undefined) continue
    const points: Array<[number, number] | null> = []
    let drawn = 0
    let pairs = 0
    const span: [number, number] = [Infinity, 0]
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i]
      const hi = edges[i + 1]
      const count = counts[i] ?? 0
      pairs += count
      if (lo <= 0) continue
      if (count > 0) {
        points.push([Math.sqrt(lo * hi), count / (hi - lo)])
        span[0] = Math.min(span[0], lo)
        span[1] = hi
        drawn++
      } else {
        points.push(null)
      }
    }
    if (drawn >= 2) out.push({ strands, name: ORIENTATIONS[strands].name, points, span, pairs })
  }
  return out
}

/** Every whole decade from `lo` to `hi`, both in log10. */
function decades(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let d = Math.ceil(lo - 1e-9); d <= Math.floor(hi + 1e-9); d++) out.push(d)
  return out
}

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
}

/** `-3` → `10⁻³`. */
function power(decade: number): string {
  return `10${[...String(decade)].map((c) => SUPERSCRIPT[c] ?? c).join('')}`
}

/** The P(s) chart's height: a few of the card's lines. */
const DECAY_HEIGHT = 104

/** P(s) by orientation, with the convergence marked, or `null` where no orientation has a line. */
export function decayChart(stats: PairStats): HTMLElement | null {
  const series = decaySeries(stats)
  if (series.length === 0) return null
  const { distance } = convergenceOf(stats)

  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const one of series) {
    for (const point of one.points) {
      if (point === null) continue
      xMin = Math.min(xMin, point[0])
      xMax = Math.max(xMax, point[0])
      yMin = Math.min(yMin, point[1])
      yMax = Math.max(yMax, point[1])
    }
  }
  // The mark is the right edge of the furthest bin that strays, which can lie
  // past the last bin's centre: the axis reaches it rather than losing it.
  const meet = distance !== null && distance > 0 && distance < 1e9 ? distance : null
  if (meet !== null) xMax = Math.max(xMax, meet)
  const lx = [Math.log10(xMin), Math.log10(xMax)]
  if (lx[1] - lx[0] < 1e-6) lx[1] = lx[0] + 1
  const ly = [Math.floor(Math.log10(yMin)), Math.ceil(Math.log10(yMax))]
  if (ly[1] === ly[0]) ly[1] = ly[0] + 1

  const meetText = meet === null ? null : resolutionLabel(meet)
  const range =
    `${resolutionLabel(Math.min(...series.map((one) => one.span[0])))} to ` +
    `${resolutionLabel(Math.max(...series.map((one) => one.span[1])))}`
  const ariaLabel =
    `Contact frequency by separation for ${series.length === 4 ? 'the four' : series.length} strand orientations, ` +
    `log-log, ${range}: ${series.map((one) => `${one.name} ${fmt.int(one.pairs)} pairs`).join(', ')}. ` +
    (meetText === null ? 'The orientations agree at every separation.' : `They meet past ${meetText}.`)
  const title = 'P(s) by strand orientation: cis pairs per base pair of separation, each bin over its width as pairtools plots it.'

  const chart = chartSvg('pairs-stats-decay', DECAY_HEIGHT, ariaLabel, title, (root, width) => {
    const yTicks = decades(ly[0], ly[1])
    const yLabelWidth = Math.max(...yTicks.map((d) => textWidth(power(d))))
    const left = Math.ceil(yLabelWidth + 5)
    const xTicks = decades(lx[0], lx[1])
    const right = width - 2
    const top = 4
    const bottom = DECAY_HEIGHT - 15
    const sx = (x: number): number => left + ((Math.log10(x) - lx[0]) / (lx[1] - lx[0])) * (right - left)
    const sy = (y: number): number => bottom - ((Math.log10(y) - ly[0]) / (ly[1] - ly[0])) * (bottom - top)

    // The y decades, thinned until two labels stand a line apart.
    const perDecade = (bottom - top) / (ly[1] - ly[0])
    const yStep = Math.max(1, Math.ceil((FONT + 3) / perDecade))
    const grid = svg('g', { class: 'pairs-stats-grid' })
    const labels = svg('g', { 'aria-hidden': 'true' })
    for (const d of yTicks) {
      if ((d - ly[0]) % yStep !== 0) continue
      const y = sy(10 ** d)
      grid.append(svg('line', { x1: left, x2: right, y1: crisp(y), y2: crisp(y) }))
      labels.append(label(power(d), left - 4, Math.min(bottom, Math.max(top + FONT * 0.7, y + FONT * 0.35)), 'end'))
    }
    // The x decades, every one that has room for its label; the last kept
    // inside the right edge.
    const xStepWidth = xTicks.length > 1 ? sx(10 ** xTicks[1]) - sx(10 ** xTicks[0]) : Infinity
    const widest = Math.max(0, ...xTicks.map((d) => textWidth(resolutionLabel(10 ** d))))
    const xStep = Math.max(1, Math.ceil((widest + 6) / xStepWidth))
    for (const d of xTicks) {
      if ((d - xTicks[0]) % xStep !== 0) continue
      const x = sx(10 ** d)
      grid.append(svg('line', { x1: crisp(x), x2: crisp(x), y1: top, y2: bottom }))
      const text = resolutionLabel(10 ** d)
      const half = textWidth(text) / 2
      const anchor = x + half > width ? 'end' : x - half < left - 2 ? 'start' : 'middle'
      labels.append(label(text, anchor === 'end' ? width : x, DECAY_HEIGHT - 3, anchor))
    }
    grid.append(svg('line', { class: 'pairs-stats-axis', x1: left, x2: right, y1: crisp(bottom), y2: crisp(bottom) }))
    root.append(grid)

    // The convergence: a rule, and its value at the top beside it.
    if (meet !== null && meetText !== null) {
      const x = crisp(sx(meet))
      const mark = svg('g', { class: 'pairs-stats-meet' })
      mark.append(
        svg('line', { class: 'pairs-stats-rule', x1: x, x2: x, y1: top, y2: bottom }),
        tip(
          `The four orientations meet past ${meetText}: above it each stays within ` +
            `${fmt.pct(CONVERGENCE_THRESHOLD, 0)} of their mean, as pairtools finds it.`,
        ),
      )
      const fits = x + 4 + textWidth(meetText) <= right
      mark.append(label(meetText, fits ? x + 4 : x - 4, top + FONT - 1, fits ? 'start' : 'end', 'pairs-stats-label pairs-stats-meet-label'))
      root.append(mark)
    }

    // The lines, the tandem pair first so the two that part at short range lie on top.
    const lines = svg('g', { class: 'pairs-stats-lines' })
    for (const one of [...series].reverse()) {
      const spec = ORIENTATIONS[one.strands]
      let d = ''
      let run = 0
      for (const point of one.points) {
        if (point === null) {
          run = 0
          continue
        }
        d += `${run === 0 ? 'M' : 'L'}${round(sx(point[0]))} ${round(sy(point[1]))}`
        run++
      }
      const path = svg('path', {
        class: `pairs-stats-line is-s${spec.slot}`,
        d,
        'data-strands': one.strands,
        ...(spec.dash === '' ? {} : { 'stroke-dasharray': spec.dash }),
      })
      path.append(tip(`${spec.name} ${spec.what}: ${fmt.int(one.pairs)} cis pairs`))
      lines.append(path)
    }
    root.append(lines, labels)
  })

  // The key: a line of each, dashed as it is drawn, so the four part without colour.
  const legend = el(
    'div',
    { class: 'pairs-stats-legend', attrs: { 'aria-hidden': 'true' } },
    ...series.map((one) => {
      const spec = ORIENTATIONS[one.strands]
      const sample = svg(
        'svg',
        { class: 'pairs-stats-key-line', width: 16, height: 6, viewBox: '0 0 16 6' },
        svg('line', {
          class: `pairs-stats-line is-s${spec.slot}`,
          x1: 0,
          x2: 16,
          y1: 3,
          y2: 3,
          ...(spec.dash === '' ? {} : { 'stroke-dasharray': spec.dash }),
        }),
      )
      return el('span', { class: 'pairs-stats-key', title: `${spec.name} ${spec.what}` }, sample, spec.name)
    }),
  )
  const caption = el('div', { class: 'pairs-stats-caption' }, el('span', { text: 'P(s) by orientation' }), legend)
  return block('pairs-stats-decay-block', caption, chart)
}

// ---------------------------------------------------------------------------
// Pair types
// ---------------------------------------------------------------------------

/** A type that is at least this share of the records gets a colour of its own… */
const TYPE_SHARE = 0.02
/** …and at most this many do; the rest are one neutral segment. */
const TYPE_SLOTS = 3

/** One segment of the pair-types bar. */
export interface TypeSegment {
  /** The type, or `null` for the rest together. */
  type: string | null
  types: string[]
  count: number
  /** `1`–`3`, or `0` for the neutral segment. */
  slot: number
}

/**
 * The bar's segments: the most common types with a colour each, and every
 * other type folded into one, since thirteen slivers are not readable and the
 * chips under the bar list each of them.
 */
export function typeSegments(stats: PairStats): TypeSegment[] {
  const types = stats.pairTypes.filter(([, count]) => count > 0)
  const whole = types.reduce((sum, [, count]) => sum + count, 0)
  if (whole === 0) return []
  const out: TypeSegment[] = []
  let at = 0
  while (at < types.length && out.length < TYPE_SLOTS && types[at][1] / whole >= TYPE_SHARE) {
    out.push({ type: types[at][0], types: [types[at][0]], count: types[at][1], slot: out.length + 1 })
    at++
  }
  const rest = types.slice(at)
  if (rest.length === 1) out.push({ type: rest[0][0], types: [rest[0][0]], count: rest[0][1], slot: 0 })
  else if (rest.length > 1)
    out.push({ type: null, types: rest.map(([type]) => type), count: rest.reduce((sum, [, count]) => sum + count, 0), slot: 0 })
  return out
}

/** Which segment of {@link typeSegments} a type is drawn in. */
export function slotOfType(segments: TypeSegment[], type: string): number {
  return segments.find((segment) => segment.types.includes(type))?.slot ?? 0
}

const TYPES_HEIGHT = 10
const GAP = 2

/** The pair types as one stacked bar, or `null` for a file with no `pair_type` column. */
export function typesBar(stats: PairStats): SVGSVGElement | null {
  const segments = typeSegments(stats)
  if (segments.length === 0) return null
  const whole = segments.reduce((sum, segment) => sum + segment.count, 0)
  const named = (segment: TypeSegment): string =>
    segment.type ?? `${segment.types.length} other types`
  const ariaLabel = `Pair types, of every record: ${segments.map((s) => `${named(s)} ${fmt.pct(s.count / whole)}`).join(', ')}.`
  return chartSvg('pairs-stats-types-bar', TYPES_HEIGHT, ariaLabel, 'Every record by its pair type, the most common first.', (root, width) => {
    const room = width - GAP * (segments.length - 1)
    // Every segment at least the gap's width, so a rare one is still a mark;
    // what that adds is taken off the widest.
    const widths = segments.map((segment) => Math.max(GAP, (segment.count / whole) * room))
    const excess = widths.reduce((sum, w) => sum + w, 0) - room
    widths[widths.indexOf(Math.max(...widths))] -= excess
    let x = 0
    segments.forEach((segment, i) => {
      const rect = svg('rect', {
        class: `pairs-stats-seg ${segment.slot === 0 ? 'is-other' : `is-s${segment.slot}`}`,
        x: round(x),
        y: 0,
        width: round(Math.max(0.5, widths[i])),
        height: TYPES_HEIGHT,
        rx: 2,
      })
      rect.append(
        tip(
          segment.type === null
            ? `${segment.types.join(', ')}: ${fmt.int(segment.count)} records · ${fmt.pct(segment.count / whole)}`
            : `${segment.type}: ${fmt.int(segment.count)} records · ${fmt.pct(segment.count / whole)}`,
        ),
      )
      root.append(rect)
      x += widths[i] + GAP
    })
  })
}

// ---------------------------------------------------------------------------
// Cis
// ---------------------------------------------------------------------------

/** The cis chart's columns: every cis pair, then each distance, as shares of the unique mapped pairs. */
export function cisColumns(stats: PairStats): Array<{ label: string; key: string; count: number; share: number }> {
  if (stats.totalNodups <= 0 || stats.cis <= 0) return []
  return [
    { label: 'cis', key: 'cis', count: stats.cis, share: stats.cis / stats.totalNodups },
    ...stats.cisAtLeast.map(([kb, count]) => ({
      label: `≥${kb}`,
      key: `cis ≥ ${kb} kb`,
      count,
      share: count / stats.totalNodups,
    })),
  ]
}

/**
 * A share short enough to stand over a narrow column: whole per cent from ten
 * up, a decimal under it — or whole per cent throughout, `compact`, where the
 * columns are too close for a decimal (the table above has every one).
 */
function shortShare(share: number, compact = false): string {
  if (share <= 0) return '0%'
  if (compact) return share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`
  if (share < 0.001) return '<0.1%'
  return share >= 0.1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`
}

const CIS_HEIGHT = 62

/** Cis, and cis past each distance, as columns over a full track, or `null` with no cis pair. */
export function cisChart(stats: PairStats): HTMLElement | null {
  const columns = cisColumns(stats)
  if (columns.length === 0) return null
  const ariaLabel =
    `Cis pairs as a share of the unique mapped pairs: ${fmt.pct(columns[0].share)} in all` +
    (columns.length > 1
      ? `; ${columns
          .slice(1)
          .map((column) => `${fmt.pct(column.share)} at least ${column.label.slice(1)} kb apart`)
          .join(', ')}.`
      : '.')
  const title = 'Cis pairs, and cis pairs at least so far apart, each of the unique mapped pairs.'
  const chart = chartSvg('pairs-stats-cis', CIS_HEIGHT, ariaLabel, title, (root, width) => {
    const slot = width / columns.length
    const barWidth = Math.min(22, Math.max(6, slot - 12))
    const top = 14
    const bottom = CIS_HEIGHT - 14
    const span = bottom - top
    const labels = svg('g', { 'aria-hidden': 'true' })
    const compact = Math.max(...columns.map((column) => textWidth(shortShare(column.share)))) > slot - 5
    columns.forEach((column, i) => {
      const centre = slot * (i + 0.5)
      const x = round(centre - barWidth / 2)
      const g = svg('g', { class: 'pairs-stats-column', 'data-key': column.key })
      g.append(
        tip(`${column.key}: ${fmt.int(column.count)} · ${fmt.pct(column.share)} of the unique mapped pairs`),
        svg('rect', { class: 'pairs-stats-track', x, y: top, width: barWidth, height: span, rx: 2 }),
      )
      const height = Math.max(column.share > 0 ? 1 : 0, Math.min(1, column.share) * span)
      if (height > 0) {
        g.append(
          svg('rect', {
            class: 'pairs-stats-fill',
            x,
            y: round(bottom - height),
            width: barWidth,
            height: round(height),
            rx: Math.min(2, height / 2),
          }),
        )
      }
      root.append(g)
      // The value over the column, and its name under it, each kept inside the chart.
      const place = (text: string, y: number): void => {
        const half = textWidth(text) / 2
        const anchor = centre + half > width ? 'end' : centre - half < 0 ? 'start' : 'middle'
        labels.append(label(text, anchor === 'end' ? width : anchor === 'start' ? 0 : centre, y, anchor))
      }
      place(shortShare(column.share, compact), top - 4)
      place(column.label, CIS_HEIGHT - 3)
    })
    root.append(labels)
  })
  return block('pairs-stats-cis-block', 'cis, all and ≥ N kb apart', chart)
}
