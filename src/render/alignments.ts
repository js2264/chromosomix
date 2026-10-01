/**
 * Drawing a pile of reads, and the pairs between them.
 *
 * ## Where a pile can be drawn at all
 *
 * A BAM imports as two rows (§8.13): its depth, which is a coverage profile
 * `drawTrack` paints like any other track, and the pile — this module. So there
 * is no rung here at which this lane draws a curve. There are only the two at
 * which it draws anything:
 *
 * - **reads**, individual molecules in packed rows, once a read is wider than a
 *   few pixels;
 * - **bases**, the same pile with a letter in every column, once a base owns
 *   one.
 *
 * …and `none` for everywhere else, where the lane says *zoom in* rather than
 * drawing a smear. {@link readRungFor} is the whole of that decision and it
 * takes the *surface* as an argument. Beside a heatmap the axis is an axis of
 * matrix bins, where the finest unit is a bin rather than a base — so there is
 * nothing for a read to be drawn on, and the answer there is always `none`. The
 * rule is geometry rather than policy, but it is stated as a rule because the
 * geometry alone cannot enforce it: `basePixels` measures pixels per *axis
 * unit*, and a map zoomed into a fine cooler has the same pixels-per-unit as a
 * browser.
 *
 * ## Why the pile is not just rectangles
 *
 * A read is a rectangle only when nothing happened to it. What a reader is
 * looking for is the exceptions, and each is a different mark: an insertion is
 * a tick *between* two bases and has no width of its own; a deletion is a gap
 * with a line through it, because the read spans it and asserts it is not
 * there; a spliced gap is a thin line with no ink, because the read says
 * nothing about what it skipped; and a soft clip is drawn faintly outside the
 * aligned extent, because a read that is half clipped is telling you something
 * about the alignment rather than about the genome.
 */

import { BASE_COLOURS } from './sequence'

/**
 * The glyph for a `BASE_CODE` value.
 *
 * `BASE_CODE` maps every one of 256 bytes into `0..4`, so this is total — and
 * it is the inverse of that table rather than a second opinion about it, which
 * is why it is five entries in the same order as {@link BASE_COLOURS}.
 */
const BASE_LETTERS = ['A', 'C', 'G', 'T', 'N'] as const
import {
  canvasToAcross,
  laneBands,
  laneIsHorizontal,
  laneRect,
  laneX,
  laneY,
  type LaneFrame,
} from './lane'
import { basePixels } from './sequence'
import { rotateHue } from './hue'
import type { PairLayout, ReadPile } from '../annotations/types'
import { FLAG } from '../annotations/bam/format'
import { modStateOf, probabilityOf } from '../annotations/bam/basemods'

/** The one flag bit this module draws differently; see {@link drawOne}. */
const SUPPLEMENTARY = FLAG.SUPPLEMENTARY
import { stretchOf, unitAt, type LocusAxis, type LocusSegment } from './locus'

/**
 * Which picture a pile lane draws, if any.
 *
 * `none` is the answer everywhere a read is narrower than the ink it would take
 * — the lane says *zoom in* rather than drawing a smear. It used to be called
 * `coverage`, because the depth curve shared the lane and was what a reader saw
 * out here; the depth is a row of its own now (§8.13) and this rung draws
 * nothing at all.
 */
export type ReadRung = 'none' | 'reads' | 'bases'

/** Which surface is asking — the one thing geometry cannot answer for itself. */
export type LaneSurface = 'browser' | 'map'

/** A read narrower than this is thinner than the ink it would be drawn with. */
const READ_MIN_PIXELS = 2.5

/** …and below this many pixels per base, a letter does not fit in a column. */
const LETTER_MIN_PIXELS = 7

/**
 * The stretch of the axis a pile was fetched for.
 *
 * The first stretch of its contig on most axes; on an edited one (§27.2) a
 * contig can be several pieces, and a pile belongs to the one whose piece its
 * window overlaps — a window is cut per piece, so there is exactly one.
 */
function pileSegment(axis: LocusAxis, pile: ReadPile): LocusSegment | null {
  for (const segment of axis.segmentsOf(pile.contig)) {
    if (!(segment.bpPerUnit > 0)) continue
    const [from, to] = stretchOf(segment)
    if (pile.end > from && pile.start < to) return segment
  }
  return null
}

/**
 * Which rung this frame is on.
 *
 * `surface` is not advisory. A pile exists only in the 1D browser (§8.13), and
 * this is the one place that is decided — so a caller on the map gets `none`
 * whatever its zoom, and cannot get anything else by arriving with a frame that
 * happens to be finely scaled.
 *
 * `bpPerUnit` converts the frame's own units into base pairs. It is `1` in the
 * browser, where the axis is the assembly laid out at one unit per base, and it
 * is the bin size beside a map — which is exactly why the surface has to be
 * asked rather than inferred from the number.
 */
