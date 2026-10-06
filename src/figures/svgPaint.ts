/**
 * An SVG picture, replayed as canvas drawing calls.
 *
 * This exists for one reason: the PDF export must stay a real vector export.
 *
 * Every figure in this app is a {@link PlotFigure} — an object with a `draw(ctx,
 * box)` that is handed *some* context and draws into it. On screen that context
 * belongs to a canvas; in an export it is a {@link VectorPage}, which turns the
 * same calls into PDF operators. That indirection is the whole reason a plot
 * leaves this application as paths and text rather than as a photograph of
 * pixels, and it is not something a charting library gives away: a library
 * paints into a canvas of its own, and what comes back is an image.
 *
 * So the library is asked for SVG instead — `zrender`'s SVG renderer, which is
 * what ECharts draws with here — and this module reads that SVG back out and
 * issues the equivalent canvas calls. One implementation then serves both
 * paths: the screen gets the calls on a real context, the PDF gets the same
 * calls on a page, and the two cannot drift, because they are the same drawing
 * twice rather than two drawings of the same data.
 *
 * The vocabulary handled is the one `zrender` emits, which is small and worth
 * naming: `<g transform>`, `<path d>` (`M L H V C S Q T A Z`, absolute and
 * relative), `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`,
 * `<polygon>`, `<text>`/`<tspan>`, `<defs>` holding `<clipPath>` and gradients,
 * and `<style>`, which carries only `:hover` rules and is therefore ignored.
 *
 * Three limits, stated rather than hidden:
 *
 * - **A linear gradient is bands.** A canvas context can hold a
 *   `CanvasGradient`, but a {@link VectorPage} holds only the radial one its
 *   structure painter asks for — so a shape filled with a linear one is clipped to and filled with a
 *   hundred bands across the gradient's line, each the colour the gradient has
 *   at its middle. That is what a chart's continuous colour bar is: it used to
 *   be flattened to its middle stop, and every exported pileup's key was one
 *   orange rectangle beside a picture in a hundred colours. A radial gradient,
 *   which nothing here draws, is still its middle stop; a gradient stroke is
 *   too.
 * - **`<image>` is skipped.** Nothing `zrender` draws for these charts is a
 *   raster; a contact map, which genuinely is one, is not drawn through here at
 *   all (`ui/analysisPlots.ts` keeps its own painter).
 * - **Arc flags must be separated.** SVG allows `a1 1 0 11 5 5`, gluing the two
 *   one-character flags to their neighbours. The scanner below reads them as
 *   single characters, so that form works too — but a flag written as anything
 *   other than `0` or `1` is refused rather than guessed at.
 */

import { pdfColour, type VectorTarget } from '../ui/vector'

/** The slice of a canvas context a replay needs. A real one satisfies it. */
export type PaintTarget = VectorTarget

