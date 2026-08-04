/**
 * Everything drawn *on* the matrix: the map-overlay card's files, and the
 * hand-drawn marks (spec §8.1).
 *
 * The rule the whole module follows is that an overlay must not hide the pixel
 * it is about. A loop marked by a filled disc is a loop nobody can see; a domain
 * marked by a filled triangle is a domain whose interior has been painted over.
 * So everything here is an outline, a rule, or a glyph placed *beside* what it
 * points at — and the one filled shape, the arrowhead, sits outside the cell it
 * names, on the far side from the diagonal.
 *
 * Positions come from the two {@link LocusAxis} objects the panel already built,
 * which are the same ones the lanes use, which are built from the same runs the
 * heatmap draws its separators from. There is no second coordinate system here
 * either (§8.4).
 */

import { featureRange } from '../annotations/featureset'
import type { ManualArrowhead, ManualLine } from '../annotations/manual'
import type { FeatureSet, OverlayShape, PairSet } from '../annotations/types'
import type { Rect } from './heatmap'
import type { LocusAxis } from './locus'
import type { Scale } from './scale'

/** The plot geometry an overlay is drawn against. */
export interface OverlayFrame {
  plot: Rect
  data: Rect
  rowScale: Scale
  colScale: Scale
  dpr: number
}

/** The two axes an overlay places itself on. */
export interface OverlayAxes {
  rows: LocusAxis | null
  cols: LocusAxis | null
}

/** Canvas x for a column-axis matrix coordinate. */
function toX(frame: OverlayFrame, unit: number): number {
  return frame.plot.x + frame.colScale.toPixel(unit)
}

/** Canvas y for a row-axis matrix coordinate. */
function toY(frame: OverlayFrame, unit: number): number {
  return frame.plot.y + frame.rowScale.toPixel(unit)
}

/** Put a hairline on the device-pixel grid, as the heatmap's own rules are. */
function snap(value: number, dpr: number): number {
  return (Math.round(value * dpr - 0.5) + 0.5) / dpr
}

/** `true` when a pixel is inside the drawn data. */
function insideX(frame: OverlayFrame, x: number): boolean {
  return x >= frame.data.x - 1 && x <= frame.data.x + frame.data.width + 1
}

function insideY(frame: OverlayFrame, y: number): boolean {
  return y >= frame.data.y - 1 && y <= frame.data.y + frame.data.height + 1
}

// ---------------------------------------------------------------------------
// Bed-like files, on the diagonal
// ---------------------------------------------------------------------------

export interface OverlayPaint {
  colour: string
  opacity: number
  shape: OverlayShape
}

/**
 * Bed features, marked where they meet the diagonal.
 *
 * Two shapes, because the two things people put in a BED beside a contact map
 * are not the same kind of object:
 *
 * - **border** — a point-like call (an insulation minimum, a boundary). Drawn as
 *   a short rule *across* the diagonal at the feature's midpoint, which is the
 *   only mark that reads at any zoom: a boundary 2 kb wide is sub-pixel on a
 *   whole-genome view and a box for it would vanish.
 * - **element** — an extent (a domain, a compartment). Drawn as the outline of
 *   the square it occupies on both axes, so the reader sees the block of
 *   contacts the call is claiming rather than a mark next to it.
 *
 * On a rectangular block — `contig_A × contig_B` — a feature that lands on both
 * axes still draws its box, which is the intersection of the two bands and is
 * exactly where the two features' contacts are. One that lands on only one axis
 * is skipped rather than smeared across the other, since there is no coordinate
 * there for it to have.
 */
