/**
 * The stage's furniture, drawn (SPECS §27.3): the two pieces bars along the
 * map's top and left edges, and what is laid over the map — the sequences'
 * edges, every junction an edit made, the selection, the crosshair.
 *
 * Canvas calls only, against a context and the numbers to place things by; the
 * stage decides what to draw and this decides how it looks.
 */

import type { LensGrid } from './grid'

/** The colours and the type the furniture is drawn in, read off the page. */
export interface StageInk {
  text: string
  dim: string
  faint: string
  accent: string
  accentSoft: string
  background: string
  font: string
}

/** Read the stage's colours from the element it is drawn in, so both themes are right. */
export function readInk(from: Element): StageInk {
  const style = getComputedStyle(from)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    text: pick('--text', '#17181a'),
    dim: pick('--text-dim', '#54565a'),
    faint: pick('--text-faint', '#68696d'),
    accent: pick('--accent', '#1f5fa9'),
    accentSoft: pick('--accent-soft', '#dce8f7'),
    background: pick('--bg', '#ffffff'),
    font: `10px ${style.fontFamily || 'system-ui, sans-serif'}`,
  }
}

/**
 * The colour of an original sequence on the pieces bars: a hue per sequence,
 * a golden angle from the one before, so neighbours in the file never share
 * one and a moved piece still says where it came from.
 */
export function originalHue(index: number): string {
  if (index < 0) return 'transparent'
  return `hsl(${Math.round((index * 137.508) % 360)} 52% 54%)`
}

/** Thickness of a pieces bar, in CSS pixels: a row of names over a row of pieces. */
export const BAR_THICKNESS = 32
const NAMES = 13
const PIECES_FROM = 15
/** How far across a bar, from its outer edge, the row of names reaches: a press there is on the sequence, whole. */
export const BAR_NAMES = PIECES_FROM

/** Which edge a bar runs along. */
export type BarEdge = 'top' | 'left'

/**
 * One pieces bar: every piece a block in its original sequence's hue with
 * chevrons pointing the way it reads, a gap between sequences, and each edited
 * sequence's name over its span where it fits.
 *
 * @param toPixel A unit of the edited axis to a pixel along the bar.
 * @param lit A stretch of the axis to light — the selection — in units.
 * @param mark A unit to mark with a caret — where a dragged stretch would go.
 * @param ticks The points suggestions name, each a tick across the pieces —
 *   the axes' share of a breakpoint's diamond (§27.3) — the lit ones stronger.
 * @param linked A stretch lit from the corner dot plot, in units — the piece
 *   a hovered line lies along (§27.3): the rest of the bar veiled, its span
 *   bracketed and its sequence's name in the accent.
 */
