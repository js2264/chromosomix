/**
 * Segments and gene models: the lanes that draw *things on the sequence* rather
 * than a value over it.
 *
 * Two renderers over one layout, because the hard part is shared. Features
 * overlap, and a lane 16 pixels thick has room for two rows of them, so the
 * layout is a greedy row packing — the same thing every genome browser does, and
 * for the same reason: a peak drawn on top of another peak is one peak.
 *
 * The zoomed-out case is handled by *changing what is drawn*, not by drawing
 * less of it. Past the point where there are more features than pixels, packing
 * is meaningless — every row is full at every position — so the lane collapses
 * to a single row of density. Nothing is dropped: the picture stops claiming to
 * resolve individual features at the moment it stops being able to, which is the
 * same bargain the matrix raster makes when it pools (`poolDisplay`).
 */

import { featureRange } from '../annotations/featureset'
import type { FeatureSet } from '../annotations/types'
import { laneRect, laneText, valueAcross, type LaneFrame } from './lane'
import type { LocusAxis } from './locus'

/** Where one feature ended up. `along` is in canvas pixels. */
export interface FeaturePlacement {
  /** Index into the {@link FeatureSet}. */
  index: number
  along0: number
  along1: number
  row: number
}

export interface FeatureLayout {
  placements: FeaturePlacement[]
  /** How many rows the packing used. At least 1. */
  rows: number
  /** `true` when there were more features than pixels and rows were collapsed. */
  dense: boolean
  /** How many features the window actually holds, drawn or not. */
  total: number
}

/** Gap between two features in the same row, in pixels, so they read as two. */
const ROW_GAP = 2

/** Never pack into more rows than this, however thick the lane is. */
const MAX_ROWS = 8

/**
 * Beyond this many features the lane stops resolving individuals.
 *
 * Deliberately a *cap on work*, not only on appearance: past a hundred thousand
 * candidates in one window the layout itself is the cost, and no arrangement of
 * them is a picture anyone reads.
 */
const LAYOUT_CAP = 100_000

/**
 * Place every feature the window shows into a row.
 *
 * Candidates come per contig from the sorted index, so the whole visible set is
 * already in ascending order along the axis — which is exactly what a greedy
 * packing needs, and why this makes one pass rather than sorting.
 */
export function layoutFeatures(
  frame: LaneFrame,
  axis: LocusAxis,
  set: FeatureSet,
  maxRows: number,
): FeatureLayout {
  const placements: FeaturePlacement[] = []
  const span = Math.abs(frame.alongTo - frame.alongFrom)
  let total = 0

  for (const window of axis.windows(frame.domain)) {
    const contig = set.contigs.indexOf(window.contig)
    if (contig < 0) continue
    const segment = axis.segmentOf(window.contig)
    if (segment === null || !(segment.bpPerUnit > 0)) continue
    const [from, to] = featureRange(set, contig, window.start, window.end)
    for (let i = from; i < to && placements.length < LAYOUT_CAP; i++) {
      if (set.end[i] <= window.start || set.start[i] >= window.end) continue
      total++
      const u0 = segment.unitStart + (set.start[i] - segment.bpStart) / segment.bpPerUnit
      const u1 = segment.unitStart + (set.end[i] - segment.bpStart) / segment.bpPerUnit
      const along0 = frame.toPixel(u0)
      const along1 = frame.toPixel(u1)
      placements.push({ index: i, along0: Math.min(along0, along1), along1: Math.max(along0, along1), row: 0 })
    }
  }

  // More features than pixels: no packing exists that separates them, so say so
  // and draw one row. The count is kept, because "17,400 features here" is the
  // information the picture can still carry.
  const dense = placements.length > span / 2
  if (dense || maxRows <= 1) {
    return { placements, rows: 1, dense, total }
  }

  const rowEnds: number[] = []
  for (const placement of placements) {
    let row = rowEnds.findIndex((end) => end + ROW_GAP <= placement.along0)
    if (row < 0) {
      if (rowEnds.length < maxRows) {
        row = rowEnds.length
        rowEnds.push(placement.along1)
      } else {
        // Every row is occupied here. Overlapping the row that frees up soonest
        // loses the least, and it beats dropping the feature — an annotation
        // that silently omits rows is one nobody can trust.
        row = smallestIndex(rowEnds)
        rowEnds[row] = Math.max(rowEnds[row], placement.along1)
      }
    } else {
      rowEnds[row] = placement.along1
    }
    placement.row = row
  }
  return { placements, rows: Math.max(1, rowEnds.length), dense: false, total }
}

