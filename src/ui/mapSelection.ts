/**
 * What a drag on the map names, said in coordinates a reader can use.
 *
 * A box or a band is drawn in cells, and cells are an offset into whichever
 * block happened to be loaded when the hand moved. What the gesture *means* is a
 * stretch of one sequence — anchored where the drag began, clamped to that
 * sequence — and that meaning has several readers: the region a view opens, the
 * form waiting on *pick on map*, the clipboard, and the chips written beside the
 * marquee while it is still being drawn. The shapes a selection resolves to and
 * the ways it is written are here, once, so that a box which opens a region and
 * the numbers that promised it cannot come to name different stretches.
 *
 * Out of `ui/MatrixPanel.ts` because none of it needs a canvas: the panel
 * resolves a drag against the block it holds, and these say what the answer is
 * and how it is written down.
 */

import { formatPosition } from '../genome/assembly'
import type { Cell, SelectionBox } from '../render/heatmap'
import { bpAt, stretchOf, type LocusAxis } from '../render/locus'
import { fmt } from './dom'
import type { PickedLocus } from './mapPick'

/**
 * What a dragged box resolves to: one block, and how much of it.
 *
 * *One* block, not the rectangle the box covers, because that is the view a
 * selection is asking for. A square drawn across the corner of two chromosomes
 * on a whole-genome map is asking to look at a chromosome — it cannot be asking
 * for a region that spans two of them, since no such region exists — so it
 * resolves to the one the drag began in, ending at the edge of the box or at
 * the end of that chromosome, whichever comes first.
 *
 * `range` is absent above bin level, where a cell *is* a contig or a genome and
 * there is no position inside one to name.
 */
export interface SelectedAxis {
  /** The block this axis of the box falls in: a contig, or a genome. */
  label: string
  /** Base pairs within that block, clamped to it; absent above bin level. */
  range?: [number, number]
}

export interface SelectedRegion {
  rows: SelectedAxis
  cols: SelectedAxis
  /**
   * `true` when the box lies *on* the diagonal: the same block on both axes,
   * covering the same stretch of it.
   *
   * Not "the same block" — that was the first version of this and it is the
   * wrong question. A box in the top-right corner of one chromosome is two
   * different windows of the same sequence, and answering it with the row's
   * window alone hands back a square centred on the diagonal: the one place the
   * reader was deliberately not looking. Only when both windows coincide is
   * there a single region to open.
   */
  diagonal: boolean
  level: 'bin' | 'contig' | 'genome'
  /** The cell the drag began on, for a view that resolves blocks its own way. */
  anchor: Cell
}

/**
 * A dragged band of one axis, as a locus on the sequence it began in.
 *
 * **Clamped to that sequence, and that is the whole of this function.** A drag
 * is free to run across several — on a whole-metagenome view a cell is a contig
 * or two, so a band of five crosses four boundaries — and the reading used to
 * take the *name* from where the hand went down and the *end* from where it
 * came up, which is one contig's name against another contig's coordinate. On
 * the mock community that produced `NODE_…:1-260,000` for a 200 kb sequence,
 * and the range parser refused it: `Genomic region out of bounds`. The 4C
 * task's anchor, unusable from the picture it was picked on, and a clipboard
 * copy of the same gesture that pasted back as an error.
 *
 * The anchor is where the hand went down — the same rule a marquee follows, for
 * the same reason (`axisSelection`) — and what it names is however much of that
 * sequence the gesture covered. The end never passes the sequence's length,
 * because a contig's last bin is partial in general and a whole-contig drag
 * would otherwise name a coordinate a bin beyond the end of it.
 *
 * Exported for the test that pins those two clamps, beside the three selection
 * helpers below it and for the same reason: the panel needs a canvas and the
 * arithmetic does not.
 */
export function bandRegion(axis: LocusAxis, span: [number, number]): PickedLocus | null {
  const segment = axis.segmentAt(span[0])
  if (segment === null) return null
  // The band's far edge: a cell on from where the hand went down at the least,
  // and never past the stretch it went down in.
  const far = Math.min(Math.max(span[0] + 1, span[1]), segment.unitEnd)
  // Low and high, whichever way the stretch reads — a piece of an edited
  // sequence turned round names its stretch from its right edge (§27.2).
  const a = bpAt(segment, span[0])
  const b = bpAt(segment, far)
  const [low, high] = stretchOf(segment)
  return {
    contig: segment.contig,
    start: Math.max(low, Math.round(Math.min(a, b))),
    end: Math.min(high, Math.round(Math.max(a, b))),
  }
}

/**
 * Whether a box straddles the diagonal, in cells.
 *
 * Compared in cells rather than in base pairs because that is where the
 * question is exact, and with a bin of slack at each end because the marquee is
 * square in *pixels*: the two axes convert those pixels through their own
 * scales, and a plot whose gutters differ by a pixel turns a square on the
 * diagonal into ranges that differ by one cell. A whole bin of tolerance is
 * still far tighter than any box a hand can draw off the diagonal.
 */
export function onDiagonal(box: SelectionBox): boolean {
  return Math.abs(box.rows[0] - box.cols[0]) <= 1 && Math.abs(box.rows[1] - box.cols[1]) <= 1
}

/**
 * One axis of a selection as a region string, in the grammar the region box
 * takes.
 *
 * Rounded to whole base pairs and written without separators, so it is both a
 * legal range (§5.4) and something that can be pasted back. Above bin level
 * there is no range to write and the block's own name is the answer.
 */
export function axisRegion(axis: SelectedAxis): string {
  if (axis.range === undefined) return axis.label
  const [start, end] = axis.range
  return `${axis.label}:${Math.round(start)}-${Math.round(end)}`
}

/**
 * One axis of a dragged box, as the three numbers written *beside* it.
 *
 * Not {@link axisRegion}, and the difference is the audience: that one is a
 * region string, half-open and separator-free because it is pasted back into a
 * box; this one is read, so both ends are 1-based positions and the width is in
 * the reader's units. The wording is the 1D browser's marquee, word for word —
 * one gesture described in two dialects is two gestures as far as anybody can
 * tell.
 *
 * Above bin level there is no range and the block's own name is the answer.
 */
export function spanText(axis: SelectedAxis): { start: string; end: string; span: string } {
  if (axis.range === undefined) return { start: axis.label, end: axis.label, span: '' }
  const [start, end] = axis.range
  // The first base and the last, each through the one helper that writes a
  // base (§26.1): the last of a half-open range is the one before its end.
  return {
    start: formatPosition(axis.label, Math.round(start)),
    end: formatPosition(axis.label, Math.round(end) - 1),
    span: fmt.bp(end - start),
  }
}
