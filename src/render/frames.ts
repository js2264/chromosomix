/**
 * The six reading frames under a sequence lane (§8.8).
 *
 * A band of six rows — `+1`, `+2`, `+3` over `−1`, `−2`, `−3` — drawn under the
 * residues when the reader asks for it, and like the residues it changes its
 * *picture* with the zoom rather than only its resolution:
 *
 * - a codon is wide enough for a glyph — every codon a box, alternately shaded
 *   so where one ends and the next begins can be seen without counting bases,
 *   with its amino acid written in it; starts filled green and stops red;
 * - a base still owns a pixel — the same boxes and the same colours, without the
 *   letters, which is where an open reading frame starts to read as a stretch of
 *   grey between two red marks;
 * - up to {@link TICKS_MAX_BASES_PER_PIXEL} bases a pixel — the starts and stops
 *   alone, as ticks, IGV's and UCSC's picture of the same thing: a long frame
 *   with no red in it is a gene, or the place for one;
 * - beyond that, nothing, and the band says so — at a chromosome's width every
 *   frame has a stop every few pixels and the ticks are a grey wash.
 *
 * One decision, {@link framesRungFor}, asked of the frame by the fetch, the paint
 * and the readout alike, as {@link basesAreDrawable} is for the residues.
 */

import {
  CODON,
  READING_FRAMES,
  aminoAcidAt,
  codonTable,
  forEachCodon,
  type ReadingFrame,
} from '../annotations/codons'
import type { BaseRegion } from '../annotations/types'
import { laneBand, laneRect, laneText, type LaneFrame } from './lane'
import { stretchOf, strandOf, unitAt, type LocusAxis } from './locus'
import { basePixels } from './sequence'

/**
 * A start and a stop. The green and the red every genome browser uses for them,
 * close to the sequence lane's own A and T so the two bands read as one drawing.
 */
export const START_COLOUR = '#2e9d4f'
export const STOP_COLOUR = '#d13f3f'

/** One frame's row, in CSS pixels, before the reader's text size scales it. */
export const FRAME_ROW = 12
/** Between the residues and `+1`, and between `+3` and `−1`. */
const BAND_GAP = 3
const STRAND_GAP = 4

/** The coarsest zoom the starts and stops are drawn at, in bases per pixel. */
export const TICKS_MAX_BASES_PER_PIXEL = 24
/** Below this a codon box is narrower than the letter in it. */
const LETTER_MIN_CODON = 9
/** …and below this a row is shorter than one. */
const LETTER_MIN_ROW = 9

/** What the band draws at a zoom: letters, bare codons, ticks or nothing. */
export type FramesRung = 'letters' | 'codons' | 'ticks' | 'none'

/** How thick the band is under a lane, for rows of this height. */
export function framesThickness(row: number): number {
  return BAND_GAP + 6 * row + STRAND_GAP
}

/**
 * Which picture of the frames this lane can draw.
 *
 * From the frame alone, like {@link basesAreDrawable}: the fetch, the paint and
 * the readout each ask, and asking the same question of the same frame is what
 * keeps them from disagreeing.
 */
export function framesRungFor(frame: LaneFrame, row: number): FramesRung {
  const base = basePixels(frame)
  if (!(base > 0)) return 'none'
  if (base * 3 >= LETTER_MIN_CODON && row >= LETTER_MIN_ROW) return 'letters'
  if (base >= 1) return 'codons'
  if (base >= 1 / TICKS_MAX_BASES_PER_PIXEL) return 'ticks'
  return 'none'
}

/**
 * The six rows of a band, top to bottom in {@link READING_FRAMES}' order.
 *
 * `band` is the whole strip under the residues; the first gap separates it from
 * them, the second the forward strand from the reverse.
 */
export function frameRows(band: LaneFrame, row: number): LaneFrame[] {
  return READING_FRAMES.map((_frame, at) =>
    laneBand(band, BAND_GAP + at * row + (at >= 3 ? STRAND_GAP : 0), row),
  )
}

/** The frame a point across the band is in, or `null` between rows. */
export function frameAtAcross(across: number, row: number): ReadingFrame | null {
  for (let at = 0; at < READING_FRAMES.length; at++) {
    const from = BAND_GAP + at * row + (at >= 3 ? STRAND_GAP : 0)
    if (across >= from && across < from + row) return READING_FRAMES[at]
  }
  return null
}

export interface FramesPaint {
  /** NCBI's number for the code the codons are read with. */
  code: number
  rung: FramesRung
  /** Row thickness, in canvas pixels. */
  row: number
  font: string
  opacity: number
  /** The page's ink, for the shading and for the letters on it. */
  ink: string
  /** Drawn on a start or a stop, where the ink would be on a strong colour. */
  inkOnColour: string
}