export function readRungFor(
  frame: LaneFrame,
  surface: LaneSurface,
  bpPerUnit = 1,
  nameBand = NAME_BAND,
): ReadRung {
  if (surface !== 'browser') return 'none'
  const perBase = basePixels(frame) / Math.max(1e-9, bpPerUnit)
  const rung = perBase >= LETTER_MIN_PIXELS ? 'bases' : perBase >= READ_MIN_PIXELS / AVERAGE_READ ? 'reads' : 'none'
  if (rung === 'none') return 'none'
  // Zoom is not the only thing that decides this. The name strip takes a fixed
  // height off the top, so a lane dragged short enough has a pile band that can
  // hold nothing — and the pile is what this lane *is*. Answering `reads` there
  // drew an empty lane and still spent a whole BAM window on it, so zooming in
  // made the picture disappear.
  return rowsIn(pileBands(frame, nameBand)[1]) >= 1 ? rung : 'none'
}

/**
 * The read length the rung threshold is expressed against.
 *
 * The switch is about whether a *read* is wide enough to be a shape rather than
 * a mark, and a read's width is its length times the pixels per base. A hundred
 * is the short-read length this feature is scoped to (§8.13); getting it wrong
 * moves the switch by a factor of two, which a reader corrects with one scroll.
 */
const AVERAGE_READ = 100

/** How a pile is painted. */
export interface ReadPaint {
  /** One colour per category in `pile.groups`. */
  colours: readonly string[]
  /** Thickness of one read row, in pixels. */
  rowHeight: number
  /** Gap between rows. */
  rowGap: number
  /**
   * How a template is laid out and what is drawn between its two ends.
   *
   * `pairs` draws both reads on one row with a dotted thread across the gap —
   * the default, because a pair *is* one fragment and two blocks a row apart
   * joined by nothing read as two unrelated reads. `fragments` fills the gap
   * instead, for a reader who wants the fragment as one object. `reads` packs
   * every record on its own, which is what a single-ended library wants.
   */
  layout: PairLayout
  /** Draw mismatching bases, where the file gave any. */
  diffs: boolean
  opacity: number
  font: string
  /** Ink for the marks that are not a category: gaps, clips, outlines. */
  guideColour: string
  /**
   * Draw each read's base-modification calls of this code over it (§8.13),
   * where the pile carries them: modified at or above `threshold`, unmodified
   * at or below its complement, each as sure as its probability says.
   * Absent draws none, and the mismatch marks are drawn instead.
   */
  mods?: { code: string; threshold: number }
}

/**
 * The inks of a pile coloured by base modification (§8.13).
 *
 * Red and blue because that is the pair every reader of these pictures has
 * learnt from IGV and from modkit's own plots, and because neither is a read
 * category here — under this colouring the reads are drawn in `read`, a grey
 * light enough that a blue call on it is still blue. The mismatch marks are
 * not drawn under it: they are coloured by base, and a red `T` and a red 5mC
 * a column apart would be one ink making two claims.
 */
export const MOD_INK = {
  modified: '#d7191c',
  unmodified: '#2c7bb6',
  read: '#c8c8c8',
} as const

/** The narrowest a call is drawn, in pixels, so one is visible at the zoom reads first appear. */
const MOD_MIN_PIXELS = 2

// ---------------------------------------------------------------------------
// Packing the pile into rows, for the window that is on screen
// ---------------------------------------------------------------------------

/**
 * How the reads of a template are laid out together.
 *
 * `reads` packs every record on its own, which is what a single-ended library
 * wants and what this lane did from the start. The other two treat the template
 * as the unit — both ends on one row — and differ only in what is drawn between
 * them: a thread, or ink.
 */
/** Where every read of a window goes, packed for the window on screen. */
export interface PileLayout {
  /** One row per read of the pile it belongs to; `-1` for a read left out. */
  row: Int16Array
  /** Rows the packing used, which may exceed what the band can draw. */
  rows: number
  /** Reads placed at all — those overlapping the visible window. */
  placed: number
  /** …of which this many landed past the last row the band draws. */
  hidden: number
}

/**
 * The gap between two reads on one row, in **pixels**.
 *
 * Pixels rather than base pairs, which is what the worker's packer used. A gap
 * of three bases is a third of a pixel at 10 bases per pixel — so two reads a
 * hundred bases apart were drawn touching, and a row read as one long fragment.
 * That is the whole reason a reader cannot tell where one read ends here.
 */
const ROW_PAD = 2

