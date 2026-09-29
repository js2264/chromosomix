/**
 * An axis of the edited assembly, turned into one the tracks can be drawn
 * through (SPECS §27.7).
 *
 * Under an edit the reader answers in the edited assembly — `IV_e1`, its bins,
 * its base pairs — and every view builds its axis from that answer, as it
 * always has. The tracks, the marks and the features are not in the edited
 * assembly: they are in the file's, and fetched in the file's coordinates, so
 * that the annotations worker never learns there is an edit (§27.7). This is
 * the step between: each stretch of an edited sequence on the axis is cut into
 * the pieces it is made of, and each piece becomes a stretch of its **original**
 * sequence — forward or read backwards, and clipped to the piece — at exactly
 * the units the edited stretch had. A gap becomes no stretch at all, so nothing
 * is drawn in it.
 *
 * Exact in base pairs: an edited position is a position in one piece, and a
 * piece maps its bases to the original's one for one. Only the contacts are
 * placed to the bin (`metacooler/lens.ts`); a track drawn through this is where
 * its bases are.
 */

import type { EditedAssembly } from '../genome/edit'
import { LocusAxis, bpAt, strandOf, stretchOf, unitAt, type LocusSegment } from '../render/locus'

/**
 * The axis with every stretch of an edited sequence replaced by its pieces,
 * as stretches of the original sequences. A stretch of a sequence the edit
 * left whole — `II`, still `II` — is kept as it is, and so is the whole axis
 * where nothing on it was edited.
 */
export function axisThroughEdit(axis: LocusAxis | null, assembly: EditedAssembly | null): LocusAxis | null {
  if (axis === null || assembly === null) return axis
  const lengths = new Map(assembly.original.names.map((name, i) => [name, assembly.original.lengths[i]]))
  const segments: LocusSegment[] = []
  let changed = false
  for (const segment of axis.segments) {
    const sequence = assembly.sequence(segment.contig)
    const whole = sequence !== null && sequence.parts.length === 1 && lengths.has(segment.contig)
    if (sequence === null || whole) {
      segments.push(segment)
      continue
    }
    changed = true
    // The edited stretch this segment shows, low end first.
    const [from, to] = stretchOf(segment)
    const a = Math.max(from, Math.min(bpAt(segment, segment.unitStart), bpAt(segment, segment.unitEnd)))
    const b = Math.min(to, Math.max(bpAt(segment, segment.unitStart), bpAt(segment, segment.unitEnd)))
    if (!(b > a)) continue
    for (const { offset, piece } of assembly.piecesIn(segment.contig, a, b)) {
      const length = piece.end - piece.start
      // The piece's two ends on the axis, as the edited stretch places them.
      const u0 = unitAt(segment, offset)
      const u1 = unitAt(segment, offset + length)
      const unitStart = Math.min(u0, u1)
      const unitEnd = Math.max(u0, u1)
      if (!(unitEnd > unitStart)) continue
      // Which way the original reads along the axis: the piece's own strand,
      // turned again where the edited stretch is itself drawn backwards.
      const strand = (piece.strand * strandOf(segment)) as 1 | -1
      segments.push({
        contig: piece.sequence,
        unitStart,
        unitEnd,
        bpStart: strand === 1 ? piece.start : piece.end,
        bpPerUnit: segment.bpPerUnit,
        contigLength: lengths.get(piece.sequence) ?? piece.end,
        strand,
        bpFrom: piece.start,
        bpTo: piece.end,
      })
    }
  }
  if (!changed) return axis
  segments.sort((x, y) => x.unitStart - y.unitStart)
  return segments.length === 0 ? null : new LocusAxis(segments)
}