function smallestIndex(values: number[]): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i
  return best
}

/** How many rows a lane of this thickness can hold at a legible row height. */
export function rowsThatFit(thickness: number, rowHeight = 11): number {
  return Math.max(1, Math.min(MAX_ROWS, Math.floor(thickness / rowHeight)))
}

export interface FeaturePaint {
  colour: string
  guideColour: string
  haloColour: string
  font: string
  opacity: number
  /** Write feature names where they fit. */
  labels: boolean
}

/**
 * Plain segments: a box per feature.
 *
 * Strand, where the file carries one, is a notch on the trailing end rather than
 * an arrow beside the box — at the sizes a peak lane runs to there is no room
 * beside anything, and a notch costs no width at all.
 */
export function drawSegments(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
): void {
  if (layout.dense) {
    drawDensity(ctx, frame, layout, paint)
    return
  }
  const rowHeight = frame.thickness / layout.rows
  const boxHeight = Math.max(3, rowHeight - 2)
  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.fillStyle = paint.colour
  ctx.beginPath()
  for (const placement of layout.placements) {
    const top = placement.row * rowHeight + (rowHeight - boxHeight) / 2
    const [x, y, width, height] = laneRect(
      frame,
      placement.along0,
      placement.along1,
      top,
      top + boxHeight,
    )
    ctx.rect(x, y, width, height)
  }
  ctx.fill()

  if (paint.labels && !layout.dense) {
    labelFeatures(ctx, frame, set, layout, paint, rowHeight)
  }
  ctx.restore()
}

/**
 * Gene models: a spine, exon boxes on it, and the coding part thicker.
 *
 * The thick/thin distinction is not decoration — it is the difference between
 * the transcript and the protein, and it is the first thing anyone reads off a
 * gene track. Strand is a chevron *on* the spine, repeated along it, so a long
 * gene says which way it runs at every point rather than only at one end.
 */