/** The size to paint at, when it differs from the picture's own. */
export interface PaintBox {
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Inherited paint state
// ---------------------------------------------------------------------------

interface PaintState {
  /** `null` is SVG's `none`: the shape is not filled at all. */
  fill: string | null
  /**
   * The linear gradient a shape is filled with, where it is one; {@link fill}
   * is then its middle stop, for the text and the strokes that cannot be
   * banded.
   */
  fillGradient: LinearPaint | null
  stroke: string | null
  strokeWidth: number
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  dash: number[]
  fontSize: number
  fontFamily: string
  fontWeight: string
  fontStyle: string
  anchor: CanvasTextAlign
  baseline: CanvasTextBaseline
  /** Which of fill and stroke is laid down first, from `paint-order`. */
  strokeFirst: boolean
}

const INITIAL: PaintState = {
  fill: '#000000',
  fillGradient: null,
  stroke: null,
  strokeWidth: 1,
  opacity: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  dash: [],
  fontSize: 12,
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  anchor: 'left',
  baseline: 'alphabetic',
  strokeFirst: false,
}

/**
 * A presentation property, from the `style` attribute or the attribute itself.
 *
 * CSS wins, which is what a browser does and what `zrender` relies on: it puts
 * the font in `style` and the colours in attributes, on the same element.
 */
function prop(el: Element, inline: Map<string, string>, name: string): string | null {
  const styled = inline.get(name)
  if (styled !== undefined && styled !== '') return styled
  const attr = el.getAttribute(name)
  return attr === null || attr === '' ? null : attr
}

function inlineStyle(el: Element): Map<string, string> {
  const map = new Map<string, string>()
  const text = el.getAttribute('style')
  if (text === null) return map
  for (const rule of text.split(';')) {
    const colon = rule.indexOf(':')
    if (colon < 0) continue
    map.set(rule.slice(0, colon).trim().toLowerCase(), rule.slice(colon + 1).trim())
  }
  return map
}

function num(text: string | null, fallback: number): number {
  if (text === null) return fallback
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : fallback
}

function alignOf(text: string | null, fallback: CanvasTextAlign): CanvasTextAlign {
  if (text === 'middle') return 'center'
  if (text === 'end') return 'right'
  if (text === 'start') return 'left'
  return fallback
}

function baselineOf(text: string | null, fallback: CanvasTextBaseline): CanvasTextBaseline {
  switch (text) {
    case 'central':
    case 'middle':
      return 'middle'
    case 'hanging':
    case 'text-before-edge':
      return 'top'
    case 'text-after-edge':
    case 'ideographic':
      return 'bottom'
    case 'alphabetic':
    case 'auto':
      return 'alphabetic'
    default:
      return fallback
  }
}

function dashOf(text: string | null): number[] | null {
  if (text === null || text === 'none') return null
  const parts = text
    .split(/[\s,]+/)
    .filter((piece) => piece !== '')
    .map((piece) => Number.parseFloat(piece))
  if (parts.length === 0 || parts.some((on) => !Number.isFinite(on) || on < 0)) return []
  return parts
}

/** The state an element's own attributes make out of the one it inherited. */
function descend(el: Element, parent: PaintState, paints: Paints): PaintState {
  const inline = inlineStyle(el)
  const next: PaintState = { ...parent }

  const fill = prop(el, inline, 'fill')
  if (fill !== null) {
    next.fill = colourOf(fill, parent.fill, paints)
    next.fillGradient = gradientOf(fill, parent.fillGradient, paints)
  }
  const stroke = prop(el, inline, 'stroke')
  if (stroke !== null) next.stroke = colourOf(stroke, parent.stroke, paints)

  const width = prop(el, inline, 'stroke-width')
  if (width !== null) next.strokeWidth = num(width, parent.strokeWidth)
  const opacity = prop(el, inline, 'opacity')
  if (opacity !== null) next.opacity = parent.opacity * clamp01(num(opacity, 1))
  const fillOpacity = prop(el, inline, 'fill-opacity')
  if (fillOpacity !== null) next.fillOpacity = clamp01(num(fillOpacity, 1))
  const strokeOpacity = prop(el, inline, 'stroke-opacity')
  if (strokeOpacity !== null) next.strokeOpacity = clamp01(num(strokeOpacity, 1))

  const cap = prop(el, inline, 'stroke-linecap')
  if (cap === 'round' || cap === 'square' || cap === 'butt') next.lineCap = cap
  const join = prop(el, inline, 'stroke-linejoin')
  if (join === 'round' || join === 'bevel' || join === 'miter') next.lineJoin = join
  const dash = dashOf(prop(el, inline, 'stroke-dasharray'))
  if (dash !== null) next.dash = dash

  const size = prop(el, inline, 'font-size')
  if (size !== null) next.fontSize = num(size, parent.fontSize)
  const family = prop(el, inline, 'font-family')
  if (family !== null) next.fontFamily = family
  const weight = prop(el, inline, 'font-weight')
  if (weight !== null) next.fontWeight = weight
  const style = prop(el, inline, 'font-style')
  if (style !== null) next.fontStyle = style

  next.anchor = alignOf(prop(el, inline, 'text-anchor'), parent.anchor)
  next.baseline = baselineOf(
    prop(el, inline, 'dominant-baseline') ?? prop(el, inline, 'alignment-baseline'),
    parent.baseline,
  )
  const order = prop(el, inline, 'paint-order')
  if (order !== null) next.strokeFirst = order.trim().split(/\s+/)[0] === 'stroke'

  return next
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * A linear gradient as SVG states it: the line it runs along, in the shape's
 * own box (`objectBoundingBox`, the default) or in the user space the shape is
 * drawn in, and its stops in order.
 */
interface LinearPaint {
  units: 'objectBoundingBox' | 'userSpaceOnUse'
  x1: number
  y1: number
  x2: number
  y2: number
  stops: Array<{ offset: number; rgb: [number, number, number]; opacity: number }>
}

/**
 * Every gradient in the document, by id: the colour it stands for where only
 * one colour can be drawn — a stroke, a run of text, a radial gradient — and,
 * for a linear one, the gradient itself, for a fill to be banded with.
 */
type Paints = Map<string, { flat: string; linear: LinearPaint | null }>

/** The `#id` a `url(#id)` paint names, or `null` for any other paint. */
function urlOf(text: string): string | null {
  return /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/.exec(text.trim())?.[1] ?? null
}

/**
 * A paint value as a colour, or `null` for `none`.
 *
 * `url(#id)` is a gradient, which a colour string cannot be; the table built
 * by {@link collectPaints} holds the one stop that stands for each.
 */
function colourOf(value: string, inherited: string | null, paints: Paints): string | null {
  const text = value.trim()
  if (text === 'none' || text === 'transparent') return null
  if (text === 'currentColor' || text === 'inherit') return inherited
  const url = urlOf(text)
  if (url !== null) return paints.get(url)?.flat ?? null
  return text
}

/** The linear gradient a fill names, or `null` where it names anything else. */
function gradientOf(value: string, inherited: LinearPaint | null, paints: Paints): LinearPaint | null {
  const text = value.trim()
  if (text === 'inherit') return inherited
  const url = urlOf(text)
  return url === null ? null : (paints.get(url)?.linear ?? null)
}

/**
 * Every gradient in the document.
 *
 * Its single colour is the middle stop rather than the first, because a
 * gradient is chosen for the colour it reads as overall and its ends are the
 * extremes of that, not the average of it.
 */
function collectPaints(root: Element): Paints {
  const paints: Paints = new Map()
  const gradients = root.querySelectorAll('linearGradient, radialGradient')
  for (const gradient of Array.from(gradients)) {
    const id = gradient.getAttribute('id')
    if (id === null) continue
    const stops = Array.from(gradient.querySelectorAll('stop'))
    if (stops.length === 0) continue
    const middle = stops[Math.floor((stops.length - 1) / 2)]
    const flat = prop(middle, inlineStyle(middle), 'stop-color') ?? '#000000'
    paints.set(id, {
      flat,
      linear: gradient.tagName.toLowerCase() === 'lineargradient' ? linearOf(gradient, stops) : null,
    })
  }
  return paints
}

/**
 * A `<linearGradient>` read whole. Offsets are fractions or percentages and
 * never run backwards, as SVG has them; the line defaults to left to right
 * across the shape's box.
 */
function linearOf(gradient: Element, stops: Element[]): LinearPaint {
  const fraction = (text: string | null, fallback: number): number => {
    if (text === null || text.trim() === '') return fallback
    const value = Number.parseFloat(text)
    if (!Number.isFinite(value)) return fallback
    return text.trim().endsWith('%') ? value / 100 : value
  }
  let last = 0
  return {
    units: gradient.getAttribute('gradientUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox',
    x1: fraction(gradient.getAttribute('x1'), 0),
    y1: fraction(gradient.getAttribute('y1'), 0),
    x2: fraction(gradient.getAttribute('x2'), 1),
    y2: fraction(gradient.getAttribute('y2'), 0),
    stops: stops.map((stop) => {
      const inline = inlineStyle(stop)
      last = Math.max(last, clamp01(fraction(stop.getAttribute('offset'), 0)))
      return {
        offset: last,
        rgb: pdfColour(prop(stop, inline, 'stop-color') ?? '#000000'),
        opacity: clamp01(num(prop(stop, inline, 'stop-opacity'), 1)),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number]

/**
 * An SVG `transform` attribute as one matrix.
 *
 * Applied to the context with `transform` rather than `setTransform`, so it
 * composes with wherever the caller already placed the figure.
 */
export function parseTransform(text: string): Matrix {
  let out: Matrix = [1, 0, 0, 1, 0, 0]
  const each = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let found: RegExpExecArray | null
  while ((found = each.exec(text)) !== null) {
    const args = found[2]
      .split(/[\s,]+/)
      .filter((piece) => piece !== '')
      .map((piece) => Number.parseFloat(piece))
      .map((value) => (Number.isFinite(value) ? value : 0))
    out = compose(out, single(found[1], args))
  }
  return out
}

function single(kind: string, a: number[]): Matrix {
  switch (kind) {
    case 'matrix':
      return [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0]
    case 'translate':
      return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    case 'scale': {
      const sx = a[0] ?? 1
      return [sx, 0, 0, a[1] ?? sx, 0, 0]
    }
    case 'rotate': {
      const angle = ((a[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const turn: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (a.length < 3) return turn
      const cx = a[1]
      const cy = a[2]
      return compose(compose([1, 0, 0, 1, cx, cy], turn), [1, 0, 0, 1, -cx, -cy])
    }
    case 'skewX':
      return [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

function compose(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

/**
 * A `d` attribute, issued as path calls on the context.
 *
 * The scanner is positional rather than a token list, for one reason: an arc's
 * two flags are single characters that may be glued to the numbers around them
 * (`a1 1 0 11 5 5` is legal and means flags `1` and `1`), and a tokeniser that
 * read numbers greedily would see `11` and mis-shape the curve.
 *
 * Arcs are converted to cubics here rather than passed on, because a canvas has
 * no elliptical-arc-to and the conversion is exact for the segments the
 * standard decomposition produces.
 */
export function paintPath(ctx: PaintTarget, d: string): void {
  let at = 0
  const skip = (): void => {
    while (at < d.length && (d[at] === ' ' || d[at] === ',' || d[at] === '\n' || d[at] === '\t' || d[at] === '\r')) {
      at += 1
    }
  }
  const number = (): number => {
    skip()
    const start = at
    if (d[at] === '+' || d[at] === '-') at += 1
    while (at < d.length && d[at] >= '0' && d[at] <= '9') at += 1
    if (d[at] === '.') {
      at += 1
      while (at < d.length && d[at] >= '0' && d[at] <= '9') at += 1
    }
    if (d[at] === 'e' || d[at] === 'E') {
      at += 1
      if (d[at] === '+' || d[at] === '-') at += 1
      while (at < d.length && d[at] >= '0' && d[at] <= '9') at += 1
    }
    const value = Number.parseFloat(d.slice(start, at))
    return Number.isFinite(value) ? value : Number.NaN
  }
  const flag = (): number => {
    skip()
    const ch = d[at]
    if (ch === '0' || ch === '1') {
      at += 1
      return ch === '1' ? 1 : 0
    }
    return Number.NaN
  }
  const more = (): boolean => {
    skip()
    const ch = d[at]
    return ch !== undefined && (ch === '+' || ch === '-' || ch === '.' || (ch >= '0' && ch <= '9'))
  }

  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  /** The reflection point `S` and `T` need, or `null` after any other command. */
  let lastCubic: { x: number; y: number } | null = null
  let lastQuad: { x: number; y: number } | null = null
  let open = false

  const move = (nx: number, ny: number): void => {
    ctx.moveTo(nx, ny)
    x = nx
    y = ny
    startX = nx
    startY = ny
    open = true
  }
  const line = (nx: number, ny: number): void => {
    if (!open) move(nx, ny)
    else {
      ctx.lineTo(nx, ny)
      x = nx
      y = ny
    }
  }
  const cubic = (
    c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number,
  ): void => {
    if (!open) move(x, y)
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, nx, ny)
    x = nx
    y = ny
  }

  let code = ''
  skip()
  while (at < d.length) {
    const ch = d[at]
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      code = ch
      at += 1
    } else if (code === '') {
      // Junk before any command: nothing can be drawn from it.
      return
    } else if (code === 'M') {
      code = 'L'
    } else if (code === 'm') {
      code = 'l'
    }
    const rel = code === code.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0

    switch (code.toUpperCase()) {
      case 'Z': {
        ctx.closePath()
        x = startX
        y = startY
        lastCubic = null
        lastQuad = null
        // `Z` has no implicit repeat, so the next thing must be a command
        // letter; forgetting the code is what makes a stray number end the
        // walk instead of closing the same subpath for ever.
        code = ''
        skip()
        continue
      }
      case 'M': {
        move(ox + number(), oy + number())
        lastCubic = null
        lastQuad = null
        break
      }
      case 'L': {
        line(ox + number(), oy + number())
        lastCubic = null
        lastQuad = null
        break
      }
      case 'H': {
        line(ox + number(), y)
        lastCubic = null
        lastQuad = null
        break
      }
      case 'V': {
        line(x, oy + number())
        lastCubic = null
        lastQuad = null
        break
      }
      case 'C': {
        const c1x = ox + number()
        const c1y = oy + number()
        const c2x = ox + number()
        const c2y = oy + number()
        const nx = ox + number()
        const ny = oy + number()
        cubic(c1x, c1y, c2x, c2y, nx, ny)
        lastCubic = { x: c2x, y: c2y }
        lastQuad = null
        break
      }
      case 'S': {
        const c1x: number = lastCubic === null ? x : 2 * x - lastCubic.x
        const c1y: number = lastCubic === null ? y : 2 * y - lastCubic.y
        const c2x = ox + number()
        const c2y = oy + number()
        const nx = ox + number()
        const ny = oy + number()
        cubic(c1x, c1y, c2x, c2y, nx, ny)
        lastCubic = { x: c2x, y: c2y }
        lastQuad = null
        break
      }
      case 'Q': {
        const cx = ox + number()
        const cy = oy + number()
        const nx = ox + number()
        const ny = oy + number()
        if (!open) move(x, y)
        ctx.quadraticCurveTo(cx, cy, nx, ny)
        x = nx
        y = ny
        lastQuad = { x: cx, y: cy }
        lastCubic = null
        break
      }
      case 'T': {
        const cx: number = lastQuad === null ? x : 2 * x - lastQuad.x
        const cy: number = lastQuad === null ? y : 2 * y - lastQuad.y
        const nx = ox + number()
        const ny = oy + number()
        if (!open) move(x, y)
        ctx.quadraticCurveTo(cx, cy, nx, ny)
        x = nx
        y = ny
        lastQuad = { x: cx, y: cy }
        lastCubic = null
        break
      }
      case 'A': {
        const rx = number()
        const ry = number()
        const angle = number()
        const large = flag()
        const sweep = flag()
        const nx = ox + number()
        const ny = oy + number()
        if (Number.isNaN(large) || Number.isNaN(sweep) || Number.isNaN(nx) || Number.isNaN(ny)) {
          return
        }
        if (!open) move(x, y)
        for (const seg of arcToCubics(x, y, rx, ry, angle, large === 1, sweep === 1, nx, ny)) {
          ctx.bezierCurveTo(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5])
        }
        x = nx
        y = ny
        lastCubic = null
        lastQuad = null
        break
      }
      default:
        return
    }
    if (Number.isNaN(x) || Number.isNaN(y)) return
    skip()
    if (!more() && at < d.length && !/[MmLlHhVvCcSsQqTtAaZz]/.test(d[at])) return
  }
}

/**
 * An elliptical arc as a run of cubics.
 *
 * The endpoint parameterisation SVG uses turned into the centre one, then split
 * into segments of at most a quarter turn — the span over which the standard
 * `4/3·tan(θ/4)` handle is accurate to well under a printed pixel.
 */
export function arcToCubics(
  x1: number, y1: number,
  rxIn: number, ryIn: number,
  degrees: number,
  large: boolean,
  sweep: boolean,
  x2: number, y2: number,
): Array<[number, number, number, number, number, number]> {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  // A zero radius is a straight line, per the specification.
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]

  const phi = (degrees * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy

  // Radii too small to reach the endpoint are scaled up until they just do.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const grow = Math.sqrt(lambda)
    rx *= grow
    ry *= grow
  }

  const sign = large === sweep ? -1 : 1
  const top = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const bottom = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const factor = bottom === 0 ? 0 : sign * Math.sqrt(Math.max(0, top / bottom))
  const cxp = (factor * rx * y1p) / ry
  const cyp = (-factor * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2

  const angleOf = (ux: number, uy: number): number => Math.atan2(uy, ux)
  const start = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry)
  const end = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry)
  let span = end - start
  if (!sweep && span > 0) span -= 2 * Math.PI
  if (sweep && span < 0) span += 2 * Math.PI

  const steps = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)))
  const step = span / steps
  const handle = (4 / 3) * Math.tan(step / 4)
  const out: Array<[number, number, number, number, number, number]> = []
  const at = (angle: number): [number, number] => [
    cx + rx * Math.cos(angle) * cos - ry * Math.sin(angle) * sin,
    cy + rx * Math.cos(angle) * sin + ry * Math.sin(angle) * cos,
  ]
  const slope = (angle: number): [number, number] => [
    -rx * Math.sin(angle) * cos - ry * Math.cos(angle) * sin,
    -rx * Math.sin(angle) * sin + ry * Math.cos(angle) * cos,
  ]
  for (let i = 0; i < steps; i++) {
    const a0 = start + i * step
    const a1 = a0 + step
    const [px, py] = at(a0)
    const [qx, qy] = at(a1)
    const [dpx, dpy] = slope(a0)
    const [dqx, dqy] = slope(a1)
    out.push([
      px + handle * dpx, py + handle * dpy,
      qx - handle * dqx, qy - handle * dqy,
      qx, qy,
    ])
  }
  return out
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** Parse an SVG document and paint it. See {@link paintSvgElement}. */
export function paintSvgString(svg: string, ctx: PaintTarget, box?: PaintBox): void {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (root === null || root.nodeName === 'parsererror') return
  paintSvgElement(root, ctx, box)
}

/**
 * Paint an `<svg>` element's contents onto a context.
 *
 * `box` scales the picture to a size other than its own — a PNG exported at
 * twice the screen size, say — by the one transform that keeps it a drawing
 * rather than an enlargement of pixels.
 */
export function paintSvgElement(root: Element, ctx: PaintTarget, box?: PaintBox): void {
  const size = sizeOf(root)
  const paints = collectPaints(root)
  const clips = collectClips(root)

  ctx.save()
  if (box !== undefined && size !== null && size.width > 0 && size.height > 0) {
    const sx = box.width / size.width
    const sy = box.height / size.height
    if (sx !== 1 || sy !== 1) ctx.transform(sx, 0, 0, sy, 0, 0)
  }
  // The viewBox's own origin, so a picture that does not start at (0, 0) lands
  // where it says it does.
  if (size !== null && (size.x !== 0 || size.y !== 0)) ctx.transform(1, 0, 0, 1, -size.x, -size.y)
  walk(root, ctx, INITIAL, paints, clips)
  ctx.restore()
}

/** The picture's own coordinate box, from `viewBox` or `width`/`height`. */
function sizeOf(root: Element): { x: number; y: number; width: number; height: number } | null {
  const view = root.getAttribute('viewBox')
  if (view !== null) {
    const parts = view
      .split(/[\s,]+/)
      .filter((piece) => piece !== '')
      .map((piece) => Number.parseFloat(piece))
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    }
  }
  const width = num(root.getAttribute('width'), Number.NaN)
  const height = num(root.getAttribute('height'), Number.NaN)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return { x: 0, y: 0, width, height }
}

/** Every `<clipPath>` in the document, by id. */
function collectClips(root: Element): Map<string, Element> {
  const clips = new Map<string, Element>()
  for (const clip of Array.from(root.querySelectorAll('clipPath'))) {
    const id = clip.getAttribute('id')
    if (id !== null) clips.set(id, clip)
  }
  return clips
}

const SKIP = new Set(['defs', 'style', 'clippath', 'lineargradient', 'radialgradient', 'title', 'desc', 'metadata', 'filter', 'mask', 'pattern', 'marker', 'symbol'])

function walk(
  el: Element,
  ctx: PaintTarget,
  inherited: PaintState,
  paints: Paints,
  clips: Map<string, Element>,
): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase()
    if (SKIP.has(tag)) continue
    const state = descend(child, inherited, paints)
    const matrix = transformOf(child)
    const clip = clipOf(child, clips)

    const framed = !isIdentity(matrix) || clip !== null
    if (framed) ctx.save()
    if (!isIdentity(matrix)) ctx.transform(...matrix)
    if (clip !== null) applyClip(ctx, clip, clips)

    if (tag === 'g' || tag === 'a' || tag === 'svg') {
      walk(child, ctx, state, paints, clips)
    } else {
      shape(child, tag, ctx, state)
    }

    if (framed) ctx.restore()
  }
}

function transformOf(el: Element): Matrix {
  const text = el.getAttribute('transform')
  return text === null || text === '' ? IDENTITY : parseTransform(text)
}

function clipOf(el: Element, clips: Map<string, Element>): Element | null {
  const text = el.getAttribute('clip-path') ?? inlineStyle(el).get('clip-path') ?? null
  if (text === null) return null
  const url = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/.exec(text.trim())
  if (url === null) return null
  return clips.get(url[1]) ?? null
}

/**
 * A `<clipPath>`, as a clip on the context.
 *
 * Every child contributes to one path, which is what SVG says a clip path is:
 * the union of its shapes. Nothing inside it is filled or stroked.
 */
function applyClip(ctx: PaintTarget, clip: Element, clips: Map<string, Element>): void {
  ctx.beginPath()
  let any = false
  for (const child of Array.from(clip.children)) {
    const matrix = transformOf(child)
    // A transform on a clip child would have to move the path's own points,
    // since the clip is built as one path; identity is what `zrender` emits and
    // anything else is skipped rather than silently mis-clipped.
    if (!isIdentity(matrix)) continue
    if (outline(child, child.tagName.toLowerCase(), ctx)) any = true
  }
  const nested = clipOf(clip, clips)
  if (nested !== null) applyClip(ctx, nested, clips)
  if (any) ctx.clip()
}

/**
 * The geometry of one shape, added to the current path.
 *
 * Split out from {@link shape} because a clip path needs exactly this and none
 * of the painting.
 */
function outline(el: Element, tag: string, ctx: PaintTarget): boolean {
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d')
      if (d === null || d === '') return false
      paintPath(ctx, d)
      return true
    }
    case 'rect': {
      const x = num(el.getAttribute('x'), 0)
      const y = num(el.getAttribute('y'), 0)
      const width = num(el.getAttribute('width'), 0)
      const height = num(el.getAttribute('height'), 0)
      if (!(width > 0) || !(height > 0)) return false
      const rx = Math.min(num(el.getAttribute('rx'), 0), width / 2)
      const ry = Math.min(num(el.getAttribute('ry'), rx), height / 2)
      if (rx > 0 && ry > 0) roundedRect(ctx, x, y, width, height, rx, ry)
      else ctx.rect(x, y, width, height)
      return true
    }
    case 'circle': {
      const r = num(el.getAttribute('r'), 0)
      if (!(r > 0)) return false
      ctx.moveTo(num(el.getAttribute('cx'), 0) + r, num(el.getAttribute('cy'), 0))
      ctx.arc(num(el.getAttribute('cx'), 0), num(el.getAttribute('cy'), 0), r, 0, Math.PI * 2)
      return true
    }
    case 'ellipse': {
      const rx = num(el.getAttribute('rx'), 0)
      const ry = num(el.getAttribute('ry'), 0)
      if (!(rx > 0) || !(ry > 0)) return false
      // As an arc, since `ellipse` is not in the slice of the context this can
      // count on; the four-cubic decomposition is the same one an arc gets.
      const cx = num(el.getAttribute('cx'), 0)
      const cy = num(el.getAttribute('cy'), 0)
      ctx.moveTo(cx + rx, cy)
      for (const seg of arcToCubics(cx + rx, cy, rx, ry, 0, true, true, cx - rx, cy)) {
        ctx.bezierCurveTo(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5])
      }
      for (const seg of arcToCubics(cx - rx, cy, rx, ry, 0, true, true, cx + rx, cy)) {
        ctx.bezierCurveTo(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5])
      }
      ctx.closePath()
      return true
    }
    case 'line': {
      ctx.moveTo(num(el.getAttribute('x1'), 0), num(el.getAttribute('y1'), 0))
      ctx.lineTo(num(el.getAttribute('x2'), 0), num(el.getAttribute('y2'), 0))
      return true
    }
    case 'polyline':
    case 'polygon': {
      const points = (el.getAttribute('points') ?? '')
        .split(/[\s,]+/)
        .filter((piece) => piece !== '')
        .map((piece) => Number.parseFloat(piece))
      if (points.length < 4) return false
      ctx.moveTo(points[0], points[1])
      for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(points[i], points[i + 1])
      if (tag === 'polygon') ctx.closePath()
      return true
    }
    default:
      return false
  }
}

