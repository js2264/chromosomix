/**
 * Segments and gene models: the lanes that draw *things on the sequence* rather
 * than a value over it.
 *
 * One renderer over one layout: `drawModels` draws a segment and a gene model
 * alike, each by its own structure rather than by the lane's kind (§8.16), and
 * the hard part is the layout they share. Features overlap, and a lane 16
 * pixels thick has room for two rows of them, so the layout is a greedy row
 * packing — the same thing every genome browser does, and for the same reason:
 * a peak drawn on top of another peak is one peak.
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
import { strandBands, type BarScale, type FeatureDisplay } from '../annotations/fields'
import type { AnnotationKind, AnnotationPayload, FeatureSet } from '../annotations/types'
import { junctionCeiling } from '../annotations/junctions'
import {
  BAR_GAP,
  BAR_MIN_WIDTH,
  barChartCaption,
  barExtentOf,
  barChartRows,
  barColours,
  dominantOf,
  peakOf,
} from './barchart'
import { drawIdeogram, ideogramCaption } from './ideogram'
import { drawJunctions, junctionAt, junctionCaption, junctionLimits, type JunctionArc } from './junctions'
import { cutMiddle } from './laneLabel'
import { VARIANT_MIN_WIDTH } from './variants'

/**
 * How far past its own feature a name below may run: this many times its width,
 * or {@link OVERHANG_PX}, whichever is more.
 *
 * Four, because a gene four pixels wide has a name worth ten times that and is
 * exactly the case the overhang exists for, while a name a dozen times wider
 * than its peak is a label for the peaks either side of it.
 */
const OVERHANG_TIMES = 4

/**
 * The overhang a name gets whatever its feature's width, in pixels.
 *
 * Enough for a short gene symbol — `YDR001C` — so the bound never costs the
 * zoom where individual genes are the point, which is the zoom the below-the-
 * feature placement was built for.
 */
const OVERHANG_PX = 80
import {
  canvasToAcross,
  laneGrowsInward,
  laneCurve,
  laneIsHorizontal,
  laneLine,
  laneMove,
  laneRect,
  laneText,
  OUTLINE_WIDTH,
  valueAcross,
  type LaneFrame,
} from './lane'
import { stretchOf, strandOf, unitAt, type LocusAxis } from './locus'

/** Where one feature ended up. `along` is in canvas pixels. */
export interface FeaturePlacement {
  /** Index into the {@link FeatureSet}. */
  index: number
  along0: number
  along1: number
  row: number
  /**
   * Placed on a stretch read backwards — a reversed piece of an edited
   * sequence (§27.2): its blocks run the other way along the axis, and the
   * strand it is drawn with is its own turned round ({@link placedStrand}).
   */
  reversed?: boolean
}

/**
 * The strand a placed feature has **on the axis**: its own, turned round where
 * the stretch it is placed on is read backwards. What the arrow points by, the
 * band it is packed in and the colour a strand key gives it.
 */