/**
 * Pack a window's reads into rows, for the window that is on screen.
 *
 * ## Why this is not the worker's job
 *
 * It used to be, and the packing came back on the wire in `ReadPile.row`. Three
 * things were wrong with that and all three are visible on a real file:
 *
 * **The rows were packed for the window that was *fetched*.** That window is
 * three view-widths (`ReadCache.FETCH_PAD`), so a reader who zooms in is shown
 * a packing made for a picture three times wider, and the rows it needed.
 *
 * **A window read as several byte spans came back as several piles, each
 * numbering its rows from zero.** Drawn into one band they collided, and two
 * reads a chunk boundary apart were drawn on top of each other. Packing every
 * pile of the window into one row space is what fixes that, and it can only be
 * done where all of them are in hand.
 *
 * **A template cannot be packed as a unit in the worker.** The mate join is
 * resolved there, but which reads share a row is a question about the picture —
 * it changes with a switch in the settings card — and re-fetching a window to
 * answer it would be a BAM read for a drawing decision.
 *
 * What is given up is row *stability under a pan*: a read can change row when
 * the window moves, where the worker's packing held it still for as long as the
 * bytes were in hand. That trade is worth taking because the old stability was
 * already a half-truth — the packer only ever saw the reads that survived
 * thinning, so any change of budget re-packed everything anyway — and because
 * a row that is stable but wrong is not the better failure.
 *
 * ## What it does
 *
 * Greedy first fit over the units in coordinate order, which is what makes the
 * rows compact and the picture stable left to right. Units are read extents
 * including their soft clips, because a clip is drawn and two of them
 * overlapping would be two reads drawn over each other.
 *
 * Reads outside `[from, to)` are left out entirely — `row = -1` — so the rows
 * count what is on screen and nothing else.
 */
export function packPile(
  piles: readonly ReadPile[],
  axis: LocusAxis,
  frame: LaneFrame,
  from: number,
  to: number,
  layout: PairLayout,
  rowsDrawn: number,
): PileLayout[] {
  const out: PileLayout[] = piles.map((pile) => ({
    row: new Int16Array(pile.length).fill(-1),
    rows: 0,
    placed: 0,
    hidden: 0,
  }))

  // One unit per thing that occupies a row: a read, or a whole template where
  // the layout asks for that. Collected across every pile first, because they
  // share one row space — see the docblock.
  const units: Array<{ pile: number; a: number; b: number; start: number; end: number }> = []
  for (let p = 0; p < piles.length; p++) {
    const pile = piles[p]
    const segment = pileSegment(axis, pile)
    if (segment === null) continue
    const unitOf = (base: number): number => unitAt(segment, base)
    const paired = layout !== 'reads'
    for (let i = 0; i < pile.length; i++) {
      const mate = paired ? pile.mate[i] : -1
      // Once per template, from its left-hand end: the other end is placed with
      // it, so meeting it again is not a second unit.
      if (mate >= 0 && mate < i) continue
      let lo = pile.refStart[i] - pile.clipStart[i]
      let hi = pile.refEnd[i] + pile.clipEnd[i]
      if (mate > i) {
        lo = Math.min(lo, pile.refStart[mate] - pile.clipStart[mate])
        hi = Math.max(hi, pile.refEnd[mate] + pile.clipEnd[mate])
      }
      const start = unitOf(lo)
      const end = unitOf(hi)
      // Off screen entirely. The pad is fetched so a pan is free, not so that
      // it is drawn — and counting it would make the rows and the caption
      // describe a picture three times wider than the one on the screen.
      if (end <= from || start >= to) continue
      units.push({ pile: p, a: i, b: mate > i ? mate : -1, start, end })
    }
  }

  // Coordinate order, because greedy first fit is only compact over a sorted
  // stream. A pile arrives sorted, but two piles interleave and a template's
  // extent is not its first read's.
  units.sort((one, two) => one.start - two.start || one.end - two.end)

  // The gap, in axis units, from a gap in pixels. `toPixel` is affine, so one
  // subtraction settles the scale for the whole window.
  const perUnit = Math.abs(frame.toPixel(1) - frame.toPixel(0))
  const gap = perUnit > 0 ? ROW_PAD / perUnit : 0

  const ends: number[] = []
  for (const unit of units) {
    let row = ends.length
    for (let r = 0; r < ends.length; r++) {
      if (ends[r] + gap <= unit.start) {
        row = r
        break
      }
    }
    if (row === ends.length) ends.push(unit.end)
    else ends[row] = unit.end
    const held = out[unit.pile]
    held.row[unit.a] = row
    held.placed++
    if (row >= rowsDrawn) held.hidden++
    if (unit.b >= 0) {
      held.row[unit.b] = row
      held.placed++
      if (row >= rowsDrawn) held.hidden++
    }
  }
  for (const held of out) held.rows = ends.length
  return out
}

