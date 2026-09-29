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
import type { ManualArrowhead, ManualLine, ManualRect, ManualSpan } from '../annotations/manual'
import type { FeatureSet, OverlayShape, PairSet } from '../annotations/types'
import type { Rect } from './heatmap'
import type { LocusAxis } from './locus'
import { placeRays, rowForSeparation, type RotateDirection } from './rotate'
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
 * - a **line** becomes the V its place makes — the two 45° rays of contacts it
 *   anchors, standing on the axis where the same line carries on, vertical,
 *   down the lanes below: the whole reason to turn a map is that its x axis
 *   becomes the tracks' axis, and a column of the turned picture is not a place
 *   ({@link placeRays});
 * - a **domain** becomes a triangle standing on the axis, its apex over its own
 *   midpoint at the height of its own span;
 * - a **loop** becomes a dot at the height of its own span, which is the single
 *   clearest thing a turned map does — a row of loops at one separation reads as
 *   a row, where on the square it is a smear parallel to the diagonal;
 * - a **box** becomes a parallelogram leaning at 45°, or — when it sits on the
 *   diagonal — the same triangle a domain does, which is the shape it should
 *   have: an on-diagonal box *is* a domain, drawn by hand
 *   ({@link turnedLobes}).
 */
export interface OverlayTurn {
  /** Separation, in bins, of the row furthest from the axis. */
  maxSeparation: number
  direction: RotateDirection
  /** Base pairs per bin, for turning a distance into a row. */
  binsize: number
  /** Rows of the turned block — where a line's V ends ({@link placeRays}). */
  nrows: number
  /** The first row of a mirrored pair's second band, where there is one. */
  fold?: number
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
 * A turned domain is an *extent* whose apex is a consequence of its own width —
 * a domain wider than the band on screen has its apex above the plot, and
 * unclipped it would be drawn over the ruler. The square map needs no clip of
 * its own here, because its caller already has one
 * (`HeatmapView.drawOverlay`); what both presentations need, and what the
 * point tests {@link insideX}/{@link insideY} cannot give an extent, is the
 * overlap test each shape's own branch makes before it draws.
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
      // Against the window's **own** stretch, not the first on the axis with
      // this name: a circular sequence panned across its junction carries the
      // same contig at both ends of the picture, and resolving by name would
      // draw everything on the far side of the join a sequence out (§8.15).
      const segment = window.segment
      if (!(segment.bpPerUnit > 0)) continue
      const at = (bp: number): number =>
        segment.unitStart + (bp - segment.bpStart) / segment.bpPerUnit
      const colFrom = at(set.start[i])
      const colTo = at(set.end[i])