export function drawBar(
  ctx: CanvasRenderingContext2D,
  edge: BarEdge,
  length: number,
  grid: LensGrid,
  toPixel: (unit: number) => number,
  ink: StageInk,
  lit: readonly [number, number] | null,
  mark: number | null,
  ticks: ReadonlyArray<{ unit: number; lit: boolean }> = [],
  linked: readonly [number, number] | null = null,
): void {
  const across = BAR_THICKNESS
  // Along and across, to x and y: the top bar reads left to right, the left
  // bar top to bottom, and nothing below needs to know which it is.
  const rect = (a0: number, a1: number, c0: number, c1: number): void => {
    if (edge === 'top') ctx.fillRect(a0, c0, a1 - a0, c1 - c0)
    else ctx.fillRect(c0, a0, c1 - c0, a1 - a0)
  }
  ctx.clearRect(0, 0, edge === 'top' ? length : across, edge === 'top' ? across : length)

  // The pieces.
  for (const part of grid.parts) {
    if (part.piece === null || part.to <= part.from) continue
    const a0 = Math.max(0, toPixel(part.from))
    const a1 = Math.min(length, toPixel(part.to))
    if (a1 <= 0 || a0 >= length || a1 - a0 < 0.5) continue
    ctx.fillStyle = originalHue(part.original)
    // A hairline of the background between two pieces, so a junction is seen
    // on the bar as well as on the map.
    rect(a0 + (a1 - a0 > 3 ? 0.5 : 0), a1 - (a1 - a0 > 3 ? 0.5 : 0), PIECES_FROM, across - 2)
    const width = a1 - a0
    if (width < 9) continue
    // Chevrons, one every forty pixels or so, pointing the way it reads.
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    const count = Math.max(1, Math.floor(width / 40))
    const mid = (PIECES_FROM + across - 2) / 2
    const half = 3.5
    for (let k = 0; k < count; k++) {
      const at = a0 + ((k + 0.5) * width) / count
      const forward = part.piece.strand === 1
      const tip = forward ? at + half : at - half
      const back = forward ? at - half : at + half
      ctx.beginPath()
      if (edge === 'top') {
        ctx.moveTo(back, mid - half)
        ctx.lineTo(tip, mid)
        ctx.lineTo(back, mid + half)
      } else {
        ctx.moveTo(mid - half, back)
        ctx.lineTo(mid, tip)
        ctx.lineTo(mid + half, back)
      }
      ctx.closePath()
      ctx.fill()
    }
  }

  // A stretch lit from the dot plot: everything else veiled, so that it stands
  // out in its own colours rather than washed in another.
  const linkedPx = linked === null ? null : ([Math.max(0, toPixel(linked[0])), Math.min(length, toPixel(linked[1]))] as const)
  if (linkedPx !== null) {
    ctx.fillStyle = ink.background
    ctx.globalAlpha = 0.65
    if (linkedPx[0] > 0) rect(0, Math.min(length, linkedPx[0]), PIECES_FROM, across - 2)
    if (linkedPx[1] < length) rect(Math.max(0, linkedPx[1]), length, PIECES_FROM, across - 2)
    ctx.globalAlpha = 1
  }

  // The sequences: a tick at each edge and the name where it fits.
  ctx.font = ink.font
  ctx.textBaseline = 'middle'
  for (const sequence of grid.sequences) {
    const a0 = toPixel(sequence.from)
    const a1 = toPixel(sequence.to)
    if (a1 <= 0 || a0 >= length) continue
    ctx.fillStyle = ink.dim
    rect(Math.max(0, a0), Math.max(0, a0) + 1, 1, NAMES)
    const room = Math.min(a1, length) - Math.max(a0, 0) - 6
    if (room < 14) continue
    let name = sequence.name
    while (name.length > 1 && ctx.measureText(name).width > room) name = name.slice(0, -1)
    if (name !== sequence.name) name = `${name.slice(0, -1)}…`
    if (ctx.measureText(name).width > room) continue
    const centre = (Math.max(a0, 0) + Math.min(a1, length)) / 2
    ctx.fillStyle = linked !== null && linked[0] < sequence.to && linked[1] > sequence.from ? ink.accent : ink.text
    if (edge === 'top') {
      ctx.textAlign = 'center'
      ctx.fillText(name, centre, NAMES / 2 + 1)
    } else {
      ctx.save()
      ctx.translate(NAMES / 2 + 1, centre)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.fillText(name, 0, 0)
      ctx.restore()
    }
  }

  // The selection, lit.
  if (lit !== null) {
    const a0 = Math.max(0, toPixel(lit[0]))
    const a1 = Math.min(length, toPixel(lit[1]))
    if (a1 > a0) {
      ctx.fillStyle = ink.accentSoft
      ctx.globalAlpha = 0.55
      rect(a0, a1, PIECES_FROM - 2, across)
      ctx.globalAlpha = 1
      ctx.fillStyle = ink.accent
      rect(a0, a1, across - 3, across)
      rect(a0, Math.min(a1, a0 + 2), PIECES_FROM - 2, across)
      rect(Math.max(a0, a1 - 2), a1, PIECES_FROM - 2, across)
    }
  }

  // The stretch lit from the dot plot, bracketed: a rule along its inner edge, and its two ends.
  if (linkedPx !== null && linkedPx[1] > linkedPx[0] - 1) {
    const a0 = linkedPx[0]
    const a1 = Math.max(a0 + 2, linkedPx[1])
    ctx.fillStyle = ink.accent
    rect(a0, a1, across - 2, across)
    rect(a0, Math.min(a1, a0 + 1.5), PIECES_FROM - 1, across)
    rect(Math.max(a0, a1 - 1.5), a1, PIECES_FROM - 1, across)
  }

  // The points suggestions name.
  for (const tick of ticks) {
    const at = toPixel(tick.unit)
    if (at < -2 || at > length + 2) continue
    const half = tick.lit ? 1.75 : 1
    ctx.fillStyle = ink.background
    ctx.globalAlpha = 0.8
    rect(at - half - 1, at + half + 1, PIECES_FROM - 3, across)
    ctx.globalAlpha = tick.lit ? 1 : 0.85
    ctx.fillStyle = ink.accent
    rect(at - half, at + half, PIECES_FROM - 3, across)
    ctx.globalAlpha = 1
  }

  // Where a dragged stretch would go.
  if (mark !== null) {
    const at = toPixel(mark)
    if (at >= -2 && at <= length + 2) {
      ctx.fillStyle = ink.accent
      rect(at - 1.5, at + 1.5, 0, across)
      ctx.beginPath()
      if (edge === 'top') {
        ctx.moveTo(at - 5, 0)
        ctx.lineTo(at + 5, 0)
        ctx.lineTo(at, 6)
      } else {
        ctx.moveTo(0, at - 5)
        ctx.lineTo(0, at + 5)
        ctx.lineTo(6, at)
      }
      ctx.closePath()
      ctx.fill()
    }
  }
}