/**
 * Draw one window of reads into a band.
 *
 * Returns the rows actually drawn, so a caller can say when a pile was taller
 * than its lane.
 */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  axis: LocusAxis,
  pile: ReadPile,
  placed: PileLayout,
  paint: ReadPaint,
  rung: ReadRung,
): number {
  const segment = pileSegment(axis, pile)
  if (segment === null) return 0
  // The same conversion `profileOf` makes, and it has to be the same one: a
  // read and the coverage above it disagreeing by half a pixel is a pile that
  // does not line up with its own summary.
  const at = (base: number): number => frame.toPixel(unitAt(segment, base))
  const perBase = Math.abs(at(1) - at(0))

  ctx.save()
  ctx.globalAlpha = paint.opacity
  const step = paint.rowHeight + paint.rowGap
  const rowsDrawn = rowsAcross(frame.thickness, paint.rowHeight, paint.rowGap)
  // The code's number in *this* pile's table — each pile numbers its own.
  const modIndex = paint.mods === undefined ? -1 : (pile.mods?.codes.indexOf(paint.mods.code) ?? -1)

  // Pair lines first, so a read is never drawn under the thread joining it to
  // its mate — the line is context and the reads are the subject.
  if (paint.layout !== 'reads') {
    drawPairs(ctx, frame, pile, placed, paint, at, step, rowsDrawn)
  }

  for (let i = 0; i < pile.length; i++) {
    const row = placed.row[i]
    if (row < 0 || row >= rowsDrawn) continue
    const across = row * step
    const colour = paint.colours[pile.group[i]] ?? paint.colours[0] ?? '#4478b8'

    // The soft clips, outside the aligned extent and faint: they are what the
    // aligner could not place, not what it placed somewhere.
    if (pile.clipStart[i] > 0 || pile.clipEnd[i] > 0) {
      ctx.globalAlpha = paint.opacity * 0.3
      if (pile.clipStart[i] > 0) {
        fill(ctx, frame, at(pile.refStart[i] - pile.clipStart[i]), at(pile.refStart[i]), across, paint.rowHeight, colour)
      }
      if (pile.clipEnd[i] > 0) {
        fill(ctx, frame, at(pile.refEnd[i]), at(pile.refEnd[i] + pile.clipEnd[i]), across, paint.rowHeight, colour)
      }
      ctx.globalAlpha = paint.opacity
    }

    drawOne(ctx, frame, pile, i, at, across, paint, colour)

    if (paint.mods !== undefined) {
      if (modIndex >= 0) drawMods(ctx, frame, pile, i, at, across, paint, modIndex, paint.mods.threshold)
    } else if (paint.diffs && rung !== 'none') {
      drawDiffs(ctx, frame, pile, i, at, across, paint, perBase, rung)
    }
  }
  ctx.restore()
  return rowsDrawn
}

/**
 * The read under a canvas point, or `null`.
 *
 * The inverse of {@link drawReads}, and it has to be built out of the same two
 * conversions — the axis one and `laneRect`'s — or a click lands on the read
 * above the one that was pointed at. That is the reason it lives here beside
 * the drawing rather than in the view: the two answers are one piece of
 * geometry, and §8.4 says a lane's geometry is decided in one place.
 *
 * The *last* match wins, as `featureAt` does and for the same reason: within a
 * row the reads are in axis order and later ones paint over earlier ones, so
 * the one on top is the one that was clicked.
 *
 * Soft clips are inside the target. They are drawn, faintly, outside the
 * aligned extent — and a reader who clicks the faint part is asking about the
 * read it belongs to, not about the gap behind it.
 */