function roundedRect(
  ctx: PaintTarget,
  x: number, y: number, w: number, h: number,
  rx: number, ry: number,
): void {
  ctx.moveTo(x + rx, y)
  ctx.lineTo(x + w - rx, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + ry)
  ctx.lineTo(x + w, y + h - ry)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rx, y + h)
  ctx.lineTo(x + rx, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - ry)
  ctx.lineTo(x, y + ry)
  ctx.quadraticCurveTo(x, y, x + rx, y)
  ctx.closePath()
}

function shape(el: Element, tag: string, ctx: PaintTarget, state: PaintState): void {
  if (tag === 'text' || tag === 'tspan') {
    paintText(el, ctx, state)
    return
  }
  // A raster has no vector form, and nothing these figures draw is one.
  if (tag === 'image' || tag === 'use' || tag === 'foreignobject') return

  ctx.beginPath()
  if (!outline(el, tag, ctx)) return
  const gradient = state.fill === null ? null : state.fillGradient
  if (gradient === null) {
    fillAndStroke(ctx, state, false)
    return
  }
  // A banded fill clips to the outline, so the stroke is laid along it again
  // afterwards — in the order `paint-order` asks for, as for any other shape.
  const fill = (): void => paintGradient(el, tag, ctx, state, gradient)
  const stroke = (): void => {
    ctx.beginPath()
    outline(el, tag, ctx)
    fillAndStroke(ctx, { ...state, fill: null }, false)
  }
  if (state.strokeFirst) {
    stroke()
    fill()
  } else {
    fill()
    stroke()
  }
}

