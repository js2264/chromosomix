/**
 * The app's mark drawn inline, for the two places on the landing page where a
 * picture of it is not enough.
 *
 * - **Beside the name** (`mastheadMark`), whose cells are elements so that the
 *   X the name ends on can be drawn on them when the pointer is over the
 *   masthead: the corners light, the arms run in to the centre, the diagonal
 *   steps back, and the map settles again (`styles.css`, `.cx-arm`). Drawn as
 *   vector it is also sharp at the size the masthead sets it, which the 192 px
 *   icon the header uses is not on every screen.
 * - **In the page's right margin** (`markWatermark`): the map and its lanes
 *   without the plate, half of it, faint, in the theme's own colours — the
 *   light plate's ember on paper and the dark plate's on ink — which a PNG of
 *   one variant cannot follow.
 *
 * Both are built from `mark.generated.ts`, which `scripts/make-app-icons.py`
 * writes from the constants every PNG of the mark is rendered from, so this
 * file holds no drawing of its own. Built with `createElementNS` and
 * attributes alone: the page's policy allows no inline `style` (§21.6).
 */

import {
  MARK_CELLS,
  MARK_LANE_RADIUS,
  MARK_LANES,
  MARK_MAP,
  MARK_PLATE,
  MARK_VIEW,
} from './mark.generated'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Ids for the gradients, unique however many marks are built. */
let nextMark = 0

function node(tag: string, attrs: Record<string, string | number>): SVGElement {
  const out = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) out.setAttribute(key, String(value))
  return out
}

function frame(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${MARK_VIEW} ${MARK_VIEW}`)
  svg.setAttribute('class', className)
  // Decorative wherever it is drawn: the name stands beside it.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  return svg
}

/**
 * Where a cell sits in the X: `0` for the far corners, `3` for the centre, and
 * `null` off the anti-diagonal. Counted from the corners in, because that is
 * the order the arms light in.
 */
export function armStep(row: number, column: number, n = 7): number | null {
  if (row + column !== n - 1) return null
  return Math.min(row, column)
}

/** A cell's classes: its step on the X, or its place on the diagonal the X crosses. */
function cellClass(row: number, column: number): string | null {
  const step = armStep(row, column)
  if (step !== null) return `cx-arm cx-arm-${step}`
  return row === column ? 'cx-diag' : null
}

/** The map's cells, in one colour, each with its intensity as opacity. */
function cells(fill: string, animated: boolean): SVGElement {
  const group = node('g', { fill })
  const { x, y, pitch, inset, round } = MARK_MAP
  const size = pitch * (1 - 2 * inset)
  for (const [row, column, level] of MARK_CELLS) {
    const rect = node('rect', {
      x: (x + column * pitch + pitch * inset).toFixed(1),
      y: (y + row * pitch + pitch * inset).toFixed(1),
      width: size.toFixed(1),
      height: size.toFixed(1),
      rx: (size * round).toFixed(1),
      opacity: level,
    })
    const name = animated ? cellClass(row, column) : null
    if (name !== null) rect.setAttribute('class', name)
    group.appendChild(rect)
  }
  return group
}

/** Every lane's slivers, in each lane's colour on one of the two plates. */
function lanes(variant: 'dark' | 'light'): SVGElement {
  const group = node('g', {})
  for (const lane of MARK_LANES) {
    const one = node('g', { fill: lane[variant] })
    for (const [x, y, width, height, level] of lane.rects) {
      one.appendChild(node('rect', { x, y, width, height, rx: MARK_LANE_RADIUS, opacity: level }))
    }
    group.appendChild(one)
  }
  return group
}

function gradient(id: string, stops: readonly [string, number][]): SVGElement {
  const out = node('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 })
  stops.forEach(([colour, opacity], k) => {
    out.appendChild(
      node('stop', { offset: k / (stops.length - 1), 'stop-color': colour, 'stop-opacity': opacity }),
    )
  })
  return out
}

/**
 * The mark beside the name: the plate, the map whose X lights on hover, the
 * lanes and the rim — the shipped dark variant, as every icon of the app is.
 */
export function mastheadMark(): SVGSVGElement {
  const id = `cx-mark-${nextMark++}`
  const svg = frame('app-mark cx-mark')
  const defs = node('defs', {})
  defs.appendChild(
    gradient(`${id}-plate`, [
      [MARK_PLATE.top, 1],
      [MARK_PLATE.bottom, 1],
    ]),
  )
  defs.appendChild(
    gradient(`${id}-rim`, [
      [MARK_PLATE.rimTop, MARK_PLATE.rimTopOpacity],
      [MARK_PLATE.rimBottom, MARK_PLATE.rimBottomOpacity],
    ]),
  )
  svg.appendChild(defs)
  svg.appendChild(node('path', { d: MARK_PLATE.path, fill: `url(#${id}-plate)` }))
  svg.appendChild(cells(MARK_MAP.dark, true))
  svg.appendChild(lanes('dark'))
  svg.appendChild(
    node('path', {
      d: MARK_PLATE.rim,
      fill: 'none',
      stroke: `url(#${id}-rim)`,
      'stroke-width': MARK_PLATE.rimWidth,
    }),
  )
  return svg
}

/**
 * The half mark in the landing page's right margin: the map and its lanes, no
 * plate, drawn twice — once in each plate's colours — so the stylesheet shows
 * the one the theme asks for (`.cx-ink-light`, `.cx-ink-dark`). The box it
 * returns is half the mark's width and clips the rest, so what shows is the
 * left half, standing against the window's right edge.
 */
export function markWatermark(): HTMLElement {
  const svg = frame('cx-watermark-art')
  for (const variant of ['light', 'dark'] as const) {
    const ink = node('g', { class: `cx-ink-${variant}` })
    ink.appendChild(cells(MARK_MAP[variant], false))
    ink.appendChild(lanes(variant))
    svg.appendChild(ink)
  }
  const box = document.createElement('div')
  box.className = 'picker-watermark'
  box.setAttribute('aria-hidden', 'true')
  box.appendChild(svg)
  return box
}