export function readAt(
  frame: LaneFrame,
  axis: LocusAxis,
  pile: ReadPile,
  placed: PileLayout,
  rowHeight: number,
  rowGap: number,
  x: number,
  y: number,
): number | null {
  const segment = pileSegment(axis, pile)
  if (segment === null) return null
  const along = laneIsHorizontal(frame.orientation) ? x : y
  const across = canvasToAcross(frame, laneIsHorizontal(frame.orientation) ? y : x)
  if (across < 0 || across > frame.thickness) return null
  // …and the same bound on the *other* axis, which the paint gets for free from
  // `clipLane` and an inverse does not. Without it a click in the name column —
  // a strip at least fifty pixels wide, whose documented answer is "reveal this
  // track" — lands on a read that begins off the left edge of the view. The
  // window is fetched a whole view-width wider on each side, so those reads are
  // there in quantity.
  const from = Math.min(frame.alongFrom, frame.alongTo)
  const to = Math.max(frame.alongFrom, frame.alongTo)
  if (along < from || along > to) return null
  // The gap below a row belongs to that row. It is two pixels and a pointer is
  // not that accurate, so treating it as a miss would make every third click on
  // a dense pile do nothing.
  const row = Math.floor(across / (rowHeight + rowGap))
  // …but not the strip below the *last* drawn row, which `drawReads` leaves
  // empty when the band does not divide evenly. A click there would open a card
  // for a read that is not on the screen, which is the one way a hit test can
  // be wrong and look right.
  if (row >= rowsAcross(frame.thickness, rowHeight, rowGap)) return null

  const at = (base: number): number => frame.toPixel(unitAt(segment, base))
  let found: number | null = null
  for (let i = 0; i < pile.length; i++) {
    if (placed.row[i] !== row) continue
    // A read narrower than a pixel is still a target: the drawn block is
    // rounded to one, so a hit area measured exactly would be unhittable at the
    // zoom where reads first appear.
    const a = at(pile.refStart[i] - pile.clipStart[i])
    const b = at(pile.refEnd[i] + pile.clipEnd[i])
    if (along < Math.min(a, b) - 1 || along > Math.max(a, b) + 1) continue
    found = i
  }
  return found
}

/**
 * One read: its blocks, its gaps and its indels.
 *
 * Walks the CIGAR rather than filling the extent, because the extent is the one
 * thing about a read that is *never* the interesting part.
 */
function drawOne(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  pile: ReadPile,
  i: number,
  at: (base: number) => number,
  across: number,
  paint: ReadPaint,
  colour: string,
): void {
  let refPos = pile.refStart[i]
  const from = pile.opAt[i]
  const to = pile.opAt[i + 1]
  const middle = across + paint.rowHeight / 2

  for (let op = from; op < to; op++) {
    const code = pile.opCode[op]
    const length = pile.opLen[op]
    if (code === 0 || code === 7 || code === 8) {
      fill(ctx, frame, at(refPos), at(refPos + length), across, paint.rowHeight, colour)
      refPos += length
      continue
    }
    if (code === 2) {
      // A deletion. The read spans it and says it is absent, so it gets a line
      // rather than a gap: a gap would read as "no read here".
      line(ctx, frame, at(refPos), at(refPos + length), middle, paint.guideColour, 1.5)
      refPos += length
      continue
    }
    if (code === 3) {
      // A spliced gap. The read says *nothing* about what it skipped, so the
      // line is thinner and lighter than a deletion's — the difference between
      // "not there" and "not observed" is most of what an RNA-seq pile is for.
      line(ctx, frame, at(refPos), at(refPos + length), middle, paint.guideColour, 0.75)
      refPos += length
      continue
    }
    if (code === 1) {
      // An insertion has no width on the reference at all, so it is a tick
      // *between* two bases rather than a block of any length.
      const x = at(refPos)
      ctx.save()
      ctx.strokeStyle = paint.guideColour
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(laneX(frame, x, across), laneY(frame, x, across))
      ctx.lineTo(laneX(frame, x, across + paint.rowHeight), laneY(frame, x, across + paint.rowHeight))
      ctx.stroke()
      ctx.restore()
      continue
    }
    // `S`, `H` and `P` move along the read, never along the reference.
  }

  // A supplementary alignment is outlined, and nothing else is. It is one piece
  // of a molecule the aligner split across a breakpoint, so it must be readable
  // *as* a piece — a plain block would say "another read here", which is the
  // one thing it is not. An outline rather than a fainter fill, because faint
  // is already what a soft clip means on this lane and two faint things a row
  // apart cannot be told apart.
  if ((pile.flags[i] & SUPPLEMENTARY) !== 0) {
    const [x, y, w, h] = laneRect(
      frame,
      at(pile.refStart[i]),
      at(pile.refEnd[i]),
      across,
      across + paint.rowHeight,
    )
    ctx.save()
    ctx.strokeStyle = paint.guideColour
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
    ctx.restore()
  }
}

/** Mismatching bases: a coloured column, and a letter once one fits. */
function drawDiffs(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  pile: ReadPile,
  i: number,
  at: (base: number) => number,
  across: number,
  paint: ReadPaint,
  perBase: number,
  rung: ReadRung,
): void {
  const from = pile.diffAt[i]
  const to = pile.diffAt[i + 1]
  if (to <= from) return
  const letters = rung === 'bases' && perBase >= LETTER_MIN_PIXELS && paint.rowHeight >= 8
  for (let d = from; d < to; d++) {
    const base = pile.diffBase[d]
    const colour = BASE_COLOURS[base] ?? BASE_COLOURS[4]
    const x0 = at(pile.diffPos[d])
    const x1 = at(pile.diffPos[d] + 1)
    fill(ctx, frame, x0, x1, across, paint.rowHeight, colour)
    if (!letters) continue
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.font = paint.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const mid = (x0 + x1) / 2
    const centre = across + paint.rowHeight / 2
    ctx.fillText(BASE_LETTERS[base] ?? 'N', laneX(frame, mid, centre), laneY(frame, mid, centre))
    ctx.restore()
  }
}

