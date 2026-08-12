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

import { contigIndexOf } from '../genome/naming'

import { featureRange } from '../annotations/featureset'
import type { ManualArrowhead, ManualLine } from '../annotations/manual'
import type { FeatureSet, OverlayShape, PairSet } from '../annotations/types'
import type { Rect } from './heatmap'
import type { LocusAxis } from './locus'
import { rowForSeparation, type RotateDirection } from './rotate'
import type { Scale } from './scale'

/** The plot geometry an overlay is drawn against. */
export interface OverlayFrame {
  plot: Rect
  data: Rect
  rowScale: Scale
  colScale: Scale
  dpr: number
}

/**
 * What a mark needs to place itself on a map that has been turned 45°.
 *
 * A turned map has one genomic axis and one that is not: x is position and y is
 * distance from the diagonal (`render/rotate.ts`). So the row axis is `null`,
 * and a mark cannot be placed by asking both axes where a locus is — the
 * question has no answer up the side. What it is placed by instead is the pair
 * of loci it was always *about*: a mark on a contact map names one position or
 * two, and the turn is a function of those two.
 *
 * Which means every mark changes shape, and each change is the useful one:
 *
 * - a **line** stays a line, at the same place on the genome, joining up with
 *   the same line drawn in the lane below it — the whole reason to turn a map is
 *   that its x axis becomes the tracks' axis;
 * - a **domain** becomes a triangle standing on the axis, its apex over its own
 *   midpoint at the height of its own span;
 * - a **loop** becomes a dot at the height of its own span, which is the single
 *   clearest thing a turned map does — a row of loops at one separation reads as
 *   a row, where on the square it is a smear parallel to the diagonal.
 */
export interface OverlayTurn {
  /** Separation, in bins, of the row furthest from the axis. */
  maxSeparation: number
  direction: RotateDirection
  /** Base pairs per bin, for turning a distance into a row. */
  binsize: number
}

/** The two axes an overlay places itself on. */
export interface OverlayAxes {
  rows: LocusAxis | null
  cols: LocusAxis | null
  /** Set while the map is turned; the row axis is `null` whenever it is. */
  turn?: OverlayTurn | null
}

/**
 * Where a pair of loci lands on a turned map, in matrix units.
 *
 * The rotation, in the axis's own coordinates rather than in bins: x is the
 * midpoint of the two positions and y is their separation, which is what the
 * rows of a turned block count. Both ends have to be on the same sequence —
 * between two of them there is no distance to plot, which is the same condition
 * `isTurnable` gates the whole picture on.
 *
 * `null` past the band. A contact further from the diagonal than the reader
 * asked to see is not off the edge of the picture, it is *outside the data*, and
 * a mark for it hovering at the top of the plot would claim a depth the map is
 * not showing.
 */
function turnedPlace(
  axes: OverlayAxes,
  turn: OverlayTurn,
  a: { contig: string; bp: number },
  b: { contig: string; bp: number },
): { col: number; row: number } | null {
  if (axes.cols === null || a.contig !== b.contig) return null
  const one = axes.cols.locusToUnit(a.contig, a.bp)
  const two = axes.cols.locusToUnit(b.contig, b.bp)
  if (one === null || two === null) return null
  const separation = Math.abs(a.bp - b.bp) / turn.binsize
  if (!(separation <= turn.maxSeparation)) return null
  return { col: (one + two) / 2, row: rowForSeparation(turn, separation) + 0.5 }
}

/** The row the diagonal itself is drawn on: everything turned stands on it. */
function axisRow(turn: OverlayTurn): number {
  return rowForSeparation(turn, 0) + 0.5
}

/**
 * Keep a turned mark inside the picture.
 *
 * The square's marks are each at one point and are guarded by
 * {@link insideX}/{@link insideY}, but a turned domain is an *extent* whose apex
 * is a consequence of its own width — a domain wider than the band on screen has
 * its apex above the plot, and unclipped it would be drawn over the ruler.
 */
