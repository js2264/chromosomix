/**
 * Segments and gene models: the lanes that draw *things on the sequence* rather
 * than a value over it.
 *
 * Two renderers over one layout, because the hard part is shared. Features
 * overlap, and a lane 16 pixels thick has room for two rows of them, so the
 * layout is a greedy row packing — the same thing every genome browser does, and
 * for the same reason: a peak drawn on top of another peak is one peak.
 *
 * Where the file carries strands and the lane has the rows for it, that packing
 * runs **once per strand** into a band of its own — unstranded, then forward,
 * then reverse, outward from the map (§8.16). Two features on the same bases and
 * opposite strands are the case it is for: packed together they are two boxes
 * one above the other and which is which is a colour you have to look up, and
 * banded they are two boxes in the two places the strands live.
 *
 * The zoomed-out case is handled by *changing what is drawn*, not by drawing
 * less of it. Past the point where there are more features than pixels, packing
 * is meaningless — every row is full at every position — so the lane collapses
 * to a single row of density. Nothing is dropped: the picture stops claiming to
 * resolve individual features at the moment it stops being able to, which is the
 * same bargain the matrix raster makes when it pools (`poolDisplay`).
 */

import { contigIndexOf } from '../genome/naming'

import { featureRange } from '../annotations/featureset'
import { strandBands, type BarScale } from '../annotations/fields'
import type { AnnotationKind, FeatureSet } from '../annotations/types'
import {
  BAR_GAP,
  BAR_MIN_WIDTH,
  barChartRows,
  barColours,
  dominantOf,
  peakOf,
} from './barchart'
import { VARIANT_MIN_WIDTH } from './variants'
import {
  canvasToAcross,
  laneGrowsInward,
  laneIsHorizontal,
  laneLine,
  laneMove,
  laneRect,
  laneText,
  valueAcross,
  type LaneFrame,
} from './lane'
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
  /**
   * How many rows the lane is divided into. At least 1.
   *
   * What the packing *used* on an unbanded lane, and what it was *given* on a
   * banded one — see {@link layoutFeatures}. The difference matters because
   * this is the divisor for the row height: a band that fits into fewer rows
   * than it was allotted still has to sit where the allotment put it.
   */
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
 *
 * The rows are **banded by strand** when the file uses more than one and the
 * lane is at least that many rows tall (§8.16): each band gets a contiguous
 * slice of the rows and is packed inside it. The bands come from the file rather
 * than from the window (`strandBands`), so panning never re-lays out the lane;
 * a lane too short to give every band a row falls back to the one packing over
 * all of them, which is what a 16-pixel lane beside a map gets.
 */