export function drawGenes(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
): void {
  if (layout.dense) {
    drawDensity(ctx, frame, layout, paint)
    return
  }
  const rowHeight = frame.thickness / layout.rows
  const exonHeight = Math.max(3, Math.min(9, rowHeight * 0.5))
  const cdsHeight = Math.max(exonHeight + 2, Math.min(13, rowHeight * 0.78))

  ctx.save()
  ctx.globalAlpha = paint.opacity

  // The spines first, in one path: a gene with no exon table is a bare box, and
  // one with exons is a line the boxes sit on.
  ctx.strokeStyle = paint.colour
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const placement of layout.placements) {
    if (set.exonAt[placement.index + 1] === set.exonAt[placement.index]) continue
    const centre = placement.row * rowHeight + rowHeight / 2
    const [x, y, width, height] = laneRect(
      frame,
      placement.along0,
      placement.along1,
      centre - 0.5,
      centre + 0.5,
    )
    ctx.rect(x, y, width, height)
  }
  ctx.fillStyle = paint.colour
  ctx.fill()

  // Exons, then the coding part of each exon over them.
  for (const pass of [0, 1] as const) {
    const height = pass === 0 ? exonHeight : cdsHeight
    ctx.beginPath()
    for (const placement of layout.placements) {
      const index = placement.index
      const cdsFrom = set.cdsStart[index]
      const cdsTo = set.cdsEnd[index]
      if (pass === 1 && !(cdsTo > cdsFrom)) continue
      const centre = placement.row * rowHeight + rowHeight / 2
      const top = centre - height / 2
      const first = set.exonAt[index]
      const last = set.exonAt[index + 1]

      if (first === last) {
        // No sub-structure: the feature is its own single block, and only on the
        // first pass — there is no coding span to thicken.
        if (pass === 0) {
          const [x, y, width, boxHeight] = laneRect(
            frame,
            placement.along0,
            placement.along1,
            top,
            top + height,
          )
          ctx.rect(x, y, width, boxHeight)
        }
        continue
      }

      const scale = (placement.along1 - placement.along0) / Math.max(1, set.end[index] - set.start[index])
      for (let exon = first; exon < last; exon++) {
        let bpFrom = set.exonStart[exon]
        let bpTo = set.exonEnd[exon]
        if (pass === 1) {
          bpFrom = Math.max(bpFrom, cdsFrom)
          bpTo = Math.min(bpTo, cdsTo)
          if (!(bpTo > bpFrom)) continue
        }
        const a0 = placement.along0 + (bpFrom - set.start[index]) * scale
        const a1 = placement.along0 + (bpTo - set.start[index]) * scale
        const [x, y, width, boxHeight] = laneRect(frame, a0, a1, top, top + height)
        ctx.rect(x, y, width, boxHeight)
      }
    }
    ctx.fill()
  }

  if (!layout.dense) {
    drawStrandMarks(ctx, frame, set, layout, paint, rowHeight)
    if (paint.labels) labelFeatures(ctx, frame, set, layout, paint, rowHeight)
  }
  ctx.restore()
}

/**
 * The zoomed-out picture: how many features cover each pixel.
 *
 * Boxes are the wrong answer once there are more features than pixels — every
 * pixel is covered, so the lane is a solid bar and says only "there are genes
 * here", which for a gene-dense genome is not news. A count profile says
 * *how many*, which is the question that still has an answer at this zoom, and
 * it costs one pass over placements that have already been computed.
 *
 * Scaled to the busiest pixel in view rather than to a fixed ceiling: the lane
 * is a picture of relative density across what is on screen, and it rescales as
 * the view moves for the same reason a track's autoscale does.
 */
function drawDensity(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  layout: FeatureLayout,
  paint: FeaturePaint,
): void {
  const from = Math.floor(Math.min(frame.alongFrom, frame.alongTo))
  const slots = Math.max(1, Math.ceil(Math.abs(frame.alongTo - frame.alongFrom)) + 1)
  const counts = new Float32Array(slots)
  let peak = 0
  for (const placement of layout.placements) {
    const first = Math.max(0, Math.floor(placement.along0 - from))
    const last = Math.min(slots - 1, Math.ceil(placement.along1 - from) - 1)
    for (let slot = first; slot <= last; slot++) {
      counts[slot]++
      if (counts[slot] > peak) peak = counts[slot]
    }
  }
  if (peak <= 0) return

  const base = valueAcross(frame, 0)
  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.fillStyle = paint.colour
  ctx.beginPath()
  for (let slot = 0; slot < slots; slot++) {
    if (counts[slot] === 0) continue
    // A floor of one twelfth, so a pixel with a single feature under a busy
    // neighbour is still visible rather than rounded away to nothing.
    const height = Math.max(counts[slot] / peak, 1 / 12)
    const [x, y, width, boxHeight] = laneRect(
      frame,
      from + slot,
      from + slot + 1,
      base,
      valueAcross(frame, height),
    )
    ctx.rect(x, y, width, boxHeight)
  }
  ctx.fill()
  ctx.restore()
}

/** Chevrons along each spine, every {@link STRAND_MARK_GAP} pixels. */
const STRAND_MARK_GAP = 26