export function drawDiagonalFeatures(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  axes: OverlayAxes,
  set: FeatureSet,
  paint: OverlayPaint,
): void {
  const { rows, cols } = axes
  if (rows === null || cols === null) return

  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.strokeStyle = paint.colour
  ctx.lineWidth = Math.max(1 / frame.dpr, paint.shape === 'border' ? 1.25 : 1)
  ctx.beginPath()

  // Candidates come from the *column* axis's visible windows and are then asked
  // for a row coordinate. Either axis would do on a symmetric view; the column
  // axis is the one whose windows are already what a track would have queried.
  for (const window of cols.windows(frame.colScale.domain)) {
    const contig = set.contigs.indexOf(window.contig)
    if (contig < 0) continue
    const [from, to] = featureRange(set, contig, window.start, window.end)
    for (let i = from; i < to; i++) {
      if (set.end[i] <= window.start || set.start[i] >= window.end) continue
      const colFrom = cols.locusToUnit(window.contig, set.start[i])
      const colTo = cols.locusToUnit(window.contig, set.end[i])
      const rowFrom = rows.locusToUnit(window.contig, set.start[i])
      const rowTo = rows.locusToUnit(window.contig, set.end[i])
      if (colFrom === null || colTo === null || rowFrom === null || rowTo === null) continue

      if (paint.shape === 'border') {
        // A cross on the diagonal at the feature's midpoint: it marks the place
        // without asserting a width the picture cannot show.
        const x = snap(toX(frame, (colFrom + colTo) / 2), frame.dpr)
        const y = snap(toY(frame, (rowFrom + rowTo) / 2), frame.dpr)
        if (!insideX(frame, x) || !insideY(frame, y)) continue
        const reach = 7
        ctx.moveTo(x - reach, y - reach)
        ctx.lineTo(x + reach, y + reach)
        continue
      }

      const x0 = toX(frame, colFrom)
      const x1 = toX(frame, colTo)
      const y0 = toY(frame, rowFrom)
      const y1 = toY(frame, rowTo)
      if (!insideX(frame, x1) || !insideY(frame, y1)) continue
      ctx.rect(
        snap(Math.min(x0, x1), frame.dpr),
        snap(Math.min(y0, y1), frame.dpr),
        Math.max(2, Math.abs(x1 - x0)),
        Math.max(2, Math.abs(y1 - y0)),
      )
    }
  }
  ctx.stroke()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Paired files, off the diagonal
// ---------------------------------------------------------------------------

/**
 * Loop calls, as circles around the pixel each one names.
 *
 * Unfilled, and that is not a style choice: the reader is looking at the pixel
 * to judge whether the call is real, and a disc over it answers the question by
 * hiding it.
 *
 * Drawn **once**, on the upper side of the diagonal.
 *
 * A call at `(a, b)` is a fact about a pair of loci, and the map draws that pair
 * twice — the matrix is symmetric, so the pixel at `(a, b)` and the one at
 * `(b, a)` hold the same number. Ringing both said the same thing twice, and on
 * a set of any size the second ring was pure ink: a few hundred calls became a
 * few hundred circles the reader has to check against the diagonal to know they
 * are not a second set. One ring per call, always in the same half, reads as
 * what it is.
 *
 * "Upper" is `row <= col`, which on a canvas — rows increasing downward — is the
 * half above and right of the diagonal, and is the half a cooler stores.
 *
 * The choice only applies when both placements are actually on screen, which is
 * the symmetric case: a view whose two axes are *different* blocks — chrI down
 * the side, chrII across the top — represents at most one of them, and there the
 * rule would drop the only circle there was. So the side is a preference between
 * two candidates, not a filter applied to each.
 */
export function drawPairs(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  axes: OverlayAxes,
  set: PairSet,
  paint: { colour: string; opacity: number; radius: number },
): void {
  const { rows, cols } = axes
  if (rows === null || cols === null) return
  const radius = Math.max(2.5, paint.radius)

  /** One placement of a pair, or `null` where it is off this view entirely. */
  const place = (
    rowContig: string,
    rowBp: number,
    colContig: string,
    colBp: number,
  ): { x: number; y: number; upper: boolean } | null => {
    const row = rows.locusToUnit(rowContig, rowBp)
    const col = cols.locusToUnit(colContig, colBp)
    if (row === null || col === null) return null
    const x = toX(frame, col)
    const y = toY(frame, row)
    if (!insideX(frame, x) || !insideY(frame, y)) return null
    return { x, y, upper: row <= col }
  }

  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.strokeStyle = paint.colour
  ctx.lineWidth = Math.max(1 / frame.dpr, 1.25)
  ctx.beginPath()

  for (let i = 0; i < set.length; i++) {
    const one = set.contigs[set.contig1[i]]
    const two = set.contigs[set.contig2[i]]
    const bpOne = (set.start1[i] + set.end1[i]) / 2
    const bpTwo = (set.start2[i] + set.end2[i]) / 2
    const a = place(one, bpOne, two, bpTwo)
    const b = place(two, bpTwo, one, bpOne)
    // Both on screen: take the upper one. One on screen: take it, wherever it
    // fell. A call on the diagonal has `a` and `b` at the same pixel, so either
    // answer is the same circle.
    const at = a !== null && b !== null ? (a.upper ? a : b) : (a ?? b)
    if (at === null) continue
    ctx.moveTo(at.x + radius, at.y)
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Hand-drawn marks
// ---------------------------------------------------------------------------

/** Vertical and horizontal rules at a coordinate the reader named. */
export function drawManualLines(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  axes: OverlayAxes,
  lines: readonly ManualLine[],
): void {
  if (lines.length === 0) return
  ctx.save()
  ctx.lineWidth = Math.max(1 / frame.dpr, 1)
  for (const line of lines) {
    ctx.strokeStyle = line.colour
    ctx.fillStyle = line.colour
    const wantsVertical = line.axis !== 'horizontal'
    const wantsHorizontal = line.axis !== 'vertical'

    if (wantsVertical && axes.cols !== null) {
      const unit = axes.cols.locusToUnit(line.at.contig, line.at.bp)
      if (unit !== null) {
        const x = snap(toX(frame, unit), frame.dpr)
        if (insideX(frame, x)) {
          ctx.beginPath()
          ctx.moveTo(x, frame.data.y)
          ctx.lineTo(x, frame.data.y + frame.data.height)
          ctx.stroke()
        }
      }
    }
    if (wantsHorizontal && axes.rows !== null) {
      const unit = axes.rows.locusToUnit(line.at.contig, line.at.bp)
      if (unit !== null) {
        const y = snap(toY(frame, unit), frame.dpr)
        if (insideY(frame, y)) {
          ctx.beginPath()
          ctx.moveTo(frame.data.x, y)
          ctx.lineTo(frame.data.x + frame.data.width, y)
          ctx.stroke()
        }
      }
    }
  }
  ctx.restore()
}

/** How far the arrowhead's tip sits off the cell it names, in CSS pixels. */
const ARROW_GAP = 4
/** Tip to base. */
const ARROW_LENGTH = 13
/** Half the base's width. */
const ARROW_HALF = 6.5

/**
 * Arrowheads, pointing down-left at the cell they name.
 *
 * Placed **outside** the cell relative to the main diagonal — up and to the
 * right for a mark in the upper triangle, down and to the left for its mirror —
 * so the pixel being called out is never under the glyph that calls it out. The
 * tip is what carries the meaning, and it is what sits closest to the cell.
 *
 * The mirror is not cosmetic. A mark placed while reading the upper triangle
 * must not point *into* the map when the reader pans to the lower one, which is
 * what a fixed direction would do.
 */
export function drawArrowheads(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  axes: OverlayAxes,
  marks: readonly ManualArrowhead[],
  halo: string,
): void {
  const { rows, cols } = axes
  if (marks.length === 0 || rows === null || cols === null) return

  ctx.save()
  ctx.lineJoin = 'round'
  for (const mark of marks) {
    const row = rows.locusToUnit(mark.a.contig, mark.a.bp)
    const col = cols.locusToUnit(mark.b.contig, mark.b.bp)
    if (row === null || col === null) continue
    const x = toX(frame, col)
    const y = toY(frame, row)
    if (!insideX(frame, x) || !insideY(frame, y)) continue

    // Which side of the diagonal the cell is on. On the diagonal itself, and on
    // a rectangular block where there is no diagonal to be on a side of, the
    // upper-triangle placement is the default — up and to the right, pointing
    // down and to the left, which is where a reader of a symmetric map looks.
    const above = row <= col
    const side = above ? 1 : -1
    // Unit vector pointing away from the diagonal, at 45°.
    const dx = side * Math.SQRT1_2
    const dy = -side * Math.SQRT1_2
    const tipX = x + dx * ARROW_GAP
    const tipY = y + dy * ARROW_GAP
    const baseX = x + dx * (ARROW_GAP + ARROW_LENGTH)
    const baseY = y + dy * (ARROW_GAP + ARROW_LENGTH)
    // Perpendicular to the axis of the arrow.
    const px = -dy
    const py = dx

    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(baseX + px * ARROW_HALF, baseY + py * ARROW_HALF)
    ctx.lineTo(baseX - px * ARROW_HALF, baseY - py * ARROW_HALF)
    ctx.closePath()
    // Outlined in the page background before it is filled, so the glyph reads
    // against a saturated colormap as well as against an empty corner.
    ctx.strokeStyle = halo
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = mark.colour
    ctx.fill()
  }
  ctx.restore()
}

