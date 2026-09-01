/**
 * Drawing a pile of reads, the consensus under it, and the pairs between them.
 *
 * ## Three rungs, and which surface each belongs to
 *
 * An alignment lane is the second kind here whose *picture* changes with the
 * zoom rather than only its resolution — the FASTA lane is the first, and this
 * is that shape with one more rung (§8.13):
 *
 * - **coverage**, a value per pixel, which is a track in every sense §8.2 means
 *   and is drawn by `drawTrack` like any other;
 * - **reads**, individual molecules in packed rows, once a read is wider than a
 *   few pixels;
 * - **bases**, the same pile with a letter in every column, once a base owns
 *   one.
 *
 * {@link readRungFor} is the whole of that decision and it takes the *surface*
 * as an argument. Beside a heatmap the axis is an axis of matrix bins, where
 * the finest unit is a bin rather than a base — so there is nothing for a read
 * to be drawn on, and the answer there is always `coverage`. The rule is
 * geometry rather than policy, but it is stated as a rule because the geometry
 * alone cannot enforce it: `basePixels` measures pixels per *axis unit*, and a
 * map zoomed into a fine cooler has the same pixels-per-unit as a browser.
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
import { laneRect, laneX, laneY, type LaneFrame } from './lane'
import { basePixels } from './sequence'
import type { BaseCounts, ReadPile } from '../annotations/types'
import { BASE_LANES } from '../annotations/bam/reads'
import type { LocusAxis } from './locus'

/** Which picture an alignment lane draws. */
export type ReadRung = 'coverage' | 'reads' | 'bases'

/** Which surface is asking — the one thing geometry cannot answer for itself. */
export type LaneSurface = 'browser' | 'map'

/** A read narrower than this is thinner than the ink it would be drawn with. */
const READ_MIN_PIXELS = 2.5

/** …and below this many pixels per base, a letter does not fit in a column. */
const LETTER_MIN_PIXELS = 7