/** What the overlay is asked to draw on one frame. */
export interface OverlayFrame {
  size: number
  grid: LensGrid
  toX: (unit: number) => number
  toY: (unit: number) => number
  ink: StageInk
  /** A stretch selected on the diagonal, in units. */
  square: readonly [number, number] | null
  /** A box off it: rows and columns, in units. */
  box: { rows: readonly [number, number]; cols: readonly [number, number] } | null
  /** A stretch lit from the corner dot plot (§27.3), on the diagonal, in units. */
  linked?: readonly [number, number] | null
  /** The pointer, snapped: a column and a row, in units, and whether each snapped. */
  cross: { x: number; y: number; snappedX: boolean; snappedY: boolean } | null
  /** What else is drawn over the picture and under the selection: the suggestions (`marks.ts`). */
  under?: (ctx: CanvasRenderingContext2D) => void
}

/** The fewest pixels between two rules the overlay draws. */
const RULE_GAP_PX = 8

/**
 * The overlay over the picture: the edges of sequences, the junctions of the
 * edit, the selection and the crosshair.
 *
 * A sequence's edge is ink; a junction inside a sequence is a fainter rule, an
 * edit already made (§27.3). The selection and the pointer are the accent, what
 * the reader can act on (§26.5).
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
  const { size, grid, toX, toY, ink } = frame
  ctx.clearRect(0, 0, size, size)
  // Rules closer than a few pixels to the last one drawn are left out: a
  // metagenome's genome of two thousand contigs, whole on the screen, would
  // otherwise be a square of rules with no map under it. Zoomed in, every one
  // is drawn.
  let lastX = Number.NEGATIVE_INFINITY
  let lastY = Number.NEGATIVE_INFINITY
  const rule = (unit: number): void => {
    const x = Math.round(toX(unit)) + 0.5
    const y = Math.round(toY(unit)) + 0.5
    if (x > 0 && x < size && x - lastX >= RULE_GAP_PX) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, size)
      lastX = x
    }
    if (y > 0 && y < size && y - lastY >= RULE_GAP_PX) {
      ctx.moveTo(0, y)
      ctx.lineTo(size, y)
      lastY = y
    }
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = ink.faint
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  for (const unit of grid.junctions()) rule(unit)
  ctx.stroke()
  ctx.globalAlpha = 0.7
  ctx.strokeStyle = ink.dim
  ctx.beginPath()
  lastX = Number.NEGATIVE_INFINITY
  lastY = Number.NEGATIVE_INFINITY
  for (const unit of grid.boundaries()) if (unit > 0 && unit < grid.n) rule(unit)
  ctx.stroke()
  ctx.globalAlpha = 1

  frame.under?.(ctx)

  // An outline and no fill: a wash over the picture changes the colours of
  // the contacts being judged, and over the darkest of them it reads as a
  // different colour altogether. The bars and the lanes carry the fill.
  const outline = (x0: number, y0: number, x1: number, y1: number): void => {
    ctx.strokeStyle = ink.background
    ctx.lineWidth = 4
    ctx.globalAlpha = 0.6
    ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, x1 - x0 - 2), Math.max(0, y1 - y0 - 2))
    ctx.globalAlpha = 1
    ctx.strokeStyle = ink.accent
    ctx.lineWidth = 2
    ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, x1 - x0 - 2), Math.max(0, y1 - y0 - 2))
    ctx.lineWidth = 1
  }
  // The stretch the dot plot's hovered line lies along: dashed, so that it is
  // not taken for the selection, which is drawn whole over it.
  if (frame.linked !== undefined && frame.linked !== null) {
    const [a, b] = frame.linked
    const [x0, y0, x1, y1] = [toX(a), toY(a), toX(b), toY(b)]
    ctx.strokeStyle = ink.background
    ctx.lineWidth = 4
    ctx.globalAlpha = 0.6
    ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, x1 - x0 - 2), Math.max(0, y1 - y0 - 2))
    ctx.globalAlpha = 1
    ctx.strokeStyle = ink.accent
    ctx.lineWidth = 2
    ctx.setLineDash([5, 3])
    ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, x1 - x0 - 2), Math.max(0, y1 - y0 - 2))
    ctx.setLineDash([])
    ctx.lineWidth = 1
  }
  if (frame.square !== null) {
    const [a, b] = frame.square
    outline(toX(a), toY(a), toX(b), toY(b))
  }
  if (frame.box !== null) {
    const { rows, cols } = frame.box
    outline(toX(cols[0]), toY(rows[0]), toX(cols[1]), toY(rows[1]))
  }

  const cross = frame.cross
  if (cross !== null) {
    const x = Math.round(toX(cross.x)) + 0.5
    const y = Math.round(toY(cross.y)) + 0.5
    ctx.strokeStyle = ink.accent
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size)
    ctx.moveTo(0, y)
    ctx.lineTo(size, y)
    ctx.stroke()
    ctx.globalAlpha = 1
    // A snapped axis says so where it meets the edge: a notch at the bar.
    ctx.fillStyle = ink.accent
    if (cross.snappedX) ctx.fillRect(x - 2.5, 0, 5, 6)
    if (cross.snappedY) ctx.fillRect(0, y - 2.5, 6, 5)
  }
}