export function placedStrand(set: FeatureSet, placement: FeaturePlacement): number {
  const own = sign(set.strand[placement.index])
  return placement.reversed === true ? -own : own
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
  /**
   * The arcs a junction lane drew, where one did (§8.23).
   *
   * Written by the renderer rather than the layout, because an arc's height is
   * a fact about the paint — the lane's limits — and not about the packing. Kept
   * here because the layout is what both surfaces hold on to for the hit test,
   * so {@link featureAt} can answer with the curve under the pointer rather
   * than with the box of an intron that nests three others.
   */
  arcs?: JunctionArc[]
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
    // The piece this stretch is, on an edited axis: a feature across a cut is
    // drawn to the cut and no further, since the rest of it is somewhere else
    // on the axis — or, set aside, nowhere (§27.2). The whole contig otherwise.
    const [lowBp, highBp] = stretchOf(segment)
    const reversed = strandOf(segment) === -1
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
      const u0 = unitAt(segment, Math.max(set.start[i], lowBp))
      const u1 = unitAt(segment, Math.min(set.end[i], highBp))
      const along0 = frame.toPixel(u0)
      const along1 = frame.toPixel(u1)
      placements.push({
        index: i,
        along0: Math.min(along0, along1),
        along1: Math.max(along0, along1),
        row: 0,
        ...(reversed ? { reversed: true } : {}),
      })
    }
  }

  // More features than the lane can draw apart: no packing exists that separates
  // them, so say so and draw one row. The count is kept, because "17,400
  // features here" is the information the picture can still carry.
  //
  // The width one feature needs is its drawn floor plus the gap that makes two
  // read as two — which for everything but a variant lane is the two pixels it
  // has always been.
  //
  // **Asked of the fullest row the lane will use, not of the whole lane.** The
  // test used to be `span / 2` over every feature in the window, whatever the
  // lane was about to do with them — so a stranded gene set, which this lane
  // spreads over a band per strand, was measured as though all of it went in
  // one row. The same 230 yeast genes over the same window then drew as named
  // boxes on a 680-pixel lane and as a solid grey density block on a
  // 455-pixel one, because 230 falls either side of `span / 2` across that
  // range: opening a side panel made the gene track appear to have been lost
  // (§8.14, §8.16).
  //
  // Not `maxRows` either, which is the room the lane *has* rather than the rows
  // it will fill: the packing moves a feature to a second row only when it
  // **overlaps** one already there, so four rows do nothing for four hundred
  // peaks that merely sit two to a pixel — they all land in row zero and merge
  // into a bar, which is the case this rule exists for.
  //
  // The bands are a fact about the file (`strandBands`), so this answer does not
  // move as a reader narrows a column, which is the whole complaint.
  const bands = banded ? strandBands(set) : [0]
  const spread = bands.length > 1 && frame.thickness / bands.length >= MIN_BAND_ROW ? bands : [0]
  const needed = Math.max(2, leastWidth + ROW_GAP)
  const fullest =
    spread.length === 1
      ? placements.length
      : Math.max(
          ...spread.map(
            (strand) =>
              placements.filter((placement) => placedStrand(set, placement) === strand).length,
          ),
        )
  const dense = fullest > span / needed

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
  if (spread.length > 1) {
    const rows = Math.max(maxRows, bands.length)
    const shares = shareRows(rows, bands.length)
    let offset = 0
    for (let band = 0; band < bands.length; band++) {
      packRows(
        placements.filter((placement) => placedStrand(set, placement) === bands[band]),
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
 * A three-pixel glyph — the floor {@link glyphSizes} keeps for a block — plus the gap
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
   * Edge each block in {@link guideColour}, the plot's ink: the `outline`
   * preference, which is the rule along the top of a coverage track (§8.16).
   *
   * Required rather than defaulted, as it is on a track's paint, so that a new
   * surface has to decide — one that forgot would draw its boxes unedged under
   * tracks that are outlined, and one picture would say two things.
   */
  outline: boolean
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
  colourOf?: (index: number, reversed?: boolean) => string
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
   * How the rows are spent (`FeatureStyle.display`), which decides how thick a
   * glyph is drawn in the row it is given. `expanded` when absent.
   */
  display?: FeatureDisplay
  /**
   * What a barChart's bars are measured against (§8.17).
   *
   * Absent is `file` — one ceiling for every chart on the lane, which is the
   * only setting under which two glyphs can be compared. `FeatureStyle.bars` in
   * `annotations/fields.ts` says why the other reading exists.
   */
  barScale?: BarScale
  /**
   * A value axis the reader has fixed, which overrides {@link barScale}.
   *
   * Absent is the file's own ceiling — the two readings §8.17 describes, both
   * relative. Present, a bar's height is where its value falls between these two
   * numbers, which is the only reading under which the same chart in two files
   * draws the same way. See `render/barchart.ts`'s `barLimitsOf`.
   *
   * A junction lane reads it the same way (§8.23): an arc's height is its count
   * between these two, and one under the floor is not drawn. It was called
   * `barLimits` while a barChart was the only glyph with an axis.
   */
  axisLimits?: { min: number; max: number }
}

/** Height a below-the-feature name needs, in canvas pixels. */
export const LABEL_BAND = 11

/**
 * Every feature lane but a barChart: a glyph per feature, drawn by the feature's
 * **own** structure rather than by the lane's kind (§8.16).
 *
 * A feature with no parts — a peak, a plain BED row, a variant — is one block.
 * One with exons is a transcript: its exons are blocks on a hairline that
 * stands for the introns between them, the coding span is drawn thick and the
 * untranslated ends and every exon of a non-coding transcript thin, and one with
 * a coding span and no exon table is a single exon split the same way. It used
 * to be the kind that decided, which is how a BED12 or a bigBed of transcripts —
 * a `segments` lane — came out as one plain box per gene: the exons and the
 * coding span were read, carried and never drawn.
 *
 * **A stranded feature ends in a point**, on the block where it ends — the
 * last exon in the direction it is transcribed — cut *out of* the block rather
 * than drawn past it, so the glyph occupies exactly the bases the feature does
 * and the box drawn, the box clicked and the box the packing kept a row clear
 * for are one span (§8.4). No chevrons inside it: they were a second way of
 * saying the same thing, laid over the one thing the glyph exists to show.
 *
 * Blocks have their corners rounded a little, and they take most of their row:
 * a lane made taller draws its features thicker, up to {@link MAX_THICK}. With
 * the outline on, each is edged in the plot's ink — the hairline along the top of
 * a coverage track — down to {@link OUTLINE_MIN}.
 * Variants stay square — a mark on a base is a mark, not a box to be shaped —
 * and so does anything too narrow for a corner to be a corner.
 */
function drawModels(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  round: boolean,
): void {
  if (layout.dense) {
    drawDensity(ctx, frame, layout, paint)
    return
  }
  const rowHeight = frame.thickness / layout.rows
  const band = labelBandOf(paint, rowHeight)
  // The glyph is centred in what is left of the row once the name has its band,
  // rather than in the row: centring in the row and then writing under it puts
  // the name over the next feature down.
  const room = rowHeight - band
  const sizes = glyphSizes(room, paint.display ?? 'expanded')
  const pointed = paint.arrows !== false
  ctx.save()
  ctx.globalAlpha = paint.opacity
  // One group of placements per ink, and both passes inside it: a transcript's
  // introns and its exons are one glyph and must come out in one colour,
  // whatever column the reader is colouring by (§8.16).
  for (const [ink, placements] of groupByInk(layout, paint)) {
    ctx.fillStyle = ink
    // The introns first, so the blocks sit on them.
    ctx.beginPath()
    for (const placement of placements) {
      const centre = placement.row * rowHeight + room / 2
      intronPath(ctx, frame, set, placement, centre, sizes.line)
    }
    ctx.fill()
    // The blocks that are edged, five numbers each, kept from the fill rather
    // than walked again: the rule is then exactly the boundary of the ink under it.
    const edged: number[] = []
    ctx.beginPath()
    for (const placement of placements) {
      const centre = placement.row * rowHeight + room / 2
      forEachBlock(set, placement, (along0, along1, coding, point) => {
        const height = coding ? sizes.thick : sizes.thin
        const top = centre - height / 2
        const tip = pointed ? point : 0
        blockPath(ctx, frame, along0, along1, top, height, tip, round)
        if (paint.outline && Math.abs(along1 - along0) >= OUTLINE_MIN && height >= OUTLINE_MIN) {
          edged.push(along0, along1, top, height, tip)
        }
      })
    }
    ctx.fill()
    if (edged.length > 0) {
      ctx.beginPath()
      for (let i = 0; i < edged.length; i += 5) {
        blockPath(ctx, frame, edged[i], edged[i + 1], edged[i + 2], edged[i + 3], edged[i + 4], round)
      }
      ctx.strokeStyle = paint.guideColour
      ctx.lineWidth = OUTLINE_WIDTH
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
  }
  if (paint.labels) labelFeatures(ctx, frame, set, layout, paint, rowHeight)
  ctx.restore()
}

/**
 * How tall a feature's parts are drawn, given the room its row leaves for them.
 *
 * `thick` is a plain block and a coding span; `thin` an untranslated end and a
 * non-coding exon, about three fifths of it, which is the ratio at which the two
 * read as two weights of one shape rather than as two shapes; `line` the intron.
 * Expanded and collapsed rows give the glyph all but a pixel either side of it,
 * up to {@link MAX_THICK}: the cap is what keeps a lane dragged to two hundred
 * pixels from drawing its genes as slabs, and it sits well above the nine and
 * thirteen pixels a gene used to stop at whatever the lane was given. Squished
 * rows are thin by design, and their glyphs are capped low for the same reason.
 */
export function glyphSizes(
  room: number,
  display: FeatureDisplay,
): { thick: number; thin: number; line: number } {
  if (display === 'squished') {
    const thick = clamp(room * 0.7, 2, SQUISHED_THICK)
    return { thick, thin: Math.max(1.5, thick * 0.6), line: 1 }
  }
  const thick = clamp(room - 2, 3, MAX_THICK)
  return { thick, thin: Math.max(2, thick * 0.6), line: thick >= 16 ? 1.5 : 1 }
}

/** The tallest a block is drawn, in pixels, however much room its row has. */
export const MAX_THICK = 22

/** …and the tallest in a squished row. */
const SQUISHED_THICK = 7

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
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
  display: FeatureDisplay = 'expanded',
): { rows: number; least: number; banded: boolean } {
  // A single base is a hairline at every zoom a chromosome is browsed at
  // (§8.14).
  const least = kind === 'variants' ? scale(VARIANT_MIN_WIDTH) : 0
  // One row, never banded, whatever the display mode says. A karyotype's bands
  // tile one shape (§8.22) and a junction's arc has its strand in which way it
  // grows (§8.23): rows would cut the one and halve the other.
  if (kind === 'ideogram' || kind === 'junctions') return { rows: 1, least, banded: false }
  if (kind === 'barchart') {
    // A chart's rows divide its value axis, so how many of them fit is a
    // question about the *measurement* and not about the label under it — and
    // no display mode reaches it (§8.17).
    return { rows: barChartRows(thickness, rowsThatFit(thickness, scale(22))), least, banded: false }
  }
  // One row across the whole lane, strands and all: the point and the colour
  // say which way each feature runs, and banding would halve the one row.
  if (display === 'collapsed') return { rows: 1, least, banded: false }
  if (display === 'squished') {
    return {
      rows: Math.max(1, Math.min(MAX_SQUISHED_ROWS, Math.floor(thickness / SQUISHED_ROW))),
      least,
      banded: true,
    }
  }
  // Taller rows than a bare glyph needs, because each one carries a name under
  // its features; `labelBandOf` refuses the band on a row too short for both,
  // so a lane dragged down to sixteen pixels still falls back to names inside
  // the wide features.
  return { rows: rowsThatFit(thickness, scale(kind === 'gtf' ? 26 : 22)), least, banded: true }
}

/** A squished row, in pixels: a thin glyph and the gap under it, and no name. */
const SQUISHED_ROW = 8

/** …and how many of them a lane may hold, which is well past {@link MAX_ROWS}. */
const MAX_SQUISHED_ROWS = 32

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
  if (kind === 'barchart') drawBarCharts(ctx, frame, set, layout, paint)
  else if (kind === 'ideogram') drawIdeogram(ctx, frame, set, layout, paint)
  else if (kind === 'junctions') drawJunctions(ctx, frame, set, layout, paint)
  else drawModels(ctx, frame, set, layout, paint, kind !== 'variants')
}

/**
 * The value axis a feature lane's glyphs stand on before a reader moves it, or
 * `null` for a kind whose glyphs have none.
 *
 * Zero to a barChart's tallest bar (§8.17) and zero to a junction lane's
 * largest count (§8.23): what each draws against under `auto`, and so where a
 * ceiling drag, a ⌘-scroll and the typed field all start from. One function
 * for both, because the three gestures ask it on two surfaces and a kind
 * answered at some of those six places and not the others is a lane whose
 * ceiling moves by one gesture and not by another.
 */
export function glyphExtentOf(
  kind: AnnotationKind,
  set: FeatureSet | undefined,
  /**
   * What the lane last drew, where the caller has it: a junction lane's `auto`
   * is fitted to the junctions in view (`render/junctions.ts`), so a gesture
   * that starts from the axis on screen starts from that — and from the file's
   * largest count where nothing has been drawn yet.
   */
  layout?: FeatureLayout,
): { min: number; max: number } | null {
  if (set === undefined) return null
  if (kind === 'barchart') return barExtentOf(set.bars)
  if (kind === 'junctions') {
    if (layout !== undefined && layout.placements.length > 0) return junctionLimits(set, undefined, layout)
    const top = junctionCeiling(set)
    return top > 0 ? { min: 0, max: top } : null
  }
  return null
}

/** {@link glyphExtentOf} for a row, whose set may not have arrived yet. */
export function glyphExtentOfRow(
  row: { kind: AnnotationKind; payload?: AnnotationPayload },
  layout?: FeatureLayout,
): { min: number; max: number } | null {
  return glyphExtentOf(row.kind, row.payload?.kind === 'features' ? row.payload.data : undefined, layout)
}

/**
 * The line under a feature lane's name, or `null` for none (§8.16, §8.17,
 * §8.22, §8.23).
 *
 * One function for both surfaces, for {@link featureLayoutFor}'s reason: the
 * map's lanes and the 1D browser wrote the same two branches, and a kind added
 * to one of them and not the other is a lane with two captions.
 */
export function featureCaption(
  kind: AnnotationKind,
  set: FeatureSet,
  layout: FeatureLayout,
  barScale: BarScale,
  axisLimits: { min: number; max: number } | undefined,
  int: (value: number) => string,
  num: (value: number) => string,
): string | null {
  // Bands tile rather than overlap, so a genome's worth of them is still the
  // karyotype: the caption names the ones under the window whatever the count.
  if (kind === 'ideogram') return ideogramCaption(set, layout)
  // …and arcs are drawn at every zoom, the strongest when there are too many.
  if (kind === 'junctions') return junctionCaption(set, layout, axisLimits, int)
  if (layout.dense) return `${int(layout.total)} ${kind === 'variants' ? 'variants' : 'features'} in view`
  // What the top of a bar means, which is the one thing a chart without an
  // axis cannot say for itself (§8.17).
  return set.bars === undefined ? null : barChartCaption(set.bars, num, barScale, axisLimits)
}

/**
 * A barChart: one chart per feature, drawn inside the bases the feature covers
 * (§8.17).
 *
 * The second renderer over {@link layoutFeatures}' layout, and it is a second one
 * rather than a flag on {@link drawModels} because nothing in it is a box:
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
    drawModels(ctx, frame, set, layout, paint, true)
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
  const fixed = paint.axisLimits
  // A fixed axis is not a *ceiling*, it is two ends, so it cannot be folded into
  // the division below — and it overrides the per-feature reading rather than
  // composing with it: "each chart against its own top" and "every chart against
  // these two numbers" are contradictory answers to one question, and the one
  // the reader typed wins.
  const perFeature = fixed === undefined && paint.barScale === 'feature'
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
  /**
   * How tall a bar stands, as a fraction of the chart.
   *
   * Clamped at both ends under a fixed axis, which is what a fixed axis means: a
   * value above the ceiling draws full height rather than out of the lane and
   * into the one above it, and one below the floor draws nothing rather than
   * downwards through the baseline.
   */
  const heightOf = (value: number, index: number): number => {
    if (fixed === undefined) return value / ceilingOf(index)
    return Math.max(0, Math.min(1, (value - fixed.min) / (fixed.max - fixed.min)))
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
      if (!Number.isFinite(value)) continue
      // Nothing to draw is nothing drawn, and the test is the **height** rather
      // than the value: under the file's own ceiling those are the same question
      // (a positive value is a positive bar), and under a fixed axis they are
      // not — a value below the floor is a real number with no ink, and a
      // zero-height rectangle in the path is a bar the lane claims to have drawn.
      const height = heightOf(value, placement.index)
      if (!(height > 0)) continue
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
        height,
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
      // height, which is a lane saying nothing. A fixed axis is honoured here
      // too: it is the one reading that is about the numbers rather than about
      // the picture, so a collapsed row has to obey it or a lane zoomed out
      // would quietly change what its heights meant.
      const against =
        fixed === undefined
          ? value / fileCeiling
          : Math.max(0, Math.min(1, (value - fixed.min) / (fixed.max - fixed.min)))
      const height = Number.isFinite(value) ? Math.max(against, 1 / 12) : 1
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
 * The narrowest a block can be and still be worth pointing, in pixels.
 *
 * A head is cut out of the block, so on a narrow one it eats the part that says
 * *where*: at four pixels a pentagon and a rectangle are the same three pixels
 * of ink with a different corner, and the reader has lost a pixel of extent to
 * learn nothing. Six is where a head reads as a head.
 */
export const ARROW_MIN_WIDTH = 6

/** …and the shortest head worth cutting, once the two caps below are applied. */
const ARROW_MIN_HEAD = 2

/** The roundest a block's corner is, in pixels, however big the block. */
const MAX_RADIUS = 3

/**
 * The smallest block that is edged when the outline is on, in pixels along the
 * lane and across it.
 *
 * Under four a block is a tick, and a hairline round a tick is most of its ink:
 * the colour that says which strand or which class would be lost to the plot's
 * ink, on exactly the features too small to say it any other way.
 */
export const OUTLINE_MIN = 4

/**
 * Walk one placed feature's blocks, in axis order: where each one runs, whether
 * it is coding (drawn thick) or not, and which way it points, `0` for none.
 *
 * The point is on the block the feature *ends* in, in the direction it runs:
 * the last one for a forward feature and the first for a reverse one, since the
 * blocks come in axis order (`FeatureBuilder.finish` sorts a transcript's exons,
 * which a GTF lists 5′ to 3′ and so backwards on the minus strand).
 */
function forEachBlock(
  set: FeatureSet,
  placement: FeaturePlacement,
  visit: (along0: number, along1: number, coding: boolean, point: number) => void,
): void {
  const index = placement.index
  // The file's own strand picks *which* block is the tip, in base-pair order;
  // the placed one says which way along the axis it points — the other way on
  // a reversed piece, where the tip block is also mirrored to the other end.
  const strand = sign(set.strand[index])
  const pointing = placedStrand(set, placement)
  const first = set.exonAt[index]
  const last = set.exonAt[index + 1]
  const cdsFrom = set.cdsStart[index]
  const cdsTo = set.cdsEnd[index]
  const coding = cdsTo > cdsFrom
  if (first === last && !coding) {
    // No parts: the feature is its own single block, at the placement's own
    // extent — which carries a variant's floor, so the mark drawn is the mark
    // the pointer finds (§8.14).
    visit(placement.along0, placement.along1, true, pointing)
    return
  }
  const start = set.start[index]
  const scale = (placement.along1 - placement.along0) / Math.max(1, set.end[index] - start)
  const at = (bp: number): number =>
    placement.reversed === true
      ? placement.along1 - (bp - start) * scale
      : placement.along0 + (bp - start) * scale
  // Each exon, split where the coding span begins and ends: an exon can hold an
  // untranslated end, the coding span, or — in a gene of one exon — both ends
  // and the span between them.
  const parts: Array<[number, number, boolean]> = []
  const exons = first === last ? 1 : last - first
  for (let k = 0; k < exons; k++) {
    const from = first === last ? start : set.exonStart[first + k]
    const to = first === last ? set.end[index] : set.exonEnd[first + k]
    if (!coding) {
      parts.push([from, to, false])
      continue
    }
    if (from < cdsFrom) parts.push([from, Math.min(to, cdsFrom), false])
    const inFrom = Math.max(from, cdsFrom)
    const inTo = Math.min(to, cdsTo)
    if (inTo > inFrom) parts.push([inFrom, inTo, true])
    if (to > cdsTo) parts.push([Math.max(from, cdsTo), to, false])
  }
  const tip = strand > 0 ? parts.length - 1 : strand < 0 ? 0 : -1
  for (let i = 0; i < parts.length; i++) {
    const [from, to, isCoding] = parts[i]
    if (!(to > from)) continue
    const a = at(from)
    const b = at(to)
    visit(Math.min(a, b), Math.max(a, b), isCoding, i === tip ? pointing : 0)
  }
}

/**
 * The hairline a transcript's introns are, from the end of its first exon to
 * the start of its last — under the blocks, so only the gaps between them show.
 * Nothing for a feature of one block.
 */
function intronPath(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  placement: FeaturePlacement,
  centre: number,
  line: number,
): void {
  const index = placement.index
  const first = set.exonAt[index]
  const last = set.exonAt[index + 1]
  if (last - first < 2) return
  const start = set.start[index]
  const scale = (placement.along1 - placement.along0) / Math.max(1, set.end[index] - start)
  const at = (bp: number): number =>
    placement.reversed === true
      ? placement.along1 - (bp - start) * scale
      : placement.along0 + (bp - start) * scale
  const a = at(set.exonEnd[first])
  const b = at(set.exonStart[last - 1])
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  if (!(to > from)) return
  const [x, y, width, height] = laneRect(frame, from, to, centre - line / 2, centre + line / 2)
  ctx.rect(x, y, width, height)
}

/**
 * One block's outline: a box with its corners rounded, pointed at one end where
 * `point` says so — `+1` at the far end along the axis, `-1` at the near one.
 *
 * Through `laneMove`/`laneLine`/`laneCurve`, so a right-hand lane's quarter turn
 * stays `render/lane.ts`'s business (§8.8). The head is capped twice — by the
 * block's height, so it is a point rather than a spear, and by a third of its
 * width, so a short block keeps most of its body — and it is not cut at all
 * below {@link ARROW_MIN_WIDTH}. Every outline is traced the same way round,
 * whichever end is pointed, so blocks that overlap in one path add up rather
 * than cancel into a hole.
 */
function blockPath(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  along1: number,
  top: number,
  height: number,
  point: number,
  round: boolean,
): void {
  const width = along1 - along0
  const head = point === 0 ? 0 : Math.min(height * 0.55, width * 0.35)
  const pointed = point !== 0 && head >= ARROW_MIN_HEAD && width >= ARROW_MIN_WIDTH
  const corner = round ? Math.min(MAX_RADIUS, height * 0.22, (width - (pointed ? head : 0)) / 2) : 0
  // Under a pixel a corner is not a corner, and a one-pixel feature stays the
  // crisp rectangle `laneRect` floors it to.
  const r = corner >= 1 ? corner : 0
  if (!pointed && r === 0) {
    const [x, y, boxWidth, boxHeight] = laneRect(frame, along0, along1, top, top + height)
    ctx.rect(x, y, boxWidth, boxHeight)
    return
  }
  const bottom = top + height
  const middle = top + height / 2
  const near = pointed && point < 0 ? along0 + head : along0 + r
  const far = pointed && point > 0 ? along1 - head : along1 - r
  laneMove(ctx, frame, near, top)
  laneLine(ctx, frame, far, top)
  if (pointed && point > 0) {
    laneLine(ctx, frame, along1, middle)
    laneLine(ctx, frame, far, bottom)
  } else if (r > 0) {
    laneCurve(ctx, frame, along1, top, along1, top + r)
    laneLine(ctx, frame, along1, bottom - r)
    laneCurve(ctx, frame, along1, bottom, far, bottom)
  } else {
    laneLine(ctx, frame, along1, bottom)
  }
  laneLine(ctx, frame, near, bottom)
  if (pointed && point < 0) {
    laneLine(ctx, frame, along0, middle)
  } else if (r > 0) {
    laneCurve(ctx, frame, along0, bottom, along0, bottom - r)
    laneLine(ctx, frame, along0, top + r)
    laneCurve(ctx, frame, along0, top, near, top)
  } else {
    laneLine(ctx, frame, along0, top)
  }
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
    const ink =
      paint.colourOf === undefined ? paint.colour : paint.colourOf(placement.index, placement.reversed === true)
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
 * Names: inside the feature beside a map, under it in a browser.
 *
 * Two placements because the two callers have two different amounts of room. A
 * lane 46 pixels thick under a contact map has no *under*, so a name goes
 * inside and only onto the features wide enough to hold one. A browser lane has
 * a band to itself, so the name goes below and may run past a feature far
 * narrower than it — which is what makes a gene track legible at the zoom where
 * the genes, rather than their density, are the point.
 *
 * **Two bounds on that overhang, both of them corrections.**
 *
 * A name may be a few times wider than its feature and no more
 * ({@link OVERHANG_TIMES}, {@link OVERHANG_PX}). Unbounded, a 46-character MACS
 * name — its caller's run id plus a counter — was written under a peak three
 * pixels wide and spanned a dozen unlabelled neighbours, so one peak in twenty
 * carried a name and each name read as the label for the group it lay across.
 * Past the bound the name is cut in the middle rather than dropped, because
 * `LM331_…peak_1116` still says which set the peak is from and a reader who
 * wants the rest hovers it.
 *
 * And the text is kept **inside the lane**, which is where the false gene names
 * came from: a name centred on a feature at the edge of the window was cut by
 * the lane's own clip, so `MSW1` was drawn as `SW1`, `HEH2` as `HE` and `MUS81`
 * as `US81` — every one of them a plausible yeast symbol that a reader would
 * search for or cite. A browser must never print a gene name that is not in the
 * file (§8.16); the codebase's own rule for a group bar says the same thing
 * ("half a group's name is a different group's name"), and there the name is
 * dropped. Here it is nudged inward, which keeps it.
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
  // The lane's own ends, in reading order. A name may not be written past them:
  // whatever falls outside is cut by the clip, and a cut name is another name.
  const edgeLo = Math.min(frame.alongFrom, frame.alongTo) + 1
  const edgeHi = Math.max(frame.alongFrom, frame.alongTo) - 1
  for (const placement of layout.placements) {
    const name = set.name[placement.index]
    if (name === '') continue
    const width = placement.along1 - placement.along0
    const middle = (placement.along0 + placement.along1) / 2

    if (band === 0) {
      const text = ctx.measureText(name).width
      // Inside the feature: only where it genuinely fits, because a name that
      // overflows its box is a name attached to whatever is next to it — and
      // only where the box itself is whole, since a name centred in a box the
      // window cut in half is centred on a place the feature does not have.
      if (width < 18 || text + 6 > width) continue
      if (middle - text / 2 < edgeLo || middle + text / 2 > edgeHi) continue
      laneText(ctx, frame, name, middle, placement.row * rowHeight + rowHeight / 2, {
        halo: paint.haloColour,
      })
      continue
    }

    // As wide as the name, or as wide as the overhang allows — whichever is
    // smaller, and below a readable minimum nothing at all.
    const allowed = Math.max(width * OVERHANG_TIMES, OVERHANG_PX)
    const measure = (part: string): number => ctx.measureText(part).width
    const fitted = measure(name) <= allowed ? name : cutMiddle(measure, name, allowed)
    const text = measure(fitted)
    if (text <= 0) continue
    // Nudged inside the lane, and only then tested against its neighbour: a
    // feature half off the left edge keeps its name by moving it right, which
    // is what JBrowse does, and a feature so far out that nothing of it is
    // visible has already been dropped by the layout.
    const centre = Math.min(Math.max(middle, edgeLo + text / 2), edgeHi - text / 2)
    const from = centre - text / 2
    if (from < lastRight[placement.row] + 4) continue
    lastRight[placement.row] = centre + text / 2
    laneText(ctx, frame, fitted, centre, placement.row * rowHeight + rowHeight - band / 2 - 1, {
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
  // A lane of arcs is hit on its curves: three nested junctions share one span,
  // and a box test would name the last of them wherever the pointer was.
  if (layout.arcs !== undefined) return junctionAt(frame, layout, x, y)
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