/** How many bands a gradient's whole line is cut into, at most, between its first stop and its last. */
const GRADIENT_BANDS = 100

/**
 * A shape filled with a linear gradient, as bands.
 *
 * Each band is a strip square to the gradient's line, clipped to the shape and
 * filled with the colour the gradient has at the strip's middle: a hundred
 * across the line, fewer where two stops are closer than a hundredth and one
 * where two stops are the same colour, plus the first and last stops' colours
 * padding out to the shape's edges, which is SVG's `spreadMethod="pad"`. An
 * opaque band runs on into the next by half its width, since two strips that
 * merely touch leave a hairline of the page between them in every
 * anti-aliased reader; the next one covers the overlap.
 *
 * In `objectBoundingBox` units the line is in fractions of the shape's own box
 * and so are the strips — square to the line *in that box*, as SVG has it,
 * which on a box that is not square is a parallelogram on the page.
 */
function paintGradient(el: Element, tag: string, ctx: PaintTarget, state: PaintState, gradient: LinearPaint): void {
  const bounds = boundsOf(el, tag)
  if (bounds === null || gradient.stops.length === 0) return
  // Gradient space → the shape's user space: the box's own affine for
  // `objectBoundingBox`, the identity for `userSpaceOnUse`.
  const boxed = gradient.units === 'objectBoundingBox'
  const toUser = (x: number, y: number): [number, number] =>
    boxed ? [bounds.x + x * bounds.width, bounds.y + y * bounds.height] : [x, y]
  const corners: Array<[number, number]> = boxed
    ? [[0, 0], [1, 0], [1, 1], [0, 1]]
    : [
        [bounds.x, bounds.y],
        [bounds.x + bounds.width, bounds.y],
        [bounds.x + bounds.width, bounds.y + bounds.height],
        [bounds.x, bounds.y + bounds.height],
      ]
  const dx = gradient.x2 - gradient.x1
  const dy = gradient.y2 - gradient.y1
  const length2 = dx * dx + dy * dy
  const stops = gradient.stops
  const first = stops[0]
  const last = stops[stops.length - 1]
  const alpha = state.opacity * state.fillOpacity
  const band = (from: number, to: number, rgb: [number, number, number], opacity: number): void => {
    // A strip of the gradient's line from `from` to `to`, wide enough across
    // to cover every corner of the shape.
    const along = (t: number): [number, number] => [gradient.x1 + dx * t, gradient.y1 + dy * t]
    const nx = -dy / Math.sqrt(length2)
    const ny = dx / Math.sqrt(length2)
    let reach = 0
    for (const [cx, cy] of corners) {
      reach = Math.max(reach, Math.abs((cx - gradient.x1) * nx + (cy - gradient.y1) * ny))
    }
    reach += 1
    const [ax, ay] = along(from)
    const [bx, by] = along(to)
    const quad = [
      toUser(ax + nx * reach, ay + ny * reach),
      toUser(bx + nx * reach, by + ny * reach),
      toUser(bx - nx * reach, by - ny * reach),
      toUser(ax - nx * reach, ay - ny * reach),
    ]
    ctx.globalAlpha = alpha * opacity
    ctx.fillStyle = `rgb(${rgb.map((v) => Math.round(clamp01(v) * 255)).join(', ')})`
    ctx.beginPath()
    ctx.moveTo(quad[0][0], quad[0][1])
    for (const [x, y] of quad.slice(1)) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
  }

  ctx.save()
  ctx.beginPath()
  outline(el, tag, ctx)
  ctx.clip()
  if (!(length2 > 0)) {
    // A line of no length paints the last stop everywhere, as SVG says.
    band(-1, 1, last.rgb, last.opacity)
  } else {
    // Where the shape's corners fall on the line, so the padding reaches them.
    let lo = 0
    let hi = 1
    for (const [cx, cy] of corners) {
      const t = ((cx - gradient.x1) * dx + (cy - gradient.y1) * dy) / length2
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
    type Strip = { from: number; to: number; rgb: [number, number, number]; opacity: number }
    const strips: Strip[] = []
    // Neighbours of one colour are one strip: a gradient of a hundred equal
    // stops — the grey track behind a chart's colour bar — is one fill.
    const push = (strip: Strip): void => {
      const before = strips[strips.length - 1]
      const same =
        before !== undefined &&
        before.opacity === strip.opacity &&
        before.rgb.every((v, channel) => v === strip.rgb[channel])
      if (same) before.to = strip.to
      else strips.push(strip)
    }
    if (lo < first.offset) push({ from: lo - 0.01, to: first.offset, rgb: first.rgb, opacity: first.opacity })
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k]
      const b = stops[k + 1]
      const span = b.offset - a.offset
      if (!(span > 0)) continue
      const same = a.opacity === b.opacity && a.rgb.every((v, channel) => v === b.rgb[channel])
      const count = same ? 1 : Math.max(1, Math.round(span * GRADIENT_BANDS))
      for (let i = 0; i < count; i++) {
        const mid = (i + 0.5) / count
        push({
          from: a.offset + (span * i) / count,
          to: a.offset + (span * (i + 1)) / count,
          rgb: [0, 1, 2].map((channel) => a.rgb[channel] + (b.rgb[channel] - a.rgb[channel]) * mid) as [
            number,
            number,
            number,
          ],
          opacity: a.opacity + (b.opacity - a.opacity) * mid,
        })
      }
    }
    if (hi > last.offset) push({ from: last.offset, to: hi + 0.01, rgb: last.rgb, opacity: last.opacity })
    strips.forEach((strip, index) => {
      const opaque = alpha * strip.opacity >= 1 && index + 1 < strips.length
      band(strip.from, opaque ? strip.to + (strip.to - strip.from) / 2 : strip.to, strip.rgb, strip.opacity)
    })
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

/**
 * A shape's box in its own user space, from the same outline it is drawn
 * with: every point the outline visits, a curve's handles included. That is
 * the box a little generously for a curve that does not reach its handles,
 * which on the shapes a chart fills with a gradient — rectangles and polygons
 * — is the box exactly.
 */
function boundsOf(el: Element, tag: string): { x: number; y: number; width: number; height: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number): void => {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const noop = (): void => {}
  const recorder = {
    beginPath: noop,
    closePath: noop,
    moveTo: add,
    lineTo: add,
    rect: (x: number, y: number, w: number, h: number) => {
      add(x, y)
      add(x + w, y + h)
    },
    arc: (x: number, y: number, r: number) => {
      add(x - r, y - r)
      add(x + r, y + r)
    },
    bezierCurveTo: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      add(a, b)
      add(c, d)
      add(e, f)
    },
    quadraticCurveTo: (a: number, b: number, c: number, d: number) => {
      add(a, b)
      add(c, d)
    },
  }
  if (!outline(el, tag, recorder as unknown as PaintTarget)) return null
  if (!(x1 > x0) || !(y1 > y0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Lay down the fill and the stroke, in the order `paint-order` asks for.
 *
 * `globalAlpha` carries both the element's own opacity and the per-paint one,
 * because that is the only transparency the target has — and it is enough:
 * SVG's two opacities multiply into exactly this number for a shape painted on
 * its own, which every shape here is.
 */
function fillAndStroke(ctx: PaintTarget, state: PaintState, text: boolean): void {
  const strokes = state.stroke !== null && state.strokeWidth > 0
  const paintFill = (): void => {
    if (state.fill === null) return
    ctx.globalAlpha = state.opacity * state.fillOpacity
    ctx.fillStyle = state.fill
    if (!text) ctx.fill()
  }
  const paintStroke = (): void => {
    if (!strokes) return
    ctx.globalAlpha = state.opacity * state.strokeOpacity
    ctx.strokeStyle = state.stroke as string
    ctx.lineWidth = state.strokeWidth
    ctx.lineJoin = state.lineJoin
    ctx.lineCap = state.lineCap
    ctx.setLineDash(state.dash)
    if (!text) ctx.stroke()
  }
  if (state.strokeFirst) {
    paintStroke()
    paintFill()
  } else {
    paintFill()
    paintStroke()
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
}

/**
 * One run of text.
 *
 * `x`/`y` are the SVG anchor, and `text-anchor`/`dominant-baseline` have already
 * become the canvas's `textAlign`/`textBaseline`, so the context places the run
 * itself — which matters for the export, where the offsets are worked out from
 * the screen font's metrics rather than guessed.
 *
 * A stroked run is `zrender`'s halo, kept because a label over a busy series is
 * unreadable without it; `paint-order` decides which way round the two go.
 */
function paintText(el: Element, ctx: PaintTarget, state: PaintState): void {
  const spans = Array.from(el.children).filter(
    (child) => child.tagName.toLowerCase() === 'tspan',
  )
  const text = spans.length > 0 ? '' : (el.textContent ?? '')

  if (text.trim() !== '') {
    const x = num(el.getAttribute('x'), 0) + num(el.getAttribute('dx'), 0)
    const y = num(el.getAttribute('y'), 0) + num(el.getAttribute('dy'), 0)
    ctx.font = fontOf(state)
    ctx.textAlign = state.anchor
    ctx.textBaseline = state.baseline
    const strokes = state.stroke !== null && state.strokeWidth > 0
    const write = (): void => {
      if (state.fill === null) return
      ctx.globalAlpha = state.opacity * state.fillOpacity
      ctx.fillStyle = state.fill
      ctx.fillText(text, x, y)
    }
    const halo = (): void => {
      if (!strokes) return
      ctx.globalAlpha = state.opacity * state.strokeOpacity
      ctx.strokeStyle = state.stroke as string
      ctx.lineWidth = state.strokeWidth
      ctx.lineJoin = state.lineJoin
      ctx.setLineDash([])
      ctx.strokeText(text, x, y)
    }
    if (state.strokeFirst) {
      halo()
      write()
    } else {
      write()
      halo()
    }
    ctx.globalAlpha = 1
  }

  for (const span of spans) paintText(span, ctx, descend(span, state, new Map()))
}

/** A CSS `font` shorthand out of the resolved text state. */
function fontOf(state: PaintState): string {
  const style = state.fontStyle !== 'normal' ? `${state.fontStyle} ` : ''
  const weight = state.fontWeight !== 'normal' ? `${state.fontWeight} ` : ''
  return `${style}${weight}${state.fontSize}px ${state.fontFamily}`
}