export function layoutFeatures(
  frame: LaneFrame,
  axis: LocusAxis,
  set: FeatureSet,
  maxRows: number,
  /**
   * The narrowest one feature will be *drawn* — {@link FeaturePaint.minWidth}.
   *
   * It belongs here as well as in the paint because it changes the answer to
   * "can these be told apart", which is the question the collapse below asks. A
   * variant is one base, which is a hairline at every zoom a chromosome is
   * browsed at, so it is drawn at a floor of three pixels — and the moment
   * records are closer together than that floor plus the gap between them, the
   * marks *merge*. Merged, a stretch of mixed substitutions draws as one solid
   * bar in whichever ink was laid down last, which reads as a single
   * three-kilobase variant: a claim the file does not make. Collapsing to
   * density instead says the true thing, which is that there are many here.
   *
   * Zero — every caller but the variant lane — leaves the rule exactly as it
   * was: a peak that is one pixel wide *is* one pixel of genome.
   */
  leastWidth = 0,
  /**
   * Whether the rows may be banded by strand (§8.16).
   *
   * `true` for every lane whose glyph is a *box*, which is every lane but one.
   * A barChart lane says `false`, and the reason is that banding spends the
   * thing a chart is made of: the rows divide the lane's **height**, and a
   * barChart's height is its value axis. Splitting a sixty-pixel lane into
   * three strand bands buys a fact the card already states and costs two thirds
   * of every reading on the lane — which is the one trade §8.16's argument for
   * banding, "a colour you have to look up against a place you can see", does
   * not survive when the place is also the measurement.
   */
  banded = true,
): FeatureLayout {
  const placements: FeaturePlacement[] = []
  const span = Math.abs(frame.alongTo - frame.alongFrom)
  let total = 0

  for (const window of axis.windows(frame.domain)) {
    // Alias-aware, because a deck draws one feature set beside every panel and
    // each asks by the name *its* own file writes (§5.9). The set carries the
    // spelling of the map it was loaded against, which is one of them at most.
    const contig = contigIndexOf(set.contigs, window.contig)
    if (contig < 0) continue
    // The window's **own** stretch, not the first one on the axis with this
    // name: a circular sequence panned across its junction is the same contig
    // twice, and `segmentOf` would place the far half a sequence out (§8.15).
    const segment = window.segment
    if (!(segment.bpPerUnit > 0)) continue
    const [from, to] = featureRange(set, contig, window.start, window.end)
    for (let i = from; i < to; i++) {
      if (set.end[i] <= window.start || set.start[i] >= window.end) continue
      // Counted before the cap is consulted, not after it. The loop used to
      // stop dead at `LAYOUT_CAP`, which stopped the *count* with it — so the
      // caption a collapsed lane writes ("17,400 features here") reported the
      // cap rather than the window, and under-reported by however much a dense
      // file exceeded it. The count is the one thing the picture can still
      // carry once it has stopped resolving individuals; it must be the truth.
      total++
      if (placements.length >= LAYOUT_CAP) continue
      const u0 = segment.unitStart + (set.start[i] - segment.bpStart) / segment.bpPerUnit
      const u1 = segment.unitStart + (set.end[i] - segment.bpStart) / segment.bpPerUnit
      const along0 = frame.toPixel(u0)
      const along1 = frame.toPixel(u1)
      placements.push({ index: i, along0: Math.min(along0, along1), along1: Math.max(along0, along1), row: 0 })
    }
  }

  // More features than the lane can draw apart: no packing exists that separates
  // them, so say so and draw one row. The count is kept, because "17,400
  // features here" is the information the picture can still carry.
  //
  // The width one feature needs is its drawn floor plus the gap that makes two
  // read as two — which for everything but a variant lane is the two pixels it
  // has always been.
  const dense = placements.length > span / Math.max(2, leastWidth + ROW_GAP)

  // Widened **into the placement**, here, once — so the box that is drawn, the
  // box that is clicked and the box the packing keeps a row clear for are one
  // number (§8.4). It was applied in the paint alone, which left a variant
  // three pixels wide on screen and a fraction of a pixel wide to the pointer:
  // two thirds of every mark was dead to hover and to click, and the spec said
  // "three pixels to be seen and to be hit" while only the first was true.
  //
  // After the density decision and not before: a collapsed lane bins by
  // position, and widening there would spread one variant's count over three
  // pixels and inflate the profile.
  if (leastWidth > 0 && !dense) {
    for (const placement of placements) {
      placement.along1 = Math.max(placement.along1, placement.along0 + leastWidth)
    }
  }

  if (dense) {
    return { placements, rows: 1, dense, total }
  }

  // Banded by strand where the file has more than one and the lane has the room
  // for each: unstranded at the near edge, then forward, then reverse (§8.16). A
  // band is a *sub-range of the rows*, so the packing below is the same greedy
  // pass it always was — run once per band, over its own rows.
  //
  // Asked of the lane's **thickness** rather than of `maxRows`, and the
  // difference is the whole of whether this works where it is most wanted.
  // `maxRows` is calibrated on the height a row needs to carry a *name under a
  // feature* — twenty-odd pixels — so a segments lane at its default sixteen
  // gets one row and would never band at all, which is exactly the lane a
  // stranded BED lands in. A band needs only {@link MIN_BAND_ROW}: a glyph and
  // the gap under it. Where both fit, the bands win and the labels go back
  // inside the features, which is what a lane that short does anyway.
  const bands = banded ? strandBands(set) : [0]
  if (bands.length > 1 && frame.thickness / bands.length >= MIN_BAND_ROW) {
    const rows = Math.max(maxRows, bands.length)
    const shares = shareRows(rows, bands.length)
    let offset = 0
    for (let band = 0; band < bands.length; band++) {
      packRows(
        placements.filter((placement) => sign(set.strand[placement.index]) === bands[band]),
        offset,
        shares[band],
      )
      offset += shares[band]
    }
    // The *allocated* height, not the used one: a band that packed into one of
    // its two rows still sits where the allocation put it, and reporting the
    // smaller number would scale every row up and slide the bands over each
    // other.
    return { placements, rows: offset, dense: false, total }
  }

  if (maxRows <= 1) {
    return { placements, rows: 1, dense, total }
  }

  const used = packRows(placements, 0, maxRows)
  return { placements, rows: Math.max(1, used), dense: false, total }
}