/**
 * Which rung this frame is on.
 *
 * `surface` is not advisory. Reads and the consensus exist only in the 1D
 * browser (§8.13), and this is the one place that is decided — so a caller on
 * the map gets `coverage` whatever its zoom, and cannot get anything else by
 * arriving with a frame that happens to be finely scaled.
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
): ReadRung {
  if (surface !== 'browser') return 'coverage'
  const perBase = basePixels(frame) / Math.max(1e-9, bpPerUnit)
  if (perBase >= LETTER_MIN_PIXELS) return 'bases'
  if (perBase >= READ_MIN_PIXELS / AVERAGE_READ) return 'reads'
  return 'coverage'
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
  /** Draw the line joining two ends of a template. */
  pairs: boolean
  /** Draw mismatching bases, where the file gave any. */
  diffs: boolean
  opacity: number
  font: string
  /** Ink for the marks that are not a category: gaps, clips, outlines. */
  guideColour: string
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
  paint: ReadPaint,
  rung: ReadRung,
): number {
  const segment = axis.segmentOf(pile.contig)
  if (segment === null || !(segment.bpPerUnit > 0)) return 0
  // The same conversion `profileOf` makes, and it has to be the same one: a
  // read and the coverage above it disagreeing by half a pixel is a pile that
  // does not line up with its own summary.
  const at = (base: number): number =>
    frame.toPixel(segment.unitStart + (base - segment.bpStart) / segment.bpPerUnit)
  const perBase = Math.abs(at(1) - at(0))

  ctx.save()
  ctx.globalAlpha = paint.opacity
  const step = paint.rowHeight + paint.rowGap
  const rowsDrawn = Math.max(0, Math.floor((frame.thickness + paint.rowGap) / step))

  // Pair lines first, so a read is never drawn under the thread joining it to
  // its mate — the line is context and the reads are the subject.
  if (paint.pairs) drawPairs(ctx, frame, pile, paint, at, step, rowsDrawn)

  for (let i = 0; i < pile.length; i++) {
    const row = pile.row[i]
    if (row >= rowsDrawn) continue
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

    if (paint.diffs && rung !== 'coverage') {
      drawDiffs(ctx, frame, pile, i, at, across, paint, perBase, rung)
    }
  }
  ctx.restore()
  return rowsDrawn
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

/** The thread joining the two ends of one template. */
function drawPairs(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  pile: ReadPile,
  paint: ReadPaint,
  at: (base: number) => number,
  step: number,
  rowsDrawn: number,
): void {
  ctx.save()
  ctx.globalAlpha = paint.opacity * 0.45
  for (let i = 0; i < pile.length; i++) {
    const mate = pile.mate[i]
    // Once per pair, from the left-hand end — otherwise every line is drawn
    // twice, which is visible wherever the lines are translucent.
    if (mate <= i) continue
    if (pile.row[i] >= rowsDrawn) continue
    const gapFrom = Math.min(pile.refEnd[i], pile.refEnd[mate])
    const gapTo = Math.max(pile.refStart[i], pile.refStart[mate])
    if (gapTo <= gapFrom) continue
    const middle = pile.row[i] * step + paint.rowHeight / 2
    line(ctx, frame, at(gapFrom), at(gapTo), middle, paint.guideColour, 1)
  }
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

// ---------------------------------------------------------------------------
// The consensus, which needs no reference at all
// ---------------------------------------------------------------------------

/**
 * How a consensus band is painted.
 *
 * Two pictures of one thing, and the switch between them is width. A **bar** is
 * one column per position, coloured by the base that won and as tall as its
 * share — legible down to a pixel a base. A **logo** stacks every base that was
 * seen, each glyph scaled to its own frequency, and needs a column wide enough
 * to hold a letter and a band tall enough to stack four.
 */
export interface ConsensusPaint {
  opacity: number
  font: string
  /** Ink for the baseline and for a column nothing was observed at. */
  guideColour: string
  /**
   * Draw stacked glyphs rather than one bar per column.
   *
   * A logo is the honest picture where a column is mixed — it shows *what* the
   * minority was, not merely that there was one — and it is unreadable where a
   * column is a pixel wide.
   */
  logo: boolean
}

/** What a column of the consensus turned out to be. */
export interface ConsensusColumn {
  /** `BASE_CODE` value of the commonest base, or `-1` where nothing was seen. */
  base: number
  /** Its share of the column, in `[0, 1]`. */
  share: number
  /** Reads counted at this position, deletions included. */
  depth: number
}

/**
 * The commonest base at one position, and how sure that is.
 *
 * Deletions are counted in the depth but can never *win* the column: a
 * consensus is a claim about sequence, and "the consensus here is a gap" is not
 * a sequence — it is what the coverage band and the pile are already saying.
 */
export function consensusAt(counts: BaseCounts, position: number): ConsensusColumn {
  const at = position - counts.start
  if (at < 0 || at >= counts.span) return { base: -1, share: 0, depth: 0 }
  const from = at * BASE_LANES
  let depth = 0
  for (let lane = 0; lane < BASE_LANES; lane++) depth += counts.counts[from + lane]
  if (depth === 0) return { base: -1, share: 0, depth: 0 }
  let best = -1
  let most = 0
  // Only the four real bases compete. `N` is an absence of information and a
  // deletion is an absence of sequence; neither is a letter to call.
  for (let lane = 0; lane < 4; lane++) {
    if (counts.counts[from + lane] > most) {
      most = counts.counts[from + lane]
      best = lane
    }
  }
  return most === 0 ? { base: -1, share: 0, depth } : { base: best, share: most / depth, depth }
}

/**
 * Draw the consensus for one window.
 *
 * Every column is drawn, including the ones nothing was observed at — a gap in
 * a consensus band is a fact about the data and must not look like the edge of
 * the window.
 */
export function drawConsensus(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  axis: LocusAxis,
  contig: string,
  counts: BaseCounts,
  paint: ConsensusPaint,
): void {
  const segment = axis.segmentOf(contig)
  if (segment === null || !(segment.bpPerUnit > 0)) return
  const at = (base: number): number =>
    frame.toPixel(segment.unitStart + (base - segment.bpStart) / segment.bpPerUnit)

  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.font = paint.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let position = counts.start; position < counts.start + counts.span; position++) {
    const x0 = at(position)
    const x1 = at(position + 1)
    if (x1 < frame.alongFrom - 2 || x0 > frame.alongTo + 2) continue
    if (paint.logo) drawLogoColumn(ctx, frame, counts, position, x0, x1)
    else drawBarColumn(ctx, frame, counts, position, x0, x1, paint)
  }
  ctx.restore()
}

/** One column as a bar: the winning base, as tall as its share. */
function drawBarColumn(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  counts: BaseCounts,
  position: number,
  x0: number,
  x1: number,
  paint: ConsensusPaint,
): void {
  const column = consensusAt(counts, position)
  if (column.base < 0) {
    // Observed nothing here. A hairline on the baseline says so; leaving the
    // column blank would look like the edge of the window.
    if (column.depth === 0 && x1 - x0 >= 1) {
      ctx.save()
      ctx.globalAlpha = paint.opacity * 0.35
      ctx.fillStyle = paint.guideColour
      const [x, y, w, h] = laneRect(frame, x0, x1, 0, 1)
      ctx.fillRect(x, y, w, h)
      ctx.restore()
    }
    return
  }
  // Full height at a unanimous column, and never *less than* a sliver at a
  // mixed one: a column drawn at a tenth of a pixel reads as an absence.
  const height = Math.max(1, frame.thickness * column.share)
  const [x, y, w, h] = laneRect(frame, x0, x1, 0, height)
  ctx.fillStyle = BASE_COLOURS[column.base] ?? BASE_COLOURS[4]
  ctx.fillRect(x, y, w, h)

  if (x1 - x0 >= LETTER_MIN_PIXELS && frame.thickness >= 10) {
    ctx.fillStyle = '#ffffff'
    const mid = (x0 + x1) / 2
    const centre = height / 2
    ctx.fillText(BASE_LETTERS[column.base] ?? 'N', laneX(frame, mid, centre), laneY(frame, mid, centre))
  }
}

/**
 * One column as a stack of glyphs, each scaled to its own frequency.
 *
 * The picture a reader means by "a logo": the height of a letter *is* its
 * share, so a column where two bases split evenly is two half-height letters
 * rather than one full-height letter and a number somewhere else. Drawn from
 * the least common upward, so the winner sits on top where the eye lands.
 */
function drawLogoColumn(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  counts: BaseCounts,
  position: number,
  x0: number,
  x1: number,
): void {
  const from = (position - counts.start) * BASE_LANES
  if (from < 0 || from >= counts.counts.length) return
  let depth = 0
  for (let lane = 0; lane < BASE_LANES; lane++) depth += counts.counts[from + lane]
  if (depth === 0) return

  const seen: Array<{ base: number; share: number }> = []
  for (let lane = 0; lane < 4; lane++) {
    const share = counts.counts[from + lane] / depth
    if (share > 0) seen.push({ base: lane, share })
  }
  seen.sort((a, b) => a.share - b.share)

  // Uniform horizontal scale and a per-letter vertical one, so the glyphs stay
  // in the same column and only their height carries the number. `VectorTarget`
  // sees ordinary text with a transform, so the PDF export is untouched.
  const width = x1 - x0
  const mid = (x0 + x1) / 2
  let across = 0
  for (const { base, share } of seen) {
    const height = frame.thickness * share
    if (height < 1) {
      across += height
      continue
    }
    ctx.save()
    ctx.fillStyle = BASE_COLOURS[base] ?? BASE_COLOURS[4]
    const centre = across + height / 2
    const cx = laneX(frame, mid, centre)
    const cy = laneY(frame, mid, centre)
    ctx.translate(cx, cy)
    // A glyph is about 0.7 em wide and 0.72 em tall in the fonts this uses; the
    // scale puts it in the column rather than assuming it already fits.
    const metrics = ctx.measureText(BASE_LETTERS[base] ?? 'N')
    const emWidth = Math.max(1, metrics.width)
    ctx.scale((width * 0.92) / emWidth, height / EM_HEIGHT)
    ctx.fillText(BASE_LETTERS[base] ?? 'N', 0, 0)
    ctx.restore()
    across += height
  }
}

/**
 * The height of a capital letter, as a fraction of the font size.
 *
 * Measured rather than derived, because `measureText` reports a width and the
 * cap height is not portable across the fonts this runs in. `0.72` is the
 * conventional cap-height ratio and is close enough that a logo's letters
 * touch without overlapping.
 */
const EM_HEIGHT = 0.72