/**
 * One read's modification calls of one code: a column per call, red or blue,
 * as opaque as the caller was sure.
 *
 * Alpha runs from a sixth at a call that only just cleared the threshold to
 * whole at a certain one — so a stretch of confident calls reads as solid
 * colour and a stretch of coin-flips as a wash, which is the difference a
 * reader is looking for between a methylated island and a noisy model.
 */
function drawMods(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  pile: ReadPile,
  i: number,
  at: (base: number) => number,
  across: number,
  paint: ReadPaint,
  code: number,
  threshold: number,
): void {
  const mods = pile.mods
  if (mods === undefined) return
  const from = mods.at[i]
  const to = mods.at[i + 1]
  for (let k = from; k < to; k++) {
    if (mods.code[k] !== code) continue
    const state = modStateOf(mods.prob[k], threshold)
    if (state < 0) continue
    const p = probabilityOf(mods.prob[k])
    const sure = state === 1 ? p : 1 - p
    ctx.globalAlpha = paint.opacity * (1 / 6 + (5 / 6) * Math.max(0, (sure - 0.5) * 2))
    let x0 = at(mods.pos[k])
    let x1 = at(mods.pos[k] + 1)
    if (Math.abs(x1 - x0) < MOD_MIN_PIXELS) {
      const mid = (x0 + x1) / 2
      x0 = mid - MOD_MIN_PIXELS / 2
      x1 = mid + MOD_MIN_PIXELS / 2
    }
    fill(ctx, frame, x0, x1, across, paint.rowHeight, state === 1 ? MOD_INK.modified : MOD_INK.unmodified)
  }
  ctx.globalAlpha = paint.opacity
}

/**
 * The modification calls a read makes at the base nearest a reference position.
 *
 * The readout's question, answered from the pile the lane drew. The nearest
 * call **of the code drawn** within `reach` bases of `pos` decides the base —
 * so a pointer a pixel off a one-base column still lands on it, and does not
 * land instead on an invisible implicit call of another code a base closer —
 * and then every code's call at that base is returned, the drawn one first,
 * so a cytosine carrying both a 5mC and a 5hmC call names both.
 */
export function modsNear(
  pile: ReadPile,
  i: number,
  pos: number,
  reach: number,
  code?: string,
): Array<{ pos: number; code: string; prob: number; byte: number }> {
  const mods = pile.mods
  if (mods === undefined) return []
  const drawn = code === undefined ? -1 : mods.codes.indexOf(code)
  if (code !== undefined && drawn < 0) return []
  let best = -1
  let distance = Number.POSITIVE_INFINITY
  for (let k = mods.at[i]; k < mods.at[i + 1]; k++) {
    if (drawn >= 0 && mods.code[k] !== drawn) continue
    const off = Math.abs(mods.pos[k] + 0.5 - pos)
    if (off <= reach && off < distance) {
      distance = off
      best = mods.pos[k]
    }
  }
  if (best < 0) return []
  const out: Array<{ pos: number; code: string; prob: number; byte: number }> = []
  for (let k = mods.at[i]; k < mods.at[i + 1]; k++) {
    if (mods.pos[k] !== best) continue
    out.push({
      pos: mods.pos[k],
      code: mods.codes[mods.code[k]] ?? '',
      prob: probabilityOf(mods.prob[k]),
      byte: mods.prob[k],
    })
  }
  if (code !== undefined) out.sort((a, b) => Number(b.code === code) - Number(a.code === code))
  return out
}

