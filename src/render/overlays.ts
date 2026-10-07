/**
 * Everything drawn *on* the matrix: the map-overlay card's files, and the
 * hand-drawn marks (spec §8.1).
 *
 * The rule the whole module follows is that an overlay must not hide the pixel
 * it is about. A loop marked by a filled disc is a loop nobody can see; a domain
 * marked by a filled triangle is a domain whose interior has been painted over.
 * So everything here is an outline, a rule, or a glyph placed *beside* what it
 * points at — and of the two filled shapes, the arrowhead sits outside the cell
 * it names, on the far side from the diagonal, and a called place's **point**
 * sits on the diagonal itself, over the one pixel a boundary is not about: what
 * it claims is that little crosses *there*, which is read off the map either
 * side of the dot.
 *
 * Positions come from the two {@link LocusAxis} objects the panel already built,
 * which are the same ones the lanes use, which are built from the same runs the
 * heatmap draws its separators from. There is no second coordinate system here
 * either (§8.4).
 */

import { contigIndexOf } from '../genome/naming'

import { featureRange } from '../annotations/featureset'
import type { ManualArrowhead, ManualLine, ManualRect, ManualSpan } from '../annotations/manual'
import { overlayShapeOf, type FeatureSet, type OverlayShape, type PairSet } from '../annotations/types'
import type { Rect } from './heatmap'
import { stretchOf, unitSpan, type LocusAxis } from './locus'
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
  /**
   * What a `point` is ringed in before it is filled — the page's background, so
   * a dot reads against a saturated colormap as well as against an empty
   * corner, as an arrowhead does. Absent, a point is filled alone.
   */
  halo?: string
}

/** A point's radius, in CSS pixels: a dot on the diagonal, not a disc over it. */
const POINT_RADIUS = 3