function clipToData(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
  ctx.beginPath()
  ctx.rect(frame.data.x, frame.data.y, frame.data.width, frame.data.height)
  ctx.clip()
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
  const turn = axes.turn ?? null
  // A turned map has no row axis, and needs none: both ends of a feature are on
  // the axis that survived, and the height is what the two of them are apart.
  if (cols === null || (turn === null && rows === null)) return

  ctx.save()
  if (turn !== null) clipToData(ctx, frame)
  ctx.globalAlpha = paint.opacity
  ctx.strokeStyle = paint.colour
  ctx.lineWidth = Math.max(1 / frame.dpr, paint.shape === 'border' ? 1.25 : 1)
  ctx.beginPath()

  // Candidates come from the *column* axis's visible windows and are then asked
  // for a row coordinate. Either axis would do on a symmetric view; the column
  // axis is the one whose windows are already what a track would have queried.
  for (const window of cols.windows(frame.colScale.domain)) {
    // Alias-aware, for the reason `render/features.ts` gives: one set, one
    // spelling, and as many asking vocabularies as the deck has panels (§5.9).
    const contig = contigIndexOf(set.contigs, window.contig)
    if (contig < 0) continue
    const [from, to] = featureRange(set, contig, window.start, window.end)
    for (let i = from; i < to; i++) {
      if (set.end[i] <= window.start || set.start[i] >= window.end) continue
      const colFrom = cols.locusToUnit(window.contig, set.start[i])
      const colTo = cols.locusToUnit(window.contig, set.end[i])
      if (colFrom === null || colTo === null) continue

      if (turn !== null) {
        const base = toY(frame, axisRow(turn))
        // Away from the diagonal, which is up the screen on an ordinary turned
        // map and down the screen on the mirrored half of a comparison.
        const away = turn.direction === 'up' ? -1 : 1
        const mid = toX(frame, (colFrom + colTo) / 2)
        if (!insideX(frame, mid)) continue
        if (paint.shape === 'border') {
          // A tick standing on the axis rather than a cross over it: the whole
          // of a turned map's signal is in the first few rows above the
          // diagonal, and a cross centred there covers what it is pointing at.
          // Snapped, because it is a hairline; the triangle below is not.
          const x = snap(mid, frame.dpr)
          ctx.moveTo(x, base)
          ctx.lineTo(x, base + away * 9)
          continue
        }
        // The square `[start, end]²` a domain occupies, turned: its two corners
        // on the diagonal stay on the axis, and the two off it meet over the
        // midpoint at the height of the domain's own width. A triangle standing
        // on the axis, which is the shape a reader of a turned map is looking
        // for and the reason the picture is worth turning.
        const apart = Math.abs(set.end[i] - set.start[i]) / turn.binsize
        ctx.moveTo(toX(frame, colFrom), base)
        ctx.lineTo(mid, toY(frame, rowForSeparation(turn, apart) + 0.5))
        ctx.lineTo(toX(frame, colTo), base)
        ctx.closePath()
        continue
      }

      const rowFrom = rows?.locusToUnit(window.contig, set.start[i]) ?? null
      const rowTo = rows?.locusToUnit(window.contig, set.end[i]) ?? null
      if (rowFrom === null || rowTo === null) continue

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
  const turn = axes.turn ?? null
  if (cols === null || (turn === null && rows === null)) return
  const radius = Math.max(2.5, paint.radius)

  /** One placement of a pair, or `null` where it is off this view entirely. */
  const place = (
    rowContig: string,
    rowBp: number,
    colContig: string,
    colBp: number,
  ): { x: number; y: number; upper: boolean } | null => {
    // Turned, a call is one dot rather than two: the pair and its mirror rotate
    // to the same point, so the "which half" question below never arises.
    if (turn !== null) {
      const at = turnedPlace(axes, turn, { contig: rowContig, bp: rowBp }, { contig: colContig, bp: colBp })
      if (at === null) return null
      const x = toX(frame, at.col)
      const y = toY(frame, at.row)
      if (!insideX(frame, x) || !insideY(frame, y)) return null
      return { x, y, upper: true }
    }
    const row = rows?.locusToUnit(rowContig, rowBp) ?? null
    const col = cols.locusToUnit(colContig, colBp)
    if (row === null || col === null) return null
    const x = toX(frame, col)
    const y = toY(frame, row)
    if (!insideX(frame, x) || !insideY(frame, y)) return null
    return { x, y, upper: row <= col }
  }

  ctx.save()
  if (turn !== null) clipToData(ctx, frame)
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
  const turn = axes.turn ?? null
  ctx.save()
  ctx.lineWidth = Math.max(1 / frame.dpr, 1)
  for (const line of lines) {
    ctx.strokeStyle = line.colour
    ctx.fillStyle = line.colour
    // A mark names one locus and stores which axis it was drawn against. On a
    // turned map only one of those axes is still a place, so every line is drawn
    // against it — including the ones that were horizontal, which would
    // otherwise be marks the reader put down and can no longer find. This is
    // also what keeps a line joined to the same line in the lane below it.
    const wantsVertical = turn !== null || line.axis !== 'horizontal'
    const wantsHorizontal = turn === null && line.axis !== 'vertical'

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
  const turn = axes.turn ?? null
  if (marks.length === 0 || cols === null || (turn === null && rows === null)) return

  ctx.save()
  if (turn !== null) clipToData(ctx, frame)
  ctx.lineJoin = 'round'
  for (const mark of marks) {
    const at =
      turn !== null
        ? turnedPlace(axes, turn, mark.a, mark.b)
        : ((): { row: number; col: number } | null => {
            const row = rows?.locusToUnit(mark.a.contig, mark.a.bp) ?? null
            const col = cols.locusToUnit(mark.b.contig, mark.b.bp)
            return row === null || col === null ? null : { row, col }
          })()
    if (at === null) continue
    const x = toX(frame, at.col)
    const y = toY(frame, at.row)
    if (!insideX(frame, x) || !insideY(frame, y)) continue

    // Which side of the diagonal the cell is on. On the diagonal itself, and on
    // a rectangular block where there is no diagonal to be on a side of, the
    // upper-triangle placement is the default — up and to the right, pointing
    // down and to the left, which is where a reader of a symmetric map looks.
    //
    // Turned, "away from the diagonal" is straight up rather than at 45°: the
    // diagonal is now the bottom edge of the picture, so the glyph stands over
    // the dot it names with its tip pointing down at it. Straight down instead
    // on the mirrored half of a comparison, where separation grows downward.
    const above = turn !== null || at.row <= at.col
    const side = above ? 1 : -1
    // Unit vector pointing away from the diagonal, at 45°.
    const dx = turn === null ? side * Math.SQRT1_2 : 0
    const dy =
      turn === null ? -side * Math.SQRT1_2 : turn.direction === 'up' ? -1 : 1
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