/** The thread joining the two ends of one template. */
function drawPairs(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  pile: ReadPile,
  placed: PileLayout,
  paint: ReadPaint,
  at: (base: number) => number,
  step: number,
  rowsDrawn: number,
): void {
  const fragment = paint.layout === 'fragments'
  ctx.save()
  // A thread is context and is drawn faintly; a fragment body is the subject
  // and is drawn as the read is, because in that layout the gap is not a gap —
  // it is the part of the fragment nobody sequenced.
  ctx.globalAlpha = paint.opacity * (fragment ? 0.55 : 0.45)
  if (!fragment) {
    // Dotted, and this is the whole difference between a pair that reads as a
    // pair and one that reads as a fragment: a solid rule between two blocks on
    // one row is indistinguishable from a fragment drawn through. The dashes
    // are in pixels, so they are the same length at every zoom.
    ctx.setLineDash([2, 3])
  }
  for (let i = 0; i < pile.length; i++) {
    const mate = pile.mate[i]
    // Once per pair, from the left-hand end — otherwise every line is drawn
    // twice, which is visible wherever the lines are translucent.
    if (mate <= i) continue
    const row = placed.row[i]
    if (row < 0 || row >= rowsDrawn) continue
    const gapFrom = Math.min(pile.refEnd[i], pile.refEnd[mate])
    const gapTo = Math.max(pile.refStart[i], pile.refStart[mate])
    if (gapTo <= gapFrom) continue
    const across = row * step
    if (fragment) {
      const colour = paint.colours[pile.group[i]] ?? paint.colours[0] ?? '#4478b8'
      fill(ctx, frame, at(gapFrom), at(gapTo), across, paint.rowHeight, colour)
      continue
    }
    line(ctx, frame, at(gapFrom), at(gapTo), across + paint.rowHeight / 2, paint.guideColour, 1)
  }
  ctx.setLineDash([])
  ctx.restore()
}

/** A filled block in lane coordinates. */
function fill(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  along1: number,
  across: number,
  height: number,
  colour: string,
): void {
  ctx.fillStyle = colour
  const [x, y, w, h] = laneRect(frame, along0, along1, across, across + height)
  ctx.fillRect(x, y, w, h)
}

/** A horizontal rule along the read's own middle. */
function line(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along0: number,
  along1: number,
  across: number,
  colour: string,
  width: number,
): void {
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(laneX(frame, along0, across), laneY(frame, along0, across))
  ctx.lineTo(laneX(frame, along1, across), laneY(frame, along1, across))
  ctx.stroke()
  ctx.restore()
}

/**
 * Room kept clear at the top of a pile lane for its own name and detail, at the
 * reader's default text size.
 *
 * Every other lane draws its label *over* its data, with a halo, and that works
 * because a track is low wherever it is low — there is usually somewhere for
 * two lines of text to sit. A pile has no such place: it fills the lane and is
 * dense by construction, so a label over it is a label read through ink.
 * Reserving the strip costs two rows of reads and is the difference between a
 * lane whose name can be read and one whose name is decoration.
 *
 * Two lines, because a pile lane writes both: its name, and how many reads are
 * in the window. Thirty pixels held only the first, and the second came out
 * through the top row of reads — which is exactly the failure the strip exists
 * to prevent. The number is `nameTop + detailDrop + nameLine` from
 * `render/laneLabel.ts`: where the first line's centre goes, how far the detail
 * drops below it, and one line's room under that.
 *
 * A *default* rather than the number, because those three scale with the
 * reader's text size and this module cannot see it — {@link pileBands} takes
 * the strip it should keep, and `BrowserView` computes it from the very
 * constants it hands `render/laneLabel.ts`. A constant here would write over a
 * reader who made the type larger; this one is what that sum comes to at the
 * default size, and it is what every caller that draws no label uses.
 */
export const NAME_BAND = 36

/** Gap between the name strip and the pile, so they read as two and not one. */
export const BAND_GAP = 3
/** One read row, and the gap under it. */
export const READ_ROW = 7
export const READ_ROW_GAP = 2

/**
 * How many read rows a lane has room for.
 *
 * What is left under the name strip, which is what the worker thins the pile
 * against. A lane too short for a single row still asks for one: the
 * alternative is a request for zero reads, and a pile of none is
 * indistinguishable from a failure.
 */
export function rowsFor(frame: LaneFrame, nameBand = NAME_BAND): number {
  return Math.max(1, rowsIn(pileBands(frame, nameBand)[1]))
}

/**
 * The lane's two bands: the name strip, and the pile under it.
 *
 * One function because §8.4 means it: the paint lays these out, the row budget
 * sent to the worker is measured against the second of them, and the hit test
 * inverts it. Three readings of one split, and when they were three
 * *expressions* of it the budget over-stated the pile by a gap.
 *
 * `nameBand` is a thickness rather than a "is it labelled" flag, because the
 * strip's right size is the label's own metrics and those live on the surface
 * drawing it. Zero is a surface that writes no text — a band of no thickness
 * rather than a part that is absent, so every caller can index the pair the
 * same way.
 *
 * It used to be four bands — a name strip, a depth curve and a consensus above
 * the pile — and every one of those is now a question this lane does not ask.
 * The depth is a row of its own beside this one (§8.13); the consensus is gone.
 * A band is not something a reader resizes any more, because a *lane* is.
 */