/**
 * A called set of segments, marked where it meets the diagonal (§18.7).
 *
 * Three looks, because the two things a task calls along a contact map are not
 * the same kind of object and the first of them has two honest pictures:
 *
 * - **point** — a place (an insulation minimum, a boundary, a site), drawn as a
 *   dot on the diagonal at the feature's midpoint. A dot reads at any zoom: a
 *   boundary one bin wide is sub-pixel on a whole-chromosome view, and a box for
 *   it vanished.
 * - **border** — the same place as a short rule *across* the diagonal, the
 *   short diagonal marker, which says *here* without covering the diagonal's
 *   own pixel: a run of them crosses the diagonal as a row of ticks.
 * - **corner** — an extent (a domain, a compartment), drawn as the corner of
 *   the square it occupies: its top edge and its right edge, which meet off the
 *   diagonal over the block of contacts the call is claiming. One corner per
 *   domain, on the upper side as a loop's ring is, so consecutive domains read
 *   as the run of corners along the diagonal every domain figure draws; the
 *   whole square drew each claim twice, once either side of the line it is
 *   symmetric about, and hid the near-diagonal under a lattice.
 *
 * On a rectangular block — `contig_A × contig_B` — a feature that lands on both
 * axes still draws its corner, at the intersection of the two bands, which is
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
  // Read through the stored look, so a session written when the extent's look
  // was a whole box draws its corner rather than nothing.
  const shape = overlayShapeOf(paint)
  // A point is filled rather than stroked, and a marker is ringed before it is
  // stroked, so both are gathered and drawn after the walk, halo first; the
  // corners are the one path the walk itself builds.
  const points: Array<{ x: number; y: number }> = []
  const marks: Array<[number, number, number, number]> = []

  ctx.save()
  if (turn !== null) clipToData(ctx, frame)
  ctx.globalAlpha = paint.opacity
  ctx.strokeStyle = paint.colour
  ctx.lineWidth = Math.max(1 / frame.dpr, 1.25)
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
      // Clipped to the piece this stretch is, and ordered: a reversed piece of
      // an edited sequence (§27.2) puts a feature's end on its left. On an axis
      // with no edit the stretch is the whole contig and the order already right.
      const [colFrom, colTo] = unitSpan(
        segment,
        Math.max(set.start[i], stretchOf(segment)[0]),
        Math.min(set.end[i], stretchOf(segment)[1]),
      )
      if (!(colTo > colFrom)) continue

      if (turn !== null) {
        const base = toY(frame, axisRow(turn))
        // Away from the diagonal, which is up the screen on an ordinary turned
        // map and down the screen on the mirrored half of a comparison.
        const away = turn.direction === 'up' ? -1 : 1
        const mid = toX(frame, (colFrom + colTo) / 2)
        if (shape === 'border' || shape === 'point') {
          // The midpoint *is* the mark here, so a midpoint off screen is a mark
          // off screen — which is why this guard belongs inside this branch and
          // not above it.
          if (!insideX(frame, mid)) continue
          // A dot resting on the axis rather than centred on it, for the tick's
          // reason below: half of it would be over the first rows of signal.
          if (shape === 'point') {
            points.push({ x: mid, y: base + away * POINT_RADIUS })
            continue
          }
          // A tick standing on the axis rather than a cross over it: the whole
          // of a turned map's signal is in the first few rows above the
          // diagonal, and a cross centred there covers what it is pointing at.
          // Snapped, because it is a hairline; the corner below is not.
          const x = snap(mid, frame.dpr)
          marks.push([x, base, x, base + away * 9])
          continue
        }
        // The corner of the square `[start, end]²` a domain occupies, turned:
        // its two ends on the diagonal stay on the axis, and the corner off it
        // stands over the midpoint at the height of the domain's own width. The
        // two sides of a triangle standing on the axis — the shape a reader of a
        // turned map is looking for and the reason the picture is worth turning
        // — and no base, which would be a rule along the diagonal's own row.
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
        continue
      }

      // The row axis's copy of the *same* stretch, so a box on a circular
      // sequence panned across its junction stands on the diagonal rather than a
      // sequence away from it (§8.15). On every other view this is the one
      // stretch there is, and `at` and `rowAt` are the same mapping.
      const rowSegment = rows?.like(segment) ?? null
      if (rowSegment === null || !(rowSegment.bpPerUnit > 0)) continue
      const [rowFrom, rowTo] = unitSpan(
        rowSegment,
        Math.max(set.start[i], stretchOf(rowSegment)[0]),
        Math.min(set.end[i], stretchOf(rowSegment)[1]),
      )

      if (shape === 'border' || shape === 'point') {
        const x = toX(frame, (colFrom + colTo) / 2)
        const y = toY(frame, (rowFrom + rowTo) / 2)
        if (!insideX(frame, x) || !insideY(frame, y)) continue
        // A dot on the diagonal at the feature's midpoint: where the place is,
        // and nothing about a width the picture cannot show.
        if (shape === 'point') {
          points.push({ x, y })
          continue
        }
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
        const sx = snap(x, frame.dpr)
        const sy = snap(y, frame.dpr)
        const reach = 7
        marks.push([sx - reach, sy + reach, sx + reach, sy - reach])
        continue
      }

      const x0 = toX(frame, colFrom)
      const x1 = toX(frame, colTo)
      const y0 = toY(frame, rowFrom)
      const y1 = toY(frame, rowTo)
      const left = Math.min(x0, x1)
      // A floor of two pixels on each side, as a hand-drawn box has: a domain
      // one bin wide on a whole-chromosome view is sub-pixel, and a corner of
      // nothing is a mark nobody can find.
      const right = Math.max(Math.max(x0, x1), left + 2)
      const top = Math.min(y0, y1)
      const bottom = Math.max(Math.max(y0, y1), top + 2)
      // Overlap, not corner-in-view, and the same test {@link drawManualRects}
      // makes for the same reason: a domain is an *extent*, and an extent is
      // very often bigger than the window it is read in — zoom into a domain and
      // its square surrounds the view. Guarding it by `insideX(x1)`/`insideY(y1)`
      // asked whether its bottom-right corner was on screen, so the mark
      // disappeared at exactly the zoom the reader reached for to inspect the
      // block it is claiming, and asymmetrically at that: `locusToUnit` grows
      // with bp, so a pan that kept only the domain's start drew nothing while
      // the mirror pan kept drawing. Nothing is at risk unclipped — the caller
      // (`HeatmapView.drawOverlay`) clips the painter to the data rect.
      if (right < frame.data.x || left > frame.data.x + frame.data.width) continue
      if (bottom < frame.data.y || top > frame.data.y + frame.data.height) continue
      // The top edge and then the right one: from the diagonal at the domain's
      // start, along its first row to the corner over its end, and down that
      // column to the diagonal again. Both rules on the device grid, because
      // they are hairlines and a corner's two arms are what is read.
      const edgeY = snap(top, frame.dpr)
      const edgeX = snap(right, frame.dpr)
      ctx.moveTo(left, edgeY)
      ctx.lineTo(edgeX, edgeY)
      ctx.lineTo(edgeX, bottom)
    }
  }
  ctx.stroke()

  // Each traced once per paint rather than painted twice off one path: the
  // vector page (§7.2) hands a path to the operator that paints it and starts
  // the next one empty, so a fill after the halo's stroke filled nothing and the
  // PDF held a ring for every dot.
  if (marks.length > 0) {
    const rule = (): void => {
      ctx.beginPath()
      for (const [x0, y0, x1, y1] of marks) {
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
      }
    }
    // A rule a pixel and a half wide in the row's colour over one three wide in
    // the page's, so a marker crossing the darkest row of the map is still read
    // as a mark and not as a scratch on it.
    if (paint.halo !== undefined) {
      rule()
      ctx.strokeStyle = paint.halo
      ctx.lineWidth = 3
      ctx.stroke()
    }
    rule()
    ctx.strokeStyle = paint.colour
    ctx.lineWidth = Math.max(1 / frame.dpr, 1.5)
    ctx.stroke()
  }

  if (points.length > 0) {
    const trace = (): void => {
      ctx.beginPath()
      for (const point of points) {
        ctx.moveTo(point.x + POINT_RADIUS, point.y)
        ctx.arc(point.x, point.y, POINT_RADIUS, 0, Math.PI * 2)
      }
    }
    // Ringed in the page's background before it is filled, as an arrowhead is,
    // so a dot over the darkest row of the map is still a dot.
    if (paint.halo !== undefined) {
      trace()
      ctx.strokeStyle = paint.halo
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    trace()
    ctx.fillStyle = paint.colour
    ctx.fill()
  }
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


// ---------------------------------------------------------------------------
// Which mark the hand is on
// ---------------------------------------------------------------------------

/** How near a rule or an outline the pointer has to be to be on it, in CSS pixels. */
export const MARK_REACH = 6