/**
 * The shortest a strand band may be, in pixels.
 *
 * A three-pixel glyph — the floor `drawSegments` keeps for a box — plus the gap
 * that makes two rows read as two, plus a pixel either side of the glyph. Below
 * it the two strands are two hairlines and the packing has bought nothing;
 * above it they are two rows of small boxes, which is what a sixteen-pixel
 * segments lane should be when its file has both strands in it.
 */
const MIN_BAND_ROW = 8

/** `+1`, `-1` or `0`, so a strand column with other values in it still bands. */
function sign(strand: number): number {
  return strand > 0 ? 1 : strand < 0 ? -1 : 0
}

/**
 * Greedy row packing over `rows` rows starting at `from`. Returns how many were
 * used.
 *
 * Candidates arrive in ascending order along the axis — the sorted index gives
 * them that way, and a band is a filter over them, which preserves it — so this
 * is one pass rather than a sort.
 */
function packRows(placements: FeaturePlacement[], from: number, rows: number): number {
  const rowEnds: number[] = []
  for (const placement of placements) {
    let row = rowEnds.findIndex((end) => end + ROW_GAP <= placement.along0)
    if (row < 0) {
      if (rowEnds.length < rows) {
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
    placement.row = from + row
  }
  return rowEnds.length
}

/**
 * How the lane's rows are split between the strand bands.
 *
 * Evenly, with the remainder going to the earliest bands, and **not** in
 * proportion to how many features each band holds in this window. Proportional
 * would pack better and would move every glyph in the lane each time a pan
 * changed the balance; an even split is the same split at every position in the
 * genome, which is what makes the three bands readable as three bands.
 */
function shareRows(rows: number, bands: number): number[] {
  const each = Math.floor(rows / bands)
  const spare = rows - each * bands
  return Array.from({ length: bands }, (_, i) => each + (i < spare ? 1 : 0))
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
  /**
   * Put the name *under* the feature rather than inside it.
   *
   * What a genome browser does, and what a lane beside a contact map has no
   * room for — which is the whole of the difference between the two callers. A
   * name below is legible on a feature far narrower than the name, so a gene
   * track stops being a row of anonymous boxes at any zoom where the genes are
   * the point; a name inside is only ever legible on the wide ones.
   */
  labelsBelow?: boolean
  /**
   * How tall the band under a feature is, or absent for this module's own.
   *
   * Passed in because it is measured in the same units as {@link font}: the app
   * scales every canvas font together, and a band that stayed eleven pixels
   * while the name in it grew would clip the name it exists to hold.
   */
  labelBand?: number
  /**
   * A colour per feature, where one feature's ink is not the lane's.
   *
   * Resolved by `render/featureInk.ts` from the field the lane's style names
   * (§8.16) — by strand, which is where every feature lane starts; by a called
   * variant's substituted base, which is §8.14's older rule and still its
   * default; by a column of the file; or not at all. Absent draws the whole set
   * in {@link colour}, in one path, exactly as this always did — which is what
   * `one colour` in the picker resolves to.
   *
   * The index is into the {@link FeatureSet}, not into the layout, because that
   * is what a placement carries and what the label pass already uses.
   */
  colourOf?: (index: number) => string
  /**
   * Point a stranded feature the way it runs.
   *
   * `true` unless said otherwise, because a stranded file is the common case
   * and the direction is the fact two colours cannot state: an ink says *which*
   * strand, a point says *which way*, and a reader following an operon is
   * reading the second. It reaches only the features that have a strand and the
   * room for a head — see {@link ARROW_MIN_WIDTH} — so a peak set with no strand
   * column comes out in the plain rectangles it always did, whatever this says.
   */
  arrows?: boolean
  /**
   * What a barChart's bars are measured against (§8.17).
   *
   * Absent is `file` — one ceiling for every chart on the lane, which is the
   * only setting under which two glyphs can be compared. `FeatureStyle.bars` in
   * `annotations/fields.ts` says why the other reading exists.
   */
  barScale?: BarScale
}

/** Height a below-the-feature name needs, in canvas pixels. */
export const LABEL_BAND = 11

/**
 * Plain segments: a box per feature, pointed where the file gives it a strand.
 *
 * The point is *part of the box* rather than a mark beside it — the head is cut
 * out of the leading end, so the glyph occupies exactly the bases the feature
 * does and the thing that is drawn, the thing that is clicked and the thing the
 * packing kept a row clear for stay one span (§8.4). At the sizes a peak lane
 * runs to there is no room beside anything, and an arrow drawn past the end of
 * a feature is an arrow claiming bases the file never mentioned.
 *
 * A feature with no strand, and every feature on a lane whose reader has turned
 * the points off, is the rectangle this always drew. So is one too narrow to
 * hold a head: below {@link ARROW_MIN_WIDTH} a point is a smudge that makes a
 * five-pixel peak look like a four-pixel peak.
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
  const band = labelBandOf(paint, rowHeight)
  const boxHeight = Math.max(3, rowHeight - band - 2)
  const pointed = paint.arrows !== false
  ctx.save()
  ctx.globalAlpha = paint.opacity
  for (const [ink, placements] of groupByInk(layout, paint)) {
    ctx.fillStyle = ink
    ctx.beginPath()
    for (const placement of placements) {
      const top = placement.row * rowHeight + (rowHeight - band - boxHeight) / 2
      segmentPath(
        ctx,
        frame,
        placement.along0,
        placement.along1,
        top,
        boxHeight,
        pointed ? set.strand[placement.index] : 0,
      )
    }
    ctx.fill()
  }

  if (!layout.dense) {
    // Chevrons *inside* a long box, in the halo colour, so a segment that runs
    // across the whole window says which way it goes at every point rather than
    // only at the end the head is on. Only on the long ones: on a box a few
    // times the height of its own row the head is the whole of the answer, and
    // a tick through it is noise over a fact already stated.
    if (pointed) {
      drawStrandMarks(ctx, frame, set, layout, paint, rowHeight, band, {
        least: SEGMENT_MARK_MIN,
        reach: boxHeight * 0.3,
      })
    }
    if (paint.labels) labelFeatures(ctx, frame, set, layout, paint, rowHeight)
  }
  ctx.restore()
}

/**
 * Everything {@link layoutFeatures} needs that depends on what the lane *is*.
 *
 * One function rather than three conditionals repeated on each surface, and the
 * reason is the reason `annotations/types.ts` gives for its kind predicates: the
 * map lanes and the 1D browser lay out the same file with the same code, and
 * every per-kind number spelled at both is a chance for them to drift into two
 * pictures of one lane. It was already two — the row height and the variant
 * floor — and a barChart adds a third and a fourth.
 *
 * `scale` is the app's font scaling, passed in rather than imported because
 * this module is free of the DOM and of the settings that decide it.
 */
export function featureLayoutFor(
  kind: AnnotationKind,
  thickness: number,
  scale: (length: number) => number,
): { rows: number; least: number; banded: boolean } {
  // Taller rows than a bare glyph needs, because each one carries a name under
  // its features; `labelBandOf` refuses the band on a row too short for both,
  // so a lane dragged down to sixteen pixels still falls back to names inside
  // the wide features.
  const fit = rowsThatFit(thickness, scale(kind === 'gtf' ? 26 : 22))
  return {
    // A chart's rows divide its value axis, so how many of them fit is a
    // question about the *measurement* and not about the label under it.
    rows: kind === 'barchart' ? barChartRows(thickness, fit) : fit,
    // A single base is a hairline at every zoom a chromosome is browsed at
    // (§8.14).
    least: kind === 'variants' ? scale(VARIANT_MIN_WIDTH) : 0,
    banded: kind !== 'barchart',
  }
}

/**
 * The renderer a feature lane of this kind is drawn by.
 *
 * The same one-place argument {@link featureLayoutFor} makes, for the half of
 * the decision that follows the layout: a two-armed `if` at two call sites is
 * how a third arm reaches one surface and not the other, and the way that fails
 * is a lane that draws charts beside the map and boxes in the browser.
 */
export function drawFeatures(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  kind: AnnotationKind,
): void {
  if (kind === 'gtf') drawGenes(ctx, frame, set, layout, paint)
  else if (kind === 'barchart') drawBarCharts(ctx, frame, set, layout, paint)
  else drawSegments(ctx, frame, set, layout, paint)
}

/**
 * A barChart: one chart per feature, drawn inside the bases the feature covers
 * (§8.17).
 *
 * The third renderer over {@link layoutFeatures}' layout, and it is a third one
 * rather than a flag on {@link drawSegments} because nothing in it is a box:
 * where that function asks *what colour is this feature and which way does it
 * point*, this asks *what are its values and is there room to show them*.
 *
 * ## The two pictures, and the line between them
 *
 * With room, a feature is `expCount` bars standing on a common baseline, each
 * the height of its own value against the file's ceiling. Without it, it is one
 * box in the colour of the category that dominates the row and the height of
 * that category's value — so the glyph gives up *which categories* long before
 * it gives up *which one* and *how much*, and a lane zoomed out to a chromosome
 * still reads as a map of where each tissue wins.
 *
 * The line is {@link BAR_MIN_WIDTH} per category and no fudge factor, because
 * under a pixel a bar is not thin, it is gone: the canvas rounds it away or
 * blends it into its neighbour, and a chart quietly missing half its categories
 * is a different chart drawn with the same confidence.
 *
 * ## Why the bars are painted by category rather than by feature
 *
 * One path per *category*, filled once — so a lane of four hundred glyphs over
 * fifty-four tissues is fifty-four fills rather than twenty-one thousand. The
 * same argument {@link groupByInk} makes for boxes, and it matters more here
 * because the number of pieces is the product of two counts rather than one.
 *
 * ## What is deliberately not drawn
 *
 * An axis. A chart sixteen pixels tall has no room for one, there are as many
 * of them on the lane as there are features, and the ceiling is the same number
 * for every one of them — so it is stated once, under the lane's label and in
 * the card, where it can be read (§8.17). What *is* drawn is the baseline, once
 * per glyph, because without it a row of short bars and a row of tall bars
 * hanging from above are the same picture.
 */
export function drawBarCharts(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
): void {
  const bars = set.bars
  // A file that reached this lane with no categories on it — every row
  // disagreeing about `expCount`, or a stored session restored against a set
  // that was re-read as a BED. Boxes are the honest picture of it and are
  // already written; drawing an empty chart would be an assertion that the
  // values are all zero.
  if (bars === undefined) {
    drawSegments(ctx, frame, set, layout, paint)
    return
  }
  if (layout.dense) {
    drawDensity(ctx, frame, layout, paint)
    return
  }
  const rowHeight = frame.thickness / layout.rows
  const band = labelBandOf(paint, rowHeight)
  const chartHeight = Math.max(3, rowHeight - band - 2)
  const width = bars.labels.length
  const colours = barColours(bars)
  const perFeature = paint.barScale === 'feature'
  // A file of zeroes would divide every bar by nothing. One is the ceiling that
  // draws all of them flat on the baseline, which is what that file says.
  const fileCeiling = bars.max > 0 ? bars.max : 1
  const inward = laneGrowsInward(frame.orientation)
  /** What this feature's bars are divided by — see {@link FeaturePaint.barScale}. */
  const ceilingOf = (index: number): number => {
    if (!perFeature) return fileCeiling
    const peak = peakOf(bars, index)
    return Number.isFinite(peak) && peak > 0 ? peak : fileCeiling
  }

  const charted: FeaturePlacement[] = []
  const collapsed: FeaturePlacement[] = []
  for (const placement of layout.placements) {
    const room = placement.along1 - placement.along0 >= width * BAR_MIN_WIDTH
    ;(room ? charted : collapsed).push(placement)
  }

  ctx.save()
  ctx.globalAlpha = paint.opacity

  // The baselines first, under everything, so a bar of zero still has a mark
  // saying the feature is there.
  ctx.fillStyle = paint.guideColour
  ctx.globalAlpha = paint.opacity * 0.45
  ctx.beginPath()
  for (const placement of layout.placements) {
    const base = baseOf(placement.row, rowHeight, band, chartHeight, inward)
    const [x, y, w, h] = laneRect(frame, placement.along0, placement.along1, base, base)
    ctx.rect(x, y, w, h)
  }
  ctx.fill()
  ctx.globalAlpha = paint.opacity

  for (let category = 0; category < width; category++) {
    ctx.fillStyle = colours[category]
    ctx.beginPath()
    let drawn = false
    for (const placement of charted) {
      const value = bars.values[placement.index * width + category]
      if (!Number.isFinite(value) || value <= 0) continue
      const span = placement.along1 - placement.along0
      const slot = span / width
      // The gap is dropped rather than shrinking the bars below the floor: two
      // bars touching are still two heights, where two bars half a pixel wide
      // are one smear.
      const thickness = slot - BAR_GAP >= BAR_MIN_WIDTH ? slot - BAR_GAP : slot
      const along0 = placement.along0 + category * slot
      const [across0, across1] = barAcross(
        placement.row,
        rowHeight,
        band,
        chartHeight,
        inward,
        value / ceilingOf(placement.index),
      )
      const [x, y, w, h] = laneRect(frame, along0, along0 + thickness, across0, across1)
      ctx.rect(x, y, w, h)
      drawn = true
    }
    if (drawn) ctx.fill()
  }

  // The collapsed glyphs, gathered under the category each is dominated by, so
  // the fills are bounded by the number of categories here too.
  const byCategory = new Map<number, FeaturePlacement[]>()
  for (const placement of collapsed) {
    const at = dominantOf(bars, placement.index)
    const held = byCategory.get(at)
    if (held === undefined) byCategory.set(at, [placement])
    else held.push(placement)
  }
  for (const [category, placements] of byCategory) {
    // No dominant category is no answer, and takes the lane's own colour —
    // never a category's, which would name one.
    ctx.fillStyle = category < 0 ? paint.colour : colours[category]
    ctx.beginPath()
    for (const placement of placements) {
      const value = peakOf(bars, placement.index)
      // A floor of a twelfth, so a feature whose tallest category is near zero
      // is still a mark rather than a gap in the lane. Against the *file's*
      // ceiling whatever the switch says, because per feature this is the
      // feature's own peak divided by itself — every collapsed glyph full
      // height, which is a lane saying nothing.
      const height = Number.isFinite(value) ? Math.max(value / fileCeiling, 1 / 12) : 1
      const [across0, across1] = barAcross(
        placement.row,
        rowHeight,
        band,
        chartHeight,
        inward,
        height,
      )
      const [x, y, w, h] = laneRect(frame, placement.along0, placement.along1, across0, across1)
      ctx.rect(x, y, w, h)
    }
    ctx.fill()
  }

  if (paint.labels) labelFeatures(ctx, frame, set, layout, paint, rowHeight)
  ctx.restore()
}

/**
 * Where one row's charts stand, in lane across-coordinates.
 *
 * The baseline follows {@link laneGrowsInward}, which is the one place this
 * application decides which way a value grows: up the page on a horizontal lane
 * and right across a vertical one, whichever edge of the map the lane is on. So
 * a barChart on a bottom stack stands on its outer edge and grows towards the
 * matrix, and the one on the top stack stands on its inner edge and grows away
 * — which is what every profile lane beside them already does.
 */
function baseOf(
  row: number,
  rowHeight: number,
  band: number,
  chartHeight: number,
  inward: boolean,
): number {
  const top = row * rowHeight + (rowHeight - band - chartHeight) / 2
  return inward ? top + chartHeight : top
}

/** The across-span of one bar at `height` of the chart, as a `[from, to]` pair. */
function barAcross(
  row: number,
  rowHeight: number,
  band: number,
  chartHeight: number,
  inward: boolean,
  height: number,
): [number, number] {
  const clamped = height < 0 ? 0 : height > 1 ? 1 : height
  const base = baseOf(row, rowHeight, band, chartHeight, inward)
  return inward ? [base - clamped * chartHeight, base] : [base, base + clamped * chartHeight]
}

/**
 * The narrowest a feature can be and still be worth pointing, in pixels.
 *
 * A head is cut out of the box, so on a narrow one it eats the part that says
 * *where*: at four pixels a pentagon and a rectangle are the same three pixels
 * of ink with a different corner, and the reader has lost a pixel of extent to
 * learn nothing. Six is where a head reads as a head.
 */
export const ARROW_MIN_WIDTH = 6

/** …and the shortest head worth cutting, once the two caps below are applied. */
const ARROW_MIN_HEAD = 2

/** Chevrons along each spine, every {@link STRAND_MARK_GAP} pixels. */
const STRAND_MARK_GAP = 26

/**
 * How long a segment must be before chevrons are drawn through it.
 *
 * Four gaps, so the first box to get them holds three of them and reads as a
 * run rather than as a box with one mark in it.
 */
const SEGMENT_MARK_MIN = STRAND_MARK_GAP * 4

/**
 * One feature's outline: a rectangle, or a rectangle with a point on it.
 *
 * Through `laneRect` in the flat case and through `laneMove`/`laneLine` in the
 * pointed one, so a right-hand lane's quarter turn stays `render/lane.ts`'s
 * business in both (§8.8). The head is capped twice — by the glyph's own height,
 * so it is a point rather than a spear, and by a third of the feature's width,
 * so a short feature keeps most of its body.
 */
function segmentPath(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  along1: number,
  top: number,
  height: number,
  strand: number,
): void {
  const width = along1 - along0
  const head = strand === 0 ? 0 : Math.min(height * 0.55, width * 0.35)
  if (head < ARROW_MIN_HEAD || width < ARROW_MIN_WIDTH) {
    const [x, y, boxWidth, boxHeight] = laneRect(frame, along0, along1, top, top + height)
    ctx.rect(x, y, boxWidth, boxHeight)
    return
  }
  // `+1` is further along the axis, which on a right-hand lane is downward —
  // the same reading the chevrons make, so the two agree on every edge.
  const tip = strand > 0 ? along1 : along0
  const neck = strand > 0 ? along1 - head : along0 + head
  const tail = strand > 0 ? along0 : along1
  laneMove(ctx, frame, tail, top)
  laneLine(ctx, frame, neck, top)
  laneLine(ctx, frame, tip, top + height / 2)
  laneLine(ctx, frame, neck, top + height)
  laneLine(ctx, frame, tail, top + height)
  ctx.closePath()
}

/**
 * The placements, gathered under the ink each is drawn in.
 *
 * Grouped by ink rather than one fill per feature: a lane of ten thousand boxes
 * in one colour is one path, and a lane coloured by a twelve-category column is
 * twelve — which is the difference between twelve state changes and ten
 * thousand of them. The common case, no `colourOf`, is the single group it
 * always was.
 *
 * It does reorder the painting, and where two features in one row overlap the
 * one on top is now the one whose *ink* was laid down last rather than the one
 * later in the set — so it can differ from the feature `featureAt` names. That
 * happens only where the packing had to overlap two features in one row, where
 * the hit test's answer is a real record at the place that was clicked either
 * way, and the card names which.
 */
function groupByInk(
  layout: FeatureLayout,
  paint: FeaturePaint,
): Map<string, FeaturePlacement[]> {
  const byInk = new Map<string, FeaturePlacement[]>()
  for (const placement of layout.placements) {
    const ink = paint.colourOf === undefined ? paint.colour : paint.colourOf(placement.index)
    const held = byInk.get(ink)
    if (held === undefined) byInk.set(ink, [placement])
    else held.push(placement)
  }
  return byInk
}

/**
 * How much of each row is given to a name written under the feature.
 *
 * Zero unless names go below *and* the row is tall enough to hold both — a row
 * that gave half of eleven pixels to text would have three left for the gene,
 * which is a line rather than a glyph.
 */
export function labelBandOf(paint: FeaturePaint, rowHeight: number): number {
  const band = paint.labelBand ?? LABEL_BAND
  // Room for the band *and* a glyph above it, in the band's own units — a row
  // that gave half of its height to text would have a line left for the gene.
  return paint.labelsBelow === true && paint.labels && rowHeight >= band + 9 ? band : 0
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
  const band = labelBandOf(paint, rowHeight)
  // The glyph is centred in what is left of the row once the name has its band,
  // rather than in the row: centring in the row and then writing under it puts
  // the name over the next gene down.
  const glyph = rowHeight - band
  const exonHeight = Math.max(3, Math.min(9, glyph * 0.5))
  const cdsHeight = Math.max(exonHeight + 2, Math.min(13, glyph * 0.78))

  const pointed = paint.arrows !== false
  ctx.save()
  ctx.globalAlpha = paint.opacity

  // One group of placements per ink, and all three passes inside it: a gene's
  // spine, its exons and its coding part are one glyph and must come out in one
  // colour, whatever column the reader is colouring by (§8.16). A lane with no
  // `colourOf` is the single group it always was.
  for (const [ink, placements] of groupByInk(layout, paint)) {
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    ctx.lineWidth = 1

    // The spines first, in one path: a gene with no exon table is a bare box,
    // and one with exons is a line the boxes sit on.
    ctx.beginPath()
    for (const placement of placements) {
      if (set.exonAt[placement.index + 1] === set.exonAt[placement.index]) continue
      const centre = placement.row * rowHeight + glyph / 2
      const [x, y, width, height] = laneRect(
        frame,
        placement.along0,
        placement.along1,
        centre - 0.5,
        centre + 0.5,
      )
      ctx.rect(x, y, width, height)
    }
    ctx.fill()

    // Exons, then the coding part of each exon over them.
    for (const pass of [0, 1] as const) {
      const height = pass === 0 ? exonHeight : cdsHeight
      ctx.beginPath()
      for (const placement of placements) {
        const index = placement.index
        const cdsFrom = set.cdsStart[index]
        const cdsTo = set.cdsEnd[index]
        if (pass === 1 && !(cdsTo > cdsFrom)) continue
        const centre = placement.row * rowHeight + glyph / 2
        const top = centre - height / 2
        const first = set.exonAt[index]
        const last = set.exonAt[index + 1]

        if (first === last) {
          // No sub-structure: the feature is its own single block, and only on
          // the first pass — there is no coding span to thicken. It is pointed
          // like a segment, because a box is all this gene has and the chevrons
          // below ride a spine it does not own.
          if (pass === 0) {
            segmentPath(
              ctx,
              frame,
              placement.along0,
              placement.along1,
              top,
              height,
              pointed ? set.strand[index] : 0,
            )
          }
          continue
        }

        const scale =
          (placement.along1 - placement.along0) / Math.max(1, set.end[index] - set.start[index])
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
  }

  if (!layout.dense) {
    if (pointed) drawStrandMarks(ctx, frame, set, layout, paint, rowHeight, band)
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

/**
 * Where the chevrons go, for the caller that is not a gene model.
 *
 * A gene's chevrons ride a spine that is thinner than the glyph around it, so
 * they may be as tall as the row allows and they start on the first gene long
 * enough to hold one. A segment's ride *inside* a filled box: they must fit the
 * box's own height, and they are worth drawing only on a box long enough that
 * the head on its end has stopped being the whole answer.
 */
interface MarkOptions {
  /** The narrowest feature that gets any. */
  least: number
  /** How far a chevron reaches from the centre line, before the row's own cap. */
  reach: number
}

function drawStrandMarks(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  rowHeight: number,
  band = 0,
  options?: MarkOptions,
): void {
  ctx.save()
  ctx.strokeStyle = paint.haloColour
  ctx.lineWidth = 1
  ctx.globalAlpha = paint.opacity * 0.9
  ctx.beginPath()
  const reach = Math.max(
    2,
    Math.min(3.5, rowHeight * 0.2, options?.reach ?? Number.POSITIVE_INFINITY),
  )
  const least = Math.max(STRAND_MARK_GAP, options?.least ?? 0)
  for (const placement of layout.placements) {
    const strand = set.strand[placement.index]
    if (strand === 0) continue
    const width = placement.along1 - placement.along0
    if (width < least) continue
    // The chevrons ride the spine, so they follow it above the name's band.
    const centre = placement.row * rowHeight + (rowHeight - band) / 2
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

/** One segment of a strand chevron, in lane coordinates. */
function line(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  across0: number,
  along1: number,
  across1: number,
): void {
  laneMove(ctx, frame, along0, across0)
  laneLine(ctx, frame, along1, across1)
}

/**
 * Names: inside the feature beside a map, under it in a browser.
 *
 * Two placements because the two callers have two different amounts of room. A
 * lane 46 pixels thick under a contact map has no *under*, so a name goes
 * inside and only onto the features wide enough to hold one. A browser lane has
 * a band to itself, so the name goes below and may run past a feature far
 * narrower than it — which is what makes a gene track legible at the zoom where
 * the genes, rather than their density, are the point.
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
  const band = labelBandOf(paint, rowHeight)
  ctx.save()
  ctx.font = paint.font
  ctx.fillStyle = paint.guideColour
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Where a name below is allowed to run past its own feature: a gene 4 px wide
  // still has a name, and a browser that only labelled the wide ones would go
  // blank at exactly the zoom where the names are the point. Bounded by the
  // last name written *in the same row*, so two of them never overlap — which
  // is the only thing that makes an overhanging label readable at all.
  const lastRight = new Float64Array(layout.rows).fill(Number.NEGATIVE_INFINITY)
  for (const placement of layout.placements) {
    const name = set.name[placement.index]
    if (name === '') continue
    const width = placement.along1 - placement.along0
    const text = ctx.measureText(name).width
    const middle = (placement.along0 + placement.along1) / 2

    if (band === 0) {
      // Inside the feature: only where it genuinely fits, because a name that
      // overflows its box is a name attached to whatever is next to it.
      if (width < 18 || text + 6 > width) continue
      laneText(ctx, frame, name, middle, placement.row * rowHeight + rowHeight / 2, {
        halo: paint.haloColour,
      })
      continue
    }

    const from = middle - text / 2
    if (from < lastRight[placement.row] + 4) continue
    lastRight[placement.row] = middle + text / 2
    laneText(ctx, frame, name, middle, placement.row * rowHeight + rowHeight - band / 2 - 1, {
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
  // The exact inverse of what `laneRect` did when the boxes were drawn — through
  // the same module, so the two cannot answer differently about an edge where
  // `across` runs backwards against the canvas.
  const along = laneIsHorizontal(frame.orientation) ? x : y
  const across = canvasToAcross(frame, laneIsHorizontal(frame.orientation) ? y : x)
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