export function pileBands(frame: LaneFrame, nameBand = NAME_BAND): [LaneFrame, LaneFrame] {
  return laneBands(
    frame,
    [{ fixed: Math.max(0, nameBand) }, { fill: true }],
    BAND_GAP,
  ) as [LaneFrame, LaneFrame]
}

/**
 * How many rows of reads a band of this thickness draws.
 *
 * The one expression of it — genuinely one, now: the budget, {@link drawReads}
 * and {@link readAt} all call this rather than inlining the arithmetic, which
 * they did until the doc above said they did not. The row height and gap are
 * arguments because the paint takes them from `ReadPaint` rather than from the
 * module constants.
 *
 * The `+ rowGap` is not a fudge: the last row needs no gap under it, so a band
 * of exactly `n * row + (n - 1) * gap` holds `n` rows.
 */
export function rowsAcross(thickness: number, rowHeight: number, rowGap: number): number {
  return Math.max(0, Math.floor((thickness + rowGap) / (rowHeight + rowGap)))
}

function rowsIn(band: LaneFrame): number {
  return rowsAcross(band.thickness, READ_ROW, READ_ROW_GAP)
}

/**
 * A colour per category, from the lane's own colour.
 *
 * The lane's colour is what a reader chose and what the swatch on its row
 * shows, so the first category keeps it exactly and the rest are rotations of
 * its hue — which keeps a two-category colouring (the strands) legible as *one
 * track drawn two ways* rather than as two unrelated tracks.
 */
export function readColoursFor(
  window: { piles: readonly ReadPile[] },
  colour: string,
): string[] {
  return readPalette(window.piles[0]?.groups ?? ['reads'], colour)
}

/**
 * The palette for a set of categories, from the lane's own colour.
 *
 * Split out of {@link readColoursFor} so the settings card can draw the same
 * key without a pile in hand: the categories are a pure function of the
 * colouring (`groupsFor`), so a legend built from them cannot disagree with
 * the picture — which a second hand-written palette eventually would.
 */
export function readPalette(groups: readonly string[], colour: string): string[] {
  if (groups.length <= 1) return [colour]
  return groups.map((_, i) =>
    i === 0 ? colour : rotateHue(colour, (i * 360) / (groups.length + 1)),
  )
}

/**
 * The line under an alignment lane's name.
 *
 * Says what the pile *is* rather than repeating the coverage axis above it, and
 * names the two things a reader cannot see: that reads were dropped to fit, and
 * where the mismatch colouring came from — because "no mismatches here" and
 * "this file cannot tell me" are the same empty picture (§8.13).
 */
export function pileDetail(
  window: {
    kept: number
    total: number
    capped: boolean
    diffs: string
    note?: string
  },
  placed: readonly PileLayout[] = [],
  /** Under a colouring by base modification, the code drawn and its name. */
  mods?: { label: string; calls: number },
): string {
  if (window.note !== undefined) return window.note
  // What is on the screen, not what came back. The reply covers three
  // view-widths, so its counts describe a picture the reader is not looking at
  // — and they do not move when the view zooms inside the window that was
  // fetched, which is how a caption that says "203 of 394" ends up over a
  // drawing of thirty.
  const here = placed.reduce((sum, one) => sum + one.placed, 0)
  const hidden = placed.reduce((sum, one) => sum + one.hidden, 0)
  const reads =
    placed.length === 0
      ? window.capped
        ? `${window.kept.toLocaleString()} of ${window.total.toLocaleString()} reads`
        : `${window.kept.toLocaleString()} reads`
      : hidden > 0
        ? // The one number the lane owed a reader and never gave: a pile taller
          // than its band drops its tail silently, and a caption that counted
          // the dropped reads as drawn is why a peak of depth forty looked like
          // a peak of depth nine.
          `${(here - hidden).toLocaleString()} of ${here.toLocaleString()} reads — taller lane for the rest`
        : window.capped
          ? `${here.toLocaleString()} reads, thinned`
          : `${here.toLocaleString()} reads`
  // What the colours are of, in place of where the mismatches came from: they
  // are not drawn under this colouring, and "no MM/ML tags here" is the one
  // thing a reader of a plain grey pile needs told.
  if (mods !== undefined) {
    return `${reads} · ${mods.calls === 0 ? 'no MM/ML calls here' : mods.label}`
  }
  const diffs =
    window.diffs === 'none'
      ? 'no reference to compare'
      : window.diffs === 'md'
        ? 'MD'
        : window.diffs === 'cigar'
          ? '=/X'
          : 'reference'
  return `${reads} · ${diffs}`
}