/**
 * Draw the six frames of every window that has arrived.
 *
 * Every codon is placed through the axis, as every base is (§8.4). On an edited
 * axis a stretch read backwards (§27.2) shows the other strand, as the residues
 * do: there the top three rows are the file's reverse frames, because those are
 * the ones that read left to right on screen.
 */
export function drawFrames(
  ctx: CanvasRenderingContext2D,
  band: LaneFrame,
  axis: LocusAxis,
  regions: readonly BaseRegion[],
  paint: FramesPaint,
): void {
  if (paint.rung === 'none') return
  const table = codonTable(paint.code)
  const rows = frameRows(band, paint.row)
  const low = Math.min(band.alongFrom, band.alongTo) - 3 * basePixels(band)
  const high = Math.max(band.alongFrom, band.alongTo) + 3 * basePixels(band)
  const letters = paint.rung === 'letters'

  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.font = paint.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const region of regions) {
    for (const segment of axis.segmentsOf(region.contig)) {
      if (!(segment.bpPerUnit > 0)) continue
      const [lowBp, highBp] = stretchOf(segment)
      const reversed = strandOf(segment) === -1
      for (const [at, shown] of READING_FRAMES.entries()) {
        const rowFrame = rows[at]
        const read = (reversed ? -shown : shown) as ReadingFrame
        if (paint.rung === 'ticks') {
          drawTicks(ctx, rowFrame, region, read, table, segment, lowBp, highBp, low, high, paint)
          continue
        }
        forEachCodon(region, read, table, lowBp, highBp, (start, index, kind) => {
          const a0 = rowFrame.toPixel(unitAt(segment, start))
          const a1 = rowFrame.toPixel(unitAt(segment, start + 3))
          const from = Math.min(a0, a1)
          const to = Math.max(a0, a1)
          if (to < low || from > high) return
          const [x, y, w, h] = laneRect(rowFrame, from, to, 0.5, rowFrame.thickness - 0.5)
          // Every codon shaded, every other one darker: the boundaries are
          // what a reader needs to see, and a box with an outline at this size
          // is mostly outline.
          const coloured = kind === CODON.start || kind === CODON.stop
          ctx.fillStyle =
            kind === CODON.start || kind === CODON.alternative
              ? START_COLOUR
              : kind === CODON.stop
                ? STOP_COLOUR
                : paint.ink
          ctx.globalAlpha =
            paint.opacity *
            (coloured ? 0.85 : kind === CODON.alternative ? 0.3 : Math.floor(start / 3) % 2 === 0 ? 0.07 : 0.17)
          ctx.fillRect(x, y, w, h)
          if (!letters) return
          ctx.globalAlpha = paint.opacity
          ctx.fillStyle = coloured ? paint.inkOnColour : paint.ink
          laneText(ctx, rowFrame, aminoAcidAt(table, index), (from + to) / 2, rowFrame.thickness / 2)
        })
      }
    }
  }
  ctx.restore()
}

/**
 * One row's starts and stops as ticks, the stops drawn last so a stop and a
 * start sharing a pixel read as the stop — the one that ends a frame.
 */
function drawTicks(
  ctx: CanvasRenderingContext2D,
  row: LaneFrame,
  region: BaseRegion,
  frame: ReadingFrame,
  table: ReturnType<typeof codonTable>,
  segment: Parameters<typeof unitAt>[0],
  lowBp: number,
  highBp: number,
  low: number,
  high: number,
  paint: FramesPaint,
): void {
  const starts: number[] = []
  const stops: number[] = []
  forEachCodon(region, frame, table, lowBp, highBp, (start, _index, kind) => {
    if (kind !== CODON.start && kind !== CODON.stop) return
    const at = row.toPixel(unitAt(segment, start + 1.5))
    if (at < low || at > high) return
    ;(kind === CODON.start ? starts : stops).push(at)
  })
  // A faint floor under each row, so an empty one reads as a frame with no
  // starts or stops in it rather than as a gap in the drawing.
  const [fx, fy, fw, fh] = laneRect(row, row.alongFrom, row.alongTo, 0.5, row.thickness - 0.5)
  ctx.globalAlpha = paint.opacity * 0.06
  ctx.fillStyle = paint.ink
  ctx.fillRect(fx, fy, fw, fh)
  ctx.globalAlpha = paint.opacity
  for (const [ticks, colour] of [
    [starts, START_COLOUR],
    [stops, STOP_COLOUR],
  ] as const) {
    ctx.fillStyle = colour
    for (const at of ticks) {
      const [x, y, w, h] = laneRect(row, at - 0.5, at + 0.5, 0.5, row.thickness - 0.5)
      ctx.fillRect(x, y, w, h)
    }
  }
}