/** The drawn marks, kind by kind, as `ManualStore` hands them to a painter. */
export interface DrawnMarks {
  readonly lines: readonly ManualLine[]
  readonly arrowheads: readonly ManualArrowhead[]
  readonly rects: readonly ManualRect[]
}

/**
 * The marks under a point of the map, nearest first — what its right-click
 * menu offers to hide (§8.1).
 *
 * **Measured on the ink.** Each mark is drawn again, alone, into a context that
 * keeps the path it was handed rather than painting it, and the pointer is
 * measured against that path: the rule or the V a line is, the glyph an
 * arrowhead is, the outline — or the triangle, or the leaning lobes — a box is.
 * So the answer cannot part from the picture on either presentation, and a
 * fourth copy of each mark's geometry is not written here to drift from the
 * three painters.
 *
 * A rule or an outline is under the pointer within `reach` pixels of it, and an
 * arrowhead anywhere on its glyph or within reach of it — which takes in the
 * cell it names, a few pixels off its tip. A box is the one mark that is an
 * area, so a point **inside** one is on it too, after anything the pointer is
 * on the line of, and the smaller of two boxes first: the domain inside the
 * compartment, not the compartment around the domain.
 */
export function manualMarksAt(
  frame: OverlayFrame,
  axes: OverlayAxes,
  marks: DrawnMarks,
  at: { x: number; y: number },
  reach: number = MARK_REACH,
): Array<ManualLine | ManualArrowhead | ManualRect> {
  const found: Array<{ mark: ManualLine | ManualArrowhead | ManualRect; distance: number; area: number }> = []
  const measure = (
    mark: ManualLine | ManualArrowhead | ManualRect,
    draw: (ctx: CanvasRenderingContext2D) => void,
    inside: number | null,
  ): void => {
    const path = new PathRecorder()
    draw(path as unknown as CanvasRenderingContext2D)
    const near = path.near(at, inside)
    if (near !== null && near.distance <= reach) found.push({ mark, ...near })
  }
  for (const line of marks.lines) measure(line, (ctx) => drawManualLines(ctx, frame, axes, [line]), null)
  for (const mark of marks.arrowheads) measure(mark, (ctx) => drawArrowheads(ctx, frame, axes, [mark], ''), 0)
  // Inside a box counts as just within reach: after every mark whose own line
  // the pointer is on, before nothing it is not.
  for (const rect of marks.rects) measure(rect, (ctx) => drawManualRects(ctx, frame, axes, [rect]), reach * 0.9)
  found.sort((one, two) => one.distance - two.distance || one.area - two.area)
  return found.map((entry) => entry.mark)
}