      if (turn !== null) {
        const base = toY(frame, axisRow(turn))
        // Away from the diagonal, which is up the screen on an ordinary turned
        // map and down the screen on the mirrored half of a comparison.
        const away = turn.direction === 'up' ? -1 : 1
        const mid = toX(frame, (colFrom + colTo) / 2)
        if (paint.shape === 'border') {
          // A tick standing on the axis rather than a cross over it: the whole
          // of a turned map's signal is in the first few rows above the
          // diagonal, and a cross centred there covers what it is pointing at.
          // Snapped, because it is a hairline; the triangle below is not.
          // The midpoint *is* the mark here, so a midpoint off screen is a mark
          // off screen — which is why this guard belongs inside this branch and
          // not above it.
          if (!insideX(frame, mid)) continue
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
        const footFrom = toX(frame, colFrom)
        const footTo = toX(frame, colTo)
        // On the feet, because the triangle is an extent and its midpoint is a
        // consequence of its own width rather than the thing being pointed at.
        // Culling on the midpoint — the border tick's test, applied to both
        // shapes — dropped a domain panned so that only one of its feet is on
        // screen, the same corner-versus-overlap mistake the square path made.
        // The apex needs no test: this path draws under `clipToData`.
        if (Math.max(footFrom, footTo) < frame.data.x) continue
        if (Math.min(footFrom, footTo) > frame.data.x + frame.data.width) continue
        ctx.moveTo(footFrom, base)
        ctx.lineTo(mid, toY(frame, rowForSeparation(turn, apart) + 0.5))
        ctx.lineTo(footTo, base)
        ctx.closePath()
        continue
      }

      // The row axis's copy of the *same* stretch, so a box on a circular
      // sequence panned across its junction stands on the diagonal rather than a
      // sequence away from it (§8.15). On every other view this is the one
      // stretch there is, and `at` and `rowAt` are the same mapping.
      const rowSegment = rows?.like(segment) ?? null
      if (rowSegment === null || !(rowSegment.bpPerUnit > 0)) continue
      const rowAt = (bp: number): number =>
        rowSegment.unitStart + (bp - rowSegment.bpStart) / rowSegment.bpPerUnit
      const rowFrom = rowAt(set.start[i])
      const rowTo = rowAt(set.end[i])

      if (paint.shape === 'border') {
        // A short rule *across* the diagonal at the feature's midpoint: it
        // marks the place without asserting a width the picture cannot show.
        //
        // Across, and the sign on one axis is the whole of it. Rows increase
        // downward and columns rightward, so on a symmetric block `row == col`
        // is pixel slope +1 — and a rule drawn from `(x - reach, y - reach)` to
        // `(x + reach, y + reach)` lay *along* the diagonal, painting over the
        // brightest row in the picture, which is the one thing the module
        // header forbids. A run of adjacent boundary calls then merged into a
        // stripe down the diagonal instead of reading as a row of ticks
        // crossing it. One stroke, not two: an X would put an arm back along
        // the diagonal and re-break the rule.
        const x = snap(toX(frame, (colFrom + colTo) / 2), frame.dpr)
        const y = snap(toY(frame, (rowFrom + rowTo) / 2), frame.dpr)
        if (!insideX(frame, x) || !insideY(frame, y)) continue
        const reach = 7
        ctx.moveTo(x - reach, y + reach)
        ctx.lineTo(x + reach, y - reach)
        continue
      }

      const x0 = toX(frame, colFrom)
      const x1 = toX(frame, colTo)
      const y0 = toY(frame, rowFrom)
      const y1 = toY(frame, rowTo)
      const left = Math.min(x0, x1)
      const right = Math.max(x0, x1)
      const top = Math.min(y0, y1)
      const bottom = Math.max(y0, y1)
      // Overlap, not corner-in-view, and the same test {@link drawManualRects}
      // makes for the same reason: an element is an *extent*, and an extent is
      // very often bigger than the window it is read in — zoom into a domain and
      // its box surrounds the view. Guarding it by `insideX(x1)`/`insideY(y1)`
      // asked whether its bottom-right corner was on screen, so the outline
      // disappeared at exactly the zoom the reader reached for to inspect the
      // block it is claiming, and asymmetrically at that: `locusToUnit` grows
      // with bp, so a pan that kept only the domain's start drew nothing while
      // the mirror pan kept drawing. Nothing is at risk unclipped — the caller
      // (`HeatmapView.drawOverlay`) clips the painter to the data rect.
      if (right < frame.data.x || left > frame.data.x + frame.data.width) continue
      if (bottom < frame.data.y || top > frame.data.y + frame.data.height) continue
      ctx.rect(
        snap(left, frame.dpr),
        snap(top, frame.dpr),
        Math.max(2, right - left),
        Math.max(2, bottom - top),
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
    // Every place each end lands, which on a circular axis panned across its
    // junction is two — and the pair is drawn at the combination that is
    // actually on screen. First-occurrence-only made a loop near the join
    // disappear rather than be misplaced, which is the quieter failure and the
    // harder one to notice (§8.15).
    for (const row of rows?.locusToUnits(rowContig, rowBp) ?? []) {
      for (const col of cols.locusToUnits(colContig, colBp)) {
        const x = toX(frame, col)
        const y = toY(frame, row)
        if (!insideX(frame, x) || !insideY(frame, y)) continue
        return { x, y, upper: row <= col }
      }
    }
    return null
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
  // A V is an extent, and its arms run past the band's far edge by design.
  if (turn !== null) clipToData(ctx, frame)
  for (const line of lines) {
    ctx.strokeStyle = line.colour
    ctx.fillStyle = line.colour

    // Every landing, not the first: a hand-drawn rule on a circular sequence is
    // on screen twice while the junction is (§8.15), and drawing one of them
    // makes the mark flicker in and out as the reader slides past the join.
    if (turn !== null) {
      // **Turned, a line is the V its place makes.** A mark names one locus and
      // stores which axis it was drawn against; on a turned map only one of
      // those axes is still a place, and what a place is there is not a column
      // but the two 45° rays of contacts it anchors — the V a pointer on a track
      // draws, standing on the axis where the same line carries on down the
      // lanes. Drawn straight up, it crossed contacts between two *other*
      // places the whole height of the band. A horizontal mark names a place
      // too, and is the same V: the axis it was drawn against is gone, the
      // locus is not.
      if (axes.cols === null) continue
      const units = axes.cols.locusToUnits(line.at.contig, line.at.bp)
      // A place off the side of the block still has arms reaching into it, so
      // it is placed by extending its sequence's stretch past the block's edge —
      // a turned map is one sequence, laid out once unless it is a circle panned
      // across its join (whose landings the list above already has).
      if (units.length === 0) {
        const beyond = axes.cols.locusToUnit(line.at.contig, line.at.bp)
        if (beyond !== null) units.push(beyond)
      }
      for (const unit of units) {
        ctx.beginPath()
        for (const ray of placeRays(turn, unit)) {
          const x0 = toX(frame, ray.from.col)
          const x1 = toX(frame, ray.to.col)
          // Culled on the arm rather than on the apex: a place just off the
          // side of the picture still has an arm reaching into it.
          if (Math.max(x0, x1) < frame.data.x || Math.min(x0, x1) > frame.data.x + frame.data.width) {
            continue
          }
          ctx.moveTo(x0, toY(frame, ray.from.row))
          ctx.lineTo(x1, toY(frame, ray.to.row))
        }
        ctx.stroke()
      }
      continue
    }

    if (line.axis !== 'horizontal' && axes.cols !== null) {
      for (const unit of axes.cols.locusToUnits(line.at.contig, line.at.bp)) {
        const x = snap(toX(frame, unit), frame.dpr)
        if (!insideX(frame, x)) continue
        ctx.beginPath()
        ctx.moveTo(x, frame.data.y)
        ctx.lineTo(x, frame.data.y + frame.data.height)
        ctx.stroke()
      }
    }
    if (line.axis !== 'vertical' && axes.rows !== null) {
      for (const unit of axes.rows.locusToUnits(line.at.contig, line.at.bp)) {
        const y = snap(toY(frame, unit), frame.dpr)
        if (!insideY(frame, y)) continue
        ctx.beginPath()
        ctx.moveTo(frame.data.x, y)
        ctx.lineTo(frame.data.x + frame.data.width, y)
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Hand-drawn boxes
// ---------------------------------------------------------------------------

/** A corner of a box, as one base-pair coordinate per axis. */
interface Corner {
  row: number
  col: number
}

/** A drawn point, in canvas pixels. */
interface Point {
  x: number
  y: number
}

/**
 * The part of a box on the upper side of the diagonal, in base pairs.
 *
 * Sutherland–Hodgman against `col >= row`, which is all the clipping a convex
 * quadrilateral against one half-plane needs: walk the edges, keep the corners
 * that are in, and add the crossing wherever an edge changes its mind. Comes
 * back with three to five corners, or fewer than three where the box is wholly
 * on the other side and there is nothing up here to draw.
 */
function upperHalf(corners: readonly Corner[]): Corner[] {
  const out: Corner[] = []
  const side = (corner: Corner): number => corner.col - corner.row
  for (let i = 0; i < corners.length; i++) {
    const from = corners[i]
    const to = corners[(i + 1) % corners.length]
    const here = side(from)
    const there = side(to)
    if (here >= 0) out.push(from)
    if ((here > 0 && there < 0) || (here < 0 && there > 0)) {
      const t = here / (here - there)
      out.push({
        row: from.row + (to.row - from.row) * t,
        col: from.col + (to.col - from.col) * t,
      })
    }
  }
  return out
}

/** Twice the signed area, whose sign is which way a polygon winds. */
function windingOf(polygon: readonly Point[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum
}

/** `true` when every corner of `inner` is inside the convex `outer`. */
function convexContains(outer: readonly Point[], inner: readonly Point[]): boolean {
  const winding = windingOf(outer)
  if (outer.length < 3 || winding === 0) return false
  const way = Math.sign(winding)
  for (const point of inner) {
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i]
      const b = outer[(i + 1) % outer.length]
      const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
      // Half a pixel of slack: a lobe poking out by less than that is not a
      // shape, it is the rounding on the corner it was clipped at.
      if (cross * way < -0.5) return false
    }
  }
  return true
}

/**
 * The one or two shapes a box turns into, in canvas pixels.
 *
 * A turned map draws the upper triangle and nothing else, so what a box shows
 * there is not the box: it is *the contacts the box names*, which the picture
 * holds in one place each. The box and its mirror across the diagonal are the
 * same contacts, and the turn sends them to the same band — so the honest
 * drawing is the image of `box ∪ mirror(box)`, taken on the side that is drawn.
 *
 * Each half of that union is a rectangle clipped to `col >= row` and then sent
 * through the rotation, which is affine on that side — x is the midpoint of the
 * two coordinates and y is what they are apart — so corners go to corners and
 * edges stay straight. Hence **lobes**, plural, and each is a polygon:
 *
 * - a box **off** the diagonal has one lobe, a parallelogram leaning at 45°;
 * - a box **on** it has two that coincide, and they are the domain triangle —
 *   the two corners that sit on the diagonal land on the axis and the two that
 *   do not meet over the midpoint at the height of the box's own width;
 * - a box **across** it has two that overlap, and the containment test drops the
 *   one inside the other, because a second outline in there reads as a shape
 *   that is not on the map.
 *
 * The one case that keeps both is a box far taller than it is wide — a locus
 * against a whole arm — whose two halves genuinely rotate into two separate
 * stripes, one leaning each way. Drawing one of them would be drawing half the
 * contacts the reader boxed.
 *
 * Empty between two sequences, which have no separation and so no place in a
 * band that counts it — the condition {@link turnedPlace} is gated on too.
 */
function turnedLobes(
  frame: OverlayFrame,
  cols: LocusAxis,
  turn: OverlayTurn,
  rect: ManualRect,
): Point[][] {
  if (rect.a.contig !== rect.b.contig) return []
  const contig = rect.a.contig
  // One lookup answers for every corner: the axis is linear within a stretch, so
  // it is `null` for a contig that is off this view and for nothing else.
  if (cols.locusToUnit(contig, rect.a.from) === null) return []
  const unit = (bp: number): number => cols.locusToUnit(contig, bp) ?? 0
  const place = (corner: Corner): Point => ({
    x: toX(frame, (unit(corner.row) + unit(corner.col)) / 2),
    // Clipped, `col >= row`, so the separation needs no absolute value. Not
    // gated on the band's depth: a box deeper than the rows on screen is drawn
    // and clipped, exactly as a domain triangle wider than the band is.
    y: toY(frame, rowForSeparation(turn, (corner.col - corner.row) / turn.binsize) + 0.5),
  })

  const lobes: Point[][] = []
  for (const [rows, columns] of [
    [rect.a, rect.b],
    [rect.b, rect.a],
  ] as Array<[ManualSpan, ManualSpan]>) {
    const half = upperHalf([
      { row: rows.from, col: columns.from },
      { row: rows.to, col: columns.from },
      { row: rows.to, col: columns.to },
      { row: rows.from, col: columns.to },
    ])
    if (half.length >= 3) lobes.push(half.map(place))
  }
  if (lobes.length === 2) {
    if (convexContains(lobes[0], lobes[1])) return [lobes[0]]
    if (convexContains(lobes[1], lobes[0])) return [lobes[1]]
  }
  return lobes
}

/**
 * Boxes the reader drew: a stretch of rows by a stretch of columns.
 *
 * An outline, never a fill, and the same 1.25 px rule an overlay file's elements
 * are drawn with — a hand-drawn box and a domain out of a BED are the same
 * assertion about the same block of pixels, and drawing them differently would
 * suggest one of them means more than the other.
 *
 * Clipped to the data on **both** presentations, which the lines above do not
 * need to be: a line is drawn between the data's own edges, but a box is an
 * extent the reader chose and is very often bigger than what is on screen —
 * zoom into a domain and its box surrounds the view. Unclipped, its edges would
 * be drawn over the rulers and the lanes.
 */
export function drawManualRects(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  axes: OverlayAxes,
  rects: readonly ManualRect[],
): void {
  const { rows, cols } = axes
  const turn = axes.turn ?? null
  if (rects.length === 0 || cols === null || (turn === null && rows === null)) return

  ctx.save()
  clipToData(ctx, frame)
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1 / frame.dpr, 1.25)
  for (const rect of rects) {
    ctx.strokeStyle = rect.colour

    if (turn !== null) {
      for (const lobe of turnedLobes(frame, cols, turn, rect)) {
        ctx.beginPath()
        ctx.moveTo(lobe[0].x, lobe[0].y)
        for (let i = 1; i < lobe.length; i++) ctx.lineTo(lobe[i].x, lobe[i].y)
        ctx.closePath()
        ctx.stroke()
      }
      continue
    }

    const left = cols.locusToUnit(rect.b.contig, rect.b.from)
    const right = cols.locusToUnit(rect.b.contig, rect.b.to)
    const top = rows?.locusToUnit(rect.a.contig, rect.a.from) ?? null
    const bottom = rows?.locusToUnit(rect.a.contig, rect.a.to) ?? null
    // One end on a sequence this view does not draw is not half a box: on a
    // `chrI × chrII` block a box of chrI against chrIII has no columns here.
    if (left === null || right === null || top === null || bottom === null) continue
    const x0 = toX(frame, Math.min(left, right))
    const x1 = toX(frame, Math.max(left, right))
    const y0 = toY(frame, Math.min(top, bottom))
    const y1 = toY(frame, Math.max(top, bottom))
    if (x1 < frame.data.x || x0 > frame.data.x + frame.data.width) continue
    if (y1 < frame.data.y || y0 > frame.data.y + frame.data.height) continue
    ctx.beginPath()
    // A floor of two pixels on each side, as a domain's box has: a box one bin
    // wide on a whole-genome view is sub-pixel, and a mark the reader placed
    // must not be a mark they cannot find.
    ctx.rect(
      snap(x0, frame.dpr),
      snap(y0, frame.dpr),
      Math.max(2, x1 - x0),
      Math.max(2, y1 - y0),
    )
    ctx.stroke()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Arrowheads
// ---------------------------------------------------------------------------

/** How far the arrowhead's tip sits off the cell it names, in CSS pixels. */
const ARROW_GAP = 4
/** Tip to base. */
const ARROW_LENGTH = 13
/** Half the base's width. */
const ARROW_HALF = 6.5
/**
 * The last pixel between the tip and the cell, square to the axes.
 *
 * {@link ARROW_GAP} stands the glyph off along its own 45° axis, which is
 * `0.707 * 4` on each of x and y — enough to clear the cell's *centre*, which is
 * where the mark is anchored, and not enough to clear its **corner**. So at any
 * zoom where a bin is a handful of pixels the tip sat on the last row and column
 * of the very cell it was pointing at, which is the one thing §8.1 asks an
 * overlay never to do: it covered a corner of the pixel the reader was being
 * asked to look at.
 *
 * One pixel out on each axis is the whole fix, and it is deliberately *not*
 * scaled along the 45° axis — the overlap is with the cell's square corner, so
 * the correction is square too. Turned, the glyph stands straight up over the
 * dot and only the vertical needs it; a sideways nudge there would put the tip
 * over a *different* separation, which is a different pair of loci.
 */
const ARROW_NUDGE = 1

/**
 * Arrowheads, pointing down-left at the cell they name.
 *
 * Placed **outside** the cell relative to the main diagonal — up and to the
 * right for a mark in the upper triangle, down and to the left for its mirror —
 * so the pixel being called out is never under the glyph that calls it out. The
 * tip is what carries the meaning, and it is what sits closest to the cell,
 * clear of it by {@link ARROW_GAP} along the diagonal and {@link ARROW_NUDGE}
 * square to the axes.
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
    // The whole glyph stood off the cell's corner, tip and base together: a
    // nudge applied to the tip alone would shorten the arrow by a pixel and
    // leave it pointing a pixel to the side of where it is.
    const fromX = x + (turn === null ? side * ARROW_NUDGE : 0)
    const fromY = y + Math.sign(dy) * ARROW_NUDGE
    const tipX = fromX + dx * ARROW_GAP
    const tipY = fromY + dy * ARROW_GAP
    const baseX = fromX + dx * (ARROW_GAP + ARROW_LENGTH)
    const baseY = fromY + dy * (ARROW_GAP + ARROW_LENGTH)
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

