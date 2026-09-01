/**
 * The sequence itself, drawn.
 *
 * A genome browser's sequence lane is the one track whose *representation*
 * changes with the zoom rather than merely its resolution, and this module owns
 * the top two rungs of that ladder:
 *
 * - a base is under a pixel wide — nothing legible can be drawn, and the lane
 *   shows GC content instead. That is not here: GC is a value per window, so it
 *   goes through `render/tracks.ts` like every other value track, which is what
 *   makes it autoscale, fill, flip and export with no special case (§8.4);
 * - a base is a pixel or more — one coloured column per residue. At a whole gene
 *   this is a texture rather than a reading, and that texture is exactly right:
 *   AT-rich promoters and GC-rich exons are visible in it;
 * - a base is wide enough for a glyph — the letter, in its own colour, over a
 *   pale wash of it. Which is the point the reader was zooming towards.
 *
 * There is no third drawing to keep in step with the other two: the transition
 * is decided by one number, {@link basesAreDrawable}, and both the browser and
 * its PDF export ask it the same question about the same frame.
 */

import { BASE_CODE } from '../annotations/fasta'
import type { BaseRegion } from '../annotations/types'
import { laneRect, laneText, type LaneFrame } from './lane'
import type { LocusAxis } from './locus'

/**
 * Base colours, indexed by {@link BASE_CODE}: A, C, G, T/U, anything else.
 *
 * The convention every genome browser shares — green, blue, orange, red — so a
 * reader who knows one knows this. Darkened a little from the primaries, because
 * these are drawn as filled columns at full height rather than as letters on
 * white, and a screen of saturated primaries is a screen nobody can look at.
 */
export const BASE_COLOURS = ['#3d9950', '#2f6fb5', '#d59225', '#c8483f', '#8b939c'] as const

/** Below this many pixels per base, a column is thinner than the ink in it. */
export const COLUMN_MIN_WIDTH = 1

/** Below this, a letter does not fit between its neighbours. */
export const LETTER_MIN_WIDTH = 6

/** …and a lane shorter than this has no room for one across. */
const LETTER_MIN_THICKNESS = 12

/**
 * `true` when this frame can draw one residue per column.
 *
 * The single decision behind the whole ladder, asked of the frame rather than of
 * a zoom level so that the answer is the same for the screen and for the figure
 * exported from it — and so that the lane, its readout and its tooltip cannot
 * disagree about which of the two things is on screen.
 */
export function basesAreDrawable(frame: LaneFrame): boolean {
  return basePixels(frame) >= COLUMN_MIN_WIDTH
}

/** How many pixels one base occupies in this frame. */
export function basePixels(frame: LaneFrame): number {
  const [d0, d1] = frame.domain
  const span = d1 - d0
  if (!(span > 0)) return 0
  return Math.abs(frame.alongTo - frame.alongFrom) / span
}

export interface SequencePaint {
  font: string
  opacity: number
  /** Draw the letters where they fit; off leaves the columns bare. */
  letters: boolean
}

/**
 * Draw the residues of every window that has arrived.
 *
 * Each base is placed through the axis, like every other mark in this viewer
 * (§8.4) — never by dividing the window into equal parts, which would be a
 * second coordinate system and would drift from the ruler above it by a pixel
 * at the far end of a chromosome.
 */
export function drawSequence(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  axis: LocusAxis,
  regions: readonly BaseRegion[],
  paint: SequencePaint,
): void {
  const width = basePixels(frame)
  if (!(width >= COLUMN_MIN_WIDTH)) return
  const letters =
    paint.letters && width >= LETTER_MIN_WIDTH && frame.thickness >= LETTER_MIN_THICKNESS

  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.font = paint.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const low = Math.min(frame.alongFrom, frame.alongTo) - width
  const high = Math.max(frame.alongFrom, frame.alongTo) + width

  for (const region of regions) {
    const segment = axis.segmentOf(region.contig)
    if (segment === null || !(segment.bpPerUnit > 0)) continue
    const step = 1 / segment.bpPerUnit
    const origin = segment.unitStart + (region.start - segment.bpStart) / segment.bpPerUnit
    for (let i = 0; i < region.bases.length; i++) {
      const a0 = frame.toPixel(origin + i * step)
      const a1 = frame.toPixel(origin + (i + 1) * step)
      const from = Math.min(a0, a1)
      const to = Math.max(a0, a1)
      if (to < low || from > high) continue
      const colour = BASE_COLOURS[BASE_CODE[region.bases[i]]]
      const [x, y, boxWidth, boxHeight] = laneRect(frame, from, to, 0, frame.thickness)
      ctx.fillStyle = colour
      // Under a letter the column is a wash rather than a block: the letter is
      // what is being read at that zoom, and reading it off a saturated ground
      // is harder than reading it off a tint of the same colour.
      //
      // And even bare, a column is not drawn at full strength. A lane of solid
      // primaries is a wall: it takes over the picture from the tracks it is
      // supposed to be annotating, and the lane's own edges disappear into it.
      // At two thirds it is still four distinguishable colours and it still
      // reads as a strip of a genome browser rather than as a test card.
      ctx.globalAlpha = paint.opacity * (letters ? 0.22 : 0.62)
      ctx.fillRect(x, y, boxWidth, boxHeight)
      if (!letters) continue
      ctx.globalAlpha = paint.opacity
      ctx.fillStyle = colour
      laneText(ctx, frame, letterOf(region.bases[i]), (from + to) / 2, frame.thickness / 2)
    }
  }
  ctx.restore()
}

/** The residue as a glyph: upper case, whatever the file wrote. */
export function letterOf(byte: number): string {
  return String.fromCharCode(byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte)
}

/**
 * The base at one position, for the readout.
 *
 * A linear scan of the windows in hand, which are the windows on screen: three
 * of them at most, and a binary search over a `Uint8Array` whose start is known
 * is arithmetic anyway.
 */
export function baseAt(
  regions: readonly BaseRegion[],
  contig: string,
  bp: number,
): string | null {
  const at = Math.floor(bp)
  for (const region of regions) {
    if (region.contig !== contig || at < region.start || at >= region.end) continue
    return letterOf(region.bases[at - region.start])
  }
  return null
}