function drawStrandMarks(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  rowHeight: number,
): void {
  ctx.save()
  ctx.strokeStyle = paint.haloColour
  ctx.lineWidth = 1
  ctx.globalAlpha = paint.opacity * 0.9
  ctx.beginPath()
  const reach = Math.max(2, Math.min(3.5, rowHeight * 0.2))
  for (const placement of layout.placements) {
    const strand = set.strand[placement.index]
    if (strand === 0) continue
    const width = placement.along1 - placement.along0
    if (width < STRAND_MARK_GAP) continue
    const centre = placement.row * rowHeight + rowHeight / 2
    for (let at = placement.along0 + STRAND_MARK_GAP / 2; at < placement.along1; at += STRAND_MARK_GAP) {
      // The chevron points the way the gene is transcribed. On a right-hand
      // lane the axis runs downward, so `+1` still means "further along the
      // axis" and the mark comes out consistent with the map beside it.
      const tip = at + reach * strand
      const back = at - reach * strand
      line(ctx, frame, back, centre - reach, tip, centre)
      line(ctx, frame, back, centre + reach, tip, centre)
    }
  }
  ctx.stroke()
  ctx.restore()
}

function line(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  across0: number,
  along1: number,
  across1: number,
): void {
  const x0 = frame.orientation === 'bottom' ? along0 : frame.acrossFrom + across0
  const y0 = frame.orientation === 'bottom' ? frame.acrossFrom + across0 : along0
  const x1 = frame.orientation === 'bottom' ? along1 : frame.acrossFrom + across1
  const y1 = frame.orientation === 'bottom' ? frame.acrossFrom + across1 : along1
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
}

/**
 * Names, on the features wide enough to hold one.
 *
 * Written *inside* the feature rather than beside it. Beside is what a genome
 * browser does with a whole window to itself; a lane 46 pixels thick under a
 * contact map has no beside, and a name that overflows its feature is a name
 * attached to whatever is next to it.
 */
function labelFeatures(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  rowHeight: number,
): void {
  if (rowHeight < 9) return
  ctx.save()
  ctx.font = paint.font
  ctx.fillStyle = paint.guideColour
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const placement of layout.placements) {
    const name = set.name[placement.index]
    if (name === '') continue
    const width = placement.along1 - placement.along0
    if (width < 18) continue
    const text = ctx.measureText(name).width
    if (text + 6 > width) continue
    const centre = placement.row * rowHeight + rowHeight / 2
    laneText(ctx, frame, name, (placement.along0 + placement.along1) / 2, centre, {
      halo: paint.haloColour,
    })
  }
  ctx.restore()
}

/**
 * The feature under a canvas point, or `null`.
 *
 * Takes the *last* match rather than the first, so the feature drawn on top is
 * the one the tooltip names. Within a row the placements are in axis order and
 * later ones paint over earlier ones, which is only visible where the packing
 * had to overlap them — but that is exactly where getting it wrong is confusing.
 */
export function featureAt(
  frame: LaneFrame,
  layout: FeatureLayout,
  x: number,
  y: number,
): FeaturePlacement | null {
  const along = frame.orientation === 'bottom' ? x : y
  const across = (frame.orientation === 'bottom' ? y : x) - frame.acrossFrom
  if (across < 0 || across > frame.thickness) return null
  const rowHeight = frame.thickness / layout.rows
  const row = Math.min(layout.rows - 1, Math.max(0, Math.floor(across / rowHeight)))
  let found: FeaturePlacement | null = null
  for (const placement of layout.placements) {
    if (!layout.dense && placement.row !== row) continue
    // A one-pixel feature is a two-pixel target: the drawn box is floored to a
    // pixel, and a hit area narrower than what is on screen is unhittable.
    if (along < placement.along0 - 1 || along > placement.along1 + 1) continue
    found = placement
  }
  return found
}

/** Where a value lands across the lane; re-exported so callers need one import. */
export { valueAcross }