/**
 * Just enough of a 2D context to read back where a painter put its ink: the
 * paths it stroked or filled, in its own coordinates.
 *
 * What a painter clips to is dropped — a frame around the data is not part of
 * a mark — and so is anything built and never drawn.
 */
class PathRecorder {
  strokeStyle: unknown = ''
  fillStyle: unknown = ''
  lineWidth = 1
  lineJoin = ''
  globalAlpha = 1
  private readonly drawn: Array<{ points: Point[]; closed: boolean }> = []
  private path: Array<{ points: Point[]; closed: boolean }> = []

  save(): void {}
  restore(): void {}
  beginPath(): void {
    this.path = []
  }
  moveTo(x: number, y: number): void {
    this.path.push({ points: [{ x, y }], closed: false })
  }
  lineTo(x: number, y: number): void {
    const open = this.path[this.path.length - 1]
    if (open === undefined) this.moveTo(x, y)
    else open.points.push({ x, y })
  }
  closePath(): void {
    const open = this.path[this.path.length - 1]
    if (open !== undefined) open.closed = true
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.path.push({
      points: [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ],
      closed: true,
    })
  }
  clip(): void {
    this.path = []
  }
  stroke(): void {
    this.drawn.push(...this.path)
  }
  fill(): void {
    this.drawn.push(...this.path)
  }

  /**
   * How far a point is from the ink, and the area of the smallest closed shape
   * around it. `inside` is the distance a point within a closed shape counts as
   * — `null` where a shape is only its outline.
   */
  near(at: Point, inside: number | null): { distance: number; area: number } | null {
    let distance = Number.POSITIVE_INFINITY
    let area = Number.POSITIVE_INFINITY
    for (const { points, closed } of this.drawn) {
      const count = closed ? points.length : points.length - 1
      if (points.length === 1) distance = Math.min(distance, Math.hypot(at.x - points[0].x, at.y - points[0].y))
      for (let i = 0; i < count; i++) {
        distance = Math.min(distance, segmentDistance(at, points[i], points[(i + 1) % points.length]))
      }
      if (closed && points.length >= 3 && inside !== null && polygonHolds(points, at)) {
        distance = Math.min(distance, inside)
        area = Math.min(area, Math.abs(windingOf(points)) / 2)
      }
    }
    return Number.isFinite(distance) ? { distance, area } : null
  }
}

/** Distance from a point to a segment. */
function segmentDistance(at: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length))
  return Math.hypot(at.x - (a.x + t * dx), at.y - (a.y + t * dy))
}

/** Whether a polygon holds a point: an even-odd ray cast, which any simple polygon answers. */
function polygonHolds(polygon: readonly Point[], at: Point): boolean {
  let holds = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > at.y !== b.y > at.y && at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x) holds = !holds
  }
  return holds
}
